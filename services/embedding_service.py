# -*- coding: utf-8 -*-
"""
embedding_service.py
--------------------
Converts text to 384-dim vectors using fastembed (BAAI/bge-small-en-v1.5).

WHY FASTEMBED INSTEAD OF SENTENCE-TRANSFORMERS:
    sentence-transformers depends on transformers → torch (PyTorch).
    PyTorch requires libtorch_python.so which can fail to load in constrained
    environments (low RAM, missing glibc symbols, broken venv installs).
    fastembed uses ONNX Runtime instead of PyTorch — no torch dependency,
    same embedding quality, much smaller install footprint (~50 MB vs ~2 GB).

INSTALL:
    pip install fastembed --break-system-packages

MODEL:
    BAAI/bge-small-en-v1.5 — 384 dimensions, multilingual-friendly,
    well-suited for short conversational facts and preferences.

SINGLETON:
    Model is loaded once per Odoo worker process and cached in _model.
    Avoids re-downloading/re-initializing on every message.

USED BY: memory_service.py
"""

import logging
from fastembed import TextEmbedding

_logger = logging.getLogger(__name__)

MODEL_NAME = "BAAI/bge-small-en-v1.5"
_model: TextEmbedding | None = None


def _get_model() -> TextEmbedding:
    """Lazy-load the model on first call, reuse on subsequent calls."""
    global _model
    if _model is None:
        _logger.info("[EmbeddingService] Loading fastembed model '%s'...", MODEL_NAME)
        _model = TextEmbedding(model_name=MODEL_NAME)
        _logger.info("[EmbeddingService] Model loaded and cached.")
    return _model


def embed_text(text: str) -> list[float]:
    """
    Embed a single string into a 384-dim vector.
    Raises ValueError on empty input.
    """
    if not text or not text.strip():
        raise ValueError("[EmbeddingService] Cannot embed empty text.")
    model = _get_model()
    # fastembed.embed() returns a generator of numpy arrays
    vectors = list(model.embed([text]))
    return vectors[0].tolist()


def embed_texts(texts: list[str]) -> list[list[float]]:
    """
    Batch-embed multiple strings.
    Returns list of vectors in the same order as input.
    """
    if not texts:
        return []
    model = _get_model()
    return [v.tolist() for v in model.embed(texts)]