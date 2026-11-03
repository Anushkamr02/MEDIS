"""Explainable timeline screening; thresholds are heuristics, not validated diagnoses.

Input measurements use the units documented in the ORM. Structured symptoms are
preferred to free-text inference. Prescription end dates describe intended coverage,
not proof that a patient took, stopped, or refilled medication.
"""

import re
from collections import Counter
from datetime import timedelta
from statistics import median
from medis.ai.trajectories import analysis_date, normalize_visits, build_trajectories, parse_date as _date, finite_number as _number
from medis.ai.seasonality import seasonal_bp_screen


def _name(value):
    return " ".join(str(value or "").casefold().split())


def detect_visit_patterns(visits_data, *, as_of=None):
    """Screen six pattern families with dated evidence and explicit limitations.

    Dates are sorted, duplicate visit IDs ignored, and future/invalid dates excluded.
    A sliding window detects repeated complaints without all-pairs visit comparison.
    ``as_of`` makes historical replay deterministic; the default is today's UTC date.
    """
    cutoff = analysis_date(as_of)
    normalized, excluded_rows = normalize_visits(visits_data, as_of=cutoff)
    rows = [(_date(v["date"]), v) for v in normalized]
    excluded = len(excluded_rows)
    metric_series = build_trajectories(normalized, as_of=cutoff)
    flags = []

    def flag(code, message, evidence, severity="REVIEW"):
        flags.append(dict(code=code, severity=severity, message=message, evidence=evidence))

    def evidence(day, visit, **extra):
        return dict(date=day.isoformat(), visit_id=visit["visit_id"],
                    hospital=visit.get("hospital"), **extra)

    # Ignore same-day duplicates when estimating a patient's visit cadence.
    visit_days = sorted({day for day, _ in rows})
    gaps = [(b - a).days for a, b in zip(visit_days, visit_days[1:])]
    if len(gaps) >= 6:
        baseline, recent = median(gaps[:-3]), median(gaps[-3:])
        if recent < 14 and recent * 2 < baseline:
            flag("VISIT_ACCELERATION", "Recent visit intervals are less than half the historical median; review the reason for increased attendance.",
                 [{"baseline_median_days": baseline, "recent_median_days": recent,
                   "baseline_intervals": len(gaps) - 3, "recent_intervals": 3,
                   "window_end": visit_days[-1].isoformat()}])

    # Same complaint within a 21-day window, at least 3 visits at 3 known sites.
    complaints = {}
    for day, visit in rows:
        complaint = _name((visit.get("symptoms") or {}).get("chief_complaint"))
        if complaint:
            complaints.setdefault(complaint, []).append((day, visit))
    for complaint, group in complaints.items():
        left, hospitals = 0, Counter()
        for right, (day, visit) in enumerate(group):
            hospital = _name(visit.get("hospital_id") or visit.get("hospital"))
            if hospital:
                hospitals[hospital] += 1
            while (day - group[left][0]).days > 21:
                old = _name(group[left][1].get("hospital_id") or group[left][1].get("hospital"))
                if old:
                    hospitals[old] -= 1
                    if hospitals[old] == 0:
                        del hospitals[old]
                left += 1
            if right - left >= 2 and len(hospitals) >= 3:
                flag("VISIT_CLUSTER", "Repeated complaint across three or more hospitals within 21 days; review care coordination.",
                     [evidence(d, v, complaint=complaint) for d, v in group[left:right + 1]])
                break

    # Structured severity and NYHA comparisons; no diagnosis from keyword matches.
    symptomatic = [(d, v) for d, v in rows if v.get("symptoms")]
    nyha = {"i": 1, "ii": 2, "iii": 3, "iv": 4}
    for (d1, v1), (d2, v2) in zip(symptomatic, symptomatic[1:]):
        if not 0 < (d2 - d1).days <= 90:
            continue
        a, b = v1["symptoms"], v2["symptoms"]
        sa, sb = a.get("chest_pain_severity"), b.get("chest_pain_severity")
        pain = (a.get("chest_pain_present") is True and b.get("chest_pain_present") is True
                and _number(sa) and _number(sb) and 0 <= sa < sb <= 10)
        na = nyha.get(_name(a.get("breathlessness_nyha_class")).removeprefix("class "))
        nb = nyha.get(_name(b.get("breathlessness_nyha_class")).removeprefix("class "))
        dyspnea = (a.get("breathlessness_present") is True and b.get("breathlessness_present") is True
                   and na is not None and nb is not None and nb > na)
        if pain or dyspnea:
            flag("SYMPTOM_ESCALATION", "Recorded symptom severity increased within 90 days; clinician review required.",
                 [evidence(d1, v1, symptoms=a), evidence(d2, v2, symptoms=b)])

    # Require contemporaneous domain endpoints; unrelated years are not a cluster.
    trajectories = {}
    for key in ("bmi", "fasting_glucose", "egfr"):
        series = metric_series[key]
        if series["count"] >= 2 and series["span_days"] >= 30 and not series["stale"]:
            trajectories[key] = series["points"][0], series["points"][-1]
    worsening = []
    for key, (first, last) in trajectories.items():
        a, b = first["value"], last["value"]
        if ((key == "bmi" and b - a >= 3.5)
                or (key == "fasting_glucose" and a < 126 <= b)
                or (key == "egfr" and b <= a * .8)):
            worsening.append(key)
    baseline_dates = [_date(ends[0]["date"]) for ends in trajectories.values()]
    latest_dates = [_date(ends[1]["date"]) for ends in trajectories.values()]
    if len(worsening) == 3 and (max(baseline_dates) - min(baseline_dates)).days <= 90 and (max(latest_dates) - min(latest_dates)).days <= 90:
        flag("MULTISYSTEM_TREND", "Concurrent BMI, glucose, and eGFR deterioration; review dates and causes. This does not establish metabolic syndrome.",
             [{"metric": key, **point} for key in worsening for point in trajectories[key]])

    # Only explicit generic ingredients and unambiguous durations are recognized.
    beta = {"metoprolol", "atenolol", "bisoprolol", "carvedilol", "propranolol", "nebivolol"}
    rate_ccb = {"diltiazem", "verapamil"}
    courses, unknown_duration = [], 0
    for day, visit in rows:
        for rx in visit.get("prescriptions", []):
            start = _date(rx.get("date"))
            if start is None or start > cutoff:
                continue
            for item in rx.get("items", []):
                name = _name(item.get("medicine_name"))
                match = re.fullmatch(r"(\d+)\s*(days?|weeks?)", _name(item.get("duration")))
                if not match or not name or int(match[1]) <= 0:
                    unknown_duration += 1
                    continue
                days = int(match[1]) * (7 if match[2].startswith("week") else 1)
                if days > 3650:
                    unknown_duration += 1
                    continue
                courses.append((start, start + timedelta(days=days), name, visit, rx))
    active = [c for c in courses if c[0] <= cutoff < c[1]]
    for i, a in enumerate(active):
        for b in active[i + 1:]:
            duplicate = a[2] == b[2]
            interaction = (a[2] in beta and b[2] in rate_ccb) or (b[2] in beta and a[2] in rate_ccb)
            if duplicate or interaction:
                flag("PRESCRIPTION_OVERLAP", "Potential duplicate ingredient or rate-slowing combination in intended prescription coverage; reconcile actual medication use.",
                     [evidence(c[0], c[3], medicine=c[2], prescription_id=c[4].get("prescription_id"),
                               intended_end=c[1].isoformat()) for c in (a, b)])

    recorded_lists = []
    for day, visit in rows:
        drugs = {_name(item.get("medicine_name")): _name(item.get("dosage"))
                 for rx in visit.get("prescriptions", []) if _date(rx.get("date")) is not None and _date(rx["date"]) <= cutoff
                 for item in rx.get("items", []) if item.get("medicine_name")}
        if drugs:
            recorded_lists.append((day, visit, drugs))
    for (d1, v1, a), (d2, v2, b) in zip(recorded_lists, recorded_lists[1:]):
        if 0 < (d2 - d1).days <= 90 and a != b:
            flag("PRESCRIPTION_LIST_CHANGE", "Recorded prescription lists or dose text changed within 90 days; reconcile actual treatment. Omission does not establish discontinuation.",
                 [evidence(d1, v1, recorded_medications=a), evidence(d2, v2, recorded_medications=b)])
    seasonality = seasonal_bp_screen(metric_series["systolic_bp"]["points"])
    if seasonality["status"] == "PATTERN":
        flag("ANNUAL_BP_PATTERN", "Repeated annual BP variation improves prediction of held-out years; review treatment and sampling changes before attributing a seasonal cause.",
             [seasonality])
    # No dispensing or refill events exist in the schema. Do not infer adherence.
    recent_hospitals = {_name(v.get("hospital_id") or v.get("hospital")) for d, v in rows
                        if (cutoff - d).days <= 365}
    recent_hospitals.discard("")
    return {
        "status": "REVIEW" if flags else "NO_FLAGS",
        "as_of": cutoff.isoformat(), "visits_analyzed": len(rows), "excluded_visits": excluded,
        "distinct_hospitals_last_365_days": len(recent_hospitals), "flags": flags,
        "seasonality": seasonality,
        "coverage": {
            "visit_frequency": "Exact normalized complaint match: 3 visits / 3 hospitals / 21 days. Acceleration: median of last 3 intervals <14 days and <half earlier median; at least 3 baseline intervals.",
            "symptom_escalation": "Structured chest-pain severity and NYHA changes within 90 days.",
            "prescriptions": "Limited generic-ingredient screen of intended coverage at as_of; no stop events or comprehensive interaction database.",
            "metabolic_cluster": "BMI +3.5, glucose crossing 126 mg/dL, eGFR decrease >=20%; baseline and latest domain dates each within 90 days; heuristic, not diagnostic criteria.",
            "refill_dropoff": "NOT_ASSESSABLE: dispensing/refill and medication reconciliation events are unavailable.",
            "seasonality": f"{seasonality['status']}: {seasonality['reason']}",
        },
        "unparsed_prescription_items": unknown_duration,
        "disclaimer": "Screening rules are unvalidated. No flags does not establish absence of disease or medication risk.",
    }
