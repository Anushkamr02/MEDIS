"""Regression scenarios and published risk-equation reference examples."""
import json
import math
import unittest
from datetime import date, timedelta

from medis.ai.ascvd import calculate_pce
from medis.ai.longitudinal_analysis import (
    assess_timeline, analyze_lipid_progression, analyze_bp_progression,
    analyze_diabetes_progression, analyze_symptom_progression,
)
from medis.ai.seasonality import seasonal_bp_screen
from medis.ai.trajectories import build_trajectories, normalize_visits
from medis.ai.visit_patterns import detect_visit_patterns


def visit(identity, day, **measurements):
    return {"visit_id": identity, "date": day, "hospital": str(identity), "measurements": measurements}


class TrajectoryTests(unittest.TestCase):
    def test_breathlessness_and_palpitations_without_chest_pain(self):
        for symptom in ("breathlessness_present", "palpitations"):
            rows = [{**visit("a", "2026-06-01"), "symptoms": {symptom: True}}]
            report = assess_timeline(rows, as_of="2026-06-01")
            self.assertEqual(report["review_priority"], "REVIEW")
            self.assertTrue(report["clinical_flags"][0]["message"])

    def test_falling_but_elevated_ldl_is_improving(self):
        rows = [visit("a", "2026-01-01", ldl_cholesterol=190), visit("b", "2026-06-01", ldl_cholesterol=140)]
        result = analyze_lipid_progression(rows, as_of="2026-06-01")
        self.assertEqual(result["status"], "IMPROVING")
        self.assertNotIn("increased", " ".join(result["observations"]))
        self.assertEqual(result["trajectories"]["ldl_cholesterol"]["delta"], -50)

    def test_glucose_only_diabetes_range(self):
        rows = [visit("a", "2026-01-01", fasting_glucose=98), visit("b", "2026-06-01", fasting_glucose=132)]
        self.assertEqual(analyze_diabetes_progression(rows, as_of="2026-06-01")["status"], "DIABETES_RANGE")

    def test_first_visit_syncope_and_historical_separation(self):
        rows = [{**visit("a", "2026-06-01"), "symptoms": {"syncope": True}}]
        self.assertEqual(analyze_symptom_progression(rows, as_of="2026-06-01")["status"], "ACUTE_WARNING")
        self.assertEqual(analyze_symptom_progression(rows, as_of="2026-11-01")["status"], "HISTORICAL_WARNING")

    def test_missing_bp_is_unknown_and_partial_high_bp_is_not_dropped(self):
        self.assertEqual(analyze_bp_progression([])["status"], "INSUFFICIENT_DATA")
        rows = [visit("a", "2026-06-01", systolic_bp=150)]
        self.assertEqual(analyze_bp_progression(rows, as_of="2026-06-01")["status"], "STAGE_2_RANGE")

    def test_sparse_series_does_not_require_complete_first_and_last_rows(self):
        rows = [visit("a", "2026-01-01", ldl_cholesterol=95), visit("b", "2026-03-01", hba1c=6),
                visit("c", "2026-06-01", ldl_cholesterol=155), visit("d", "2026-07-01", systolic_bp=120)]
        result = assess_timeline(rows[::-1], as_of="2026-07-01")
        self.assertEqual(result["metric_trajectories"]["ldl_cholesterol"]["percent_change"], 63.16)
        self.assertEqual(result["review_priority"], "REVIEW")

    def test_isolated_mid_series_outlier_does_not_create_robust_slope(self):
        rows = [visit(str(i), (date(2026, 1, 1) + timedelta(days=i * 30)).isoformat(), ldl_cholesterol=x)
                for i, x in enumerate([100, 100, 500, 100, 100])]
        result = assess_timeline(rows, as_of="2026-06-01")["metric_trajectories"]["ldl_cholesterol"]
        self.assertEqual(result["slope_per_year"], 0)
        self.assertEqual(result["slope_method"], "theil_sen_daily_medians")

    def test_short_interval_not_annualized(self):
        rows = [visit("a", "2026-01-01", systolic_bp=120), visit("b", "2026-01-02", systolic_bp=148)]
        metric = assess_timeline(rows, as_of="2026-01-02")["metric_trajectories"]["systolic_bp"]
        self.assertIsNone(metric["slope_per_year"])
        self.assertEqual(metric["delta"], 28)

    def test_daily_median_does_not_hide_severe_bp(self):
        rows = [visit("a", "2026-01-01", systolic_bp=110), visit("b", "2026-01-01", systolic_bp=200)]
        report = assess_timeline(rows, as_of="2026-01-01")
        self.assertEqual(report["review_priority"], "URGENT_REVIEW")
        self.assertEqual(report["metric_trajectories"]["systolic_bp"]["latest"], 155)
        self.assertIn("same_day_disagreement", {i["reason"] for i in report["data_quality"]})

    def test_low_hdl_is_reviewable_without_prior_measurements(self):
        report = assess_timeline([visit("a", "2026-06-01", hdl_cholesterol=32)], as_of="2026-06-01")
        self.assertEqual(report["review_priority"], "REVIEW")
        self.assertEqual(report["clinical_flags"][0]["code"], "LOW_RECORDED_HDL")

    def test_future_invalid_duplicate_and_nonfinite_records(self):
        rows = [visit("a", "2026-01-01", systolic_bp=float("nan")), visit("a", "2026-01-01"),
                visit("b", "bad", systolic_bp=200), visit("c", "2030-01-01", systolic_bp=200)]
        report = assess_timeline(rows, as_of="2026-06-01")
        self.assertEqual(report["review_priority"], "INSUFFICIENT_DATA")
        self.assertEqual(len(report["data_quality"]), 4)
        json.dumps(report, allow_nan=False)

    def test_stale_and_single_measurement_cannot_imply_low_risk(self):
        stale = assess_timeline([visit("a", "2020-01-01", systolic_bp=120)], as_of="2026-06-01")
        single = assess_timeline([visit("a", "2026-06-01", systolic_bp=120)], as_of="2026-06-01")
        self.assertEqual(stale["review_priority"], "INSUFFICIENT_DATA")
        self.assertEqual(single["review_priority"], "INSUFFICIENT_DATA")
        self.assertIsNone(single["absolute_risk"]["risk_percent"])

    def test_declared_incompatible_units_are_rejected(self):
        row = {**visit("a", "2026-06-01", ldl_cholesterol=4), "measurement_units": {"ldl_cholesterol": "mmol/L"}}
        result = assess_timeline([row], as_of="2026-06-01")
        self.assertEqual(result["metric_trajectories"]["ldl_cholesterol"]["count"], 0)

    def test_linear_slope_respects_elapsed_time(self):
        rows = [visit("a", "2025-01-01", systolic_bp=110), visit("b", "2025-04-11", systolic_bp=120),
                visit("c", "2025-10-28", systolic_bp=140)]
        metric = assess_timeline(rows, as_of="2025-10-28")["metric_trajectories"]["systolic_bp"]
        self.assertAlmostEqual(metric["slope_per_year"], 36.525)


class AbsoluteRiskTests(unittest.TestCase):
    def inputs(self, **changes):
        return dict(model_sex="Female", cohort="White", age=55, total_cholesterol=213,
                    hdl_cholesterol=50, systolic_bp=120, bp_treated=False, diabetes=False,
                    current_smoker=False, known_ascvd=False, snapshot_date="2026-01-01") | changes

    def test_all_four_published_table_a_examples(self):
        for sex, cohort, expected in [("Female", "White", 2.1), ("Female", "Black", 3.0), ("Male", "White", 5.3), ("Male", "Black", 6.1)]:
            with self.subTest(sex=sex, cohort=cohort):
                result = calculate_pce(self.inputs(model_sex=sex, cohort=cohort), as_of="2026-01-01")
                # Printed coefficients/means and example risks have different rounding.
                # Male/White yields 5.4% from the published coefficients vs 5.3%
                # in Table A. Retain the published coefficients and expose this limit.
                self.assertAlmostEqual(result["risk_percent"], expected, delta=0.11)

    def test_required_flags_are_not_assumed_negative(self):
        result = calculate_pce(self.inputs(bp_treated=None), as_of="2026-01-01")
        self.assertIsNone(result["risk_percent"])
        self.assertIn("bp_treated", result["missing_inputs"])

    def test_out_of_range_unsupported_and_secondary_prevention(self):
        for changes in ({"age": 30}, {"age": 80}, {"systolic_bp": 250}, {"cohort": "Other"},
                        {"known_ascvd": True}, {"snapshot_date": "2030-01-01"}, {"current_smoker": "false"}):
            with self.subTest(changes=changes):
                self.assertIsNone(calculate_pce(self.inputs(**changes), as_of="2026-01-01")["risk_percent"])

    def test_risk_increases_with_diabetes_smoking_and_treatment_context(self):
        baseline = calculate_pce(self.inputs(), as_of="2026-01-01")["risk_percent"]
        for key in ("diabetes", "current_smoker", "bp_treated"):
            self.assertGreater(calculate_pce(self.inputs(**{key: True}), as_of="2026-01-01")["risk_percent"], baseline)


class PatternMethodTests(unittest.TestCase):
    def points(self, seasonal):
        return [{"date": date(2022 + i // 12, i % 12 + 1, 15).isoformat(),
                 "value": 120 + i * .05 + (12 * math.cos(2 * math.pi * (i % 12) / 12) if seasonal else 0)} for i in range(48)]

    def test_annual_signal_requires_out_of_year_improvement(self):
        result = seasonal_bp_screen(self.points(True))
        self.assertEqual(result["status"], "PATTERN")
        self.assertGreater(result["held_out_error_reduction"], .8)

    def test_linear_drift_and_sparse_sampling_are_not_seasonality(self):
        self.assertEqual(seasonal_bp_screen(self.points(False))["status"], "NO_SUPPORTED_PATTERN")
        self.assertEqual(seasonal_bp_screen(self.points(True)[:12])["status"], "NOT_ASSESSABLE")

    def test_same_prescription_combination_is_screened(self):
        row = visit("a", "2026-01-01")
        row["prescriptions"] = [{"prescription_id": "rx", "date": "2026-01-01", "items": [
            {"medicine_name": drug, "duration": "30 days"} for drug in ("Metoprolol", "Diltiazem")]}]
        result = detect_visit_patterns([row], as_of="2026-01-15")
        self.assertIn("PRESCRIPTION_OVERLAP", {f["code"] for f in result["flags"]})

    def test_distant_metabolic_endpoints_are_not_concurrent(self):
        rows = [visit("a", "2020-01-01", bmi=25), visit("b", "2023-01-01", fasting_glucose=98, egfr=100),
                visit("c", "2026-01-01", bmi=29, fasting_glucose=132, egfr=75)]
        result = detect_visit_patterns(rows, as_of="2026-01-01")
        self.assertNotIn("MULTISYSTEM_TREND", {f["code"] for f in result["flags"]})


if __name__ == "__main__":
    unittest.main()
