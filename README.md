# MEDIS — Medical Evaluation & Diagnostic Intelligence System

MEDIS is a multi-hospital electronic health record with digital consultations and AI-assisted, longitudinal screening for coronary artery disease (CAD).

Every patient gets one permanent **MEDIS Patient ID** that works at every hospital. A doctor finds a patient by that ID and asks for access; the record opens once the patient approves, and every access is logged and shown to the patient. Visits, prescriptions, lab results and reports from all hospitals form one timeline. AI decision support then looks for worsening trends across those visits.

> **Decision support, not a diagnosis.** MEDIS is a college major project and a prototype. It is not a certified medical device; every AI output is labelled and the final decision rests with the doctor.

---

## Features

### For patients
- Register once and get a permanent Patient ID; complete a health profile (vitals, lifestyle, allergies, medications).
- See appointments, current medicines, every visit across hospitals, and the results doctors choose to share.
- Download prescriptions and a consolidated **medical history PDF**.
- Upload reports (PDF or any photo, including HEIC/WebP).
- **Control who can open the record:** approve or decline a doctor's access request, and revoke any doctor later. Emergency access is flagged with the reason the doctor gave.
- See every doctor who opened the record (**access history**).
- **Health summary from your doctor:** a plain-language summary a doctor wrote, reviewed and published. Patients never see raw AI output: no review priority, risk percentage, flag or ECG result.
- **Ask MEDIS chatbot:** explains the patient's own shared results, medicines and published summary in simple words. It does not diagnose, and it shows an emergency notice for red-flag symptoms. Each reply can be marked 👍 / 👎, and its source chips jump to the visit or prescription they cite.

### For doctors
- Search a patient by ID and request access; once the patient approves, see the full multi-hospital record and add medications, conditions, family history and reports. **Emergency access** opens the record at once, needs a written reason, and is shown to the patient.
- **Digital consultation:**
  - Complaints, including structured symptoms (chest pain type, severity, radiation, pain at rest, syncope, NYHA class).
  - Vitals and lab values.
  - Observations, diagnosis, prescriptions, then finalize and share with the patient.
- Red-flag alerts during the consultation (e.g. chest pain at rest, BP ≥ 180/120, SpO₂ < 90%).
- Appointments (booking, conflicts, follow-ups) and saved drafts.
- **Overview:** a monitoring board — trend tiles, patients needing review, improving patients, follow-ups due, and overdue urgent findings pinned at the top.
- **Continuous monitoring:** every finalized visit, issued prescription and verified report re-checks the patient and saves an Improving / Stable / Worsening trend with dated reasons.
- **Clinical Insights (doctor only):** screening, monitoring, ECG and risk grouped together, with a recorded review for every significant finding, and publication of a patient-facing summary.
- **Find any patient** by MEDIS Patient ID from the search box in the top bar, on every doctor page.

### AI decision support
| Feature | How it works |
|---|---|
| Longitudinal CAD screening | A rule-based trend engine across finalized visits (BP, lipids, glucose, HbA1c, BMI, kidney function, symptoms). The result is a review priority (Critical / Needs review / No concern found / Not enough data), **not a probability**. |
| Trend graphs | Per-metric charts with target ranges. Each point is linked to the visit it came from, and its shape shows which hospital recorded it. |
| AI summary | Google Gemini writes a summary of the screening for the doctor. Numbers that cannot be traced back to the data are flagged for checking. |
| 10-year risk | The **2023 PREVENT** base model (total CVD, ASCVD and heart failure) with the legacy **2013 Pooled Cohort Equations** for comparison, both only from inputs the doctor confirms one by one. Neither is calibrated for Indian populations, neither is shown to patients, and neither is merged with the screening priority. `backend/test_prevent.py` pins PREVENT to its published worked examples. |
| ECG analysis | Digital recordings (WFDB `.hea`/`.dat`/`.mat`, CSV, NPY): a 1D CNN (Normal vs MI), signal quality checks, intervals and the waveform for each lead. Photos and PDFs are digitised only: the CNN is deliberately not run on them, because it was not validated on printouts. |
| Lab report extraction | OCR (Tesseract) reads lab values from a report; the doctor verifies each value before it is applied. |

---

## Architecture

```
React + Vite frontend ──► Supabase (Auth, Postgres with row-level security, Storage)
        │
        └──────────────► FastAPI AI service (backend/server.py)
                              ├─ medis/ engine (trends, monitoring, risk, ECG CNN, OCR, PDFs)
                              └─ Google Gemini (summary, chatbot)
```

- **Supabase** is the system of record. Row-level security decides who sees what: a doctor only sees patients who approved their access (or whom they opened under emergency access), and a patient only sees their own data and the visits a doctor has shared.
- **The AI service** calls Supabase with the **signed-in user's own token**, so the same access rules apply to AI features. It never uses a service-role key.

## Tech stack

- **Frontend:** React 19, Vite, React Router, Tailwind CSS v4, Radix UI / shadcn-style components, Recharts, lucide icons.
- **Backend:** Python 3.11, FastAPI, TensorFlow (ECG CNN), NumPy/SciPy, OpenCV, Tesseract OCR, ReportLab, `google-genai`.
- **Database:** Supabase (PostgreSQL, Auth, Storage, pg_cron).

## Project structure

```
backend/
  server.py           FastAPI AI service (all /ai and /pdf endpoints)
  adapters.py         Supabase rows → engine input formats
  history_pdf.py      Consolidated history PDF from Supabase data
  llm.py              Gemini prompts, JSON schemas, number check
  supa.py             Supabase REST client using the caller's token
  medis/              Analysis engine (trends, PCE, ECG, OCR, PDF generators)
  models/             Trained ECG CNN (ecg_cnn.keras)
  test_*.py           Engine tests
frontend/src/
  pages/              Patient and doctor pages (doctor/ = doctor portal)
  components/         UI, AI panels, forms, chatbot
  hooks/, lib/        Data loading, Supabase/AI clients, helpers
supabase/             SQL migrations and demo seed data
docs/                 Integration plan and UI feature spec
```

---

## Getting started

### Prerequisites
- Node.js 20+ and npm
- Python 3.11
- A Supabase project
- A Google Gemini API key (free at <https://aistudio.google.com/apikey>), for the AI summary and chatbot
- Optional, for OCR of photos and scanned PDFs:
  - [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki)
  - [Poppler](https://github.com/oschwartz10612/poppler-windows)
  - On Windows: `winget install UB-Mannheim.TesseractOCR oschwartz10612.Poppler`

### 1. Database (Supabase)
In the Supabase SQL editor, run the migrations in order:

1. `supabase_migration_v1.sql`, `v2`, `v3`, `v3b` (the base schema)
2. `supabase_migration_v3c.sql` → `v3d` → `v3e` → `v3f`
3. `supabase_migration_v4.sql` → `v5` → `v6` → `v7` → `v8` → `v9` → `v10` → `v11`
4. Optional: `demo_seed.sql`, which loads the demo accounts and data

Every migration is safe to re-run, so an existing database only needs the
ones it has not had yet.

The last four are each required by a feature:

- `v8` — the dashboards: per-event access history (`log_patient_access`,
  `get_patient_access_events`), the richer visit history
  (`get_patient_visits`, `get_patient_visit_details`), document deletion
  (`delete_medical_report`) and `medical_reports.file_size_bytes`.
- `v9` — signing in with a MEDIS ID (`resolve_login_email`).
- `v10` — deleting your own unfinished consultation (`delete_own_draft`).
- `v11` — patient-controlled access: `request_patient_access`, `respond_access_request`, `revoke_doctor_access`, and a trigger so nothing else can grant access. Without it, opening a record grants access at once as before.

### 2. Backend (AI service)
```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt

copy backend\.env.example backend\.env   # then set GEMINI_API_KEY
cd backend
python -m uvicorn server:app --port 8000
```
- The backend reads the Supabase URL and anon key from `frontend/.env` unless you set them in `backend/.env`.
- Check it at <http://localhost:8000/health>. `ecg_model`, `ocr` and `scanned_pdf` should be `true`.

### 3. Frontend
```bash
cd frontend
npm install
copy .env.example .env                 # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```
Open <http://localhost:5173>.

### Demo accounts (after `demo_seed.sql`)
All use the password `Demo@1234`.

| Role | Email |
|---|---|
| Doctor | doctor1@demo.com, doctor2@demo.com |
| Patient | patient1@demo.com (Rahul Sharma, with a 4-visit trend history), patient2@demo.com |

### Running the tests
```bash
cd backend && python -m unittest          # engine, endpoints, LLM and PDF tests
cd frontend && npm run build
cd frontend && npm run test:e2e           # Playwright, fully mocked
```

---

## Privacy and limitations

- **Gemini free tier:** Google may use what is sent to improve its products, so use demo data only. Real patient data needs a paid key.
- **ECG model:** the teammate's reported metrics are on 603 PTB-XL records: accuracy 89%, sensitivity 79%, specificity 95%, AUC 0.96. They have not been independently reproduced or validated on Indian patients. Recordings that fail the signal quality checks get no classification.
- **Trend screening** is a set of deterministic rules. The review priority is a screening flag, never a probability or a diagnosis.
- **Risk equations** (PREVENT 2023, PCE 2013) are population estimates from US cohorts, run only on clinician-confirmed inputs. They are not individual prognoses and are not calibrated for Indian populations.
- **Migrations v12–v16 must be applied by hand** in the Supabase SQL editor, in order. Features whose migration is not live hide themselves.
- **Secrets:** `.env` files are git-ignored. Never commit API keys.

## Documentation
- [docs/INTEGRATION_PLAN.md](docs/INTEGRATION_PLAN.md): how the AI engine was integrated, endpoints and migrations.
- [docs/UI_FEATURES_SPEC.md](docs/UI_FEATURES_SPEC.md): every screen, button and state.
- [docs/DASHBOARD_PANELS.md](docs/DASHBOARD_PANELS.md): what each dashboard panel shows.
- [backend/README.md](backend/README.md): engine internals, algorithms and model details.
