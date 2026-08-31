"""Validation for the refractor VLM recognition protocol.

The VLM response is treated as untrusted external input. This module keeps the
wire-level rules independent from the provider adapter so batch jobs, tests,
and future typed tools all apply the same validation.
"""

from __future__ import annotations

import re
from typing import Any

SCHEMA_VERSION = "refractor-recognition.v1"
REQUIRED_FIELDS = frozenset({"pattern", "color", "brand", "series", "desc"})
MAX_PATTERN_CHARS = 40
MAX_COLOR_CHARS = 20
MAX_BRAND_CHARS = 80
MAX_SERIES_CHARS = 80
MAX_DESC_CHARS = 300


class RecognitionValidationError(ValueError):
    """Raised when a model response violates the recognition protocol."""

    code = "schema_validation_failed"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class RecognitionFormatError(RecognitionValidationError):
    """Raised for malformed or incomplete output that may be repaired once."""

    retryable = True


class RecognitionBusinessError(RecognitionValidationError):
    """Raised for a syntactically valid value that violates domain rules."""

    code = "business_validation_failed"


def _clean_text(value: Any, field: str, max_chars: int) -> str:
    if not isinstance(value, str):
        raise RecognitionValidationError(f"{field} must be a string")
    value = re.sub(r"\s+", " ", value.strip())
    if not value:
        raise RecognitionValidationError(f"{field} must not be empty")
    if len(value) > max_chars:
        raise RecognitionValidationError(
            f"{field} exceeds {max_chars} Unicode characters",
            code="field_too_large",
        )
    return value


def _identifier(value: Any, field: str, max_chars: int) -> str:
    value = _clean_text(value, field, max_chars)
    return value.lower()


def validate_recognition(
    raw: Any,
    patterns: set[str],
    colors: set[str],
    *,
    pairs: set[tuple[str, str]] | None = None,
    require_schema_version: bool = False,
) -> dict[str, str]:
    """Validate and normalize one flat VLM recognition object.

    ``patterns`` and ``colors`` are the controlled values derived from the
    dictionary. Unknown keys, nested objects, arrays, nulls, and invalid enum
    values are rejected before matching. The returned mapping contains only
    protocol fields plus ``schemaVersion``.
    """
    if not isinstance(raw, dict):
        raise RecognitionValidationError("VLM response must be a JSON object")

    if require_schema_version and raw.get("schemaVersion") != SCHEMA_VERSION:
        raise RecognitionValidationError(
            f"schemaVersion must be {SCHEMA_VERSION!r}"
        )

    keys = set(raw) - {"schemaVersion"}
    missing = REQUIRED_FIELDS - keys
    extra = keys - REQUIRED_FIELDS
    if missing:
        raise RecognitionValidationError(
            f"missing required fields: {', '.join(sorted(missing))}"
        )
    if extra:
        raise RecognitionValidationError(
            f"unknown fields: {', '.join(sorted(extra))}"
        )

    pattern = _clean_text(raw["pattern"], "pattern", MAX_PATTERN_CHARS)
    color = _clean_text(raw["color"], "color", MAX_COLOR_CHARS)
    brand = _identifier(raw["brand"], "brand", MAX_BRAND_CHARS)
    series = _identifier(raw["series"], "series", MAX_SERIES_CHARS)
    desc = _clean_text(raw["desc"], "desc", MAX_DESC_CHARS)

    allowed_patterns = set(patterns) | {"平卡", "其他"}
    allowed_colors = set(colors) | {"无", "其他"}
    if pattern not in allowed_patterns:
        raise RecognitionValidationError(
            f"invalid pattern {pattern!r}; expected one of the controlled values",
            code="enum_validation_failed",
        )
    if color not in allowed_colors:
        raise RecognitionValidationError(
            f"invalid color {color!r}; expected one of the controlled values",
            code="enum_validation_failed",
        )
    if pattern == "平卡" and color != "无":
        raise RecognitionValidationError(
            "plain card must use color=无",
            code="business_validation_failed",
        )
    if (
        pairs is not None
        and pattern not in {"平卡", "其他"}
        and color not in {"无", "其他"}
        and (pattern, color) not in pairs
    ):
        raise RecognitionValidationError(
            f"unregistered pattern/color pair: {pattern}/{color}",
            code="business_validation_failed",
        )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "pattern": pattern,
        "color": color,
        "brand": brand,
        "series": series,
        "desc": desc,
    }
