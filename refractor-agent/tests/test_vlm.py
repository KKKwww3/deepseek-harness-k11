from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import vlm


VALID_BODY = {
    "output": [
        {
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": '{"pattern":"碎冰","color":"红","brand":"Panini","series":"Prizm","desc":"红色水晶裂纹折射"}',
                }
            ],
        }
    ]
}


class VlmValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = patch.dict(
            os.environ,
            {
                "VLM_BASE_URL": "https://vlm.example.test",
                "VLM_API_KEY": "test-key",
                "VLM_SCHEMA_RETRIES": "1",
                "VLM_NETWORK_RETRIES": "2",
                "VLM_RETRY_BACKOFF_SECONDS": "0",
            },
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_validates_and_normalizes_fields(self) -> None:
        result = vlm._parse_and_validate(
            '{"pattern":"碎冰","color":"红","brand":" PANINI ","series":"PRIZM","desc":" 红色 水晶裂纹折射 "}'
        )
        self.assertEqual(result["brand"], "panini")
        self.assertEqual(result["series"], "prizm")

    def test_rejects_extra_fields_and_invalid_enum(self) -> None:
        with self.assertRaises(vlm.VLMBusinessValidationError):
            vlm._parse_and_validate(
                '{"pattern":"不存在","color":"红","brand":"panini","series":"prizm","desc":"x"}'
            )
        with self.assertRaises(vlm.VLMResponseValidationError):
            vlm._parse_and_validate(
                '{"pattern":"碎冰","color":"红","brand":"panini","series":"prizm","desc":"x","extra":"no"}'
            )

    @patch.object(vlm, "to_image_url", return_value="data:image/jpeg;base64,AA==")
    @patch.object(vlm, "load_env")
    @patch("vlm.time.sleep")
    @patch.object(vlm, "_request_body", side_effect=[
        {"output": [{"type": "message", "content": [{"type": "output_text", "text": "not-json"}]}]},
        VALID_BODY,
    ])
    def test_schema_error_retries_identical_request(self, request, sleep, load_env, image):
        result = vlm.recognize(["front.jpg"])
        self.assertEqual(result["pattern"], "碎冰")
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].args[0].data, request.call_args_list[1].args[0].data)
        sleep.assert_not_called()

    @patch.object(vlm, "to_image_url", return_value="data:image/jpeg;base64,AA==")
    @patch.object(vlm, "load_env")
    @patch.object(vlm, "_request_body", side_effect=[
        {"output": [{"type": "message", "content": [{"type": "output_text", "text": "not-json"}]}]},
        VALID_BODY,
    ])
    def test_repair_mode_appends_note_and_keeps_base_instruction(self, request, load_env, image):
        with patch.dict(os.environ, {"VLM_RETRY_MODE": "repair"}):
            result = vlm.recognize(["front.jpg"])
        self.assertEqual(result["pattern"], "碎冰")
        first = json.loads(request.call_args_list[0].args[0].data)["input"][0]["content"][0]["text"]
        second = json.loads(request.call_args_list[1].args[0].data)["input"][0]["content"][0]["text"]
        self.assertTrue(first.startswith("你是球星卡折射识别助手"))
        self.assertTrue(second.startswith("你是球星卡折射识别助手"))
        self.assertIn("补充要求", second)
        self.assertGreater(len(second), len(first))

    @patch.object(vlm, "to_image_url", return_value="data:image/jpeg;base64,AA==")
    @patch.object(vlm, "load_env")
    def test_invalid_retry_mode_fails_loud(self, load_env, image):
        with patch.dict(os.environ, {"VLM_RETRY_MODE": "bogus"}):
            with self.assertRaises(ValueError):
                vlm.recognize(["front.jpg"])

    @patch.object(vlm, "to_image_url", return_value="data:image/jpeg;base64,AA==")
    @patch.object(vlm, "load_env")
    @patch("vlm.time.sleep")
    @patch.object(vlm, "_request_body", side_effect=[
        vlm.VLMNetworkError("timeout"),
        vlm.VLMTransientHTTPError("server error"),
        VALID_BODY,
    ])
    def test_network_errors_use_bounded_backoff(self, request, sleep, load_env, image):
        with patch.dict(os.environ, {"VLM_RETRY_BACKOFF_SECONDS": "1"}):
            result = vlm.recognize(["front.jpg"])
        self.assertEqual(result["color"], "红")
        self.assertEqual(request.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1.0, 2.0])

    @patch.object(vlm, "to_image_url", return_value="data:image/jpeg;base64,AA==")
    @patch.object(vlm, "load_env")
    @patch.object(vlm, "_request_body", side_effect=vlm.VLMBusinessValidationError("invalid enum"))
    def test_business_error_is_not_retried(self, request, load_env, image):
        with self.assertRaises(vlm.VLMBusinessValidationError):
            vlm.recognize(["front.jpg"])
        self.assertEqual(request.call_count, 1)

    @patch.object(vlm, "to_image_url", return_value="data:image/jpeg;base64,AA==")
    @patch.object(vlm, "load_env")
    @patch.object(vlm, "_request_body", side_effect=vlm.VLMPermanentHTTPError("401"))
    def test_permanent_provider_error_is_not_retried(self, request, load_env, image):
        with self.assertRaises(vlm.VLMPermanentHTTPError):
            vlm.recognize(["front.jpg"])
        self.assertEqual(request.call_count, 1)

    def test_model_text_limit_rejects_without_truncation(self) -> None:
        with patch.dict(os.environ, {"VLM_MAX_TEXT_BYTES": "10"}):
            with self.assertRaises(vlm.VLMResponseTooLargeError):
                vlm._parse_and_validate('{"pattern":"碎冰"}')


if __name__ == "__main__":
    unittest.main()
