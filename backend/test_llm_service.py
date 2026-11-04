"""Provider error handling, without external API requests."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from google.genai import errors

import llm


class GeminiServiceTests(unittest.IsolatedAsyncioTestCase):
    async def generate(self, model_call):
        client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=model_call)))
        with patch.object(llm, "client", return_value=client):
            return await llm.generate_json("Synthetic test", [{"role": "user", "content": "Test"}],
                                           llm.SUMMARY_SCHEMA, effort="medium")

    async def test_provider_503_is_reported_as_temporary_unavailability(self):
        model = AsyncMock(side_effect=errors.ServerError(503, {"error": {"message": "Busy", "status": "UNAVAILABLE"}}))
        with self.assertRaises(HTTPException) as raised:
            await self.generate(model)
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Gemini is temporarily unavailable", raised.exception.detail)

    async def test_slow_provider_request_is_cancelled(self):
        cancelled = asyncio.Event()

        async def slow(**kwargs):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()

        with patch.object(llm, "REQUEST_TIMEOUT_SECONDS", 0.01):
            with self.assertRaises(HTTPException) as raised:
                await self.generate(AsyncMock(side_effect=slow))
        self.assertEqual(raised.exception.status_code, 504)
        self.assertTrue(cancelled.is_set())

    async def test_successful_json_response_is_preserved(self):
        response = SimpleNamespace(prompt_feedback=None, candidates=[], text='{"overview":"Synthetic test"}',
                                   model_version="test-model")
        answer, model = await self.generate(AsyncMock(return_value=response))
        self.assertEqual(answer, {"overview": "Synthetic test"})
        self.assertEqual(model, "test-model")


if __name__ == "__main__":
    unittest.main()
