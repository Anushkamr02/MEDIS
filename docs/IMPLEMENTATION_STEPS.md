# MEDIS improvement plan: implementation steps

This splits [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) into **14 steps**, to be built one after
another.

**How each step works**
- A step is one commit (or one PR) and leaves the app working.
- It finishes with tests passing and a short manual check.
- Section numbers like §2.3 point to IMPROVEMENT_PLAN.md.

**Migrations**
- Each step that changes the database ships its **own small migration**: v12, v13, v14 and so
  on. This replaces the single v12 described in the plan.
- Every migration is idempotent and wrapped in `begin … commit`.
- It must be **applied by hand in the Supabase SQL editor** before testing that step.
- The frontend keeps working on the older schema: new features hide until their migration is
  live.

**Open team questions**
- Until the team answers the questions in IMPROVEMENT_PLAN §10, each step uses the plan's
  default.
- The step lists the question it depends on, so an answer can be slotted in before that step
  starts.

## Progress

| Step | Status | Notes |
|---|---|---|
| 1 | Done (not yet committed) | 4 `redesign.spec.js` tests are now `test.fixme`. Their features were removed by earlier commits (see below). |
| 2 | Done (not yet committed) | `medis/ai/monitoring.py`, `medis/ai/drug_classes.py`, `test_monitoring.py` (18 tests). |
| 3 | Done (not yet committed) | `supabase_migration_v12.sql`, `run_assessment()`, `/ai/monitor`, `/ai/monitor/queue`, `test_monitor_endpoint.py` (6 tests). Treatment follow-up queue rows are added by the AI service rather than a SQL trigger, so the medicine list stays only in `drug_classes.py`. |
| 4 | Done (not yet committed) | `lib/healthTrend.js`, `lib/monitoring.js`, `TrendPill`, Trend column/filter/sort in My Patients, `MonitoringTimeline.jsx` on the profile, `tests/monitoring.spec.js` (4 tests). No trigger in `DocumentAiActions.jsx`: applied OCR values only fill the unsaved draft, so they are re-checked when the visit is finalized. |
| 5 | Done (not yet committed) | `useDueQueue` + `refresh`/trigger/treatments in `useLatestPriorities`; "Patient monitoring" board on `DoctorOverview.jsx` (4 tiles, Needs attention, Improving, Follow-ups due, queue processing); 2 tests added to `monitoring.spec.js`. Follow-ups due is read from the latest assessment's treatment responses, not queue rows, because processing the queue marks due follow-up rows as processed. |
| 6 | Done (not yet committed) | `supabase_migration_v13.sql`, `lib/findingReview.js` (Q5 rule, outcome labels), `FindingReview.jsx`, `ClinicalInsights.jsx`; review status on AI Insights, Monitoring, ECG and the Overview "Needs review" list; Appointments accepts `?reason=`; `tests/finding-review.spec.js` (3 tests). ECG interval flags (PR > 200 or < 120, QRS ≥ 120, QTc > 460 ms) count only on digital recordings that passed quality checks. My Patients does not show review status yet. |
| 7 | Done (not yet committed) | `llm.py` (doctor version + `patient_draft` schema, `summary_input()` with monitoring and without an assessment), `/ai/summary` (Gemini, `unverified_numbers`, `fallback_reason`), `AiSummary.jsx`, 4 backend tests in `test_record_summary.py`, `tests/ai-summary.spec.js` (3 tests). The patient draft is returned but **not stored**: a shared `cad_assessments` row stays patient-readable until v14, so step 8 should persist drafts once that policy is dropped. |
| 8 | Done (not yet committed) | `supabase_migration_v14.sql` (drops the patient policy on `cad_assessments` and the v6 share notification; `patient_health_summaries`; `publish_health_summary()`, `withdraw_health_summary()`; access history lists publish/withdraw), `PublishSummary.jsx` (replaces `ShareAssessment.jsx`), `HealthSummary.jsx` (replaces `HeartHealthCheck.jsx`), `lib/healthSummary.js`; patient history PDF prints the published summary; `/ai/summary` marks drafts with untraceable numbers `publishable: false` and stores the draft once v14 is live; `test_history_pdf.py` (3 tests), `tests/health-summary.spec.js` (3 tests). A review is required only when the assessment has a significant finding (Q5 rule, mirrored in SQL). Publishing a new version withdraws the previous one. Ask MEDIS still reads shared assessments until step 11, which returns no rows once v14 is applied. The demo seed has no assessments, so it needs no change. |
| 9 | Done (not yet committed) | `supabase_migration_v15.sql` (`escalation_events`, `escalate_finding()`, insert triggers for the immediate step, hourly `medis_escalate_urgent`, time limits in `medis_escalation_after()`, 7-day look-back so applying it doesn't alert on old findings); `lib/escalation.js`, `useEscalations`; red "Overdue urgent reviews" block pinned at the top of the Overview; escalation history on the Monitoring card; `tests/escalation.spec.js` (3 tests). Only the latest check / latest ECG per patient escalates, and only the highest new level notifies. Escalation audit rows have no actor, so v15 makes `audit_logs.user_id` nullable. |
| 10 | Done (not yet committed) | `viewed_clinical_insights` audited from `ClinicalInsights.jsx` (once per patient per 10 min; whitelist and access-history label in v15). Reviews, publish/withdraw and escalation already audit inside their RPCs/triggers. The patient dashboard no longer queries `ecg_analyses` (RLS returned nothing, but the UI was built to show classifications). `tests/governance.spec.js` (6 tests) and `supabase/governance_check.sql` (RLS checks as the demo accounts, rolled back). No-family/caregiver policy in CLAUDE.md and INTEGRATION_PLAN §11. |
| 11 | Done (not yet committed) | `supabase_migration_v16.sql` (`chat_messages.feedback`/`feedback_at`, `rate_chat_message()`); the chat context now reads the **published summary** (v14) and no longer touches `cad_assessments`; source entries carry the anchor of the record they cite (`llm.py chat_context`), `lib/chatSources.js` + `useRevealHash()` in `PatientLayout`, 👍/👎 in `PatientChat.jsx` (hidden without v16), anchors on the dashboard profile card, medications and health summary; `tests/chatbot.spec.js` (3 tests) and the updated `test_patient_chat.py` (10 tests). Chips point at existing DOM ids (`visit-<visit_id>`, `rx-<id>`), so no page layout changed. |
| 12 | Done (not yet committed) | Patient-ID search in the doctor top bar (`DoctorLayout.jsx`), which navigates to `/doctor/patients?q=…`; `MyPatients.jsx` also accepts `?id=`; per-hospital marker shapes and a key in `TrendChart.jsx`; `tests/doctor-ux.spec.js` (3 tests). `PatientSearch.jsx` stays a redirect — My Patients owns the lookup, so the search box reuses it instead of a second implementation. |
| 13 | Done (not yet committed) | `medis/ai/prevent.py` (2023 PREVENT base model, 10-year total CVD / ASCVD / heart failure), `test_prevent.py` (11 tests against the published worked examples), `POST /ai/risk/{assessment_id}` storing PREVENT under `pce.prevent` with who confirmed the inputs, `test_risk_endpoint.py` (6 tests), `ai/RiskForm.jsx` + `ai/RiskCard.jsx` on the Patient Profile, `tests/risk.spec.js` (4 tests). The entry point question from step 1 is answered: the card sits inside Clinical Insights, so both equations are doctor-only. `PceForm.jsx` was replaced by `RiskForm.jsx`, and the `redesign.spec.js` fixme for the old card now points at `risk.spec.js`. BMI may be left blank: heart failure is then reported as unavailable rather than guessed. |
| 14 | Done (not yet committed) | CLAUDE.md (architecture, layout, v16, risk conventions, Known state), README (patient/doctor features, risk row, test commands, limitations), `docs/UI_FEATURES_SPEC.md` (§2.10 chatbot, §3.10(3) hospital markers, §3.10(6) risk card), `docs/DASHBOARD_PANELS.md` (panels added since), `docs/INTEGRATION_PLAN.md` (PREVENT beside the PCE), and `IMPROVEMENT_PLAN.md` marked implemented. |

**Found during step 1: features that earlier commits removed**

These are now `test.fixme` in `tests/redesign.spec.js`, so each one needs a team decision: bring
it back, or delete its test.

| Removed feature | Removed in | Note |
|---|---|---|
| **ASCVD/PCE risk card** | `01ba245` ("Remove ASCVD risk card") | **Resolved in step 13:** `ai/RiskCard.jsx` renders inside Clinical Insights on the Patient Profile, with PREVENT (2023) as the default and the 2013 PCE behind "Compare". `PceForm.jsx` became `RiskForm.jsx`. |
| Chart "View measurement data" table and focusable chart points | `0145977` | Accessibility |
| Sticky header and tab bar | `0145977` | |
| Clicking a notification jumps to its section | `0145977` | Clicking now only marks it read. |
| Unsaved-edits warning on tab switch | `0145977` | |
| Arrow and Home keyboard navigation between patient tabs | `0145977` | Accessibility |

## Overview

| Step | Feature | Migration | Depends on | Team Q |
|---|---|---|---|---|
| 1 | Code-health cleanup | — | — | — |
| 2 | Monitoring engine (pure Python) | — | 1 | Q2, Q3 |
| 3 | Monitoring backend: schema, queue, `/ai/monitor` | **v12** | 2 | Q1 |
| 4 | Monitoring in the UI: triggers, trend column, Monitoring card | — | 3 | — |
| 5 | Doctor Overview monitoring board | — | 4 | — |
| 6 | Clinical Insights module + review of significant findings | **v13** | 5 | Q5 |
| 7 | Gemini AI summary (doctor version + patient draft) | — | 6 | Q4 |
| 8 | Doctor-reviewed publication + patient lockdown | **v14** | 6, 7 | Q8, Q9 |
| 9 | Escalation of urgent findings | **v15** | 6 | Q6, Q7 |
| 10 | Audit hardening + family/caregiver rules + governance tests | — | 8, 9 | — |
| 11 | Chatbot: feedback, source chips, published summaries | **v16** | 8 | — |
| 12 | Doctor UX: top-bar search, hospital markers | — | 1 | — |
| 13 | PREVENT 10-year risk | — | 6 | — |
| 14 | Docs and CLAUDE.md final pass | — | all | — |

Steps 12 and 13 are independent, so they can be done earlier or in parallel by another teammate.
Step 7 can also start early (see "Working in parallel" below).

## Working in parallel (two people)

**The split.** One person takes the **main chain**. The other takes the **side track**, which
touches different files.

| Main chain (person A) | Side track (person B) |
|---|---|
| 3 → 4 → 5 → 6 → 8 → 9 → 10 → 11 | 12 → 7 → 13, then help with 10 (tests) and 14 (docs) |
| Owns the migrations and `monitoring_queue` | Needs **no migrations** |

**Why this split is safe**
- Step 12 touches only `DoctorLayout.jsx`, `PatientSearch.jsx` and `TrendChart.jsx`.
- Step 7 touches `llm.py`, the `/ai/summary` endpoint and `AiSummary.jsx`.
  - It can start before the monitoring data exists.
  - Once step 3 is merged, person B adds the trend, reasons and treatment responses to
    `summary_input()`. That is a small follow-up PR.
- Step 13's maths (`medis/ai/prevent.py`, `test_prevent.py`) is a new file.
  - Only its UI entry point overlaps with the main chain.
  - The team must first decide where that entry point goes (see "Found during step 1").

**Rules that prevent most conflicts**
1. **One branch per step, from the latest `main`**, for example `step-03-monitoring-backend`.
   Keep each PR to one step. Merge `main` into your branch at least daily.
2. **Migration numbers are reserved.** Use the table at the end of this file. Only the main
   chain writes migrations. If the side track ever needs one, ask first and take the next free
   number. Never renumber a migration that has been merged.
3. **One shared Supabase project means one person applies migrations.**
   - Apply a migration only after its PR is merged, and post in the team chat when you do.
   - Code must keep working on the older schema, using the `dashboardCompatibility.js`
     pattern, so a teammate who hasn't pulled yet isn't broken.
4. **Hot-spot files: coordinate before editing.**
   - `backend/server.py`: add new endpoints in their own section; don't reorder or reformat
     existing code. Step 3's `run_assessment()` refactor should merge **before** step 7 edits
     the summary endpoint.
   - `frontend/src/pages/doctor/PatientProfile.jsx`, `components/ai/AiInsights.jsx` and
     `hooks/useDoctorData.js`: main chain only. The side track asks first.
   - `frontend/tests/fixtures.js`: only add new mock data; don't change existing entries.
   - `CLAUDE.md` and `docs/*`: update only the section about your own step. Step 14 does the
     full pass.
5. **Shared definitions are the contract.**
   - `TARGETS` in `medis/ai/monitoring.py` and the monitoring output shape are fixed by step 2.
   - Changing them needs a short note to the other person, because steps 4, 5 and 7 read them.
6. **Before every merge:**
   - `python -m unittest` in `backend/`;
   - `npm run build`;
   - `npm run test:e2e` in `frontend/`.

   A PR that leaves `main` red is reverted, not fixed forward.
7. **Never commit secrets.** `.env` files stay local. Each person uses their own Gemini key.

---

## Step 1: Code-health cleanup
**Goal:** a clean, fully green base before new features.

**Backend**
- New `backend/medis/ecg_upload.py` holding `MAX_FILE_BYTES`, `LegacyRiskInputs`, `json_safe`
  and `analyze_uploads`, moved from `medis/web/routes.py`.
- Change the import in `server.py`.
- Delete `medis/web/` and `medis/auth/`. **Keep `medis/database/`**, because `history_pdf.py`
  and the engine use its models.
- Update `backend/README.md`, `HANDOFF.md` and `MANIFEST.csv`, which mention the removed paths.

**Frontend**
- Fix the 8 stale tests in `tests/redesign.spec.js`: the login label is now "Email or MEDIS ID",
  and the tab names have changed.

**Done when**
- `python -m unittest` passes all 61 existing backend tests.
- `/health` still reports `ecg_model`, `ocr` and `scanned_pdf` as true.
- An ECG upload still works.
- `npm run test:e2e` is fully green, including `redesign`.

## Step 2: Monitoring engine
**Goal:** the logic that decides Improving / Stable / Worsening, with no database or UI yet
(§2.3).

**Backend**
- `backend/medis/ai/monitoring.py`: `assess_monitoring(report, previous_report, visits,
  prescriptions, as_of)` returns `health_trend`, `metric_changes`, `symptom_change`,
  `priority_change`, `treatment_responses` and `reasons`.
- `backend/medis/ai/drug_classes.py`: statins, blood-pressure medicines and glucose-lowering
  medicines, each with its target metric(s) and response window.
- The metric targets and minimum-change values go in one table, the single source of truth that
  the frontend will read later.

**Tests:** `backend/test_monitoring.py`
- Rahul's demo series comes out as Worsening.
- A statin followed by an LDL drop is responding / Improving.
- Noise smaller than the minimum change is Stable.
- A single visit is Not enough data.
- A prescription with no follow-up reading is awaiting follow-up, with a due date.
- A resolved symptom is Improving.
- A priority escalation alone is Worsening.

**Done when** all tests pass. Nothing user-visible changes in this step.

## Step 3: Monitoring backend (migration v12)
**Goal:** every finalized visit, prescription and verified report produces a saved monitoring
result (§2.2).

**Database: v12**
- New columns on `cad_assessments`: `trigger_event`, `trigger_ref`, `previous_assessment_id`,
  `health_trend`, `monitoring` (jsonb).
- New `monitoring_queue` table, with RLS for doctors with active access.
- Triggers that queue a patient when:
  - a visit moves to completed;
  - a prescription is inserted (plus a `treatment_follow_up` row with a `due_at` for each
    recognised medicine);
  - a report becomes verified.
- Daily pg_cron job `medis_monitoring_due`, which sends doctors a "follow-up due" notification.

**Backend**
- Factor `run_assessment()` out of `/ai/longitudinal`.
- New `POST /ai/monitor/{patient_id}` and `POST /ai/monitor/queue`. Both mark queue rows as
  processed and audit as `ai_monitoring`.
- `/ai/longitudinal` (manual Run analysis) also stores monitoring, with `trigger_event='manual'`.

**Tests**
- Endpoint tests with a fake Supabase client: the trigger is stored, the previous assessment is
  linked, queue rows are collapsed per patient, and a failure leaves the row queued.

**Done when**
- v12 is applied.
- Finalizing a visit in the SQL editor creates a queue row.
- Calling `/ai/monitor` saves an assessment with a `health_trend`.

## Step 4: Monitoring in the UI
**Goal:** doctors see the trend wherever they look at a patient.

**Frontend**
- `lib/healthTrend.js`: the labels, colours and arrows, defined once.
- `lib/monitoring.js`: `runMonitoring(patientId, trigger)`.
  - On success it shows a toast with the new trend.
  - On failure it shows a quiet "will update shortly", because the database already queued the
    patient.
- `runMonitoring` is called after:
  - finalize in `NewConsultation.jsx`;
  - issuing a prescription in `PrescriptionForm.jsx` (not draft edits);
  - applying OCR values in `DocumentAiActions.jsx`.
- `MyPatients.jsx`: a Trend column, a trend filter, `?trend=`, and sorting Critical first, then
  Worsening.
- `components/ai/MonitoringTimeline.jsx` on the Patient Profile, showing:
  - the timeline dots;
  - "Since last check";
  - treatment response.
- When v12 isn't applied, all of this is hidden (`dashboardCompatibility.js` pattern).

**Tests**
- `tests/monitoring.spec.js` with a mocked `/ai/monitor`: finalize shows the toast, and the Trend
  column and filter work.

**Done when** finalizing a visit for Rahul updates his trend in My Patients and on his profile.

## Step 5: Doctor Overview monitoring board
**Goal:** the dashboard becomes the monitoring screen (§2.1).

**Frontend**
- `useDoctorData.js` loads the latest assessment per patient (trend and monitoring) and the due
  queue items.
- `DoctorOverview.jsx` gets:
  - four trend tiles that link to My Patients;
  - a **Needs attention** list (worsening patients, for now; step 6 turns it into review status);
  - an **Improving** list;
  - a **Follow-ups due** list.
- When the Overview opens, it processes the queue through `/ai/monitor/queue` and shows
  "Updating N patients…".

**Tests:** extend `monitoring.spec.js` to cover the tiles, the lists and queue processing.

**Done when**
- After a reseed, doctor1's Overview shows Rahul as Worsening with dated reasons.
- Stopping the AI service, finalizing a visit, then restarting and reopening the Overview gets
  the patient processed.

## Step 6: Clinical Insights module + review of significant findings (migration v13)
**Goal:** all AI output is grouped as doctor-only, and significant findings need a recorded
review (§3.1 UI part, §3.3).

**Database: v13**
- `finding_reviews` table: `assessment_id` or `ecg_analysis_id`, `reviewed_by`, `reviewed_at`,
  `outcome`, `note`.
- RPC `record_finding_review()`. It checks the doctor has active access and writes the audit
  row itself.
- **No** patient policy on the new table.

**Frontend**
- The AI Insights, Monitoring and ECG cards are grouped under a **"Clinical Insights: doctor
  only"** header on the Patient Profile and the consultation page.
- Review dialog: the finding, its evidence, the outcome choice and a note. "Follow-up booked"
  opens Appointments with the form pre-filled.
- Overview **Needs attention → Needs review**: significant findings without a review.
- Every surface shows the review status.

**Default rule (Q5):** a finding is significant if it is Critical, Needs review, Worsening,
worsening on treatment, an ECG possible MI, or an ECG interval flag.

**Done when** reviewing Rahul removes him from Needs review and shows the outcome on his
profile.

## Step 7: Gemini AI summary
**Goal:** Gemini writes the doctor summary and a patient draft. The draft stays doctor-only
(§5).

**Backend**
- `llm.py`: new `SUMMARY_SYSTEM` and `SUMMARY_SCHEMA` (doctor version + `patient_draft`).
- `summary_input()` works without an assessment and includes the trend, reasons and treatment
  responses.
- `/ai/summary`:
  - calls Gemini and flags `unverified_numbers`;
  - falls back to `record_summary` on any Gemini error, with a `fallback_reason`.

**Frontend: `AiSummary.jsx`**
- Shows the doctor version and the "patient draft (not visible to the patient)" preview.
- Shows the unverified-number and fallback notes.
- Generates once; Refresh regenerates.

**Tests**
- `test_record_summary.py` and `test_llm_service.py`: a mocked Gemini response gives the new
  format, a 429 gives the fallback, and the draft never appears in any patient-readable field.

**Done when** Rahul's summary reads in plain words with dates, and works without a key (the
fallback note shows).

## Step 8: Doctor-reviewed publication + patient lockdown (migration v14)
**Goal:** patients see only what a doctor reviewed and published (§3.1 database part, §3.2).
This step closes the gap where a shared assessment exposes raw AI output.

**Database: v14**
- **Drop** the `cad_assessments: patient reads shared` policy.
- `patient_health_summaries` table, immutable, with the columns listed in §3.2. RLS: the patient
  reads only their own non-withdrawn rows.
- RPCs:
  - `publish_health_summary()`: requires a review of the linked assessment, notifies the
    patient, writes an audit row and an access-history event;
  - `withdraw_health_summary()`.

**Backend**
- The patient history PDF prints the published summary, not the AI section.
- `/ai/summary` refuses to treat unverified numbers as publishable.

**Frontend**
- `ShareAssessment.jsx` becomes **PublishSummary**:
  - the text starts from the Gemini patient draft (or blank);
  - the doctor picks the status message and ticks which measured values to show;
  - the doctor ticks "I have reviewed this";
  - Publish is blocked while there is no review or there are unverified numbers;
  - the doctor can withdraw a published summary.
- `HeartHealthCheck.jsx` becomes **"Health summary from your doctor"**, reading
  `patient_health_summaries`. It never shows the priority, the risk %, flags or ECG results.

**Default (Q8):** previously shared assessments become invisible to patients until a doctor
publishes a summary.

**Done when**
- As patient1, a direct REST query on `cad_assessments` returns **0 rows**.
- After doctor1 reviews and publishes, patient1 sees only the summary.
- Withdrawing it hides it again.

## Step 9: Escalation of urgent findings (migration v15)
**Goal:** urgent findings can't be quietly missed (§3.4).

**Database: v15**
- `escalation_events` table.
- Hourly pg_cron job `medis_escalate_urgent`. "Urgent" means Critical, ECG possible MI, or
  severe recent BP.
  - **Immediately:** an urgent notification to every doctor with access.
  - **At 4 h:** mark the finding overdue and notify again.
  - **At 24 h:** level 2.
  - Each step writes an audit row, and escalation stops once a review exists.
- The time limits are SQL constants.

**Frontend**
- Overdue urgent items are pinned in red at the top of the Overview, with a banner.
- The Monitoring card shows the escalation history.

**Done when** moving a finding's timestamp back 5 h and running the job by hand pins it as
overdue, and a review stops further escalation.

## Step 10: Audit hardening + family/caregiver rules + governance tests
**Goal:** prove the governance requirements hold (§3.5, §3.6).

- Audit **Clinical Insights viewed** when the doctor opens the module, using the existing
  `log_patient_access` pattern.
- Confirm that reviews, publish/withdraw and escalation are audited inside the RPCs and
  triggers.
- **Tests:**
  - `tests/governance.spec.js` covers:
    - a patient never receives AI fields;
    - publishing is blocked without a review;
    - withdrawing a summary hides it;
    - access is revoked straight away for the review, queue and summary tables;
    - a non-doctor can't be granted access.
  - A SQL check script: the patient role gets zero rows from `cad_assessments`, `ecg_analyses`,
    `finding_reviews`, `monitoring_queue` and `escalation_events`.
- Write the **no family/caregiver access** policy into CLAUDE.md and the docs.

**Done when** all governance tests pass.

## Step 11: Chatbot improvements (migration v16)
**Goal:** finish Ask MEDIS (§6).

**Database: v16**
- `chat_messages.feedback`.
- RPC `rate_chat_message()`.

**Backend**
- The chat context adds published summaries. Check that it never reads `cad_assessments`.

**Frontend**
- 👍 / 👎 in `PatientChat.jsx`. The buttons hide when v16 isn't applied.
- Source chips scroll to stable anchors in `VisitTimeline.jsx` and `PrescriptionsPanel.jsx`,
  closing the drawer first on mobile.

**Tests:** `test_patient_chat.py`, plus an e2e check of feedback and chip scrolling.

**Done when** a chip scrolls to and highlights the visit, and feedback is saved.

## Step 12: Doctor UX
**Goal:** small doctor-side gaps (§7). This step is independent of the others.

- Patient ID search box in `DoctorLayout.jsx`. It navigates to `/doctor/search?id=…`, and
  `PatientSearch.jsx` runs the search automatically.
- A marker shape per hospital, with a legend, in `TrendChart.jsx`.

**Done when** the search works from any doctor page, and Rahul's charts show distinct hospital
markers.

## Step 13: PREVENT 10-year risk
**Goal:** a newer risk equation alongside the 2013 PCE, and doctor-only (§7).

- `backend/medis/ai/prevent.py`, with `test_prevent.py` checking the published worked examples.
- Endpoint support, stored under `pce.prevent`.
- The form follows the `PceForm.jsx` confirm-every-input pattern, adding eGFR and BMI.
- Labelled "not calibrated for Indian populations".
- Never shown to patients and never merged with the trend or the priority.

**Done when** the example values match the published results, and the card renders on Rahul's
profile.

## Step 14: Docs final pass
- Update:
  - README;
  - CLAUDE.md (architecture, migrations v12–v16, Known state, governance rules);
  - `docs/UI_FEATURES_SPEC.md`;
  - `docs/DASHBOARD_PANELS.md`;
  - `docs/INTEGRATION_PLAN.md`.
- Mark IMPROVEMENT_PLAN.md as implemented.

---

## Applying migrations: checklist for the team
Apply them in the Supabase SQL editor, in order. Each one only after its step is merged:

| Migration | Step |
|---|---|
| v12 | 3 |
| v13 | 6 |
| v14 | 8 |
| v15 | 9 |
| v16 | 11 (`supabase/supabase_migration_v16.sql`) |

After v14, run `demo_seed.sql` again so the demo has published summaries instead of the old
shared assessments.
