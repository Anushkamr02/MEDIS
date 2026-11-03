"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  patient: null,
  visits: [],
  visit: null,
  mode: "login",
  revision: 0,
};
const node = (tag, text, cls) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = error ? "error" : "";
  $("notice").hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(
    () => ($("notice").hidden = true),
    error ? 15000 : 8000,
  );
}
async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (state.session)
    headers.Authorization = `Bearer ${state.session.access_token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let detail;
    try {
      detail = (await response.json()).detail;
    } catch {
      detail = response.statusText;
    }
    if (Array.isArray(detail))
      detail = detail
        .map((d) => `${d.loc.slice(1).join(".")}: ${d.msg}`)
        .join("\n");
    throw new Error(
      typeof detail === "string"
        ? detail
        : `Request failed (${response.status})`,
    );
  }
  if (options.download) return response.blob();
  return response.json();
}
function action(id, event, fn) {
  $(id).addEventListener(event, async (e) => {
    e.preventDefault();
    const buttons = e.currentTarget.matches("button")
      ? [e.currentTarget]
      : [...e.currentTarget.querySelectorAll("button")];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await fn(e);
    } catch (error) {
      notify(error.message, true);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}
function field(container, name, label, type = "text", options) {
  const wrap = node("label", label, type === "checkbox" ? "checkbox" : "");
  let input;
  if (Array.isArray(options)) {
    input = node("select");
    options.forEach((value) => {
      const o = node("option", value);
      o.value = value;
      input.append(o);
    });
  } else input = node(type === "textarea" ? "textarea" : "input");
  input.name = name;
  if (input.tagName === "INPUT") input.type = type;
  if (type === "number") input.step = "any";
  if (options === true) input.required = true;
  wrap.append(input);
  container.append(wrap);
  return input;
}
function formData(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.type === "file") continue;
    data[el.name] =
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? el.value === ""
            ? null
            : Number(el.value)
          : el.value.trim() || null;
  }
  return data;
}
function details(parent, title, data) {
  const d = node("details");
  d.append(node("summary", title), node("pre", JSON.stringify(data, null, 2)));
  parent.append(d);
}
function metrics(parent, values) {
  const grid = node("div", undefined, "metrics");
  for (const [label, value] of Object.entries(values)) {
    const item = node("div", undefined, "metric");
    item.append(node("span", label), node("strong", value ?? "Not recorded"));
    grid.append(item);
  }
  parent.append(grid);
}
function table(parent, rows) {
  if (!rows.length) {
    parent.append(node("p", "No records available.", "empty"));
    return;
  }
  const wrap = node("div", undefined, "table-wrap"),
    t = node("table"),
    head = node("tr");
  Object.keys(rows[0]).forEach((k) =>
    head.append(node("th", k.replaceAll("_", " "))),
  );
  t.append(head);
  rows.forEach((row) => {
    const tr = node("tr");
    Object.values(row).forEach((v) => tr.append(node("td", v ?? "—")));
    t.append(tr);
  });
  wrap.append(t);
  parent.append(wrap);
}
function needPatient() {
  if (!state.patient) throw new Error("Open a patient record first.");
  return encodeURIComponent(state.patient.patient_id);
}
function needVisit() {
  needPatient();
  if (!state.visit)
    throw new Error("Select or start a consultation visit first.");
  return encodeURIComponent(state.visit);
}
async function download(path, name) {
  const blob = await request(path, { download: true });
  const url = URL.createObjectURL(blob),
    a = node("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderAuth() {
  const fields = $("auth-fields");
  fields.replaceChildren();
  const role = $("role").value,
    register = state.mode === "register";
  $("auth-title").textContent = register
    ? "Create your account"
    : "Welcome back";
  $("auth-submit").textContent = register ? "Create account" : "Sign in";
  $("login-mode").classList.toggle("selected", !register);
  $("register-mode").classList.toggle("selected", register);
  if (!register)
    field(
      fields,
      `${role}_id`,
      `${role === "doctor" ? "Doctor" : "Patient"} MEDIS ID`,
      "text",
      true,
    );
  else {
    field(fields, "full_name", "Full name", "text", true);
    if (role === "doctor") {
      field(
        fields,
        "medical_registration_number",
        "Medical registration number",
        "text",
        true,
      );
      field(fields, "hospital_name", "Hospital", "text", true);
      field(fields, "email", "Email", "email", true);
      field(fields, "qualification", "Qualification", "text", true);
      field(fields, "specialization", "Specialization", "text", true);
    } else {
      field(fields, "gender", "Gender", "text", ["Male", "Female", "Other"]);
      field(fields, "age", "Age", "number").min = 0;
      field(fields, "date_of_birth", "Date of birth", "date");
      field(fields, "contact_number", "Contact number", "tel", true);
      field(fields, "blood_group", "Blood group", "text", [
        "",
        "A+",
        "A-",
        "B+",
        "B-",
        "AB+",
        "AB-",
        "O+",
        "O-",
      ]);
    }
  }
  const password = field(fields, "password", "Password", "password", true);
  password.minLength = 6;
  password.autocomplete = register ? "new-password" : "current-password";
}
$("role").addEventListener("change", renderAuth);
$("login-mode").onclick = () => {
  state.mode = "login";
  renderAuth();
};
$("register-mode").onclick = () => {
  state.mode = "register";
  renderAuth();
};
action("auth-form", "submit", async (e) => {
  const role = $("role").value;
  state.session = await request(`/api/auth/${role}/${state.mode}`, {
    method: "POST",
    body: formData(e.target),
  });
  enterWorkspace();
  notify(`Signed in. Your MEDIS ID: ${state.session.user_id}`);
  if (role === "patient") await loadPatient(state.session.user_id);
});
function enterWorkspace() {
  const doctor = state.session.role === "DOCTOR";
  $("auth-view").hidden = true;
  $("workspace").hidden = false;
  $("account-role").textContent = doctor ? "DOCTOR PORTAL" : "PATIENT PORTAL";
  $("account-name").textContent = state.session.name;
  $("account-id").textContent = state.session.user_id;
  $("patient-search").hidden = !doctor;
  $("prescription-editor").hidden = !doctor;
  $("legacy-risk-editor").hidden = !doctor;
  const nav = $("navigation");
  nav.replaceChildren();
  const sections = [
    ["record", "Patient record"],
    ["consultation", "Consultation"],
    ["prescriptions", "Prescriptions"],
    ["patterns", "Trends & patterns"],
    ["documents", "Documents"],
    ["ecg", "ECG analysis"],
    ["audit", "Audit activity"],
  ];
  sections
    .filter(([id]) => doctor || !["consultation", "ecg", "audit"].includes(id))
    .forEach(([id, title]) => {
      const b = node("button", title);
      b.type = "button";
      b.dataset.panel = id;
      b.onclick = () => showPanel(id, title);
      nav.append(b);
    });
  showPanel("record", "Patient record");
}
function showPanel(id, title) {
  document
    .querySelectorAll(".panel")
    .forEach((p) => (p.hidden = p.id !== `${id}-panel`));
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.panel === id));
  $("page-title").textContent = title;
  if (id === "audit") loadAudit().catch((e) => notify(e.message, true));
  if (id === "patterns" && state.patient)
    loadPatterns().catch((e) => notify(e.message, true));
  if (id === "documents" && state.session.role === "PATIENT")
    loadDocuments().catch((e) => notify(e.message, true));
}
$("logout").onclick = () => location.reload();
action("patient-search", "submit", (e) =>
  loadPatient(formData(e.target).patient_id),
);
async function loadPatient(id) {
  const revision = ++state.revision;
  state.patient = null;
  state.visit = null;
  state.visits = [];
  $("risk-form").reset();
  resetClinicalForms();
  $("active-visit").replaceChildren(node("option", "Select a visit"));
  $("active-visit").firstChild.value = "";
  $("patient-summary").textContent = "Loading patient…";
  for (const name of ["timeline", "prescriptions", "assessment", "documents"])
    $(name).replaceChildren();
  try {
    const patient = await request(`/api/patients/${encodeURIComponent(id)}`);
    if (revision !== state.revision) return;
    state.patient = patient;
    $("patient-summary").replaceChildren(
      node("strong", patient.full_name),
      node(
        "span",
        `${patient.patient_id} · ${patient.age ?? "Age not recorded"} · ${patient.gender}`,
      ),
    );
    await refreshTimeline();
    await loadPrescriptions();
  } catch (error) {
    if (revision === state.revision)
      $("patient-summary").textContent = "Patient could not be loaded.";
    throw error;
  }
}
async function refreshTimeline() {
  const id = needPatient(),
    revision = state.revision;
  const visits = await request(`/api/patients/${id}/timeline`);
  if (revision !== state.revision) return;
  state.visits = visits;
  const target = $("timeline");
  target.replaceChildren();
  target.className = "";
  if (!visits.length)
    target.append(node("p", "No visits recorded yet.", "empty"));
  [...visits].reverse().forEach((v) => {
    const card = node("article", undefined, "card visit");
    card.append(
      node("div", `${v.visit_date} · ${v.status}`, "date"),
      node("h3", v.hospital_name),
      node("p", `${v.doctor_name} · ${v.visit_type}`),
      node("strong", v.chief_complaint || "Complaint not recorded"),
    );
    metrics(card, {
      "Blood pressure": v.blood_pressure,
      "Heart rate": v.heart_rate,
      "LDL cholesterol": v.ldl_cholesterol,
      HbA1c: v.hba1c,
    });
    card.append(node("p", `Diagnosis: ${v.diagnosis || "Pending"}`));
    target.append(card);
  });
  const select = $("active-visit");
  select.replaceChildren();
  const blank = node("option", "Select a visit");
  blank.value = "";
  select.append(blank);
  [...visits].reverse().forEach((v) => {
    const option = node(
      "option",
      `${v.visit_date} · ${v.hospital_name} · ${v.visit_id}`,
    );
    option.value = v.visit_id;
    select.append(option);
  });
  select.value = state.visit || "";
}
function resetClinicalForms() {
  for (const id of [
    "symptoms-form",
    "measurements-form",
    "notes-form",
    "prescription-form",
  ])
    $(id).reset();
  $("symptoms-form").elements.chest_pain_severity.value = 0;
  $("medicine-items").replaceChildren();
  addMedicine();
}
$("active-visit").onchange = (e) => {
  state.visit = e.target.value || null;
  resetClinicalForms();
};
action("start-visit", "submit", async (e) => {
  const patient = needPatient();
  const result = await request("/api/consultations/start", {
    method: "POST",
    body: {
      ...formData(e.target),
      patient_id: decodeURIComponent(patient),
      doctor_id: state.session.user_id,
    },
  });
  state.visit = result.visit_id;
  resetClinicalForms();
  await refreshTimeline();
  notify(`Visit started: ${state.visit}`);
});

const symptoms = [
  ["chief_complaint", "Chief complaint", "textarea"],
  ["chest_pain_present", "Chest pain", "checkbox"],
  [
    "chest_pain_type",
    "Chest pain type",
    "text",
    ["None", "Typical Angina", "Atypical", "Non-Anginal"],
  ],
  ["chest_pain_severity", "Pain severity (0–10)", "number"],
  ["chest_pain_duration", "Pain duration"],
  ["chest_pain_radiation", "Radiation"],
  ["breathlessness_present", "Breathlessness", "checkbox"],
  [
    "breathlessness_nyha_class",
    "Recorded NYHA class",
    "text",
    ["None", "Class I", "Class II", "Class III", "Class IV"],
  ],
  ["palpitations", "Palpitations", "checkbox"],
  ["fatigue", "Fatigue", "checkbox"],
  ["syncope", "Syncope", "checkbox"],
  ["ankle_swelling", "Ankle swelling", "checkbox"],
  ["additional_symptoms", "Additional symptoms", "textarea"],
];
symptoms.forEach((args) => field($("symptom-fields"), ...args));
const severity = $("symptoms-form").elements.chest_pain_severity;
severity.min = 0;
severity.max = 10;
severity.step = 1;
severity.value = 0;
const measurements = {
  systolic_bp: "Systolic BP (mmHg)",
  diastolic_bp: "Diastolic BP (mmHg)",
  heart_rate: "Heart rate (bpm)",
  respiratory_rate: "Respiratory rate (/min)",
  temperature: "Temperature (°C)",
  spo2: "SpO₂ (%)",
  height_cm: "Height (cm)",
  weight_kg: "Weight (kg)",
  fasting_glucose: "Fasting glucose (mg/dL)",
  postprandial_glucose: "Postprandial glucose (mg/dL)",
  hba1c: "HbA1c (%)",
  total_cholesterol: "Total cholesterol (mg/dL)",
  ldl_cholesterol: "LDL (mg/dL)",
  hdl_cholesterol: "HDL (mg/dL)",
  triglycerides: "Triglycerides (mg/dL)",
  serum_creatinine: "Creatinine (mg/dL)",
  egfr: "eGFR (mL/min/1.73m²)",
};
Object.entries(measurements).forEach(
  ([key, label]) =>
    (field($("measurement-fields"), key, label, "number").min = 0),
);
for (const [key, label] of Object.entries({
  chief_complaint: "Chief complaint",
  history_of_present_illness: "History of present illness",
  past_medical_history: "Past medical history",
  general_examination_notes: "General examination",
  cardiovascular_exam_notes: "Cardiovascular examination",
  provisional_diagnosis: "Provisional diagnosis",
  final_diagnosis: "Final diagnosis",
  clinical_observations: "Clinical observations",
}))
  field($("note-fields"), key, label, "textarea");
field($("note-fields"), "status", "Note status", "text", [
  "DRAFT",
  "FINALIZED",
]);
for (const [form, endpoint] of [
  ["symptoms-form", "symptoms"],
  ["measurements-form", "measurements"],
  ["notes-form", "notes"],
])
  action(form, "submit", async (e) => {
    const data = formData(e.target);
    if (endpoint === "symptoms" && data.chest_pain_severity === null)
      data.chest_pain_severity = 0;
    await request(`/api/consultations/${needVisit()}/${endpoint}`, {
      method: "POST",
      body: data,
    });
    await refreshTimeline();
    notify("Saved successfully.");
  });

for (const [key, label] of Object.entries({
  diagnosis: "Diagnosis",
  general_advice: "General advice",
  follow_up_date: "Follow-up date / instructions",
}))
  field($("prescription-fields"), key, label, "text", key === "diagnosis");
function addMedicine() {
  const row = node("div", undefined, "medicine"),
    grid = node("div", undefined, "form-grid");
  for (const [key, label] of Object.entries({
    medicine_name: "Generic medicine name",
    dosage: "Dosage",
    frequency: "Frequency",
    duration: "Duration (e.g. 30 days)",
    instructions: "Instructions",
  }))
    field(grid, key, label, "text", key !== "instructions");
  const remove = node("button", "Remove medicine", "secondary");
  remove.type = "button";
  remove.onclick = () => row.remove();
  row.append(grid, remove);
  $("medicine-items").append(row);
}
$("add-medicine").onclick = addMedicine;
addMedicine();
action("prescription-form", "submit", async (e) => {
  const items = [...$("medicine-items").children].map((row) => {
    const item = {};
    row
      .querySelectorAll("input")
      .forEach((el) => (item[el.name] = el.value.trim()));
    return item;
  });
  if (!items.length) throw new Error("Add at least one medicine.");
  const body = {
    visit_id: decodeURIComponent(needVisit()),
    patient_id: state.patient.patient_id,
    doctor_id: state.session.user_id,
    items,
  };
  for (const key of ["diagnosis", "general_advice", "follow_up_date"])
    body[key] = e.target.elements[key].value;
  const result = await request("/api/prescriptions/create", {
    method: "POST",
    body,
  });
  await loadPrescriptions();
  notify(`Prescription created: ${result.prescription_id}`);
});
async function loadPrescriptions() {
  const id = needPatient(),
    revision = state.revision;
  const rows = await request(`/api/patients/${id}/prescriptions`);
  if (revision !== state.revision) return;
  const target = $("prescriptions");
  target.className = "";
  target.replaceChildren();
  if (!rows.length)
    target.append(node("p", "No prescriptions recorded.", "empty"));
  rows.forEach((rx) => {
    const card = node("article", undefined, "card");
    card.append(
      node("h3", rx.prescription_id),
      node("p", `${rx.date} · ${rx.diagnosis}`),
    );
    const b = node("button", "Download PDF", "secondary");
    b.onclick = () =>
      download(rx.pdf_url, `${rx.prescription_id}.pdf`).catch((e) =>
        notify(e.message, true),
      );
    card.append(b);
    target.append(card);
  });
}
action("history-download", "click", () =>
  download(
    `/api/reports/patient-history/${needPatient()}/pdf`,
    "MEDIS-history.pdf",
  ),
);

function chart(parent, title, history, key, sampleAxis = false) {
  const points = history
    .map((row) => ({ x: Date.parse(row.date), y: row[key] }))
    .filter(
      (p) =>
        Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y),
    );
  if (points.length < 2) return;
  const box = node("div"),
    canvas = node("canvas", undefined, "chart");
  canvas.width = 700;
  canvas.height = 250;
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    `${title}: ${points.map((p) => p.y).join(", ")}`,
  );
  box.append(
    node("h3", title),
    canvas,
    node(
      "p",
      sampleAxis
        ? `${points.length} samples · amplitude ${minValue(points)} to ${maxValue(points)}`
        : `${new Date(points[0].x).toISOString().slice(0, 10)} → ${new Date(points.at(-1).x).toISOString().slice(0, 10)} · ${points[0].y} → ${points.at(-1).y}`,
      "chart-label",
    ),
  );
  parent.append(box);
  const ctx = canvas.getContext("2d"),
    xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  ctx.strokeStyle = "#087f76";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = 35 + ((p.x - minX) / (maxX - minX || 1)) * 630,
      y = 215 - ((p.y - minY) / (maxY - minY || 1)) * 175;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#647b7b";
  ctx.font = "16px sans-serif";
  ctx.fillText(String(maxY), 8, 22);
  ctx.fillText(String(minY), 8, 240);
}
async function loadPatterns(riskInputs = null) {
  const id = needPatient(),
    revision = state.revision;
  $("assessment").textContent = "Analyzing available records…";
  const report = await request(
    `/api/ai/longitudinal/${id}`,
    riskInputs ? { method: "POST", body: riskInputs } : {},
  );
  if (revision !== state.revision) return;
  if (report.error) throw new Error(report.error);
  const target = $("assessment");
  target.className = "";
  target.replaceChildren();
  const summary = node("div", undefined, `card risk-${report.risk_category}`);
  summary.append(
    node(
      "h2",
      `Review priority: ${(report.review_priority || report.risk_category).replaceAll("_", " ")}`,
    ),
    node("p", report.overall_assessment),
    node("p", report.risk_method, "small"),
  );
  metrics(summary, {
    "Visits analyzed": report.visits_analyzed_count,
    "Hospitals (365 days)":
      report.visit_patterns?.distinct_hospitals_last_365_days,
  });
  target.append(summary);
  const absolute = report.absolute_risk || {};
  const estimate = node("section", undefined, "card");
  estimate.append(
    node("h3", "10-year ASCVD estimate"),
    node(
      "p",
      absolute.status === "CALCULATED"
        ? `${absolute.risk_percent}% · ${absolute.category} (legacy PCE categories)`
        : "Not calculated from the visit timeline.",
    ),
    node("p", absolute.reason || "Explicit risk inputs are required."),
  );
  const prevent = node("a", "Open the official PREVENT calculator");
  prevent.href =
    "https://professional.heart.org/en/guidelines-and-statements/prevent-calculator";
  prevent.target = "_blank";
  prevent.rel = "noopener noreferrer";
  estimate.append(prevent);
  details(estimate, "Model, inputs and limitations", absolute);
  target.append(estimate);
  const charts = node("div", undefined, "chart-grid");
  for (const [key, title] of Object.entries({
    ldl_cholesterol: "LDL",
    hdl_cholesterol: "HDL",
    triglycerides: "Triglycerides",
    systolic_bp: "Systolic BP",
    diastolic_bp: "Diastolic BP",
    hba1c: "HbA1c",
    fasting_glucose: "Fasting glucose",
  })) {
    const metric = report.metric_trajectories?.[key];
    if (!metric?.count) continue;
    chart(
      charts,
      `${title} (${metric.unit})${metric.stale ? " · historical" : ""}`,
      metric.points,
      "value",
    );
  }
  target.append(charts);
  target.append(node("h2", "Clinical findings"));
  for (const flag of report.clinical_flags || []) {
    const card = node(
      "article",
      undefined,
      `card finding risk-${flag.severity}`,
    );
    card.append(
      node("h3", flag.code.replaceAll("_", " ")),
      node("p", flag.message),
    );
    details(card, "Dated evidence", flag.evidence);
    target.append(card);
  }
  target.append(node("h2", "Cross-visit patterns"));
  const flags = report.visit_patterns?.flags || [];
  if (!flags.length)
    target.append(
      node(
        "p",
        "No screening rules triggered in available records. This does not establish absence of risk.",
        "empty",
      ),
    );
  flags.forEach((flag) => {
    const card = node("article", undefined, "card finding");
    card.append(
      node("h3", flag.code.replaceAll("_", " ")),
      node("p", flag.message),
    );
    details(card, "View dated evidence", flag.evidence);
    target.append(card);
  });
  details(
    target,
    "Screening coverage and limitations",
    report.visit_patterns?.coverage,
  );
  details(target, "Longitudinal observations", report.observations);
  details(target, "Missingness, freshness and rejected records", {
    coverage: report.coverage,
    issues: report.data_quality,
  });
  details(
    target,
    "Metric summaries and robust slopes",
    report.metric_trajectories,
  );
  details(target, "Clinical recommendations", report.recommendations);
  target.append(node("p", report.disclaimer, "small"));
}
action("refresh-patterns", "click", () => loadPatterns());
for (const [key, label, options] of [
  ["model_sex", "Model sex", ["", "Female", "Male", "Unsupported"]],
  ["cohort", "Published PCE cohort", ["", "White", "Black", "Other"]],
  ["bp_treated", "Currently treated for blood pressure?", ["", "Yes", "No"]],
  ["diabetes", "Clinically established diabetes?", ["", "Yes", "No"]],
  ["current_smoker", "Current smoker?", ["", "Yes", "No"]],
  ["known_ascvd", "Known ASCVD?", ["", "Yes", "No"]],
])
  field($("risk-fields"), key, label, "text", options).required = true;
for (const [key, label, min, max] of [
  ["age", "Age at snapshot", 40, 79],
  ["total_cholesterol", "Total cholesterol (mg/dL)", 130, 320],
  ["hdl_cholesterol", "HDL (mg/dL)", 20, 100],
  ["systolic_bp", "Systolic BP (mmHg)", 90, 200],
]) {
  const input = field($("risk-fields"), key, label, "number", true);
  input.min = min;
  input.max = max;
  if (key === "age") input.step = 1;
}
field(
  $("risk-fields"),
  "snapshot_date",
  "Confirmed snapshot date",
  "date",
  true,
);
action("risk-form", "submit", async (e) => {
  const data = formData(e.target);
  for (const key of ["bp_treated", "diabetes", "current_smoker", "known_ascvd"])
    data[key] = data[key] === "Yes";
  await loadPatterns(data);
});
action("upload-form", "submit", async (e) => {
  needPatient();
  const data = new FormData(e.target);
  data.append("patient_id", state.patient.patient_id);
  let endpoint = "patient-document";
  if (state.session.role === "DOCTOR") {
    endpoint = "medical-report";
    data.append("doctor_id", state.session.user_id);
    data.append("report_type", data.get("category"));
    if (state.visit) data.append("visit_id", state.visit);
  }
  await request(`/api/uploads/${endpoint}`, { method: "POST", body: data });
  e.target.reset();
  notify("Document uploaded.");
  if (state.session.role === "PATIENT") await loadDocuments();
});
async function loadDocuments() {
  const rows = await request("/api/web/documents");
  $("documents").replaceChildren();
  table($("documents"), rows);
}
action("ecg-form", "submit", async (e) => {
  $("ecg-result").textContent = "Analyzing ECG… This may take a moment.";
  const result = await request("/api/ecg/analyze", {
    method: "POST",
    body: new FormData(e.target),
  });
  const target = $("ecg-result");
  target.replaceChildren();
  target.append(
    node("h2", (result.status || "Analysis result").replaceAll("_", " ")),
  );
  if (result.error) target.append(node("p", result.error, "card finding"));
  if (result.clinical_notice)
    target.append(node("p", result.clinical_notice, "card finding"));
  metrics(target, result.cardiac_intervals || {});
  details(target, "Calibration and quality", {
    calibration: result.digitization?.calibration,
    quality: result.digitization?.quality_metrics,
    validation: result.validation,
  });
  details(target, "Classification", result.classification || {});
  const leads = result.digitization?.lead_signals || result.lead_signals || {};
  if (Object.keys(leads).length) {
    const select = node("select"),
      plot = node("div");
    select.setAttribute("aria-label", "ECG lead");
    Object.keys(leads).forEach((name) => select.append(node("option", name)));
    const draw = () => {
      plot.replaceChildren();
      const values = leads[select.value];
      if (Array.isArray(values))
        chart(
          plot,
          `Lead ${select.value} · sample index (sampling rate not assumed)`,
          values.map((value, i) => ({
            date: new Date(i * 1000).toISOString(),
            value,
          })),
          "value",
          true,
        );
    };
    select.onchange = draw;
    target.append(select, plot);
    draw();
  }
  details(target, "Full analysis", result);
});
async function loadAudit() {
  const rows = await request("/api/audit/logs?limit=25");
  $("audit").replaceChildren();
  table($("audit"), rows);
}
action("refresh-audit", "click", loadAudit);
renderAuth();

function minValue(points) {
  return Math.min(...points.map((p) => p.y));
}
function maxValue(points) {
  return Math.max(...points.map((p) => p.y));
}
