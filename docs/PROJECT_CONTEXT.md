# MEDIS — project context map

A fast orientation for anyone (human or AI) picking up this codebase. It explains
how the pieces fit, where each feature lives, and the traps that are not obvious
from reading one file. Verified against the code at `main` @ `7c7c3d5` on
24 Nov 2026. For rules and conventions see [CLAUDE.md](../CLAUDE.md); for the IEEE
paper see [PAPER_CONTEXT.md](PAPER_CONTEXT.md).

---

## 1. One-paragraph summary

MEDIS (Medical Evaluation and Diagnostic Intelligence System) is a college
prototype of a **multi-hospital electronic health record**. Every patient has one
permanent MEDIS ID (`MEDIS-P-…`; doctors are `MEDIS-D-…`). Doctors at any
participating hospital record digital consultations, issue prescriptions and share
findings. Patients see their record, control which doctors may open it, and ask a
chatbot about it. A **rule-based longitudinal engine** reads every finalized visit
and returns a *review priority*, never a diagnosis or probability.

## 2. System shape

```
Browser (React 19 + Vite, frontend/)
  │  supabase-js with the user's session          │  aiRequest() + bearer token
  ▼                                                ▼
Supabase                                       FastAPI (backend/server.py, :8000)
  Auth · Postgres + RLS · Storage   ◄──────────  supa.py: REST calls with the CALLER's token
  (system of record, sole authz layer)            ├─ medis/ai/*        trend engine, PCE
                                                  ├─ medis/ecg_*       ECG CNN + digitizer
                                                  ├─ record_summary.py doctor summary (local)
                                                  └─ llm.py → Gemini   patient chat only
```

- Routine reads/writes (visits, prescriptions, appointments, uploads) go **straight
  from the browser to Supabase**. The backend is only called for computation and PDFs.
- The backend has **no service-role key**. Whatever RLS lets the signed-in user
  see is all the AI code can see. This is the core security property; keep it.

## 3. Roles and what each can do

| | Doctor (`/doctor/*`) | Patient (`/patient/*`) |
|---|---|---|
| Find record | Search by MEDIS ID → request access, or emergency access with reason ≥ 10 chars | — |
| Access control | Sees only patients with an active `doctor_patient_assignments` row | Approves / declines requests, revokes later, sees access history |
| Visits | Start, save draft, resume, delete own draft, finalize, share | Sees all visit metadata; clinical details only for shared visits |
| Prescriptions | Issue with a visit; edit only while the visit is a draft | View, download PDF |
| Reports | Upload, OCR lab values → verify → apply to a visit | Upload, see review status |
| AI | Trend check, summary, PCE, ECG, share assessment with a note | Heart health check (once shared), Ask MEDIS chat |

Route guard: [ProtectedRoute.jsx](../frontend/src/components/ProtectedRoute.jsx) with
`allowedRoles`; auth state in [context/AuthContext.jsx](../frontend/src/context/AuthContext.jsx).

## 4. Frontend map

Routes are defined in [App.jsx](../frontend/src/App.jsx).

| Route | File | Purpose |
|---|---|---|
| `/login`, `/register` | `pages/Login.jsx`, `pages/Register.jsx` | Login by email or MEDIS ID (v9 RPC) |
| `/patient` | `pages/PatientDashboard.jsx` | Overview, appointments, heart check, chat |
| `/patient/visits` · `prescriptions` · `documents` · `access` · `profile` · `onboarding` | `pages/patient/*`, `pages/MyProfile.jsx`, `pages/Onboarding.jsx` | |
| `/doctor` | `pages/doctor/DoctorOverview.jsx` | Critical / Needs-review counts from latest assessments |
| `/doctor/search`, `/doctor/patients` | `PatientSearch.jsx`, `MyPatients.jsx` | Request / emergency access |
| `/doctor/patients/:id` | `PatientProfile.jsx` | Full record + AI panels |
| `/doctor/patients/:id/consult`, `/doctor/consultations/:id` | `NewConsultation.jsx` | Consultation form (new / resume draft) |
| `/doctor/appointments`, `/doctor/drafts` | `DoctorAppointments.jsx`, `Drafts.jsx` | |

Key shared code:

- `hooks/usePatientData.js`, `hooks/useDoctorData.js`: own all fetching and refresh.
  Refresh through them after a mutation; don't patch local state.
- `lib/aiClient.js`: `aiRequest()` attaches the Supabase token and returns `{ data, error }`.
- `lib/patientAccess.js`: access requests, emergency access, audit logging
  (`logPatientAccess`), 60-second signed URLs for reports, legacy pre-v11 fallback.
- `lib/aiPriority.js`: the **only** place priority labels are spelled.
- `lib/dashboardCompatibility.js`: degrades gracefully when an older migration is live.
- `components/ai/*`: `AiInsights` (trend panel), `TrendChart`, `AiSummary`,
  `PceForm`, `EcgAnalysis`, `ShareAssessment`, `DocumentAiActions` (OCR).
- `components/ui.jsx`: shadcn-style Radix wrappers. Use these, not raw Radix.

## 5. Backend map

| Endpoint | Who | What it does |
|---|---|---|
| `GET /health` | any | Engine version and whether ECG model, Tesseract and Poppler are available |
| `POST /ai/longitudinal/{patient_id}` | doctor | Finalized visits (+ optional draft values) → `assess_timeline` → saves a `cad_assessments` row |
| `POST /ai/summary/{patient_id}` | doctor | **Local deterministic** summary (`record_summary.py`, model tag `record-summary-v2`) |
| `POST /ai/ecg/document/{id}`, `POST /ai/ecg/upload` | doctor | ECG from a stored report or uploaded digital files |
| `POST /ai/extract-report/{id}` | doctor | Tesseract OCR → candidate lab values for the doctor to verify |
| `GET /pdf/prescription/{id}` | both | Prescription PDF |
| `GET /pdf/history/{patient_id}` | both | History PDF (patient copy has shared visits only) |
| `POST /ai/chat` | patient | Ask MEDIS via Gemini; 30 questions/hour, last 10 turns of history |

Files:

- `server.py`: all endpoints; `audit()` writes through the `log_patient_access` RPC,
  and a failed audit write does **not** block the action.
- `supa.py`: thin Supabase REST client constructed per request with the caller's token.
- `adapters.py`: Supabase rows → engine visit dicts (`consultations_to_visits`).
- `llm.py`: Gemini client (`MEDIS_LLM_MODEL`, default `gemini-3.5-flash`), chat
  prompt/schema, `chat_context()`, `validate_chat_answer()` (rejects citations to
  sources not retrieved for that request), emergency-symptom regex.
- `history_pdf.py`: consolidated history PDF.
- `medis/`: the analysis package originally written by a teammate:
  - `ai/trajectories.py`: 11 metrics, unit/range validation, daily medians, Theil–Sen slope.
  - `ai/longitudinal_analysis.py`: `assess_timeline()` → flags + priority.
  - `ai/visit_patterns.py`: visit clusters, symptom escalation, prescription overlap/list change.
  - `ai/ascvd.py`: Pooled Cohort Equations (doctor-confirmed inputs only).
  - `ecg_*.py`, `models/ecg_cnn.keras`: 1D CNN, Normal vs MI, digital signals only.
  - `report_extraction.py`: OCR.
  - `web/routes.py`: still imported for `analyze_uploads` and `LegacyRiskInputs`.
    `auth/`, `database/` and `reports/` are leftovers of the teammate's standalone
    app (they read `DATABASE_URL` and `MEDIS_SECRET_KEY`) and are not on the live request path.

## 6. The longitudinal engine in brief

Input: one dict per visit `{visit_id, date, hospital, measurements{11 metrics}, symptoms, prescriptions}`.

1. **Normalize:** drop invalid, future or duplicate visits; sort by date.
2. **Per metric** (`total/ldl/hdl cholesterol, triglycerides, systolic/diastolic BP,
   fasting glucose, HbA1c, BMI, eGFR, serum creatinine`):
   - reject wrong unit or out-of-range values;
   - take the median per day;
   - span < 30 days → `SHORT_INTERVAL` (no annual rate);
   - last value > 365 days old → stale;
   - otherwise Theil–Sen slope × 365.25, sampling 200 points if there are more than 200 days;
   - direction comes from the fitted change vs a per-metric "material change".
3. **Flags:**
   - `ADVERSE_TRAJECTORY`, `ABNORMAL_RECORDED_VALUE`, `LOW_RECORDED_HDL`;
   - `SEVERE_RECENT_BP` (urgent);
   - symptom status;
   - `PRESCRIPTION_OVERLAP`.
4. **Priority:**
   - any urgent flag → `URGENT_REVIEW` ("Critical");
   - any other flag → `REVIEW` ("Needs review");
   - no metric with enough data for a trend → `INSUFFICIENT_DATA`;
   - otherwise `NO_FLAGGED_PROGRESSION`.

`visit_patterns` flags (e.g. `PRESCRIPTION_LIST_CHANGE`: consecutive lists within
90 days that differ) live in `report.visit_patterns`. They don't change the priority,
except `PRESCRIPTION_OVERLAP`.

## 7. Data model (Supabase)

Tables used by the app: `profiles` (role, `display_id`), `patient_profiles`,
`doctor_profiles`, `hospitals`, `doctor_patient_assignments` (`is_active`,
`access_status` pending/active/denied/revoked, `is_emergency`), `consultations`
(status `pending` = draft, `completed` = finalized; `is_shared_with_patient`; numeric
lab columns from v4), `prescriptions` (`medicines` JSON array, linked by
`consultation_id`), `appointments`, `medical_reports` (Storage bucket
`medical-reports`), `current_medications`, `patient_medical_history`,
`family_history`, `cad_assessments` (engine report, PCE, summary, sharing fields),
`ecg_analyses`, `chat_messages`, `notifications`, `audit_logs`.

Migrations: run by hand in the Supabase SQL editor, in order. `v1`–`v3b` predate this repo.

| Migration | Adds |
|---|---|
| v3c | Search-by-ID fix |
| v3d | Consultation fields, `cad` disease type |
| v3e | Doctor registration with a hospital |
| v3f | Shared history and doctor data entry |
| v4 | Numeric lab columns, AI tables |
| v5 | Summary columns, `chat_messages` |
| v6 | Sharing an assessment with the patient |
| v7 | Edit a prescription while its visit is a draft |
| v8 | Access events, visit RPCs |
| v9 | Login by MEDIS ID |
| v10 | `delete_own_draft` |
| v11 | Patient-controlled access |

RPCs the frontend calls: `search_patient_by_display_id`, `request_patient_access`,
`respond_access_request`, `revoke_doctor_access`, `log_patient_access`,
`get_patient_access_history`, `get_patient_access_events`, `get_patient_visits`,
`get_patient_visit_details`, `update_draft_prescription`, `delete_own_draft`,
`delete_medical_report`, `resolve_login_email`.

## 8. End-to-end flows (where to trace them)

- **Access request:**
  1. `MyPatients.jsx` calls `request_patient_access()`, which inserts a pending row.
  2. The patient sees it in `PatientAccess.jsx` and calls `respond_access_request()`.
  3. The row becomes active, and RLS now returns the record.
  
  An appointment the patient booked (`booked_by='patient'`, `status='scheduled'`)
  grants access directly. The `guard_assignment_write()` trigger turns any direct insert into a pending request.
- **Consultation:**
  1. `NewConsultation.jsx` inserts a `pending` row (a draft).
  2. The doctor can save and resume it, and prescriptions are written with `consultation_id`.
  3. Finalizing updates the row to `completed`, and the doctor can then toggle `is_shared_with_patient`.
- **Trend check:** `AiInsights` calls `/ai/longitudinal` (optionally with unsaved draft
  values), which saves a `cad_assessments` row. `ShareAssessment` sets the sharing columns,
  and the patient's `HeartHealthCheck` reads the shared row.
- **OCR:**
  1. The report is uploaded to Storage and `DocumentAiActions` calls `/ai/extract-report`.
  2. The doctor verifies each value, and it is applied to a consultation's lab columns, where it appears as a graph point.
- **Chat:** `PatientChat` calls `/ai/chat`.
  1. `patient_record_for_chat()` collects shared visits, active medicines, ≤ 10
     prescriptions, ≤ 5 appointments dated today or later, ≤ 20 document metadata rows,
     and the latest shared assessment.
  2. This context goes to Gemini.
  3. The service validates the citations and saves both messages.

## 9. Running and testing

```bash
# frontend (needs frontend/.env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL)
cd frontend && npm install && npm run dev             # :5173
npx playwright test --project=desktop                 # 53 e2e tests (Supabase/AI mocked)
node --test unit-tests/dashboardCompatibility.test.mjs src/lib/prescriptionDraft.test.js   # 8

# backend (needs backend/.env: SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY, ALLOWED_ORIGINS)
.venv/Scripts/activate && cd backend
python -m uvicorn server:app --port 8000
python -m unittest discover                           # 61 tests
python setup_check.py                                 # Tesseract / Poppler / model
```

Test files:

- Backend: `test_longitudinal_engine` (22), `test_visit_patterns` (12), `test_patient_chat` (9),
  `test_record_summary` (9), `test_access_audit` (6), `test_llm_service` (3).
- E2E specs: `access-control`, `dashboards`, `migration-compatibility`, `profile-setup`,
  `redesign`. Each spec runs in desktop, tablet and mobile projects, 159 tests in total.
  On the 24 Nov run, 8 of the 53 desktop tests failed.

Demo data comes from `supabase/demo_seed.sql`. Every account's password is `Demo@1234`.

| Account | Who | Use |
|---|---|---|
| `doctor1@demo.com` | Dr. Priya Mehta, Apollo | |
| `doctor2@demo.com` | Dr. Arjun Rao, Manipal | |
| `patient1@demo.com` | Rahul Sharma | The 4-visit worsening case: Jan / Mar / Jun / Oct 2026, LDL 95 → 155, March visit not shared |
| `patient2@demo.com` | Ananya Nair | 1 visit + an open draft |

## 10. How the project came together

MEDIS merges two codebases:

1. **The React + Supabase app (this team).** It provides accounts, IDs, RLS,
   consultations, prescriptions, appointments, notifications, storage and the audit log.
2. **A teammate's standalone Python app.** It had its own FastAPI + SQLAlchemy +
   JWT stack, a vanilla-JS UI and ML training code.

[INTEGRATION_PLAN.md](INTEGRATION_PLAN.md) records what was kept from each side:

- **Kept from ours:** auth, IDs, access control, consultations, storage, audit,
  notifications, and the live red-flag alerts in the consultation form.
- **Taken from theirs:** the trend engine, PCE, ECG CNN and digitizer, OCR, and the PDF generators.
- **Dropped:**
  - simulated speech transcription;
  - the tabular CAD, glaucoma, MODY and Fabry models (their files were absent);
  - probability fusion;
  - the teammate's own auth and database.

Only the engine modules were copied into `backend/medis/`. Consequences:

- **[backend/README.md](../backend/README.md), [HANDOFF.md](../backend/HANDOFF.md)
  and [PROJECT_REVIEW.md](../backend/PROJECT_REVIEW.md) describe the teammate's
  original app**, not this repo. `api.py`, `app.py`, `medis/main.py`, `predict.py`,
  `train_real.py`, `test_web_app.py` and the `/api/...` routes they list do not exist here.
  Their P0 "unauthenticated routes" findings apply to that app. Here, authorization is RLS.
  Their engine sections (§6 output contract, algorithms, the model inventory) are still accurate.
- `medis/web/routes.py` survives because `server.py` imports `analyze_uploads`,
  `json_safe` and `LegacyRiskInputs` from it. It imports SQLAlchemy models and JWT helpers,
  so those packages must be installed, but no SQLAlchemy database is used at runtime.
- `outputs/ecg_metrics.json` (the AUC 0.9578 / accuracy 0.8922 source) is not in
  this repo, so those ECG figures can't be reproduced from here.

## 11. Feature reality check (what is actually wired)

| Feature | State in the app |
|---|---|
| Patient-controlled access, emergency access, access history | Live (needs v11) |
| Consultation draft → finalize → share; prescriptions; drafts page | Live |
| Live red-flag alerts in the consultation form (`clinicalAlerts()` in `NewConsultation.jsx`) | Live, client-side only |
| Trend check (`AiInsights`) | Live. With unsaved draft values it runs as a **preview** (`save: false`) |
| Doctor summary | Live, local rules (`record_summary.py`), not an LLM |
| Share assessment → patient Heart health check | Live (needs v6); `notify_cad_assessment_shared` trigger notifies the patient |
| Report OCR → verify → apply | Live when Tesseract is installed (`/health` reports it) |
| ECG | Digital files run through the CNN. PDFs and photos are digitized only (`digitization_complete_cnn_blocked`) |
| Prescription / history PDFs | Live |
| Ask MEDIS chat | Live with `GEMINI_API_KEY`. Emergency regex adds a notice and flags the message, but **the LLM is still called** (the integration plan said it would skip the LLM) |
| 10-year ASCVD (PCE) | **Backend only.** `/ai/longitudinal` accepts `pce_inputs`, but `PceForm.jsx` is not imported anywhere, so the UI never sends them |
| Notifications | DB triggers + an hourly pg_cron appointment reminder; the bell refreshes on window focus (no realtime) |

Audit writes take two routes:

- The backend and `logPatientAccess()` use the `log_patient_access` RPC.
- `NewConsultation.jsx` inserts into `audit_logs` directly (start, save, finalize, share).

## 12. Gotchas and stale documentation

- **Doctor summary is not Gemini any more.** The README, the `server.py` module
  docstring and `SUMMARY_SYSTEM` / `summary_input()` in `llm.py` still describe a
  Gemini summary. The live endpoint uses `record_summary.summarize_records()`, so
  the remaining Gemini summary code is unused. Gemini is used **only** for patient chat.
- `SecureDocumentPreview.jsx` signs URLs for 300 s but is not imported anywhere.
  The live paths (`openStoredDocument`, `downloadStoredDocument`) use 60 s.
- The `demo_seed.sql` comment says Rahul's visits span "3 hospitals"; the data
  uses two (Apollo, Manipal).
- Pre-v11 databases fall back to granting access on open (`isLegacyAccessSchema`),
  so patient approval only exists where v11 is applied.
- The ECG CNN is deliberately **not** run on photos or PDFs (display-only digitizing).
  OCR and PCE values always pass a doctor confirm step. Do not "fix" either.
- Engine output is a review priority. Never surface it as a diagnosis or probability.

## 13. Further documentation

| File | Covers |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | Rules, conventions, migration notes |
| [INTEGRATION_PLAN.md](INTEGRATION_PLAN.md) | How the engine was integrated |
| [UI_FEATURES_SPEC.md](UI_FEATURES_SPEC.md) | Every screen and state |
| [DASHBOARD_PANELS.md](DASHBOARD_PANELS.md) | Dashboard panel behaviour |
| [UI_REDESIGN_VERIFICATION.md](UI_REDESIGN_VERIFICATION.md) | Redesign checks |
| [backend/README.md](../backend/README.md) | Engine internals (also describes the teammate's original app; see §10) |
| [backend/LONGITUDINAL_VALIDATION.md](../backend/LONGITUDINAL_VALIDATION.md) | Engine validation |
| [PAPER_CONTEXT.md](PAPER_CONTEXT.md) | IEEE paper status and verified evidence |
