"""Concise clinical narratives assembled from recorded facts, without inference."""
import json
import math
import re
from datetime import date

FORMAT = "clinical-highlights-v1"
_IDENTIFIERS = re.compile(r"\b(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|MEDIS-[A-Z0-9-]+|TEST-[A-Z0-9-]+)\b", re.I)
_SYMPTOMS = {"chest_pain": "chest pain", "breathlessness": "breathlessness", "palpitations": "palpitations",
             "dizziness": "dizziness", "sweating": "sweating", "fatigue": "fatigue", "syncope": "syncope"}


def _clean(value):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", _IDENTIFIERS.sub("", value)).strip(" .;,:-?")


def _phrases(value):
    """Read text values without exposing JSON or treating negative flags as symptoms."""
    if isinstance(value, str):
        if value.lstrip().startswith(("{", "[")):
            try:
                return _phrases(json.loads(value))
            except (ValueError, TypeError):
                return []
        text = _clean(value)
        return [text] if text else []
    if isinstance(value, dict):
        return [phrase for item in value.values() for phrase in _phrases(item)]
    if isinstance(value, list):
        return [phrase for item in value for phrase in _phrases(item)]
    return []


def _unique(values, maximum=3):
    result, seen = [], set()
    for value in values:
        key = value.casefold()
        if value and key not in seen and len(value.split()) <= 20:
            result.append(value)
            seen.add(key)
        if len(result) == maximum:
            break
    return result


def _join(items):
    if len(items) < 2:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _day(value):
    try:
        return date.fromisoformat(str(value)[:10]).strftime("%d %b %Y")
    except ValueError:
        return ""


def _bmi(value):
    try:
        number = float(value)
        return f"{number:g}" if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError):
        return None


def summarize_records(source):
    visits = sorted(source.get("recent_consultations") or [], key=lambda v: v.get("date") or "", reverse=True)
    completed = [v for v in visits if v.get("status") == "completed"]
    drafts = [v for v in visits if v.get("status") == "pending"]
    other = len(visits) - len(completed) - len(drafts)
    counts = []
    if completed:
        counts.append(f"{len(completed)} completed consultation{'s' if len(completed) != 1 else ''}")
    if drafts:
        counts.append(f"{len(drafts)} pending draft consultation{'s' if len(drafts) != 1 else ''}")
    if other:
        counts.append(f"{other} other recorded consultation{'s' if other != 1 else ''}")
    intro = "The available history includes " + _join(counts) + "." if counts else "No consultation findings are currently recorded."

    closing = []
    bmi_visit = next((v for v in visits if _bmi(v.get("bmi"))), None)
    bmi = _bmi(bmi_visit.get("bmi")) if bmi_visit else _bmi(source.get("profile_bmi"))
    if bmi:
        when = _day(bmi_visit.get("date")) if bmi_visit else ""
        closing.append(f"The latest recorded BMI is {bmi}" + (f" on {when}" if when else "") +
                       (", documented in a draft." if bmi_visit and bmi_visit.get("status") == "pending" else "."))
    if drafts:
        draft = drafts[0]
        complaints = draft.get("complaints") or {}
        main = _clean(complaints.get("main_complaint")) if isinstance(complaints, dict) else _clean(complaints)
        detail = _unique([main], 1)
        closing.append(("The latest draft records " + detail[0] + "; its findings and diagnosis remain unfinalized.")
                       if detail else "Draft findings and diagnoses remain unfinalized.")

    candidates = []
    conditions = (source.get("patient") or {}).get("known_conditions") or {}
    if isinstance(conditions, dict):
        conditions = [key.replace("_", " ") for key, value in conditions.items()
                      if value is True or (isinstance(value, str) and value.strip().lower() in ("yes", "true"))]
    else:
        conditions = _phrases(conditions)
    conditions += _phrases((source.get("patient") or {}).get("recorded_conditions"))
    conditions = _unique([_clean(item) for item in conditions])
    if conditions:
        candidates.append("The recorded medical history includes " + _join(conditions) + ".")
    chief, symptoms = [], []
    for visit in completed:
        complaints = visit.get("complaints") or {}
        if isinstance(complaints, dict):
            chief.extend(_phrases(complaints.get("main_complaint")))
            chief.extend(_phrases(complaints.get("other_symptoms")))
            symptoms.extend(label for key, label in _SYMPTOMS.items() if complaints.get(key) is True or complaints.get(key) == "yes")
        else:
            chief.extend(_phrases(complaints))
    symptoms = [symptom for symptom in symptoms if not any(symptom.casefold() in phrase.casefold() for phrase in chief)]
    complaints = _unique(chief + symptoms, 4)
    if complaints:
        candidates.append("Completed visits document " + _join(complaints) + ".")
    diagnoses = _unique([_clean(v.get("diagnosis")) for v in completed])
    diagnoses = [diagnosis for diagnosis in diagnoses if diagnosis.casefold() not in {condition.casefold() for condition in conditions}]
    if diagnoses:
        candidates.append("Recorded diagnoses include " + _join(diagnoses) + ".")
    if completed:
        latest = completed[0]
        findings = _unique(_phrases(latest.get("observations")), 2)
        if findings:
            candidates.append("At the latest completed visit, examination documented " + _join(findings) + ".")
        notes = _unique(_phrases(latest.get("doctor_notes")), 1)
        if notes and notes[0].casefold() not in {finding.casefold() for finding in findings}:
            candidates.append("The latest completed consultation notes " + notes[0] + ".")
        vitals = []
        if latest.get("systolic_bp") is not None and latest.get("diastolic_bp") is not None:
            vitals.append(f"blood pressure {latest['systolic_bp']}/{latest['diastolic_bp']} mmHg")
        if latest.get("heart_rate") is not None:
            vitals.append(f"heart rate {latest['heart_rate']} bpm")
        if vitals:
            candidates.append("Recorded measurements were " + _join(vitals) + ".")
    medicines = _unique([_clean(m.get("name")) for m in source.get("current_medications") or []])
    if medicines:
        candidates.append("Current recorded medicines include " + _join(medicines) + ".")

    selected = [intro]
    for sentence in candidates:
        if len(" ".join(selected + [sentence] + closing).split()) <= 100:
            selected.append(sentence)
    overview = selected.pop(0)
    if conditions and selected and selected[0].startswith("The recorded medical history includes "):
        overview += " " + selected.pop(0)
    # Keep major findings easy to scan and always retain BMI and draft status.
    points = selected[:max(0, 6 - len(closing))] + closing
    return {"format": FORMAT, "overview": overview, "key_points": points, "changes": [], "review_points": [],
            "data_gaps": [], "unverified_numbers": []}
