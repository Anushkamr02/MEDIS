"""Maps MEDIS Supabase rows to the input formats of the teammate's medis package."""
import math
from datetime import date

from medis.ai.trajectories import METRICS

# report_extraction field name -> our consultation column
EXTRACTED_TO_COLUMN = {
    "total_chol": "total_cholesterol",
    "ldl": "ldl_cholesterol",
    "hdl": "hdl_cholesterol",
    "triglycerides": "triglycerides",
    "fasting_glucose": "fasting_glucose",
    "hba1c": "hba1c",
    "creatinine": "serum_creatinine",
    "egfr": "egfr",
    "bp_sys": "systolic_bp",
    "bp_dia": "diastolic_bp",
    "bmi": "bmi",
}
UNITS = {**{key: spec[0] for key, spec in METRICS.items()}, "bmi": "kg/m2"}


def number(value):
    """PostgREST may return numeric columns as strings; blanks stay None (never 0)."""
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


YES_NO = {"yes": True, "no": False}
CHEST_PAIN_TYPES = {"typical": "Typical Angina", "atypical": "Atypical Angina", "non_anginal": "Non-Anginal"}
PAIN_RADIATION = {"none": "None", "left_arm": "Left arm", "jaw": "Jaw", "back": "Back", "both_arms": "Both arms"}


def _symptoms(complaints):
    c = complaints or {}
    pain = c.get("chest_pain") == "yes"
    breathless = bool(c.get("breathlessness"))
    # Unticked checkboxes mean "not recorded", not "absent", so only a tick
    # becomes True. Chest pain and syncope have explicit yes/no selects; the
    # pain details and NYHA class only count when their symptom is present.
    symptoms = {
        "chief_complaint": (c.get("main_complaint") or "").strip() or None,
        "chest_pain_present": YES_NO.get(c.get("chest_pain")),
        "chest_pain_severity": number(c.get("pain_severity")) if pain else None,
        "chest_pain_type": CHEST_PAIN_TYPES.get(c.get("chest_pain_type")) if pain else None,
        "chest_pain_radiation": PAIN_RADIATION.get(c.get("pain_radiation")) if pain else None,
        "chest_pain_at_rest": YES_NO.get(c.get("pain_at_rest")) if pain else None,
        "breathlessness_present": True if breathless else None,
        "breathlessness_nyha_class": f"Class {c['nyha_class']}" if breathless and c.get("nyha_class") else None,
        "palpitations": True if c.get("palpitations") else None,
        "syncope": YES_NO.get(c.get("syncope")),
    }
    return {k: v for k, v in symptoms.items() if v is not None}


def _prescriptions(rows):
    return [{
        "prescription_id": rx["id"],
        "date": (rx.get("issued_at") or "")[:10] or None,
        "items": [{"medicine_name": m.get("name"), "dosage": m.get("dosage"),
                   "frequency": m.get("frequency"), "duration": m.get("duration")}
                  for m in (rx.get("medicines") or [])],
    } for rx in rows]


def consultations_to_visits(consultations, prescriptions, draft_values=None):
    """Supabase consultations (+ hospitals(name)) -> assess_timeline visit dicts.

    draft_values: {consultation_id: {column: value}} overrides for a visit being
    edited, so the doctor sees how today's unsaved numbers change the trend.
    """
    by_consultation = {}
    for rx in prescriptions:
        if rx.get("consultation_id"):
            by_consultation.setdefault(rx["consultation_id"], []).append(rx)

    visits = []
    for c in consultations:
        values = {**c, **(draft_values or {}).get(c["id"], {})}
        visits.append({
            "visit_id": c.get("visit_id") or c["id"],
            "date": (c.get("consultation_date") or date.today().isoformat())[:10],
            "hospital": (c.get("hospitals") or {}).get("name"),
            "hospital_id": c.get("hospital_id"),
            "measurements": {key: number(values.get(key)) for key in METRICS},
            "symptoms": _symptoms(values.get("complaints")),
            "prescriptions": _prescriptions(by_consultation.get(c["id"], [])),
        })
    return visits


def extracted_to_rows(extraction):
    """report_extraction.extract_fields output -> rows the doctor verifies."""
    fields, sources = extraction["fields"], extraction["source_lines"]
    return [{"column": column, "value": round(fields[field], 2), "unit": UNITS.get(column),
             "source_text": sources.get(field)}
            for field, column in EXTRACTED_TO_COLUMN.items() if field in fields]


MAX_SAVED_SAMPLES = 1000  # per lead: a 10 s digital recording at 100 Hz is exactly this


def _thin(signals):
    """Keeps every lead's waveform for the graph, evenly thinned if longer than MAX_SAVED_SAMPLES."""
    thinned = {}
    for lead, values in (signals or {}).items():
        step = max(1, math.ceil(len(values) / MAX_SAVED_SAMPLES))
        thinned[lead] = values[::step]
    return thinned


def compact_lead_samples(result):
    """Waveform arrays sized for saving: digital recordings stay complete,
    long digitised printouts are thinned (the graph looks the same)."""
    slim = dict(result)
    if "lead_signals" in slim:
        slim["lead_signals"] = _thin(slim["lead_signals"])
    if isinstance(slim.get("digitization"), dict) and "lead_signals" in slim["digitization"]:
        slim["digitization"] = {**slim["digitization"], "lead_signals": _thin(slim["digitization"]["lead_signals"])}
    return slim
