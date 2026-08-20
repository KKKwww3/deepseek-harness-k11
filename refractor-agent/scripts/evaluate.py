#!/usr/bin/env python3
"""Evaluate refractor-agent against the golden dataset (eval/golden.yaml).

Two modes:
  match  — match-layer only: use each case's pre-recorded ``rec`` and run the
           matching logic. Offline, no VLM needed (embeddings still used).
  live   — full pipeline: recognize the card images with the VLM first, then
           match. Needs VLM_* env vars and image files.

Prints a metrics table; also writes metrics.json / errors.jsonl / confusion.json
under the output dir. ``--sweep`` scans thresholds for calibration.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from match import best_type, query_text, series_name
from refract_store import (
    BaseStore,
    Embedder,
    cosine,
    create_store,
    load_env,
    LOCAL_THRESHOLD,
    REMOTE_THRESHOLD,
)
from vlm import recognize

DEFAULT_GOLDEN = Path(__file__).resolve().parent.parent / "eval" / "golden.yaml"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "eval" / "out"
DICT_DIR = Path(__file__).resolve().parent.parent / "dicts"
SWEEP_STEPS = [round(0.50 + 0.05 * i, 2) for i in range(10)]  # 0.50..0.95


def load_cases(golden: Path, images_root: Path) -> list[dict]:
    with golden.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    cases = []
    for c in doc.get("cases", []):
        c["images_root"] = images_root
        cases.append(c)
    return cases


def prepare(cases: list[dict], mode: str, embedder: Embedder) -> list[dict]:
    """Recognize (live) and embed the query once per case; reuse for every threshold."""
    prepared = []
    for case in cases:
        item = {"case": case}
        try:
            if mode == "live":
                imgs = case_images(case)
                if not imgs:
                    item["error"] = "missing images"
                else:
                    item["rec"] = recognize(imgs)
            else:  # match
                rec = case.get("rec")
                if not rec:
                    item["error"] = "case has no rec (match mode)"
                else:
                    item["rec"] = rec
            if "rec" in item and item["rec"].get("pattern") != "平卡":
                item["qv"] = embedder.embed([query_text(item["rec"])])[0]
        except Exception as exc:  # noqa: BLE001 - a bad case must not kill the run
            item["error"] = str(exc)
            item.pop("rec", None)
        prepared.append(item)
    return prepared


def run_match_prepared(item: dict, rows: list[dict], store: BaseStore,
                       threshold: float) -> dict:
    """Match using a precomputed query vector (``qv``): global type match +
    series naming lookup (same logic as scripts/match.py)."""
    rec = item.get("rec")
    if rec is None:
        return {"error": item.get("error", "no rec")}
    if rec.get("pattern") == "平卡":
        return {"matched": False, "refraction": None, "needsReview": False}

    scores = [(cosine(item["qv"], r["vector"]), r) for r in rows]
    typ = best_type(scores, threshold)
    if typ is None:
        return {"matched": False, "needsReview": True}

    naming = series_name(rec, typ["pattern"], typ["color"], DICT_DIR)
    if naming is None:
        return {**typ, "refraction": None, "needsReview": True}
    return {**typ, **naming, "needsReview": False}


def effective_threshold(args_threshold: float | None, embedder: Embedder) -> float:
    if args_threshold is not None:
        return args_threshold
    return REMOTE_THRESHOLD if embedder.remote else LOCAL_THRESHOLD


def case_images(case: dict) -> list[Path]:
    paths = []
    for key in ("front", "back"):
        rel = case.get(key)
        if rel:
            p = case["images_root"] / rel
            if p.is_file():
                paths.append(p)
    return paths


def aggregate(prepared: list[dict], rows: list[dict], store: BaseStore,
              threshold: float) -> tuple[dict, list[dict], dict]:
    """Run matching over prepared cases at one threshold and aggregate metrics."""
    details: list[dict] = []
    confusion: dict[str, dict[str, int]] = {}
    det_c = term_c = pattern_c = color_c = series_c = 0
    non_plain = predicted_terms = review = total = 0

    for item in prepared:
        total += 1
        case = item["case"]
        expected = case.get("expected", {})
        pred = run_match_prepared(item, rows, store, threshold)
        if "error" in pred:
            details.append({"id": case["id"], "error": pred["error"], "stage": "recognize"})
            continue
        exp_refr = expected.get("refraction")
        pred_refr = pred.get("refraction")

        det_ok = (exp_refr is None) == (pred_refr is None)
        det_c += int(det_ok)

        exp_key = exp_refr or "(plain)"
        pred_key = pred_refr or "(none)"
        confusion.setdefault(exp_key, {})
        confusion[exp_key][pred_key] = confusion[exp_key].get(pred_key, 0) + 1

        fields = {}
        if pred_refr is not None:
            predicted_terms += 1
        rec = item.get("rec") or {}
        if exp_refr is not None:
            non_plain += 1
            term_ok = pred_refr == exp_refr
            term_c += int(term_ok)
            fields["term"] = term_ok
            if expected.get("pattern") is not None:
                pattern_ok = pred.get("pattern") == expected["pattern"]
                pattern_c += int(pattern_ok)
                fields["pattern"] = pattern_ok
            if expected.get("color") is not None:
                color_ok = pred.get("color") == expected["color"]
                color_c += int(color_ok)
                fields["color"] = color_ok
            # series accuracy: does the RECOGNITION self-determine the right
            # brand x series? (that decides which naming table to look up)
            if expected.get("brand") is not None and expected.get("series") is not None:
                series_ok = (rec.get("brand"), rec.get("series")) == (
                    expected["brand"], expected["series"])
                series_c += int(series_ok)
                fields["series"] = series_ok
        if pred.get("needsReview"):
            review += 1
        fields["review"] = bool(pred.get("needsReview"))

        details.append({
            "id": case["id"],
            "expected": expected,
            "rec": item.get("rec"),
            "predicted": pred,
            "correct": fields,
        })

    def pct(n: int, d: int) -> float:
        return round(n / d, 4) if d else None

    metrics = {
        "total": total,
        "det_acc": pct(det_c, total),
        "term_acc": pct(term_c, non_plain),
        "pattern_acc": pct(pattern_c, non_plain),
        "color_acc": pct(color_c, non_plain),
        "series_acc": pct(series_c, non_plain),
        "review_rate": pct(review, total),
        "precision": pct(term_c, predicted_terms),
        "recall": pct(term_c, non_plain),
        "non_plain": non_plain,
        "predicted_terms": predicted_terms,
    }
    return metrics, details, confusion


def print_metrics(m: dict) -> None:
    def fmt(v) -> str:
        return "n/a" if v is None else f"{v:.2%}"

    print("=" * 46)
    print(f"  total cases      : {m['total']}")
    for k in ("det_acc", "term_acc", "pattern_acc", "color_acc", "series_acc"):
        print(f"  {k:<18}: {fmt(m.get(k))}")
    print(f"  review_rate      : {fmt(m.get('review_rate'))}")
    print(f"  precision        : {fmt(m.get('precision'))}")
    print(f"  recall           : {fmt(m.get('recall'))}")
    print("=" * 46)


def write_outputs(out_dir: Path, metrics: dict, details: list[dict], confusion: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (out_dir / "errors.jsonl").open("w", encoding="utf-8") as fh:
        for d in details:
            fh.write(json.dumps(d, ensure_ascii=False) + "\n")
    (out_dir / "confusion.json").write_text(
        json.dumps(confusion, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=["match", "live"], default="match")
    ap.add_argument("--golden", default=str(DEFAULT_GOLDEN))
    ap.add_argument("--images-root", default=None, help="override golden images_root")
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--sweep", action="store_true", help="scan thresholds (match mode)")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    load_env()
    embedder = Embedder()
    store = create_store(args.db)
    rows = store.rows()
    if not rows:
        raise SystemExit("empty store; run scripts/embed.py first")
    golden = Path(args.golden)
    images_root = Path(args.images_root) if args.images_root else golden.parent
    cases = load_cases(golden, images_root)
    if not cases:
        print(f"no cases in {golden}", file=sys.stderr)
        return 1

    # recognize + embed every query once; thresholds only re-rank
    prepared = prepare(cases, args.mode, embedder)

    if args.sweep:
        print(f"{'thr':>5} {'term_acc':>9} {'review_rate':>11} {'recall':>7}")
        for t in SWEEP_STEPS:
            m, _, _ = aggregate(prepared, rows, store, t)
            ta = m["term_acc"] if m["term_acc"] is not None else float("nan")
            rr = m["review_rate"] if m["review_rate"] is not None else float("nan")
            rc = m["recall"] if m["recall"] is not None else float("nan")
            print(f"{t:>5.2f} {ta:>9.2%} {rr:>11.2%} {rc:>7.2%}")
        return 0

    threshold = effective_threshold(args.threshold, embedder)
    metrics, details, confusion = aggregate(prepared, rows, store, threshold)
    print_metrics(metrics)
    write_outputs(Path(args.out), metrics, details, confusion)
    print(f"detail rows -> {Path(args.out) / 'errors.jsonl'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
