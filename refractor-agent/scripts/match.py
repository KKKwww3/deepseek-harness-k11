#!/usr/bin/env python3
"""Match a refractor recognition (structured) to the standard industry name.

Query text = ``pattern + color + desc`` so the same pattern with a different color
scores separately. Matches inside the brand x series bucket first; if nothing
clears the threshold, expands to the full library before giving up.

Prints a single JSON object to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from refract_store import Embedder, Store, bucket_rows, load_env, LOCAL_THRESHOLD, REMOTE_THRESHOLD


def query_text(rec: dict) -> str:
    parts = [rec.get("pattern", ""), rec.get("color", ""), rec.get("desc", "")]
    return " ".join(p for p in parts if p)


def best_match(scores: list[tuple[float, dict]], threshold: float) -> dict | None:
    if not scores:
        return None
    score, row = max(scores, key=lambda t: t[0])
    if score < threshold:
        return None
    return {"matched": True, "refraction": row["name"], "name_en": row["name_en"],
            "pattern": row["pattern"], "color": row["color"], "matchScore": round(score, 4)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rec", required=True, help="JSON string with pattern/color/brand/year/series/desc")
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    ap.add_argument("--threshold", type=float, default=None,
                    help="defaults to REMOTE/LOCAL threshold based on embedder mode")
    args = ap.parse_args()

    rec = json.loads(args.rec)

    load_env()

    # a plain card is not a refraction and not a failure
    if rec.get("pattern") == "平卡":
        print(json.dumps({"matched": False, "refraction": None, "needsReview": False}))
        return 0

    embedder = Embedder()
    threshold = args.threshold if args.threshold is not None else (
        REMOTE_THRESHOLD if embedder.remote else LOCAL_THRESHOLD)

    store = Store(args.db)
    rows = store.rows()
    if not rows:
        print("empty store; run scripts/embed.py first", file=sys.stderr)
        return 1

    q = store.cosine  # band-friendly alias
    qv = embedder.embed([query_text(rec)])[0]

    def rank(candidates):
        return [(q(qv, r["vector"]), r) for r in candidates]

    out = None
    bucket = bucket_rows(rows, rec.get("brand", ""), rec.get("series", ""))
    if bucket:
        out = best_match(rank(bucket), threshold) or best_match(rank(rows), threshold)
    else:
        out = best_match(rank(rows), threshold)

    if out is None:
        out = {"matched": False, "needsReview": True}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())