from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from run_batch import classify_failure, failure_record  # noqa: E402
from vlm import VLMBusinessValidationError, VLMNetworkError  # noqa: E402


class ClassifyFailureTests(unittest.TestCase):
    def test_business_validation_routes_to_review(self) -> None:
        status, retryable = classify_failure(VLMBusinessValidationError("bad enum"), 1, 3)
        self.assertEqual(status, "review_required")
        self.assertFalse(retryable)

    def test_retryable_error_retries_below_limit(self) -> None:
        status, retryable = classify_failure(VLMNetworkError("timeout"), 1, 3)
        self.assertEqual((status, retryable), ("retryable_failed", True))

    def test_retryable_error_terminates_at_limit(self) -> None:
        status, retryable = classify_failure(VLMNetworkError("timeout"), 3, 3)
        self.assertEqual((status, retryable), ("terminal_failed", False))

    def test_unknown_errors_are_terminal(self) -> None:
        status, retryable = classify_failure(RuntimeError("boom"), 1, 3)
        self.assertEqual((status, retryable), ("terminal_failed", False))


class FailureRecordTests(unittest.TestCase):
    def test_record_is_structured_and_bounded(self) -> None:
        item = {"id": "A-001", "attempt": 2}
        record = failure_record(
            item, VLMNetworkError("timeout " * 200), "retryable_failed", True
        )
        self.assertEqual(record["itemId"], "A-001")
        self.assertEqual(record["attempt"], 2)
        self.assertEqual(record["errorCode"], "provider_network_error")
        self.assertEqual(record["status"], "retryable_failed")
        self.assertTrue(record["retryable"])
        self.assertLessEqual(len(record["lastError"]), 500)


if __name__ == "__main__":
    unittest.main()
