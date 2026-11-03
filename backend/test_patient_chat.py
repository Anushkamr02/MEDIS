"""Chat regressions using synthetic records; no database writes or Gemini calls."""
import json
import unittest
from copy import deepcopy
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import llm
import server


class FakeSupa:
    def __init__(self, rows=None):
        self.rows = rows or {}
        self.queries = []
        self.writes = []

    async def select(self, table, params):
        self.queries.append((table, params))
        return deepcopy(self.rows.get(table, []))

    async def insert(self, table, row):
        self.writes.append((table, row))
        return {"id": str(len(self.writes)), **row}


def generated(sources=None):
    return {"reply": "Your recorded LDL was 123 on 1 October 2026.",
            "sources": sources or [], "suggest_contact_doctor": False}


class EvidenceTests(unittest.TestCase):
    def test_context_preserves_data_and_has_request_local_sources(self):
        record = {"patient": {"name": "Synthetic patient"},
                  "shared_visits": [{"visit_id": "TEST-V1", "ldl_cholesterol": 123}]}
        original = deepcopy(record)
        context, catalog, schema = llm.chat_context(record)
        self.assertEqual(record, original)
        self.assertEqual(context["shared_visits"][0]["ldl_cholesterol"], 123)
        self.assertEqual(catalog[context["shared_visits"][0]["source_id"]], "Visit TEST-V1")
        self.assertEqual(schema["properties"]["sources"]["items"]["enum"], list(catalog))
        self.assertNotIn("enum", llm.CHAT_SCHEMA["properties"]["sources"]["items"])

    def test_empty_records_have_no_citable_sources(self):
        _, catalog, schema = llm.chat_context({"patient": {}, "shared_visits": []})
        self.assertEqual(catalog, {})
        self.assertEqual(schema["properties"]["sources"]["maxItems"], 0)
        self.assertEqual(llm.validate_chat_answer(generated(), catalog)["sources"], [])

    def test_citations_resolve_and_deduplicate(self):
        answer = llm.validate_chat_answer(generated(["S1", "S1"]), {"S1": "Visit TEST-V1"})
        self.assertEqual(answer["sources"], ["Visit TEST-V1"])

    def test_unknown_citations_and_malformed_responses_are_rejected(self):
        for answer in (generated(["invented"]), {"reply": "answer"},
                       {**generated(), "reply": "   "},
                       {**generated(), "suggest_contact_doctor": "false"}):
            with self.subTest(answer=answer), self.assertRaises(HTTPException) as raised:
                llm.validate_chat_answer(answer, {"S1": "Visit TEST-V1"})
            self.assertEqual(raised.exception.status_code, 502)


class ChatFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_and_question_retrieve_records_before_generation(self):
        for question in ("Summarize my health records", "What was my latest LDL?"):
            with self.subTest(question=question):
                db = FakeSupa({
                    "profiles": [{"full_name": "Synthetic patient"}],
                    "consultations": [{"visit_id": "TEST-V1", "consultation_date": "2026-10-01",
                                       "ldl_cholesterol": 123}],
                    "medical_reports": [{"file_name": "test.pdf", "review_status": "pending_review"}],
                })

                async def model(system, messages, schema, **kwargs):
                    record = json.loads(system.split("Patient record (JSON):\n")[1])
                    visit = record["shared_visits"][0]
                    self.assertEqual(visit["ldl_cholesterol"], 123)
                    self.assertEqual(messages[-1], {"role": "user", "content": question})
                    self.assertIn("metadata only", record["retrieval_scope"]["uploaded_documents"])
                    self.assertEqual(record["uploaded_documents"][0]["file_name"], "test.pdf")
                    self.assertEqual(db.writes, [])
                    return generated([visit["source_id"]]), "mock"

                with patch.object(llm, "generate_json", side_effect=model):
                    result = await server.ai_chat(server.ChatRequest(message=question),
                                                  (db, {"id": "TEST-P1", "role": "patient"}))
                self.assertEqual(result["reply"]["sources"], ["Visit TEST-V1"])
                self.assertEqual(len(db.writes), 2)
                for table, params in db.queries:
                    self.assertEqual(params.get("patient_id", params.get("id")), "eq.TEST-P1")
                    if table == "consultations":
                        self.assertEqual(params["is_shared_with_patient"], "eq.true")
                    if table == "medical_reports":
                        self.assertEqual(params["order"], "uploaded_at.desc")
                    if table == "cad_assessments":
                        self.assertEqual(params["shared_with_patient"], "eq.true")

    async def test_empty_record_can_be_explained_without_inventing_evidence(self):
        db = FakeSupa()
        answer = {**generated(), "reply": "That information is not available in the records I can see."}
        with patch.object(llm, "generate_json", AsyncMock(return_value=(answer, "mock"))):
            result = await server.ai_chat(server.ChatRequest(message="Summarize my records"),
                                          (db, {"id": "TEST-P1", "role": "patient"}))
        self.assertEqual(result["reply"]["sources"], [])

    async def test_invalid_citation_is_not_saved_or_displayed(self):
        db = FakeSupa()
        with patch.object(llm, "generate_json", AsyncMock(return_value=(generated(["S999"]), "mock"))):
            with self.assertRaises(HTTPException) as raised:
                await server.ai_chat(server.ChatRequest(message="Summarize my records"),
                                     (db, {"id": "TEST-P1", "role": "patient"}))
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(db.writes, [])

    async def test_retrieval_failure_does_not_generate_an_ungrounded_answer(self):
        db = FakeSupa()
        db.select = AsyncMock(side_effect=HTTPException(502, "Database unavailable"))
        with patch.object(llm, "generate_json", AsyncMock()) as model:
            with self.assertRaises(HTTPException):
                await server.ai_chat(server.ChatRequest(message="Summarize my records"),
                                     (db, {"id": "TEST-P1", "role": "patient"}))
        model.assert_not_called()
        self.assertEqual(db.writes, [])

    async def test_doctor_cannot_use_patient_chat(self):
        db = FakeSupa()
        with self.assertRaises(HTTPException) as raised:
            await server.ai_chat(server.ChatRequest(message="Summarize my records"),
                                 (db, {"id": "TEST-D1", "role": "doctor"}))
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(db.queries, [])


if __name__ == "__main__":
    unittest.main()
