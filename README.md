<<<<<<< HEAD
# MEDIS — Medical Evaluation & Diagnostic Intelligence System

MEDIS is a multi-hospital electronic health record with digital consultations and AI-assisted, longitudinal screening for coronary artery disease (CAD).

Every patient gets one permanent **MEDIS Patient ID** that works at every hospital. A doctor opens a patient's record by searching that ID; the access is logged and shown to the patient. Visits, prescriptions, lab results and reports from all hospitals form one timeline. AI decision support then looks for worsening trends across those visits.

> **Decision support, not a diagnosis.** MEDIS is a college major project and a prototype. It is not a certified medical device; every AI output is labelled and the final decision rests with the doctor.

---

## Features

### For patients
- Register once and get a permanent Patient ID; complete a health profile (vitals, lifestyle, allergies, medications).
- See appointments, current medicines, every visit across hospitals, and the results doctors choose to share.
- Download prescriptions and a consolidated **medical history PDF**.
- Upload reports (PDF or any photo, including HEIC/WebP).
- See every doctor who opened the record (**access history**).
- **Heart health check:** a plain-language view of the AI screening, once the doctor shares it.
- **Ask MEDIS chatbot:** explains the patient's own shared results and medicines in simple words. It does not diagnose, and it shows an emergency notice for red-flag symptoms.

### For doctors
- Search a patient by ID, see the full multi-hospital record, and add medications, conditions, family history and reports.
- **Digital consultation:**
  - Complaints, including structured symptoms (chest pain type, severity, radiation, pain at rest, syncope, NYHA class).
  - Vitals and lab values.
  - Observations, diagnosis, prescriptions, then finalize and share with the patient.
- Red-flag alerts during the consultation (e.g. chest pain at rest, BP ≥ 180/120, SpO₂ < 90%).
- Appointments (booking, conflicts, follow-ups) and saved drafts.
- **Overview:** counts of **Critical** and **Needs review** patients, from each patient's latest AI check.

### AI decision support
| Feature | How it works |
|---|---|
| Longitudinal CAD screening | A rule-based trend engine across finalized visits (BP, lipids, glucose, HbA1c, BMI, kidney function, symptoms). The result is a review priority (Critical / Needs review / No concern found / Not enough data), **not a probability**. |
| Trend graphs | Per-metric charts with target ranges. Each point is linked to the visit and hospital it came from. |
| AI summary | Google Gemini writes a summary of the screening for the doctor. Numbers that cannot be traced back to the data are flagged for checking. |
| 10-year ASCVD risk | Pooled Cohort Equations (2013), only from inputs the doctor confirms. Not calibrated for Indian populations. |
| ECG analysis | Digital recordings (WFDB `.hea`/`.dat`/`.mat`, CSV, NPY): a 1D CNN (Normal vs MI), signal quality checks, intervals and the waveform for each lead. Photos and PDFs are digitised only: the CNN is deliberately not run on them, because it was not validated on printouts. |
| Lab report extraction | OCR (Tesseract) reads lab values from a report; the doctor verifies each value before it is applied. |

---

## Architecture

```
React + Vite frontend ──► Supabase (Auth, Postgres with row-level security, Storage)
        │
        └──────────────► FastAPI AI service (backend/server.py)
                              ├─ medis/ engine (trend screening, PCE, ECG CNN, OCR, PDFs)
                              └─ Google Gemini (summary, chatbot)
```

- **Supabase** is the system of record. Row-level security decides who sees what: a doctor only sees patients they have opened, and a patient only sees their own data and the visits a doctor has shared.
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
3. `supabase_migration_v4.sql` → `v5` → `v6` → `v7` → `v8`
4. Optional: `demo_seed.sql`, which loads the demo accounts and data

`v8` is required by the dashboards: it adds the per-event access history
(`log_patient_access`, `get_patient_access_events`), the richer visit
history (`get_patient_visits`, `get_patient_visit_details`), document
deletion (`delete_medical_report`) and `medical_reports.file_size_bytes`.

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
cd backend
python -m unittest test_longitudinal_engine test_visit_patterns
```

---

## Privacy and limitations

- **Gemini free tier:** Google may use what is sent to improve its products, so use demo data only. Real patient data needs a paid key.
- **ECG model:** the teammate's reported metrics are on 603 PTB-XL records: accuracy 89%, sensitivity 79%, specificity 95%, AUC 0.96. They have not been independently reproduced or validated on Indian patients. Recordings that fail the signal quality checks get no classification.
- **Trend screening and PCE** are deterministic rules. The review priority is a screening flag, never a probability or a diagnosis.
- **Secrets:** `.env` files are git-ignored. Never commit API keys.

## Documentation
- [docs/INTEGRATION_PLAN.md](docs/INTEGRATION_PLAN.md): how the AI engine was integrated, endpoints and migrations.
- [docs/UI_FEATURES_SPEC.md](docs/UI_FEATURES_SPEC.md): every screen, button and state.
- [backend/README.md](backend/README.md): engine internals, algorithms and model details.
=======
# MEDIS
MEDIS is an AI-powered platform for Coronary Artery Disease (CAD) screening. It integrates patient records, ECG analysis, medical report extraction, digital consultations, prescriptions, and long-term health tracking to help doctors assess cardiovascular risk and make informed clinical decisions.
>>>>>>> origin/main
