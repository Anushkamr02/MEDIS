"""Consolidated medical-history PDF from MEDIS Supabase rows.

The teammate's generator (medis.reports.medical_history_pdf) reads its own
SQLAlchemy tables, so we load the patient's rows into a throwaway in-memory
SQLite database with those models and run the generator unchanged.
"""
import re
from datetime import date, datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from adapters import _symptoms, number
from medis.database.connection import Base
from medis.database.models import (
    ClinicalMeasurement, Doctor, ECGResult, Patient, Prescription, PrescriptionItem, Symptom, Visit,
)

MEASUREMENTS = ("systolic_bp", "diastolic_bp", "heart_rate", "respiratory_rate", "spo2", "height_cm", "weight_kg",
                "bmi", "fasting_glucose", "hba1c", "total_cholesterol", "ldl_cholesterol", "hdl_cholesterol",
                "triglycerides", "serum_creatinine", "egfr")
SYMPTOM_FLAGS = ("chest_pain_present", "chest_pain_severity", "breathlessness_present", "palpitations", "fatigue",
                 "syncope", "ankle_swelling")


def _when(value):
    return datetime.fromisoformat(value[:19]) if value else datetime.now()


def _label(value, fallback="Not recorded"):
    return str(value).replace("_", " ").capitalize() if value else fallback


def _emergency_contact(text):
    """'Meera Sharma (wife) +91 99001 65432' -> ('Meera Sharma (wife)', '+91 99001 65432')."""
    match = re.match(r"^(.*?)\s*(\+?\d[\d\s-]{7,})$", (text or "").strip())
    return (match.group(1) or None, match.group(2)) if match else (text or None, None)


def rx_label(prescription_id):
    return f"RX-{prescription_id[:8].upper()}"


def build_session(profile, details, history, family, doctors, consultations, prescriptions, ecgs):
    """Loads one patient's Supabase rows into the teammate's models; returns (session, patient_id)."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()

    known = details.get("known_conditions") or {}
    contact_name, contact_phone = _emergency_contact(details.get("emergency_contact"))
    dob = profile.get("date_of_birth")
    age = None
    if dob:
        born, today = date.fromisoformat(dob[:10]), date.today()
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    conditions = [h["condition_name"] for h in history if h.get("is_active")]
    family_cad = known.get("family_cardiac_history") is True or any(
        re.search(r"coronary|cardiac|heart|myocardial", f.get("condition_name") or "", re.I) for f in family)

    patient_id = profile.get("display_id") or profile["id"]
    db.add(Patient(
        patient_id=patient_id, full_name=profile.get("full_name") or "—", date_of_birth=dob, age=age,
        gender=_label(profile.get("gender"), "—"), blood_group=details.get("blood_group"),
        contact_number=profile.get("phone") or "—", email=profile.get("email"),
        emergency_contact_name=contact_name, emergency_contact_phone=contact_phone,
        smoking_status=_label(details.get("smoking_status")), alcohol_consumption=_label(details.get("alcohol_use")),
        exercise_frequency="Not recorded", known_allergies=details.get("allergies") or None,
        chronic_conditions=", ".join(conditions) or None, family_history_cad=family_cad))

    doctor_ids = {}
    for d in doctors:
        doctor_ids[d["id"]] = d.get("display_id") or d["id"]
        db.add(Doctor(
            doctor_id=doctor_ids[d["id"]], full_name=f"Dr. {d.get('full_name') or ''}".strip(),
            qualification=d.get("qualification") or "—", specialization=d.get("specialization") or "—",
            medical_registration_number=d.get("license_number") or "—",
            email=d.get("email") or f"{doctor_ids[d['id']]}@medis.local"))

    visit_ids = {}
    for c in consultations:
        visit_id = visit_ids[c["id"]] = c.get("visit_id") or c["id"]
        db.add(Visit(
            visit_id=visit_id, patient_id=patient_id, doctor_id=doctor_ids.get(c["doctor_id"], c["doctor_id"]),
            hospital_id=c.get("hospital_id"), hospital_name=(c.get("hospitals") or {}).get("name"),
            visit_date=_when(c.get("consultation_date")),
            visit_type=f"{(c.get('disease_type') or '').upper()} consultation".strip(),
            status="Final"))  # only finalized visits are exported; the column is narrow
        db.add(ClinicalMeasurement(visit_id=visit_id, measurement_date=_when(c.get("consultation_date")),
                                   **{key: number(c.get(key)) for key in MEASUREMENTS}))
        # Symptom has no column for some engine keys (e.g. chest_pain_at_rest)
        db.add(Symptom(visit_id=visit_id, **{key: value for key, value in _symptoms(c.get("complaints")).items()
                                             if key in Symptom.__table__.columns}))

    diagnoses = {c["id"]: c.get("final_diagnosis") for c in consultations}
    for rx in prescriptions:
        if rx.get("consultation_id") not in visit_ids:
            continue  # prescriptions of unfinished visits are left out with their visit
        label = rx_label(rx["id"])
        db.add(Prescription(
            prescription_id=label, visit_id=visit_ids[rx["consultation_id"]], patient_id=patient_id,
            doctor_id=doctor_ids.get(rx["doctor_id"], rx["doctor_id"]), prescription_date=_when(rx.get("issued_at")),
            diagnosis=diagnoses.get(rx["consultation_id"]) or "—", general_advice=rx.get("instructions"),
            items=[PrescriptionItem(medicine_name=m.get("name") or "—", dosage=m.get("dosage") or "",
                                    frequency=m.get("frequency") or "", duration=m.get("duration") or "",
                                    instructions=m.get("timing"))
                   for m in rx.get("medicines") or []]))

    for e in ecgs:
        result = e.get("result") or {}
        intervals = result.get("cardiac_intervals") or {}
        db.add(ECGResult(
            visit_id=visit_ids.get(e.get("consultation_id")), patient_id=patient_id,
            recording_date=_when(e.get("created_at")), file_path=e.get("file_name") or "—",
            source_type=(e.get("input_format") or "file").upper(),
            heart_rate=number(intervals.get("heart_rate_bpm")), rr_interval_ms=number(intervals.get("rr_interval_ms")),
            pr_interval_ms=number(intervals.get("pr_interval_ms")), qrs_duration_ms=number(intervals.get("qrs_duration_ms")),
            qt_interval_ms=number(intervals.get("qt_interval_ms")), qtc_interval_ms=number(intervals.get("qtc_bazett_ms")),
            inference_status=e.get("status"),
            # Only digital traces that passed the signal checks count towards interval comparisons
            qa_overall_pass=e.get("status") == "validated_continuous_10s_analysis"
            and (result.get("validation") or {}).get("overall_valid") is not False,
            clinical_advisory=result.get("clinical_notice") or result.get("error")))

    db.commit()
    # The model's insert defaults turn unrecorded symptoms into "absent"; reset them to NULL
    for c in consultations:
        recorded = _symptoms(c.get("complaints"))
        db.query(Symptom).filter(Symptom.visit_id == visit_ids[c["id"]]).update(
            {getattr(Symptom, key): None for key in SYMPTOM_FLAGS if key not in recorded}, synchronize_session=False)
    db.commit()
    return db, patient_id


def render(path, *rows, ai_report=None, include_ai=True):
    from medis.reports.medical_history_pdf import generate_patient_medical_history_pdf

    db, patient_id = build_session(*rows)
    try:
        generate_patient_medical_history_pdf(patient_id, db, output_filename=str(path),
                                             ai_report=ai_report, include_ai=include_ai)
    finally:
        db.close()
