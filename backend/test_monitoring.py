"""Monitoring trend scenarios; synthetic records only, no Supabase or network."""
import unittest

from medis.ai.drug_classes import classify
from medis.ai.longitudinal_analysis import assess_timeline
from medis.ai.monitoring import assess_monitoring, metric_change, TARGETS


def visit(identity, day, symptoms=None, prescriptions=None, **measurements):
    return {"visit_id": identity, "date": day, "hospital": "Hospital " + identity,
            "measurements": measurements, "symptoms": symptoms or {}, "prescriptions": prescriptions or []}


def rx(day, *names):
    return [{"prescription_id": f"rx-{day}", "date": day, "items": [{"medicine_name": n} for n in names]}]


def monitor(visits, previous=None, as_of=None):
    report = assess_timeline(visits, as_of=as_of)
    return assess_monitoring(report, previous, visits, as_of=as_of)


class MonitoringTrendTests(unittest.TestCase):
    def test_rahul_demo_series_is_worsening_with_dated_reasons(self):
        rows = [visit("V1", "2026-01-15", systolic_bp=120, diastolic_bp=80, ldl_cholesterol=95, hba1c=5.5),
                visit("V2", "2026-03-15", systolic_bp=130, diastolic_bp=85, ldl_cholesterol=110, hba1c=5.9),
                visit("V3", "2026-06-15", systolic_bp=140, diastolic_bp=90, ldl_cholesterol=135, hba1c=6.2),
                visit("V4", "2026-10-08", systolic_bp=150, diastolic_bp=95, ldl_cholesterol=155, hba1c=6.8)]
        result = monitor(rows, as_of="2026-10-20")
        self.assertEqual(result["health_trend"], "WORSENING")
        text = " ".join(result["reasons"])
        self.assertIn("LDL 135 → 155 mg/dL (15 Jun 2026 → 08 Oct 2026), moving away from target < 100", text)
        self.assertIn("HbA1c 6.2 → 6.8", text)
        ldl = next(m for m in result["metric_changes"] if m["metric"] == "ldl_cholesterol")
        self.assertEqual(ldl["previous"]["visit_ids"], ["V3"])
        self.assertEqual(ldl["latest"]["visit_ids"], ["V4"])

    def test_statin_followed_by_ldl_drop_is_responding_and_improving(self):
        rows = [visit("V1", "2026-01-10", prescriptions=rx("2026-01-10", "Tab. Atorvastatin 20 mg"), ldl_cholesterol=160),
                visit("V2", "2026-03-10", ldl_cholesterol=110)]
        result = monitor(rows, as_of="2026-03-12")
        self.assertEqual(result["health_trend"], "IMPROVING")
        statin = result["treatment_responses"][0]
        self.assertEqual((statin["medicine"], statin["metric"], statin["status"]),
                         ("Atorvastatin", "ldl_cholesterol", "responding"))
        self.assertEqual(statin["baseline"]["value"], 160)
        self.assertEqual(statin["follow_up"]["value"], 110)

    def test_rise_on_treatment_is_worsening(self):
        rows = [visit("V1", "2026-01-10", prescriptions=rx("2026-01-10", "Rosuvastatin 10mg"), ldl_cholesterol=130),
                visit("V2", "2026-03-10", ldl_cholesterol=150)]
        result = monitor(rows, as_of="2026-03-12")
        self.assertEqual(result["health_trend"], "WORSENING")
        self.assertEqual(result["treatment_responses"][0]["status"], "worsening_on_treatment")

    def test_change_below_minimum_is_stable(self):
        rows = [visit("V1", "2026-01-10", ldl_cholesterol=120, systolic_bp=135),
                visit("V2", "2026-04-10", ldl_cholesterol=124, systolic_bp=137)]
        result = monitor(rows, as_of="2026-04-12")
        self.assertEqual(result["health_trend"], "STABLE")
        self.assertEqual({m["status"] for m in result["metric_changes"] if m["previous"]}, {"stable"})

    def test_values_within_target_are_controlled_not_improving(self):
        rows = [visit("V1", "2026-01-10", ldl_cholesterol=90), visit("V2", "2026-04-10", ldl_cholesterol=60)]
        result = monitor(rows, as_of="2026-04-12")
        self.assertEqual(result["health_trend"], "STABLE")
        self.assertEqual(result["metric_changes"][2]["status"], "controlled")

    def test_single_visit_is_insufficient(self):
        result = monitor([visit("V1", "2026-04-10", ldl_cholesterol=150, systolic_bp=140)], as_of="2026-04-12")
        self.assertEqual(result["health_trend"], "INSUFFICIENT_DATA")
        self.assertTrue(all(m["status"] == "insufficient" for m in result["metric_changes"]))

    def test_stale_latest_reading_is_not_compared(self):
        rows = [visit("V1", "2024-01-10", ldl_cholesterol=100), visit("V2", "2024-06-10", ldl_cholesterol=160)]
        result = monitor(rows, as_of="2026-04-12")
        self.assertEqual(result["health_trend"], "INSUFFICIENT_DATA")

    def test_prescription_without_follow_up_is_awaiting_with_due_dates(self):
        rows = [visit("V1", "2026-10-01", prescriptions=rx("2026-10-01", "Atorvastatin"), ldl_cholesterol=170)]
        result = monitor(rows, as_of="2026-10-15")
        statin = result["treatment_responses"][0]
        self.assertEqual(statin["status"], "awaiting_follow_up")
        self.assertEqual((statin["due_from"], statin["due_by"], statin["overdue"]), ("2026-10-29", "2026-12-24", False))
        self.assertIn("LDL check after atorvastatin due by 24 Dec 2026", result["reasons"])
        late = monitor(rows, as_of="2027-01-05")["treatment_responses"][0]
        self.assertTrue(late["overdue"])

    def test_bp_medicine_checks_both_pressures_and_glucose_medicine_waits_for_hba1c(self):
        rows = [visit("V1", "2026-01-10", prescriptions=rx("2026-01-10", "Telmisartan + Amlodipine", "Metformin 500"),
                      systolic_bp=150, diastolic_bp=95, hba1c=7.4, fasting_glucose=150),
                visit("V2", "2026-02-10", systolic_bp=134, diastolic_bp=84, fasting_glucose=118)]
        result = monitor(rows, as_of="2026-02-12")
        by_metric = {(t["medicine"], t["metric"]): t["status"] for t in result["treatment_responses"]}
        self.assertEqual(by_metric[("Telmisartan", "systolic_bp")], "responding")
        self.assertEqual(by_metric[("Amlodipine", "diastolic_bp")], "responding")
        self.assertEqual(by_metric[("Metformin", "fasting_glucose")], "responding")
        self.assertEqual(by_metric[("Metformin", "hba1c")], "awaiting_follow_up")
        self.assertEqual(result["health_trend"], "IMPROVING")

    def test_old_prescription_is_not_a_current_course(self):
        rows = [visit("V1", "2024-01-10", prescriptions=rx("2024-01-10", "Atorvastatin"), ldl_cholesterol=160),
                visit("V2", "2026-03-10", ldl_cholesterol=150)]
        self.assertEqual(monitor(rows, as_of="2026-03-12")["treatment_responses"], [])

    def test_resolved_chest_pain_is_improving(self):
        rows = [visit("V1", "2026-05-01", symptoms={"chest_pain_present": True, "chest_pain_severity": 5}),
                visit("V2", "2026-06-01", symptoms={"chest_pain_present": False})]
        result = monitor(rows, as_of="2026-06-02")
        self.assertEqual(result["symptom_change"]["status"], "improving")
        self.assertEqual(result["health_trend"], "IMPROVING")

    def test_new_symptom_and_rising_nyha_are_worsening(self):
        rows = [visit("V1", "2026-05-01", symptoms={"breathlessness_present": True, "breathlessness_nyha_class": "Class II"}),
                visit("V2", "2026-06-01", symptoms={"breathlessness_present": True, "breathlessness_nyha_class": "Class III",
                                                    "palpitations": True})]
        result = monitor(rows, as_of="2026-06-02")
        self.assertEqual(result["health_trend"], "WORSENING")
        text = " ".join(result["symptom_change"]["reasons"])
        self.assertIn("New palpitations", text)
        self.assertIn("NYHA class 2 → 3", text)

    def test_priority_escalation_alone_is_worsening(self):
        rows = [visit("V1", "2026-06-01", systolic_bp=185, diastolic_bp=100)]
        result = monitor(rows, previous={"review_priority": "REVIEW"}, as_of="2026-06-02")
        self.assertEqual(result["priority_change"]["status"], "escalated")
        self.assertEqual(result["health_trend"], "WORSENING")

    def test_priority_de_escalation_counts_as_improving(self):
        rows = [visit("V1", "2026-01-10", ldl_cholesterol=90), visit("V2", "2026-04-10", ldl_cholesterol=88)]
        result = monitor(rows, previous={"review_priority": "REVIEW"}, as_of="2026-04-12")
        self.assertEqual(result["health_trend"], "IMPROVING")

    def test_falling_but_still_low_egfr_and_rising_hdl_directions(self):
        egfr = metric_change("egfr", {"unit": "mL/min/1.73m2", "stale": False, "points": [
            {"date": "2026-01-01", "value": 80, "evidence": []}, {"date": "2026-04-01", "value": 70, "evidence": []}]})
        self.assertEqual(egfr["status"], "worsening")
        hdl = metric_change("hdl_cholesterol", {"unit": "mg/dL", "stale": False, "points": [
            {"date": "2026-01-01", "value": 32, "evidence": []}, {"date": "2026-04-01", "value": 41, "evidence": []}]})
        self.assertEqual(hdl["status"], "improving")

    def test_every_engine_metric_has_a_target(self):
        from medis.ai.trajectories import METRICS
        self.assertEqual(set(METRICS), set(TARGETS))


class DrugClassTests(unittest.TestCase):
    def test_generic_names_are_matched_inside_free_text(self):
        self.assertEqual(classify("Tab. Atorvastatin 20 mg"), [("statin", "atorvastatin")])
        self.assertEqual(classify("Amlodipine + Atorvastatin"),
                         [("statin", "atorvastatin"), ("antihypertensive", "amlodipine")])

    def test_unknown_or_empty_names_are_ignored(self):
        self.assertEqual(classify("Aspirin 75 mg"), [])
        self.assertEqual(classify(None), [])


if __name__ == "__main__":
    unittest.main()
