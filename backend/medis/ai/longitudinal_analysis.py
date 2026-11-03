"""Versioned longitudinal screening, independent of absolute ASCVD probability.

Missing observations are unknown. Current abnormal values, temporal direction,
clinical review priority and a legacy population risk estimate are separate outputs.
"""
import json
from datetime import datetime, time, timedelta

from sqlalchemy.orm import Session, selectinload

from medis.ai.ascvd import calculate_pce
from medis.ai.trajectories import (
    METRICS, analysis_date, build_trajectories, finite_number, normalize_visits, parse_date, summarize_metric,
)
from medis.ai.visit_patterns import detect_visit_patterns
from medis.database.models import Patient, Visit, Prescription, ECGResult, LongitudinalAssessment

ENGINE_VERSION = "longitudinal-2.0"


def _group(visits, keys, *, as_of=None, rename=None):
    rows, issues = normalize_visits(visits, as_of=as_of)
    series = {key: summarize_metric(rows, key, as_of=as_of) for key in keys}
    accepted = {key: {(point["date"], e["visit_id"]): e["value"] for point in metric["points"] for e in point["evidence"]}
                for key, metric in series.items()}
    rename = rename or {}
    history = []
    for visit in rows:
        item = {"visit_id": visit["visit_id"], "date": visit["date"], "hospital": visit.get("hospital")}
        for key in keys:
            item[rename.get(key, key)] = accepted[key].get((visit["date"], visit["visit_id"]))
        if any(item[rename.get(k, k)] is not None for k in keys):
            history.append(item)
    observations = []
    for key, metric in series.items():
        if metric["delta"] is None:
            continue
        first, latest = metric["points"][0], metric["points"][-1]
        direction = "increased" if metric["delta"] > 0 else "decreased" if metric["delta"] < 0 else "was unchanged"
        message = (f"{key.replace('_', ' ')} {direction}: {first['value']:g} to {latest['value']:g} {metric['unit']} "
                   f"({metric['delta']:+g}; {metric['percent_change']:+.1f}%) over {metric['span_days']} days "
                   f"({first['date']} to {latest['date']}).")
        if metric["slope_per_year"] is not None:
            message += f" Estimated slope {metric['slope_per_year']:+.2f} {metric['unit']}/year ({metric['slope_method']}); not a forecast."
        if metric["stale"]:
            message += " Latest value is older than 365 days."
        observations.append(message)
    return {"history": history, "trajectories": series, "observations": observations,
            "status": "INSUFFICIENT_DATA", "data_points_count": len(history), "data_quality": issues}


def analyze_lipid_progression(visits_data, *, as_of=None):
    result = _group(visits_data, ("total_cholesterol", "ldl_cholesterol", "hdl_cholesterol", "triglycerides"), as_of=as_of)
    series = result["trajectories"]
    active = [m for m in series.values() if m["count"] and not m["stale"]]
    if not active:
        return result
    adverse = any(m["direction"] == ("DECREASING" if k == "hdl_cholesterol" else "INCREASING")
                  for k, m in series.items() if not m["stale"])
    improving = any(m["direction"] == ("INCREASING" if k == "hdl_cholesterol" else "DECREASING")
                    for k, m in series.items() if not m["stale"])
    ldl = series["ldl_cholesterol"]
    elevated = ldl["latest"] is not None and not ldl["stale"] and ldl["latest"] >= 130
    result["status"] = "DETERIORATING" if adverse else "IMPROVING" if improving else "ELEVATED" if elevated else "NO_FLAGGED_PROGRESSION"
    if elevated:
        result["observations"].append(f"Latest recorded LDL-C is {ldl['latest']:g} mg/dL. Review the patient's prevention category and individualized target; elevated level and trend direction are separate findings.")
    return result


def analyze_bp_progression(visits_data, *, as_of=None):
    result = _group(visits_data, ("systolic_bp", "diastolic_bp"), as_of=as_of,
                    rename={"systolic_bp": "systolic", "diastolic_bp": "diastolic"})
    available = [m for m in result["trajectories"].values() if m["count"] and not m["stale"]]
    if not available:
        return result
    last_day = max(m["points"][-1]["date"] for m in available)
    s, d = [m["latest"] if m["points"] and m["points"][-1]["date"] == last_day else None
            for m in result["trajectories"].values()]
    status = ("SEVERE_BP_RANGE" if (s is not None and s > 180) or (d is not None and d > 120) else
              "STAGE_2_RANGE" if (s is not None and s >= 140) or (d is not None and d >= 90) else
              "STAGE_1_RANGE" if (s is not None and s >= 130) or (d is not None and d >= 80) else
              "INCOMPLETE_BP" if s is None or d is None else "ELEVATED_BP" if s >= 120 else "NO_FLAGGED_PROGRESSION")
    result["status"] = status
    result["observations"].append(f"Latest BP components on {last_day}: systolic {s if s is not None else 'unavailable'}, diastolic {d if d is not None else 'unavailable'} mmHg ({status}). Confirm technique and repeat measurements; this is not a hypertension diagnosis.")
    return result


def analyze_diabetes_progression(visits_data, *, as_of=None):
    result = _group(visits_data, ("fasting_glucose", "hba1c"), as_of=as_of)
    active = {k: m["latest"] for k, m in result["trajectories"].items() if m["count"] and not m["stale"]}
    if not active:
        return result
    glucose, a1c = active.get("fasting_glucose"), active.get("hba1c")
    if (glucose is not None and glucose >= 126) or (a1c is not None and a1c >= 6.5):
        result["status"] = "DIABETES_RANGE"
        result["observations"].append("Available fasting glucose/HbA1c includes a diabetes-range result. Confirm the diagnosis clinically and with repeat testing where indicated; a single result does not establish diabetes type.")
    elif (glucose is not None and glucose >= 100) or (a1c is not None and a1c >= 5.7):
        result["status"] = "PREDIABETES_RANGE"
        result["observations"].append("Available fasting glucose/HbA1c includes a prediabetes-range result; review follow-up testing and prevention measures.")
    else:
        result["status"] = "NO_FLAGGED_PROGRESSION"
    return result


def analyze_symptom_progression(visits_data, *, as_of=None):
    cutoff = analysis_date(as_of)
    rows, issues = normalize_visits(visits_data, as_of=cutoff)
    history = [{"visit_id": v["visit_id"], "date": v["date"], "hospital": v.get("hospital"), **v["symptoms"]}
               for v in rows if any(v["symptoms"].get(k) is not None for k in
                                    ("chest_pain_present", "breathlessness_present", "syncope", "palpitations"))]
    result = dict(history=history, observations=[], status="INSUFFICIENT_DATA", data_points_count=len(history), data_quality=issues)
    if not history:
        return result
    latest = history[-1]
    recent_days = (cutoff - parse_date(latest["date"])).days
    present = latest.get("chest_pain_present") is True
    severity = latest.get("chest_pain_severity")
    radiation = str(latest.get("chest_pain_radiation") or "").strip().casefold()
    radiating = radiation not in {"", "none", "no", "no radiation", "absent", "unknown", "not recorded"} and not radiation.startswith(("no ", "denies "))
    red_flag = latest.get("syncope") is True or (present and (radiating or
                (finite_number(severity) and 7 <= severity <= 10) or latest.get("chest_pain_at_rest") is True))
    if red_flag:
        result["status"] = "ACUTE_WARNING" if recent_days <= 7 else "HISTORICAL_WARNING"
        result["observations"].append(f"Concerning symptom recorded on {latest['date']} (syncope or severe/radiating/rest chest pain). Verify whether it is ongoing; current symptoms require urgent clinical assessment, independent of any 10-year risk score.")
    elif recent_days > 90:
        result["status"] = "HISTORICAL_SYMPTOMS"
        result["observations"].append(f"Last structured symptom assessment is dated {latest['date']}; current symptom status is unknown.")
    else:
        result["status"] = "SYMPTOMATIC" if any(latest.get(k) is True for k in ("chest_pain_present", "breathlessness_present", "palpitations")) else "NO_RECORDED_CURRENT_SYMPTOMS"
        escalations = [f for f in detect_visit_patterns(rows, as_of=cutoff)["flags"] if f["code"] == "SYMPTOM_ESCALATION" and f["evidence"][-1]["date"] == latest["date"]]
        if escalations:
            result["status"] = "WORSENING_SYMPTOMS"
            result["observations"].extend(f["message"] for f in escalations)
        elif result["status"] == "SYMPTOMATIC":
            recorded = [label for key, label in (("chest_pain_present", "chest pain"),
                        ("breathlessness_present", "breathlessness"), ("palpitations", "palpitations"))
                        if latest.get(key) is True]
            result["observations"].append(f"{', '.join(recorded).capitalize()} documented on {latest['date']}; review symptom characteristics and clinical context.")
    return result


def compare_historical_ecgs(visits_data, db: Session = None, patient_id=None, *, as_of=None):
    cutoff = analysis_date(as_of)
    records = [] if db is None or patient_id is None else db.query(ECGResult).filter(
        ECGResult.patient_id == patient_id, ECGResult.recording_date < datetime.combine(cutoff + timedelta(days=1), time.min)
    ).order_by(ECGResult.recording_date.asc(), ECGResult.id.asc()).all()
    history = [{"visit_id": r.visit_id, "date": r.recording_date.date().isoformat(),
                "qtc_interval": r.qtc_interval_ms, "qrs_duration": r.qrs_duration_ms,
                "heart_rate": r.heart_rate, "qa_passed": r.qa_overall_pass is True,
                "inference_status": r.inference_status} for r in records]
    result = dict(history=history, observations=[], status="INSUFFICIENT_DATA", data_points_count=len(history))
    for key, threshold in (("qtc_interval", 460), ("qrs_duration", 120)):
        eligible = [r for r in history if r["qa_passed"] and finite_number(r[key]) and r[key] > 0]
        if not eligible:
            continue
        latest = eligible[-1]
        if (cutoff - parse_date(latest["date"])).days > 365:
            continue
        if result["status"] == "INSUFFICIENT_DATA":
            result["status"] = "NO_FLAGGED_INTERVALS"
        if latest[key] >= threshold:
            baseline = eligible[0][key] if len(eligible) > 1 else "unavailable"
            result["status"] = "INTERVAL_REVIEW"
            result["observations"].append(f"{key} {latest[key]:g} ms on {latest['date']}; baseline {baseline}. Verify trace, measurement quality and clinical context; interval screening cannot establish or exclude ischemia.")
    if result["status"] == "INSUFFICIENT_DATA":
        result["observations"].append("Insufficient recent quality-accepted ECG intervals for comparison; no normal ECG inference is made.")
    return result


def calculate_risk_factor_accumulation(patient, visits_data, *, as_of=None):
    rows, _ = normalize_visits(visits_data, as_of=as_of)
    series = build_trajectories(rows, as_of=as_of)
    factors = []
    if patient.smoking_status == "Current":
        factors.append({"factor": "Current tobacco use", "detail": "Current smoking recorded in profile; verify current status."})
    if patient.family_history_cad:
        factors.append({"factor": "Family history", "detail": "CAD family history recorded; verify relative and age at onset."})
    for key, threshold in (("bmi", 30), ("ldl_cholesterol", 130), ("systolic_bp", 130), ("diastolic_bp", 80), ("hba1c", 5.7), ("fasting_glucose", 100)):
        metric = series[key]
        if metric["count"] and not metric["stale"] and metric["latest"] >= threshold:
            factors.append({"factor": key, "detail": f"{metric['latest']:g} {metric['unit']} on {metric['points'][-1]['date']}; screening finding."})
    return {"accumulated_factors": factors, "total_count": len(factors)}


def assess_timeline(visits_data, *, as_of=None):
    """Pure orchestration used by database reports and regression scenarios."""
    cutoff = analysis_date(as_of)
    rows, quality = normalize_visits(visits_data, as_of=cutoff)
    series = build_trajectories(rows, as_of=cutoff)
    modules = {"lipid_progression": analyze_lipid_progression(rows, as_of=cutoff),
               "bp_progression": analyze_bp_progression(rows, as_of=cutoff),
               "diabetes_progression": analyze_diabetes_progression(rows, as_of=cutoff),
               "symptom_progression": analyze_symptom_progression(rows, as_of=cutoff)}
    flags = []
    for key, metric in series.items():
        quality.extend(metric["rejected"])
        if metric["count"] and metric["stale"]:
            quality.append({"metric": key, "reason": "stale_measurement", "age_days": metric["age_days"]})
        for point in metric["points"]:
            values = [e["value"] for e in point["evidence"]]
            if len(values) > 1 and max(values) - min(values) >= METRICS[key][3]:
                quality.append({"metric": key, "date": point["date"], "reason": "same_day_disagreement", "evidence": point["evidence"]})
        if not metric["count"] or metric["stale"]:
            continue
        adverse_direction = "DECREASING" if key in {"hdl_cholesterol", "egfr"} else "INCREASING"
        if metric["direction"] == adverse_direction:
            flags.append({"code": "ADVERSE_TRAJECTORY", "metric": key, "severity": "REVIEW",
                          "message": f"{key.replace('_', ' ')} shows an adverse recorded trajectory.",
                          "evidence": [metric["points"][0], metric["points"][-1]], "slope_per_year": metric["slope_per_year"]})
        thresholds = {"ldl_cholesterol": 130, "triglycerides": 150, "systolic_bp": 130,
                      "diastolic_bp": 80, "hba1c": 5.7, "fasting_glucose": 100}
        # Preserve extreme same-day observations even when the daily median is lower.
        latest_values = [e["value"] for e in metric["points"][-1]["evidence"]]
        extreme = max(latest_values)
        if key in thresholds and extreme >= thresholds[key]:
            flags.append({"code": "ABNORMAL_RECORDED_VALUE", "metric": key, "severity": "REVIEW",
                          "message": f"Recorded {key.replace('_', ' ')} reaches {extreme:g} {metric['unit']}; verify and review.",
                          "evidence": [metric["points"][-1]]})
        if key == "hdl_cholesterol" and min(latest_values) < 40:
            flags.append({"code": "LOW_RECORDED_HDL", "metric": key, "severity": "REVIEW",
                          "message": "Recorded HDL below 40 mg/dL; review overall cardiovascular context rather than treating this value alone.",
                          "evidence": [metric["points"][-1]]})
        if key in {"systolic_bp", "diastolic_bp"} and extreme > (180 if key == "systolic_bp" else 120) and metric["age_days"] <= 7:
            flags.append({"code": "SEVERE_RECENT_BP", "metric": key, "severity": "URGENT_REVIEW",
                          "message": "Recent severe BP reading: confirm promptly; ongoing chest pain, breathlessness or neurological symptoms require emergency assessment.",
                          "evidence": [metric["points"][-1]]})
    symptoms = modules["symptom_progression"]
    if symptoms["status"] in {"ACUTE_WARNING", "WORSENING_SYMPTOMS", "SYMPTOMATIC", "HISTORICAL_WARNING"}:
        flags.append({"code": symptoms["status"], "severity": "URGENT_REVIEW" if symptoms["status"] == "ACUTE_WARNING" else "REVIEW",
                      "message": symptoms["observations"][-1], "evidence": symptoms["history"][-2:]})
    patterns = detect_visit_patterns(rows, as_of=cutoff)
    flags.extend(f for f in patterns["flags"] if f["code"] == "PRESCRIPTION_OVERLAP")
    recent_metrics = [m for m in series.values() if m["count"] and not m["stale"]]
    trend_ready = [m for m in recent_metrics if m["count"] >= 2 and m["span_days"] >= 30]
    priority = ("URGENT_REVIEW" if any(f["severity"] == "URGENT_REVIEW" for f in flags) else
                "REVIEW" if flags else "INSUFFICIENT_DATA" if not trend_ready else "NO_FLAGGED_PROGRESSION")
    recommendations = []
    if priority == "URGENT_REVIEW":
        recommendations.append("Verify current symptoms and repeat severe measurements promptly. If concerning symptoms are ongoing, use local emergency assessment pathways; do not defer to a 10-year score or routine exercise stress testing.")
    if any(f.get("metric") in {"ldl_cholesterol", "triglycerides"} for f in flags):
        recommendations.append("Review lipid results, secondary causes, medication reconciliation and the appropriate prevention category with the clinician. Select therapy and dose only after clinical assessment.")
    if any(f.get("metric") in {"systolic_bp", "diastolic_bp"} for f in flags):
        recommendations.append("Confirm BP with repeat standardized/home measurements and review the existing treatment plan.")
    if modules["diabetes_progression"]["status"] in {"DIABETES_RANGE", "PREDIABETES_RANGE"}:
        recommendations.append("Review glycemic results and arrange confirmation/follow-up where indicated; do not infer diabetes type or medication need from a single value.")
    if not trend_ready or quality:
        recommendations.append("Review missing, stale or invalid observations and obtain clinically appropriate follow-up measurements before interpreting a trajectory.")
    if patterns["flags"]:
        recommendations.append("Review dated cross-visit evidence and reconcile care across hospitals. Missing refill records do not prove non-adherence.")
    if not recommendations:
        recommendations.append("Continue clinician-directed follow-up; absence of screening flags does not establish low absolute cardiovascular risk.")
    summary = {"URGENT_REVIEW": "Recent concerning observations require prompt assessment of current clinical status.",
               "REVIEW": "Recorded abnormalities or adverse changes require clinical review; see dated evidence.",
               "INSUFFICIENT_DATA": "Insufficient recent measurements across distinct dates to assess longitudinal progression.",
               "NO_FLAGGED_PROGRESSION": "No configured adverse progression rule triggered in the available data. Absolute cardiovascular risk remains a separate assessment."}[priority]
    return {**modules, "engine_version": ENGINE_VERSION, "as_of": cutoff.isoformat(), "metric_trajectories": series,
            "review_priority": priority, "risk_category": priority, "overall_assessment": summary,
            "risk_method": "Date-aware descriptive screening and review priority; not a validated probability or diagnosis.",
            "clinical_flags": flags, "visit_patterns": patterns, "data_quality": quality,
            "coverage": {"valid_visits": len(rows), "recent_metrics": len(recent_metrics), "trend_ready_metrics": len(trend_ready),
                         "minimum_trend_span_days": 30, "stale_after_days": 365},
            "observations": [o for module in modules.values() for o in module["observations"]],
            "recommendations": recommendations, "absolute_risk": calculate_pce(as_of=cutoff),
            "disclaimer": "Descriptive clinical decision support. No model can guarantee or exclude a future heart attack; physician review and population-specific validation are required."}


def generate_longitudinal_cad_report(patient_id: str, db: Session, *, persist: bool = True, as_of=None, risk_inputs=None):
    cutoff = analysis_date(as_of)
    patient = db.query(Patient).filter(Patient.patient_id == patient_id).first()
    if not patient:
        return {"error": f"Patient {patient_id} not found"}
    visits = db.query(Visit).filter(Visit.patient_id == patient_id).options(
        selectinload(Visit.clinical_measurements), selectinload(Visit.symptoms),
        selectinload(Visit.prescriptions).selectinload(Prescription.items)
    ).order_by(Visit.visit_date.asc(), Visit.id.asc()).all()
    rows = []
    duplicate_rows = []
    for visit in visits:
        # Existing services update a single row per visit. If legacy duplicates exist,
        # preserve deterministic selection and expose the ambiguity for reconciliation.
        meas = max(visit.clinical_measurements, key=lambda row: row.id, default=None)
        sym = max(visit.symptoms, key=lambda row: row.id, default=None)
        if len(visit.clinical_measurements) > 1 or len(visit.symptoms) > 1:
            duplicate_rows.append({"visit_id": visit.visit_id, "reason": "multiple_observation_rows_latest_id_selected"})
        rows.append({"visit_id": visit.visit_id, "date": visit.visit_date.isoformat(), "hospital": visit.hospital_name,
                     "hospital_id": visit.hospital_id, "measurements": {k: getattr(meas, k) if meas else None for k in METRICS},
                     "symptoms": {k: getattr(sym, k) for k in ("chief_complaint", "chest_pain_present", "chest_pain_type", "chest_pain_severity",
                         "chest_pain_radiation", "breathlessness_present", "breathlessness_nyha_class", "palpitations", "syncope")} if sym else {},
                     "prescriptions": [{"prescription_id": rx.prescription_id, "date": rx.prescription_date.isoformat() if rx.prescription_date else None,
                         "items": [{"medicine_name": item.medicine_name, "duration": item.duration, "dosage": item.dosage, "frequency": item.frequency} for item in rx.items]}
                         for rx in visit.prescriptions]})
    report = assess_timeline(rows, as_of=cutoff)
    valid_rows, _ = normalize_visits(rows, as_of=cutoff)
    report["data_quality"].extend(duplicate_rows)
    ecg = compare_historical_ecgs(valid_rows, db, patient_id, as_of=cutoff)
    report["ecg_progression"] = ecg
    report["observations"].extend(ecg["observations"])
    if ecg["status"] == "INTERVAL_REVIEW":
        report["clinical_flags"].append({"code": "ECG_INTERVAL_REVIEW", "severity": "REVIEW", "message": "Review recorded ECG intervals.", "evidence": ecg["history"][-2:]})
        if report["review_priority"] != "URGENT_REVIEW":
            report.update(review_priority="REVIEW", risk_category="REVIEW", overall_assessment="Recorded ECG intervals require clinical review; see measurement dates and quality information.")
    factors = calculate_risk_factor_accumulation(patient, valid_rows, as_of=cutoff)
    report["absolute_risk"] = calculate_pce(risk_inputs, as_of=cutoff)
    report.update(patient_id=patient_id, patient_name=patient.full_name, visits_analyzed_count=len(valid_rows),
                  accumulated_risk_factors=factors["accumulated_factors"], assessment_date=cutoff.isoformat(), assessment_id=None)
    if persist:
        record = LongitudinalAssessment(patient_id=patient_id, assessment_date=datetime.combine(cutoff, time.min),
            visits_analyzed_count=len(valid_rows), lipid_progression_json=json.dumps(report["lipid_progression"]),
            bp_progression_json=json.dumps(report["bp_progression"]), diabetes_progression_json=json.dumps(report["diabetes_progression"]),
            ecg_progression_json=json.dumps(ecg), symptom_progression_json=json.dumps({**report["symptom_progression"], "visit_patterns": report["visit_patterns"]}),
            cumulative_risk_factors_json=json.dumps({**factors, "engine_version": ENGINE_VERSION, "absolute_risk": report["absolute_risk"],
                "data_quality": report["data_quality"], "metric_trajectories": report["metric_trajectories"], "clinical_flags": report["clinical_flags"]}),
            longitudinal_risk_category=report["review_priority"], ai_clinical_summary=report["overall_assessment"],
            recommendations_json=json.dumps(report["recommendations"]))
        db.add(record)
        db.commit()
        db.refresh(record)
        report["assessment_id"] = record.id
    return report
