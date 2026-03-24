# -*- coding: utf-8 -*-
"""
fact_extractor.py
-----------------
Extracts durable user facts/preferences from each conversation turn using the LLM,
then stores them in ChromaDB via memory_service AND mirrors them into the
mcp.chatbot.user.fact Odoo model for visibility in the backend UI.
"""

import json
import logging
import threading

from openai import OpenAI

_logger = logging.getLogger(__name__)


def extract_facts_async(api_key: str, base_url: str, extraction_model: str,
                        rag_system_prompt: str,
                        user_id: str, user_message: str, bot_response: str,
                        memory_service_module,
                        odoo_registry=None, odoo_db: str = None):
    """
    Kick off fact extraction in a background daemon thread.
    Returns immediately — does not block the chat response.

    Args:
        odoo_registry: The Odoo registry object (passed from the controller as
                       `request.env.registry`). Used to open a fresh cursor in
                       the background thread so we can write to the Odoo model.
        odoo_db:       The current database name (`request.env.cr.dbname`).
                       Required alongside odoo_registry.
    """
    t = threading.Thread(
        target=_extract_and_store,
        args=(
            api_key, base_url, extraction_model, rag_system_prompt,
            user_id, user_message, bot_response,
            memory_service_module, odoo_registry, odoo_db,
        ),
        daemon=True,
        name=f"fact_extractor_{user_id}",
    )
    t.start()


def _extract_and_store(api_key, base_url, extraction_model, rag_system_prompt,
                       user_id, user_message, bot_response,
                       memory_service_module, odoo_registry, odoo_db):
    try:
        _logger.info("[FactExtractor] Thread started for user %s", user_id)
        facts = _call_llm(api_key, base_url, extraction_model, rag_system_prompt,
                          user_message, bot_response)
        _logger.info("[FactExtractor] LLM returned %d facts", len(facts) if facts else 0)

        if not facts:
            _logger.info("[FactExtractor] No facts to store, exiting")
            return

        for fact in facts:
            text = fact.get("text", "").strip()
            if not text:
                continue

            category = fact.get("category", "general")

            # ── 1. Write to ChromaDB ─────────────────────────────────────
            _logger.info("[FactExtractor] Storing in ChromaDB: %s", text)
            chroma_ok = memory_service_module.store_memory(
                user_id=user_id,
                fact_text=text,
                metadata={"category": category, "source": "llm_extraction"},
            )
            _logger.info("[FactExtractor] store_memory returned: %s", chroma_ok)

            # ── 2. Mirror into the Odoo mcp.chatbot.user.fact model ───────
            if odoo_registry and odoo_db:
                _write_to_odoo(
                    registry=odoo_registry,
                    db=odoo_db,
                    user_id=user_id,
                    fact_text=text,
                    category=category,
                    chroma_doc_id=memory_service_module._doc_id(user_id, text),
                )

    except Exception:
        import traceback
        _logger.error("[FactExtractor] FULL TRACEBACK:\n%s", traceback.format_exc())


def _write_to_odoo(registry, db: str, user_id: str, fact_text: str,
                   category: str, chroma_doc_id: str):
    """
    Open a fresh database cursor and write one fact record.

    We open our own cursor (instead of reusing the request cursor) because
    this runs in a daemon thread after the HTTP response has already been
    committed — the original cursor is closed by that point.
    """
    try:
        partner_id = int(user_id)
    except (ValueError, TypeError):
        _logger.warning("[FactExtractor] Cannot mirror to Odoo — user_id is not an integer: %s", user_id)
        return

    try:
        with registry.cursor() as cr:
            from odoo.api import Environment
            import odoo
            env = Environment(cr, odoo.SUPERUSER_ID, {})

            # Avoid duplicates: if the same chroma_doc_id already exists, skip
            existing = env["mcp.chatbot.user.fact"].search(
                [("chroma_doc_id", "=", chroma_doc_id)], limit=1
            )
            if existing:
                # Update fact text in case it changed (dedup update in ChromaDB)
                existing.write({"fact_text": fact_text, "category": category})
                _logger.info(
                    "[FactExtractor] Updated existing Odoo fact record id=%s for user %s",
                    existing.id, user_id,
                )
            else:
                env["mcp.chatbot.user.fact"].create({
                    "partner_id": partner_id,
                    "fact_text": fact_text,
                    "category": category,
                    "chroma_doc_id": chroma_doc_id,
                })
                _logger.info(
                    "[FactExtractor] Created Odoo fact record for user %s: '%s'",
                    user_id, fact_text[:80],
                )

    except Exception:
        import traceback
        _logger.error("[FactExtractor] Failed to mirror fact to Odoo:\n%s", traceback.format_exc())


def _call_llm(api_key: str, base_url: str, extraction_model: str,
              rag_system_prompt: str,
              user_message: str, bot_response: str) -> list[dict]:
    raw = ""
    try:
        client = OpenAI(api_key=api_key, base_url=base_url)
        exchange = (
            f"USER MESSAGE (extract facts from this):\n{user_message}\n\n"
            f"ASSISTANT RESPONSE (context only — do not extract from this):\n{bot_response}"
        )
        response = client.chat.completions.create(
            model=extraction_model,
            messages=[
                {"role": "system", "content": rag_system_prompt},
                {"role": "user", "content": f"Extract facts about the user from this exchange:\n\n{exchange}"},
            ],
            temperature=0.0,
            max_tokens=512,
        )
        raw = response.choices[0].message.content.strip()
        clean = raw.replace("```json", "").replace("```", "").strip()
        return json.loads(clean).get("facts", [])
    except json.JSONDecodeError as exc:
        _logger.warning("[FactExtractor] JSON parse error: %s | output: %s", exc, raw[:200])
        return []
    except Exception as exc:
        _logger.error("[FactExtractor] LLM call failed: %s", exc)
        return []