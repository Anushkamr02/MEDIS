# MEDIS paper handoff

Current manuscript: [final Word paper](MEDIS_IEEE_Paper_Final.docx), the two-column version with author blocks, corrected against the code on 24 Nov 2026. It was built from `MEDIS_IEEE_Paper_Reviewed.docx`; `MEDIS_IEEE_Paper_Proofread.docx` is an alternative single-byline wording and still has the prescription-flag error below.

**Prescription flag.** `PRESCRIPTION_LIST_CHANGE` (`backend/medis/ai/visit_patterns.py`) compares consecutive recorded lists issued within 90 days. In the demo seed it fires for January to March (65 days), not June to October (108 days). It sits in the visit-pattern report; "Needs review" comes from the lipid, BP, glucose and HbA1c trajectory and threshold flags.

**Project.** MEDIS stands for Medical Evaluation and Diagnostic Intelligence System. One patient ID links visits, prescriptions and reports across participating sites. Doctors start and finalize consultations, issue prescriptions and share findings. Patients view records and manage doctor access. Migration v11 supports approval, revocation and logged emergency access with a reason.

**AI.** Rules flag changes across visits. Graphs retain the source visit. The doctor’s summary runs locally in `backend/record_summary.py`. Google Gemini powers patient chat using patient-visible records. ECG classification and lab-report OCR are additional project features.

**Evidence, 24 Nov 2026, commit `7c7c3d5`.** A synthetic doctor-to-patient prescription walkthrough passed. Four visits at two sites showed LDL cholesterol rising from 95 to 155 mg/dL over 269 days. The engine returned “Needs review.” All 61 backend and 8 JavaScript unit tests passed. Desktop browser tests had 45 passes and 8 failures. Live Gemini accuracy, deployed access controls and clinical utility remain unverified.

**Editorial review.** The paper discloses ChatGPT’s drafting and figure assistance. A local comparison found zero exact eight-word matches against five cited full texts and one cited abstract, excluding the bibliography. No institutional similarity score was obtained.
