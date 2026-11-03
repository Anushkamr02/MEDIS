# MEDIS: Screens, Features and Buttons for UI Design

This document lists **every screen, section, button and state** in the MEDIS patient and doctor
dashboards. Use it to design the screens.

**What it covers:** behaviour and content, meaning what each element is for, who sees it, and
what happens when it is clicked.

**What it does not cover:** layout, colours and visual style. Those are your decisions. The
engineering team will connect your design to the existing logic.

### Tags used

| Tag | Meaning |
|---|---|
| **[EXISTS]** | Already built and working; a redesign is welcome |
| **[NEW]** | Coming with the AI integration; needs a fresh design |
| **[CHANGED]** | Exists, but gains new parts |

---

## 0. Global rules (apply everywhere)

### 0.1 Users
- **Patient**
  - Gets a permanent **Patient ID** such as `MEDIS-P-000123`.
  - Sees only their own data.
  - Sees only the visits a doctor has **shared**.
- **Doctor**
  - Gets a **Doctor ID** such as `MEDIS-D-000045` and belongs to one hospital.
  - Opens a patient by searching that patient's ID, or from an appointment.
  - Every time a doctor opens a record it is logged, and the patient can see that log.

### 0.2 ID formats
IDs appear on most screens, so give them a recognisable "ID chip" style, ideally monospaced and
copyable.

| ID | Example |
|---|---|
| Patient | `MEDIS-P-000123` |
| Doctor | `MEDIS-D-000045` |
| Visit | `MEDIS-V-000789` |

### 0.3 Status pills (consistent colours everywhere)

| Group | Values |
|---|---|
| Appointment | `scheduled`, `completed`, `cancelled`, `missed` |
| Visit | `draft` (pending), `final` (completed) |
| Document review | `pending review`, `reviewed`, `verified`, `needs clarification` |
| Sharing | `shared with patient`, `not shared` |
| **[NEW]** AI review priority | `URGENT REVIEW`, `REVIEW`, `NO FLAGGED PROGRESSION`, `INSUFFICIENT DATA` (see §3.10) |

### 0.4 Every data section needs 4 states
1. **Loading** (skeleton or spinner).
2. **Empty**, with a helpful sentence and a next-step button where one makes sense.
3. **Error**, with a red banner and the message.
4. **Filled**.

AI sections need **two more states**:

5. **AI service unavailable**: a grey card reading *"AI analysis is temporarily unavailable.
   All other features work normally."*
6. **Running**: *"Analysing 4 visits…"*. It can take 2–10 seconds.

### 0.5 AI labelling rule (required)
Anything produced by AI must carry:
- a small **"AI" badge or sparkle icon**,
- the line *"Decision support, not a diagnosis. Final decision rests with the doctor."*,
- **when it was generated** and **how many visits or what data it used**.

Never show AI output styled like a confirmed diagnosis. Never combine the three AI results
(review priority, 10-year risk %, ECG result) into a single "risk score". They measure different
things.

### 0.6 Common controls
- **Back button**: on every inner page (all doctor pages except Overview; patient Profile and
  Edit pages). Returns to the previous page.
- **Notification bell**: an icon with an unread-count badge. Clicking it opens a dropdown list.
  The list has a **"Mark all as read"** action, and clicking a notification marks it as read.
- **Responsive:** must work on a phone (~400px). Patients will mostly use phones; doctors mostly
  use desktop.

---

## 1. Public pages [EXISTS, already redesigned]

### 1.1 Login (`/login`)
- **Layout:** split screen. The left side is the MEDIS introduction:
  - logo and headline,
  - animated ECG line,
  - 4 feature cards,
  - "How it works" in 3 steps,
  - a privacy note.
- **The login card has:**
  - Email field.
  - Password field with a **Show/Hide** toggle.
  - **Log in** button. It sends the user to the patient or doctor dashboard by role.
  - Error box.
  - Link: **"New to MEDIS? Create an account"**.
  - Two info cards: "For patients" and "For doctors".

### 1.2 Register (`/register`)
- **Toggle:** **I'm a patient / I'm a doctor**.
- **Fields:**
  - Full name, Email, Password (with Show/Hide).
  - Doctors only: **Hospital** (dropdown), Specialization, Qualification.
- **Button:** **Create account**.
- **Success screen:**
  - Shows the new permanent ID in a large ID display.
  - Patients get **Continue to profile setup**; doctors get **Go to dashboard**.
  - If email confirmation is on, it shows *"check your email"* and **Go to login** instead.

---

## 2. Patient side

### 2.0 Patient page map
| Route | Screen |
|---|---|
| `/patient` | Patient dashboard |
| `/patient/profile` | My profile (read-only view) |
| `/patient/onboarding` | Profile setup / Edit profile form |
| **[NEW]** chatbot | Floating panel, available on every patient page (not a separate route) |

### 2.1 Patient dashboard header [CHANGED]
- **Shows:**
  - "Welcome, *Name*".
  - **Patient ID chip.** **[NEW]** Add a **Copy ID** button: patients share this ID with doctors.
- **Right side:**
  - 🔔 **Notification bell** [EXISTS]
  - **My profile** button [EXISTS]
  - **[NEW] "Ask MEDIS" chat button** (also available as a floating button, see §2.9)
  - **Log out** [EXISTS]
- **Warning banner** (yellow) appears when the profile is incomplete: *"You haven't completed
  your profile yet. **Fill it in now**…"*. The link goes to the onboarding form.

**Notification types the patient receives:**
- appointment booked or reminder (24h before),
- doctor accessed your record,
- prescription issued,
- visit result shared,
- document reviewed.

### 2.2 Appointments card [EXISTS]
- **Table columns:** Date · Doctor · Status pill.
- **Empty state:** "No appointments booked."
- Read-only for the patient. Doctors book appointments.

### 2.3 Current medications card [EXISTS]
- **List:** medicine name, dosage · frequency · "for *condition*".
- **Empty state:** "No ongoing medications logged."

### 2.4 Visit history card [EXISTS]
- A **timeline** of every visit at every hospital and with every doctor.
- **Each entry shows:**
  - Visit ID,
  - date,
  - hospital,
  - doctor,
  - status.
- The diagnosis appears **only if the doctor shared that visit**. Otherwise the entry reads
  *"Results not shared yet"*.
- Drafts are never shown to patients.

### 2.5 Doctors who accessed your record [EXISTS]
- **Rows:**
  - doctor name and Doctor ID,
  - hospital,
  - first access date,
  - last access date,
  - how they opened the record (ID search, appointment, consultation).
- **Purpose:** transparency. Design this so it feels trustworthy, not alarming.

### 2.6 Shared results [EXISTS]
- One entry per shared visit:
  - disease tag,
  - status,
  - Visit ID,
  - date,
  - doctor,
  - the doctor's notes.
- **[NEW] "Your heart health check" card** (above Appointments), shown only after the doctor
  shares an assessment. It shows the latest shared one:
  - "Shared by Dr. X on <date> · based on results up to <date>".
  - A coloured box with a plain-language title and sentence for the review priority:
    - green: *"No worrying trend found"*
    - amber: *"Some results to keep an eye on"*
    - red: *"Your doctor wants to discuss your results soon"* (includes the 112/108 line)
    - grey: *"Not enough visits yet"*
  - The doctor's note, if any ("Note from your doctor").
  - "Your numbers over time": chips with plain names (e.g. *LDL ("bad") cholesterol*), a sentence
    such as *"went up from 95 to 155 mg/dL between …"*, and the trend chart.
  - The 10-year risk only if the doctor calculated it, worded as *"out of 100 people with numbers
    like yours, about N…"*.
  - A disclaimer that this is not a diagnosis, pointing to "Ask MEDIS".
  - Never show the clinical flags, the AI summary text or ECG results here.

### 2.7 Prescriptions [CHANGED]
- **Each prescription shows:**
  - date and doctor,
  - medicines (name, dosage, frequency, duration, timing, notes),
  - instructions.
- **[NEW] Download PDF** button on each prescription.

### 2.8 Medical documents [EXISTS]
- **Upload form:**
  - **Report type** dropdown: Blood Report, Lipid Profile, HbA1c, ECG, Cardiac Report
    (2D Echo, TMT…), X-ray, CT, MRI, Discharge Summary, Previous Prescription, Medical History,
    Other.
  - **Hospital** dropdown.
  - **Report date**.
  - **File picker**: PDF or image.
  - Optional note.
  - **Upload** button.
- **List:**
  - each file with its type, date, hospital, review status pill and **View** button (opens a
    secure link in a new tab),
  - documents uploaded by doctors are marked *"Added by Dr. X"*.

### 2.9 [NEW] Download my medical history
- A button on the dashboard or profile: **Download my history (PDF)**.
- Built as **Download my history** in the dashboard header.
- The PDF contains the patient's shared visits, labs and prescriptions. The AI screening section
  is included only when the doctor has shared an assessment. ECG analyses are not included.
- **States:** generating ("Preparing PDF...") → opens in a new tab; an error appears next to the
  button.

### 2.10 [NEW] "Ask MEDIS" patient chatbot

**Purpose:** answer the patient's questions in simple language about:
- *their own* shared results and prescriptions ("What does LDL mean?", "Why was I given
  atorvastatin?", "When is my next appointment?"),
- how to use MEDIS ("How do I upload a report?", "Who has seen my record?").

**Entry points:**
- **Floating round button** in the bottom-right corner on every patient page, with a chat icon
  and the label "Ask MEDIS".
- The header button.

**Panel:**
- **Size:** a side drawer on desktop; full screen on mobile.

**Header:**
- title "Ask MEDIS", subtitle "AI health assistant",
- **AI badge**,
- **⋯ menu** containing **Clear conversation** and **About this assistant**,
- **✕ Close** button.

**Welcome state** (first open, or after clearing):
- A short intro: *"I can explain your shared reports, medicines and appointments in simple
  words. I can't diagnose or change your treatment."*
- **4 suggested-question chips** (tap to send):
  - "Explain my latest results"
  - "What are my current medicines for?"
  - "When is my next appointment?"
  - "How do I share my ID with a doctor?"

**Conversation:**
- The patient's messages appear on the right, the assistant's on the left.
- Show a time on each message.
- Assistant messages can contain simple formatting: bold text and bullet lists.
- They can also contain **source chips**, e.g. `Visit MEDIS-V-000789 · 08 Oct 2026` or
  `Prescription · 08 Oct`. Tapping a chip scrolls the dashboard to that item.
- **Footer line under every assistant reply:** *"For information only, not medical advice. Ask
  your doctor about any decision."*
- **Feedback on each reply:** 👍 / 👎 icons (optional).

**Input bar:**
- multi-line text box with placeholder "Type your question…",
- **Send** button (disabled while empty or while a reply is loading),
- character limit of about 500.

**States to design:**

| State | Look |
|---|---|
| Typing / thinking | Three animated dots in an assistant bubble |
| Normal reply | As described above |
| **Emergency reply** | ⚠ A **red alert card** (not a normal bubble): *"Your message mentions a symptom that may need urgent care. Call 108 / 112 or go to the nearest emergency department now."* plus a **Call 112** link shown as text with the number visible. It appears when the patient mentions things like chest pain right now, fainting, or severe breathlessness. |
| Out of scope | A polite refusal, e.g. "I can't recommend changing your dose. Please ask Dr. X." plus a **Book an appointment / contact doctor** chip |
| Rate limited | "You've asked a lot of questions. Please try again in a few minutes." |
| Service down | "The assistant is unavailable right now." Input disabled. |
| Not shared yet | "Your doctor hasn't shared the result of your latest visit yet." |

Chat history is saved, so the patient sees past conversations when they reopen the panel.

### 2.11 My profile (`/patient/profile`) [EXISTS]

**Header:** a **profile ID card** showing:
- name,
- Patient ID,
- age, gender, blood group.

**Buttons:** **Edit profile** and **Back**.

**Sections (read-only fields; an empty value shows "—"):**

| Section | Fields |
|---|---|
| **Personal details** | Full name, Email, Phone, Gender, Date of birth, Age, Emergency contact |
| **Health details** | Blood group, Height, Weight, BMI, Smoking, Alcohol, Allergies |
| **Known conditions & risk factors** | Chips, e.g. Hypertension, Diabetes |
| **Current medications** | List |
| **Medical & family history** | List |

If the profile is empty, show a **Complete your profile** button.

### 2.12 Profile setup / Edit profile (`/patient/onboarding`) [EXISTS]
- **Title:** "Tell us about yourself" for first setup; "Edit your profile" when editing (form
  pre-filled).
- **Personal fields:** name, date of birth, gender, phone.
- **Health fields:** blood group, height, weight, smoking (never/former/current), alcohol,
  allergies, emergency contact.
- **Current medications:** add rows (name, dosage, frequency, condition) with **+ Add
  medication** and a remove ✕ per row. Medications already saved are shown, not re-added.
- **Buttons:** **Save** and **Back**.

---

## 3. Doctor side

### 3.0 Doctor layout [EXISTS]

**Left sidebar:**
- MEDIS logo
- **Overview**
- **Search Patient**
- **My Patients**
- **Appointments**
- **Drafts** (with a count badge)
- **My Profile**
- At the bottom: the doctor's name, Doctor ID, hospital, and **Log out**.

**Top of content:** **Back** button on every page except Overview.

**Doctor notifications:**
- appointment reminders,
- patient uploaded a document,
- **[NEW]** ECG analysis ready.

### 3.1 Overview (`/doctor`) [EXISTS]

**Stat cards** (some are clickable):
- Patients with access
- Today's consultations
- Draft consultations (→ Drafts)
- Reports awaiting review
- Upcoming appointments (→ Appointments)
- **[NEW] Critical patients** (red when above 0) and **Patients needing review** (amber when
  above 0): counts of patients whose *latest* AI check is Critical or Needs review. Each opens My
  Patients filtered to those patients.
- **[NEW]** A red banner above the cards when there are critical patients: "2 critical patients.
  Their latest AI check found a worsening trend that needs your review soon. View them →".

**"Start with a Patient ID" card:** short text and a **Search patient** button.

**Upcoming appointments list** (today onward):
- Each row: time, patient name and ID, reason.
- **"Now"** badge when it's time for the appointment.
- **Open** button (primary style when "Now"). It opens the patient with an appointment banner.

**Recently accessed patients:** a list; clicking a row opens the patient.

### 3.2 Search Patient (`/doctor/search`) [EXISTS]
- **Input:** Patient ID (`MEDIS-P-…`) and a **Search** button.
- **Result card:** name and ID, plus an **Open record** button. Opening the record grants and
  logs access.
- **Not found state:** "No patient with this ID. Check the ID with the patient and try again."

### 3.3 My Patients (`/doctor/patients`) [CHANGED]
- **Header:** title plus a **Search patient** button.
- **List or table:** name, Patient ID, last visit date, how access was granted.
- **[NEW] "AI check" column:** a pill (Critical / Needs review / No concern found / Not enough
  data / Not checked) with the date of the latest analysis.
- **[NEW]** Filter dropdown: All patients / Critical + needs review / Critical only / Needs review
  only. It can be linked from the Overview (`?priority=critical`).
- **[NEW]** Sorted Critical first, then Needs review, then the rest (newest access first within
  each group).
- A footnote: the AI check is a screening result, not a diagnosis, and it only changes when the
  analysis is run again.
- Clicking a row opens the Patient Profile.

### 3.4 Patient Profile (`/doctor/patients/:id`) [CHANGED: main AI screen]

**a) Appointment banner** (only when opened from an appointment): *"Appointment now: reason"*.

**b) Patient header:**
- name, Patient ID, age, gender, blood group.
- **Buttons:**
  - **Write prescription**
  - **Start consultation**, or **Resume it** if a draft exists. A notice reads *"You have a
    draft consultation for this patient"*.
  - **[NEW] Download history PDF**

**c) [NEW] AI Insights panel**: the main new feature (details in §3.10).
- Place it high on the page, directly below the header. It contains:
  1. **Review priority badge** and a one-line reason.
  2. **AI summary** (text).
  3. **Trend graphs.**
  4. **Flags and evidence list.**
  5. **Data quality notes.**
  6. **10-year risk (PCE)** card.
  7. **Latest ECG analysis** card.
- **Panel buttons:**
  - **Run analysis** (first time) or **Refresh analysis**
  - **Regenerate summary**
  - **Share summary with patient** (toggle)
  - **View full report** (expands the details)

**d) "Add to record" quick actions** (tabs or buttons). Each opens an inline form:
- **Add medication**: name, dosage, frequency, condition, start date.
- **Add condition**: medical history entry.
- **Add family history**: relation, condition.
- **Upload test report**: same fields as the patient upload; saved as "verified".

**e) Vitals & lifestyle:** Blood group, Height, Weight, BMI, Smoking, Alcohol, Allergies,
Emergency contact.

**f) Known conditions & risk factors:** chips.

**g) Current medications:** list, each with a **Stop** button (red text). Stopping marks the
medicine as no longer current.

**h) Medical & family history:** list.

**i) Visit history (all doctors and hospitals):**
- A timeline. Each visit shows Visit ID, date, hospital, doctor, status and diagnosis.
- Clicking a visit opens it: read-only if another doctor owns it.

**j) Doctors who accessed this record:** same as the patient view.

**k) Prescriptions:** each shows the issuing doctor and the Visit ID. **[NEW]** A **PDF**
button on each.

**l) Medical documents:**
- Each document shows type, date, hospital, review status and **View**.
- **[NEW]** For lab-type documents (Blood Report, Lipid Profile, HbA1c): **Extract values (AI)**.
- **[NEW]** For ECG documents: **Analyse ECG (AI)**.

### 3.5 Consultation page (`/doctor/consultations/:id`) [CHANGED]

**Header:**
- Visit ID, date, hospital, status (Draft/Final).
- **Patient record** button.
- **See all drafts** link.
- Messages:
  - *"Resumed your draft from <date>"*,
  - *"Read-only: this visit belongs to Dr. X"* when another doctor views it,
  - *"Final, cannot be edited"*.

**Patient context side box:** age, BMI, smoking/alcohol, allergies, known conditions, current
medications.

**Section 1: Patient complaints**
- Checkboxes: Chest pain, Breathlessness, Palpitations, Fatigue, Dizziness, Sweating, Other.
- Free text for duration and details.
- **[NEW] Structured symptoms** (read by the AI trend engine). Each select starts at "Not assessed",
  which is different from "No":
  - **Chest pain** (Yes / No) and **Fainting (syncope)** (Yes / No): always shown.
  - When chest pain = Yes: Duration, Location, **Severity 0–10**, **Pain type** (Typical angina /
    Atypical angina / Non-anginal), **Radiates to** (Does not radiate / Left arm / Jaw-neck / Back /
    Both arms), **Occurs at rest** (Yes / No, on exertion only).
  - When Breathlessness is ticked: **Breathlessness class (NYHA I–IV)**, with a one-line meaning
    for each class.
  - Red alert banners appear for: chest pain at rest or with severity ≥ 7, sweating or
    breathlessness; syncope; NYHA class IV.

**Section 2: Clinical examination (vitals)**

| Field | Unit |
|---|---|
| Systolic BP | mmHg |
| Diastolic BP | mmHg |
| Heart rate | bpm |
| Respiratory rate | /min |
| Oxygen saturation | % |
| Temperature | °C |
| Height | cm |
| Weight | kg |

- BMI is calculated automatically (show it as a read-only calculated value).
- **Clinical alerts** [EXISTS]: small warning chips appear instantly while typing, e.g.
  "BP ≥ 140/90: Stage 2 hypertension" or "SpO₂ < 94%".

**[NEW] Section 2b: Lab values (numeric)**

| Field | Unit |
|---|---|
| Total cholesterol | mg/dL |
| LDL | mg/dL |
| HDL | mg/dL |
| Triglycerides | mg/dL |
| Fasting glucose | mg/dL |
| HbA1c | % |
| Creatinine | mg/dL |
| eGFR | mL/min/1.73m² |

- Each field shows its unit inside or next to the input.
- **Button: "Fill from uploaded report (AI)".** It opens the extraction review (§3.12).
- Each value shows a small source tag: *Entered manually* or *From report · verified*.
- The labs feed the trend graphs, so the labels must be clear.

**Section 3: Clinical observations:** text areas for:
- General examination
- Cardiovascular examination
- Respiratory examination
- ECG observations
- Blood report observations
- Physical examination
- Additional notes

**Section 4: Diagnosis and assessment**
- Preliminary diagnosis, **Final diagnosis** (required to finalize).
- Clinical assessment, Suspected conditions, CAD risk assessment (the doctor's own words),
  Supporting findings, Recommended investigations.
- Follow-up date.
- Doctor's notes.

**[CHANGED] AI CAD screening card** (replaces today's placeholder):
- A compact version of the AI Insights panel (§3.10) for this patient.
- It **includes the values of the visit being written**, so the doctor can see how today's
  numbers change the trend.
- **Buttons:** **Run AI screening** and **Calculate 10-year risk (PCE)**.

**Test reports for this visit:**
- An upload form and list (same as the documents section).
- Lab reports have **Extract values (AI)**; ECG files have **Analyse ECG (AI)**.

**Prescription section:**
- A list of prescriptions already issued for this visit.
- **+ Write prescription** opens a form:
  - medicine rows (name, dosage, frequency, duration in days, timing, notes),
  - **+ Add medicine** and a remove ✕ per row,
  - General instructions,
  - **Issue prescription** and **Cancel**.
- Prescriptions can't be edited after they are issued. Show a lock or "issued" style.
- **[NEW]** **Download PDF** on each issued prescription.

**Sticky action bar** (only while the visit is a draft and owned by this doctor):
- Save status text: "Unsaved changes", "Draft saved at 10:42", or an error in red.
- **Save draft** button.
- **Finalize consultation** button (primary). It needs a final diagnosis and then locks the
  visit.
- **[NEW]** A confirmation step before finalizing: *"Finalizing locks this visit. Continue?"*
  with **Finalize** / **Keep editing**.

**Share & follow-up card** (after finalizing, owner only):
- **Share with patient** / **Stop sharing** toggle, with the text: *"Sharing shows the diagnosis
  and summary in the patient's portal and notifies them."*
- Follow-up: *"Suggested follow-up date: …"* with a **Book follow-up** button. It opens
  Appointments with the booking form pre-filled.

### 3.6 Appointments (`/doctor/appointments`) [EXISTS]

**Book appointment form:**
- Patient (from your patients, pre-filled when coming from a visit),
- date, time,
- duration,
- reason (full width),
- **Book appointment** button.
- Error shown if the slot clashes with another appointment.

**Tabs:** **Upcoming** / **Past**.

**Row actions:**
- **Open** (primary when "Now")
- **Done**
- **Cancel** (red text)
- **Missed**

### 3.7 Drafts (`/doctor/drafts`) [EXISTS]
- A list of unfinished consultations: patient, Visit ID, started date, last saved.
- **Resume** button on each.
- **Empty state:** "No drafts. Every consultation is finalized."

### 3.8 My Profile (doctor, `/doctor/profile`) [EXISTS]

**Header card:** Dr. name, Doctor ID, specialization, hospital, and an **Edit profile** button.

**Stat tiles:** Patients with access · Finalized consultations · Prescriptions issued.

**Sections:**
- **Personal details:** Full name, Email, Phone, Gender.
- **Professional details:** Specialization, Qualification, License number, Experience.
- **Hospital:** Name, City, Address.

**Edit mode:** an inline form with **Save** / **Cancel**.

### 3.9 Drafts badge and global search (optional)
- A suggested addition: a quick "Search Patient ID" box in the doctor's top bar.

### 3.10 [NEW] AI Insights panel: detailed spec

This panel appears on the Patient Profile (full size) and on the Consultation page (compact).

**(1) Review priority badge**

| Engine value → **label shown** | Meaning shown to doctor | Suggested tone |
|---|---|---|
| `URGENT_REVIEW` → **Critical** | Significant worsening found; review soon | strong red |
| `REVIEW` → **Needs review** | Some values worsening across visits | amber |
| `NO_FLAGGED_PROGRESSION` → **No concern found** | No worrying trend found in the available data | green/neutral (**not** "healthy") |
| `INSUFFICIENT_DATA` → **Not enough data** | Not enough visits or values to judge a trend | grey |

- Use these labels everywhere on the doctor side. Don't use "Emergency": this is a trend
  across past visits, not a check of the patient's condition right now. Patients never see
  these labels (see §2.6 for their wording).

- **Under the badge:** "Based on **4 visits** at **3 hospitals**, Jan 2026 – Oct 2026 · Analysed
  3 Nov 2026 10:15".
- **Important:** this is **not a probability**. Don't add "%" or a gauge to it.
- **[NEW] Share with patient** (saved assessments only, not previews):
  - The button opens a small form with an optional "Note for the patient" (plain words, 500
    characters) and a line explaining what the patient will see.
  - **Share** / **Cancel**.
  - Once shared: a green pill "Shared with patient", the date, the note and **Stop sharing**.
  - Sharing sends the patient a bell notification: "Heart health check shared".

**(2) AI summary card**

Sections, rendered as headings:
- **Overview**: 2–3 lines.
- **What changed**: bullets, each citing values and dates, e.g. *"LDL rose from 95 to 155 mg/dL
  (+63%) between Jan and Oct 2026."*
- **Points to review**: bullets.
- **Data gaps**: e.g. *"No HbA1c in the last 6 months."*

Each bullet can carry **visit chips** (`MEDIS-V-000789`); clicking one opens that visit.

Footer:
- *"AI-generated from structured visit data · Model: … · 3 Nov 2026 10:16"*,
- **Regenerate** and **Copy**,
- **Share with patient** toggle (off by default).

States:
- No assessment yet: an empty state with a **Run analysis** button.
- Generating: a skeleton text block.
- Failed: error text and **Try again**.

**(3) Trend graphs** (the graph the doctor asked for)

- **Type:** a **line chart over time** (x-axis = visit date, true time scale).
  - One point per visit. **Missing values are skipped**: the line must not drop to 0.
- **Metric selector** (tabs or chips) in groups:
  - **Blood pressure**: systolic and diastolic on one chart (mmHg).
  - **Cholesterol**: LDL, HDL, Total, Triglycerides (mg/dL).
  - **Sugar**: HbA1c (%) and Fasting glucose (mg/dL). Use **separate y-axes or separate small
    charts**, because the units differ.
  - **Body**: BMI, Heart rate.
  - **Kidney**: Creatinine, eGFR.
- **Reference band** (light shaded area) showing the normal or target range, e.g.
  LDL < 100, SBP < 130, HbA1c < 5.7. The engineering team will supply the exact values.
- **Point tooltip:** value and unit, date, hospital, Visit ID, doctor.
- **Point marker** by hospital (shape or outline) is optional, so a doctor can see the data came
  from different hospitals.
- **Header line above each chart**, from the engine:
  - change (e.g. **+60 mg/dL / +63%**),
  - direction arrow (↑ worsening, ↓ improving, → stable; the colour depends on the metric:
    HDL ↑ is good),
  - the number of readings.
- **Small multiples / sparklines (optional):** a compact grid with one sparkline per metric and
  its % change, as an overview before the full chart.
- **Empty state per metric:** "No LDL recorded yet." A trend needs at least 2 readings at least
  30 days apart. Otherwise show the single value with the note *"Need another reading to show a
  trend."*
- **Stale data note:** if the latest reading is over a year old, mark it *"Last measured
  >12 months ago"*.

**(4) Flags and evidence list**
- Rows such as:
  - "Sustained BP rise across 3 visits",
  - "LDL increasing despite statin prescription",
  - "New symptom: exertional chest pain since Mar 2026".
- Each row has a severity icon, a short explanation and the dated evidence (visit chips).
- Expandable: **Show evidence**.

**(5) Data quality notes** (collapsible, small grey text)
- e.g. "2 readings excluded (conflicting same-day values)" or "HbA1c not recorded at Fortis
  visit".

**(6) 10-year risk (PCE) card**
- **Title:** "10-year ASCVD risk (Pooled Cohort Equations, 2013)".
- **Button:** **Calculate**. It opens a **confirmation form**, because the doctor must confirm
  each input. The system **never guesses** them.
  - Sex (Male / Female)
  - Race/cohort (as required by the equation)
  - Age (pre-filled)
  - Total cholesterol, HDL, Systolic BP (pre-filled from the latest visit, editable, with
    "measured on <date>" shown)
  - On BP treatment? (Yes / No)
  - Diabetes? (Yes / No)
  - Current smoker? (Yes / No)
  - Known heart disease or stroke (ASCVD)? (Yes / No)
  - Snapshot date
  - Every Yes/No starts **unselected**. **Calculate** stays disabled until every input is
    answered.
- **Result:**
  - a big **% number** and a category label,
  - "Inputs confirmed by Dr. X on <date>",
  - a limitations note *"Legacy 2013 equation; not calibrated for Indian populations."*
- **Blocked state:** if the patient already has known ASCVD, show *"Not applicable: patient
  has known ASCVD."*, not a number.

**(7) Latest ECG analysis card**
- **Shows:**
  - the source file name and type (digital / PDF / image),
  - the date analysed.
- **Results:**
  - **Classification:** `Normal (NORM)` or `Possible myocardial infarction (MI)`, with a
    confidence bar.
  - **Signal quality** checklist: leads detected, duration, noise. Each item shows ✓ or ⚠.
  - Intervals, when available (from paper ECGs): HR, PR, QRS, QT/QTc.
  - **Waveform image** (optional): the digitised trace.
- **States (all must be designed):**

| Status | What to show |
|---|---|
| Completed | Classification, confidence, quality, intervals |
| **Blocked** | ⚠ "AI classification not run: the printout segment is too short / leads missing. Measurements shown where available." **Never show "Normal" in this case.** |
| Low quality | **Classification withheld**: "This recording failed the signal quality checks. Check the leads and recording, then upload it again." Quality notes and intervals are still shown. |
| Failed | "Couldn't read this file. Try a clearer scan or the digital ECG file." |
| Running | Progress spinner: "Analysing ECG…" |

- **Buttons:** **Analyse ECG** (on the document), **View details**, **Re-run**.
- **[NEW] Digital ECG recording** (in the AI Insights panel, on the patient profile and the
  consultation page):
  - A file picker for multiple files: `.hea` with its `.dat`/`.mat` (WFDB), or one `.csv`/`.npy`
    with 12 lead columns covering 10 seconds.
  - **Upload & analyse** is disabled until the selection is valid.
  - Inline errors: missing `.dat`/`.mat` for a `.hea` (or the reverse), an unsafe filename,
    more than 16 files, a file over 25 MB.
  - Help line: "The files are analysed, not stored; the result is saved to the patient's record."
  - Shows the ECG result card (above) after upload; the "Recent ECG analyses" list refreshes.

### 3.11 [NEW] Critical patients list (Overview → My Patients filter)
- Built into My Patients (§3.3): the "AI check" pill and date, the filter dropdown, and Critical
  first.

### 3.12 [NEW] "Extract values from report" review dialog
- **Opened from:** **Extract values (AI)** on a document, or **Fill from uploaded report** in a
  consultation.
- **Layout:** two parts. The document preview (image or PDF page) on one side, the extracted
  values table on the other.
- **Table columns:**
  - ☐ checkbox
  - Test
  - Extracted value
  - Unit
  - Converted to standard unit
  - Confidence
  - Source text snippet
- **Behaviour:**
  - Every row starts **unticked**. The doctor ticks each one after checking it and can edit
    any value.
  - Low-confidence rows are highlighted.
- **Buttons:**
  - **Apply selected to this visit** (disabled until at least one row is ticked)
  - **Reject extraction**
  - **Cancel**
- **Banner:** *"Values read by AI from the report. Check each value against the document before
  applying."*
- **States:**
  - reading the document (spinner, can take ~10 s),
  - nothing found ("No lab values recognised"),
  - OCR unavailable.

---

## 4. Shared components (reuse on both sides)

| Component | Used in | Notes |
|---|---|---|
| Notification bell plus dropdown | Patient header, doctor layout | Unread badge, **Mark all as read** |
| Visit timeline | Patient dashboard, doctor Patient Profile | Vertical timeline; the patient view hides unshared diagnoses |
| Access history | Both | Doctor, hospital, first and last access, source |
| Document upload plus list | Patient dashboard, doctor profile, consultation | Type, hospital, date, file, note; list with status and **View** |
| Prescription card | Both | **[NEW]** PDF button |
| Field (label: value) | Profiles | "—" when empty |
| ID chip | Everywhere | **[NEW]** copy button |
| Status pill | Everywhere | See §0.3 |
| **[NEW]** AI badge plus disclaimer | All AI outputs | §0.5 |
| **[NEW]** Review-priority pill | My Patients, AI panel | §3.10(1) |
| **[NEW]** Trend chart | AI panel | §3.10(3) |
| **[NEW]** Chat panel | Patient | §2.10 |

---

## 5. Data glossary: what the measurements mean (for labels and tooltips)

| Label | Unit | Plain-language meaning (for patient tooltips) |
|---|---|---|
| Systolic / Diastolic BP | mmHg | Blood pressure (top / bottom number) |
| Heart rate | bpm | Heartbeats per minute |
| SpO₂ | % | Oxygen level in the blood |
| BMI | kg/m² | Weight relative to height |
| Total cholesterol | mg/dL | All cholesterol in the blood |
| LDL | mg/dL | "Bad" cholesterol; lower is better |
| HDL | mg/dL | "Good" cholesterol; higher is better |
| Triglycerides | mg/dL | A type of blood fat |
| Fasting glucose | mg/dL | Blood sugar after not eating |
| HbA1c | % | Average blood sugar over about 3 months |
| Creatinine / eGFR | mg/dL / mL/min/1.73m² | Kidney function |

---

## 6. Demo data for mock-ups

Use these logins to see real data:

| Account | Email | Password |
|---|---|---|
| Doctor (Apollo) | doctor1@demo.com | Demo@1234 |
| Doctor (Manipal) | doctor2@demo.com | Demo@1234 |
| Patient: Rahul Sharma (4 visits, worsening trend) | patient1@demo.com | Demo@1234 |
| Patient: Ananya Nair (1 visit plus 1 draft) | patient2@demo.com | Demo@1234 |

**Rahul's trend, ideal for the graph mock-ups:**

| Month (2026) | BP | LDL | HbA1c |
|---|---|---|---|
| Jan | 120/80 | 95 | 5.5 |
| Mar | 130/85 | 110 | 5.9 |
| Jun | 140/90 | 135 | 6.2 |
| Oct | 150/95 | 155 | 6.8 |

The expected AI review priority for Rahul is **REVIEW** or **URGENT REVIEW**.
