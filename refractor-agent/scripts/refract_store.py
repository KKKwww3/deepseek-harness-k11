"""Shared vector store + embedder for refractor-agent.

Production uses the Volcano Ark multimodal embeddings endpoint
(``EMBED_BASE_URL`` / ``EMBED_API_KEY`` / ``EMBED_MODEL``). Vectors live in an
external store selected by ``VECTOR_STORE``:

- ``pgvector`` (default): a Supabase/Postgres table (cloud-durable; the whole
  dictionary could be rebuilt, but the store survives local disk loss and hosts
  future non-regenerable data). Configured via ``SUPABASE_DB_URL``.
- ``lance``: local LanceDB file (``db/refractors.lance``), used as offline
  fallback when no Supabase URL is configured.

The multimodal embedding endpoint returns ONE vector per request (the whole
``input`` list is treated as one multimodal document), so ``embed()`` issues one
request per text — dicts are small (tens of entries), so this is fine.

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

TABLE = "refractor_types"
LOCAL_DIM = 256
# Remote embedding dimension. doubao-embedding-vision-251215 supports MRL
# (dimensions param); 1024 stays under pgvector's 2000-dim HNSW/ivfflat cap while
# keeping quality. Must match the vector column in PgStore.DDL.
REMOTE_DIM_DEFAULT = 1024
# cosine thresholds: calibrated for doubao-embedding-vision-251215 on the seed
# golden set (sweep: perfect at 0.50-0.70, drops at 0.75+ where borderline
# matches no longer clear the bar; re-run `evaluate.py --sweep` after enlarging
# the golden set with real VLM recs).
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


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    x = np.asarray(a, dtype=float)
    y = np.asarray(b, dtype=float)
    denom = float(np.linalg.norm(x) * np.linalg.norm(y))
    if denom == 0.0:
        return 0.0
    return float(np.dot(x, y) / denom)


class Embedder:
    def __init__(self) -> None:
        base = _env("EMBED_BASE_URL", "OPENAI_BASE_URL")
        key = _env("EMBED_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY")
        model = _env("EMBED_MODEL")
        self._remote = bool(base and key and model)
        self._base = (base or "").rstrip("/")
        self._key = key or ""
        self._model = model
        try:
            self._dims = int(_env("EMBED_DIMENSIONS") or REMOTE_DIM_DEFAULT)
        except ValueError:
            self._dims = REMOTE_DIM_DEFAULT

    @property
    def remote(self) -> bool:
        return self._remote

    @property
    def dimensions(self) -> int:
        """Requested remote embedding dimension (used by the pgvector DDL)."""
        return self._dims

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if self._remote:
            return [self._remote_one(t) for t in texts]
        return [self._local(t) for t in texts]

    def _remote_one(self, text: str) -> list[float]:
        # Volcano Ark multimodal endpoint: input is a list of multimodal parts,
        # the whole list is embedded as one document -> one vector per call.
        url = self._base + "/embeddings/multimodal"
        payload = json.dumps(
            {"model": self._model, "dimensions": self._dims,
             "input": [{"type": "text", "text": text}]}
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


# ── vector stores ──────────────────────────────────────────────────────────────

NAMES_TABLE = "refraction_names"


class BaseStore:
    """Minimal store contract used by embed/match/evaluate/run_batch."""

    def reset(self, rows: list[dict[str, Any]]) -> None:
        """Idempotent rebuild: each row needs a ``vector`` list[float]."""
        raise NotImplementedError

    def rows(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def reset_names(self, names: list[dict[str, Any]]) -> None:
        """Idempotent rebuild of the series-naming table."""
        raise NotImplementedError

    def names_for(self, brand: str, series: str, pattern: str, color: str) -> dict | None:
        """Return ``{'name':..., 'name_en':...}`` for a refraction in a series, else None."""
        raise NotImplementedError

    def top1(self, qv: list[float]) -> tuple[float, dict] | None:
        """Highest-similarity refraction as ``(cosine_score, row)``, or None when empty.

        Default implementation scans all rows in Python (used by the local
        backend); ``PgStore`` overrides it with a server-side pgvector search.
        """
        rows = self.rows()
        if not rows:
            return None
        return max((cosine(qv, r["vector"]), r) for r in rows)


class LanceStore(BaseStore):
    """Local LanceDB-backed store (offline fallback, VECTOR_STORE=lance)."""

    def __init__(self, db_path: str) -> None:
        import lancedb

        self._db = lancedb.connect(db_path)

    def reset(self, rows: list[dict[str, Any]]) -> None:
        self._db.create_table(TABLE, data=rows, mode="overwrite")

    def rows(self) -> list[dict[str, Any]]:
        try:
            # to_pylist avoids a pandas dependency; vector comes back as a list
            return self._db.open_table(TABLE).to_arrow().to_pylist()
        except Exception:
            return []

    def reset_names(self, names: list[dict[str, Any]]) -> None:
        self._db.create_table(NAMES_TABLE, data=names, mode="overwrite")

    def names_for(self, brand: str, series: str, pattern: str, color: str) -> dict | None:
        try:
            rows = self._db.open_table(NAMES_TABLE).to_arrow().to_pylist()
        except Exception:
            return None
        for r in rows:
            if (r.get("brand") == brand and r.get("series") == series
                    and r.get("pattern") == pattern and r.get("color") == color):
                return {"name": r["name"], "name_en": r.get("name_en")}
        return None


class PgStore(BaseStore):
    """Supabase/Postgres + pgvector store (VECTOR_STORE=pgvector, default).

    Durable in the cloud: the vector column survives local disk loss. The table
    schema and HNSW index are created idempotently on first ``reset``. The
    vector column dimension follows EMBED_DIMENSIONS (HNSW caps at 2000 dims).
    Rows are GLOBAL refractor types (one per pattern+color, no brand/series). The
    ``refraction_names`` table stores the brand/series-specific output names.
    """

    def __init__(self, dsn: str | None = None, dim: int | None = None) -> None:
        import psycopg

        self._dsn = dsn or _env("SUPABASE_DB_URL")
        if not self._dsn:
            raise RuntimeError(
                "pgvector store needs SUPABASE_DB_URL (or pass dsn to create_store)"
            )
        self._psycopg = psycopg
        try:
            self._dim = dim or int(_env("EMBED_DIMENSIONS") or REMOTE_DIM_DEFAULT)
        except ValueError:
            self._dim = REMOTE_DIM_DEFAULT
        self._ddl = [
            "CREATE EXTENSION IF NOT EXISTS vector",
            f"""CREATE TABLE IF NOT EXISTS {TABLE} (
                id       TEXT PRIMARY KEY,
                pattern  TEXT NOT NULL,
                color    TEXT NOT NULL,
                keywords JSONB,
                text     TEXT,
                vector   VECTOR({self._dim})
            )""",
            f"""CREATE TABLE IF NOT EXISTS {NAMES_TABLE} (
                brand    TEXT NOT NULL,
                series   TEXT NOT NULL,
                pattern  TEXT NOT NULL,
                color    TEXT NOT NULL,
                name     TEXT NOT NULL,
                name_en  TEXT,
                PRIMARY KEY (brand, series, pattern, color)
            )""",
        ]

    def _connect(self):
        return self._psycopg.connect(self._dsn)

    def _ensure_schema(self, conn, create_index: bool = False) -> None:
        with conn.cursor() as cur:
            for stmt in self._ddl:
                cur.execute(stmt)
            if create_index:
                cur.execute(
                    f"CREATE INDEX IF NOT EXISTS {TABLE}_vector_hnsw "
                    f"ON {TABLE} USING hnsw (vector vector_cosine_ops)"
                )
        conn.commit()

    def reset(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self._connect() as conn:
            self._ensure_schema(conn)
            with conn.cursor() as cur:
                cur.execute(f"DELETE FROM {TABLE}")
                for r in rows:
                    cur.execute(
                        f"""INSERT INTO {TABLE}
                            (id, pattern, color, keywords, text, vector)
                            VALUES (%s,%s,%s,%s::jsonb,%s,%s::vector)""",
                        (
                            r["id"], r["pattern"], r["color"],
                            json.dumps(r.get("keywords", []), ensure_ascii=False),
                            r.get("text", ""), json.dumps(r["vector"]),
                        ),
                    )
            conn.commit()

    def rows(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            with conn.cursor() as cur:
                cur.execute(
                    f"""SELECT id, pattern, color, keywords, text, vector::text AS vector
                        FROM {TABLE}"""
                )
                cols = [d.name for d in cur.description]
                out = []
                for rec in cur.fetchall():
                    row = dict(zip(cols, rec))
                    row["vector"] = json.loads(row["vector"])
                    # psycopg3 decodes jsonb to a Python list already
                    if row.get("keywords") is not None and isinstance(row["keywords"], str):
                        row["keywords"] = json.loads(row["keywords"])
                    out.append(row)
        return out

    def reset_names(self, names: list[dict[str, Any]]) -> None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            with conn.cursor() as cur:
                cur.execute(f"DELETE FROM {NAMES_TABLE}")
                for r in names:
                    cur.execute(
                        f"""INSERT INTO {NAMES_TABLE}
                            (brand, series, pattern, color, name, name_en)
                            VALUES (%s,%s,%s,%s,%s,%s)""",
                        (r["brand"], r["series"], r["pattern"], r["color"],
                         r["name"], r.get("name_en")),
                    )
            conn.commit()

    def names_for(self, brand: str, series: str, pattern: str, color: str) -> dict | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            with conn.cursor() as cur:
                cur.execute(
                    f"""SELECT name, name_en FROM {NAMES_TABLE}
                        WHERE brand=%s AND series=%s AND pattern=%s AND color=%s""",
                    (brand, series, pattern, color),
                )
                rec = cur.fetchone()
        if rec is None:
            return None
        return {"name": rec[0], "name_en": rec[1]}

    def top1(self, qv: list[float]) -> tuple[float, dict] | None:
        """Server-side cosine search: pgvector ``<=>`` distance over the table.

        Only the single highest-similarity row is returned (never the whole
        table), so the match path does not pull all vectors into Python.
        """
        with self._connect() as conn:
            self._ensure_schema(conn)
            with conn.cursor() as cur:
                cur.execute(
                    f"""SELECT pattern, color, 1 - (vector <=> %s::vector) AS sim
                        FROM {TABLE}
                        ORDER BY vector <=> %s::vector
                        LIMIT 1""",
                    (json.dumps(qv), json.dumps(qv)),
                )
                rec = cur.fetchone()
        if rec is None:
            return None
        return (float(rec[2]), {"pattern": rec[0], "color": rec[1]})


def create_store(db_path: str | None = None, dsn: str | None = None) -> BaseStore:
    """Build the configured store: pgvector by default, lance as fallback.

    ``VECTOR_STORE`` env selects explicitly (``pgvector`` / ``lance`` / a DSN);
    otherwise pgvector wins when a Supabase URL is configured, else lance.
    """
    default_db = str(Path(__file__).parent.parent / "db" / "refractors.lance")
    vs = _env("VECTOR_STORE")
    if vs:
        vs = vs.strip().lower()
        if vs == "lance":
            return LanceStore(db_path or default_db)
        if vs == "pgvector":
            return PgStore(dsn or _env("SUPABASE_DB_URL"))
        return PgStore(vs)  # explicit DSN value
    if dsn or _env("SUPABASE_DB_URL"):
        return PgStore(dsn)
    return LanceStore(db_path or default_db)


# ── dict→store self-healing sync ───────────────────────────────────────────────

FINGERPRINT_FILE = "vector_fingerprint.json"


def dict_fingerprint(dict_dir: Path) -> str:
    """SHA-1 over every dict *.yml (relative path + bytes) — detects any edit."""
    import hashlib

    h = hashlib.sha1()
    paths = sorted(p for p in Path(dict_dir).rglob("*.yml") if p.is_file())
    for p in paths:
        h.update(str(p.relative_to(dict_dir)).encode("utf-8"))
        h.update(b"\0")
        h.update(p.read_bytes())
    return h.hexdigest()


def fingerprint_path() -> Path:
    return Path(__file__).resolve().parent.parent / "db" / FINGERPRINT_FILE


def write_fingerprint(dict_dir: Path) -> None:
    fp = fingerprint_path()
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(dict_fingerprint(dict_dir), encoding="utf-8")


def ensure_synced(dict_dir: Path) -> str:
    """Auto-rebuild the vector store when the dicts changed (idempotent).

    Returns ``'synced'`` (fingerprint matches), ``'rebuilt'`` (dicts were newer
    and embed.py re-ran), or ``'rebuild-failed'`` (offline/error; caller may
    keep serving the stale store). Match/evaluate call this before reading rows.
    """
    import subprocess
    import sys

    fp = fingerprint_path()
    cur = dict_fingerprint(dict_dir)
    try:
        if fp.is_file() and fp.read_text(encoding="utf-8").strip() == cur:
            return "synced"
    except OSError:
        pass
    try:
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("embed.py")),
             "--dict-dir", str(dict_dir)],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            write_fingerprint(dict_dir)
            return "rebuilt"
        print(f"[sync] rebuild failed:\n{proc.stdout}{proc.stderr}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001 - offline/network failure, keep serving
        print(f"[sync] rebuild error: {exc}", file=sys.stderr)
    return "rebuild-failed"


def main() -> int:  # convenience: source the environment and report mode
    load_env()
    e = Embedder()
    print("embedder: " + ("remote" if e.remote else "local-fallback (set EMBED_*)"))
    print("store: " + type(create_store()).__name__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
