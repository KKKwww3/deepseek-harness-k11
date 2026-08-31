#!/usr/bin/env python3
"""VLM refraction recognition via the Volcano Ark Responses API.

Sends the card front+back images plus a strict-JSON prompt to
``VLM_BASE_URL``/``VLM_API_KEY``/``VLM_MODEL`` (default model
``doubao-seed-2-0-lite-260428``) and returns the structured recognition dict
``{pattern, color, brand, series, desc}``.

Images may be local file paths, http(s) URLs, data: URIs, or raw base64 (any
mix) — each is normalized by ``to_image_url``.

The controlled pattern/color enum is auto-derived from ``dicts/refractions.yml``
at runtime (every registered pattern/color becomes a prompt choice), so the prompt
and the dictionary can never drift apart.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import yaml

from refract_store import load_env
from schemas import (
    RecognitionValidationError,
    validate_recognition,
)

DEFAULT_MODEL = "doubao-seed-2-0-lite-260428"
DEFAULT_TIMEOUT_SECONDS = 180
DEFAULT_MAX_OUTPUT_TOKENS = 500
DEFAULT_MAX_PROVIDER_BYTES = 256 * 1024
DEFAULT_MAX_TEXT_BYTES = 16 * 1024
DEFAULT_SCHEMA_RETRIES = 1
DEFAULT_NETWORK_RETRIES = 2
DEFAULT_RETRY_BACKOFF_SECONDS = 1.0
DEFAULT_RETRY_MODE = "same"
RETRY_MODES = ("repair", "same")
RETRY_NOTE_DETAIL_CHARS = 200
MAX_RETRY_COUNT = 10
MAX_RETRY_BACKOFF_SECONDS = 60.0
MAX_PATTERN_CHARS = 40
MAX_COLOR_CHARS = 20
MAX_IDENTIFIER_CHARS = 80
MAX_DESC_CHARS = 300
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif"}

ROOT = Path(__file__).resolve().parent.parent


def controlled_enum() -> tuple[list[str], list[str]]:
    """Derive pattern/color choices from dicts/refractions.yml (auto-enum).

    The legal pattern set = every pattern registered in the dict (+ 平卡/其他);
    legal colors = every color used (+ 无/其他). Adding a refraction to the dict
    automatically extends the VLM prompt — no separate enum file to maintain.
    """
    path = ROOT / "dicts" / "refractions.yml"
    with path.open(encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    patterns, colors = [], []
    for e in doc.get("refractions", []):
        if e.get("pattern") not in patterns:
            patterns.append(e["pattern"])
        if e.get("color") not in colors:
            colors.append(e["color"])
    for sysval in ("平卡", "其他"):
        if sysval not in patterns:
            patterns.append(sysval)
    for sysval in ("无", "其他"):
        if sysval not in colors:
            colors.append(sysval)
    return patterns, colors


def build_prompt() -> str:
    patterns, colors = controlled_enum()
    return (
        "你是球星卡折射识别助手。请根据下面的卡片正面+反面图片，输出一段严格的 JSON"
        "（不要夹带任何其他文字，不要用 Markdown 围栏）：\n"
        '{"pattern":"...","color":"...","brand":"...","series":"...","desc":"..."}\n'
        "规则：\n"
        f"1. pattern 图案类型与 color 颜色取自受控枚举：图案[{ '/'.join(patterns) }]，"
        f"颜色[{ '/'.join(colors) }]。\n"
        "2. 同图案不同颜色是不同折射，pattern 相同只改 color，绝不合并。\n"
        "3. brand/series 以反面版权文字为准，读不到写 unknown。\n"
        "4. 没有折射写 pattern=平卡、color=无。\n"
        "5. desc 只描述折射外观本身（图案、颜色、光泽、质地），一句话 10~30 字，"
        "用于向量匹配；严禁描述卡面人物、球员、球队、文字、logo、背景图案。\n"
        "6. brand 用小写（如 panini、topps）；series 用简短小写（如 prizm、chrome）。"
    )


def _sniff_mime(data: bytes) -> str | None:
    """Detect image MIME from content magic bytes (trust content, not extension)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def data_uri(path: Path) -> str:
    data = path.read_bytes()
    mime = _sniff_mime(data) or MIME.get(path.suffix.lower(), "application/octet-stream")
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def to_image_url(source: str | Path) -> str:
    """Normalize any image input to an ``image_url`` the VLM API accepts.

    Accepts (auto-detected):
      - local file path        -> base64 data URI (MIME sniffed from content)
      - http(s):// URL         -> passed through as-is (VLM server fetches it)
      - data: URI              -> passed through as-is
      - raw base64             -> wrapped as ``data:<sniffed-mime>;base64,...``
    A missing local path raises instead of being misread as base64.
    """
    s = str(source).strip()
    if s.startswith(("http://", "https://")):
        return s
    if s.startswith("data:"):
        return s
    p = Path(s)
    if p.is_file():
        return data_uri(p)
    # last resort: raw base64 — but fail loudly if it is not valid base64
    try:
        data = base64.b64decode(s, validate=True)
    except Exception as exc:  # noqa: BLE001 - any decode failure means bad input
        raise ValueError(
            f"image input is neither an existing file, http(s) URL, data: URI, "
            f"nor valid base64: {s[:60]!r}"
        ) from exc
    mime = _sniff_mime(data) or "application/octet-stream"
    return f"data:{mime};base64,{s}"


def _req_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing env {name} (configure VLM OpenAI-compatible endpoint)")
    return value


def _int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be non-negative")
    return parsed


def _bounded_int_env(name: str, default: int, maximum: int) -> int:
    value = _int_env(name, default)
    if value > maximum:
        raise ValueError(f"{name} must be <= {maximum}")
    return value


def _float_env(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be non-negative")
    return parsed


class VLMResponseError(RuntimeError):
    """Base class for controlled VLM response failures."""

    code = "vlm_response_error"
    retryable = False

    def __init__(self, message: str):
        super().__init__(f"{self.code}: {message}")


class VLMResponseTooLargeError(VLMResponseError):
    code = "model_text_too_large"
    retryable = True


class VLMTransportTooLargeError(VLMResponseError):
    code = "provider_response_too_large"


class VLMResponseValidationError(VLMResponseError):
    code = "schema_validation_failed"
    retryable = True


class VLMBusinessValidationError(VLMResponseError):
    code = "business_validation_failed"


class VLMNetworkError(VLMResponseError):
    code = "provider_network_error"
    retryable = True


class VLMTransientHTTPError(VLMResponseError):
    code = "provider_transient_error"
    retryable = True


class VLMPermanentHTTPError(VLMResponseError):
    code = "provider_permanent_error"


def _read_limited(response, max_bytes: int) -> bytes:
    """Read at most max_bytes+1 and reject oversized provider responses."""
    data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise VLMTransportTooLargeError(
            f"provider response exceeds {max_bytes} bytes"
        )
    return data


def _parse_and_validate(text: str) -> dict[str, str]:
    max_text_bytes = _int_env("VLM_MAX_TEXT_BYTES", DEFAULT_MAX_TEXT_BYTES)
    if len(text.encode("utf-8")) > max_text_bytes:
        raise VLMResponseTooLargeError(
            f"model text exceeds {max_text_bytes} bytes"
        )

    normalized = text.strip()
    if normalized.startswith("```"):
        lines = normalized.splitlines()
        if len(lines) < 3 or not lines[-1].strip().startswith("```"):
            raise VLMResponseValidationError("unterminated markdown fence")
        normalized = "\n".join(lines[1:-1]).strip()

    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError as exc:
        raise VLMResponseValidationError("VLM output is not valid JSON") from exc

    try:
        with (ROOT / "dicts" / "refractions.yml").open(encoding="utf-8") as fh:
            dictionary = yaml.safe_load(fh) or {}
        pairs = {
            (entry.get("pattern"), entry.get("color"))
            for entry in dictionary.get("refractions", [])
            if isinstance(entry, dict)
        }
        return validate_recognition(
            parsed,
            set(controlled_enum()[0]),
            set(controlled_enum()[1]),
            pairs=pairs,
        )
    except RecognitionValidationError as exc:
        if exc.code == "business_validation_failed" or exc.code == "enum_validation_failed":
            raise VLMBusinessValidationError(str(exc)) from exc
        raise VLMResponseValidationError(str(exc)) from exc


def _is_transient_http(code: int) -> bool:
    return code == 408 or code == 409 or code == 425 or code == 429 or 500 <= code <= 599


def _retry_delay(attempt: int) -> float:
    base = min(
        _float_env("VLM_RETRY_BACKOFF_SECONDS", DEFAULT_RETRY_BACKOFF_SECONDS),
        MAX_RETRY_BACKOFF_SECONDS,
    )
    return min(base * (2 ** attempt), MAX_RETRY_BACKOFF_SECONDS)


def _retry_note(exc: Exception) -> str:
    """Protocol-error note appended to the original instruction on a repair retry.

    Only the validation-error summary is echoed back; the rejected raw output is
    never re-sent to the model.
    """
    detail = " ".join(str(exc).split())[:RETRY_NOTE_DETAIL_CHARS]
    return (
        "补充要求：上一次响应不符合协议（" + detail + "）。"
        "请在完整遵守上述全部规则的前提下，只返回一个严格 JSON 对象："
        "包含且只能包含 pattern、color、brand、series、desc 五个字符串字段，"
        "不要 Markdown、解释或额外字段。"
    )


def _request_body(req: urllib.request.Request, timeout: int, max_bytes: int) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = _read_limited(resp, max_bytes)
    except urllib.error.HTTPError as exc:
        if _is_transient_http(exc.code):
            raise VLMTransientHTTPError(f"VLM API transient HTTP error {exc.code}") from exc
        raise VLMPermanentHTTPError(f"VLM API HTTP error {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError) as exc:
        raise VLMNetworkError("VLM API network or timeout error") from exc
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VLMResponseValidationError("provider response is not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise VLMResponseValidationError("provider response must be a JSON object")
    return parsed



def recognize(images: list[str | Path]) -> dict[str, Any]:
    """Recognize images with bounded protocol and network retries.

    Schema failures get one bounded retry: ``VLM_RETRY_MODE=same`` (default)
    resends the identical request; ``repair`` resends the original instruction
    with the validation-error note appended. Network failures and transient HTTP
    failures use bounded exponential backoff. Permanent failures and oversized
    responses are not retried blindly.
    """
    load_env()
    base = _req_env("VLM_BASE_URL").rstrip("/")
    key = _req_env("VLM_API_KEY")
    model = os.environ.get("VLM_MODEL") or DEFAULT_MODEL
    timeout = _int_env("VLM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
    max_provider_bytes = _int_env(
        "VLM_MAX_PROVIDER_BYTES", DEFAULT_MAX_PROVIDER_BYTES
    )
    schema_retries = _bounded_int_env(
        "VLM_SCHEMA_RETRIES", DEFAULT_SCHEMA_RETRIES, MAX_RETRY_COUNT
    )
    network_retries = _bounded_int_env(
        "VLM_NETWORK_RETRIES", DEFAULT_NETWORK_RETRIES, MAX_RETRY_COUNT
    )
    max_output_tokens = _int_env(
        "VLM_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS
    )

    image_content = [
        {"type": "input_image", "image_url": to_image_url(p)} for p in images
    ]
    base_instruction = build_prompt()
    retry_mode = os.environ.get("VLM_RETRY_MODE", DEFAULT_RETRY_MODE).strip().lower()
    if retry_mode not in RETRY_MODES:
        raise ValueError("VLM_RETRY_MODE must be 'repair' or 'same'")
    instruction = base_instruction
    protocol_attempt = 0
    network_attempt = 0
    while True:
        content: list[dict] = [{"type": "input_text", "text": instruction}]
        content += image_content
        payload = json.dumps(
            {
                "model": model,
                "input": [{"role": "user", "content": content}],
                "temperature": 0,
                "max_output_tokens": max_output_tokens,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            base + "/responses",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
        )
        try:
            body = _request_body(req, timeout, max_provider_bytes)
            text = _extract_text(body)
            return _parse_and_validate(text)
        except (VLMResponseValidationError, VLMResponseTooLargeError) as exc:
            if protocol_attempt >= schema_retries:
                raise
            protocol_attempt += 1
            if retry_mode == "repair":
                instruction = base_instruction + "\n" + _retry_note(exc)
        except (VLMNetworkError, VLMTransientHTTPError):
            if network_attempt >= network_retries:
                raise
            time.sleep(_retry_delay(network_attempt))
            network_attempt += 1


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
        raise VLMResponseValidationError("VLM returned no message text")
    return text


if __name__ == "__main__":
    imgs = sys.argv[1:]
    if not imgs:
        print("usage: python vlm.py <front> [back ...]")
        print("  each item: local path | http(s):// URL | data: URI | base64")
        sys.exit(2)
    print(json.dumps(recognize(imgs), ensure_ascii=False))
