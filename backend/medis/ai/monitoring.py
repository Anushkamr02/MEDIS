"""Continuous monitoring: is the patient's recorded picture improving, stable or worsening?

Compares the newest readings with the ones before them, the review priority with the
previous assessment, structured symptoms across visits, and each recognised medicine's
target metric before and after it was started.

The trend describes recorded values moving toward or away from target. It is not a
diagnosis or a probability, and it is kept separate from the review priority:
the priority asks "is anything concerning?", the trend asks "better or worse than
last time?". Targets and minimum changes are engineering defaults for screening,
to be confirmed clinically (see docs/IMPROVEMENT_PLAN.md, question 2).
"""
from datetime import timedelta

from medis.ai.drug_classes import DRUG_CLASSES, classify
from medis.ai.trajectories import analysis_date, parse_date

MONITORING_VERSION = "monitoring-1.0"

# low/high bound the target range; min_change is the smallest move treated as real
# rather than measurement noise. One source of truth for the UI's target labels too.
TARGETS = {
    "systolic_bp": {"label": "Systolic BP", "high": 130, "target": "< 130", "min_change": 5},
    "diastolic_bp": {"label": "Diastolic BP", "high": 80, "target": "< 80", "min_change": 3},
    "ldl_cholesterol": {"label": "LDL", "high": 100, "target": "< 100", "min_change": 10},
    "hdl_cholesterol": {"label": "HDL", "low": 40, "target": "> 40", "min_change": 3},
    "total_cholesterol": {"label": "Total cholesterol", "high": 200, "target": "< 200", "min_change": 15},
    "triglycerides": {"label": "Triglycerides", "high": 150, "target": "< 150", "min_change": 20},
    "hba1c": {"label": "HbA1c", "high": 5.7, "target": "< 5.7", "min_change": 0.3},
    "fasting_glucose": {"label": "Fasting glucose", "high": 100, "target": "< 100", "min_change": 10},
    "bmi": {"label": "BMI", "low": 18.5, "high": 25, "target": "18.5–25", "min_change": 0.5},
    "serum_creatinine": {"label": "Creatinine", "low": 0.6, "high": 1.2, "high_inclusive": True,
                         "target": "0.6–1.2", "min_change": 0.2},
    "egfr": {"label": "eGFR", "low": 90, "target": "> 90", "min_change": 5},
}
# Metrics that drive the overall trend; the others are reported but do not decide it.
KEY_METRICS = ("systolic_bp", "diastolic_bp", "ldl_cholesterol", "hba1c", "fasting_glucose", "egfr")

PRIORITY_RANK = {"INSUFFICIENT_DATA": 0, "NO_FLAGGED_PROGRESSION": 0, "REVIEW": 1, "URGENT_REVIEW": 2}
SYMPTOM_KEYS = (("chest_pain_present", "chest pain"), ("breathlessness_present", "breathlessness"),
                ("syncope", "fainting"), ("palpitations", "palpitations"))
NYHA = {"I": 1, "II": 2, "III": 3, "IV": 4}
# Prescriptions older than this are not treated as a current course.
TREATMENT_LOOKBACK_DAYS = 365


def _day(value):
    return parse_date(value).strftime("%d %b %Y")


def _num(value):
    return f"{value:g}"


def at_target(key, value):
    spec = TARGETS[key]
    if spec.get("low") is not None and value < spec["low"]:
        return False
    if spec.get("high") is not None:
        return value <= spec["high"] if spec.get("high_inclusive") else value < spec["high"]
    return True


def distance_from_target(key, value):
    """How far a value sits outside the target range (0 inside it)."""
    spec = TARGETS[key]
    if spec.get("low") is not None and value < spec["low"]:
        return spec["low"] - value
    if spec.get("high") is not None and value > spec["high"]:
        return value - spec["high"]
    return 0.0


def _reading(point):
    return {"date": point["date"], "value": point["value"],
            "visit_ids": [e["visit_id"] for e in point.get("evidence", [])]}


def metric_change(key, metric):
    """Latest reading against the one before it, judged by distance from target."""
    spec = TARGETS[key]
    points = metric.get("points") or []
    result = {"metric": key, "label": spec["label"], "unit": metric.get("unit"), "target": spec["target"],
              "previous": None, "latest": _reading(points[-1]) if points else None,
              "change": None, "at_target": at_target(key, points[-1]["value"]) if points else None,
              "status": "insufficient", "reason": None}
    if len(points) < 2 or metric.get("stale"):
        return result
    before, after = points[-2], points[-1]
    result.update(previous=_reading(before), change=round(after["value"] - before["value"], 3))
    if at_target(key, before["value"]) and at_target(key, after["value"]):
        result["status"] = "controlled"
        return result
    gained = distance_from_target(key, before["value"]) - distance_from_target(key, after["value"])
    result["status"] = ("improving" if gained >= spec["min_change"] else
                        "worsening" if gained <= -spec["min_change"] else "stable")
    if result["status"] in ("improving", "worsening"):
        way = "toward" if result["status"] == "improving" else "away from"
        result["reason"] = (f"{spec['label']} {_num(before['value'])} → {_num(after['value'])} {metric['unit']} "
                            f"({_day(before['date'])} → {_day(after['date'])}), moving {way} target {spec['target']}")
    return result


def _nyha(value):
    text = str(value or "").replace("Class", "").strip().upper()
    return NYHA.get(text)


def symptom_change(report):
    """Compare the last two structured symptom assessments."""
    progression = report.get("symptom_progression") or {}
    history = progression.get("history") or []
    result = {"status": "insufficient", "reasons": [], "assessed_on": history[-1]["date"] if history else None}
    # The engine's own escalation rule can see patterns this pairwise check misses;
    # its message is the fallback when no specific change is found here.
    engine_worse = progression.get("status") == "WORSENING_SYMPTOMS"
    engine_reason = list(progression.get("observations") or [])[-1:]
    if len(history) < 2:
        if engine_worse:
            result.update(status="worsening", reasons=engine_reason)
        return result
    before, after = history[-2], history[-1]
    worse, better = [], []
    for key, label in SYMPTOM_KEYS:
        if after.get(key) is True and before.get(key) is not True:
            worse.append(f"New {label} recorded on {_day(after['date'])} (not recorded on {_day(before['date'])})")
        elif before.get(key) is True and after.get(key) is False:
            better.append(f"{label.capitalize()} recorded on {_day(before['date'])} is absent on {_day(after['date'])}")
    if before.get("chest_pain_present") is True and after.get("chest_pain_present") is True:
        a, b = before.get("chest_pain_severity"), after.get("chest_pain_severity")
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(b - a) >= 2:
            (worse if b > a else better).append(
                f"Chest pain severity {_num(a)} → {_num(b)} out of 10 ({_day(before['date'])} → {_day(after['date'])})")
    a, b = _nyha(before.get("breathlessness_nyha_class")), _nyha(after.get("breathlessness_nyha_class"))
    if a and b and a != b:
        (worse if b > a else better).append(
            f"Breathlessness NYHA class {a} → {b} ({_day(before['date'])} → {_day(after['date'])})")
    if engine_worse and not worse:
        worse = engine_reason
    result["status"] = "worsening" if worse else "improving" if better else "stable"
    result["reasons"] = worse or better
    return result


def priority_change(report, previous_report):
    current = report.get("review_priority")
    previous = (previous_report or {}).get("review_priority")
    result = {"previous": previous, "current": current, "status": "none"}
    if previous in PRIORITY_RANK and current in PRIORITY_RANK:
        delta = PRIORITY_RANK[current] - PRIORITY_RANK[previous]
        result["status"] = "escalated" if delta > 0 else "de_escalated" if delta < 0 else "unchanged"
    return result


def _courses(visits, cutoff):
    """Earliest start of each recognised generic, per checked metric, within the lookback."""
    starts = {}
    for visit in visits:
        for rx in visit.get("prescriptions") or []:
            start = parse_date(rx.get("date"))
            if start is None or start > cutoff or (cutoff - start).days > TREATMENT_LOOKBACK_DAYS:
                continue
            for item in rx.get("items") or []:
                for class_key, generic in classify(item.get("medicine_name")):
                    key = (class_key, generic)
                    if key not in starts or start < starts[key]:
                        starts[key] = start
    return starts


def treatment_responses(visits, report, cutoff):
    trajectories = report.get("metric_trajectories") or {}
    responses = []
    for (class_key, generic), start in sorted(_courses(visits, cutoff).items(), key=lambda x: (x[1], x[0])):
        spec = DRUG_CLASSES[class_key]
        for metric, after_days, due_days in spec["checks"]:
            points = (trajectories.get(metric) or {}).get("points") or []
            baseline = next((p for p in reversed(points) if parse_date(p["date"]) <= start), None)
            opens = start + timedelta(days=after_days)
            # The latest on-treatment reading is the patient's current response.
            follow = next((p for p in reversed(points) if parse_date(p["date"]) >= opens), None)
            target = TARGETS[metric]
            entry = {"medicine": generic.capitalize(), "drug_class": class_key, "class_label": spec["label"],
                     "metric": metric, "metric_label": target["label"], "unit": trajectories.get(metric, {}).get("unit"),
                     "started": start.isoformat(), "baseline": _reading(baseline) if baseline else None,
                     "follow_up": _reading(follow) if follow else None, "due_from": opens.isoformat(),
                     "due_by": (start + timedelta(days=due_days)).isoformat(), "overdue": False,
                     "status": None, "reason": None}
            if follow is None:
                entry["status"] = "awaiting_follow_up"
                entry["overdue"] = cutoff > start + timedelta(days=due_days)
            elif baseline is None:
                entry["status"] = "no_baseline"
            else:
                # Every checked metric here is "lower is better".
                drop = baseline["value"] - follow["value"]
                entry["status"] = ("responding" if drop >= target["min_change"] else
                                   "worsening_on_treatment" if drop <= -target["min_change"] else "no_clear_response")
                words = {"responding": "responding", "worsening_on_treatment": "worsening on treatment",
                         "no_clear_response": "no clear response"}[entry["status"]]
                entry["reason"] = (f"{target['label']} {_num(baseline['value'])} → {_num(follow['value'])} {entry['unit']} "
                                   f"on {generic} (started {_day(start.isoformat())}): {words}")
            responses.append(entry)
    return responses


def assess_monitoring(report, previous_report, visits, *, as_of=None):
    """Monitoring result for one patient from a fresh assess_timeline report.

    report: assess_timeline output for the same visits.
    previous_report: the patient's previous saved assessment report, or None.
    visits: the visit dicts given to assess_timeline (prescriptions included).
    """
    cutoff = analysis_date(as_of if as_of is not None else report.get("as_of"))
    trajectories = report.get("metric_trajectories") or {}
    metrics = [metric_change(key, trajectories[key]) for key in TARGETS if key in trajectories]
    by_key = {m["metric"]: m for m in metrics}
    symptoms = symptom_change(report)
    priority = priority_change(report, previous_report)
    treatments = treatment_responses(visits, report, cutoff)

    key_changes = [by_key[k] for k in KEY_METRICS if k in by_key]
    worse, better = [], []
    if priority["status"] == "escalated":
        worse.append(f"Review priority rose from {priority['previous']} to {priority['current']}")
    if symptoms["status"] == "worsening":
        worse.extend(symptoms["reasons"])
    worse.extend(m["reason"] for m in key_changes if m["status"] == "worsening")
    worse.extend(t["reason"] for t in treatments if t["status"] == "worsening_on_treatment")
    better.extend(m["reason"] for m in key_changes if m["status"] == "improving")
    if symptoms["status"] == "improving":
        better.extend(symptoms["reasons"])
    if priority["status"] == "de_escalated":
        better.append(f"Review priority eased from {priority['previous']} to {priority['current']}")
    better.extend(t["reason"] for t in treatments if t["status"] == "responding")

    comparable = (any(m["status"] != "insufficient" for m in key_changes)
                  or symptoms["status"] != "insufficient" or priority["status"] != "none")
    if worse:
        trend = "WORSENING"
    elif not comparable:
        trend = "INSUFFICIENT_DATA"
    elif better:
        trend = "IMPROVING"
    else:
        trend = "STABLE"

    # Non-key metrics do not decide the trend but are still worth a line.
    also = [m["reason"] for m in metrics if m["metric"] not in KEY_METRICS and m["reason"]]
    waiting = [f"{t['metric_label']} check after {t['medicine'].lower()} "
               f"{'overdue since' if t['overdue'] else 'due by'} {_day(t['due_by'])}"
               for t in treatments if t["status"] == "awaiting_follow_up"]
    return {
        "version": MONITORING_VERSION,
        "as_of": cutoff.isoformat(),
        "health_trend": trend,
        "reasons": worse + better + also + waiting,
        "metric_changes": metrics,
        "symptom_change": symptoms,
        "priority_change": priority,
        "treatment_responses": treatments,
        "disclaimer": "Recorded values moving toward or away from target; decision support, not a diagnosis.",
    }
