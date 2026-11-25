# MEDIS improvement plan: continuous monitoring with doctor-reviewed AI

> **Status: implemented.** All 14 steps of
> [IMPLEMENTATION_STEPS.md](IMPLEMENTATION_STEPS.md) are built and tested; this document is
> kept as the rationale behind them. Where a question in §10 was still open, the step used the
> default stated here (see each step's note in IMPLEMENTATION_STEPS.md).
> **Migrations v12–v16 must be applied by hand in the Supabase SQL editor, in order.**

## 1. Why we are proposing this

**Monitoring.** MEDIS stores a patient's records from every hospital well. But it only
*analyses* a patient when a doctor opens the profile and presses **Run analysis**, so it behaves
like a records website rather than a system that watches over patients. The goal is to
**monitor each patient continuously**:
- every finalized visit and every issued prescription re-checks the patient automatically;
- the **doctor's dashboard** shows whether each patient is **Improving**, **Stable** or
  **Worsening**, and why.

**Governance.** At the same time, AI findings must stay **doctor-only until a doctor has
reviewed them**. Patients receive only a summary that a doctor has reviewed and published.
Nobody else, including family members, gets automatic access. Urgent findings are escalated and
everything is audited. These requirements, from the team, are in §3 and shape the rest of the
plan.

We also fix the gaps found while reviewing the project (§6–§8).

---

## 2. Continuous monitoring

### 2.1 What the doctor will see
**Overview page: a new "Patient monitoring" section**
- **Four tiles:** Worsening (red), Stable, Improving (green), Not enough data. Clicking a tile
  opens My Patients filtered to that group.
- **Needs review:**
  - lists patients with a clinically significant finding that no doctor has reviewed yet (see
    §3.3);
  - **overdue urgent items are pinned at the top in red** (§3.4);
  - each row shows the top 2 dated reasons, what caused the re-check ("after Visit
    MEDIS-V-000789 was finalized") and how each medicine is working ("Atorvastatin: no clear
    response");
  - buttons: **Open** and **Review**.
- **Improving:** recently improving patients.
- **Follow-ups due:** medicines whose follow-up test is now due or overdue.

**My Patients**
- A new **Trend** column (↑ Improving / → Stable / ↓ Worsening) next to the existing AI check.
- A trend filter.
- Sort order: Critical first, then Worsening.

**Patient Profile: a new "Monitoring" card** (inside the doctor-only Clinical Insights module,
§3.1)
- **Timeline:** one dot per check, coloured by trend and labelled with its trigger.
- **Since last check:** each metric's previous → latest value, its target, and its status.
- **Treatment response:** for each active medicine, the baseline → follow-up value, or "due by
  <date>".
- **Review status:** the latest review and its outcome (§3.3).

**Notifications** go **only to doctors with access**, when a patient turns Worsening or Critical
and when a treatment follow-up falls due. Patients are **not** notified about AI findings (§3.1).

> **Framing:** the trend describes *recorded values moving toward or away from target*. It is
> not a diagnosis. It sits **next to** the existing review priority and is never merged into
> it. The review priority asks "is anything concerning?"; the trend asks "is it getting better
> or worse since last time?".

### 2.2 How re-checks are triggered
| Event | What happens |
|---|---|
| Doctor finalizes a visit | The frontend calls the new `POST /ai/monitor/{patient}` with the doctor's session, and a toast shows the new trend. |
| Doctor issues a prescription | Same call, plus a follow-up check scheduled for each recognised medicine. |
| Doctor applies verified OCR lab values | Same call. |
| Treatment follow-up falls due | A daily pg_cron job notifies the doctors and queues a re-check. |
| AI service was down at the time | A database trigger has already queued the patient. The queue is processed the next time a doctor with access opens the dashboard. |

**Why not a 24/7 background worker?**
- A worker would need a Supabase **service-role key**. Our design deliberately has none: RLS is
  our only authorization layer, and the AI service always acts as the signed-in user.
- So re-checks run on doctor actions plus a queue that pg_cron fills inside Postgres. Nothing is
  lost, but a queued re-check waits until a doctor with access is online. See question Q1.

### 2.3 The monitoring engine
New pure Python module `backend/medis/ai/monitoring.py`, with unit tests. It compares the new
assessment with the previous one.

**Each metric is compared with its previous reading.** It only counts as a change if it moves by
at least a minimum meaningful amount, so normal noise doesn't trigger "worsening":

| Metric | Target | Minimum change |
|---|---|---|
| Systolic / diastolic BP | < 130 / < 80 mmHg | 5 / 3 mmHg |
| LDL | < 100 mg/dL | 10 |
| HDL | > 40 mg/dL | 3 |
| Total cholesterol | < 200 mg/dL | 15 |
| Triglycerides | < 150 mg/dL | 20 |
| HbA1c | < 5.7 % | 0.3 |
| Fasting glucose | < 100 mg/dL | 10 |
| BMI | 18.5–25 | 0.5 |
| Creatinine / eGFR | 0.6–1.2 mg/dL / > 90 | 0.2 / 5 |

**Other inputs**
- **Symptoms:** a new or escalating symptom counts as worsening; a resolved symptom counts as
  improving.
- **Review priority** rising since the last check counts as worsening.
- **Treatment response** comes from a small curated map of medicines:

  | Drug class | Examples | Checks | After |
  |---|---|---|---|
  | Statins | atorvastatin, rosuvastatin | LDL | 4–12 weeks |
  | Blood-pressure medicines | amlodipine, telmisartan, losartan, ramipril, metoprolol | BP | 2–6 weeks |
  | Glucose-lowering medicines | metformin, glimepiride, sitagliptin, empagliflozin, insulin | HbA1c | 12 weeks |
  | | | fasting glucose | 2 weeks |

  Possible results: responding, no clear response, worsening on treatment, awaiting follow-up,
  or no baseline.

**Overall trend**
- **Worsening:** the priority rose, a symptom got worse, a key heart metric got worse, or values
  got worse while on treatment.
- **Improving:** nothing got worse, and something improved.
- **Not enough data:** fewer than two comparable readings.
- **Stable:** everything else.

---

## 3. Clinical governance: doctor-only AI, review, publication, escalation, audit

### 3.0 The requirements and where MEDIS stands today
| # | Requirement | Today | Change |
|---|---|---|---|
| G1 | AI predictions, classifications, suspicions and risk assessments stay in a **Doctor-Only Clinical Insights** module by default | Mostly met. ECG analyses are doctor-only. **Gap:** once a doctor shares a heart check, RLS lets the patient read the **whole** assessment row (raw engine report, flags, review priority, PCE %, AI summary). The UI hides most of it, but the API doesn't, and the patient's history PDF prints the AI screening section. | §3.1 |
| G2 | Unverified findings are **not automatically published** to the patient dashboard, family or caregivers | Nothing is published automatically today. But "sharing" passes on raw AI output, not a reviewed message. | §3.1, §3.2 |
| G3 | An authorized doctor **evaluates significant findings** before they are communicated as conclusions | No review workflow exists. | §3.3 |
| G4 | The doctor can **publish a reviewed, patient-friendly summary** without raw AI predictions | Partly met: there is an optional doctor note, but the card is built from raw AI fields. | §3.2 |
| G5 | Confirmed diagnoses and records follow **access rights** | Met: v11 patient-controlled access and per-visit sharing. | §3.5 (applied to the new tables) |
| G6 | **No automatic family access** | Met by default: there is no caregiver role, only accounts with the doctor role can be granted access (v11 checks this), and the emergency contact is stored as text only. | §3.6 (make it explicit and tested) |
| G7 | **Audit trails, permissions and escalation** for urgent findings | Partial: `audit_logs` and the access history exist. There is no escalation. | §3.4, §3.5 |

### 3.1 Doctor-Only Clinical Insights module (G1, G2)
**What the module holds**
- review priority and flags;
- monitoring trend;
- AI summary;
- PCE / PREVENT risk;
- ECG classifications;
- OCR suggestions.

**In the UI**
- These are grouped and labelled as **"Clinical Insights: doctor only, not visible to the
  patient"** on the patient profile and the consultation page.

**In the database** (migration v12)
- **Drop** the v6 policy `cad_assessments: patient reads shared`. Patients can no longer read
  any `cad_assessments` row.
- `ecg_analyses`, `monitoring_queue` and the review tables (§3.3) have **no** patient policy.
- The patient history PDF no longer prints the AI screening section. It prints the published
  summary instead (§3.2).
- Ask MEDIS already reads only shared visits, prescriptions and appointments. It will also
  read published summaries, and **never** `cad_assessments`.
- Patient notifications never mention AI findings. "Heart health check shared" becomes "Your
  doctor published a health summary".

### 3.2 Doctor-reviewed patient summary (G4)
**New table `patient_health_summaries`**
- It holds **what the patient sees**, written and approved by a doctor.
- Columns:
  - `headline`, `points[]`, `next_step`;
  - a **doctor-chosen** `status_message`: "Your results look steady", "Some results to keep an
    eye on" or "Please book a visit to discuss". It is **not** derived from the AI priority;
  - `shown_metrics`: the measured values the doctor chooses to show, copied at publish time;
  - `assessment_id`: an internal link, which the patient cannot follow;
  - `published_by`, `published_at`, `withdrawn_at`.
- Rows are **immutable**. A correction means withdrawing and publishing a new version, so the
  history stays auditable.

**Publish flow**, which replaces today's "Share with patient"
1. Gemini writes a **draft** patient version in simple words. If Gemini is unavailable, the
   doctor writes it themselves.
2. The doctor edits it, chooses the status message and ticks which measured values to show.
3. **Publishing is blocked** while:
   - the underlying finding hasn't been reviewed (§3.3), or
   - the draft contains numbers that can't be traced to the record (the existing
     number-grounding check).
4. The doctor ticks **"I have reviewed this summary and it is accurate"**, then clicks
   **Publish**.
5. The patient is notified, and the publication is audited.

**What patients never see**
- the review priority label;
- flags;
- the PCE or PREVENT %;
- ECG classification;
- the raw AI summary;
- the monitoring trend.

The doctor can still explain any of these in their own words in the summary.

**Patient side**
- *Your heart health check* becomes **"Health summary from your doctor"**.
- It reads `patient_health_summaries`, with RLS limited to the patient's own rows that are not
  withdrawn.

### 3.3 Clinical review of significant findings (G3)
**What counts as clinically significant**
- review priority **Critical** or **Needs review**;
- trend **Worsening**;
- treatment **worsening on treatment**;
- ECG **possible MI** or an interval flag.

**New table `finding_reviews`**
- Columns: `assessment_id` or `ecg_analysis_id`, `reviewed_by`, `reviewed_at`, `outcome`,
  `note`.
- `outcome` is one of: no action needed · follow-up booked · patient contacted · treatment
  changed · escalated / referred.
- Rows are written only through an RPC that checks the doctor has active access.

**Review dialog** (from Needs review, the Monitoring card or the ECG card)
- It shows the finding and its evidence, the outcome choices and a note.
- The outcome **follow-up booked** opens Appointments with the form pre-filled.

**Rules**
- A finding stays in **Needs review** until any doctor with access records a review.
- Its review status shows on every surface.
- A patient summary built on an assessment can only be published after that review (§3.2).

### 3.4 Escalation of urgent findings (G7)
**What counts as urgent**
- review priority **Critical**;
- ECG **possible MI**;
- severe recent BP from the engine (`SEVERE_RECENT_BP`).

**Escalation steps** (hourly pg_cron job `medis_escalate_urgent`)

| Time without review | Action |
|---|---|
| Immediately | Notification to every doctor with active access, including emergency access, with an **Urgent** label. |
| **4 h** | Repeat the notification and mark the item **"Overdue urgent review"**. It is pinned in red at the top of each such doctor's Overview. |
| **24 h** | Level 2: a further notification, the red dashboard banner stays, and the escalation is logged. |

- Every step writes an `escalation_events` row and an `audit_logs` row.
- Escalation stops as soon as a review is recorded.
- The time limits are SQL constants, so the team can tune them.

**Note:** MEDIS has no hospital-admin or on-call role today, so escalation stays within the
patient's care team. See question Q7.

### 3.5 Audit trail and permissions (G5, G7)
**Audited actions** (`audit_logs`)
- viewing Clinical Insights;
- running analyses;
- reviews and their outcomes;
- publishing and withdrawing summaries;
- escalation steps;
- emergency access (already audited);
- AI service calls (already audited).

**How the audit rows are written**
- Review, publish, withdraw and escalation audit rows are written **inside security-definer
  RPCs and triggers**, not by the browser, so a client can't skip them.

**Permissions**
- Every new table uses the same rule as the rest of MEDIS: the **doctor needs an active
  `doctor_patient_assignments` row**, from v11.
- Revoking access removes access to the reviews, the queue and the summaries straight away.
- Patients can read only their own published summaries.

**Access history**
- The patient's access history gains "Summary published" and "Summary withdrawn" events.

### 3.6 Family members and caregivers (G6)
**Policy, written into CLAUDE.md and the docs**
- MEDIS has **no family or caregiver access**.
- Only patients and doctors (with patient-granted access) can read records.
- The emergency contact is a phone number only. It gets no notifications and no data.

**Tests that enforce it**
- `request_patient_access` rejects a non-doctor account.
- An account with no assignment reads nothing from any clinical table.
- A patient cannot read another patient's published summary.

**Future caregiver access** (out of scope) would need:
- explicit patient consent, scoped to specific data;
- the ability to revoke it;
- audit of every use;
- no AI findings.

---

## 4. Database changes (migrations v12–v16)
> The build is split into steps in [IMPLEMENTATION_STEPS.md](IMPLEMENTATION_STEPS.md). These
> changes ship as five small migrations, one per step that needs schema:
> - **v12** monitoring;
> - **v13** reviews;
> - **v14** publication + patient lockdown;
> - **v15** escalation;
> - **v16** chat feedback.
>
> Each is idempotent and must be applied by hand in Supabase, like the others.

**Monitoring**
- `cad_assessments` gets new columns: `trigger_event`, `trigger_ref`, `previous_assessment_id`,
  `health_trend`, `monitoring` (jsonb).
- A `monitoring_queue` table, with triggers on finalized visits, new prescriptions and verified
  reports.
- A daily pg_cron job for follow-ups that have fallen due.

**Governance**
- Drop the patient-read policy on `cad_assessments`.
- New tables: `patient_health_summaries`, `finding_reviews`, `escalation_events`, each with RLS.
- New RPCs: `record_finding_review()`, `publish_health_summary()`, `withdraw_health_summary()`.
- An hourly pg_cron job: `medis_escalate_urgent`.
- Notification triggers that go to **doctors only** when a finding is Worsening or urgent.

**Chat**
- A `chat_messages.feedback` column for 👍 / 👎.

**Migrating existing data**
- Assessments that were "shared" before v12 stop being visible to patients, because they carried
  raw AI output. Doctors publish a reviewed summary instead. See Q8.

**Compatibility**
- The frontend hides the new features while v12 isn't applied, following the
  `dashboardCompatibility.js` pattern.

## 5. AI summary written by Gemini, in simple words
- **Today:** the doctor's AI summary is rule-based (`record_summary.py`). Gemini was removed
  from it in commit `8d2985b`. Only the chatbot uses Gemini.
- **Proposal:** one Gemini call writes two texts.
  - A **doctor version** for the Clinical Insights module: short, plain sentences with real
    values and dates, including the monitoring trend.
  - A **patient draft** in simple words, used **only as the starting text for the publish
    form** (§3.2). It is never shown to the patient until a doctor reviews, edits and publishes
    it.
- **Safety:** numbers that can't be traced back to the record are flagged and block publishing.
  If Gemini is down or out of quota, we fall back to today's rule-based summary.
- **Quota:** the summary would stop regenerating every time the panel opens. It would generate
  once, then only when the doctor presses Refresh.

## 6. Chatbot gaps (Ask MEDIS)
- **👍 / 👎 on each reply** (the column is in v12).
- **Source chips** scroll to that visit or prescription on the dashboard and highlight it.
- The chatbot reads published summaries, **never** raw AI output (§3.1).

## 7. Other doctor-side gaps
- A **Patient ID search box in the top bar**, available on every doctor page.
- **A different marker shape for each hospital on the trend charts.**
- **The 2023 PREVENT 10-year risk equation** alongside the 2013 PCE.
  - It uses the same "doctor confirms every input" form.
  - It is labelled as not calibrated for Indian populations.
  - It is **doctor-only**, like all risk assessments (§3.1).

## 8. Code health
- **Remove dead legacy code:** `medis/auth/` and `medis/web/`.
  - The four helpers `server.py` uses from `medis/web/routes.py` move to a new
    `medis/ecg_upload.py` first.
  - `medis/database/` **stays**, because the history PDF and the trend engine use its models.
- **Fix the 8 outdated tests in `redesign.spec.js`.**
- **Bring the docs up to date.** The AI summary isn't Gemini today, and commit `7c7c3d5`
  ("patient otp is added") actually holds the v11 access-control work.

## 9. Order of work and testing
The detailed, step-by-step version is in [IMPLEMENTATION_STEPS.md](IMPLEMENTATION_STEPS.md)
(14 steps). In summary:

1. Code-health cleanup and green tests.
2. Monitoring engine and its tests.
3. Migration v12 (monitoring and governance), applied in Supabase.
4. `/ai/monitor` endpoints.
5. Clinical Insights module, review dialog and escalation.
6. Doctor dashboard and frontend triggers.
7. Gemini summary and the publish flow; patient "Health summary from your doctor".
8. Chatbot fixes.
9. Doctor UX fixes.
10. PREVENT.
11. Docs.

Each step is committed separately and can be reviewed on its own.

**Tests**
- New backend tests: `test_monitoring.py`, `test_prevent.py`.
- New Playwright specs:
  - `monitoring.spec.js`;
  - `governance.spec.js`: a patient never sees AI fields, publishing is blocked until a review
    exists, withdrawing a summary hides it, and a non-doctor cannot get access.
- A SQL check that the patient role gets **zero rows** from `cad_assessments`, `ecg_analyses`,
  `finding_reviews` and `monitoring_queue`.

**Manual run with the demo accounts**
1. Rahul shows **Worsening / Critical**, and the doctors get an urgent notification.
2. After the 4 h step (simulated), Rahul is pinned as overdue.
3. Doctor1 reviews him with "follow-up booked".
4. Doctor1 publishes an edited summary.
5. Patient1 sees only that summary, with no priority, % or flags.
6. Doctor1 withdraws it, and it disappears for patient1.

## 10. Questions for the team
1. **Background worker:** are we happy that queued re-checks only run when a doctor with access
   is online? The alternative is a 24/7 worker with a service-role key, which changes our
   security model.
2. **Thresholds:** do the targets and minimum-change values in §2.3 look right? Should BMI use
   the Indian cut-off of 23 instead of 25?
3. **Medicine list:** which drug classes should be in the first version?
4. **Gemini summary:** the summary was moved off Gemini in `8d2985b`. Was there a reason
   (quota, quality, reliability) we should know about before moving it back?
5. **What counts as "clinically significant"** for the mandatory review (§3.3)? Is
   "Needs review" too broad, so that every mild LDL rise must be reviewed? An alternative is to
   require review only for Critical, Worsening and ECG possible MI.
6. **Escalation timing:** are 4 h and 24 h right for urgent findings?
7. **Escalation target:** escalation currently stays within the care team. Do we want a
   hospital-admin or on-call role so urgent findings can go above the patient's own doctors?
   That is a bigger change.
8. **Existing shared assessments:** is it acceptable that they stop being visible to patients
   when v12 is applied, until a doctor publishes a reviewed summary?
9. **Measured values in the patient summary:** should the doctor be able to show the patient
   their own BP / LDL chart? This plan allows it, because those are measured values, not
   predictions.
10. **Scope:** we left these out of this round:
    - patient home readings;
    - medicine reminders and adherence;
    - drug-interaction / allergy checks while prescribing;
    - more ECG classes;
    - caregiver access.

    Should any of these come into this round?
