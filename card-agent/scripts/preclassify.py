#!/usr/bin/env python3
"""GLM pre-classification + manifest builder for the card-lister agent.

Phase 1 of the batch pipeline (pure script, no agent loop):

1. Scan a customer folder for all images under singles/ and lots/.
2. For each image not yet recorded, append a manifest row with status=pending.
3. For each pending image whose role is still unknown, call the GLM vision
   model (OpenAI-compatible API) to classify:
       - role:  front | back | core_front | core_back | group | label | unrelated
       - sport: pokemon | basketball | football | baseball | football-american | null
   Unrelated images are marked status=skipped (the agent loop will skip them).
   Valid card images keep status=pending for the agent loop to process.

Manifest lives at <input>/.card-processing/manifest.jsonl, one JSON object per
image. The script is idempotent: re-running it never re-calls GLM for images
that already have a role, so interrupted runs resume cleanly.

Usage:
  python3 preclassify.py --input /customers/A \
      --api-key <GLM_KEY> \
      --base-url https://open.bigmodel.cn/api/paas/v4 \
      --model glm-4v-flash
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.request
from pathlib import Path

ROLES = ("front", "back", "core_front", "core_back", "group", "label", "unrelated")
SPORTS = ("pokemon", "basketball", "football", "baseball", "football-american")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def scan_images(customer_dir: Path) -> list[Path]:
    images: list[Path] = []
    for sub in ("singles", "lots"):
        root = customer_dir / sub
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*")):
            if p.is_file() and is_image(p):
                images.append(p)
    return images


def load_manifest(manifest_path: Path) -> dict[str, dict]:
    records: dict[str, dict] = {}
    if manifest_path.exists():
        with manifest_path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                records[rec["path"]] = rec
    return records


def write_manifest(manifest_path: Path, records: dict[str, dict]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as f:
        for rec in records.values():
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def image_data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    with path.open("rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def classify_with_glm(path: Path, base_url: str, api_key: str, model: str) -> dict:
    """Call the GLM vision model and return {'role': ..., 'sport': ...}."""
    prompt = (
        "这是一张卡片相关图片。请判断它的角色和运动类型。\n"
        "角色(role)只能取一个值：\n"
        "  - front: 单张卡片的正面\n"
        "  - back: 单张卡片的背面\n"
        "  - core_front: lot 中核心卖点卡片的正面\n"
        "  - core_back: lot 中核心卖点卡片的背面\n"
        "  - group: lot 的整组卡片正面合照\n"
        "  - label: lot 的标号/透明包装袋图片（通常含编号信息）\n"
        "  - unrelated: 标签、文字描述、包装特写或其他与卡片识别无关的图片\n"
        "运动类型(sport)只能取一个值：pokemon, basketball, football, baseball, "
        "football-american；若是 unrelated 则为 null。\n"
        "只输出 JSON，不要其他内容，格式：{\"role\": \"...\", \"sport\": \"...\"}"
    )
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url(path)}},
                ],
            }
        ],
        "temperature": 0,
    }
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    text = body["choices"][0]["message"]["content"]
    start, end = text.find("{"), text.rfind("}")
    parsed = json.loads(text[start : end + 1])
    role = parsed.get("role")
    sport = parsed.get("sport")
    if role not in ROLES:
        role = "unrelated"
    if sport not in SPORTS:
        sport = None
    return {"role": role, "sport": sport}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="customer folder containing singles/ and lots/")
    parser.add_argument("--api-key", default=os.environ.get("GLM_API_KEY", ""), help="GLM API key (or GLM_API_KEY env)")
    parser.add_argument("--base-url", default="https://open.bigmodel.cn/api/paas/v4")
    parser.add_argument("--model", default="glm-4v-flash")
    parser.add_argument("--manifest", default=None, help="manifest path (default: <input>/.card-processing/manifest.jsonl)")
    args = parser.parse_args()

    if not args.api_key:
        print("error: --api-key required (or set GLM_API_KEY)", file=sys.stderr)
        return 2

    customer_dir = Path(args.input).resolve()
    if not customer_dir.is_dir():
        print(f"error: not a directory: {customer_dir}", file=sys.stderr)
        return 2

    manifest_path = Path(args.manifest) if args.manifest else customer_dir / ".card-processing" / "manifest.jsonl"
    records = load_manifest(manifest_path)

    images = scan_images(customer_dir)
    new_count = 0
    for img in images:
        rel = str(img.relative_to(customer_dir))
        if rel not in records:
            records[rel] = {"path": rel, "role": None, "sport": None, "status": "pending"}
            new_count += 1
    print(f"scanned {len(images)} images, {new_count} new to manifest")

    classify_count = 0
    for rec in records.values():
        if rec["status"] == "skipped" or rec["role"] is not None:
            continue
        img = customer_dir / rec["path"]
        if not img.is_file():
            rec["status"] = "skipped"
            rec["role"] = "unrelated"
            continue
        try:
            result = classify_with_glm(img, args.base_url, args.api_key, args.model)
            rec["role"] = result["role"]
            rec["sport"] = result["sport"]
            if result["role"] == "unrelated":
                rec["status"] = "skipped"
            classify_count += 1
        except Exception as exc:  # keep going on per-image failures
            print(f"warn: classify failed for {rec['path']}: {exc}", file=sys.stderr)

    write_manifest(manifest_path, records)
    done = sum(1 for r in records.values() if r["status"] == "skipped")
    pending = sum(1 for r in records.values() if r["status"] == "pending")
    print(f"classified {classify_count} images this run")
    print(f"manifest totals: {done} skipped / {pending} pending (for agent loop)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
