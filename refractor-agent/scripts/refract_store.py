"""Shared vector store + embedder for refractor-agent.

Production uses an OpenAI-compatible embeddings endpoint (``EMBED_BASE_URL`` /
``EMBED_API_KEY`` / ``EMBED_MODEL``) and stores vectors in a LanceDB database
(the "external vector library"). When no embeddings endpoint is configured the
scripts fall back to a deterministic local hasher so dict validation and the
matching logic stay runnable offline.

Deployment-varying values come from the environment (no hardcoded tunables).
"""

from __future__ import annotations

import hashlib
import math
import os
from typing import Any, Sequence

import numpy as np

TABLE = "refractors"
LOCAL_DIM = 256
# cosine thresholds: real remote embeddings cluster around 0.7-0.9; the local
# n-gram fallback saturates lower, so the default threshold is mode-aware.
REMOTE_THRESHOLD = 0.85
LOCAL_THRESHOLD = 0.5


def _env(*names: str, default: str | None = None) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


class Embedder:
    def __init__(self) -> None:
        base = _env("EMBED_BASE_URL", "OPENAI_BASE_URL")
        key = _env("EMBED_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY")
        model = _env("EMBED_MODEL")
        self._remote = bool(base and key and model)
        self._client = None
        self._model = model
        if self._remote:
            from openai import OpenAI

            self._client = OpenAI(base_url=base, api_key=key)

    @property
    def remote(self) -> bool:
        return self._remote

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if self._remote:
            resp = self._client.embeddings.create(model=self._model, input=list(texts))
            return [d.embedding for d in resp.data]
        return [self._local(t) for t in texts]

    @staticmethod
    def _local(text: str) -> list[float]:
        # character n-gram count hashing: shared substrings ("红", "碎冰")
        # yield meaningful cosine so the local fallback can discriminate
        # same-pattern/different-color entries offline. Production should set
        # EMBED_* to a real embeddings endpoint for accurate semantics.
        vec = [0.0] * LOCAL_DIM
        grams = list(text)
        grams += [text[i : i + 2] for i in range(len(text) - 1)]
        for g in grams:
            h = hashlib.sha256(g.encode("utf-8")).digest()
            vec[int.from_bytes(h[:3], "big") % LOCAL_DIM] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]


class Store:
    """LanceDB-backed durable store for refraction term vectors."""

    def __init__(self, db_path: str) -> None:
        import lancedb

        self._db = lancedb.connect(db_path)

    def reset(self, rows: list[dict[str, Any]]) -> None:
        """Idempotent rebuild: each row needs a ``vector`` list[float]."""
        self._db.create_table(TABLE, data=rows, mode="overwrite")

    def rows(self) -> list[dict[str, Any]]:
        try:
            # to_pylist avoids a pandas dependency; vector comes back as a list
            return self._db.open_table(TABLE).to_arrow().to_pylist()
        except Exception:
            return []

    @staticmethod
    def cosine(a: Sequence[float], b: Sequence[float]) -> float:
        x = np.asarray(a, dtype=float)
        y = np.asarray(b, dtype=float)
        denom = float(np.linalg.norm(x) * np.linalg.norm(y))
        if denom == 0.0:
            return 0.0
        return float(np.dot(x, y) / denom)


def bucket_rows(rows: list[dict[str, Any]], brand: str, series: str) -> list[dict[str, Any]]:
    return [r for r in rows if r["brand"] == brand and r["series"] == series]