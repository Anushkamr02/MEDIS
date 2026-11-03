"""Isolated regression tests; never open the project's patient database."""
import unittest
from datetime import datetime
from unittest.mock import patch
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from medis.ai.longitudinal_analysis import generate_longitudinal_cad_report, compare_historical_ecgs
from medis.ai.visit_patterns import detect_visit_patterns
from medis.database.connection import Base
from medis.database.models import Patient, Visit, Symptom, ClinicalMeasurement, ECGResult, LongitudinalAssessment


def visit(identity, day, hospital="A", **extra):
    return dict(visit_id=identity, date=day, hospital=hospital, **extra)


def codes(result):
    return {flag["code"] for flag in result["flags"]}


class PatternTests(unittest.TestCase):
    def test_velocity_uses_personal_baseline(self):
        dates = ["2024-01-01", "2024-07-01", "2025-01-01", "2025-07-01",
                 "2025-07-08", "2025-07-15", "2025-07-22"]
        rows = [visit(str(i), day) for i, day in enumerate(dates)]
        self.assertIn("VISIT_ACCELERATION", codes(detect_visit_patterns(rows, as_of="2025-07-22")))
        self.assertNotIn("VISIT_ACCELERATION", codes(detect_visit_patterns(rows[-3:], as_of="2025-07-22")))

    def test_cluster_sorted_deduplicated(self):
        rows = [visit(str(i), f"2026-01-{1 + i * 7:02}", h, symptoms={"chief_complaint": " Chest   Pain "})
                for i, h in enumerate(("A", "B", "C"))]
        result = detect_visit_patterns(rows[::-1] + [rows[0]], as_of="2026-01-22")
        self.assertIn("VISIT_CLUSTER", codes(result))
        self.assertEqual(result["excluded_visits"], 1)
        self.assertEqual(result["distinct_hospitals_last_365_days"], 3)

    def test_different_complaints_and_unknown_sites(self):
        rows = [visit(str(i), "2026-01-01", None, symptoms={"chief_complaint": str(i)}) for i in range(3)]
        self.assertNotIn("VISIT_CLUSTER", codes(detect_visit_patterns(rows, as_of="2026-01-22")))

    def test_invalid_future_and_old_dates(self):
        result = detect_visit_patterns([visit("a", "bad"), visit("b", "2027-01-01"),
                                        visit("c", "2020-01-01")], as_of="2026-01-22")
        self.assertEqual(result["excluded_visits"], 2)
        self.assertEqual(result["distinct_hospitals_last_365_days"], 0)
        with self.assertRaises(ValueError):
            detect_visit_patterns([], as_of="bad")

    def test_structured_symptoms(self):
        rows = [visit("a", "2026-01-01", symptoms={"chest_pain_present": True, "chest_pain_severity": 2}),
                visit("b", "2026-02-01", symptoms={"chest_pain_present": True, "chest_pain_severity": 8})]
        self.assertIn("SYMPTOM_ESCALATION", codes(detect_visit_patterns(rows, as_of="2026-02-01")))
        rows[1]["symptoms"]["chest_pain_present"] = False
        self.assertNotIn("SYMPTOM_ESCALATION", codes(detect_visit_patterns(rows, as_of="2026-02-01")))

    def test_sparse_metabolic_measurements(self):
        rows = [visit("a", "2025-01-01", measurements={"bmi": 25, "fasting_glucose": 98, "egfr": 100}),
                visit("b", "2025-02-01", measurements={"bmi": float("nan")}),
                visit("c", "2026-01-01", measurements={"bmi": 29, "fasting_glucose": 132, "egfr": 75})]
        self.assertIn("MULTISYSTEM_TREND", codes(detect_visit_patterns(rows, as_of="2026-01-01")))
        rows[-1]["measurements"]["egfr"] = None
        self.assertNotIn("MULTISYSTEM_TREND", codes(detect_visit_patterns(rows, as_of="2026-01-01")))

    def test_prescription_overlap_and_expiry(self):
        rows = [visit(str(i), "2026-01-01", prescriptions=[{
            "prescription_id": str(i), "date": "2026-01-01", "items": [
                {"medicine_name": drug, "duration": "30 days"}]}])
                for i, drug in enumerate(("Metoprolol", "Diltiazem"))]
        self.assertIn("PRESCRIPTION_OVERLAP", codes(detect_visit_patterns(rows, as_of="2026-01-15")))
        self.assertNotIn("PRESCRIPTION_OVERLAP", codes(detect_visit_patterns(rows, as_of="2026-01-31")))
        rows[0]["prescriptions"][0]["items"][0]["duration"] = "as needed"
        result = detect_visit_patterns(rows, as_of="2026-01-15")
        self.assertNotIn("PRESCRIPTION_OVERLAP", codes(result))
        self.assertEqual(result["unparsed_prescription_items"], 1)

    def test_insufficient_evidence(self):
        result = detect_visit_patterns([], as_of="2026-01-01")
        self.assertEqual(result["flags"], [])
        self.assertIn("NOT_ASSESSABLE", result["coverage"]["refill_dropoff"])
        self.assertIn("NOT_ASSESSABLE", result["coverage"]["seasonality"])


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.db.add(Patient(patient_id="P", full_name="Test", gender="Female", contact_number="000"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_read_only_and_persistence(self):
        report = generate_longitudinal_cad_report("P", self.db, persist=False)
        self.assertEqual(report["risk_category"], "INSUFFICIENT_DATA")
        self.assertEqual(self.db.query(LongitudinalAssessment).count(), 0)
        saved = generate_longitudinal_cad_report("P", self.db)
        self.assertIsNotNone(saved["assessment_id"])
        self.assertEqual(self.db.query(LongitudinalAssessment).count(), 1)

    def test_queries_do_not_grow_per_visit(self):
        for i in range(12):
            self.db.add(Visit(visit_id=str(i), patient_id="P", doctor_id="D", visit_date=datetime(2025, 1, i + 1)))
            self.db.add(ClinicalMeasurement(visit_id=str(i), systolic_bp=120, diastolic_bp=75))
            self.db.add(Symptom(visit_id=str(i), chest_pain_present=False))
        self.db.commit()
        queries = []
        def record(conn, cursor, statement, parameters, context, many):
            if statement.lstrip().upper().startswith("SELECT"):
                queries.append(statement)
        event.listen(self.engine, "before_cursor_execute", record)
        report = generate_longitudinal_cad_report("P", self.db, persist=False)
        self.assertEqual(report["visits_analyzed_count"], 12)
        self.assertLessEqual(len(queries), 8)

    def test_missing_baseline_qtc(self):
        self.db.add_all([ECGResult(patient_id="P", file_path="fixture", recording_date=datetime(2025, 1, 1), qtc_interval_ms=None),
                         ECGResult(patient_id="P", file_path="fixture", recording_date=datetime(2025, 2, 1), qtc_interval_ms=480)])
        self.db.commit()
        result = compare_historical_ecgs([], db=self.db, patient_id="P", as_of="2025-02-01")
        self.assertIn("unavailable", result["observations"][0])


class SetupTests(unittest.TestCase):
    def test_failure_returns_nonzero(self):
        import setup_check
        with patch("builtins.print"), patch("sys.argv", ["setup_check.py"]), \
             patch.object(setup_check.shutil, "which", return_value=None), \
             patch.object(setup_check.importlib, "import_module", side_effect=ImportError("missing")):
            self.assertEqual(setup_check.main(), 1)


if __name__ == "__main__":
    unittest.main()
