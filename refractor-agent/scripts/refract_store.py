"""Shared vector store + embedder for refractor-agent.

Production uses the Volcano Ark multimodal embeddings endpoint
(``EMBED_BASE_URL`` / ``EMBED_API_KEY`` / ``EMBED_MODEL``) and stores vectors in a
LanceDB database (the "external vector library"). When no embeddings endpoint is
configured the scripts fall back to a deterministic local hasher so dict
validation and the matching logic stay runnable offline.

The multimodal endpoint returns ONE vector per request (the whole ``input`` list
is treated as one multimodal document), so ``embed()`` issues one request per
text — dicts are small (tens of entries), so this is fine.

Deployment-varying values come from the environment (no hardcoded tunables).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Sequence

import numpy as np

TABLE = "refractors"
LOCAL_DIM = 256
# cosine thresholds: calibrated for doubao-embedding-vision-251215 on the seed
# golden set (sweep: perfect at 0.50-0.70, drops at 0.75+ because borderline
# bucket matches fall back to the full library and cross-series terms win; re-run
# `evaluate.py --sweep` after enlarging the golden set with real VLM recs).
REMOTE_THRESHOLD = 0.70
LOCAL_THRESHOLD = 0.5


def _env(*names: str, default: str | None = None) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def load_env() -> None:
    """Load ``.env`` files without overriding real env vars.

    Candidates, in order: the repo root (``refractor-agent/.env``), then ``.env``
    files found by walking up from the current directory (so a workspace-root
    ``.env`` is found when running from anywhere inside the workspace). Minimal
    parser: ``KEY=VALUE`` lines, ``#`` comments, no shell expansion.
    """
    candidates: list[Path] = [Path(__file__).resolve().parent.parent / ".env"]
    cwd = Path.cwd()
    for parent in (cwd, *cwd.parents):
        if parent == cwd.parents[-1]:  # filesystem root has no basename .env
            break
        candidates.append(parent / ".env")
    seen: set[Path] = set()
    for path in candidates:
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


class Embedder:
    def __init__(self) -> None:
        base = _env("EMBED_BASE_URL", "OPENAI_BASE_URL")
        key = _env("EMBED_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY")
        model = _env("EMBED_MODEL")
        self._remote = bool(base and key and model)
        self._base = (base or "").rstrip("/")
        self._key = key or ""
        self._model = model

    @property
    def remote(self) -> bool:
        return self._remote

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if self._remote:
            return [self._remote_one(t) for t in texts]
        return [self._local(t) for t in texts]

    def _remote_one(self, text: str) -> list[float]:
        # Volcano Ark multimodal endpoint: input is a list of multimodal parts,
        # the whole list is embedded as one document -> one vector per call.
        url = self._base + "/embeddings/multimodal"
        payload = json.dumps(
            {"model": self._model, "input": [{"type": "text", "text": text}]}
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # surface the API error message
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"embedding API error {exc.code}: {detail}") from exc
        data = body.get("data")
        if isinstance(data, dict):
            return list(data["embedding"])
        if isinstance(data, list) and data:
            return list(data[0]["embedding"])
        raise RuntimeError(f"unexpected embedding response: {body}")

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


def main() -> int:  # convenience: source the environment and report mode
    load_env()
    e = Embedder()
    print("embedder: " + ("remote" if e.remote else "local-fallback (set EMBED_*)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
