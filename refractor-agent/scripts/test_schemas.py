from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from schemas import validate_recognition  # noqa: E402
from vlm import (  # noqa: E402
    VLMResponseTooLargeError,
    VLMResponseValidationError,
    _parse_and_validate,
)


PATTERNS = {"碎冰", "银折", "金折", "平卡", "其他"}
COLORS = {"银", "红", "蓝", "金", "无", "其他"}


def rec(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "pattern": "碎冰",
        "color": "红",
        "brand": " PANINI ",
        "series": " PRIZM ",
        "desc": "红色水晶裂纹折射",
    }
    value.update(overrides)
    return value


class RecognitionValidationTests(unittest.TestCase):
    def test_normalizes_identifiers_and_rejects_extra_fields(self) -> None:
        result = validate_recognition(rec(), PATTERNS, COLORS)
        self.assertEqual(result["brand"], "panini")
        self.assertEqual(result["series"], "prizm")
        with self.assertRaises(ValueError):
            validate_recognition({**rec(), "extra": "no"}, PATTERNS, COLORS)

    def test_rejects_invalid_enum_and_plain_card_mismatch(self) -> None:
        with self.assertRaises(ValueError):
            validate_recognition(rec(pattern="invented"), PATTERNS, COLORS)
        with self.assertRaises(ValueError):
            validate_recognition(rec(pattern="平卡", color="红"), PATTERNS, COLORS)

    def test_rejects_oversized_field_and_accepts_plain_card(self) -> None:
        with self.assertRaises(ValueError):
            validate_recognition(rec(desc="x" * 301), PATTERNS, COLORS)
        with self.assertRaises(ValueError):
            validate_recognition(
                rec(pattern="银折", color="金"), PATTERNS, COLORS,
                pairs={("银折", "银"), ("碎冰", "红")},
            )
        result = validate_recognition(rec(pattern="平卡", color="无"), PATTERNS, COLORS)
        self.assertEqual(result["pattern"], "平卡")


class VLMParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous = os.environ.get("VLM_MAX_TEXT_BYTES")
        os.environ["VLM_MAX_TEXT_BYTES"] = "4096"

    def tearDown(self) -> None:
        if self.previous is None:
            os.environ.pop("VLM_MAX_TEXT_BYTES", None)
        else:
            os.environ["VLM_MAX_TEXT_BYTES"] = self.previous

    def test_valid_json_is_normalized(self) -> None:
        result = _parse_and_validate(json.dumps(rec(), ensure_ascii=False))
        self.assertEqual(result["brand"], "panini")

    def test_invalid_json_is_retryable_validation_error(self) -> None:
        with self.assertRaises(VLMResponseValidationError):
            _parse_and_validate("not json")

    def test_text_limit_rejects_without_truncation(self) -> None:
        os.environ["VLM_MAX_TEXT_BYTES"] = "100"
        with self.assertRaises(VLMResponseTooLargeError):
            _parse_and_validate("x" * 101)


if __name__ == "__main__":
    unittest.main()
