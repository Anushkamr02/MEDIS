"""2023 PREVENT base model against published worked examples.

The expected percentages are the reference values of the equations as
published with Khan SS et al., Circulation. 2024;149(6):430-449 (base model,
10-year), i.e. the values the AHA PREVENT calculator and the reference
implementations produce for these inputs.
"""
import unittest
from datetime import date

from medis.ai.prevent import calculate_prevent

AS_OF = date(2026, 11, 25)
SNAPSHOT = "2026-11-01"


def confirmed(**overrides):
    """A complete, clinician-confirmed snapshot; tests override one field at a time."""
    return {"model_sex": "Female", "age": 45, "total_cholesterol": 200, "hdl_cholesterol": 60,
            "systolic_bp": 120, "diabetes": True, "current_smoker": False, "bmi": 25, "egfr": 95,
            "bp_treated": False, "statin": False, "known_ascvd": False,
            "snapshot_date": SNAPSHOT, **overrides}


class WorkedExampleTests(unittest.TestCase):
    def test_female_45_base_model_matches_the_published_values(self):
        result = calculate_prevent(confirmed(), as_of=AS_OF)
        self.assertEqual(result["status"], "CALCULATED")
        self.assertEqual(result["risks"], {"total_cvd": 3.4, "ascvd": 2.1, "heart_failure": 1.7})
        self.assertEqual(result["category"], "LOW")
        self.assertEqual(result["unavailable"], {})

    def test_male_75_on_treatment_matches_the_published_values(self):
        result = calculate_prevent(confirmed(
            model_sex="Male", age=75, total_cholesterol=240, hdl_cholesterol=90, systolic_bp=130,
            diabetes=False, bmi=30, egfr=105, bp_treated=True, statin=True), as_of=AS_OF)
        self.assertEqual(result["risks"], {"total_cvd": 18.2, "ascvd": 10.6, "heart_failure": 12.7})
        # The band follows the ASCVD estimate: 10.6% is intermediate (7.5-19.9%).
        self.assertEqual(result["category"], "INTERMEDIATE")

    def test_female_39_without_a_bmi_still_gets_the_lipid_outcomes(self):
        result = calculate_prevent(confirmed(
            age=39, total_cholesterol=190, hdl_cholesterol=50, systolic_bp=110, bmi=None,
            egfr=120), as_of=AS_OF)
        self.assertEqual(result["status"], "CALCULATED")
        self.assertEqual(result["risks"], {"total_cvd": 2.1, "ascvd": 1.3})
        self.assertIn("BMI", result["unavailable"]["heart_failure"])

    def test_male_58_without_hdl_gets_heart_failure_only(self):
        result = calculate_prevent(confirmed(
            model_sex="Male", age=58, total_cholesterol=267, hdl_cholesterol=None, systolic_bp=150,
            diabetes=False, bmi=35, egfr=45, bp_treated=True, statin=None), as_of=AS_OF)
        self.assertEqual(result["risks"], {"heart_failure": 11.0})
        self.assertIn("HDL", result["unavailable"]["ascvd"])
        self.assertIsNone(result["category"])


class GuardTests(unittest.TestCase):
    def test_a_missing_input_is_never_assumed_to_be_negative(self):
        for key in ("model_sex", "age", "systolic_bp", "diabetes", "current_smoker", "egfr",
                    "bp_treated", "known_ascvd", "snapshot_date"):
            with self.subTest(missing=key):
                result = calculate_prevent(confirmed(**{key: None}), as_of=AS_OF)
                self.assertEqual(result["status"], "NOT_CALCULATED")
                self.assertEqual(result["missing_inputs"], [key])
                self.assertEqual(result["risks"], {})

    def test_known_ascvd_and_an_unsupported_sex_are_not_estimated(self):
        for inputs in (confirmed(known_ascvd=True), confirmed(model_sex="Unsupported")):
            with self.subTest(inputs=inputs["model_sex"]):
                result = calculate_prevent(inputs, as_of=AS_OF)
                self.assertEqual(result["status"], "NOT_APPLICABLE")
                self.assertEqual(result["risks"], {})

    def test_values_outside_the_model_range_are_reported_not_clamped(self):
        for overrides in ({"age": 29}, {"age": 80}, {"systolic_bp": 89}, {"systolic_bp": 201}, {"egfr": 0}):
            with self.subTest(**overrides):
                result = calculate_prevent(confirmed(**overrides), as_of=AS_OF)
                self.assertEqual(result["status"], "OUT_OF_RANGE")
                self.assertEqual(result["risks"], {})

    def test_an_out_of_range_lipid_or_bmi_removes_only_its_own_outcomes(self):
        lipids = calculate_prevent(confirmed(total_cholesterol=400), as_of=AS_OF)
        self.assertEqual(set(lipids["risks"]), {"heart_failure"})
        self.assertIn("total_cholesterol", lipids["unavailable"]["ascvd"])

        obese = calculate_prevent(confirmed(bmi=45), as_of=AS_OF)
        self.assertEqual(set(obese["risks"]), {"total_cvd", "ascvd"})
        self.assertIn("bmi", obese["unavailable"]["heart_failure"])

    def test_a_stale_or_future_snapshot_is_rejected(self):
        for snapshot in ("2027-01-01", "2025-01-01", "not-a-date"):
            with self.subTest(snapshot=snapshot):
                result = calculate_prevent(confirmed(snapshot_date=snapshot), as_of=AS_OF)
                self.assertEqual(result["status"], "INVALID_SNAPSHOT")

    def test_yes_no_inputs_must_be_booleans(self):
        result = calculate_prevent(confirmed(diabetes="yes"), as_of=AS_OF)
        self.assertEqual(result["status"], "INVALID_INPUT")

    def test_the_result_never_carries_a_screening_priority(self):
        result = calculate_prevent(confirmed(), as_of=AS_OF)
        self.assertNotIn("review_priority", result)
        self.assertIn("not the longitudinal review priority", result["reason"])
        self.assertTrue(any("South Asian" in note for note in result["limitations"]))


if __name__ == "__main__":
    unittest.main()
