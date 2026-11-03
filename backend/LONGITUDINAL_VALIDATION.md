# Longitudinal engine review — 3 November 2026

The previous engine was not reliable enough for its advertised behavior. It did
not calculate a 10-year ASCVD probability: the badge counted adverse modules.
Reproduced defects included falling LDL described as increasing, glucose-only
diabetes-range results classified as euglycemic, first-visit syncope classified as
asymptomatic, and absent blood pressure classified as optimal.

## Implemented corrections and methods

- [Longitudinal orchestration](./medis/ai/longitudinal_analysis.py) separates
  current abnormal values, trend direction, review priority and absolute risk.
  Review priority is `URGENT_REVIEW`, `REVIEW`, `INSUFFICIENT_DATA` or
  `NO_FLAGGED_PROGRESSION`. The legacy `risk_category` response key now aliases
  this priority; integrations must not interpret it as a probability band.
- [Trajectory summaries](./medis/ai/trajectories.py) sort dates, reject future,
  invalid and duplicate visits, reject nonfinite/out-of-range measurements and
  explicitly incompatible units, and preserve source visits and hospitals.
  Daily medians prevent repeated same-day visits dominating a slope. Material
  same-day disagreements are surfaced and severe latest-day readings remain
  visible even if the median is lower.
- Robust Theil–Sen slopes use elapsed calendar time, not visit index. Two-point
  deltas remain available; annual slopes require at least 30 days. Series over
  200 dates use a deterministic 200-date sample to bound pairwise computation.
  End-to-end change and robust slope are separately labelled. A slope is not a
  forecast or a calibrated risk estimate. Latest measurements over 365 days old
  do not establish current status. These cutoffs are engineering heuristics.
- Current severe BP and recorded concerning symptoms receive separate review
  flags. Structured symptoms are not converted into inferred NYHA diagnoses.
  Glycemic ranges require clinical confirmation; no diabetes type or automatic
  drug/dose prescription is generated. Isolated breathlessness/palpitations also
  produce a valid summary.
- [Visit patterns](./medis/ai/visit_patterns.py) screen exact normalized complaint
  clusters across hospitals, personal visit cadence, structured symptom changes,
  limited generic drug overlap, recorded prescription-list changes and aligned
  BMI/glucose/eGFR deterioration. These are descriptive prompts, not accusations
  of doctor shopping, proof of actual medication use, or metabolic-syndrome diagnoses.
- [Annual BP screening](./medis/ai/seasonality.py) compares a linear trend with
  linear trend plus annual sine/cosine terms using leave-one-year-out validation.
  It requires 24 dates, 730 days, three years and six sampled months per year.
  A flag requires at least 20% held-out error reduction and 5 mmHg amplitude.
  These research heuristics need external validation and do not establish seasonal
  causality. Dispensing/refill events are absent, so adherence remains unassessable.

## Absolute risk: what is and is not implemented

[Legacy PCE](./medis/ai/ascvd.py) is an optional, explicitly selected comparison.
It requires clinician-confirmed sex/cohort, age, total cholesterol, HDL, systolic
BP, treatment, diabetes, smoking, known ASCVD status and a recent snapshot date.
Missing flags are not assumed false. Unsupported cohorts, known ASCVD, stale or
future snapshots and out-of-range inputs do not produce a percentage. Population
calibration is uncertain for South Asian patients. Inputs are not silently built
by combining unrelated visit dates.

The coefficients reproduce the four published example estimates within 0.11
percentage point. Published rounded coefficients yield 5.4% for the White male
example whereas the printed example is 5.3%; this precision limitation is exposed
in the response. The estimate includes MI, coronary death and stroke, not just
heart attacks. PCE category thresholds are explicitly legacy thresholds.

**PREVENT-ASCVD is not implemented.** Current 2026 dyslipidemia guidance prefers
PREVENT for eligible primary prevention. Primary coefficient tables could not be
retrieved and verified during this review, so no third-party coefficients or
invented substitute were inserted. The UI links to the official calculator.
Integrating verified, versioned PREVENT coefficients and published reference
cases remains the next model upgrade, followed by local-population validation.

## Interface and integration

The FastAPI dashboard displays review priority, clinical findings with dated
evidence, LDL/HDL/triglyceride/BP/HbA1c/glucose charts, data quality and a separate
absolute-risk card. An optional doctor form submits explicit inputs to authenticated
`POST /api/ai/longitudinal/{patient_id}`. Calculations are read-only; refreshing
clears the optional estimate and changing patients clears inputs. The PDF export
labels review priority and explains that it does not include the optional snapshot
estimate. Existing GET report behavior remains read-only.

## Verification and remaining limits

Run isolated tests with:

```powershell
.\ecg_env\Scripts\python.exe -m unittest test_longitudinal_engine test_visit_patterns test_web_app -v
```

Tests cover regression cases, missing/stale/invalid data, robust slopes, severe
same-day readings, low HDL, seasonality positive and negative controls, prescription
overlap, reference PCE cases, endpoint authorization and input validation, bounded
query counts, persistence versus read-only behavior, and real PDF generation.
The broader legacy demo scripts can write to the application database and are not
used as isolated validation. ECG inference is mocked in the web test; its model
performance is outside this review.

Latest run: **38 tests passed**. JavaScript syntax and editor diagnostics passed.
A browser fixture check verified the review-priority card, seven metric charts,
dated findings and the optional risk form. Full form submission is covered by the
backend integration test; the browser submission check was interrupted and is not
claimed as passed. The server was restarted successfully at localhost:8000.

Example scenario: LDL 95 → 130 → 155 yields +60 mg/dL (+63.16%); systolic BP
124 → 138 → 148 yields +24 mmHg. This raises review findings, not a fabricated
23.8% probability. Falling LDL 190 → 140 is described as improving while the
remaining elevated value is separately reviewable.

This is engineering validation, not prospective clinical validation. No patient
outcome dataset was used to estimate calibration, discrimination, alert precision
or clinical benefit. Longitudinal observations currently use visit dates; the
schema lacks consistently normalized measurement-time/source-unit provenance.
Drug matching is limited, stop/dispensing events are absent, symptom records can
be incomplete, and uploaded narrative PDFs do not automatically become verified
structured measurements. Persisted duplicate observation rows select the latest
row ID and report the ambiguity. Existing unauthenticated legacy clinical routes
remain a deployment blocker documented in [PROJECT_REVIEW.md](./PROJECT_REVIEW.md).

## Primary references

- [NHLBI 2013 risk equations, Tables 4a/4b](https://www.nhlbi.nih.gov/sites/default/files/media/docs/risk-assessment.pdf)
- [2013 ACC/AHA guideline, Appendix 4/Table A](https://professional.heart.org/-/media/Data-Import/downloadables/0/D/A/2013-AHA-ACC-Cardiovascular-Risk-Guidelines-UCM_464291.pdf)
- [2026 dyslipidemia guideline summary](https://professional.heart.org/en/science-news/2026-guideline-on-the-management-of-dyslipidemia/top-things-to-know)
- [Official PREVENT calculator and applicability](https://professional.heart.org/en/guidelines-and-statements/prevent-calculator)
- [AHA blood-pressure ranges](https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings)
- [NIDDK A1c testing and confirmation](https://www.niddk.nih.gov/health-information/diagnostic-tests/a1c-test)
