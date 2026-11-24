"""/ai/monitor endpoints with a fake Supabase client; synthetic records only."""
import unittest
from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import server

DOCTOR = {"id": "TEST-D1", "role": "doctor"}
TODAY = date.today()


def day(offset):
    return (TODAY - timedelta(days=offset)).isoformat()


def consultation(cid, offset, **values):
    return {"id": cid, "visit_id": f"V-{cid}", "status": "completed", "consultation_date": day(offset),
            "hospitals": {"name": "Test Hospital"}, "complaints": {}, **values}


class FakeSupa:
    def __init__(self, consultations, prescriptions=(), previous=None, queue=(), legacy=False, broken=()):
        self.consultations, self.prescriptions = list(consultations), list(prescriptions)
        self.previous, self.queue, self.legacy, self.broken = previous, list(queue), legacy, set(broken)
        self.inserts, self.updates, self.ignored = [], [], []

    async def select(self, table, params):
        patient = params.get("patient_id", "eq.")[3:]
        if table == "consultations":
            if patient in self.broken:
                raise HTTPException(502, "Supabase error: boom")
            return self.consultations
        if table == "prescriptions":
            return self.prescriptions
        if table == "cad_assessments":
            return [self.previous] if self.previous else []
        if table == "monitoring_queue":
            if self.legacy:
                raise HTTPException(404, 'Supabase error: {"code":"PGRST205"}')
            return self.queue
        return []

    async def insert(self, table, row):
        if self.legacy and "health_trend" in row:
            raise HTTPException(400, 'Supabase error: {"code":"PGRST204","message":"Could not find the column"}')
        self.inserts.append((table, row))
        return {"id": f"A{len(self.inserts)}", **row}

    async def insert_ignore(self, table, rows, on_conflict):
        if self.legacy:
            raise HTTPException(404, 'Supabase error: {"code":"PGRST205"}')
        self.ignored.append((table, rows, on_conflict))

    async def update(self, table, match, values, filters=None):
        if self.legacy:
            raise HTTPException(404, 'Supabase error: {"code":"PGRST205"}')
        self.updates.append((table, match, values, filters))
        return []


WORSENING = [consultation("c1", 120, ldl_cholesterol=110, systolic_bp=130),
             consultation("c2", 10, ldl_cholesterol=150, systolic_bp=150)]


class MonitorEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, coro_factory):
        with patch.object(server, "require_patient_access", AsyncMock(return_value={})), \
                patch.object(server, "audit", AsyncMock()) as audit:
            result = await coro_factory()
        return result, audit

    async def test_monitor_saves_trend_trigger_and_previous_link(self):
        db = FakeSupa(WORSENING, previous={"id": "PREV", "review_priority": "REVIEW"})
        body = server.MonitorRequest(trigger_event="visit_finalized", trigger_ref="c2")
        result, audit = await self.call(lambda: server.monitor("TEST-P1", body, (db, DOCTOR)))
        self.assertEqual(result["health_trend"], "WORSENING")
        table, row = db.inserts[0]
        self.assertEqual(table, "cad_assessments")
        self.assertEqual((row["trigger_event"], row["trigger_ref"], row["previous_assessment_id"]),
                         ("visit_finalized", "c2", "PREV"))
        self.assertEqual(row["monitoring"]["health_trend"], "WORSENING")
        self.assertEqual(audit.call_args.args[2], "ai_monitoring")
        _, match, values, filters = db.updates[0]
        self.assertEqual(match, {"patient_id": "TEST-P1"})
        self.assertEqual(filters["processed_at"], "is.null")

    async def test_new_prescription_queues_a_follow_up_once_per_course(self):
        rx = [{"id": "rx1", "consultation_id": "c2", "issued_at": day(10) + "T10:00:00Z",
               "medicines": [{"name": "Atorvastatin 20 mg"}]}]
        db = FakeSupa(WORSENING, prescriptions=rx)
        body = server.MonitorRequest(trigger_event="prescription_issued", trigger_ref="rx1")
        await self.call(lambda: server.monitor("TEST-P1", body, (db, DOCTOR)))
        table, rows, conflict = db.ignored[0]
        self.assertEqual((table, conflict), ("monitoring_queue", "dedupe_key"))
        self.assertEqual(rows[0]["dedupe_key"], f"follow_up:TEST-P1:atorvastatin:ldl_cholesterol:{day(10)}")
        self.assertEqual(rows[0]["due_at"], day(10 - 28))
        self.assertEqual(rows[0]["detail"]["metric_label"], "LDL")

    async def test_manual_run_analysis_also_stores_monitoring(self):
        db = FakeSupa(WORSENING)
        result, audit = await self.call(lambda: server.longitudinal(
            "TEST-P1", server.LongitudinalRequest(), (db, DOCTOR)))
        self.assertEqual(result["monitoring"]["health_trend"], "WORSENING")
        self.assertEqual(db.inserts[0][1]["trigger_event"], "manual")
        self.assertEqual(audit.call_args.args[2], "ai_longitudinal_assessment")

    async def test_older_schema_still_saves_the_assessment(self):
        db = FakeSupa(WORSENING, legacy=True)
        body = server.MonitorRequest(trigger_event="visit_finalized")
        result, _ = await self.call(lambda: server.monitor("TEST-P1", body, (db, DOCTOR)))
        self.assertEqual(result["health_trend"], "WORSENING")
        self.assertNotIn("health_trend", db.inserts[0][1])
        queue, _ = await self.call(lambda: server.monitor_queue((db, DOCTOR)))
        self.assertTrue(queue["unavailable"])

    async def test_queue_collapses_rows_per_patient_and_keeps_failures(self):
        queue = [{"patient_id": "P1", "reason": "visit_finalized"},
                 {"patient_id": "P1", "reason": "prescription_issued"},
                 {"patient_id": "P2", "reason": "report_verified"}]
        db = FakeSupa(WORSENING, queue=queue, broken={"P2"})
        result, _ = await self.call(lambda: server.monitor_queue((db, DOCTOR)))
        self.assertEqual([p["patient_id"] for p in result["processed"]], ["P1"])
        self.assertEqual([f["patient_id"] for f in result["failed"]], ["P2"])
        self.assertEqual(len([i for i in db.inserts if i[0] == "cad_assessments"]), 1)
        self.assertEqual(db.inserts[0][1]["trigger_event"], "queued_recheck")
        self.assertEqual([u[1] for u in db.updates], [{"patient_id": "P1"}])  # P2 stays queued

    async def test_queue_processes_at_most_ten_patients_per_call(self):
        queue = [{"patient_id": f"P{i}", "reason": "visit_finalized"} for i in range(13)]
        db = FakeSupa(WORSENING, queue=queue)
        result, _ = await self.call(lambda: server.monitor_queue((db, DOCTOR)))
        self.assertEqual((len(result["processed"]), result["remaining"]), (10, 3))


if __name__ == "__main__":
    unittest.main()
