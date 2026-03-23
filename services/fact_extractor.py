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


def extract_facts_async(api_key: str, base_url: str, extraction_model: str,
                        rag_system_prompt: str,                              # add this
                        user_id: str, user_message: str, bot_response: str,
                        memory_service_module):
    """
    Kick off fact extraction in a background daemon thread.
    Returns immediately — does not block the chat response.
    """
    t = threading.Thread(
        target=_extract_and_store,
        args=(api_key, base_url, extraction_model, rag_system_prompt, user_id, user_message, bot_response, memory_service_module),
        daemon=True,
        name=f"fact_extractor_{user_id}",
    )
    t.start()


def _extract_and_store(api_key, base_url, extraction_model, rag_system_prompt, user_id, user_message, bot_response, memory_service_module):
    try:
        _logger.info("[FactExtractor] Thread started for user %s", user_id)
        facts = _call_llm(api_key, base_url, extraction_model, rag_system_prompt, user_message, bot_response)
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