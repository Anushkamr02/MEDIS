# MEDIS project review and upgrade plan

Update 3 November 2026: the longitudinal engine has been corrected and upgraded.
See [LONGITUDINAL_VALIDATION.md](./LONGITUDINAL_VALIDATION.md) for reproduced
defects, robust time-series methods, regression coverage, legacy PCE support,
the pending PREVENT integration and clinical-validation limits. This supersedes
the earlier longitudinal implementation notes below.

Reviewed 2 November 2026. This is a source review of the central record workflow,
authentication, reporting, setup, and longitudinal analysis, with isolated runtime
checks for the changed analysis code. It is not a complete security audit or clinical validation.

## What the project currently does

MEDIS now serves its browser interface and REST API from one FastAPI application.
[app.py](./app.py) is the Python/Uvicorn launcher; [api.py](./api.py) is a compatible
ASGI entry point over [medis/main.py](./medis/main.py). The HTML/CSS/JavaScript
interface lives in [medis/web/static](./medis/web/static) and uses the existing
SQLAlchemy services through HTTP endpoints. Streamlit has been removed.
Patients, visits, structured observations, prescriptions, ECG results, documents,
and assessments are stored in the relational model. Files live in local folders.
The default database is SQLite; a PostgreSQL URL is supported by configuration.

The current structure is suitable for a prototype of a shared patient timeline.
The permanent identifier is an application identifier; it does not itself solve
duplicate patient registration, patient identity matching, access authorization,
or federation between independently operated hospital databases.

Legacy training and synthetic disease modules coexist with the newer clinical
record platform. They are not automatically redundant: the prediction gateway
and training scripts still use those paths. Deleting them without separating the
supported product surfaces would break callers.

## FastAPI interface migration

Start with `ecg_env/Scripts/python.exe app.py`, then open http://127.0.0.1:8000.
Interactive API documentation remains at `/docs`; JSON health moved from `/` to
`/api/health`, while `/health` remains compatible. Development reload is available
through `python -m uvicorn app:app --reload`.

- Replaced the Streamlit script with a responsive, locally served interface.
  No Node build step, frontend CDN, or Streamlit runtime is required.
- Added patient/doctor registration and password sign-in through the existing
  authentication services. Tokens stay in browser memory and are cleared on reload.
  Removed profile-impersonation dropdowns and automatic demo seeding.
- Migrated patient lookup, timeline, consultation forms, multi-item prescriptions,
  PDF downloads, document uploads, longitudinal charts/pattern evidence and audit
  activity. Draft form values clear when switching patients or active visits.
- Added an authenticated ECG preview endpoint supporting single files or WFDB
  header/signal pairs, isolated temporary storage, filename/size checks and
  JSON conversion for numpy values. Existing digitization/classification guardrails
  remain in the inference engine. ECG preview does not persist a clinical record;
  document upload remains the persistence workflow for individual reports.
- Moved legacy inference imports to request time and fixed OCR temporary-file
  cleanup. Removed Streamlit from the setup checker.
- `test_web_app` plus `test_visit_patterns`: **15 tests passed**. New isolated
  integration tests exercise registration/login, consultations, timeline and pattern
  responses, actual prescription/history PDF generation, patient uploads, static
  assets, ASGI compatibility, and ECG authorization/input/serialization handling.
  ECG inference itself is mocked in the new route test; model quality is not claimed.
- Browser smoke checks passed for sign-in, lookup, pattern rendering, consultation
  navigation, prescription row controls and document navigation using fixture API
  responses. Backend integration tests use temporary storage and an isolated database.
- Python editor diagnostics and JavaScript syntax checks passed. Existing Pydantic,
  UTC timestamp and TestClient dependency deprecation warnings remain.

This migration does **not** complete the API authorization work below. A sign-in UI
does not protect existing patient/consultation/download routes by itself. New web
document-list and ECG routes verify bearer credentials; the legacy clinical routes
still need consistent role, patient ownership, hospital and consent enforcement.

## Longitudinal improvements from the earlier pass

- Added [visit_patterns.py](./medis/ai/visit_patterns.py), re-exported through
  [longitudinal_analysis.py](./medis/ai/longitudinal_analysis.py). It supplies
  dated evidence, screening coverage, excluded-record counts, and an explicit
  analysis date for historical replay.
- Added personal visit-cadence acceleration using robust median intervals:
  at least three baseline intervals, three recent intervals, recent median below
  14 days and below half the baseline median. Same-day attendance is counted
  once for cadence estimation.
- Added a sliding window for the same normalized complaint: at least three
  visits at three known hospitals within 21 days. Complaint matching is exact
  after whitespace/case normalization; it does not infer intent or equivalent
  clinical meanings. Site IDs take precedence over names; reliable hospital
  identity resolution remains a prerequisite.
- Added structured symptom severity/NYHA escalation over 90 days, a limited
  current intended-prescription overlap screen, and a three-domain metabolic
  deterioration screen. These are transparent heuristics, not diagnoses.
- Prescription screening recognizes explicit generic ingredient names and
  durations in days/weeks. It screens identical ingredients and selected
  beta-blocker plus diltiazem/verapamil combinations. It does not replace a drug
  interaction database, reconciliation, or evidence of actual medication use.
- Refill adherence and seasonality return `NOT_ASSESSABLE` with reasons.
  Neither is fabricated from missing visits or a handful of seasonal observations.
- The Trends & patterns panel displays findings, evidence, hospital dispersion,
  and coverage limitations in [app.js](./medis/web/static/app.js).
- Replaced per-visit measurement/symptom queries with batched relationship
  loading. Simplified repeated observation collection and removed the redundant
  model imports from the analysis module.
- Added `persist=False` for dashboard, GET API, and history-PDF report callers.
  Viewing these reports no longer inserts an assessment on every rerun/request.
  Existing explicit service callers retain persistence by default. Persisted
  screening output is nested in the existing symptom JSON to avoid silently
  changing the database schema; a dedicated versioned assessment payload is a
  future migration.
- Prevented a missing baseline QTc from raising `int(None)` and added an
  insufficient-data category when no relevant recorded measurements or adverse
  analytical findings support a risk category.
- Reworked [setup_check.py](./setup_check.py) into import-safe functions with a
  nonzero failure status, readable import-error details, application dependency
  checks, optional `--training` dataset checks, and optional `--ecg` artifact checks.
  Raw training datasets are no longer required for a runtime-only check.

The visit scan sorts records in O(n log n); complaint-window processing is O(n)
after sorting. Prescription pair screening is O(a²) for a active intended courses.
This is acceptable for short medication lists; a production interaction service
should index normalized ingredients and emit grouped findings to avoid alert floods.

## Upgrade priorities

| Priority | Verified finding | Recommended change |
|---|---|---|
| P0 | API patient records, prescriptions, consultations, and audit routes in [medis/main.py](./medis/main.py) have no token-verification or patient-access dependency. | Enforce verified identity, role, patient ownership, hospital authorization and consent on each read/write/download; add negative authorization tests. A supplied patient/doctor ID must never confer access. |
| P0 | UI sign-in is now implemented, but existing API authorization is incomplete. | Enforce access checks server-side and restrict doctor self-registration appropriately for deployment. Demo seeding is no longer automatic. |
| P0 | [security.py](./medis/auth/security.py) has a public fallback signing secret. | Require externally configured secrets for deployment, rotate keys, and invalidate legacy tokens. |
| P1 | Risk is calculated by counting adverse module statuses, not by a Pooled Cohort Equation. | Keep the explicit heuristic label. Implement a separately tested, versioned ASCVD calculator with eligibility rules, complete inputs, appropriate population limitations and clinical approval. Do not present its output as an exact prognosis. |
| P1 | Existing progression functions often compare only the first and last complete rows; missing measurements can conceal intermediate or latest abnormalities. | Introduce per-metric time series, unit normalization, provenance, missingness and freshness. Use robust slopes with minimum time spans; do not annualize changes over near-zero intervals. Review legacy symptom/ECG rules for missing-data and acute-warning handling. |
| P1 | Prescriptions lack explicit medication start/stop/reconciliation and dispensing events. | Add ingredient identifiers, status transitions, supply quantity/days, refill events, source hospital and reconciliation timestamps. Only calculate PDC/MPR where dispensing coverage is available; distinguish evidence gaps from non-adherence. |
| P1 | Upload naming in [patient_upload.py](./medis/uploads/patient_upload.py) interpolates category into a path; uploads lack content/size verification in that service. | Use opaque server-generated file IDs, path containment checks, size limits and content validation; keep metadata separate from storage paths. Legacy OCR temporary cleanup was fixed in this migration. |
| P1 | Audit entries in [security.py](./medis/auth/security.py) use independent unkeyed hashes of editable data. | Do not claim an immutable hash chain. Add chained, signed events, concurrency-safe sequence allocation, independent verification and externally anchored append-only storage. |
| P1 | The history PDF builder in [medical_history_pdf.py](./medis/reports/medical_history_pdf.py) does not configure PDF encryption. | Correct encrypted-export claims; design recipient access, secure delivery, retention and encryption policies. A printed signature label is not a cryptographic digital signature. |
| P2 | Fresh-environment dependency manifests/locks are still missing; [README.md](./README.md) now documents the existing environment and FastAPI launcher. | Publish tested dependency manifests/locks, supported Python versions and reproducible CI. Separate runtime, training, and optional feature dependencies. |
| P2 | Schema initialization uses `create_all`, and visits may have multiple measurement/symptom rows although services treat them as one. | Add Alembic migrations, explicit uniqueness/versioning rules, foreign-key enforcement tests, transaction boundaries and composite patient/date indexes. Validate PostgreSQL separately from SQLite. |
| P2 | Clinical, legacy inference, and training workflows share a large UI and broad imports. | Split UI rendering from orchestration; separate research commands and optional model imports; remove code only after usage checks and isolated regression coverage. |

## Clinical algorithm roadmap

1. Establish a normalized event model: UTC timestamps, observed time versus upload
   time, source identity, units, verification status, and record revision history.
2. Add explicit, configurable rule versions and assessment input fingerprints.
   Distinguish a currently active alert from a historical episode; add clinician
   acknowledgement and avoid duplicate alerts. The current detector reports
   historical screening events with dates; it does not manage an alert lifecycle.
3. Normalize symptoms with a clinical vocabulary and negation/temporality handling.
   Do not infer NYHA classes from fatigue text or equate all chest pain with angina.
4. Implement per-metric robust regression and change-point screening only after
   specifying sample requirements and evaluating irregular sampling and treatment
   changes. Thresholds need adjudicated examples and false-alert analysis.
5. For seasonality, require multiple years, per-period observation counts, location
   and treatment adjustment; then evaluate harmonic regression against a
   nonseasonal model. A winter visit count alone does not establish a BP flare-up.
6. Validate clinical patterns prospectively across sites, with sensitivity,
   specificity, calibration where applicable, subgroup analysis and alert burden.

## Claims and model evidence

[ecg_metrics.json](./outputs/ecg_metrics.json) contains the quoted AUC 0.9578,
accuracy 0.8922, and F1 0.8463. It reports 603 test records and class distributions
of 4,797 training, 600 validation, and 603 test records. The public dataset's full
size must not be described as the model's actual training sample count without
additional provenance. These are stored evaluation results; this review did not
retrain the model or independently reproduce those metrics.

## Earlier longitudinal verification and environment

- `ecg_env/Scripts/python.exe -m unittest test_visit_patterns -v`: **12 passed**.
  Tests use a disposable in-memory database, covering date handling, duplicate
  visits, false cluster prevention, personal cadence, structured symptoms, sparse
  metabolic data, intended-course expiry, unavailable evidence, missing QTc,
  read-only/persisted reports, bounded query count and setup failure status.
- A 12-visit report stays within eight SELECT statements in the query-count test.
- All seven changed/new Python files parse successfully. Editor diagnostics
  returned no errors at the time of the check.
- `setup_check.py --ecg`: exits **1** and correctly reports missing `pytesseract`,
  missing `email-validator`, and no Tesseract executable on PATH. TensorFlow and
  both ECG model artifacts are present. Python is 3.13.3 in the configured venv.
- Existing `datetime.utcnow()` use raises deprecation warnings; migrate timestamps
  consistently with a schema/timezone plan rather than mixing aware and naive values.
- No real patient rows were changed by these tests. Full application/UI execution,
  end-to-end workflows, PostgreSQL, model inference and PDF visual output were
  not validated in this pass. Existing broad tests can write records and outputs;
  isolate their storage before adding them to CI.
