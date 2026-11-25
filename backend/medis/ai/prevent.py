"""2023 PREVENT base model, 10-year risk, kept separate from progression.

Source: Khan SS, Matsushita K, Sang Y, et al. "Development and Validation of
the American Heart Association's PREVENT Equations." Circulation.
2024;149(6):430-449 (published online 2023), base-model coefficients from the
supplemental tables. Calculator:
https://professional.heart.org/en/guidelines-and-statements/prevent-calculator

Like medis.ai.ascvd, this calculator is only ever run on inputs a clinician
confirmed. Nothing is inferred from a name, nationality, prescription history
or an isolated laboratory result, and no input is silently clamped: a value
outside the model's range gives a status, not a number.

The base model needs age, sex, total cholesterol, HDL, systolic BP, diabetes,
smoking, eGFR, blood-pressure treatment and statin use; heart failure also
needs BMI. The three optional PREVENT variables (UACR, HbA1c, social
deprivation index) are not implemented, so the model name says "BASE".
"""
import math

from medis.ai.trajectories import analysis_date, finite_number, parse_date

SOURCE = "https://professional.heart.org/en/guidelines-and-statements/prevent-calculator"
PAPER = "Circulation. 2024;149(6):430-449"
MODEL = "PREVENT_2023_BASE_10YR"

# Outcome -> sex -> coefficients, in the published term order. Terms are named
# so the linear predictor below reads like the publication's equation.
#   age     = (age - 55) / 10
#   nonhdl  = non-HDL cholesterol in mmol/L, minus 3.5
#   hdl     = (HDL in mmol/L - 1.3) / 0.3
#   sbp_low = (min(SBP, 110) - 110) / 20
#   sbp     = (max(SBP, 110) - 130) / 20
#   egfr_low = (min(eGFR, 60) - 60) / -15
#   egfr    = (max(eGFR, 60) - 90) / -15
#   bmi_low = (min(BMI, 30) - 25) / 5
#   bmi     = (max(BMI, 30) - 30) / 5
COEFFICIENTS = {
    "total_cvd": {
        "Female": {
            "intercept": -3.307728, "age": 0.7939329, "nonhdl": 0.0305239, "hdl": -0.1606857,
            "sbp_low": -0.2394003, "sbp": 0.360078, "diabetes": 0.8667604, "smoking": 0.5360739,
            "egfr_low": 0.6045917, "egfr": 0.0433769, "bp_treated": 0.3151672, "statin": -0.1477655,
            "bp_treated_sbp": -0.0663612, "statin_nonhdl": 0.1197879, "age_nonhdl": -0.0819715,
            "age_hdl": 0.0306769, "age_sbp": -0.0946348, "age_diabetes": -0.27057,
            "age_smoking": -0.078715, "age_egfr_low": -0.1637806,
        },
        "Male": {
            "intercept": -3.031168, "age": 0.7688528, "nonhdl": 0.0736174, "hdl": -0.0954431,
            "sbp_low": -0.4347345, "sbp": 0.3362658, "diabetes": 0.7692857, "smoking": 0.4386871,
            "egfr_low": 0.5378979, "egfr": 0.0164827, "bp_treated": 0.288879, "statin": -0.1337349,
            "bp_treated_sbp": -0.0475924, "statin_nonhdl": 0.150273, "age_nonhdl": -0.0517874,
            "age_hdl": 0.0191169, "age_sbp": -0.1049477, "age_diabetes": -0.2251948,
            "age_smoking": -0.0895067, "age_egfr_low": -0.1543702,
        },
    },
    "ascvd": {
        "Female": {
            "intercept": -3.819975, "age": 0.719883, "nonhdl": 0.1176967, "hdl": -0.151185,
            "sbp_low": -0.0835358, "sbp": 0.3592852, "diabetes": 0.8348585, "smoking": 0.4831078,
            "egfr_low": 0.4864619, "egfr": 0.0397779, "bp_treated": 0.2265309, "statin": -0.0592374,
            "bp_treated_sbp": -0.0395762, "statin_nonhdl": 0.0844423, "age_nonhdl": -0.0567839,
            "age_hdl": 0.0325692, "age_sbp": -0.1035985, "age_diabetes": -0.2417542,
            "age_smoking": -0.0791142, "age_egfr_low": -0.1671492,
        },
        "Male": {
            "intercept": -3.500655, "age": 0.7099847, "nonhdl": 0.1658663, "hdl": -0.1144285,
            "sbp_low": -0.2837212, "sbp": 0.3239977, "diabetes": 0.7189597, "smoking": 0.3956973,
            "egfr_low": 0.3690075, "egfr": 0.0203619, "bp_treated": 0.2036522, "statin": -0.0865581,
            "bp_treated_sbp": -0.0322916, "statin_nonhdl": 0.114563, "age_nonhdl": -0.0300005,
            "age_hdl": 0.0232747, "age_sbp": -0.0927024, "age_diabetes": -0.2018525,
            "age_smoking": -0.0970527, "age_egfr_low": -0.1217081,
        },
    },
    "heart_failure": {
        "Female": {
            "intercept": -4.310409, "age": 0.8998235, "sbp_low": -0.4559771, "sbp": 0.3576505,
            "diabetes": 1.038346, "smoking": 0.583916, "bmi_low": -0.0072294, "bmi": 0.2997706,
            "egfr_low": 0.7451638, "egfr": 0.0557087, "bp_treated": 0.3534442,
            "bp_treated_sbp": -0.0981511, "age_sbp": -0.0946663, "age_diabetes": -0.3581041,
            "age_smoking": -0.1159453, "age_bmi": -0.003878, "age_egfr_low": -0.1884289,
        },
        "Male": {
            "intercept": -3.946391, "age": 0.8972642, "sbp_low": -0.6811466, "sbp": 0.3634461,
            "diabetes": 0.923776, "smoking": 0.5023736, "bmi_low": -0.0485841, "bmi": 0.3726929,
            "egfr_low": 0.6926917, "egfr": 0.0251827, "bp_treated": 0.2980922,
            "bp_treated_sbp": -0.0497731, "age_sbp": -0.1289201, "age_diabetes": -0.3040924,
            "age_smoking": -0.1401688, "age_bmi": 0.0068126, "age_egfr_low": -0.1797778,
        },
    },
}

OUTCOME_LABELS = {
    "total_cvd": "Total cardiovascular disease (ASCVD or heart failure) within 10 years",
    "ascvd": "Atherosclerotic cardiovascular disease within 10 years",
    "heart_failure": "Heart failure within 10 years",
}

# Confirmed for every outcome.
REQUIRED = ("model_sex", "age", "systolic_bp", "diabetes", "current_smoker", "egfr",
            "bp_treated", "known_ascvd", "snapshot_date")
# Extra inputs per outcome, and the ranges the model was fitted in.
LIPID_INPUTS = ("total_cholesterol", "hdl_cholesterol", "statin")
RANGES = {"age": (30, 79), "systolic_bp": (90, 200), "egfr": (15, 150),
          "total_cholesterol": (130, 320), "hdl_cholesterol": (20, 100), "bmi": (18.5, 39.9)}
BOOLEANS = ("bp_treated", "diabetes", "current_smoker", "known_ascvd", "statin")

MG_DL_TO_MMOL = 0.02586  # cholesterol, as used by the published equations

LIMITATIONS = [
    "PREVENT was developed in US cohorts; calibration for other populations, including South "
    "Asian and Indian patients, is not established.",
    "It estimates risk for a population like this patient, not an individual prognosis, and it "
    "is not an assessment of chest pain happening now.",
    "It applies to adults aged 30-79 without known cardiovascular disease.",
    "This is the base model. The optional PREVENT variables (urine albumin-to-creatinine ratio, "
    "HbA1c, social deprivation index) are not used here.",
    "No treatment, statin or dose is selected automatically.",
]


def _terms(data):
    """The published transformed predictors, from confirmed values."""
    age = (data["age"] - 55) / 10
    sbp = data["systolic_bp"]
    egfr = data["egfr"]
    terms = {
        "intercept": 1.0,
        "age": age,
        "sbp_low": (min(sbp, 110) - 110) / 20,
        "sbp": (max(sbp, 110) - 130) / 20,
        "diabetes": float(data["diabetes"]),
        "smoking": float(data["current_smoker"]),
        "egfr_low": (min(egfr, 60) - 60) / -15,
        "egfr": (max(egfr, 60) - 90) / -15,
        "bp_treated": float(data["bp_treated"]),
    }
    terms["bp_treated_sbp"] = terms["bp_treated"] * terms["sbp"]
    terms["age_sbp"] = age * terms["sbp"]
    terms["age_diabetes"] = age * terms["diabetes"]
    terms["age_smoking"] = age * terms["smoking"]
    terms["age_egfr_low"] = age * terms["egfr_low"]

    if data.get("total_cholesterol") is not None and data.get("hdl_cholesterol") is not None:
        non_hdl = MG_DL_TO_MMOL * (data["total_cholesterol"] - data["hdl_cholesterol"]) - 3.5
        hdl = (MG_DL_TO_MMOL * data["hdl_cholesterol"] - 1.3) / 0.3
        terms.update({"nonhdl": non_hdl, "hdl": hdl, "statin": float(data.get("statin") or False)})
        terms["statin_nonhdl"] = terms["statin"] * non_hdl
        terms["age_nonhdl"] = age * non_hdl
        terms["age_hdl"] = age * hdl

    if data.get("bmi") is not None:
        bmi = data["bmi"]
        terms["bmi_low"] = (min(bmi, 30) - 25) / 5
        terms["bmi"] = (max(bmi, 30) - 30) / 5
        terms["age_bmi"] = age * terms["bmi"]
    return terms


def _risk(outcome, sex, terms):
    coefficients = COEFFICIENTS[outcome][sex]
    if any(name not in terms for name in coefficients):
        return None  # an input this outcome needs was not confirmed
    linear = sum(value * terms[name] for name, value in coefficients.items())
    return round(100 / (1 + math.exp(-linear)), 1)


def _out_of_range(data, keys):
    for key in keys:
        if data.get(key) is None:
            continue
        low, high = RANGES[key]
        if not finite_number(data[key]) or not low <= data[key] <= high:
            return f"{key} must be in [{low}, {high}]; values are not clamped"
    return None


def calculate_prevent(inputs=None, *, as_of=None):
    """10-year PREVENT base-model risks from clinician-confirmed inputs.

    Returns a result dict whose `status` is one of NOT_CALCULATED (an input is
    missing), INVALID_INPUT, OUT_OF_RANGE, INVALID_SNAPSHOT, NOT_APPLICABLE
    (known ASCVD, outside the age range or unsupported sex) or CALCULATED.
    `risks` holds only the outcomes whose inputs were confirmed and in range;
    `unavailable` says which outcome was skipped and why.
    """
    data = inputs or {}
    result = {
        "model": MODEL, "status": "NOT_CALCULATED", "risks": {}, "unavailable": {},
        "outcomes": OUTCOME_LABELS, "source": SOURCE, "paper": PAPER,
        "limitations": list(LIMITATIONS),
        "missing_inputs": [key for key in REQUIRED if data.get(key) is None],
    }
    if result["missing_inputs"]:
        result["reason"] = ("Explicit clinician-confirmed inputs are required; missing values are "
                           "not assumed negative or normal.")
        return result
    for key in BOOLEANS:
        if data.get(key) is not None and type(data[key]) is not bool:
            result.update(status="INVALID_INPUT", reason=f"{key} must be true or false")
            return result
    if data["known_ascvd"] or data["model_sex"] not in ("Female", "Male"):
        result.update(status="NOT_APPLICABLE",
                      reason=("PREVENT applies to adults without known cardiovascular disease, and "
                              "needs an explicitly selected model sex. No number is estimated here."))
        return result

    problem = _out_of_range(data, [key for key in RANGES if key in ("age", "systolic_bp", "egfr")])
    if problem:
        result.update(status="OUT_OF_RANGE", reason=problem)
        return result

    snapshot, cutoff = parse_date(data["snapshot_date"]), analysis_date(as_of)
    if snapshot is None or snapshot > cutoff or (cutoff - snapshot).days > 365:
        result.update(status="INVALID_SNAPSHOT",
                      reason="Use an explicitly confirmed snapshot dated within the last 365 days, not a future date.")
        return result

    # A lipid or BMI value that is missing or outside the fitted range removes
    # the outcomes that need it, rather than the whole result.
    data = dict(data)
    for keys, outcomes, note in (
        (LIPID_INPUTS, ("total_cvd", "ascvd"), "total cholesterol, HDL and statin use"),
        (("bmi",), ("heart_failure",), "BMI between 18.5 and 39.9"),
    ):
        missing = [key for key in keys if data.get(key) is None]
        range_problem = _out_of_range(data, [key for key in keys if key in RANGES])
        if missing or range_problem:
            for key in keys:
                data[key] = None
            for outcome in outcomes:
                result["unavailable"][outcome] = (
                    range_problem or f"Confirm {note} to estimate this outcome.")

    terms = _terms(data)
    sex = data["model_sex"]
    for outcome in COEFFICIENTS:
        if outcome in result["unavailable"]:
            continue
        risk = _risk(outcome, sex, terms)
        if risk is None:
            result["unavailable"][outcome] = "An input this outcome needs was not confirmed."
        else:
            result["risks"][outcome] = risk

    if not result["risks"]:
        result["reason"] = "No outcome had all of its inputs confirmed and in range."
        return result
    result.update(
        status="CALCULATED",
        category=category(result["risks"].get("ascvd")),
        inputs={**data, "snapshot_date": snapshot.isoformat()},
        reason="PREVENT base-model comparison only; not the longitudinal review priority.",
    )
    return result


def category(ascvd_risk):
    """The 2018/2019 ACC-AHA risk bands, applied to the ASCVD estimate."""
    if ascvd_risk is None:
        return None
    return ("LOW" if ascvd_risk < 5 else "BORDERLINE" if ascvd_risk < 7.5
            else "INTERMEDIATE" if ascvd_risk < 20 else "HIGH")
