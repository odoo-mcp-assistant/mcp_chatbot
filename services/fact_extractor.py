# -*- coding: utf-8 -*-
"""
fact_extractor.py
-----------------
Extracts durable user facts/preferences from each conversation turn using the LLM,
then stores them in ChromaDB via memory_service.
"""

import json
import logging
import threading

from openai import OpenAI

_logger = logging.getLogger(__name__)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
EXTRACTION_MODEL = "openai/gpt-oss-120b"
GROQ_API_KEY = "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"

_SYSTEM_PROMPT = """You are a memory extraction assistant embedded in an Odoo ERP chatbot.

Analyze ONE conversation exchange and extract facts worth remembering long-term about the user.

EXTRACT:
- Language/communication preferences (e.g., "User prefers responses in French")
- User role, department, or company (e.g., "User is the warehouse manager at branch Tunis")
- Odoo-specific context (e.g., "User always works with company My Company", "User uses the Purchase module")
- Formatting preferences (e.g., "User prefers short answers without bullet points")
- Explicit memory requests (e.g., "User asked to remember they use warehouse WH/01")
- Recurring topics (e.g., "User frequently asks about stock valuation")

DO NOT EXTRACT:
- Questions asked in this turn
- Transient requests like "show me PO list"
- Odoo ERP data (prices, quantities, dates)
- Anything that becomes outdated quickly

Return ONLY valid compact JSON, no markdown fences, no explanation:
{"facts": [{"text": "User prefers responses in French", "category": "language"}]}

If nothing worth storing: {"facts": []}

CATEGORIES: language | role | odoo_config | formatting | explicit | topic"""


def extract_facts_async(api_key: str, user_id: str, user_message: str, bot_response: str, memory_service_module):
    """
    Kick off fact extraction in a background daemon thread.
    Returns immediately — does not block the chat response.
    """
    t = threading.Thread(
        target=_extract_and_store,
        args=(api_key, user_id, user_message, bot_response, memory_service_module),
        daemon=True,
        name=f"fact_extractor_{user_id}",
    )
    t.start()


def _extract_and_store(api_key, user_id, user_message, bot_response, memory_service_module):
    try:
        _logger.info("[FactExtractor] Thread started for user %s", user_id)
        facts = _call_llm(api_key, user_message, bot_response)
        _logger.info("[FactExtractor] LLM returned %d facts", len(facts) if facts else 0)
        if not facts:
            _logger.info("[FactExtractor] No facts to store, exiting")
            return
        for fact in facts:
            text = fact.get("text", "").strip()
            if text:
                _logger.info("[FactExtractor] Storing: %s", text)
                result = memory_service_module.store_memory(
                    user_id=user_id,
                    fact_text=text,
                    metadata={"category": fact.get("category", "general"), "source": "llm_extraction"},
                )
                _logger.info("[FactExtractor] store_memory returned: %s", result)
    except Exception as exc:
        import traceback
        _logger.error("[FactExtractor] FULL TRACEBACK:\n%s", traceback.format_exc())


def _call_llm(api_key: str, user_message: str, bot_response: str) -> list[dict]:
    raw = ""
    try:
        # Always fall back to hardcoded key if passed key is empty
        effective_key = api_key if api_key else GROQ_API_KEY
        client = OpenAI(api_key=effective_key, base_url=GROQ_BASE_URL)
        exchange = f"User: {user_message}\nAssistant: {bot_response}"
        response = client.chat.completions.create(
            model=EXTRACTION_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"Extract facts from this exchange:\n\n{exchange}"},
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