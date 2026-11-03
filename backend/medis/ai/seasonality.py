"""Conservative annual-pattern screening with held-out calendar-year validation.

An annual association is not evidence of winter causation, adherence, or treatment
effect. Models adjust for linear time only; location and treatment confounding remain.
"""
from collections import Counter
from datetime import date
import math

import numpy as np


def seasonal_bp_screen(points):
    result = {"status": "NOT_ASSESSABLE", "reason": "Requires at least 24 distinct observation dates spanning 730 days, three calendar years, and at least six sampled months per year."}
    if len(points) < 24:
        return result
    dates = [date.fromisoformat(p["date"]) for p in points]
    years = sorted({d.year for d in dates})
    if (dates[-1] - dates[0]).days < 730 or len(years) < 3:
        return result
    if any(len({d.month for d in dates if d.year == year}) < 6 for year in years):
        return result
    t = np.asarray([(d - dates[0]).days / 365.25 for d in dates])
    phase = np.asarray([2 * math.pi * (d - date(d.year, 1, 1)).days / (366 if d.year % 4 == 0 and (d.year % 100 != 0 or d.year % 400 == 0) else 365) for d in dates])
    y = np.asarray([p["value"] for p in points], dtype=float)
    base = np.column_stack([np.ones(len(t)), t])
    seasonal = np.column_stack([base, np.sin(phase), np.cos(phase)])
    baseline_errors, seasonal_errors = [], []
    for year in years:
        test = np.asarray([d.year == year for d in dates])
        train = ~test
        if np.linalg.matrix_rank(seasonal[train]) < 4:
            return result
        for design, errors in ((base, baseline_errors), (seasonal, seasonal_errors)):
            coefficients = np.linalg.lstsq(design[train], y[train], rcond=None)[0]
            errors.append(float(np.mean((y[test] - design[test] @ coefficients) ** 2)))
    baseline_mse, seasonal_mse = float(np.mean(baseline_errors)), float(np.mean(seasonal_errors))
    gain = 1 - seasonal_mse / baseline_mse if baseline_mse > 1e-8 else 0
    coefficients = np.linalg.lstsq(seasonal, y, rcond=None)[0]
    amplitude = float(np.hypot(coefficients[2], coefficients[3]))
    result.update(status="PATTERN" if gain >= .20 and amplitude >= 5 else "NO_SUPPORTED_PATTERN",
                  reason="Annual harmonic model compared with linear time trend using leave-one-calendar-year-out validation. Descriptive association only; medication, measurement practice and locale are not controlled.",
                  amplitude_mmhg=round(amplitude, 2), held_out_error_reduction=round(gain, 3),
                  observations=len(points), years=years,
                  observations_per_year=dict(Counter(d.year for d in dates)),
                  method="linear_time_plus_annual_sin_cos_leave_one_year_out")
    return result
