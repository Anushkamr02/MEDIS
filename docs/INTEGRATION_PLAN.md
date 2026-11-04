# MEDIS: Plan for Integrating the Python Backend

How the teammate's Python backend (`README_nav.md`) joins our React and Supabase system.
Prepared on 3 November 2026.

---

## 1. Summary

**Supabase stays the single source of truth.** It already handles accounts, IDs, records,
access rules (RLS), audit logs, notifications and file storage. We **do not** run the teammate's
database, login or CRUD endpoints. Their own README says that layer is not safe to expose
(*"many existing clinical GET/POST routes currently lack authorization enforcement"*).

We take the parts we don't have, **the analysis engines**, and run them inside a small FastAPI
service of our own, the **MEDIS AI Service**. This follows integration *Option A* in their
README. The service:

1. checks the caller's **Supabase login token**,
2. reads patient data from Supabase **using that same token**, so the existing RLS access rules
   still apply,
3. calls the teammate's `medis` Python functions,
4. saves the result back to Supabase and returns it to the React app.

The service also hosts the two new LLM features: the **doctor's AI patient summary** and the
**patient's help chatbot**.

```
 React (Vite)  ──────────────►  Supabase (Auth · Postgres+RLS · Storage · pg_cron)
     │                                   ▲
     │  Bearer <supabase JWT>            │ same JWT → RLS still enforced
     ▼                                   │
 MEDIS AI Service (FastAPI, ours)  ──────┘
     ├── medis.ai.longitudinal_analysis.assess_timeline   (teammate)
     ├── medis.ai.ascvd  (legacy PCE)                      (teammate)
     ├── medis.ecg_inference.analyze_ecg + models/*.keras  (teammate)
     ├── medis.report_extraction (OCR → lab values)        (teammate)
     ├── prescription / history PDF generators             (teammate, via adapter)
     └── LLM calls: AI summary + patient chatbot           (new)
```

---

## 2. Which version we keep for each feature

| Feature | Ours (React + Supabase) | Theirs (Python) | **Decision** |
|---|---|---|---|
| Login, registration, sessions | Supabase Auth, role-based routes | JWT plus their own password hashing | **Keep ours.** Theirs would add a second account system. |
| Patient, doctor and visit IDs | `MEDIS-P/D/V` set by DB triggers | Separate ID generator | **Keep ours.** Two generators would produce conflicting IDs. |
| Access control | RLS plus `doctor_patient_assignments`, audit log, access history | Authorization incomplete (their README) | **Keep ours.** |
| Consultations (complaints, vitals, examination, diagnosis, drafts, finalizing) | Full structured workflow | Basic start/symptoms/measurements/notes routes | **Keep ours.** It is richer and has the draft and final lifecycle. |
| **Lab values (LDL, HbA1c, …)** | **Free text only** (`observations.blood_report`) | Numeric measurements with units | **Take their data model.** Add numeric lab columns (§4). Their engine needs numbers. |
| Prescriptions | Fixed once issued, linked to visit, notifies patient | Records plus **PDF** | **Keep our records, take their PDF generator** (through an adapter). |
| Patient history PDF | Not built | Consolidated history PDF | **Take theirs** (through an adapter). |
| Document upload | Private bucket, signed URLs, review status | Local filesystem uploads | **Keep our storage.** |
| **Reading values out of reports (OCR)** | Not built | `report_extraction` (OCR, fields, units) | **Take theirs.** The doctor must check values before they count. |
| Single-visit clinical alerts (spec 12.5) | Instant threshold alerts while typing | `risk_flags` (one assessment) | **Keep ours** for instant feedback while typing. Theirs is not needed. |
| **Trends across visits** | Not built (placeholder card) | `assess_timeline`: slopes, % change, review priority, visit patterns, seasonal BP | **Take theirs.** This is the core of the CAD insight. |
| **Absolute 10-year risk** | Not built | Legacy 2013 PCE (explicit confirmed inputs) | **Take theirs.** The doctor must confirm the inputs. |
| **ECG analysis** | Doctor types free text | CNN (NORM vs MI) plus quality checks, PDF/image digitizing | **Take theirs.** Respect the blocked and failed states. |
| Notes → structured symptoms | Doctor ticks the complaints checklist | `symptom_extraction` | **Optional later.** Our checklist is already structured. |
| Speech transcription | Not built | **Simulated** when no transcript is given | **Drop.** Simulated dialogue must never reach a medical record. |
| CAD tabular model, glaucoma, MODY, Fabry, fusion | `disease_type` values exist | **Model files absent**; fusion is experimental | **Drop for now.** Hide these from the UI and never show a "probability" from them. |
| Audit logs | `audit_logs` table plus RPCs | Their audit table | **Keep ours.** The AI service writes to our `audit_logs`. |
| Notifications | Triggers, pg_cron reminders, bell | None | **Keep ours.** |
| AI patient summary (doctor) | None | None | **New**: LLM over the structured `assess_timeline` output (§6). |
| Patient chatbot | None | None | **New**: LLM limited to the patient's *shared* record (§7). |

**Rule we hold to (from their README):** the review priority, the PCE % and the ECG
classification measure **different things**. The UI must never merge them into one "CAD risk %".
The old placeholder text ("prediction, confidence and SHAP explanation") will be replaced
because no such tabular model ships.

---

## 3. The MEDIS AI Service (our FastAPI wrapper)

**Location:** `C:\Desktop\major_project\backend\` (the teammate's `MEDIS/` folder, renamed).
Their `medis/` package and `models/` are **unchanged**. The files we don't run (their gateway,
training and scratch scripts, and the tests for their gateway) are in `teammate_extras/`.

```
backend/
  server.py            our FastAPI app: auth, endpoints, CORS            (built)
  supa.py              Supabase REST/Storage/Auth calls with the caller's JWT (built)
  adapters.py          Supabase rows → engine inputs; OCR fields → columns  (built)
  requirements.txt     dependencies                                       (built)
  llm/                 doctor AI summary + patient chatbot            (pending)
  medis/  models/      teammate code, untouched
  teammate_extras/     their api.py, app.py, train_real.py, scratch/, outputs/, gateway tests
```

**Configuration (environment only, never committed):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_JWT_SECRET` (to verify tokens), `LLM_API_KEY`, `ALLOWED_ORIGIN`.
No service-role key is needed, because every read and write goes through the caller's own
token and RLS. **Do not set `DATABASE_URL`**, and never call `init_db()` or
`generate_longitudinal_cad_report()`: those create and write their SQLite database. We use only
the pure `assess_timeline(...)` function.

### Endpoints

| Method and path | Who | What it does |
|---|---|---|
| `GET /health` | anyone | Liveness, plus whether the ECG model and Tesseract are available |
| `POST /ai/longitudinal/{patient_id}` | doctor with access | Builds the visit list from Supabase → `assess_timeline` → saves to `cad_assessments` → returns the report and chart series |
| `POST /ai/pce/{patient_id}` | doctor with access | Body: the doctor-confirmed PCE inputs → `ascvd` → saved with the assessment |
| `POST /ai/summary/{patient_id}` | doctor with access | LLM writes a summary from the latest assessment, medications and history → saved |
| `POST /ai/extract-report/{document_id}` | doctor with access | Downloads from Storage → OCR → returns proposed lab values (**unverified**) |
| `POST /ai/ecg/{document_id}` | doctor with access | Downloads the ECG file(s) → `analyze_ecg` → saves to `ecg_analyses` |
| `GET /pdf/prescription/{id}` | doctor or that patient | Prescription PDF |
| `GET /pdf/history/{patient_id}` | doctor with access, or that patient | Consolidated history PDF of finalized visits. Patient copy: shared visits only, no ECG rows, and the AI section only when the doctor has shared an assessment (migration v6). |
| `POST /ai/chat` | patient | One chatbot turn; uses only the caller's own visible data |

"Doctor with access" is never re-implemented in Python. If the RLS-scoped read of the patient
returns nothing, the endpoint returns **403**. Every AI call writes an `audit_logs` row
(`ai_assessment`, `ai_summary`, `ecg_analysis`, `report_extraction`, `chat`).

Before the JSON response is returned, NumPy arrays and NaN/Inf values must be made JSON-safe
(their `json_safe` helper).

---

## 4. Database changes: `supabase_migration_v4.sql`

1. **Numeric labs on `consultations`** (in mg/dL unless noted):
   `total_cholesterol`, `ldl_cholesterol`, `hdl_cholesterol`, `triglycerides`,
   `fasting_glucose`, `hba1c` (%), `creatinine`, `egfr` (mL/min/1.73m²), plus
   `labs_source` (`manual` | `extracted` | `extracted_verified`).
   - These match how we already store vitals (`systolic_bp`, …).
   - The free-text `blood_report` observation stays for anything else.
2. **`cad_assessments`**:
   - `id`, `patient_id`, `consultation_id` (nullable), `requested_by`
   - `engine_version`, `as_of`, `review_priority`
   - `report` jsonb, `pce` jsonb, `pce_inputs` jsonb, `ai_summary` text, `summary_model`
   - `is_shared_with_patient`, `created_at`
   - **RLS:** assigned doctors can read and insert. A patient can read only rows the doctor has
     shared.
3. **`ecg_analyses`**:
   - `id`, `patient_id`, `consultation_id`, `document_id` → `medical_reports`
   - `source_type` (`digital` | `pdf` | `image`), `status`, `quality` jsonb
   - `classification`, `confidence`, `raw` jsonb, `created_by`, `created_at`
   - **RLS:** like `cad_assessments`, doctor-only.
4. **`report_extractions`**:
   - `id`, `document_id`, `consultation_id`, `fields` jsonb (value, unit, confidence, source text)
   - `status` (`pending_verification` | `applied` | `rejected`), `verified_by`, `verified_at`
5. **`chat_messages`**:
   - `id`, `patient_id`, `role` (`user` | `assistant`), `content`, `created_at`
   - **RLS:** a patient can read only their own messages.
   - The AI service inserts the assistant replies using the patient's token, so the patient
     needs an insert policy.
6. **New notification types** (existing trigger): `ai_summary_shared`, `ecg_result_ready` (doctor).
7. **Demo seed update:** fill in the numeric lab columns for Rahul's 4 visits (LDL 95→110→135→155,
   HbA1c 5.5→5.9→6.2→6.8, …) so the charts and engine have real data on day one.

---

## 5. Turning a Supabase visit into `assess_timeline` input

Only **completed** (finalized) consultations are used. Drafts are excluded.

```python
{
  "visit_id":    c.visit_id,                # MEDIS-V…
  "date":        c.consultation_date[:10],
  "hospital":    c.hospitals.name,
  "hospital_id": c.hospital_id,
  "measurements": {                          # None when missing, never 0
    "systolic_bp": c.systolic_bp, "diastolic_bp": c.diastolic_bp,
    "heart_rate": c.heart_rate, "bmi": c.bmi,
    "ldl_cholesterol": c.ldl_cholesterol, "hdl_cholesterol": c.hdl_cholesterol,
    "total_cholesterol": c.total_cholesterol, "triglycerides": c.triglycerides,
    "fasting_glucose": c.fasting_glucose, "hba1c": c.hba1c,
    "creatinine": c.creatinine, "egfr": c.egfr,
  },
  "symptoms":      [k for k, v in c.complaints.items() if v],
  "prescriptions": [... medicines from prescriptions linked to this consultation ...],
}
```

> **Must confirm with the teammate:** the exact measurement key names and symptom vocabulary
> accepted in `medis/ai/trajectories.py` and `test_visit_patterns.py`. Only `ldl_cholesterol`
> and `systolic_bp` are confirmed by their README. All units are already in their schema
> units, so no conversion is needed.

The returned `metric_trajectories[*]` daily evidence becomes the **chart series** sent to the
doctor's graphs. That way the graph and the AI text are built from exactly the same numbers.

---

## 6. Doctor AI summary (new)

- **Input to the LLM** is structured data only:
  - the `assess_timeline` output (priority, trajectories, flags, data quality),
  - current medications,
  - known conditions,
  - the last 3 final diagnoses.
- Raw free text is excluded, which keeps the prompt small and the summary checkable.
- **Output:** fixed sections:
  - *Overview* (2–3 lines)
  - *What changed* (each item cites a metric, its dates and its values)
  - *Points to review*
  - *Data gaps*
- **Guardrails:**
  - The prompt forbids new numbers, diagnoses or treatment orders.
  - After generation, every number in the text is checked against the input. If any number
    doesn't match, the summary is regenerated or flagged.
- Saved in `cad_assessments.ai_summary` with the model name and time.
- The doctor sees *"AI-generated · based on N visits up to <date>"* and a **Regenerate** button.
- **Model:** Google Gemini (`gemini-3.5-flash`, free tier) through the backend only; the key
  (`GEMINI_API_KEY` in `backend/.env`) never reaches the browser. `MEDIS_LLM_MODEL` overrides
  the model. On the free tier Google may use prompts to improve its products, so it is for demo
  data only; real patient data needs a paid key.

## 7. Patient help chatbot (new)

- **Scope:**
  - explains the patient's *own shared* information in plain language (shared visits,
    prescriptions, medications, test names),
  - explains general health terms (what LDL or HbA1c means),
  - helps them find their way around MEDIS ("where do I upload a report?").
- **Never:**
  - diagnoses,
  - changes a dose,
  - interprets unshared drafts or doctor-only AI results,
  - answers about other people.
- **Context given to the LLM:** only the rows that the patient's own token can read, plus a
  fixed MEDIS help text.
- **Safety:**
  - Emergency keywords (chest pain now, fainting, breathlessness at rest, etc.) trigger a fixed
    reply: *call emergency services, 108 or 112 in India*. That reply skips the model.
  - Every answer carries a short "not medical advice, ask your doctor" line.
  - The chatbot offers a **"Book / contact my doctor"** follow-up.
- **Storage:** history saved in `chat_messages`, with a **Clear chat** option.
- **Limits:** rate-limited per patient.

---

## 8. Build order (each step: you test, then we continue)

| Step | Deliverable | Depends on |
|---|---|---|
| **I1** | Migration v4, numeric lab inputs in NewConsultation, updated demo seed | none |
| **I2** | AI service skeleton (auth, Supabase client, `/health`) plus the teammate code copied and its 38 tests passing | the teammate's files |
| **I3** | Longitudinal assessment endpoint, plus the **AI Insights** panel with trend graphs on the doctor's Patient Profile (replaces the placeholder card) | I1, I2 |
| **I4** | AI summary (LLM) on the same panel | I3, LLM key |
| **I5** | Report OCR → "Extract values" → verify → apply to visit labs | I1, I2, Tesseract installed |
| **I6** | ECG analysis on uploaded ECG documents | I2, model files |
| **I7** | PCE calculator with confirmed inputs | I3 |
| **I8** | Prescription and history PDFs | I2 |
| **I9** | Patient chatbot | I2, LLM key |

The frontend calls the service through one helper, `src/lib/aiClient.js`, which attaches
`session.access_token`. The service URL comes from `VITE_API_URL` (already in `frontend/.env`).
**If the service is down, every AI panel shows a "service unavailable" state and the rest of
MEDIS keeps working.**

## 9. What we need from the teammate

- [ ] The `medis/` package, `models/ecg_cnn.keras` plus `ecg_cnn_norm_params.json`
      (check the SHA-256 values from their README), and their 3 test files.
- [ ] `requirements-validated.txt` (the README says it doesn't exist yet). Python **3.13** for
      TensorFlow compatibility.
- [ ] Confirmed measurement key names and the symptom vocabulary for `assess_timeline` (§5).
- [ ] Whether the PDF generators accept plain dicts or need their ORM objects. This decides how
      much the adapter has to do.
- [ ] The input format `report_extraction` expects, and its output field names.
- [ ] The full `analyze_ecg` result fields (`status` values, `quality`, `classification`,
      confidence).

## 10. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| Heavy dependencies (TensorFlow, Tesseract, Poppler) | Run the AI service separately; `/health` reports which features are available; the UI hides features that are unavailable |
| Someone reads the review priority as a diagnosis | Fixed wording, a "decision support" label and the evidence shown on every panel |
| OCR reads a value wrong | Extracted values are **never** used until a doctor confirms each one |
| A short printed ECG is blocked from the CNN | Show the "blocked" state with its reason. Never show it as "normal". |
| The LLM invents details | Structured input only, a number check, citations to visits, and the doctor reviews before sharing |
| The patient chatbot misses an emergency | Hard-coded emergency path that skips the LLM |
| Data leaks between patients | Every read uses the caller's JWT, so RLS applies. No service-role key in the AI service. |
