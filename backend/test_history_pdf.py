"""Patient history PDF (migration v14): a patient copy never carries AI output,
only the summary a doctor published. Synthetic data; no Supabase calls."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate

import history_pdf
import server
from medis.reports.medical_history_pdf import _append_health_summary_section

PUBLISHED = {"status_message": "keep_an_eye", "headline": "Your cholesterol <went up> & needs a recheck.",
             "points": ["LDL rose from 120 to 150."], "next_step": "Discuss it at your next visit.",
             "shown_metrics": {"ldl_cholesterol": {"label": "LDL cholesterol", "unit": "mg/dL", "count": 2,
                                                   "points": [{"date": "2026-01-10", "value": 120},
                                                              {"date": "2026-03-10", "value": 150}]}},
             "published_at": "2026-11-20T10:00:00Z", "profiles": {"full_name": "Test Doctor"}}


class FakeSupa:
    def __init__(self, v14=True):
        self.v14, self.queries = v14, []

    async def select(self, table, params):
        self.queries.append(table)
        if table == "profiles" and "id" in params and params["id"].startswith("eq."):
            return [{"id": "TEST-P1", "display_id": "MEDIS-P-1", "full_name": "Test Patient"}]
        if table == "patient_health_summaries":
            if not self.v14:
                raise HTTPException(404, "Could not find the table")
            return [dict(PUBLISHED)]
        return []


class PatientHistoryPdfTests(unittest.IsolatedAsyncioTestCase):
    async def export(self, db):
        def fake_render(path, *rows, **kwargs):
            self.kwargs = kwargs
            Path(path).write_bytes(b"%PDF-")

        with patch.object(history_pdf, "render", fake_render), patch.object(server, "audit", AsyncMock()):
            await server.history_pdf("TEST-P1", ctx=(db, {"id": "TEST-P1", "role": "patient"}))

    async def test_patient_copy_prints_the_published_summary_not_the_ai_section(self):
        db = FakeSupa()
        await self.export(db)
        self.assertFalse(self.kwargs["include_ai"])
        self.assertNotIn("ai_report", self.kwargs)
        self.assertEqual(self.kwargs["health_summary"]["headline"], PUBLISHED["headline"])
        self.assertEqual(self.kwargs["health_summary"]["doctor"], "Test Doctor")
        self.assertNotIn("cad_assessments", db.queries)

    async def test_patient_copy_before_v14_has_no_summary_section(self):
        await self.export(FakeSupa(v14=False))
        self.assertFalse(self.kwargs["include_ai"])
        self.assertIsNone(self.kwargs["health_summary"])

    def test_summary_section_renders_doctor_text_safely(self):
        styles = getSampleStyleSheet()
        story = []
        summary = {**PUBLISHED, "doctor": "Test Doctor"}
        _append_health_summary_section(story, summary, styles["Heading2"], styles["Normal"], styles["Normal"], styles["Normal"])
        text = " ".join(getattr(f, "text", "") for f in story)
        self.assertIn("Some results to keep an eye on", text)
        self.assertIn("&lt;went up&gt; &amp; needs", text)
        self.assertIn("120 on 2026-01-10, 150 on 2026-03-10", text)
        with tempfile.TemporaryDirectory() as folder:
            SimpleDocTemplate(str(Path(folder) / "s.pdf")).build(story)


if __name__ == "__main__":
    unittest.main()
