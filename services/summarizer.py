# -*- coding: utf-8 -*-
"""
summarizer.py
-------------
Runs the conversation summarisation LLM call in a background daemon
thread so the user-facing /mcp_chatbot/message request never blocks
on it.

Mirrors the fact_extractor.py pattern:
  * spawn a daemon thread
  * call the (cheaper) summary LLM
  * open a fresh Odoo cursor (the original request cursor is already
    committed by the time the thread runs)
  * write `history_summary` and `last_summarized_count` on the session

A per-worker in-flight guard prevents a fast follow-up message from
kicking off a second summarisation thread for the same session while
the first one is still running.

The rolling summary is stored as a JSON-encoded string with a fixed
schema (see SUMMARY_SCHEMA below). This gives us:
  * a hard size bound — the schema *is* the cap (no unbounded growth)
  * surgical updates — fields the LLM didn't touch are kept verbatim
  * programmatic access — other code can read entities/preferences
    directly without re-parsing prose
The injection-time renderer (`render_summary_for_prompt`) turns the
JSON back into a clean prose block for the main chatbot LLM, so the
rest of the pipeline never has to know about the underlying shape.

Backwards compat: legacy prose summaries (anything that isn't valid
JSON in our schema) are detected on read and stuffed into
`recent_context`. The next summarisation round structures them.
"""

import json
import logging
import re
import threading

from openai import OpenAI

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-worker in-flight guard
# ---------------------------------------------------------------------------
# Set of session ids that currently have a summarisation thread running on
# THIS Odoo worker. Held only across the (fast) decision-to-spawn check, so
# the lock is uncontended in practice.
_in_flight_lock = threading.Lock()
_in_flight_sessions: set = set()


# ---------------------------------------------------------------------------
# Structured summary schema
# ---------------------------------------------------------------------------
# Bumped if we ever change the shape in a non-backwards-compatible way.
# Stored inside the JSON itself as `_v` so a future migration can detect
# old formats without guessing.
SUMMARY_SCHEMA_VERSION = 1

# Per-field hard caps. Enforced in Python after every LLM round so the
# summary CAN'T grow past these regardless of what the LLM returns.
FIELD_CAPS = {
    'products':             10,
    'orders':                5,
    'user_preferences':     10,
    'unresolved_questions':  5,
    'current_goal_chars':  500,
    'recent_context_chars': 1000,
    'note_chars':            200,
}


# ---------------------------------------------------------------------------
# Price scrubber
# ---------------------------------------------------------------------------
# Tool-derived numeric data (prices, stock counts, dates, …) MUST NOT survive
# in the rolling summary, because the summary is re-injected as an authoritative
# system message on every subsequent turn. If the LLM ever wrote a stale or
# wrong price into a product `note` or into `recent_context`, that wrong price
# would be re-fed to the chatbot LLM forever and would override the live tool
# results. The schema hint asks the LLM not to do this; this regex is the hard
# defense in case it does it anyway.
_PRICE_RE = re.compile(
    r'\b\d[\d\s.,]*\s?(?:DT|TND|TND\.|MAD|EUR|USD|€|\$)\b',
    re.IGNORECASE,
)


def _scrub_prices(text: str) -> str:
    """Strip price-like substrings (e.g. '1169 DT', '€199.90') from text.

    Used on free-form fields the summary LLM controls (`note`, `recent_context`)
    so a hallucinated or stale price can never get baked into the rolling
    summary and re-injected on later turns.
    """
    if not text:
        return text
    return _PRICE_RE.sub('', text).strip()


def _empty_summary() -> dict:
    """Return a fresh, empty summary dict matching the canonical schema."""
    return {
        '_v':           SUMMARY_SCHEMA_VERSION,
        'current_goal': '',
        'entities': {
            'products':    [],
            'orders':      [],
            'identifiers': {},
        },
        'user_preferences':     [],
        'unresolved_questions': [],
        'recent_context':       '',
    }


def parse_summary(stored: str) -> dict:
    """
    Parse a stored history_summary value into the structured dict.

    Backwards-compat:
      * empty/None → fresh empty schema
      * valid JSON in our shape → validated + capped
      * anything else (legacy prose) → empty schema with the prose
        stuffed into `recent_context` so the next summarisation round
        can structure it
    """
    if not stored:
        return _empty_summary()
    try:
        data = json.loads(stored)
    except (json.JSONDecodeError, TypeError):
        fallback = _empty_summary()
        fallback['recent_context'] = stored.strip()[:FIELD_CAPS['recent_context_chars']]
        return fallback

    if not isinstance(data, dict) or '_v' not in data:
        # JSON but not our schema — treat as legacy
        fallback = _empty_summary()
        fallback['recent_context'] = (
            json.dumps(data)[:FIELD_CAPS['recent_context_chars']]
            if not isinstance(data, str)
            else data[:FIELD_CAPS['recent_context_chars']]
        )
        return fallback

    return _validate_and_cap(data)


def _validate_and_cap(data: dict) -> dict:
    """
    Coerce an incoming dict to the canonical schema, fill missing
    fields with defaults, enforce per-field caps. Never raises — bad
    inputs are silently dropped.

    For list fields that exceed their cap we keep the LAST N entries
    (newest), not the first N — newer info is more relevant.
    """
    out = _empty_summary()

    if isinstance(data.get('current_goal'), str):
        out['current_goal'] = data['current_goal'].strip()[:FIELD_CAPS['current_goal_chars']]

    entities_in = data.get('entities')
    if isinstance(entities_in, dict):
        prods = entities_in.get('products')
        if isinstance(prods, list):
            cleaned = []
            for p in prods:
                if not isinstance(p, dict):
                    continue
                # Scrub any price-like substrings the LLM may have stuffed
                # into the free-form `note` field, and cap its length.
                note = p.get('note')
                if isinstance(note, str):
                    p = dict(p)  # don't mutate the caller's dict
                    p['note'] = _scrub_prices(note)[:FIELD_CAPS['note_chars']]
                cleaned.append(p)
            out['entities']['products'] = cleaned[-FIELD_CAPS['products']:]

        orders = entities_in.get('orders')
        if isinstance(orders, list):
            cleaned = [o for o in orders if isinstance(o, dict)]
            out['entities']['orders'] = cleaned[-FIELD_CAPS['orders']:]

        ids = entities_in.get('identifiers')
        if isinstance(ids, dict):
            out['entities']['identifiers'] = {
                str(k): str(v) for k, v in ids.items() if v
            }

    prefs = data.get('user_preferences')
    if isinstance(prefs, list):
        cleaned = [str(p).strip() for p in prefs if p]
        out['user_preferences'] = cleaned[-FIELD_CAPS['user_preferences']:]

    questions = data.get('unresolved_questions')
    if isinstance(questions, list):
        cleaned = [str(q).strip() for q in questions if q]
        out['unresolved_questions'] = cleaned[-FIELD_CAPS['unresolved_questions']:]

    if isinstance(data.get('recent_context'), str):
        scrubbed = _scrub_prices(data['recent_context'])
        out['recent_context'] = scrubbed.strip()[:FIELD_CAPS['recent_context_chars']]

    return out


def _summary_is_empty(data: dict) -> bool:
    """True if a structured summary contains no useful information."""
    return not (
        data.get('current_goal')
        or data.get('entities', {}).get('products')
        or data.get('entities', {}).get('orders')
        or data.get('entities', {}).get('identifiers')
        or data.get('user_preferences')
        or data.get('unresolved_questions')
        or data.get('recent_context')
    )


def render_summary_for_prompt(stored: str) -> str:
    """
    Turn a stored history_summary (JSON string) back into the prose
    block injected into the chatbot's system context. Returns an empty
    string if there's nothing useful to inject.

    Public API — called from controllers/chatbot_controller.py via the
    importlib loader. Keep the signature stable.
    """
    data = parse_summary(stored)
    if _summary_is_empty(data):
        return ''

    lines = []

    if data['current_goal']:
        lines.append(f"- Current goal: {data['current_goal']}")

    products = data['entities']['products']
    if products:
        rendered = []
        for p in products:
            name = (p.get('name') or '').strip()
            pid  = p.get('id') or ''
            note = (p.get('note') or '').strip()
            tag  = name or 'unnamed'
            if pid:
                tag += f" (id={pid})"
            if note:
                tag += f" — {note}"
            rendered.append(tag)
        lines.append("- Products discussed: " + "; ".join(rendered))

    orders = data['entities']['orders']
    if orders:
        rendered = []
        for o in orders:
            ref    = (o.get('ref') or '').strip()
            status = (o.get('status') or '').strip()
            if ref and status:
                rendered.append(f"{ref} ({status})")
            elif ref:
                rendered.append(ref)
        if rendered:
            lines.append("- Orders referenced: " + "; ".join(rendered))

    ids = data['entities']['identifiers']
    if ids:
        rendered = ", ".join(f"{k}={v}" for k, v in ids.items())
        lines.append(f"- User identifiers: {rendered}")

    if data['user_preferences']:
        lines.append("- User preferences:")
        for pref in data['user_preferences']:
            lines.append(f"  • {pref}")

    if data['unresolved_questions']:
        lines.append("- Open questions:")
        for q in data['unresolved_questions']:
            lines.append(f"  • {q}")

    if data['recent_context']:
        lines.append(f"- Recent context: {data['recent_context']}")

    return "SUMMARY OF CONVERSATION SO FAR:\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# LLM prompts
# ---------------------------------------------------------------------------
# Two distinct prompts: one for the very first round (no prior summary),
# one for update rounds (merge with existing). They share the schema.

_SCHEMA_HINT = """{
  "_v": 1,
  "current_goal": "<one sentence — what the user is trying to do RIGHT NOW, or '' if unclear>",
  "entities": {
    "products":    [{"name": "<exact name>", "id": "<id or empty>", "note": "<short DURABLE context only — e.g. 'user is comparing this with X', 'preferred over Y'. NEVER put prices, stock levels, quantities, dates, promo amounts or any tool-derived numeric data here.>"}],
    "orders":      [{"ref": "<exact ref like S00108>", "status": "<status or empty>"}],
    "identifiers": {"email": "<...>", "phone": "<...>"}
  },
  "user_preferences":     ["<short bullet>", "..."],
  "unresolved_questions": ["<short bullet>", "..."],
  "recent_context":       "<1-2 sentences for the most recent topic shift. NEVER include prices, stock levels or any other numeric tool data — only describe what the conversation is about.>"
}"""


_SYSTEM_PROMPT_FIRST = (
    "You are a conversation summarizer. Read the chat history below and "
    "extract a structured summary in this EXACT JSON schema:\n\n"
    f"{_SCHEMA_HINT}\n\n"
    "CRITICAL RULES:\n"
    "- Output ONLY valid JSON. No prose before or after. No markdown code fences.\n"
    "- Preserve order references (e.g. S00108), product names, prices, emails, "
    "and any technical identifiers EXACTLY as they appear — never paraphrase or rename.\n"
    "- Empty fields: use \"\" for strings, [] for lists, {} for dicts. Never omit a field.\n"
    "- Keep each list under 10 items. Drop trivia and small-talk.\n"
    "- 'current_goal' is what the user wants RIGHT NOW, not what they wanted earlier.\n"
    "- Always include the '_v': 1 field."
)


_SYSTEM_PROMPT_UPDATE = (
    "You are a conversation summarizer maintaining a structured summary of "
    "an ongoing chat.\n\n"
    "You will receive:\n"
    "  1. The CURRENT structured summary as JSON.\n"
    "  2. NEW messages that have happened since the last update.\n\n"
    "Return the UPDATED summary using this EXACT schema:\n\n"
    f"{_SCHEMA_HINT}\n\n"
    "CRITICAL RULES:\n"
    "- Output ONLY valid JSON. No prose, no markdown code fences.\n"
    "- For fields where the new messages contain NO new information, COPY the "
    "existing value VERBATIM. Do not paraphrase, rewrite, or 'improve' unchanged "
    "fields.\n"
    "- For 'entities': MERGE. Keep existing entries unless explicitly resolved or "
    "cancelled, and add new ones.\n"
    "- For 'unresolved_questions': REMOVE items the new messages have answered, "
    "ADD any new open questions.\n"
    "- For 'current_goal': REPLACE only if the user's focus has clearly shifted; "
    "otherwise keep the existing value.\n"
    "- For 'recent_context': REWRITE to reflect the latest topic — this is the "
    "only field that always changes.\n"
    "- Preserve order references, product names, prices, emails, and identifiers "
    "EXACTLY as they appear.\n"
    "- Keep each list under 10 items. If a list would exceed that, drop the "
    "OLDEST entries.\n"
    "- Always include the '_v': 1 field."
)


def summarize_async(
    api_key: str,
    base_url: str,
    model_name: str,
    session_id: int,
    previous_summary_raw: str,
    messages_to_summarize: list,
    new_summarized_count: int,
    odoo_registry,
    odoo_db: str,
):
    """
    Kick off summarisation in a background daemon thread. Returns
    immediately. Duplicate calls for the same session (while a previous
    thread is still running) are dropped.

    Args:
        api_key, base_url, model_name: dedicated summary LLM settings
            (already resolved by the caller via _get_summary_settings()).
        session_id: PK of the mcp.chatbot.session row to update.
        previous_summary_raw: the current value of session.history_summary
            (a JSON string in the new format, or legacy prose, or empty).
            Passed in directly so the thread doesn't need to re-read it
            from the DB.
        messages_to_summarize: list of {role, content} dicts — the
            unsummarized tail. Should NOT include the previous summary;
            that's now passed separately.
        new_summarized_count: value to write into
            session.last_summarized_count once the summary is persisted.
            This is the prior_count snapshot the controller computed at
            kickoff time, not a value the thread re-derives.
        odoo_registry: request.env.registry from the caller — used to
            open a fresh cursor in the background thread.
        odoo_db: request.env.cr.dbname from the caller.
    """
    with _in_flight_lock:
        if session_id in _in_flight_sessions:
            _logger.info(
                "[Summarizer] Skip — session %s already has a summarisation thread in flight",
                session_id,
            )
            return
        _in_flight_sessions.add(session_id)

    t = threading.Thread(
        target=_run,
        args=(
            api_key, base_url, model_name,
            session_id, previous_summary_raw, messages_to_summarize,
            new_summarized_count, odoo_registry, odoo_db,
        ),
        daemon=True,
        name=f"summarizer_{session_id}",
    )
    t.start()


def _run(api_key, base_url, model_name,
         session_id, previous_summary_raw, messages_to_summarize, new_summarized_count,
         odoo_registry, odoo_db):
    try:
        _logger.info("[Summarizer] Thread started for session %s", session_id)

        previous_summary = parse_summary(previous_summary_raw)

        raw_response = _call_llm(
            api_key, base_url, model_name,
            previous_summary, messages_to_summarize,
        )
        if not raw_response:
            _logger.warning(
                "[Summarizer] LLM returned empty response for session %s — leaving session untouched",
                session_id,
            )
            return

        cleaned = _strip_code_fences(raw_response)
        try:
            new_dict = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            _logger.warning(
                "[Summarizer] LLM returned invalid JSON for session %s (%s) — leaving session untouched. Raw: %s",
                session_id, exc, cleaned[:300],
            )
            return

        if not isinstance(new_dict, dict):
            _logger.warning(
                "[Summarizer] LLM returned JSON but not an object for session %s — leaving session untouched",
                session_id,
            )
            return

        # Defensive merge: if the LLM omitted a field that was previously
        # populated, restore it from the prior summary so we never lose
        # information from a sloppy partial response.
        merged = _merge_with_previous(previous_summary, new_dict)
        validated = _validate_and_cap(merged)

        if _summary_is_empty(validated):
            _logger.warning(
                "[Summarizer] Validated summary is empty for session %s — leaving session untouched",
                session_id,
            )
            return

        new_summary_str = json.dumps(validated, ensure_ascii=False)

        _write_to_odoo(
            registry=odoo_registry,
            db=odoo_db,
            session_id=session_id,
            new_summary=new_summary_str,
            new_summarized_count=new_summarized_count,
        )
        _logger.info(
            "[Summarizer] Session %s summarised — %d messages now covered, %d bytes",
            session_id, new_summarized_count, len(new_summary_str),
        )
    except Exception:
        import traceback
        _logger.error("[Summarizer] FULL TRACEBACK:\n%s", traceback.format_exc())
    finally:
        with _in_flight_lock:
            _in_flight_sessions.discard(session_id)


def _merge_with_previous(previous: dict, new: dict) -> dict:
    """
    If the LLM omitted a field that was populated in the previous
    summary, copy it across. This protects against partial responses
    where the LLM "forgets" to include a field — without this, an
    unchanged field could be silently wiped on every round.
    """
    result = dict(new)  # shallow copy

    if not result.get('current_goal') and previous.get('current_goal'):
        result['current_goal'] = previous['current_goal']

    prev_entities = previous.get('entities') or {}
    if not isinstance(result.get('entities'), dict):
        result['entities'] = dict(prev_entities)
    else:
        for key in ('products', 'orders', 'identifiers'):
            if key not in result['entities'] and key in prev_entities:
                result['entities'][key] = prev_entities[key]

    for list_field in ('user_preferences', 'unresolved_questions'):
        if list_field not in result and previous.get(list_field):
            result[list_field] = previous[list_field]

    if not result.get('recent_context') and previous.get('recent_context'):
        result['recent_context'] = previous['recent_context']

    return result


def _call_llm(api_key, base_url, model_name, previous_summary, new_messages):
    """
    Call the summary LLM. Picks the FIRST or UPDATE prompt depending on
    whether there's prior structured content to merge with.

    Tries response_format=json_object for stricter providers (OpenAI,
    Groq, etc.) and falls back to plain text mode for providers that
    don't support that flag (some local/OpenRouter models).
    """
    client = OpenAI(api_key=api_key, base_url=base_url)

    if _summary_is_empty(previous_summary):
        system_prompt = _SYSTEM_PROMPT_FIRST
        user_content = (
            "CHAT HISTORY:\n"
            + json.dumps(new_messages, ensure_ascii=False)
        )
    else:
        system_prompt = _SYSTEM_PROMPT_UPDATE
        user_content = (
            "CURRENT SUMMARY:\n"
            + json.dumps(previous_summary, ensure_ascii=False)
            + "\n\nNEW MESSAGES:\n"
            + json.dumps(new_messages, ensure_ascii=False)
        )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": user_content},
    ]

    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        _logger.info(
            "[Summarizer] response_format=json_object rejected by provider (%s) — retrying without it",
            exc,
        )
        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.2,
        )

    return (response.choices[0].message.content or "").strip()


def _strip_code_fences(text: str) -> str:
    """
    Some LLMs wrap JSON in ```json ... ``` despite being told not to.
    Strip the fences if present.
    """
    text = text.strip()
    if not text.startswith("```"):
        return text
    lines = text.split("\n")
    # drop first ``` (or ```json) line
    lines = lines[1:]
    # drop trailing ``` line if present
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _write_to_odoo(registry, db: str, session_id: int,
                   new_summary: str, new_summarized_count: int):
    """
    Open a fresh database cursor and update the session row. We open
    our own cursor (instead of reusing the request cursor) because this
    runs in a daemon thread after the HTTP response has already been
    committed — the original cursor is closed by that point.
    """
    try:
        with registry.cursor() as cr:
            from odoo.api import Environment
            import odoo
            env = Environment(cr, odoo.SUPERUSER_ID, {})
            session = env["mcp.chatbot.session"].browse(session_id)
            if not session.exists():
                _logger.warning(
                    "[Summarizer] Session %s no longer exists — discarding summary",
                    session_id,
                )
                return
            session.write({
                "history_summary":       new_summary,
                "last_summarized_count": new_summarized_count,
            })
    except Exception:
        import traceback
        _logger.error("[Summarizer] Failed to persist summary to Odoo:\n%s", traceback.format_exc())
