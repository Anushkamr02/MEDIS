// patient_health_summaries (migration v14): what a patient sees, written and published by a doctor.

// Doctor-chosen status; never derived from the AI priority. Same wording in
// backend/medis/reports/medical_history_pdf.py.
export const SUMMARY_STATUS = {
  steady: 'Your results look steady',
  keep_an_eye: 'Some results to keep an eye on',
  book_visit: 'Please book a visit to discuss',
};

// Plain-language names for the measured values a doctor may show.
export const PATIENT_METRICS = {
  systolic_bp: 'Blood pressure (top number)',
  diastolic_bp: 'Blood pressure (bottom number)',
  ldl_cholesterol: 'LDL ("bad") cholesterol',
  hdl_cholesterol: 'HDL ("good") cholesterol',
  total_cholesterol: 'Total cholesterol',
  triglycerides: 'Triglycerides (blood fats)',
  fasting_glucose: 'Fasting blood sugar',
  hba1c: 'HbA1c (3-month average sugar)',
  bmi: 'Body mass index (BMI)',
  serum_creatinine: 'Creatinine (kidney)',
  egfr: 'eGFR (kidney function)',
};

// Measured values only (Q9): dates and numbers, without the engine's direction,
// flags or the visit and hospital evidence.
export function copyMetrics(trajectories, keys) {
  return Object.fromEntries(
    keys
      .map((k) => [k, (trajectories?.[k]?.points ?? []).filter((p) => p.value != null).map(({ date, value }) => ({ date, value }))])
      .filter(([, points]) => points.length)
      .map(([k, points]) => [k, { label: PATIENT_METRICS[k] ?? k, unit: trajectories[k].unit, count: points.length, points }])
  );
}

// The numbers Gemini's draft could not trace to the record that are still in
// the text. Publishing is blocked until the doctor corrects or removes them.
export function remainingUnverified(text, unverified = []) {
  return unverified.filter((n) => new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}(?![\\d])`).test(text));
}
