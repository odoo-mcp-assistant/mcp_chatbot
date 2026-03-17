# -*- coding: utf-8 -*-
"""
memory_service.py
-----------------
Long-term memory: stores and retrieves user facts/preferences in ChromaDB.

SETUP:
    ChromaDB must run as a SEPARATE HTTP server:
        chroma run --host 0.0.0.0 --port 8015 --path /opt/chroma_data

    One ChromaDB collection per user: "user_memory_{partner_id}"

DEDUPLICATION:
    Before writing a new fact, the top-1 most similar existing fact is checked.
    If cosine similarity > DEDUP_THRESHOLD (0.92), the existing entry is UPDATED
    instead of adding a near-duplicate.

CAPACITY:
    MAX_MEMORIES_PER_USER = 200. Oldest entries are pruned when exceeded.

USED BY: mcp_client_service.py, fact_extractor.py
"""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

import chromadb
import embedding_service

_logger = logging.getLogger(__name__)

CHROMA_HOST = "localhost"
CHROMA_PORT = 8015
DEDUP_THRESHOLD = 0.92
MAX_MEMORIES_PER_USER = 200
MIN_RETRIEVAL_SIMILARITY = 0.30


def _client() -> chromadb.HttpClient:
    return chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)


def _collection(client, user_id: str):
    return client.get_or_create_collection(
        name=f"user_memory_{user_id}",
        metadata={"hnsw:space": "cosine"},
    )


def _sim(distance: float) -> float:
    """ChromaDB cosine distance → similarity in [0, 1]."""
    return 1.0 - (distance / 2.0)


def _doc_id(user_id: str, text: str) -> str:
    return hashlib.md5(f"{user_id}::{text}".encode()).hexdigest()


def _prune_oldest(col, keep: int):
    try:
        items = col.get(include=["metadatas"])
        if not items["ids"]:
            return
        pairs = sorted(
            zip(items["ids"], items["metadatas"]),
            key=lambda x: x[1].get("created_at", ""),
        )
        to_del = [i for i, _ in pairs[:-keep]] if keep > 0 else [i for i, _ in pairs]
        if to_del:
            col.delete(ids=to_del)
            _logger.info("[MemoryService] Pruned %d old memories.", len(to_del))
    except Exception as exc:
        _logger.error("[MemoryService] Prune failed: %s", exc)


def store_memory(user_id: str, fact_text: str, metadata: Optional[dict] = None) -> bool:
    """
    Store a user fact. Deduplicates near-identical facts automatically.

    Args:
        user_id:   Odoo partner ID as string.
        fact_text: The fact to store.
        metadata:  Optional extra fields (category, source, etc.).

    Returns True on success, False on error.
    """
    try:
        c = _client()
        col = _collection(c, user_id)
        emb = embedding_service.embed_text(fact_text)
        count = col.count()

        if count > 0:
            res = col.query(query_embeddings=[emb], n_results=1, include=["distances", "documents"])
            if res["distances"] and res["distances"][0]:
                if _sim(res["distances"][0][0]) > DEDUP_THRESHOLD:
                    _logger.info(
                        "[MemoryService] Dedup update for user %s: '%s'", user_id, fact_text[:60]
                    )
                    col.update(
                        ids=[res["ids"][0][0]],
                        documents=[fact_text],
                        embeddings=[emb],
                        metadatas=[{**(metadata or {}), "user_id": user_id, "updated_at": datetime.now(timezone.utc).isoformat()}],
                    )
                    return True

        if count >= MAX_MEMORIES_PER_USER:
            _prune_oldest(col, keep=MAX_MEMORIES_PER_USER - 1)

        col.add(
            ids=[_doc_id(user_id, fact_text)],# Genere un id par le hashage mix de user id et le text de fact car chromadb necessite un id pour chaque document 
            documents=[fact_text],# Le texte brut du fait (stocké en clair dans ChromaDB).
            embeddings=[emb],
            metadatas=[{**(metadata or {}), "user_id": user_id, "created_at": datetime.now(timezone.utc).isoformat()}],
        )
        _logger.info("[MemoryService] Stored new memory for user %s: '%s'", user_id, fact_text[:80])
        return True

    except Exception as exc:
        _logger.error("[MemoryService] store_memory failed for user %s: %s", user_id, exc)
        return False


def retrieve_memories(user_id: str, query_text: str, n_results: int = 5) -> list[str]:
    """
    Retrieve the N most semantically relevant facts for a user.

    Args:
        user_id:    Odoo partner ID as string.
        query_text: Current user message (semantic search query).
        n_results:  Max number of facts to return.

    Returns list of fact strings (most relevant first), or [] on error/empty.
    """
    try:
        c = _client()
        col = _collection(c, user_id)
        count = col.count()
        if count == 0:
            return []

        emb = embedding_service.embed_text(query_text)
        res = col.query(
            query_embeddings=[emb],
            n_results=min(n_results, count),# Sécurité : on ne peut pas demander plus de résultats qu'il n'y en a.
            include=["documents", "distances"],
        )

        if not res["documents"] or not res["documents"][0]:
            return []

        return [
            doc for doc, dist in zip(res["documents"][0], res["distances"][0])
            if _sim(dist) >= MIN_RETRIEVAL_SIMILARITY
        ]

    except Exception as exc:
        _logger.error("[MemoryService] retrieve_memories failed for user %s: %s", user_id, exc)
        return []


def get_memory_count(user_id: str) -> int:
    """Retourne le nombre de faits stockés pour un utilisateur. Utilitaire de debug."""
    try:
        return _collection(_client(), user_id).count()
    except Exception:
        return 0


def delete_all_memories(user_id: str) -> bool:
    """Drop the entire collection for a user (GDPR deletion)."""
    try:
        _client().delete_collection(f"user_memory_{user_id}")
        _logger.info("[MemoryService] Deleted all memories for user %s", user_id)
        return True
    except Exception as exc:
        _logger.error("[MemoryService] delete_all_memories failed for user %s: %s", user_id, exc)
        return False
