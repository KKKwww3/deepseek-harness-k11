#!/usr/bin/env python3
"""Build the refractor vector library from the editable dicts.

Scans ``dicts/types.yml`` for the global refractor TYPES (one vector per
(pattern,color), shared across series) and ``dicts/series/*.yml`` for the
per-series naming tables. Validates both, embeds every type once, and
(idempotently) rebuilds the vector store (Supabase pgvector by default).

Exit non-zero on dictionary validation failure.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from refract_store import Embedder, create_store, load_env

TYPES_FILE = "types.yml"
SERIES_GLOB = "series/*.yml"


def load_yaml(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if not isinstance(doc, dict):
        raise SystemExit(f"{path} is not a YAML mapping")
    return doc


def validate_types(doc: dict, enum: dict[str, list[str]], path: Path) -> list[str]:
    errors = []
    seen: set[tuple[str, str]] = set()
    for i, t in enumerate(doc.get("types", [])):
        pat, color = t.get("pattern"), t.get("color")
        key = (pat, color)
        if key in seen:
            errors.append(f"[{path}] duplicate type (pattern,color)=({pat},{color}) at #{i}")
        seen.add(key)
        if pat not in enum["pattern"]:
            errors.append(f"[{path}] type #{i} pattern={pat!r} not in controlled enum")
        if color not in enum["color"]:
            errors.append(f"[{path}] type #{i} color={color!r} not in controlled enum")
        if not isinstance(t.get("keywords"), list) or not t["keywords"]:
            errors.append(f"[{path}] type #{i} needs a non-empty keywords list")
    if not seen:
        errors.append(f"[{path}] no types defined")
    return errors


def validate_series(paths: list[Path], known: set[tuple[str, str]]) -> list[str]:
    """Per-series naming tables: every (pattern,color) must exist in types.yml."""
    errors = []
    for path in paths:
        doc = load_yaml(path)
        for key in ("brand", "series", "names"):
            if key not in doc:
                errors.append(f"[{path}] missing top-level '{key}'")
        seen: set[tuple[str, str]] = set()
        for i, n in enumerate(doc.get("names", [])):
            pat, color = n.get("pattern"), n.get("color")
            key = (pat, color)
            if key in seen:
                errors.append(f"[{path}] duplicate (pattern,color)=({pat},{color}) at #{i}")
            seen.add(key)
            if key not in known:
                errors.append(
                    f"[{path}] #{i} ({pat},{color}) not registered in {TYPES_FILE}"
                )
            for field in ("name", "name_en"):
                if not n.get(field):
                    errors.append(f"[{path}] #{i} missing '{field}'")
        if not seen:
            errors.append(f"[{path}] no names defined")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dict-dir", default=str(Path(__file__).parent.parent / "dicts"))
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    args = ap.parse_args()

    load_env()
    dict_dir = Path(args.dict_dir)
    enum = load_yaml(dict_dir / "enum.yml")
    types_doc = load_yaml(dict_dir / TYPES_FILE)
    series_paths = sorted((dict_dir / "series").glob("*.yml"))

    errors = validate_types(types_doc, enum, dict_dir / TYPES_FILE)
    known = {(t["pattern"], t["color"]) for t in types_doc.get("types", [])}
    errors += validate_series(series_paths, known)
    if errors:
        for e in errors:
            print(f"VALIDATION ERROR: {e}", file=sys.stderr)
        return 1

    embedder = Embedder()
    print("embedder: " + ("remote" if embedder.remote else "local-fallback (set EMBED_*)"))

    rows = []
    for t in types_doc["types"]:
        pat, color = t["pattern"], t["color"]
        text = " ".join([pat, color, *t["keywords"]])
        rows.append({
            "id": f"{pat}-{color}",
            "pattern": pat,
            "color": color,
            "keywords": t["keywords"],
            "text": text,
        })

    vecs = embedder.embed([r["text"] for r in rows])
    for r, v in zip(rows, vecs):
        r["vector"] = v

    store = create_store(args.db)
    store.reset(rows)
    print(f"wrote {len(rows)} refraction types -> {store.__class__.__name__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
