"""MEDIS AI service: our FastAPI entry point around the teammate's medis package.

Supabase stays the system of record (auth, RLS, storage). This service only
runs the analysis engines on data read with the caller's own token:

  POST /ai/longitudinal/{patient_id}   trend screening (+ optional legacy PCE)
  POST /ai/ecg/document/{document_id}  ECG analysis of an uploaded PDF/image
  POST /ai/ecg/upload                  ECG analysis of digital files (WFDB/CSV/NPY)
  POST /ai/extract-report/{document_id} OCR lab values for the doctor to verify
  GET  /pdf/prescription/{id}          prescription PDF
  GET  /pdf/history/{patient_id}       consolidated medical-history PDF (doctor, or the patient's own copy)
  POST /ai/summary/{patient_id}        doctor AI summary of the latest assessment (Gemini)
  POST /ai/chat                        patient "Ask MEDIS" chatbot (Gemini)

Run from this folder:  ..\\.venv\\Scripts\\python.exe -m uvicorn server:app --port 8000
"""
import json
import os
import re
import shutil
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import llm
from record_summary import summarize_records
from adapters import consultations_to_visits, extracted_to_rows, compact_lead_samples
from medis.ai.ascvd import calculate_pce
from medis.ai.longitudinal_analysis import ENGINE_VERSION, assess_timeline
from medis.config import MODELS
from medis.web.routes import MAX_FILE_BYTES, LegacyRiskInputs, analyze_uploads, json_safe
from supa import ALLOWED_ORIGINS, Supa

# File types the ECG engine reads directly (medis.ecg_inference.FORMAT_MAP)
ENGINE_PRINT_TYPES = {".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
DIGITAL_ECG_TYPES = {".hea", ".dat", ".mat", ".csv", ".npy"}

try:  # iPhone photos (HEIC/HEIF); without it those are rejected with a clear message
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass
WINDOWS_TESSERACT = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
WINGET_PACKAGES = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"

app = FastAPI(title="MEDIS AI Service", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"],
                   allow_headers=["*"], expose_headers=["Content-Disposition"])
bearer = HTTPBearer(auto_error=False)


# ---------- auth ----------

async def current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    if not credentials:
        raise HTTPException(401, "Sign in to continue")
    supa = Supa(credentials.credentials)
    return supa, await supa.user()


async def current_doctor(ctx=Depends(current_user)):
    if ctx[1]["role"] != "doctor":
        raise HTTPException(403, "Doctor account required")
    return ctx


async def require_patient_access(supa, patient_id):
    # RLS only returns the profile to doctors with access (assignment/appointment)
    rows = await supa.select("profiles", {"select": "id,full_name,display_id,gender,date_of_birth",
                                          "id": f"eq.{patient_id}"})
    if not rows:
        raise HTTPException(403, "No access to this patient")
    return rows[0]


async def audit(supa, user, action, target_id, metadata):
    try:
        await supa.insert("audit_logs", {"user_id": user["id"], "action": action, "target_id": target_id,
                                         "target_type": "patient", "metadata": metadata})
    except HTTPException:
        pass  # an audit failure must not hide the clinical result


def tesseract_available():
    import pytesseract
    if shutil.which("tesseract"):
        return True
    if WINDOWS_TESSERACT.exists():
        pytesseract.pytesseract.tesseract_cmd = str(WINDOWS_TESSERACT)
        return True
    return False


def poppler_available():
    """pdf2image (scanned PDFs) needs Poppler on PATH; winget installs it under the user profile."""
    if shutil.which("pdftoppm"):
        return True
    found = sorted(WINGET_PACKAGES.glob("oschwartz10612.Poppler*/poppler-*/Library/bin/pdftoppm.exe"))
    if found:
        os.environ["PATH"] = f"{found[-1].parent}{os.pathsep}{os.environ['PATH']}"
        return True
    return False


def age_from_dob(dob):
    if not dob:
        return None
    born, today = date.fromisoformat(dob[:10]), date.today()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def safe_filename(name, fallback):
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", name or "").lstrip(".")
    return cleaned or fallback


@app.get("/health")
def health():
    return {"status": "ok", "engine_version": ENGINE_VERSION,
            "ecg_model": (MODELS / "ecg_cnn.keras").exists(),
            "ocr": tesseract_available(), "scanned_pdf": poppler_available()}


# ---------- longitudinal screening ----------

class LongitudinalRequest(BaseModel):
    consultation_id: Optional[str] = None   # include this (possibly draft) visit
    draft_values: Optional[dict] = None     # unsaved form numbers for that visit
    pce_inputs: Optional[LegacyRiskInputs] = None
    save: bool = True


@app.post("/ai/longitudinal/{patient_id}")
async def longitudinal(patient_id: str, body: LongitudinalRequest, ctx=Depends(current_doctor)):
    supa, user = ctx
    await require_patient_access(supa, patient_id)
    consultations = await supa.select("consultations", {
        "select": "*,hospitals(name)", "patient_id": f"eq.{patient_id}", "order": "consultation_date.asc"})
    # Finalized visits from every doctor, plus the doctor's current draft if asked
    consultations = [c for c in consultations if c["status"] != "pending" or c["id"] == body.consultation_id]
    prescriptions = await supa.select("prescriptions", {
        "select": "id,consultation_id,issued_at,medicines", "patient_id": f"eq.{patient_id}"})
    drafts = {body.consultation_id: body.draft_values} if body.consultation_id and body.draft_values else None
    visits = consultations_to_visits(consultations, prescriptions, drafts)

    as_of = date.today()
    report = assess_timeline(visits, as_of=as_of)
    pce = calculate_pce(body.pce_inputs.model_dump(mode="json"), as_of=as_of) if body.pce_inputs else None
    if pce:
        report["absolute_risk"] = pce
    report = json_safe(report)

    assessment_id = None
    if body.save:
        row = await supa.insert("cad_assessments", {
            "patient_id": patient_id, "consultation_id": body.consultation_id, "requested_by": user["id"],
            "engine_version": report["engine_version"], "as_of": report["as_of"],
            "review_priority": report["review_priority"], "report": report, "pce": pce})
        assessment_id = row["id"]
        await audit(supa, user, "ai_longitudinal_assessment", patient_id,
                    {"assessment_id": assessment_id, "review_priority": report["review_priority"]})
    return {"assessment_id": assessment_id, "report": report, "pce": pce}


# ---------- ECG ----------

async def save_ecg(supa, user, patient_id, consultation_id, document_id, file_name, result):
    slim = compact_lead_samples(result)
    row = await supa.insert("ecg_analyses", {
        "patient_id": patient_id, "consultation_id": consultation_id, "document_id": document_id,
        "requested_by": user["id"], "file_name": file_name, "input_format": result.get("input_format"),
        "status": result.get("status") or "failed", "classification": result.get("classification"),
        "result": slim})
    await audit(supa, user, "ai_ecg_analysis", patient_id, {"ecg_analysis_id": row["id"], "status": row["status"]})
    return row


def as_engine_file(path):
    """Converts any image Pillow can open (WebP, HEIC, GIF, ...) to PNG, upright
    (phone EXIF rotation applied), so the engine can read it. Engine formats pass through."""
    if path.suffix.lower() in ENGINE_PRINT_TYPES | DIGITAL_ECG_TYPES:
        return path
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(path) as image:
            png = path.with_name(path.stem + "_converted.png")
            ImageOps.exif_transpose(image).convert("RGB").save(png)
            return png
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(415, "This file is not a readable ECG: upload a photo or scan (any image type), a PDF, "
                                 "or digital ECG files (WFDB .hea/.dat/.mat, CSV, NPY).") from exc


async def run_ecg(paths):
    try:
        return await run_in_threadpool(analyze_uploads, paths)
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/ai/ecg/document/{document_id}")
async def ecg_from_document(document_id: str, consultation_id: Optional[str] = None, ctx=Depends(current_doctor)):
    supa, user = ctx
    docs = await supa.select("medical_reports", {"select": "id,patient_id,file_url,file_name", "id": f"eq.{document_id}"})
    if not docs:
        raise HTTPException(404, "Document not found")
    doc = docs[0]
    name = safe_filename(doc["file_name"], "ecg" + Path(doc["file_url"]).suffix)
    content = await supa.download(doc["file_url"])
    with tempfile.TemporaryDirectory(prefix="medis-ecg-") as folder:
        path = Path(folder) / name
        path.write_bytes(content)
        result = await run_ecg([await run_in_threadpool(as_engine_file, path)])
    row = await save_ecg(supa, user, doc["patient_id"], consultation_id, document_id, doc["file_name"], result)
    return {"analysis": row, "result": result}


@app.post("/ai/ecg/upload")
async def ecg_from_upload(patient_id: str = Form(...), consultation_id: Optional[str] = Form(None),
                          files: list[UploadFile] = File(...), ctx=Depends(current_doctor)):
    supa, user = ctx
    await require_patient_access(supa, patient_id)
    if not 1 <= len(files) <= 16:
        raise HTTPException(422, "Upload between 1 and 16 files")
    with tempfile.TemporaryDirectory(prefix="medis-ecg-") as folder:
        paths = []
        for file in files:
            name = file.filename or ""
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name.startswith("."):
                raise HTTPException(422, "Use filenames containing letters, digits, dots, hyphens or underscores")
            path = Path(folder) / name
            content = await file.read(MAX_FILE_BYTES + 1)
            if not content or len(content) > MAX_FILE_BYTES:
                raise HTTPException(413, "Each file must be nonempty and at most 25 MB")
            path.write_bytes(content)
            paths.append(await run_in_threadpool(as_engine_file, path))
        result = await run_ecg(paths)
    main = next((p.name for p in paths if p.suffix.lower() == ".hea"), paths[0].name)
    row = await save_ecg(supa, user, patient_id, consultation_id, None, main, result)
    return {"analysis": row, "result": result}


# ---------- report value extraction (OCR) ----------

@app.post("/ai/extract-report/{document_id}")
async def extract_report(document_id: str, ctx=Depends(current_doctor)):
    supa, user = ctx
    docs = await supa.select("medical_reports", {"select": "id,patient_id,file_url,file_name", "id": f"eq.{document_id}"})
    if not docs:
        raise HTTPException(404, "Document not found")
    doc = docs[0]
    from medis.report_extraction import extract_fields, read_text

    content = await supa.download(doc["file_url"])
    suffix = Path(doc["file_url"]).suffix.lower() or ".pdf"
    with tempfile.TemporaryDirectory(prefix="medis-ocr-") as folder:
        path = Path(folder) / f"report{suffix}"
        path.write_bytes(content)
        if not tesseract_available() and suffix != ".pdf":
            raise HTTPException(503, "OCR is not installed on the server (Tesseract). Digital PDFs still work.")
        poppler_available()  # scanned PDFs are rendered to images first
        try:
            text = await run_in_threadpool(read_text, path)
        except Exception as exc:  # pdf2image/Tesseract missing for scanned PDFs
            raise HTTPException(503, f"Could not read this document: {exc}") from exc
    rows = extracted_to_rows(extract_fields(text))
    await audit(supa, user, "ai_report_extraction", doc["patient_id"], {"document_id": document_id, "fields": len(rows)})
    return {"document_id": document_id, "fields": rows,
            "notice": "Values read automatically from the report. Verify each value against the document before applying."}


# ---------- PDFs ----------

@app.get("/pdf/prescription/{prescription_id}")
async def prescription_pdf(prescription_id: str, ctx=Depends(current_user)):
    supa, user = ctx
    rows = await supa.select("prescriptions", {
        "select": "*,consultations(visit_id,final_diagnosis,follow_up_date,systolic_bp,diastolic_bp,heart_rate,hospital_id)",
        "id": f"eq.{prescription_id}"})
    if not rows:
        raise HTTPException(404, "Prescription not found")
    rx = rows[0]
    visit = rx.get("consultations") or {}
    people = {p["id"]: p for p in await supa.select("profiles", {
        "select": "id,full_name,display_id,gender,date_of_birth",
        "id": f"in.({rx['patient_id']},{rx['doctor_id']})"})}
    patient, doctor = people.get(rx["patient_id"], {}), people.get(rx["doctor_id"], {})
    # Patients may not be allowed to read doctor_profiles; the PDF still renders without it
    try:
        details = (await supa.select("doctor_profiles", {"select": "*", "id": f"eq.{rx['doctor_id']}"}) or [{}])[0]
    except HTTPException:
        details = {}
    hospital_id = visit.get("hospital_id") or details.get("hospital_id")
    hospital = (await supa.select("hospitals", {"select": "name,city,address", "id": f"eq.{hospital_id}"}) or [{}])[0] \
        if hospital_id else {}

    vitals = []
    if visit.get("systolic_bp") and visit.get("diastolic_bp"):
        vitals.append(f"BP {visit['systolic_bp']}/{visit['diastolic_bp']} mmHg")
    if visit.get("heart_rate"):
        vitals.append(f"HR {visit['heart_rate']} bpm")
    age = age_from_dob(patient.get("date_of_birth"))

    data = {
        "prescription_id": f"RX-{prescription_id[:8].upper()}",
        "visit_id": visit.get("visit_id") or "",
        "date": (rx.get("issued_at") or "")[:10],
        "hospital_name": hospital.get("name") or "",
        "hospital_address": ", ".join(x for x in (hospital.get("address"), hospital.get("city")) if x),
        "doctor_name": f"Dr. {doctor.get('full_name') or ''}".strip(),
        "doctor_qualification": details.get("qualification") or details.get("specialization") or "",
        "doctor_id": doctor.get("display_id") or "",
        "doctor_reg_no": details.get("license_number") or "",
        "patient_name": patient.get("full_name") or "",
        "patient_id": patient.get("display_id") or "",
        "patient_age": age if age is not None else "",
        "patient_gender": (patient.get("gender") or "").title(),
        "diagnosis": visit.get("final_diagnosis") or "",
        "vitals": ", ".join(vitals),
        "medications": [{"medicine_name": m.get("name"), "dosage": m.get("dosage"), "frequency": m.get("frequency"),
                         "duration": m.get("duration"),
                         "instructions": " · ".join(x for x in (m.get("timing"), m.get("notes")) if x)}
                        for m in rx.get("medicines") or []],
        "general_advice": rx.get("instructions") or "",
        "follow_up_date": visit.get("follow_up_date") or "",
    }
    from medis.prescriptions.prescription_pdf import generate_prescription_pdf

    with tempfile.TemporaryDirectory(prefix="medis-pdf-") as folder:
        path = Path(folder) / "prescription.pdf"
        await run_in_threadpool(generate_prescription_pdf, data, str(path))
        content = path.read_bytes()
    filename = f"{data['prescription_id']}.pdf"
    return Response(content, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


async def latest_shared_assessment(supa, patient_id):
    try:
        rows = await supa.select("cad_assessments", {
            "select": "id,report,pce,shared_at,patient_note", "patient_id": f"eq.{patient_id}",
            "shared_with_patient": "eq.true", "order": "shared_at.desc", "limit": "1"})
    except HTTPException:
        return None  # migration v6 not applied yet: nothing is shared
    return rows[0] if rows else None


@app.get("/pdf/history/{patient_id}")
async def history_pdf(patient_id: str, ctx=Depends(current_user)):
    """Doctors get every finalized visit plus a fresh screening section. A patient
    gets their own copy: shared visits only, and the AI section only when their
    doctor has shared an assessment (that reviewed assessment is printed)."""
    supa, user = ctx
    is_patient = user["role"] == "patient"
    if is_patient and patient_id != user["id"]:
        raise HTTPException(403, "You can only download your own history")
    if not is_patient:
        if user["role"] != "doctor":
            raise HTTPException(403, "Doctor account required")
        await require_patient_access(supa, patient_id)
    profile = (await supa.select("profiles", {"select": "*", "id": f"eq.{patient_id}"}))[0]
    details = (await supa.select("patient_profiles", {"select": "*", "id": f"eq.{patient_id}"}) or [{}])[0]
    history = await supa.select("patient_medical_history", {"select": "*", "patient_id": f"eq.{patient_id}"})
    family = await supa.select("family_history", {"select": "*", "patient_id": f"eq.{patient_id}"})
    visit_filter = {"is_shared_with_patient": "eq.true"} if is_patient else {}
    consultations = await supa.select("consultations", {
        "select": "*,hospitals(name)", "patient_id": f"eq.{patient_id}", "status": "neq.pending",
        "order": "consultation_date.asc", **visit_filter})
    prescriptions = await supa.select("prescriptions", {"select": "*", "patient_id": f"eq.{patient_id}"})
    # ECG analyses are doctor-only (RLS); the patient copy lists none
    ecgs = [] if is_patient else await supa.select("ecg_analyses", {
        "select": "consultation_id,created_at,file_name,input_format,status,result", "patient_id": f"eq.{patient_id}"})
    ai = {}
    if is_patient:
        shared = await latest_shared_assessment(supa, patient_id)
        report = (shared or {}).get("report")
        ai = {"include_ai": bool(report),
              "ai_report": {**report, "visits_analyzed_count": (report.get("coverage") or {}).get("valid_visits", 0)}
              if report else None}

    doctor_ids = sorted({c["doctor_id"] for c in consultations} | {rx["doctor_id"] for rx in prescriptions})
    doctors = await supa.select("profiles", {"select": "id,full_name,display_id,email",
                                             "id": f"in.({','.join(doctor_ids)})"}) if doctor_ids else []
    try:
        details_by_id = {d["id"]: d for d in await supa.select("doctor_profiles", {
            "select": "*", "id": f"in.({','.join(doctor_ids)})"})} if doctor_ids else {}
    except HTTPException:
        details_by_id = {}
    doctors = [{**details_by_id.get(d["id"], {}), **d} for d in doctors]

    from history_pdf import render as render_history

    with tempfile.TemporaryDirectory(prefix="medis-pdf-") as folder:
        path = Path(folder) / "history.pdf"
        await run_in_threadpool(render_history, path, profile, details, history, family,
                                doctors, consultations, prescriptions, ecgs, **ai)
        content = path.read_bytes()
    await audit(supa, user, "history_pdf_export", patient_id, {"visits": len(consultations)})
    filename = f"MEDIS_History_{safe_filename(profile.get('display_id'), 'patient')}.pdf"
    return Response(content, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---------- doctor AI summary (Gemini) ----------

class SummaryRequest(BaseModel):
    assessment_id: Optional[str] = None  # defaults to the patient's latest saved assessment


@app.post("/ai/summary/{patient_id}")
async def ai_summary(patient_id: str, body: SummaryRequest, ctx=Depends(current_doctor)):
    supa, user = ctx
    await require_patient_access(supa, patient_id)
    params = {"select": "id", "patient_id": f"eq.{patient_id}", "order": "created_at.desc", "limit": "1"}
    if body.assessment_id:
        params["id"] = f"eq.{body.assessment_id}"
    assessments = await supa.select("cad_assessments", params)
    if not assessments and body.assessment_id:
        raise HTTPException(404, "The selected assessment was not found for this patient.")
    assessment = assessments[0] if assessments else None

    details = (await supa.select("patient_profiles", {"select": "*", "id": f"eq.{patient_id}"}) or [{}])[0]
    medications = await supa.select("current_medications", {
        "select": "medicine_name,dosage,frequency,condition_name", "patient_id": f"eq.{patient_id}", "is_active": "eq.true"})
    visits = await supa.select("consultations", {
        "select": "visit_id,consultation_date,status,final_diagnosis,complaints,observations,doctor_notes,follow_up_date,systolic_bp,diastolic_bp,"
                  "heart_rate,bmi,total_cholesterol,ldl_cholesterol,hdl_cholesterol,triglycerides,fasting_glucose,hba1c,"
                  "serum_creatinine,egfr,hospitals(name)", "patient_id": f"eq.{patient_id}",
        "order": "consultation_date.desc"})
    consultations = [{**{k: v for k, v in visit.items() if k not in ("hospitals", "final_diagnosis", "consultation_date")},
                      "date": (visit.get("consultation_date") or "")[:10],
                      "hospital": (visit.get("hospitals") or {}).get("name"),
                      "diagnosis": visit.get("final_diagnosis")} for visit in visits]
    source = {
        "patient": {"known_conditions": details.get("known_conditions") or {}},
        "recent_consultations": consultations,
        "current_medications": [{"name": row.get("medicine_name")} for row in medications],
    }
    conditions = await supa.select("patient_medical_history", {
        "select": "condition_name", "patient_id": f"eq.{patient_id}", "is_active": "eq.true"})
    source["patient"]["recorded_conditions"] = [row["condition_name"] for row in conditions if row.get("condition_name")]
    source["profile_bmi"] = details.get("bmi")
    summary, model = summarize_records(source), "record-summary-v2"

    created_at = datetime.now(timezone.utc).isoformat()
    if assessment:
        await supa.update("cad_assessments", {"id": assessment["id"]},
                          {"ai_summary": summary, "summary_model": model, "summary_created_at": created_at})
    assessment_id = assessment["id"] if assessment else None
    await audit(supa, user, "ai_summary", patient_id, {"assessment_id": assessment_id, "model": model})
    return {"assessment_id": assessment_id, "ai_summary": summary, "summary_model": model,
            "summary_created_at": created_at}


# ---------- patient chatbot "Ask MEDIS" (Gemini) ----------

CHAT_HISTORY_TURNS = 10
CHAT_LIMIT_PER_HOUR = 30


class ChatRequest(BaseModel):
    message: str


def _without_empty(row):
    return {k: v for k, v in row.items() if v not in (None, "", [], {})}


async def patient_record_for_chat(supa, patient_id):
    """Only what the patient already sees on their dashboard (own token + RLS)."""
    profile = (await supa.select("profiles", {"select": "full_name,display_id,gender,date_of_birth",
                                              "id": f"eq.{patient_id}"}) or [{}])[0]
    details = (await supa.select("patient_profiles", {"select": "*", "id": f"eq.{patient_id}"}) or [{}])[0]
    medications = await supa.select("current_medications", {
        "select": "medicine_name,dosage,frequency,condition_name", "patient_id": f"eq.{patient_id}", "is_active": "eq.true"})
    shared = await supa.select("consultations", {
        "select": "visit_id,consultation_date,status,final_diagnosis,doctor_notes,follow_up_date,systolic_bp,diastolic_bp,"
                  "heart_rate,bmi,total_cholesterol,ldl_cholesterol,hdl_cholesterol,triglycerides,fasting_glucose,hba1c,"
                  "serum_creatinine,egfr,hospitals(name),profiles:doctor_id(full_name)",
        "patient_id": f"eq.{patient_id}", "is_shared_with_patient": "eq.true", "order": "consultation_date.desc"})
    prescriptions = await supa.select("prescriptions", {
        "select": "issued_at,medicines,instructions,profiles:doctor_id(full_name)",
        "patient_id": f"eq.{patient_id}", "order": "issued_at.desc", "limit": "10"})
    appointments = await supa.select("appointments", {
        "select": "scheduled_at,reason,status,profiles:doctor_id(full_name)", "patient_id": f"eq.{patient_id}",
        "scheduled_at": f"gte.{date.today().isoformat()}", "order": "scheduled_at.asc", "limit": "5"})
    documents = await supa.select("medical_reports", {
        "select": "file_name,category,report_date,review_status", "patient_id": f"eq.{patient_id}",
        "order": "uploaded_at.desc", "limit": "20"})
    check = await latest_shared_assessment(supa, patient_id)
    heart_check = None
    if check:
        report, pce = check.get("report") or {}, check.get("pce") or {}
        heart_check = _without_empty({
            "shared_on": (check.get("shared_at") or "")[:10], "results_as_of": report.get("as_of"),
            "review_priority": report.get("review_priority"), "doctor_note": check.get("patient_note"),
            "trends": {k: {"unit": m.get("unit"), "first": m["points"][0]["value"], "first_date": m["points"][0]["date"],
                           "latest": m["points"][-1]["value"], "latest_date": m["points"][-1]["date"],
                           "direction": m.get("direction")}
                       for k, m in (report.get("metric_trajectories") or {}).items() if m.get("count") and m.get("points")},
            "ten_year_risk": ({"percent": pce.get("risk_percent"), "category": pce.get("category")}
                              if pce.get("status") == "CALCULATED" else None),
        })

    return {
        "today": date.today().isoformat(),
        "retrieval_scope": {
            "shared_visits": "Visits shared with this patient and returned by Supabase; unshared visits are excluded.",
            "prescriptions": "Up to 10 most recently issued prescriptions; not a complete medication history.",
            "upcoming_appointments": "Up to 5 appointments from today onward; check each status before describing it as upcoming.",
            "uploaded_documents": "Up to 20 most recently uploaded files, metadata only; file contents are not retrieved.",
            "heart_health_check": "Latest assessment shared with the patient, if available.",
        },
        "patient": _without_empty({
            "name": profile.get("full_name"), "patient_id": profile.get("display_id"),
            "gender": profile.get("gender"), "age": age_from_dob(profile.get("date_of_birth")),
            **{k: details.get(k) for k in ("blood_group", "height_cm", "weight_kg", "smoking_status",
                                           "alcohol_use", "allergies", "known_conditions")}}),
        "current_medications": medications,
        "shared_visits": [_without_empty({**{k: v for k, v in c.items() if k not in ("hospitals", "profiles")},
                                          "hospital": (c.get("hospitals") or {}).get("name"),
                                          "doctor": (c.get("profiles") or {}).get("full_name")}) for c in shared],
        "prescriptions": [_without_empty({"date": (p.get("issued_at") or "")[:10], "medicines": p.get("medicines"),
                                          "instructions": p.get("instructions"),
                                          "doctor": (p.get("profiles") or {}).get("full_name")}) for p in prescriptions],
        "upcoming_appointments": [_without_empty({"when": a["scheduled_at"], "reason": a.get("reason"),
                                                  "status": a["status"], "doctor": (a.get("profiles") or {}).get("full_name")})
                                  for a in appointments],
        "uploaded_documents": documents,
        "heart_health_check": heart_check,
    }


@app.post("/ai/chat")
async def ai_chat(body: ChatRequest, ctx=Depends(current_user)):
    supa, user = ctx
    if user["role"] != "patient":
        raise HTTPException(403, "Ask MEDIS is available to patients")
    message = body.message.strip()
    if not 1 <= len(message) <= 1000:
        raise HTTPException(422, "Write a question of up to 1000 characters")

    since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent = await supa.select("chat_messages", {"select": "id", "patient_id": f"eq.{user['id']}",
                                                  "role": "eq.user", "created_at": f"gte.{since}"})
    if len(recent) >= CHAT_LIMIT_PER_HOUR:
        raise HTTPException(429, "You have asked a lot of questions. Please try again in a little while.")

    history = await supa.select("chat_messages", {"select": "role,content", "patient_id": f"eq.{user['id']}",
                                                   "order": "created_at.desc", "limit": str(CHAT_HISTORY_TURNS)})
    history.reverse()
    while history and history[0]["role"] != "user":
        history.pop(0)  # the conversation sent to the API must start with a user turn

    record = await patient_record_for_chat(supa, user["id"])
    context, source_catalog, schema = llm.chat_context(record)
    system = llm.CHAT_SYSTEM + "\n\nPatient record (JSON):\n" + json.dumps(context, sort_keys=True, default=str)
    messages = [{"role": m["role"], "content": m["content"]} for m in history] + [{"role": "user", "content": message}]

    is_emergency = bool(llm.EMERGENCY.search(message))
    generated, _ = await llm.generate_json(system, messages, schema, effort="low")
    answer = llm.validate_chat_answer(generated, source_catalog)

    question = await supa.insert("chat_messages", {"patient_id": user["id"], "role": "user", "content": message,
                                                   "is_emergency": is_emergency})
    reply = await supa.insert("chat_messages", {"patient_id": user["id"], "role": "assistant",
                                                "content": answer["reply"], "sources": answer["sources"],
                                                "is_emergency": is_emergency})
    return {"question": question, "reply": reply, "suggest_contact_doctor": answer["suggest_contact_doctor"],
            "emergency_notice": llm.EMERGENCY_NOTICE if is_emergency else None}
