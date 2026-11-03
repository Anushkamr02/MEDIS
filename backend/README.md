# MEDIS — Backend, Clinical Analysis and Integration Guide

MEDIS (Medical Evaluation & Diagnostic Intelligence System) is a Python prototype
for a shared patient record across hospitals, with longitudinal cardiovascular
screening, ECG processing, structured consultations, prescriptions and report export.
A permanent MEDIS patient ID links records inside the same configured database.
It does not automatically federate independent hospital databases or resolve duplicate identities.

This README covers backend services, algorithms, model artifacts, setup and teammate
integration. It intentionally excludes interface design and usage instructions.
Inventory checked: **3 November 2026**.

## 1. Capabilities and implementation status

| Component | What the current code does | Important boundary |
|---|---|---|
| Central patient record | Patients, doctors, hospitals, visits, symptoms, measurements and history | One shared configured database; access hardening is incomplete |
| Longitudinal analysis | Date-aware changes, robust slopes, clinical review priorities and evidence | Descriptive screening; not a validated probability of a future event |
| Visit patterns | Visit clusters, cadence, symptom changes, limited prescription overlap, metabolic trajectories and annual BP patterns | Heuristics; refill adherence cannot be assessed without dispensing records |
| Absolute risk | Optional legacy 2013 Pooled Cohort Equations (PCE) | Explicit confirmed inputs required; PREVENT is not implemented |
| Digital ECG | File loading, preprocessing, quality checks and NORM-versus-MI CNN inference | Classification output is not a 10-year ASCVD estimate |
| Paper ECG | PDF/image digitization, calibration, waveform/interval extraction | Short printout segments are blocked from routine CNN classification |
| Report extraction | PDF/image text extraction, OCR, rule-based fields and unit mapping | Extracted values require verification; uploads are not automatically verified longitudinal measurements |
| Consultations and prescriptions | Structured records, medication items and PDF generation | Prescribing decisions remain with the clinician |
| Authentication/audit | Password hashing, JWTs and audit records | Existing legacy endpoints are not uniformly authorized; do not expose publicly as-is |
| Consultation transcription | Extraction from supplied transcript text | Missing transcript text currently invokes simulated dialogue, not speech recognition |
| Other disease branches | Orchestrator contains glaucoma, MODY and Fabry identifiers | Corresponding model bundles are absent; some older training commands reference missing modules |

See [project review](./PROJECT_REVIEW.md) and
[longitudinal validation](./LONGITUDINAL_VALIDATION.md) for findings and limitations.

## 2. Repository map

```text
MEDIS/
  api.py                         Combined FastAPI gateway, including legacy inference
  app.py                         Python/Uvicorn launcher
  setup_check.py                 Dependency, model and optional training-data checks
  train_real.py                  CAD/ECG training commands; see supported commands below
  medis/
    config.py                    Project-relative data/model/output paths
    main.py                      Clinical REST endpoints and database initialization
    database/                    SQLAlchemy models, sessions and Pydantic request schemas
    auth/                        Credentials, JWTs, password hashing and audit utilities
    patients/                    Patient/doctor/visit/prescription ID generation
    consultations/               Visit creation, measurements, symptoms, notes and timeline
    prescriptions/               Medication records and prescription PDFs
    uploads/                     Uploaded documents and medical-report records
    recordings/                  Consent, recording storage and transcript extraction
    reports/                     Consolidated medical-history PDF generation
    ai/
      longitudinal_analysis.py   Database report service and pure timeline orchestration
      trajectories.py            Daily medians, data validation and robust temporal slopes
      visit_patterns.py          Cross-visit descriptive screening
      seasonality.py             Annual BP association screening
      ascvd.py                   Explicit legacy PCE comparison
    predict.py                   Single-assessment orchestration: tabular/OCR/ECG/notes
    common.py                    Tabular model bundles, training and explanations
    cad_tabular.py               UCI CAD tabular training
    ecg.py                       ECG training and lower-level prediction
    ecg_inference.py             Unified file-based ECG entry point
    ecg_preprocessing.py         Signal preparation and normalization
    ecg_validation.py            Signal/lead quality checks
    ecg_pdf_digitizer.py          PDF waveform extraction and intervals
    ecg_image_digitizer.py        Image digitization
    ecg_explanation.py           Model explanation helpers
    ecg_fidelity.py               Waveform fidelity checks
    ecg_visualization.py         Diagnostic figures
    report_extraction.py         OCR and laboratory-field extraction
    symptom_extraction.py        Structured extraction from notes
    fusion.py                    Feature merging and experimental probability fusion
    risk_flags.py                Single-assessment screening flags
    synth.py                     Synthetic data helpers
  models/
    ecg_cnn.keras                Available ECG CNN
    ecg_cnn_norm_params.json     Matching training normalization statistics
  scratch/test_assess_integration.py  Manual digital-versus-printout demonstration
  test_longitudinal_engine.py    Pure analysis regression tests
  test_visit_patterns.py         Patterns, persistence and query-count tests
  test_web_app.py                Isolated backend route/workflow tests
  data/                         Local database, source data and uploaded records
  outputs/                      Generated PDFs, plots and evaluation artifacts
  logs/                         Runtime/audit logs
```

Preserve package paths and `__init__.py` files. Import services through `medis`;
do not flatten source files into another project's root.

## 3. Setup on a teammate's machine

The existing development environment uses **Python 3.13.3 on Windows**. A complete
fresh-machine dependency lock has not been validated. The commands below provide
an explicit bootstrap, not a reproducible lockfile. Check TensorFlow wheel support
for the target OS/Python combination before choosing a different runtime.

Run commands from the project root. Create a new environment; do not share `ecg_env/`.

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install fastapi uvicorn SQLAlchemy "pydantic>=2,<3" PyJWT python-multipart email-validator reportlab numpy pandas scipy scikit-learn matplotlib joblib
# ECG, digitization and report extraction:
.\.venv\Scripts\python.exe -m pip install tensorflow wfdb opencv-python Pillow pdfplumber pypdfium2 pytesseract pdf2image
# Existing TestClient-based integration tests:
.\.venv\Scripts\python.exe -m pip install httpx
```

Additional dependencies:

- Install the **Tesseract executable** and put it on PATH for OCR. The Python
  `pytesseract` package alone is insufficient.
- `pdf2image` paths require Poppler executables; `pypdfium2` is used by other PDF paths.
- `shap` and `xgboost` are optional explanation/training dependencies where invoked.
- PostgreSQL needs its matching SQLAlchemy DBAPI driver. For example, install
  `psycopg[binary]` when using a `postgresql+psycopg://...` URL.
- After successful installation and tests, capture the validated environment with
  `python -m pip freeze > requirements-validated.txt`, review it, and share that
  file with the handoff. No validated lockfile currently ships with this project.

```powershell
.\.venv\Scripts\python.exe setup_check.py
.\.venv\Scripts\python.exe setup_check.py --ecg
# Only when preparing to train:
.\.venv\Scripts\python.exe setup_check.py --training
```

The checker returns a nonzero exit status for missing/broken requirements. It checks
the broad runtime, including OCR, even if you only intend to use longitudinal analysis.
Earlier local checks found missing OCR/email-validation dependencies; do not assume
copying source files alone creates a complete environment.

## 4. Configuration and storage

| Variable | Behavior |
|---|---|
| `DATABASE_URL` | Defaults to SQLite at `data/medis.db`; set before importing database modules |
| `MEDIS_SECRET_KEY` | JWT signing key; set a new secret for each deployment; never use the source default outside local tests |
| `MEDIS_HOST` | Launcher bind address, default `127.0.0.1` |
| `MEDIS_PORT` | Launcher port, default `8000` |

```powershell
$env:DATABASE_URL = 'sqlite:///C:/MEDIS-local/integration.db'
# Set MEDIS_SECRET_KEY securely in your environment; do not commit it.
.\.venv\Scripts\python.exe -m uvicorn api:app --host 127.0.0.1 --port 8000
```

Create the directory for a custom SQLite path first. Configuration is read from
process environment variables; do not assume `.env` files are automatically loaded.
The existing launcher also supports `python app.py`.

`init_db()` creates missing tables with SQLAlchemy `create_all`; it is **not a
schema migration system**. There are 24 mapped table classes in
[models.py](./medis/database/models.py). Use a fresh integration database, then add
reviewed migrations before evolving a deployed schema. SQLite behavior does not
prove PostgreSQL compatibility; test that configuration separately.

Generated prescription/history PDFs, uploaded records, audio and audit logs use
local filesystem storage. Preserve source/model directory relationships and configure
appropriate writable storage before moving to a service/container deployment.

## 5. Integration options

### A. Import Python services into the teammate's backend

This is the cleanest option when the teammate already owns routing and authentication.
Copy the `medis` package, models and documentation while preserving their layout.
Your teammate supplies authorization, request validation, storage policy and error
handling around service calls. There is no packaging configuration for `pip install .`;
keep the repository root importable or package it explicitly.

A pure longitudinal example needs no existing patient database:

```python
from medis.ai.longitudinal_analysis import assess_timeline

visits = [
    {"visit_id": "demo-1", "date": "2026-01-01", "hospital": "Hospital A",
     "measurements": {"ldl_cholesterol": 95, "systolic_bp": 124}},
    {"visit_id": "demo-2", "date": "2026-10-01", "hospital": "Hospital B",
     "measurements": {"ldl_cholesterol": 155, "systolic_bp": 148}},
]
report = assess_timeline(visits, as_of="2026-11-03")
print(report["review_priority"])  # REVIEW
print(report["metric_trajectories"]["ldl_cholesterol"]["percent_change"])  # 63.16
```

Visits require a unique `visit_id` and valid date. Optional keys include
`hospital_id`, `symptoms`, `prescriptions` and `measurement_units`. Use standardized
units: lipids/glucose/creatinine in mg/dL, BP in mmHg, HbA1c in %, BMI in kg/m2,
and eGFR in mL/min/1.73m2. Missing values should be `None` or absent, not zero.
An omitted unit is interpreted as the schema unit; upstream conversion is essential.
See [trajectory definitions](./medis/ai/trajectories.py) and
[pattern tests](./test_visit_patterns.py) for the full accepted structures.

For existing persisted patients:

```python
from medis.database.connection import SessionLocal, init_db
from medis.ai.longitudinal_analysis import generate_longitudinal_cad_report

init_db()
with SessionLocal() as db:
    report = generate_longitudinal_cad_report("YOUR_PATIENT_ID", db, persist=False)
    if "error" in report:
        raise ValueError(report["error"])
```

`persist=False` is important for read-only integration. The service defaults to
`persist=True`, which saves and commits an assessment. Several other service
functions also commit internally; review transaction ownership before composing them
inside a larger transaction. The database report selects observations by visit date.

For ECG files:

```python
from medis.ecg_inference import analyze_ecg

result = analyze_ecg("path/to/record.hea")
# Keep the header's referenced signal files beside it.
print(result.get("status"))
print(result.get("classification"))
```

Use status and quality fields before consuming classification. `classification`
can be absent or `None`. Do not turn blocked/failed inference into a zero-risk result.
Keep experimental short-signal CNN overrides disabled in normal use. Some results
contain NumPy arrays; convert them to JSON-safe lists and nonfinite values to `null`
when exposing your own API. [json_safe](./medis/web/routes.py) demonstrates this.

### B. Call the existing FastAPI service

Use `api:app` for the combined service. `medis.main:app` contains clinical routes
but does not add the legacy `/predict`, `/ocr` and `/ecg` gateway routes.
Inspect `/openapi.json` or `/docs` for exact current request and response schemas.

| Endpoint | Purpose |
|---|---|
| `GET /health`, `GET /api/health` | Health checks |
| `POST /api/auth/{patient,doctor}/register` | Create account/profile; actual paths use `patient` or `doctor` |
| `POST /api/auth/{patient,doctor}/login` | Receive JWT and account identity |
| `GET /api/patients/{patient_id}` | Patient metadata |
| `POST /api/consultations/start` | Create visit |
| `POST /api/consultations/{visit_id}/symptoms` | Structured symptom record |
| `POST /api/consultations/{visit_id}/measurements` | Vitals/labs |
| `POST /api/consultations/{visit_id}/notes` | Consultation notes |
| `GET /api/patients/{patient_id}/timeline` | Aggregated history |
| `POST /api/prescriptions/create` | Prescription creation |
| `GET /api/patients/{patient_id}/prescriptions` | Prescription list |
| `GET /api/prescriptions/{prescription_id}/pdf` | Prescription document |
| `POST /api/uploads/patient-document` | Patient document upload |
| `POST /api/uploads/medical-report` | Medical report upload |
| `GET /api/ai/longitudinal/{patient_id}` | Read-only progression report |
| `POST /api/ai/longitudinal/{patient_id}` | Doctor-authenticated report with explicit legacy PCE snapshot |
| `POST /api/ecg/analyze` | Doctor-authenticated multipart preview; WFDB companion files supported |
| `GET /api/reports/patient-history/{patient_id}/pdf` | Consolidated PDF |
| `GET /api/audit/logs` | Audit retrieval; requires deployment authorization hardening |
| `POST /predict` | Legacy JSON patient-dictionary assessment |
| `POST /ocr` | Legacy single-file OCR |
| `POST /ecg` | Legacy NumPy-file prediction; not the unified ECG file-analysis route |

Send `Authorization: Bearer <token>` where enforced. Authentication exists, but
many existing clinical GET/POST routes currently lack authorization enforcement.
Protect all patient operations and enforce patient/hospital access before deployment.

**Packaging dependency:** the unchanged combined gateway imports
[medis/web/routes.py](./medis/web/routes.py), which also registers backend endpoints
and mounts a static directory. Keep `medis/web/` in an unchanged gateway handoff,
even if the teammate never uses its presentation assets. For a strictly backend-only
source subset, import services directly and provide your own FastAPI entry point;
simply deleting that directory will break the existing gateway. No presentation
integration is required for option A.

## 6. Longitudinal output contract

- `review_priority`: `URGENT_REVIEW`, `REVIEW`, `INSUFFICIENT_DATA`, or
  `NO_FLAGGED_PROGRESSION`. `risk_category` currently aliases this field for
  compatibility; it is **not** a probability category.
- `metric_trajectories`: daily source evidence, endpoint delta, percentage change,
  robust slope, direction, sample count, time span and freshness.
- `clinical_flags` / `visit_patterns`: descriptive findings and dated evidence.
- `data_quality` / `coverage`: excluded, stale, conflicting or insufficient data.
- `absolute_risk`: separate legacy PCE result, status, missing inputs and limitations.
- `observations` / `recommendations`: explanatory text requiring clinical review.
- `engine_version`, `as_of`, and, for database reports, `assessment_id`: provenance.

Theil–Sen slopes reduce sensitivity to isolated outliers; measurements on the same
date are summarized by their median. Slopes need at least 30 days; measurements
older than 365 days do not establish current status. These are engineering rules,
not calibrated outcome models. Annual BP screening uses held-out calendar years.

PCE requires confirmed model sex/cohort, age, total cholesterol, HDL, systolic BP,
BP treatment, diabetes, current smoking, known ASCVD and snapshot date. See
[LegacyRiskInputs](./medis/web/routes.py) and [PCE implementation](./medis/ai/ascvd.py).
Do not infer these flags from missing records or combine unrelated measurement dates.
PCE, ECG classification and CAD tabular classification have different outcomes and
must not be presented as interchangeable probabilities. PREVENT remains pending.

## 7. Model inventory: exactly what to share

Only these two files are currently present in `models/`:

| Artifact | Size | Requirement |
|---|---:|---|
| [ecg_cnn.keras](./models/ecg_cnn.keras) | 520,132 bytes | Required for the available ECG CNN |
| [ecg_cnn_norm_params.json](./models/ecg_cnn_norm_params.json) | 691 bytes | Share with the exact matching CNN; contains training normalization statistics |

SHA-256 hashes for this handoff inventory:

```text
6101B3600C5AA03F0CC344724BD4FBC36CE87D56F915B8BCB12B260CCB77BC02  ecg_cnn.keras
CFC6A2EF0C5F007F903017CCD5606E3F781106DD28FDEAA08831B8817B87F70B  ecg_cnn_norm_params.json
```

Verify after transfer with `Get-FileHash models/* -Algorithm SHA256`.
Do not rename either file independently. Model preprocessing expects canonical lead
order I, II, III, aVR, aVL, aVF, V1–V6, with the inference pipeline preparing the CNN
input at 100 Hz / 1,000 samples. Signal duration/lead/unit provenance must be checked;
resampling arbitrary samples does not establish a valid 10-second recording.

The generic bundle loader also looks for `models/<name>.joblib`, including
`cad_tabular`, `ecg_rf`, `glaucoma_clinical`, `mody` and `fabry` where invoked.
**These bundles are not present.** The orchestrator may skip unavailable branches;
a successful request does not prove every disease model executed. Train or obtain
compatible bundles before promising those outputs. Only load trusted serialized models.

The stored [ECG metrics](./outputs/ecg_metrics.json) can accompany the model as
historical evaluation evidence, but this handoff does not reproduce training or
verify that the metrics belong to the exact supplied weights. They are not evidence
of prospective clinical performance. Longitudinal screening needs no learned model file.

## 8. The integration script you selected

[scratch/test_assess_integration.py](./scratch/test_assess_integration.py) calls
`medis.predict.assess(patient, ecg_path=...)` twice and prints results:

1. Digital record stem `data/ptbxl/records100/00000/00001_lr`.
2. Printout fixture `outputs/test_ge_3x4_simult.pdf`.

For an unchanged run, provide the digital record's `.hea` and **every signal file
named by that header**, plus the printout fixture, model and normalization file.
Alternatively, change the two paths to approved local examples.

```powershell
.\.venv\Scripts\python.exe scratch/test_assess_integration.py
```

Run from the repository root because its paths and `sys.path` modification are
relative. It is a **manual demonstration**, not an assertion-based regression test.
It indexes nested output fields directly and can fail when input files, models or
digitization results are missing. A failed or blocked result must be handled explicitly
in production integration. Do not share patient recordings as sample fixtures.

## 9. Testing and training

Focused tests use synthetic/in-memory scenarios and temporary storage:

```powershell
.\.venv\Scripts\python.exe -m unittest test_longitudinal_engine test_visit_patterns test_web_app -v
```

The last longitudinal upgrade run passed **38 tests**. Coverage includes trajectory
regressions, missingness, seasonality controls, legacy PCE examples, authorization,
persistence behavior and PDF creation. ECG inference is mocked in the route test;
this suite does not validate CNN accuracy. Some legacy demo scripts create or modify
application records. Read them before running against any non-disposable database.

Training is optional for teammates using the supplied CNN:

```powershell
python train_real.py cad
python train_real.py ecg 6000
python train_real.py ecg_cnn 6000 25
# Larger run, only with the appropriate dataset/resources:
python train_real.py ecg_cnn all 30
```

- CAD training expects four UCI Heart Disease `processed.*.data` site files under
  `data/uci/`. Dataset: https://archive.ics.uci.edu/dataset/45/heart+disease
- ECG training expects PTB-XL metadata (`ptbxl_database.csv`, `scp_statements.csv`)
  and signal records under `data/ptbxl/`. Source: https://physionet.org/content/ptb-xl/1.0.3/
- Preserve train/validation/test provenance and normalization alongside new weights.
  Training can overwrite existing artifacts; back them up first.
- `train_real.py fusion` is a pseudo-paired experiment, not validated patient-matched
  multimodal learning. It requires the tabular/RF bundles first.
- Older `modules`/`glaucoma_img` usage text is not a guarantee of implemented commands:
  the current `modules` branch imports an absent `medis.mody` module, and there is
  no implemented `glaucoma_img` branch. Do not include these in an integration runbook.

## 10. Teammate sharing checklist

### Share for the complete unchanged backend gateway

- [ ] `README.md`, `PROJECT_REVIEW.md`, `LONGITUDINAL_VALIDATION.md`.
- [ ] Entire `medis/` source package, preserving subdirectories and `__init__.py`;
      exclude caches. Retain its route-support dependency as explained in section 5.
- [ ] `api.py`, `app.py`, `setup_check.py`.
- [ ] Both files in `models/`, with hashes above.
- [ ] `test_longitudinal_engine.py`, `test_visit_patterns.py`, `test_web_app.py`.
- [ ] A reviewed, validated dependency snapshot when available.

### Add only if your teammate needs that capability

- [ ] `scratch/test_assess_integration.py` and its approved digital/PDF fixtures.
- [ ] `outputs/ecg_metrics.json`, `outputs/ecg_roc_curve.png`,
      `outputs/ecg_confusion_matrix.png`, `outputs/ecg_training_history.png` for
      historical model evaluation context, after checking provenance.
- [ ] `train_real.py` and licensed training data for retraining. Prefer original
      dataset downloads over distributing the entire local data folder.
- [ ] Other ECG/digitization test scripts and exactly the fixtures they require.
- [ ] Additional trained `.joblib` bundles only after they actually exist and their
      preprocessing, versions, feature schemas and evaluation are documented.

### Do not include in a routine code handoff

- `ecg_env/`, `.venv/`, `__pycache__/`, `*.pyc`, editor-local configuration.
- `data/medis.db` or database backups containing profiles, credentials or records.
- Uploaded medical reports, patient documents, consultation audio, `logs/`, audit
  exports, patient prescription/history PDFs, patient-specific ECG output files.
- Secrets, `.env` files, tokens or signing keys.
- The entire `outputs/`, `data/` or `scratch/` directory without reviewing contents.
  Use the explicit optional allowlist above instead.

For a service-only integration without the existing gateway, share the package
source needed by the imported services, models and tests; omit the gateway and
presentation assets only after confirming those imports are not used. A fresh test
database can be created from ORM models; the teammate does not need your local database.

## 11. Acceptance checklist for the receiving teammate

1. Create a fresh environment, set a new JWT secret and configure disposable storage.
2. Verify the two model hashes and dependency checks.
3. Run the isolated regression suite.
4. Run the pure timeline example and confirm `REVIEW`, LDL +63.16% and BP +24 mmHg.
5. Test a known-duration digital ECG and a printout; verify the printout CNN block
   and handle absent model output correctly.
6. Exercise account, visit, measurement and report APIs with test identities only.
7. Confirm authorization, consent, storage protection, migrations and error handling
   before integrating real patient records.

MEDIS is clinical decision-support research software. Neither its heuristic findings,
legacy risk estimates nor CNN outputs replace clinician assessment. Clinical validation,
population calibration, access-control hardening and verified PREVENT integration remain
separate work items; see the linked review documents for details.
