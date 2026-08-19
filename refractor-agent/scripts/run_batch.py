#!/usr/bin/env python3
"""Batch refractor normalization with a resume-able manifest state machine.

Input: an input directory of groups, each group is a subdirectory holding a
card front + back image (extra images are passed along too). For each pending
group the script: calls the VLM (OpenAI-compatible vision) on the group images
to produce a structured recognition, vector-matches it to a standard term, and
writes the result. Low-confidence / failed groups land in review.jsonl.

Manifest contract: pending -> in-flight -> done; done/skipped is never
reprocessed, so an interrupted run resumes safely.

VLM env (OpenAI-compatible): VLM_BASE_URL / VLM_API_KEY / VLM_MODEL
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

VLM_PROMPT = """你是球星卡折射识别助手。请根据下面的卡片正面+反面图片，输出一段严格的 JSON（不要夹带其他文字）：
{"pattern":"...","color":"...","brand":"...","year":"...","series":"...","desc":"..."}

规则：
1. pattern 图案类型与 color 颜色取自受控枚举：图案[银折/碎冰/金折/绿折/橙折/紫折/现在折射/爆金/棋盘/脉冲/平卡/其他]，颜色[银/金/红/蓝/绿/橙/紫/无/其他]。
2. 同图案不同颜色是不同折射，pattern 相同只改 color，绝不合并。
3. brand/year/series 以反面版权文字为准。
4. 没有折射写 pattern=平卡、color=无。
5. desc 用一句自由文本描述折射外观（作向量匹配用）。"""

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif"}


def data_uri(path: Path) -> str:
    mime = MIME.get(path.suffix.lower(), "application/octet-stream")
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


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


def vlm_recognize(images: list[Path]) -> dict:
    base = _req_env("VLM_BASE_URL")
    key = _req_env("VLM_API_KEY")
    model = _req_env("VLM_MODEL")
    from openai import OpenAI

    client = OpenAI(base_url=base, api_key=key)
    content: list[dict] = [{"type": "text", "text": VLM_PROMPT}]
    content += [{"type": "image_url", "image_url": {"url": data_uri(p)}} for p in images]
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        temperature=0,
    )
    text = resp.choices[0].message.content.strip()
    # tolerate fenced JSON
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("VLM did not return a JSON object")
    return parsed


def _req_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"missing env {name} (configure VLM OpenAI-compatible endpoint)", file=sys.stderr)
        sys.exit(2)
    return value


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="input dir of group subdirs")
    ap.add_argument("--work", required=True, help="work dir for manifest/result/review")
    ap.add_argument("--db", default=str(Path(__file__).parent.parent / "db" / "refractors.lance"))
    ap.add_argument("--threshold", type=float, default=None,
                    help="optional; defaults to mode-aware threshold in match.py")
    ap.add_argument("--dry-run", action="store_true", help="inspect manifest without processing")
    args = ap.parse_args()

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
    for item in manifest:
        if item["status"] in ("done", "skipped"):
            continue
        item["status"] = "in-flight"
        save_manifest(work_dir, manifest)
        group = Path(item["path"])
        images = [p for p in group.iterdir() if p.suffix.lower() in IMAGE_EXTS]
        try:
            rec = vlm_recognize(images)
            args_rec = json.dumps(rec, ensure_ascii=False)
            out = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("match.py")),
                 "--rec", args_rec, "--db", args.db]
                + (["--threshold", str(args.threshold)] if args.threshold is not None else []),
                check=True, capture_output=True, text=True,
            )
            result = json.loads(out.stdout)
            record = {"itemId": item["id"], **{k: rec.get(k) for k in
                      ("brand", "series", "year", "pattern", "color", "desc")}, **result}
            with res_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            ok += 1
            if record.get("needsReview") or result.get("needsReview"):
                review += 1
                with rev_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            item["status"] = "done"
            save_manifest(work_dir, manifest)
        except Exception as exc:  # noqa: BLE001 - report any failure and retryable
            fail += 1
            item["status"] = "in-flight"
            save_manifest(work_dir, manifest)
            with rev_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"itemId": item["id"], "error": str(exc)}, ensure_ascii=False) + "\n")
            print(f"failed {item['id']}: {exc}", file=sys.stderr)

    print(f"summary: ok={ok} review={review} fail={fail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())