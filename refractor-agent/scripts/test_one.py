#!/usr/bin/env python3
"""Single-shot real-data test: card images -> VLM recognition -> match -> result.

One real card (front+back), end to end:

    python scripts/test_one.py <front> <back>

Prints the VLM recognition and the matched standard term. With ``--record`` the
case is appended to eval/golden.yaml so it can later run under
``evaluate.py --mode live`` (give ``--label`` for the case id and ``--expected``
when you know the ground-truth term; otherwise review the printed recognition
and fill expected before evaluating).

Exit code 0 even on needsReview (that is a valid outcome); 1 on hard errors.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

from vlm import recognize

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "eval" / "golden.yaml"
IMAGES_ROOT = ROOT / "eval" / "images"


def record_case(label: str, images: list[Path], rec: dict, expected: str | None) -> None:
    """Append the case to golden.yaml, copying images under eval/images."""
    front, *rest = images
    images_root = IMAGES_ROOT
    if not front.is_relative_to(images_root):
        images_root.mkdir(parents=True, exist_ok=True)
        copied = []
        for p in images:
            dst = images_root / p.name
            dst.write_bytes(p.read_bytes())
            copied.append(dst)
        front = copied[0]
        rest = copied[1:]
    rel = lambda p: str(p.relative_to(images_root))  # noqa: E731

    expected_doc: dict = {"brand": rec.get("brand"), "series": rec.get("series")}
    if expected:
        expected_doc["refraction"] = expected
        expected_doc["pattern"] = rec.get("pattern")
        expected_doc["color"] = rec.get("color")
    else:
        expected_doc["refraction"] = None  # 待员工补 ground truth
        expected_doc["pattern"] = rec.get("pattern")
        expected_doc["color"] = rec.get("color")

    with GOLDEN.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    case = {"id": label, "front": rel(front), "back": rel(rest[0]),
            "expected": expected_doc, "rec": rec}
    doc.setdefault("cases", []).append(case)
    with GOLDEN.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(doc, fh, allow_unicode=True, sort_keys=False)
    print(f"[record] case '{label}' appended to {GOLDEN.relative_to(ROOT)}"
          + ("" if expected else " — 记得补 expected.refraction"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("images", nargs="+", help="card images (front+back, any order)")
    ap.add_argument("--record", action="store_true", help="append this case to golden.yaml")
    ap.add_argument("--label", default="manual", help="case id when --record")
    ap.add_argument("--expected", default=None, help="known standard term when --record")
    args = ap.parse_args()

    images = [Path(p) for p in args.images]
    missing = [p for p in images if not p.is_file()]
    if missing:
        print(f"missing image files: {[str(p) for p in missing]}", file=sys.stderr)
        return 1

    print("── VLM 识别 ─────────────────────────────────────")
    rec = recognize(images)
    print(json.dumps(rec, ensure_ascii=False))

    print("\n── 匹配 ────────────────────────────────────────")
    out = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "match.py"),
         "--rec", json.dumps(rec, ensure_ascii=False)],
        check=True, capture_output=True, text=True,
    )
    print(out.stdout.strip())
    result = json.loads(out.stdout)

    if args.record:
        record_case(args.label, images, rec, args.expected)

    return 0


if __name__ == "__main__":
    sys.exit(main())
