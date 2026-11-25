"""/ai/risk with a fake Supabase client; synthetic records only."""
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import server

DOCTOR = {"id": "TEST-D1", "role": "doctor", "full_name": "Test Doctor"}
CONFIRMED = {"model_sex": "Female", "age": 45, "total_cholesterol": 200, "hdl_cholesterol": 60,
             "systolic_bp": 120, "diabetes": True, "current_smoker": False, "bmi": 25, "egfr": 95,
             "bp_treated": False, "statin": False, "known_ascvd": False}


def snapshot_today():
    from datetime import date
    return date.today().isoformat()


class FakeSupa:
    def __init__(self, assessment=None):
        self.assessment = assessment
        self.updates = []

    async def select(self, table, params):
        return [self.assessment] if table == "cad_assessments" and self.assessment else []

    async def update(self, table, match, values, filters=None):
        self.updates.append((table, match, values))
        return [{**self.assessment, **values}]


class RiskEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, db, **inputs):
        body = server.RiskInputs(snapshot_date=snapshot_today(), **inputs)
        with patch.object(server, "require_patient_access", AsyncMock(return_value={})), \
                patch.object(server, "audit", AsyncMock()) as audit:
            result = await server.risk("A1", body, (db, DOCTOR))
        return result, audit

    async def test_prevent_is_stored_under_pce_prevent_with_who_confirmed_it(self):
        db = FakeSupa({"id": "A1", "patient_id": "TEST-P1", "pce": {"status": "CALCULATED", "risk_percent": 8.2}})
        result, audit = await self.call(db, **CONFIRMED)

        self.assertEqual(result["result"]["risks"], {"total_cvd": 3.4, "ascvd": 2.1, "heart_failure": 1.7})
        self.assertEqual(result["result"]["confirmed_by"], "TEST-D1")
        self.assertEqual(result["result"]["inputs"]["age"], 45)
        _, match, values = db.updates[0]
        self.assertEqual(match, {"id": "A1"})
        # The legacy PCE already on the row is kept; PREVENT sits beside it.
        self.assertEqual(values["pce"]["risk_percent"], 8.2)
        self.assertEqual(values["pce"]["prevent"]["model"], "PREVENT_2023_BASE_10YR")
        self.assertEqual(audit.call_args.args[2], "ai_risk_calculation")

    async def test_the_legacy_pce_can_still_be_calculated_without_losing_prevent(self):
        db = FakeSupa({"id": "A1", "patient_id": "TEST-P1", "pce": {"prevent": {"status": "CALCULATED"}}})
        result, _ = await self.call(db, model="pce", model_sex="Male", cohort="White", age=55,
                                    total_cholesterol=213, hdl_cholesterol=50, systolic_bp=140,
                                    bp_treated=False, diabetes=False, current_smoker=True, known_ascvd=False)
        self.assertEqual(result["result"]["status"], "CALCULATED")
        self.assertEqual(result["result"]["model"], "PCE_2013_LEGACY")
        _, _, values = db.updates[0]
        self.assertEqual(values["pce"]["risk_percent"], result["result"]["risk_percent"])
        self.assertEqual(values["pce"]["prevent"], {"status": "CALCULATED"})

    async def test_a_patient_with_known_disease_is_saved_as_not_applicable(self):
        db = FakeSupa({"id": "A1", "patient_id": "TEST-P1", "pce": None})
        result, _ = await self.call(db, **{**CONFIRMED, "known_ascvd": True})
        self.assertEqual(result["result"]["status"], "NOT_APPLICABLE")
        self.assertEqual(result["result"]["risks"], {})

    async def test_the_risk_result_never_touches_the_trend_report_or_priority(self):
        db = FakeSupa({"id": "A1", "patient_id": "TEST-P1", "pce": None})
        await self.call(db, **CONFIRMED)
        _, _, values = db.updates[0]
        self.assertEqual(list(values), ["pce"])  # report and review_priority are untouched

    async def test_an_unknown_assessment_is_rejected_before_any_calculation(self):
        db = FakeSupa(None)
        with self.assertRaises(HTTPException) as raised:
            await self.call(db, **CONFIRMED)
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(db.updates, [])

    async def test_a_patient_cannot_run_the_calculators(self):
        with self.assertRaises(HTTPException) as raised:
            await server.current_doctor((FakeSupa(None), {"id": "TEST-P1", "role": "patient"}))
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
