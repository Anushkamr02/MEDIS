"""2013 PCE reference implementation, intentionally separate from progression.

Source: NHLBI Risk Assessment Work Group report, Tables 4a/4b, pp. 14-15:
https://www.nhlbi.nih.gov/sites/default/files/media/docs/risk-assessment.pdf
The 2026 dyslipidemia guideline prefers PREVENT-ASCVD; this legacy calculator is
available for explicit comparison only and never selected from a patient's name,
nationality, gender, isolated glucose result, or prescription history.
"""
import math

from medis.ai.trajectories import analysis_date, finite_number, parse_date

SOURCE = "https://www.nhlbi.nih.gov/sites/default/files/media/docs/risk-assessment.pdf"
PREVENT = "https://professional.heart.org/en/guidelines-and-statements/prevent-calculator"
# ln age, ln age squared, ln TC, age*TC, ln HDL, age*HDL,
# treated SBP, untreated SBP, age*treated SBP, age*untreated SBP,
# smoking, age*smoking, diabetes, mean, baseline survival.
COEFFICIENTS = {
    ("Female", "White"): (-29.799, 4.884, 13.540, -3.114, -13.578, 3.149, 2.019, 1.957, 0, 0, 7.574, -1.665, .661, -29.18, .9665),
    ("Female", "Black"): (17.114, 0, .940, 0, -18.920, 4.475, 29.291, 27.820, -6.432, -6.087, .691, 0, .874, 86.61, .9533),
    ("Male", "White"): (12.344, 0, 11.853, -2.664, -7.990, 1.769, 1.797, 1.764, 0, 0, 7.837, -1.795, .658, 61.18, .9144),
    ("Male", "Black"): (2.469, 0, .302, 0, -.307, 0, 1.916, 1.809, 0, 0, .549, 0, .645, 19.54, .8954),
}
REQUIRED = ("model_sex", "cohort", "age", "total_cholesterol", "hdl_cholesterol", "systolic_bp",
            "bp_treated", "diabetes", "current_smoker", "known_ascvd", "snapshot_date")


def calculate_pce(inputs=None, *, as_of=None):
    data = inputs or {}
    result = {
        "model": "PCE_2013_LEGACY", "status": "NOT_CALCULATED", "risk_percent": None, "category": None,
        "outcome": "First nonfatal MI, coronary heart disease death, or fatal/nonfatal stroke within 10 years",
        "source": SOURCE, "recommended_model": "PREVENT-ASCVD", "recommended_model_url": PREVENT,
        "limitations": ["2026 ACC/AHA dyslipidemia guidance prefers PREVENT-ASCVD for eligible primary prevention.",
                        "This is a legacy population estimate, not an exact individual prognosis or an acute chest-pain assessment.",
                        "Published rounded coefficients are used; displayed estimates can differ by 0.1 percentage point from printed examples.",
                        "PCE cohorts were US Black and White adults; calibration for other populations, including South Asian patients, is uncertain.",
                        "No treatment or statin dose is selected automatically."],
        "missing_inputs": [key for key in REQUIRED if data.get(key) is None],
    }
    if result["missing_inputs"]:
        result["reason"] = "Explicit clinician-confirmed risk inputs are required; missing values are not assumed negative."
        return result
    for key in ("bp_treated", "diabetes", "current_smoker", "known_ascvd"):
        if type(data[key]) is not bool:
            result.update(status="INVALID_INPUT", reason=f"{key} must be true or false")
            return result
    if data["known_ascvd"] or (data["model_sex"], data["cohort"]) not in COEFFICIENTS:
        result.update(status="NOT_APPLICABLE", reason="Requires no known ASCVD and an explicitly selected supported model sex/cohort; no automatic cohort substitution.")
        return result
    for key, low, high in (("age", 40, 79), ("total_cholesterol", 130, 320), ("hdl_cholesterol", 20, 100), ("systolic_bp", 90, 200)):
        if not finite_number(data[key]) or not low <= data[key] <= high:
            result.update(status="OUT_OF_RANGE", reason=f"{key} must be in [{low}, {high}]; values are not clamped")
            return result
    snapshot, cutoff = parse_date(data["snapshot_date"]), analysis_date(as_of)
    if snapshot is None or snapshot > cutoff or (cutoff - snapshot).days > 365:
        result.update(status="INVALID_SNAPSHOT", reason="Use an explicitly confirmed snapshot dated within the last 365 days, not a future date.")
        return result
    if data["hdl_cholesterol"] >= data["total_cholesterol"]:
        result.update(status="INVALID_INPUT", reason="HDL must be lower than total cholesterol")
        return result
    age, tc, hdl, sbp = [math.log(data[k]) for k in ("age", "total_cholesterol", "hdl_cholesterol", "systolic_bp")]
    treated, smoking, diabetes = [int(data[k]) for k in ("bp_treated", "current_smoker", "diabetes")]
    values = (age, age * age, tc, age * tc, hdl, age * hdl, treated * sbp, (1 - treated) * sbp,
              age * treated * sbp, age * (1 - treated) * sbp, smoking, age * smoking, diabetes)
    coefficients = COEFFICIENTS[(data["model_sex"], data["cohort"])]
    linear = sum(c * x for c, x in zip(coefficients[:13], values))
    risk = 100 * -math.expm1(math.log(coefficients[-1]) * math.exp(linear - coefficients[-2]))
    category = "LOW" if risk < 5 else "BORDERLINE" if risk < 7.5 else "INTERMEDIATE" if risk < 20 else "HIGH"
    result.update(status="CALCULATED", risk_percent=round(risk, 1), category=category,
                  inputs={**data, "snapshot_date": snapshot.isoformat()}, reason="Legacy PCE comparison only; not the longitudinal review priority.")
    return result
