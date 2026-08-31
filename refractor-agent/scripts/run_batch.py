#!/usr/bin/env python3
"""Batch refractor normalization with a resume-able manifest state machine.

Input: an input directory of groups, each group is a subdirectory holding a
card front + back image (extra images are passed along too). For each pending
group the script: calls the VLM (see ``vlm.py``) on the group images to produce
a structured recognition, vector-matches it to a standard term, and writes the
result. Low-confidence / failed groups land in review.jsonl.

Manifest contract: pending -> in-flight -> done. Failed items are classified
into retryable_failed (retried on the next run, up to BATCH_MAX_ATTEMPTS),
review_required (business validation failures, human review), and terminal_failed
(never reprocessed, like done/skipped), so an interrupted run resumes safely.

VLM env: VLM_BASE_URL / VLM_API_KEY / VLM_MODEL (see scripts/vlm.py)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from refract_store import load_env
from vlm import IMAGE_EXTS, VLMResponseError, recognize

DEFAULT_MAX_BATCH_ATTEMPTS = 3
REVIEW_ERROR_CODES = {"business_validation_failed"}


def max_batch_attempts() -> int:
    """Read the bounded whole-item retry limit from deployment configuration."""
    value = os.environ.get("BATCH_MAX_ATTEMPTS")
    if value is None:
        return DEFAULT_MAX_BATCH_ATTEMPTS
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError("BATCH_MAX_ATTEMPTS must be an integer") from exc
    if not 1 <= parsed <= 10:
        raise ValueError("BATCH_MAX_ATTEMPTS must be between 1 and 10")
    return parsed


def classify_failure(exc: Exception, attempt: int, limit: int) -> tuple[str, bool]:
    """Classify a failed item for the next run and human review."""
    code = getattr(exc, "code", "batch_error")
    if code in REVIEW_ERROR_CODES:
        return "review_required", False
    retryable = isinstance(exc, VLMResponseError) and bool(exc.retryable)
    if retryable and attempt < limit:
        return "retryable_failed", True
    return "terminal_failed", False


def failure_record(item: dict, exc: Exception, status: str, retryable: bool) -> dict:
    """Build a bounded, structured failure record without provider secrets."""
    return {
        "itemId": item["id"],
        "status": status,
        "attempt": item["attempt"],
        "errorCode": getattr(exc, "code", "batch_error"),
        "retryable": retryable,
        "lastError": str(exc)[:500],
    }


def load_manifest(work_dir: Path) -> list[dict]:
    mp = work_dir / "manifest.jsonl"
    if not mp.exists():
        return []
    return [json.loads(line) for line in mp.read_text(encoding="utf-8").splitlines() if line.strip()]


def save_manifest(work_dir: Path, manifest: list[dict]) -> None:
    lines = [json.dumps(m, ensure_ascii=False) for m in manifest]
    (work_dir / "manifest.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def ensure_manifest(input_dir: Path, work_dir: Path, manifest: list[dict]) -> list[dict]:
    if manifest:
        return manifest
    for sub in sorted(input_dir.iterdir()):
        if not sub.is_dir():
            continue
        images = [p for p in sub.iterdir() if p.suffix.lower() in IMAGE_EXTS]
        if images:
            manifest.append({"id": sub.name, "path": str(sub), "status": "pending"})
    if manifest:
        save_manifest(work_dir, manifest)
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="input dir of group subdirs")
    ap.add_argument("--work", required=True, help="work dir for manifest/result/review")
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    ap.add_argument("--threshold", type=float, default=None,
                    help="optional; defaults to mode-aware threshold in match.py")
    ap.add_argument("--dry-run", action="store_true", help="inspect manifest without processing")
    args = ap.parse_args()

    load_env()
    import subprocess  # local import to keep module top clean

    input_dir = Path(args.input)
    work_dir = Path(args.work)
    work_dir.mkdir(parents=True, exist_ok=True)
    res_path = work_dir / "result.jsonl"
    rev_path = work_dir / "review.jsonl"

    manifest = ensure_manifest(input_dir, work_dir, load_manifest(work_dir))
    if not manifest:
        print("nothing to process", file=sys.stderr)
        return 0
    if args.dry_run:
        statuses = {}
        for m in manifest:
            statuses[m["status"]] = statuses.get(m["status"], 0) + 1
        print(json.dumps(statuses))
        return 0

    from match import main as _  # noqa: F401  # ensure sibling import path works
    # match is invoked via its own module for clarity below

    ok = fail = review = 0
    attempt_limit = max_batch_attempts()
    for item in manifest:
        if item["status"] in ("done", "skipped", "terminal_failed", "review_required"):
            continue
        item["status"] = "in-flight"
        save_manifest(work_dir, manifest)
        group = Path(item["path"])
        images = [p for p in group.iterdir() if p.suffix.lower() in IMAGE_EXTS]
        try:
            rec = recognize(images)
            args_rec = json.dumps(rec, ensure_ascii=False)
            out = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("match.py")),
                 "--rec", args_rec, "--db", args.db]
                + (["--threshold", str(args.threshold)] if args.threshold is not None else []),
                check=True, capture_output=True, text=True,
            )
            result = json.loads(out.stdout)
            record = {"itemId": item["id"], **{k: rec.get(k) for k in
                      ("brand", "series", "pattern", "color", "desc")}, **result}
            with res_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            ok += 1
            if record.get("needsReview") or result.get("needsReview"):
                review += 1
                with rev_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            item["status"] = "done"
            save_manifest(work_dir, manifest)
        except Exception as exc:  # noqa: BLE001 - classified by error code below
            attempt = item.get("attempt", 0) + 1
            item["attempt"] = attempt
            status, retryable = classify_failure(exc, attempt, attempt_limit)
            item["status"] = status
            save_manifest(work_dir, manifest)
            with rev_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(failure_record(item, exc, status, retryable),
                                    ensure_ascii=False) + "\n")
            if status == "review_required":
                review += 1
            else:
                fail += 1
            print(f"failed {item['id']} ({status}): {exc}", file=sys.stderr)

    print(f"summary: ok={ok} review={review} fail={fail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())