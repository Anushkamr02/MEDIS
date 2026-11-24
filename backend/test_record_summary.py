"""Clinical paragraph tests; synthetic records only, no Gemini or Supabase calls."""
import json
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
import llm
import server
from record_summary import summarize_records


def display_text(summary):
    return " ".join([summary["overview"], *summary.get("key_points", [])])


class FakeSupa:
    def __init__(self, assessment=None, v14=False):
        self.assessment, self.v14 = assessment, v14
        self.queries, self.updates = [], []

    async def select(self, table, params):
        self.queries.append((table, params))
        if table == "patient_health_summaries" and not self.v14:
            raise HTTPException(404, "Could not find the table 'public.patient_health_summaries'")
        if table == "cad_assessments":
            return [self.assessment] if self.assessment else []
        if table == "consultations":
            return [{"visit_id": "TEST-V1", "consultation_date": "2026-11-03", "status": "completed",
                     "final_diagnosis": None, "doctor_notes": "Review at next appointment",
                     "systolic_bp": 125, "diastolic_bp": 80, "heart_rate": 72, "bmi": 27.4}]
        return []

    async def update(self, table, match, row):
        self.updates.append(row)
        return [row]


class RecordSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, db, model=None):
        # Default: Gemini unconfigured, so the rule-based summary is used.
        model = model or AsyncMock(side_effect=HTTPException(503, "AI text features are not configured"))
        with patch.object(server, "require_patient_access", AsyncMock(return_value={"gender": "male", "date_of_birth": "1975-01-01"})), \
                patch.object(server, "audit", AsyncMock()), \
                patch.object(server.llm, "generate_json", model):
            result = await server.ai_summary("TEST-P1", server.SummaryRequest(),
                                            (db, {"id": "TEST-D1", "role": "doctor"}))
        self.model = model
        return result

    async def test_single_visit_without_assessment_or_diagnosis_is_summarized(self):
        db = FakeSupa()
        result = await self.request(db)
        paragraph = display_text(result["ai_summary"])
        self.assertIsNone(result["assessment_id"])
        self.assertEqual(result["summary_model"], "record-summary-v2")
        self.assertIn("125/80", paragraph)
        self.assertIn("Review at next appointment", paragraph)
        self.assertIn("27.4", paragraph)
        self.assertNotIn("TEST-V1", paragraph)
        self.assertEqual(result["ai_summary"]["changes"], [])
        self.assertEqual(db.updates, [])
        query = next(p for table, p in db.queries if table == "consultations")
        self.assertEqual(query["patient_id"], "eq.TEST-P1")
        self.assertNotIn("status", query)
        self.assertNotIn("limit", query)
        self.assertIn("observations", query["select"])

    async def test_insufficient_trend_status_does_not_block_summary(self):
        db = FakeSupa({"id": "TEST-A1", "report": {"review_priority": "INSUFFICIENT_DATA"}})
        result = await self.request(db)
        self.assertIn("completed consultation", result["ai_summary"]["overview"])
        self.assertNotIn("insufficient", result["ai_summary"]["overview"].lower())
        self.assertEqual(db.updates[0]["ai_summary"]["format"], "clinical-highlights-v1")

    def test_rich_history_has_short_overview_and_major_clinical_points(self):
        source = {"patient": {"known_conditions": {"hypertension": True, "diabetes": False}},
                  "recent_consultations": [
                      {"status": "pending", "date": "2026-11-04", "bmi": 28.1,
                       "complaints": {"main_complaint": "recurrent dizziness"}, "diagnosis": "Unconfirmed condition"},
                      {"status": "completed", "date": "2026-11-03", "bmi": 27.4,
                       "complaints": {"main_complaint": "exertional chest pain", "breathlessness": True,
                                      "chest_pain": "yes", "syncope": False},
                       "observations": {"cardiovascular": "regular heart sounds", "respiratory": "clear lung fields"},
                       "diagnosis": "Stable angina", "doctor_notes": "Follow-up review advised",
                       "systolic_bp": 125, "diastolic_bp": 80, "heart_rate": 72},
                      {"status": "completed", "date": "2026-09-01", "diagnosis": "Stable angina",
                       "complaints": {"main_complaint": "exertional chest pain"}}]}
        summary = summarize_records(source)
        paragraph = display_text(summary)
        self.assertTrue(60 <= len(paragraph.split()) <= 100, paragraph)
        self.assertIn("2 completed consultations", paragraph)
        self.assertIn("1 pending draft consultation", paragraph)
        for fact in ["exertional chest pain", "breathlessness", "Stable angina", "regular heart sounds",
                     "clear lung fields", "28.1", "recurrent dizziness", "unfinalized"]:
            self.assertIn(fact, paragraph)
        self.assertNotIn("Unconfirmed condition", paragraph)
        self.assertNotIn("diabetes", paragraph)
        self.assertNotIn("syncope", paragraph)
        self.assertEqual(paragraph.count("Stable angina"), 1)
        self.assertEqual(paragraph.count("chest pain"), 1)
        self.assertNotIn("\n", paragraph)
        self.assertNotIn("{", paragraph)
        self.assertEqual(summary["changes"], [])
        self.assertLess(len(summary["overview"].split()), 35)
        self.assertTrue(3 <= len(summary["key_points"]) <= 6)
        self.assertNotIn("BMI", summary["overview"])
        self.assertTrue(any("BMI" in point for point in summary["key_points"]))

    def test_pending_only_never_becomes_confirmed_diagnosis(self):
        paragraph = display_text(summarize_records({"recent_consultations": [
            {"status": "pending", "date": "2026-11-04", "diagnosis": "Unconfirmed diagnosis",
             "complaints": {"main_complaint": "fatigue"}, "bmi": 24.8} ]}))
        self.assertIn("pending draft", paragraph)
        self.assertIn("fatigue", paragraph)
        self.assertIn("unfinalized", paragraph)
        self.assertNotIn("Recorded diagnoses include", paragraph)
        self.assertNotIn("Unconfirmed diagnosis", paragraph)

    def test_unknown_status_is_not_counted_as_completed(self):
        paragraph = display_text(summarize_records({"recent_consultations": [{"diagnosis": "Uncertain status"}]}))
        self.assertIn("other recorded consultation", paragraph)
        self.assertNotIn("completed", paragraph)

    def test_no_findings_are_invented_to_fill_word_count(self):
        paragraph = display_text(summarize_records({}))
        self.assertEqual(paragraph, "No consultation findings are currently recorded.")
        self.assertNotIn("normal", paragraph)

    def test_condition_flags_and_documented_history_are_combined_without_repetition(self):
        paragraph = display_text(summarize_records({"patient": {
            "known_conditions": {"hypertension": "yes", "diabetes": False},
            "recorded_conditions": ["Hypertension", "Asthma"]}}))
        self.assertEqual(paragraph.lower().count("hypertension"), 1)
        self.assertIn("Asthma", paragraph)
        self.assertNotIn("diabetes", paragraph)
        self.assertNotIn("yes", paragraph)

    def test_latest_bmi_is_chronological_and_missing_values_are_omitted(self):
        source = {"recent_consultations": [
            {"status": "completed", "date": "2026-01-01", "bmi": 22},
            {"status": "completed", "date": "2026-10-01", "bmi": 26},
            {"status": "completed", "date": "2026-11-01", "bmi": None}]}
        paragraph = display_text(summarize_records(source))
        self.assertIn("BMI is 26", paragraph)
        self.assertNotIn("BMI is 22", paragraph)

    def test_json_and_technical_identifiers_are_not_rendered(self):
        paragraph = display_text(summarize_records({"recent_consultations": [
            {"status": "completed", "date": "2026-11-03", "visit_id": "MEDIS-V-2026-00001",
             "complaints": '{"main_complaint":"headache"}',
             "observations": {"general": "Alert and oriented"},
             "doctor_notes": "MEDIS-V-2026-00001", "diagnosis": None}]}))
        self.assertIn("headache", paragraph)
        self.assertIn("Alert and oriented", paragraph)
        for raw in ("MEDIS-", "{", "}", "main_complaint", "null", "True"):
            self.assertNotIn(raw, paragraph)


MONITORING = {"health_trend": "WORSENING", "reasons": ["LDL 120 → 150 mg/dL (10 Jan 2026 → 10 Mar 2026)"],
              "treatment_responses": [{"medicine": "Atorvastatin", "status": "awaiting_follow_up"}]}
GEMINI_ANSWER = {
    "overview": "Blood pressure 125/80 on 3 Nov 2026; trend Worsening since the last check.",
    "changes": [{"text": "LDL rose from 120 to 150 mg/dL.", "visit_ids": ["TEST-V1"]}],
    "review_points": ["Check LDL after Atorvastatin; a value of 999 was noted."],
    "data_gaps": [],
    "patient_draft": {"headline": "Your blood pressure was 125/80 at your last visit.",
                      "points": ["Your cholesterol went up from 120 to 150.", "It was 777 last time."],
                      "next_step": "Talk about these results with your doctor at your next visit."},
}


class GeminiSummaryTests(RecordSummaryTests.__base__):
    request = RecordSummaryTests.request

    async def test_gemini_writes_doctor_version_and_patient_draft(self):
        db = FakeSupa({"id": "TEST-A1", "report": {"review_priority": "REVIEW"}, "monitoring": MONITORING})
        result = await self.request(db, AsyncMock(return_value=(json.loads(json.dumps(GEMINI_ANSWER)), "test-model")))
        summary, draft = result["ai_summary"], result["patient_draft"]
        self.assertEqual(summary["format"], llm.SUMMARY_FORMAT)
        self.assertEqual(result["summary_model"], "test-model")
        self.assertIsNone(result["fallback_reason"])
        self.assertEqual(summary["unverified_numbers"], ["999"])
        self.assertEqual(draft["headline"], GEMINI_ANSWER["patient_draft"]["headline"])
        self.assertEqual(draft["unverified_numbers"], ["777"])
        self.assertFalse(draft["publishable"])  # an untraceable number blocks publishing
        # The prompt carries the trend, reasons and treatment responses.
        sent = json.loads(self.model.call_args.args[1][0]["content"])
        self.assertEqual(sent["monitoring"]["health_trend"], "WORSENING")
        self.assertEqual(sent["monitoring"]["treatment_responses"][0]["medicine"], "Atorvastatin")
        self.assertEqual(sent["recent_consultations"][0]["visit_id"], "TEST-V1")

    async def test_patient_draft_is_never_stored_in_a_patient_readable_field(self):
        db = FakeSupa({"id": "TEST-A1", "report": {}, "monitoring": MONITORING})
        await self.request(db, AsyncMock(return_value=(json.loads(json.dumps(GEMINI_ANSWER)), "test-model")))
        stored = json.dumps(db.updates)
        self.assertNotIn("patient_draft", stored)
        self.assertNotIn(GEMINI_ANSWER["patient_draft"]["headline"], stored)
        self.assertNotIn(GEMINI_ANSWER["patient_draft"]["next_step"], stored)

    async def test_patient_draft_is_kept_for_the_doctor_once_v14_locks_assessments(self):
        db = FakeSupa({"id": "TEST-A1", "report": {}, "monitoring": MONITORING}, v14=True)
        await self.request(db, AsyncMock(return_value=(json.loads(json.dumps(GEMINI_ANSWER)), "test-model")))
        stored = db.updates[0]["ai_summary"]["patient_draft"]
        self.assertEqual(stored["headline"], GEMINI_ANSWER["patient_draft"]["headline"])
        self.assertFalse(stored["publishable"])

    async def test_quota_error_falls_back_to_record_summary(self):
        db = FakeSupa({"id": "TEST-A1", "report": {}})
        result = await self.request(db, AsyncMock(side_effect=HTTPException(429, "The free AI quota is used up for now.")))
        self.assertEqual(result["summary_model"], "record-summary-v2")
        self.assertEqual(result["ai_summary"]["format"], "clinical-highlights-v1")
        self.assertIn("quota", result["fallback_reason"])
        self.assertEqual(result["ai_summary"]["fallback_reason"], result["fallback_reason"])
        self.assertIsNone(result["patient_draft"])

    async def test_summary_without_an_assessment_still_uses_gemini(self):
        db = FakeSupa()
        result = await self.request(db, AsyncMock(return_value=(json.loads(json.dumps(GEMINI_ANSWER)), "test-model")))
        self.assertIsNone(result["assessment_id"])
        self.assertEqual(result["ai_summary"]["format"], llm.SUMMARY_FORMAT)
        sent = json.loads(self.model.call_args.args[1][0]["content"])
        self.assertIsNone(sent["monitoring"])
        self.assertIsNone(sent["review_priority"])
        self.assertEqual(db.updates, [])


if __name__ == "__main__":
    unittest.main()
