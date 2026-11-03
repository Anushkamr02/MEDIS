# MEDIS teammate handoff

Start with README.md for architecture, API contracts, models and setup.

## Quick start (PowerShell, from this extracted folder)

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements-bootstrap.txt
.\.venv\Scripts\python.exe setup_check.py --ecg
.\.venv\Scripts\python.exe -m unittest test_longitudinal_engine test_visit_patterns test_web_app -v
.\.venv\Scripts\python.exe -m uvicorn api:app --host 127.0.0.1 --port 8000
```

Install Tesseract and, for pdf2image paths, Poppler separately. Bootstrap dependency
versions are not locked and fresh-machine installation has not been validated.
Set a new MEDIS_SECRET_KEY in the process environment before starting the API.
Database tables and runtime storage are created locally; no existing patient database
is supplied. Use disposable test records. Existing authorization and clinical-validation
limitations are described in README.md and PROJECT_REVIEW.md.

## Included

- Full source package and unchanged gateway entry points.
- Both available ECG model artifacts and matching normalization JSON.
- Core regression tests, training entry point and manual ECG integration scripts.
- Four historical aggregate ECG evaluation artifacts (not newly reproduced).
- Documentation, bootstrap dependency list and per-file SHA-256 manifest.

The existing gateway requires medis/web/ for route registration and static-directory
mounting. Those support files are included so the unchanged entry point starts.
A teammate using their own backend may import services directly instead.

## Intentionally separate inputs

No training datasets, patient documents, database, audit logs, virtual environments,
private configuration or existing generated clinical reports are included.
The manual scratch/test_assess_integration.py script needs a PTB-XL record at
`data/ptbxl/records100/00000/00001_lr` (header plus referenced signal files).
Download it from the dataset source linked in README.md, retaining its license and
attribution, or adjust the script to an approved local example.
After obtaining that record, `python scratch/test_pipeline_upgrades.py` generates
the PDF fixtures, including `outputs/test_ge_3x4_simult.pdf`, used by the example.
The isolated core regression suite does not require those external ECG inputs.
Tabular .joblib model bundles are absent in the source project and are not included.

MANIFEST.csv records every packaged file except itself. The archive was reopened
and every listed file checked against its SHA-256 before delivery. The manifest is
an integrity inventory, not a clinical model certification. No application source
was changed to create this handoff.