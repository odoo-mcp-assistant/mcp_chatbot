# -*- coding: utf-8 -*-
"""
session_recall.py
-----------------
Per-session semantic recall: stores every (user_message, assistant_reply)
pair in a ChromaDB collection scoped to a single chat session, then lets
later turns semantically search that history for technical detail that
may have been compressed away by summarisation.

WHY THIS EXISTS
    The structured rolling summary (services/summarizer.py) keeps the
    *shape* of past conversation small and bounded — but bounded means
    lossy. After two or three summarisation rounds, fine-grained detail
    from message #60 (a specific spec, a price, an order reference) is
    no longer retrievable from the summary. If on turn #80 the user
    says "what was the RAM on the second one?", the chatbot has nothing
    to anchor on.

    Session recall plugs that gap. Each turn is embedded into a
    per-session ChromaDB collection at index time. On every new turn,
    we semantically search that collection with the incoming user
    message and inject the top-K matching pairs back into the LLM
    context as a system message.

DIFFERENCES FROM memory_service.py
    * Scope: per session (collection 'session_recall_{session_id}'),
      not per user. Anonymous sessions get this too.
    * Lifecycle: collection is dropped in chatbot_session.action_close()
      so closed sessions leave no trace.
    * No deduplication: every turn is unique by construction.
    * Retrieval is gated by `turn_index` so we never re-inject pairs
      that are still in the unsummarized tail (the LLM already sees
      those directly).

USED BY: controllers/chatbot_controller.py
"""

import hashlib
import logging
import threading
from datetime import datetime, timezone

import chromadb
import embedding_service

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ChromaDB connection — same host/port as memory_service.py
# ---------------------------------------------------------------------------
CHROMA_HOST = "localhost"
CHROMA_PORT = 8015

# Default cosine-similarity floor for retrieved pairs. Stricter than
# memory_service.MIN_RETRIEVAL_SIMILARITY (0.30) because false positives
# here cost both tokens AND confuse the LLM with off-topic snippets.
MIN_RETRIEVAL_SIMILARITY = 0.40

# Default top-K when the caller doesn't specify one.
DEFAULT_TOP_K = 3

COLLECTION_PREFIX = "session_recall_"


def _client() -> chromadb.HttpClient:
    return chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)


def _collection_name(session_id: int) -> str:
    return f"{COLLECTION_PREFIX}{session_id}"


def _collection(client, session_id: int):
    return client.get_or_create_collection(
        name=_collection_name(session_id),
        metadata={"hnsw:space": "cosine"},
    )


def _sim(distance: float) -> float:
    """ChromaDB cosine distance → similarity in [0, 1]."""
    return 1.0 - (distance / 2.0)


def _doc_id(session_id: int, turn_index: int) -> str:
    """Deterministic id so re-indexing the same turn is idempotent."""
    return hashlib.md5(f"{session_id}::{turn_index}".encode()).hexdigest()


def _format_pair(user_text: str, assistant_text: str) -> str:
    """
    Concatenate the user message and the assistant reply into a single
    document string. We embed the concatenation (not just the user
    message) because the technical detail we want to recall — specs,
    prices, references — usually lives in the assistant's reply.
    """
    return f"User: {user_text}\nAssistant: {assistant_text}"


# ---------------------------------------------------------------------------
# Indexing — daemon thread, mirrors fact_extractor.extract_facts_async
# ---------------------------------------------------------------------------

def index_turn_async(
    session_id: int,
    turn_index: int,
    user_text: str,
    assistant_text: str,
):
    """
    Kick off pair indexing in a background daemon thread. Returns
    immediately so the HTTP request never waits on ChromaDB.

    Args:
        session_id:    PK of the mcp.chatbot.session row this pair belongs to.
        turn_index:    Index of the user message in the chronological log
                       (= prior_count at controller dispatch time). Used as
                       the filter key at retrieval time, so pairs from the
                       still-unsummarized tail can be excluded.
        user_text:     The user message text.
        assistant_text: The assistant reply text.
    """
    if not user_text or not assistant_text:
        return

    t = threading.Thread(
        target=_index_pair,
        args=(session_id, turn_index, user_text, assistant_text),
        daemon=True,
        name=f"session_recall_{session_id}_{turn_index}",
    )
    t.start()


def _index_pair(session_id: int, turn_index: int,
                user_text: str, assistant_text: str):
    try:
        document = _format_pair(user_text, assistant_text)
        embedding = embedding_service.embed_text(document)

        col = _collection(_client(), session_id)
        col.add(
            ids=[_doc_id(session_id, turn_index)],
            documents=[document],
            embeddings=[embedding],
            metadatas=[{
                "session_id":  session_id,
                "turn_index":  turn_index,
                "created_at":  datetime.now(timezone.utc).isoformat(),
            }],
        )
        _logger.info(
            "[SessionRecall] Indexed turn %s for session %s (%d chars)",
            turn_index, session_id, len(document),
        )
    except Exception as exc:
        _logger.error(
            "[SessionRecall] index_turn failed for session %s turn %s: %s",
            session_id, turn_index, exc,
        )


# ---------------------------------------------------------------------------
# Retrieval — synchronous, called inline from the request path
# ---------------------------------------------------------------------------

def retrieve_relevant_turns(
    session_id: int,
    query_text: str,
    max_turn_index: int,
    top_k: int = DEFAULT_TOP_K,
) -> list[str]:
    """
    Semantically search this session's collection for past turns that
    match `query_text`, restricted to turns whose index is strictly less
    than `max_turn_index` (i.e. only pairs already covered by the
    rolling summary — never pairs still visible in the unsummarized
    tail).

    Returns a list of formatted "User: ... \\nAssistant: ..." strings,
    most relevant first, filtered by MIN_RETRIEVAL_SIMILARITY. Returns
    [] on any error or when nothing relevant exists.
    """
    if max_turn_index <= 0 or top_k <= 0 or not query_text:
        return []

    try:
        c = _client()
        col = _collection(c, session_id)
        count = col.count()
        if count == 0:
            return []

        embedding = embedding_service.embed_text(query_text)
        res = col.query(
            query_embeddings=[embedding],
            n_results=min(top_k, count),
            where={"turn_index": {"$lt": max_turn_index}},
            include=["documents", "distances"],
        )

        if not res["documents"] or not res["documents"][0]:
            return []

        return [
            doc for doc, dist in zip(res["documents"][0], res["distances"][0])
            if _sim(dist) >= MIN_RETRIEVAL_SIMILARITY
        ]

    except Exception as exc:
        _logger.error(
            "[SessionRecall] retrieve_relevant_turns failed for session %s: %s",
            session_id, exc,
        )
        return []


# ---------------------------------------------------------------------------
# Lifecycle cleanup
# ---------------------------------------------------------------------------

def delete_session_collection(session_id: int) -> bool:
    """
    Drop the per-session collection when the session is closed.
    Best-effort: never raises — logs and returns False on failure so the
    caller (action_close) can finish closing the session regardless.
    """
    try:
        _client().delete_collection(_collection_name(session_id))
        _logger.info("[SessionRecall] Deleted collection for session %s", session_id)
        return True
    except Exception as exc:
        # delete_collection raises if the collection never existed (e.g.
        # session was closed before any pair was indexed). That's fine.
        _logger.info(
            "[SessionRecall] delete_collection no-op for session %s: %s",
            session_id, exc,
        )
        return False
