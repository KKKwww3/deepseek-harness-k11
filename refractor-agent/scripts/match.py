#!/usr/bin/env python3
"""Match a refractor recognition to the standard industry name.

Query text = ``pattern + color + desc``. The vector table holds one vector per
registered refraction (``refractor_types``), so matching is a single cosine
search. With the pgvector store the search runs **server-side** (``<=>``) and
only the top hit is returned. After the best match clears the threshold, the
series naming table (``refraction_names``) maps the brand x series to the
customer-facing term (same refractor, different series = different name,
e.g. 银折 vs 普折射).

Prints a single JSON object to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from refract_store import (
    Embedder,
    create_store,
    ensure_synced,
    load_env,
    LOCAL_THRESHOLD,
    REMOTE_THRESHOLD,
)


def norm(s: str) -> str:
    """Lowercase, strip, and collapse inner whitespace."""
    return " ".join(s.strip().lower().split())


def query_text(rec: dict) -> str:
    parts = [rec.get("pattern", ""), rec.get("color", ""), rec.get("desc", "")]
    return " ".join(p for p in parts if p)


def best_type(hit: tuple[float, dict] | None, threshold: float) -> dict | None:
    """Turn a store ``top1`` hit into the match result dict (or None below threshold)."""
    if hit is None:
        return None
    score, row = hit
    if score < threshold:
        return None
    return {"matched": True, "pattern": row["pattern"], "color": row["color"],
            "matchScore": round(score, 4)}


def series_name(rec: dict, pattern: str, color: str, store) -> dict | None:
    """Look up the customer-facing name for this brand x series in the DB.

    brand/series come from the VLM as stable text (panini/prizm); we only
    lowercase + collapse whitespace defensively before querying.
    """
    brand, series = rec.get("brand"), rec.get("series")
    if not brand or not series:
        return None
    b = norm(brand) or None
    s = norm(series) or None
    if not b or not s:
        return None
    naming = store.names_for(b, s, pattern, color)
    if naming is None:
        return None
    return {"refraction": naming["name"], "name_en": naming.get("name_en")}


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
    qv = embedder.embed([query_text(rec)])[0]
    hit = store.top1(qv)
    if hit is None:
        print("empty store; run scripts/embed.py first", file=sys.stderr)
        return 1

    typ = best_type(hit, threshold)
    if typ is None:
        print(json.dumps({"matched": False, "needsReview": True}))
        return 0

    naming = series_name(rec, typ["pattern"], typ["color"], store)
    if naming is None:
        # type matched, but we cannot name it for this series (unknown brand/series
        # or the series does not sell this refractor) -> needs review
        print(json.dumps({**typ, "refraction": None, "needsReview": True}))
        return 0

    print(json.dumps({**typ, **naming, "needsReview": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
