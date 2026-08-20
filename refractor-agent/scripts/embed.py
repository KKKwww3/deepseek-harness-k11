#!/usr/bin/env python3
"""Build the refractor vector library from the editable dicts.

Scans ``dicts/*.yml`` (skipping ``schema.md``), validates each dictionary, embeds
every refraction entry, and (idempotently) rebuilds the LanceDB bucket.

Exit non-zero on dictionary validation failure (e.g. duplicate ``(pattern,color)``).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from refract_store import Embedder, Store, load_env

DICT_GLOB = "dicts/*.yml"
ENUM_FILE = "enum.yml"


def load_dicts(dict_dir: Path) -> list[dict]:
    dicts = []
    for path in sorted(dict_dir.glob("*.yml")):
        with path.open(encoding="utf-8") as fh:
            doc = yaml.safe_load(fh)
        if not isinstance(doc, dict) or "refractions" not in doc:
            continue
        doc["_file"] = str(path)
        dicts.append(doc)
    return dicts


def load_enum(dict_dir: Path) -> dict[str, list[str]]:
    """Load the controlled pattern/color enum (dicts/enum.yml)."""
    path = dict_dir / ENUM_FILE
    with path.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if not isinstance(doc, dict) or "pattern" not in doc or "color" not in doc:
        raise SystemExit(f"{path} must define pattern and color lists")
    return doc


def validate(doc: dict, enum: dict[str, list[str]]) -> list[str]:
    """Return a list of validation errors (empty means valid)."""
    errors = []
    for key in ("brand", "series", "year", "refractions"):
        if key not in doc:
            errors.append(f"[{doc.get('_file')}] missing top-level '{key}'")
    seen = {}
    for i, refr in enumerate(doc.get("refractions", [])):
        pat = refr.get("pattern")
        color = refr.get("color")
        key = (pat, color)
        if key in seen:
            errors.append(
                f"[{doc.get('_file')}] duplicate (pattern,color)=({pat},{color}) "
                f"between #{seen[key]} and #{i}; same pattern+color must be one entry"
            )
        seen[key] = i
        for field in ("name", "name_en", "pattern", "color", "keywords"):
            if field not in refr:
                errors.append(f"[{doc.get('_file')}] refraction #{i} missing '{field}'")
        if not isinstance(refr.get("keywords"), list):
            errors.append(f"[{doc.get('_file')}] refraction #{i} 'keywords' must be a list")
        if refr.get("pattern") not in enum["pattern"]:
            errors.append(
                f"[{doc.get('_file')}] refraction #{i} pattern={refr.get('pattern')!r} "
                f"not in controlled enum (see dicts/enum.yml)"
            )
        if refr.get("color") not in enum["color"]:
            errors.append(
                f"[{doc.get('_file')}] refraction #{i} color={refr.get('color')!r} "
                f"not in controlled enum (see dicts/enum.yml)"
            )
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dict-dir", default=str(Path(__file__).parent.parent / "dicts"))
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    args = ap.parse_args()

    load_env()
    dict_dir = Path(args.dict_dir)
    dicts = load_dicts(dict_dir)
    if not dicts:
        print(f"no dicts found under {dict_dir}", file=sys.stderr)
        return 1

    enum = load_enum(dict_dir)
    all_errors: list[str] = []
    for doc in dicts:
        all_errors.extend(validate(doc, enum))
    if all_errors:
        for e in all_errors:
            print(f"VALIDATION ERROR: {e}", file=sys.stderr)
        return 1

    embedder = Embedder()
    print("embedder: " + ("remote" if embedder.remote else "local-fallback (set EMBED_*)"))
    if embedder.remote:
        # remote dim unknown up front; fine, LanceDB infers from first row
        pass

    rows = []
    for doc in dicts:
        brand = doc["brand"]
        series = doc["series"]
        year = doc["year"]
        for refr in doc["refractions"]:
            text = " ".join(
                [refr["name"], refr["name_en"], *refr["keywords"], refr["pattern"], refr["color"]]
            )
            rows.append(
                {
                    "id": f"{brand}-{series}-{refr['pattern']}-{refr['color']}",
                    "brand": brand,
                    "series": series,
                    "year": year,
                    "name": refr["name"],
                    "name_en": refr["name_en"],
                    "pattern": refr["pattern"],
                    "color": refr["color"],
                    "keywords": refr["keywords"],
                    "text": text,
                }
            )

    vecs = embedder.embed([r["text"] for r in rows])
    for r, v in zip(rows, vecs):
        r["vector"] = v

    Store(args.db).reset(rows)
    print(f"wrote {len(rows)} refraction entries -> {args.db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())