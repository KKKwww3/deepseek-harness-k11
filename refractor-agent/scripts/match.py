#!/usr/bin/env python3
"""Match a refractor recognition to the standard industry name.

Query text = ``pattern + color + desc``. The vector library holds one vector per
registered refraction (``dicts/refractions.yml``), so matching is a single
cosine search. After the best match clears the threshold, the ``names`` section
maps it to the customer-facing term for that brand x series (same refractor,
different series = different name, e.g. 银折 vs 普折射).

Prints a single JSON object to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from refract_store import (
    Embedder,
    cosine,
    create_store,
    ensure_synced,
    load_env,
    LOCAL_THRESHOLD,
    REMOTE_THRESHOLD,
)

DICT_FILE = "refractions.yml"


def norm(s: str) -> str:
    """Lowercase, strip, and collapse inner whitespace (for alias lookup)."""
    return " ".join(s.strip().lower().split())


def load_dict(dict_dir: Path) -> dict:
    with (dict_dir / DICT_FILE).open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def alias_map(doc: dict, group: str) -> dict[str, str]:
    """{normalized alias: canonical key} for brands or series."""
    out: dict[str, str] = {}
    for canon, aliases in (doc.get("aliases", {}).get(group) or {}).items():
        for a in [canon, *(aliases or [])]:
            out[norm(a)] = canon
    return out


def query_text(rec: dict) -> str:
    parts = [rec.get("pattern", ""), rec.get("color", ""), rec.get("desc", "")]
    return " ".join(p for p in parts if p)


def best_type(scores: list[tuple[float, dict]], threshold: float) -> dict | None:
    if not scores:
        return None
    score, row = max(scores, key=lambda t: t[0])
    if score < threshold:
        return None
    return {"matched": True, "pattern": row["pattern"], "color": row["color"],
            "matchScore": round(score, 4)}


def series_name(rec: dict, pattern: str, color: str, dict_dir: Path) -> dict | None:
    """Look up the customer-facing name in this brand x series from the single dict."""
    brand, series = rec.get("brand"), rec.get("series")
    if not brand or not series:
        return None
    doc = load_dict(dict_dir)
    b = alias_map(doc, "brands").get(norm(brand), norm(brand)) or None
    s = alias_map(doc, "series").get(norm(series), norm(series)) or None
    if not b or not s:
        return None
    key = f"{b}-{s}"
    for e in doc.get("refractions", []):
        if e.get("pattern") == pattern and e.get("color") == color:
            n = (e.get("names") or {}).get(key)
            if n:
                return {"refraction": n["name"], "name_en": n.get("name_en")}
            return None  # type known, but this series does not sell it
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rec", required=True, help="JSON string with pattern/color/brand/series/desc")
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    ap.add_argument("--dict-dir", default=str(Path(__file__).parent.parent / "dicts"))
    ap.add_argument("--threshold", type=float, default=None,
                    help="defaults to REMOTE/LOCAL threshold based on embedder mode")
    args = ap.parse_args()

    rec = json.loads(args.rec)

    load_env()

    # a plain card is not a refraction and not a failure
    if rec.get("pattern") == "平卡":
        print(json.dumps({"matched": False, "refraction": None, "needsReview": False}))
        return 0

    # auto-rebuild the vector store when dicts/*.yml changed
    sync = ensure_synced(Path(args.dict_dir))
    if sync != "synced":
        print(f"[sync] vector store {sync}", file=sys.stderr)

    embedder = Embedder()
    threshold = args.threshold if args.threshold is not None else (
        REMOTE_THRESHOLD if embedder.remote else LOCAL_THRESHOLD)

    store = create_store(args.db)
    rows = store.rows()
    if not rows:
        print("empty store; run scripts/embed.py first", file=sys.stderr)
        return 1

    qv = embedder.embed([query_text(rec)])[0]
    scores = [(cosine(qv, r["vector"]), r) for r in rows]
    typ = best_type(scores, threshold)

    if typ is None:
        print(json.dumps({"matched": False, "needsReview": True}))
        return 0

    naming = series_name(rec, typ["pattern"], typ["color"], Path(args.dict_dir))
    if naming is None:
        # type matched, but we cannot name it for this series (unknown brand/series
        # or the series does not sell this refractor) -> needs review
        print(json.dumps({**typ, "refraction": None, "needsReview": True}))
        return 0

    print(json.dumps({**typ, **naming, "needsReview": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
