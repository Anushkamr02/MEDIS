# CLAUDE.md

Guidance for Claude Code when working in this repository.

For a full orientation (flows, endpoints, data model, stale-doc traps), read
[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md). For the IEEE paper, start with
the [short paper handoff](docs/PAPER_CONTEXT.md).

## What this project is

**MEDIS** — Medical Evaluation & Diagnostic Intelligence System. A multi-hospital
electronic health record with digital consultations and AI-assisted, longitudinal
screening for coronary artery disease (CAD). College major project / prototype —
**not** a certified medical device.

Core idea: every patient has one permanent MEDIS Patient ID that works at every
hospital. Visits, prescriptions, labs and reports from all hospitals form one
timeline, and a rule-based engine looks for worsening trends across those visits.

**Never present AI output as a diagnosis.** The engine returns a *review priority*
(Critical / Needs review / No concern found / Not enough data), never a probability.
Every AI surface in the UI is labelled as decision support, and the doctor decides.
Keep that framing in code, copy and comments.

## Architecture

```
React 19 + Vite frontend ──► Supabase (Auth, Postgres + RLS, Storage)   <- system of record
        │
        └──────────────────► FastAPI AI service (backend/server.py)
                                 ├─ medis/ engine (trends, PCE, ECG CNN, OCR, PDFs)
                                 └─ Google Gemini (Ask MEDIS patient chatbot)
```

Two rules that the whole design rests on:

1. **Supabase RLS is the only authorization layer.** A doctor sees only patients
   with an active `doctor_patient_assignments` row (`is_active`); a patient sees
   only their own data and what a doctor shared. Since v11 the *patient* grants
   that row: doctors go through `request_patient_access()` (request, or
   emergency with a reason), patients through `respond_access_request()` /
   `revoke_doctor_access()`. A guard trigger turns any other insert into a
   pending request, so never write the table directly.
2. **The AI service acts as the signed-in user.** `backend/supa.py` calls Supabase
   REST with the caller's own bearer token. There is **no service-role key** —
   do not introduce one. Frontend calls go through `aiRequest()` in
   [frontend/src/lib/aiClient.js](frontend/src/lib/aiClient.js), which attaches the
   Supabase session token and returns `{ data, error }` like supabase-js.
3. **No family or caregiver access.** Only the patient and doctors the patient
   granted access can read a record; `request_patient_access()` rejects any
   non-doctor account. The emergency contact is a phone number only: it gets no
   notifications and no data. Caregiver access would need explicit, scoped,
   revocable patient consent, audit of every use and no AI findings, and is out
   of scope. AI output (assessments, ECG classifications, reviews, queue,
   escalations) has no patient policy at all; patients see only summaries a
   doctor reviewed and published (v14). `supabase/governance_check.sql` checks
   all of this against a real database.

## Layout

```
backend/
  server.py            FastAPI app — all /ai and /pdf endpoints
  supa.py              Supabase REST client using the caller's token
  adapters.py          Supabase rows -> engine input formats
  record_summary.py    Local, deterministic prior-visit summary for doctors
  llm.py               Gemini prompts, JSON schemas, number-grounding check
  history_pdf.py       Consolidated history PDF
  medis/ai/            longitudinal_analysis, ascvd (PCE), visit_patterns, trajectories, seasonality
  medis/ecg_*.py       ECG preprocessing, validation, inference, PDF digitizer
  medis/report_extraction.py   Tesseract OCR of lab reports
  models/ecg_cnn.keras 1D CNN (Normal vs MI)
  test_*.py            unittest engine tests
frontend/src/
  pages/               patient pages; pages/doctor/ = doctor portal
  components/          UI kit (ui.jsx), ai/ panels, forms, chatbot
  hooks/               usePatientData, useDoctorData, useNotifications
  lib/                 supabaseClient, aiClient, aiPriority, format, patientAccess
  styles/theme.css     Tailwind v4 entry + design tokens
  tests/               Playwright e2e specs
supabase/              numbered SQL migrations + demo_seed.sql
docs/                  INTEGRATION_PLAN, UI_FEATURES_SPEC, DASHBOARD_PANELS, UI_REDESIGN_VERIFICATION
```

## Commands

```bash
# Frontend
cd frontend && npm install && npm run dev      # http://localhost:5173
npm run build
npm run test:e2e                               # Playwright

# Backend (from repo root venv)
.venv/Scripts/activate                         # Windows; POSIX: source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && python -m uvicorn server:app --port 8000
# http://localhost:8000/health -> ecg_model / ocr / scanned_pdf should be true

# Backend tests
cd backend && python -m unittest test_longitudinal_engine test_visit_patterns
cd backend && python setup_check.py            # verifies Tesseract/Poppler/model
```

The shell here is PowerShell; the Bash tool is also available. Use each tool's own syntax.

## Database / migrations

Migrations are plain SQL run by hand in the Supabase SQL editor, **in order**:
`v1, v2, v3, v3b, v3c, v3d, v3e, v3f, v4 … v15` (`v1`–`v3b` predate this repo's
`supabase/` folder). They are written to be **safe to re-run** (`create or replace`,
`if not exists`) — keep new ones idempotent and in a `begin; … commit;` block.

- `v8` — per-event access history (`log_patient_access`, `get_patient_access_events`),
  richer visits (`get_patient_visits`, `get_patient_visit_details`),
  `delete_medical_report`, `medical_reports.file_size_bytes`.
- `v9` — `resolve_login_email()`: log in with a MEDIS ID (returns the email only
  when the password also matches, so it can't be used for enumeration).
- `v10` — `delete_own_draft()`: a doctor may delete only their own unfinished consultation.
- `v11` — patient-controlled access: `access_status` on assignments, the request /
  respond / revoke functions, `guard_assignment_write()` trigger; access history
  RPCs return the request state and list `access_requested` / `emergency_access`.
  The frontend falls back to the pre-v11 upsert when the RPC is missing
  (`isLegacyAccessSchema` in `lib/patientAccess.js`).
- `v12` — continuous monitoring: trigger/trend/`monitoring` columns on `cad_assessments`,
  `monitoring_queue` (filled by triggers on finalized visits, prescriptions, verified reports),
  daily pg_cron `medis_monitoring_due`, doctor-only "Patient worsening" notifications.
  Processed by `POST /ai/monitor/{patient_id}` and `POST /ai/monitor/queue`; the backend
  falls back to saving without the new columns when v12 isn't applied (`missing_schema`).
- `v13` — `finding_reviews` (doctor-only, no patient policy) and `record_finding_review()`, which
  checks active access and writes the `reviewed_finding` audit row. Significance rule and outcome
  labels live in `lib/findingReview.js`; the review UI hides without v13.
- `v14` — patients can no longer read `cad_assessments`; `patient_health_summaries` (immutable, patient reads own
  non-withdrawn rows) written only by `publish_health_summary()` (requires a review when the assessment has a
  significant finding) and `withdraw_health_summary()`. Doctor UI `ai/PublishSummary.jsx`, patient card
  `HealthSummary.jsx`; both hide without v14.
- `v15` — escalation of unreviewed urgent findings (latest check Critical, validated ECG possible MI):
  `escalation_events`, `escalate_finding()`, insert triggers (level 0 at once) and hourly pg_cron
  `medis_escalate_urgent` (level 1 at 4 h, level 2 at 24 h; limits in `medis_escalation_after()`); every
  step is audited with no actor (`audit_logs.user_id` is now nullable) and stops once a review exists.
  Also adds `viewed_clinical_insights` to `log_patient_access()` and the access history. Labels in
  `lib/escalation.js`. Run `supabase/governance_check.sql` afterwards (it rolls back).

When a change needs schema, add the next numbered file **and** say in your summary
that the user must apply it in Supabase — nothing applies migrations automatically.
Code should degrade gracefully when an older schema is live (see
`frontend/src/lib/dashboardCompatibility.js` and `tests/migration-compatibility.spec.js`).

## Conventions

- **Terminology lives in one place.** Priority labels come from
  [frontend/src/lib/aiPriority.js](frontend/src/lib/aiPriority.js), access-status
  labels from `lib/accessStatus.js`; don't re-spell "Critical"/"Needs review"/
  "Pending approval" inline. Same spirit for date/number formatting in `lib/format.js`.
- **UI kit:** shadcn-style wrappers over Radix in
  [frontend/src/components/ui.jsx](frontend/src/components/ui.jsx) (`Button`, `Input`,
  `Dialog`, `SimpleSelect`, `Toaster`, …). Import from there instead of using Radix
  directly or hand-rolling a control.
- **Styling:** Tailwind v4 via `@tailwindcss/vite`, tokens and `clamp()` type scales in
  `styles/theme.css`. Toasts via `sonner`, charts via `recharts`, icons via `lucide-react`.
- **Data loading:** the `hooks/use*Data` hooks own fetching and refresh; pages consume them.
  After a mutation, refresh through the hook rather than patching local state, so stale
  warnings clear.
- **Comments** in this codebase explain *why* (a clinical rule, an RLS constraint, a
  browser quirk), not *what*. Match that density — it is moderate, not heavy.
- **Models not validated on an input are not run.** ECG photos and PDFs are digitised
  for display only; the CNN is deliberately not applied to printouts. Don't "improve"
  this by running it anyway.
- **OCR and PCE results are doctor-verified** before they are applied. Keep the
  confirm step in any new extraction flow.
- **Secrets:** `frontend/.env`, `backend/.env` are git-ignored. Never commit keys.
  Gemini runs on a free key, so demo data only.

## Known state (as of 2026-11-10, `main` @ 2934c15)

- Patient-controlled access (v11) was added on 2026-11-10: request / approve /
  decline / revoke, emergency access with reason. Doctor UI in `MyPatients.jsx`,
  patient UI in `pages/patient/PatientAccess.jsx`, e2e in `tests/access-control.spec.js`.
- Recent work: draft delete + confirm, optional medication rows, patient-data refresh
  after profile setup, duplicate ECG card removed from Patient Overview, AI check badges
  now open review reasons and evidence.

## Further reading

- [docs/INTEGRATION_PLAN.md](docs/INTEGRATION_PLAN.md) — how the engine was integrated, endpoints, migrations
- [docs/UI_FEATURES_SPEC.md](docs/UI_FEATURES_SPEC.md) — every screen, button and state
- [docs/DASHBOARD_PANELS.md](docs/DASHBOARD_PANELS.md) — dashboard panel behaviour
- [backend/README.md](backend/README.md) — engine internals, algorithms, model details
- [backend/LONGITUDINAL_VALIDATION.md](backend/LONGITUDINAL_VALIDATION.md) — trend engine validation
