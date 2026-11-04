# MEDIS UI redesign

The redesign extends the existing React/Vite application, Supabase authentication
and data access, and FastAPI analysis endpoints. It does not replace the backend
or copy appointment or patient records into a second store.

## Implemented

- Shared login/registration shell, branding and ECG animation; role-specific
  registration, validation, password visibility and authentication feedback.
- Patient appointment cards with upcoming/history tabs, doctor and hospital
  information, expandable details, loading, retry and refresh. Patients make
  SELECT requests only; doctors keep the booking and management workflow.
- Opaque sticky headers and patient navigation, a desktop sidebar with scrolling
  only when needed, a focus-trapped mobile drawer, and scroll offsets for anchors.
  Dialogs and dropdowns sit above navigation; tall dialogs scroll within the viewport.
- Six doctor patient tabs through `?tab=overview|ecg|add-record|documents|visits|prescriptions`.
  Only the selected tab mounts its full content. Existing medication/history/report
  forms, consultation views, prescriptions, downloads and access history are retained.
- Dedicated ECG workspace with saved results, available reports, digital upload,
  supported document re-analysis and refresh. Digital files must be reselected to
  re-run because the service does not retain them. Blocked classifications stay blocked.
- Searchable medical documents, signed previews and report extraction. Applying
  extracted values remains restricted to an editable consultation after verification.
- PCE confirmation uses the existing analysis endpoint. It never assumes yes/no
  answers or combines prefills from different measurement dates. The engine remains
  responsible for applicability and validation; no percentage is shown for blocked results.
- Draft confirmation/deletion through a narrow database RPC. Failed deletion keeps
  the draft and count. Successful deletion updates the list and sidebar badge.
- Unified My Patients search, clear, review-priority filters and logged Open Record
  actions. `/doctor/search` redirects while retaining query parameters.
- Keyboard tab navigation, visible focus, reduced-motion support, clipboard error
  feedback, notification navigation/read feedback, and accessible chart readings.
  Missing chart measurements are skipped rather than plotted at zero.
- Unsaved record-form tab warnings and browser-unload warnings for consultations.
  Consultation saves also match the doctor and pending status to guard stale saves
  after another session finalizes the visit.

## Required database integration

Apply `supabase/supabase_migration_v7.sql` after v6 using the project's authorized
Supabase migration workflow. It has **not been applied to the connected database**
by this change.

The migration:

1. Adds database-maintained `consultations.updated_at`; existing unknown timestamps
   remain unknown until the next save.
2. Provides `delete_own_draft(uuid)`, executable only by authenticated callers. It
   verifies a doctor account, locks the consultation, verifies ownership and pending
   status, refuses consultations with prescriptions, and audits/deletes atomically.
   It adds no general consultation DELETE policy or grant.
3. Allows a patient to read professional details of doctors on that patient's
   appointments, using RLS. Appointment write permissions are unchanged.

Without v7 the frontend reports deletion as unavailable and does not remove any
draft locally. Optional appointment professional details may be unavailable under
the older policies; core appointment rows still display.

## Automated verification

From `frontend`:

```powershell
npm run build
npm run test:e2e
```

Playwright uses installed Google Chrome, starts an isolated Vite server on port
5180, and runs desktop (1440 px), tablet (820 px), and mobile (390 px) scenarios.
All Supabase and AI calls in these browser tests are intercepted with synthetic
fixtures. Test credentials and records do not reach a real backend. Tests cover
authentication and registration, appointments and errors, search and old links,
all six tabs, sticky offsets and opacity, analysis/extraction access, deletion
success/failure, read-only records, PCE confirmation, chart missingness and
keyboard access, notifications, and saving medication records.

From `backend`:

```powershell
python -m unittest test_longitudinal_engine test_visit_patterns test_patient_chat
```

The existing 43 backend tests passed. No backend engine logic changed.

## Deployment acceptance checks

Browser fixtures verify client behavior; they do not validate deployed RLS,
PostgreSQL migrations, or model accuracy. After applying v7, use disposable test
accounts to verify:

- Doctor-created appointments are visible only to their patient and authorized doctors.
- The owner can delete a pending draft; another doctor, a patient, and an anonymous
  caller cannot. Completed visits and consultations with issued prescriptions are refused.
- A concurrent finalize/save and delete cannot remove a finalized consultation.
- Failed RPCs leave both records and draft counts intact; successful deletion creates
  the audit entry. Issued prescriptions and uploaded patient documents survive.
- Secure previews, extraction, ECG upload, PDFs, and access logging work with the
  deployment's existing RLS and Storage policies.

OCR/scanned PDF features still require their existing external executables.
Gemini text features still require the existing backend API-key configuration.
