#!/usr/bin/env python3
"""VLM refraction recognition via the Volcano Ark Responses API.

Sends the card front+back images (as base64 data URIs) plus a strict-JSON prompt
to ``VLM_BASE_URL``/``VLM_API_KEY``/``VLM_MODEL`` (default model
``doubao-seed-2-0-lite-260428``) and returns the structured recognition dict
``{pattern, color, brand, year, series, desc}``.

The controlled pattern/color enum is generated from ``dicts/enum.yml`` at runtime
so the prompt and the dictionary validation can never drift apart.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any

import yaml

from refract_store import load_env

DEFAULT_MODEL = "doubao-seed-2-0-lite-260428"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif"}

ROOT = Path(__file__).resolve().parent.parent


def controlled_enum() -> tuple[list[str], list[str]]:
    """Load pattern/color choices from dicts/enum.yml (single source of truth)."""
    path = ROOT / "dicts" / "enum.yml"
    with path.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    return list(doc["pattern"]), list(doc["color"])


def build_prompt() -> str:
    patterns, colors = controlled_enum()
    return (
        "你是球星卡折射识别助手。请根据下面的卡片正面+反面图片，输出一段严格的 JSON"
        "（不要夹带任何其他文字，不要用 Markdown 围栏）：\n"
        '{"pattern":"...","color":"...","brand":"...","year":"...","series":"...","desc":"..."}\n'
        "规则：\n"
        f"1. pattern 图案类型与 color 颜色取自受控枚举：图案[{ '/'.join(patterns) }]，"
        f"颜色[{ '/'.join(colors) }]。\n"
        "2. 同图案不同颜色是不同折射，pattern 相同只改 color，绝不合并。\n"
        "3. brand/year/series 以反面版权文字为准，读不到写 unknown。\n"
        "4. 没有折射写 pattern=平卡、color=无。\n"
        "5. desc 用一句自由文本描述折射外观（作向量匹配用）。"
    )


def data_uri(path: Path) -> str:
    mime = MIME.get(path.suffix.lower(), "application/octet-stream")
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _req_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing env {name} (configure VLM OpenAI-compatible endpoint)")
    return value


def recognize(images: list[Path]) -> dict[str, Any]:
    """Recognize card images into a structured refraction dict."""
    load_env()
    base = _req_env("VLM_BASE_URL").rstrip("/")
    key = _req_env("VLM_API_KEY")
    model = os.environ.get("VLM_MODEL") or DEFAULT_MODEL

    content: list[dict] = [{"type": "input_text", "text": build_prompt()}]
    content += [{"type": "input_image", "image_url": data_uri(p)} for p in images]
    payload = json.dumps(
        {"model": model, "input": [{"role": "user", "content": content}], "temperature": 0}
    ).encode("utf-8")
    req = urllib.request.Request(
        base + "/responses",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"VLM API error {exc.code}: {detail}") from exc

    text = _extract_text(body)
    # tolerate fenced JSON even though the prompt forbids it
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("VLM did not return a JSON object")
    return parsed


def _extract_text(body: dict) -> str:
    """Join output_text parts from the Responses API message output."""
    parts: list[str] = []
    for item in body.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                parts.append(content.get("text", ""))
    text = "".join(parts).strip()
    if not text:
        raise RuntimeError(f"VLM returned no message text: {json.dumps(body)[:300]}")
    return text


if __name__ == "__main__":
    imgs = [Path(p) for p in sys.argv[1:]]
    if not imgs:
        print("usage: python vlm.py <front> [back ...]")
        sys.exit(2)
    print(json.dumps(recognize(imgs), ensure_ascii=False))
