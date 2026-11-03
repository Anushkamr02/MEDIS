"""Deterministic, date-aware measurement summaries for irregular clinical records.

Daily medians prevent repeated same-day observations from dominating a trend.
Theil-Sen median pairwise slopes resist isolated outliers; thresholds and data
freshness are transparent engineering rules, not validated clinical predictions.
"""
import math
from collections import defaultdict
from datetime import date, datetime, timezone
from statistics import median

METRICS = {
    # name: (unit, plausible broad input limits, material absolute change)
    "total_cholesterol": ("mg/dL", 1, 1500, 20),
    "ldl_cholesterol": ("mg/dL", 1, 1000, 20),
    "hdl_cholesterol": ("mg/dL", 1, 250, 5),
    "triglycerides": ("mg/dL", 1, 10000, 30),
    "systolic_bp": ("mmHg", 40, 350, 15),
    "diastolic_bp": ("mmHg", 20, 250, 10),
    "fasting_glucose": ("mg/dL", 10, 1500, 20),
    "hba1c": ("%", 2, 25, 0.5),
    "bmi": ("kg/m2", 8, 100, 3.5),
    "egfr": ("mL/min/1.73m2", 1, 200, 10),
    "serum_creatinine": ("mg/dL", 0.1, 30, 0.3),
}


def parse_date(value):
    if isinstance(value, datetime):
        return (value.astimezone(timezone.utc) if value.tzinfo else value).date()
    if isinstance(value, date):
        return value
    try:
        return parse_date(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except (ValueError, TypeError):
        return None


def analysis_date(value=None):
    result = parse_date(value) if value is not None else datetime.now(timezone.utc).date()
    if result is None:
        raise ValueError("as_of must be a date or ISO date string")
    return result


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize_visits(visits, *, as_of=None):
    cutoff = analysis_date(as_of)
    rows, issues, seen = [], [], set()
    for visit in visits:
        day, identity = parse_date(visit.get("date")), visit.get("visit_id")
        reason = ("invalid_date" if day is None else "future_date" if day > cutoff else
                  "missing_visit_id" if not identity else "duplicate_visit_id" if identity in seen else None)
        if reason:
            issues.append({"visit_id": identity, "reason": reason})
            continue
        seen.add(identity)
        rows.append({**visit, "date": day.isoformat(), "measurements": visit.get("measurements") or {},
                     "symptoms": visit.get("symptoms") or {}})
    rows.sort(key=lambda v: (v["date"], str(v["visit_id"])))
    return rows, issues


def summarize_metric(visits, key, *, as_of=None):
    cutoff = analysis_date(as_of)
    unit, minimum, maximum, material = METRICS[key]
    by_day, rejected = defaultdict(list), []
    for visit in visits:
        value = visit["measurements"].get(key)
        if value is None:
            continue
        supplied_unit = (visit.get("measurement_units") or {}).get(key, unit)
        if not finite_number(value) or not minimum <= value <= maximum or supplied_unit != unit:
            rejected.append({"visit_id": visit["visit_id"], "metric": key, "reason": "invalid_value_or_unit"})
            continue
        by_day[visit["date"]].append({"visit_id": visit["visit_id"], "hospital": visit.get("hospital"), "value": value})
    points = [{"date": day, "value": median(x["value"] for x in evidence), "evidence": evidence}
              for day, evidence in sorted(by_day.items())]
    result = dict(unit=unit, points=points, count=len(points), rejected=rejected,
                  direction="INSUFFICIENT_DATA", delta=None, percent_change=None,
                  slope_per_year=None, slope_method=None, span_days=0, age_days=None,
                  stale=True, latest=None, residual_mad=None, concordant_pair_fraction=None)
    if not points:
        return result
    result.update(latest=points[-1]["value"], age_days=(cutoff - parse_date(points[-1]["date"])).days)
    result["stale"] = result["age_days"] > 365
    if len(points) < 2:
        return result
    span = (parse_date(points[-1]["date"]) - parse_date(points[0]["date"])).days
    delta = points[-1]["value"] - points[0]["value"]
    result.update(delta=round(delta, 6), percent_change=round(100 * delta / points[0]["value"], 2), span_days=span)
    # Short intervals can reflect acute change, but cannot support an annual trend.
    if span < 30:
        result["direction"] = "SHORT_INTERVAL"
        return result
    sample = points if len(points) <= 200 else [points[round(i * (len(points) - 1) / 199)] for i in range(200)]
    origin = parse_date(points[0]["date"])
    xy = [((parse_date(p["date"]) - origin).days, p["value"]) for p in sample]
    slopes = [(yb - ya) / (xb - xa) for i, (xa, ya) in enumerate(xy) for xb, yb in xy[i + 1:]]
    slope = median(slopes)
    intercept = median(y - slope * x for x, y in xy)
    residuals = [y - (intercept + slope * x) for x, y in xy]
    residual_center = median(residuals)
    fitted_change = slope * span
    direction = "INCREASING" if fitted_change >= material else "DECREASING" if fitted_change <= -material else "NO_MATERIAL_TREND"
    result.update(slope_per_year=round(slope * 365.25, 6),
                  slope_method="two_point" if len(points) == 2 else "theil_sen_daily_medians",
                  slope_sample_count=len(sample), direction=direction,
                  residual_mad=round(median(abs(r - residual_center) for r in residuals), 6),
                  concordant_pair_fraction=round(sum(s * slope > 0 for s in slopes) / len(slopes), 3) if slope else 0)
    return result


def build_trajectories(visits, *, as_of=None):
    return {key: summarize_metric(visits, key, as_of=as_of) for key in METRICS}
