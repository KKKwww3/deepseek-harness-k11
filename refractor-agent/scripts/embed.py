#!/usr/bin/env python3
"""Build the refractor vector library from the single editable dict.

Reads ``dicts/refractions.yml`` (one entry per database row), validates it, and
idempotently rebuilds the vector store (Supabase pgvector by default). Each
entry's ``pattern`` / ``color`` / ``keywords`` are employee-edited; ``id`` /
``text`` / ``vector`` are generated here. ``names`` per series are validated to
reference registered keys but live only in the dict (used by match output).

Exit non-zero on dictionary validation failure.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from refract_store import (
    Embedder,
    create_store,
    load_env,
    write_fingerprint,
)

DICT_FILE = "refractions.yml"


def load_yaml(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if not isinstance(doc, dict):
        raise SystemExit(f"{path} is not a YAML mapping")
    return doc


def validate(doc: dict, path: Path) -> list[str]:
    """Check enum (auto-derived), (pattern,color) uniqueness, keywords, names keys."""
    errors = []
    entries = doc.get("refractions", [])
    seen: set[tuple[str, str]] = set()
    for i, e in enumerate(entries):
        pat, color = e.get("pattern"), e.get("color")
        key = (pat, color)
        if key in seen:
            errors.append(f"[{path}] duplicate (pattern,color)=({pat},{color}) at #{i}")
        seen.add(key)
        if not pat or not color:
            errors.append(f"[{path}] #{i} needs pattern and color")
        if not isinstance(e.get("keywords"), list) or not e["keywords"]:
            errors.append(f"[{path}] #{i} ({pat},{color}) needs non-empty keywords")
        names = e.get("names") or {}
        for series_key, n in names.items():
            if not n.get("name") or not n.get("name_en"):
                errors.append(f"[{path}] #{i} series '{series_key}' needs name+name_en")
    if not seen:
        errors.append(f"[{path}] no refractions defined")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dict-dir", default=str(Path(__file__).parent.parent / "dicts"))
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    args = ap.parse_args()

    load_env()
    dict_dir = Path(args.dict_dir)
    path = dict_dir / DICT_FILE
    doc = load_yaml(path)

    errors = validate(doc, path)
    if errors:
        for e in errors:
            print(f"VALIDATION ERROR: {e}", file=sys.stderr)
        return 1

    embedder = Embedder()
    print("embedder: " + ("remote" if embedder.remote else "local-fallback (set EMBED_*)"))

    rows = []
    for e in doc["refractions"]:
        pat, color = e["pattern"], e["color"]
        text = " ".join([pat, color, *e["keywords"]])
        rows.append({
            "id": f"{pat}-{color}",
            "pattern": pat,
            "color": color,
            "keywords": e["keywords"],
            "text": text,
        })

    vecs = embedder.embed([r["text"] for r in rows])
    for r, v in zip(rows, vecs):
        r["vector"] = v

    store = create_store(args.db)
    store.reset(rows)
    write_fingerprint(dict_dir)
    print(f"wrote {len(rows)} refraction entries -> {store.__class__.__name__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
