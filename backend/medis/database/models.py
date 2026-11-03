"""
MEDIS Database Models (SQLAlchemy ORM)
Implements all 24 relational tables specified in MEDIS Specification Section 15.
Designed for PostgreSQL and fully compatible with SQLite for local development.
"""

from datetime import datetime
import json
from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime,
    ForeignKey, Text, Index
)
from sqlalchemy.orm import relationship
from medis.database.connection import Base


# ---------------------------------------------------------
# 1. Patients & Credentials
# ---------------------------------------------------------
class Patient(Base):
    """Permanent patient profile (One patient ID per individual for life)."""
    __tablename__ = "patients"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(String(32), unique=True, index=True, nullable=False)  # MEDIS-P-YYYY-XXXXX
    full_name = Column(String(128), nullable=False)
    date_of_birth = Column(String(32), nullable=True)
    age = Column(Integer, nullable=True)
    gender = Column(String(16), nullable=False)
    blood_group = Column(String(8), nullable=True)
    contact_number = Column(String(32), nullable=False)
    email = Column(String(128), nullable=True)
    address = Column(Text, nullable=True)
    emergency_contact_name = Column(String(128), nullable=True)
    emergency_contact_phone = Column(String(32), nullable=True)

    # Medical History & Lifestyle
    smoking_status = Column(String(32), default="Never")  # Never, Former, Current
    alcohol_consumption = Column(String(32), default="None")  # None, Moderate, Heavy
    exercise_frequency = Column(String(32), default="Moderate")  # Sedentary, Light, Moderate, Active
    known_allergies = Column(Text, default="None")
    chronic_conditions = Column(Text, default="None")  # e.g., "Hypertension, T2DM"
    family_history_cad = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    credentials = relationship("PatientCredential", back_populates="patient", uselist=False, cascade="all, delete-orphan")
    visits = relationship("Visit", back_populates="patient", order_by="Visit.visit_date.asc()")
    documents = relationship("PatientDocument", back_populates="patient", order_by="PatientDocument.uploaded_at.desc()")
    prescriptions = relationship("Prescription", back_populates="patient", order_by="Prescription.prescription_date.desc()")
    longitudinal_assessments = relationship("LongitudinalAssessment", back_populates="patient", order_by="LongitudinalAssessment.created_at.desc()")
    consents = relationship("PatientConsent", back_populates="patient")


class PatientCredential(Base):
    """Patient authentication credentials."""
    __tablename__ = "patient_credentials"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), unique=True, nullable=False)
    password_hash = Column(String(256), nullable=False)
    salt = Column(String(64), nullable=True)
    is_active = Column(Boolean, default=True)
    last_login = Column(DateTime, nullable=True)

    patient = relationship("Patient", back_populates="credentials")


# ---------------------------------------------------------
# 2. Doctors & Hospitals
# ---------------------------------------------------------
class Hospital(Base):
    """Hospital facility information."""
    __tablename__ = "hospitals"

    id = Column(Integer, primary_key=True, index=True)
    hospital_id = Column(String(32), unique=True, index=True, nullable=False)  # MEDIS-H-XXXX
    name = Column(String(256), nullable=False)
    branch = Column(String(128), nullable=True)
    address = Column(Text, nullable=True)
    city = Column(String(64), nullable=True)
    contact_phone = Column(String(32), nullable=True)
    email = Column(String(128), nullable=True)

    visits = relationship("Visit", back_populates="hospital")
    doctors = relationship("Doctor", back_populates="hospital")


class Doctor(Base):
    """Doctor professional profile."""
    __tablename__ = "doctors"

    id = Column(Integer, primary_key=True, index=True)
    doctor_id = Column(String(32), unique=True, index=True, nullable=False)  # MEDIS-D-YYYY-XXXX
    full_name = Column(String(128), nullable=False)
    qualification = Column(String(128), nullable=False)  # MBBS, MD (Cardiology), etc.
    specialization = Column(String(128), nullable=False)
    medical_registration_number = Column(String(64), nullable=False)
    hospital_id = Column(String(32), ForeignKey("hospitals.hospital_id"), nullable=True)
    hospital_name = Column(String(256), nullable=True)
    department = Column(String(128), default="Cardiology")
    contact_number = Column(String(32), nullable=True)
    email = Column(String(128), unique=True, nullable=False)

    hospital = relationship("Hospital", back_populates="doctors")
    credentials = relationship("DoctorCredential", back_populates="doctor", uselist=False, cascade="all, delete-orphan")
    visits = relationship("Visit", back_populates="doctor")
    prescriptions = relationship("Prescription", back_populates="doctor")


class DoctorCredential(Base):
    """Doctor authentication credentials."""
    __tablename__ = "doctor_credentials"

    id = Column(Integer, primary_key=True, index=True)
    doctor_id = Column(String(32), ForeignKey("doctors.doctor_id"), unique=True, nullable=False)
    password_hash = Column(String(256), nullable=False)
    salt = Column(String(64), nullable=True)
    is_active = Column(Boolean, default=True)
    last_login = Column(DateTime, nullable=True)

    doctor = relationship("Doctor", back_populates="credentials")


class PatientHospitalAccess(Base):
    """Patient hospital authorization records."""
    __tablename__ = "patient_hospital_access"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False)
    hospital_id = Column(String(32), ForeignKey("hospitals.hospital_id"), nullable=False)
    access_granted = Column(Boolean, default=True)
    granted_at = Column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------
# 3. Visits & Clinical Consultations
# ---------------------------------------------------------
class Visit(Base):
    """Individual hospital consultation visit."""
    __tablename__ = "visits"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), unique=True, index=True, nullable=False)  # MEDIS-V-YYYY-XXXXX
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False, index=True)
    doctor_id = Column(String(32), ForeignKey("doctors.doctor_id"), nullable=False, index=True)
    hospital_id = Column(String(32), ForeignKey("hospitals.hospital_id"), nullable=True)
    hospital_name = Column(String(256), nullable=True)
    visit_date = Column(DateTime, default=datetime.utcnow, nullable=False)
    visit_type = Column(String(64), default="Cardiology Consultation")  # Routine, Follow-up, Emergency, etc.
    status = Column(String(32), default="In Progress")  # In Progress, Completed, Finalized

    patient = relationship("Patient", back_populates="visits")
    doctor = relationship("Doctor", back_populates="visits")
    hospital = relationship("Hospital", back_populates="visits")
    symptoms = relationship("Symptom", back_populates="visit", cascade="all, delete-orphan")
    clinical_measurements = relationship("ClinicalMeasurement", back_populates="visit", cascade="all, delete-orphan")
    consultation_records = relationship("ConsultationRecord", back_populates="visit", cascade="all, delete-orphan")
    prescriptions = relationship("Prescription", back_populates="visit", cascade="all, delete-orphan")
    medical_reports = relationship("MedicalReport", back_populates="visit")
    ecg_results = relationship("ECGResult", back_populates="visit")
    cad_predictions = relationship("CADPrediction", back_populates="visit")


class Symptom(Base):
    """Visit-wise structured symptoms."""
    __tablename__ = "symptoms"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False, index=True)
    chief_complaint = Column(Text, nullable=True)
    chest_pain_present = Column(Boolean, default=False)
    chest_pain_type = Column(String(64), nullable=True)  # Typical Angina, Atypical, Non-Anginal, None
    chest_pain_severity = Column(Integer, default=0)  # 0 to 10 scale
    chest_pain_duration = Column(String(64), nullable=True)  # e.g., "15 minutes"
    chest_pain_radiation = Column(String(128), nullable=True)  # Left arm, Jaw, Back, None
    breathlessness_present = Column(Boolean, default=False)
    breathlessness_nyha_class = Column(String(16), nullable=True)  # Class I, II, III, IV
    palpitations = Column(Boolean, default=False)
    fatigue = Column(Boolean, default=False)
    syncope = Column(Boolean, default=False)
    ankle_swelling = Column(Boolean, default=False)
    additional_symptoms = Column(Text, nullable=True)

    visit = relationship("Visit", back_populates="symptoms")


class ClinicalMeasurement(Base):
    """Physical examinations, vitals, and lab parameters."""
    __tablename__ = "clinical_measurements"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False, index=True)
    measurement_date = Column(DateTime, default=datetime.utcnow)

    # Vitals
    systolic_bp = Column(Float, nullable=True)  # mmHg
    diastolic_bp = Column(Float, nullable=True)  # mmHg
    heart_rate = Column(Float, nullable=True)  # bpm
    respiratory_rate = Column(Float, nullable=True)  # breaths/min
    temperature = Column(Float, nullable=True)  # °F
    spo2 = Column(Float, nullable=True)  # %

    # Anthropometry
    height_cm = Column(Float, nullable=True)
    weight_kg = Column(Float, nullable=True)
    bmi = Column(Float, nullable=True)

    # Blood & Biochemistry (mg/dL or specified)
    fasting_glucose = Column(Float, nullable=True)  # mg/dL
    postprandial_glucose = Column(Float, nullable=True)  # mg/dL
    hba1c = Column(Float, nullable=True)  # %
    total_cholesterol = Column(Float, nullable=True)  # mg/dL
    ldl_cholesterol = Column(Float, nullable=True)  # mg/dL
    hdl_cholesterol = Column(Float, nullable=True)  # mg/dL
    triglycerides = Column(Float, nullable=True)  # mg/dL
    serum_creatinine = Column(Float, nullable=True)  # mg/dL
    egfr = Column(Float, nullable=True)  # mL/min/1.73m2

    visit = relationship("Visit", back_populates="clinical_measurements")


class ConsultationRecord(Base):
    """Digital consultation documentation (eliminating paper sheets)."""
    __tablename__ = "consultation_records"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), unique=True, nullable=False)
    chief_complaint = Column(Text, nullable=True)
    history_of_present_illness = Column(Text, nullable=True)
    past_medical_history = Column(Text, nullable=True)
    general_examination_notes = Column(Text, nullable=True)
    cardiovascular_exam_notes = Column(Text, nullable=True)
    respiratory_exam_notes = Column(Text, nullable=True)
    provisional_diagnosis = Column(Text, nullable=True)
    final_diagnosis = Column(Text, nullable=True)
    clinical_observations = Column(Text, nullable=True)
    status = Column(String(32), default="DRAFT")  # DRAFT, FINALIZED
    finalized_at = Column(DateTime, nullable=True)

    visit = relationship("Visit", back_populates="consultation_records")


class ConsultationNote(Base):
    """Doctor's detailed clinical notes and addenda."""
    __tablename__ = "consultation_notes"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False)
    doctor_id = Column(String(32), ForeignKey("doctors.doctor_id"), nullable=False)
    note_type = Column(String(64), default="Progress Note")
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------
# 4. Audio Recordings & Transcription
# ---------------------------------------------------------
class ConsultationRecording(Base):
    """Audio recordings of consultations with explicit consent."""
    __tablename__ = "consultation_recordings"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False)
    file_path = Column(String(512), nullable=False)
    duration_seconds = Column(Float, default=0.0)
    file_size_bytes = Column(Integer, default=0)
    patient_consent_verified = Column(Boolean, default=True)
    recorded_at = Column(DateTime, default=datetime.utcnow)

    transcript = relationship("ConsultationTranscript", back_populates="recording", uselist=False)


class ConsultationTranscript(Base):
    """AI transcription and key clinical entities."""
    __tablename__ = "consultation_transcripts"

    id = Column(Integer, primary_key=True, index=True)
    recording_id = Column(Integer, ForeignKey("consultation_recordings.id"), nullable=False)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False)
    raw_transcript = Column(Text, nullable=False)
    extracted_symptoms_json = Column(Text, default="{}")
    extracted_vitals_json = Column(Text, default="{}")
    doctor_approved = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    recording = relationship("ConsultationRecording", back_populates="transcript")


# ---------------------------------------------------------
# 5. Documents, Medical Reports & ECG Results
# ---------------------------------------------------------
class PatientDocument(Base):
    """Patient self-uploaded documents across hospitals."""
    __tablename__ = "patient_documents"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False, index=True)
    category = Column(String(64), nullable=False)  # Previous ECG, Blood Report, Echo, Imaging, Discharge Summary, Prescription
    file_name = Column(String(256), nullable=False)
    file_path = Column(String(512), nullable=False)
    file_type = Column(String(32), default="pdf")  # pdf, png, jpg
    file_size_bytes = Column(Integer, default=0)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    notes = Column(Text, nullable=True)
    verified_by_doctor = Column(Boolean, default=False)

    patient = relationship("Patient", back_populates="documents")


class MedicalReport(Base):
    """Doctor / hospital uploaded reports."""
    __tablename__ = "medical_reports"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False, index=True)
    doctor_id = Column(String(32), ForeignKey("doctors.doctor_id"), nullable=True)
    report_type = Column(String(64), nullable=False)  # ECG, Lipid Panel, Blood Count, Echo, Angiography
    test_date = Column(DateTime, default=datetime.utcnow)
    file_path = Column(String(512), nullable=False)
    notes = Column(Text, nullable=True)
    verification_status = Column(String(32), default="VERIFIED")  # PENDING, VERIFIED

    visit = relationship("Visit", back_populates="medical_reports")


class ECGResult(Base):
    """ECG analysis results (Digital WFDB or Digitized Printout)."""
    __tablename__ = "ecg_results"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False, index=True)
    recording_date = Column(DateTime, default=datetime.utcnow)
    file_path = Column(String(512), nullable=False)
    source_type = Column(String(32), default="PDF")  # DIGITAL_WFDB, PDF, PNG_IMAGE

    # Cardiac Intervals
    heart_rate = Column(Float, nullable=True)  # bpm
    rr_interval_ms = Column(Float, nullable=True)  # ms
    pr_interval_ms = Column(Float, nullable=True)  # ms
    qrs_duration_ms = Column(Float, nullable=True)  # ms
    qt_interval_ms = Column(Float, nullable=True)  # ms
    qtc_interval_ms = Column(Float, nullable=True)  # Bazett ms

    # Inference & Clinical Guardrail
    mi_probability = Column(Float, nullable=True)
    prediction_label = Column(String(32), nullable=True)
    inference_status = Column(String(64), default="digitization_complete_cnn_blocked")  # verified_digital_10s or guardrail blocked
    qa_overall_pass = Column(Boolean, default=True)
    qa_summary_json = Column(Text, default="{}")
    clinical_advisory = Column(Text, nullable=True)

    visit = relationship("Visit", back_populates="ecg_results")


# ---------------------------------------------------------
# 6. Prescriptions & Prescription Items
# ---------------------------------------------------------
class Prescription(Base):
    """Digital prescription generated during consultation."""
    __tablename__ = "prescriptions"

    id = Column(Integer, primary_key=True, index=True)
    prescription_id = Column(String(32), unique=True, index=True, nullable=False)  # MEDIS-RX-YYYY-XXXXX
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False)
    doctor_id = Column(String(32), ForeignKey("doctors.doctor_id"), nullable=False)
    prescription_date = Column(DateTime, default=datetime.utcnow)
    diagnosis = Column(Text, nullable=False)
    general_advice = Column(Text, nullable=True)
    follow_up_date = Column(String(64), nullable=True)
    pdf_path = Column(String(512), nullable=True)

    visit = relationship("Visit", back_populates="prescriptions")
    patient = relationship("Patient", back_populates="prescriptions")
    doctor = relationship("Doctor", back_populates="prescriptions")
    items = relationship("PrescriptionItem", back_populates="prescription", cascade="all, delete-orphan")


class PrescriptionItem(Base):
    """Individual prescribed medicine row."""
    __tablename__ = "prescription_items"

    id = Column(Integer, primary_key=True, index=True)
    prescription_id = Column(String(32), ForeignKey("prescriptions.prescription_id"), nullable=False)
    medicine_name = Column(String(128), nullable=False)  # e.g., Atorvastatin
    dosage = Column(String(64), nullable=False)  # e.g., 20 mg
    frequency = Column(String(64), nullable=False)  # e.g., 1-0-1 or Once Daily at Night
    duration = Column(String(64), nullable=False)  # e.g., 30 days
    instructions = Column(String(256), nullable=True)  # e.g., After dinner

    prescription = relationship("Prescription", back_populates="items")


# ---------------------------------------------------------
# 7. AI Risk Predictions, Flags & Longitudinal Assessments
# ---------------------------------------------------------
class CADPrediction(Base):
    """Point-in-time AI CAD risk assessment."""
    __tablename__ = "cad_predictions"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False)
    cad_risk_score = Column(Float, nullable=False)  # 0.0 - 1.0 (or 0-100%)
    risk_category = Column(String(32), nullable=False)  # LOW, MODERATE, HIGH, VERY HIGH
    fusion_strategy = Column(String(64), default="clinical_tabular_priority")
    explanation_summary = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    visit = relationship("Visit", back_populates="cad_predictions")


class RiskFlag(Base):
    """Clinical risk indicators flagged across measurements and ECG."""
    __tablename__ = "risk_flags"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False)
    flag_name = Column(String(64), nullable=False)
    severity = Column(String(32), default="MODERATE")  # LOW, MODERATE, HIGH, CRITICAL
    explanation = Column(Text, nullable=False)
    guideline_source = Column(String(128), default="AHA/ACC 2024")
    created_at = Column(DateTime, default=datetime.utcnow)


class DoctorAssessment(Base):
    """Doctor's formal clinical assessment and validation."""
    __tablename__ = "doctor_assessments"

    id = Column(Integer, primary_key=True, index=True)
    visit_id = Column(String(32), ForeignKey("visits.visit_id"), nullable=False)
    doctor_id = Column(String(32), ForeignKey("doctors.doctor_id"), nullable=False)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False)
    clinical_risk_category = Column(String(32), nullable=False)  # Low, Intermediate, High
    doctor_notes = Column(Text, nullable=True)
    agreed_with_ai = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class LongitudinalAssessment(Base):
    """Synthesized longitudinal CAD progression across historical visits."""
    __tablename__ = "longitudinal_assessments"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False, index=True)
    assessment_date = Column(DateTime, default=datetime.utcnow)
    visits_analyzed_count = Column(Integer, default=1)
    
    # Progressions (JSON strings)
    lipid_progression_json = Column(Text, default="{}")
    bp_progression_json = Column(Text, default="{}")
    diabetes_progression_json = Column(Text, default="{}")
    ecg_progression_json = Column(Text, default="{}")
    symptom_progression_json = Column(Text, default="{}")
    cumulative_risk_factors_json = Column(Text, default="[]")

    # Overall Risk & Recommendations
    longitudinal_risk_category = Column(String(32), default="MODERATE")  # LOW, MODERATE, HIGH, VERY HIGH
    ai_clinical_summary = Column(Text, nullable=False)
    recommendations_json = Column(Text, default="[]")
    created_at = Column(DateTime, default=datetime.utcnow)

    patient = relationship("Patient", back_populates="longitudinal_assessments")


# ---------------------------------------------------------
# 8. Consents & Cryptographic Audit Logs
# ---------------------------------------------------------
class PatientConsent(Base):
    """Patient consent logs for audio recording, sharing, AI evaluation."""
    __tablename__ = "patient_consents"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(String(32), ForeignKey("patients.patient_id"), nullable=False)
    consent_type = Column(String(64), nullable=False)  # AUDIO_RECORDING, DATA_SHARING, AI_ASSESSMENT
    granted = Column(Boolean, default=True)
    granted_at = Column(DateTime, default=datetime.utcnow)
    revoked_at = Column(DateTime, nullable=True)

    patient = relationship("Patient", back_populates="consents")


class AuditLog(Base):
    """Immutable audit trail of accesses, edits, and consultations."""
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow, nullable=False)
    actor_id = Column(String(64), nullable=False)  # Doctor ID, Patient ID, or SYSTEM
    actor_role = Column(String(32), nullable=False)  # DOCTOR, PATIENT, SYSTEM, ADMIN
    action = Column(String(64), nullable=False)  # VIEW_RECORD, CREATE_VISIT, WRITE_PRESCRIPTION, UPLOAD_ECG
    resource = Column(String(128), nullable=False)  # e.g., Patient/MEDIS-P-2026-00125
    details = Column(Text, nullable=True)
    ip_address = Column(String(64), default="127.0.0.1")
    tamper_hash = Column(String(128), nullable=True)

