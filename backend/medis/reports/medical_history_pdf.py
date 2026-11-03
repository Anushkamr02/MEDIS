"""
MEDIS Consolidated Patient Medical History PDF Generator
Conforms to MEDIS Specification Section 14:
Consolidates lifetime patient health history across multiple hospitals into a single,
verifiable, multi-page ReportLab PDF.
"""

import os
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether, PageBreak
)
from sqlalchemy.orm import Session
from medis.database.models import (
    Patient, Visit, ClinicalMeasurement, Symptom, Prescription,
    ECGResult, MedicalReport, LongitudinalAssessment, Doctor
)
from medis.ai.longitudinal_analysis import generate_longitudinal_cad_report

OUTPUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "outputs", "reports"))
os.makedirs(OUTPUT_DIR, exist_ok=True)


def generate_patient_medical_history_pdf(patient_id: str, db: Session, output_filename: str = None,
                                         ai_report: dict = None, include_ai: bool = True) -> str:
    """
    Renders the official consolidated MEDIS Medical History PDF for a patient across all visits.
    ai_report: use this (already reviewed) assessment instead of generating one.
    include_ai: False leaves out section 5, e.g. for a patient copy without a shared assessment.
    """
    patient = db.query(Patient).filter(Patient.patient_id == patient_id).first()
    if not patient:
        raise ValueError(f"Patient {patient_id} not found")

    if not output_filename:
        safe_id = patient_id.replace("/", "_").replace("\\", "_")
        output_filename = os.path.join(OUTPUT_DIR, f"MEDIS_History_{safe_id}.pdf")

    doc = SimpleDocTemplate(
        output_filename,
        pagesize=letter,
        rightMargin=36,
        leftMargin=36,
        topMargin=36,
        bottomMargin=36
    )

    styles = getSampleStyleSheet()
    normal = styles["Normal"]

    brand_h1 = ParagraphStyle(
        "BrandH1", parent=normal, fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=colors.HexColor("#0D3B66")
    )
    section_h2 = ParagraphStyle(
        "SectionH2", parent=normal, fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=colors.HexColor("#1A535C"), spaceBefore=10, spaceAfter=4
    )
    meta_style = ParagraphStyle(
        "MetaStyle", parent=normal, fontName="Helvetica", fontSize=8, leading=11, textColor=colors.HexColor("#718096")
    )
    body_bold = ParagraphStyle(
        "BodyBold", parent=normal, fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=colors.HexColor("#2D3748")
    )
    body_style = ParagraphStyle(
        "BodyStyle", parent=normal, fontName="Helvetica", fontSize=8.5, leading=11.5, textColor=colors.HexColor("#2D3748")
    )
    bullet_style = ParagraphStyle(
        "BulletStyle", parent=normal, fontName="Helvetica", fontSize=8.5, leading=12, textColor=colors.HexColor("#2D3748"), leftIndent=12
    )

    story = []

    # 1. Header Banner
    banner = [
        [
            Paragraph("<b>MEDIS HEALTHCARE NETWORK</b><br/><font size=8 color='#4A5568'>Medical Evaluation & Diagnostic Intelligence System</font>", brand_h1),
            Paragraph(
                f"<b>CONSOLIDATED MEDICAL HISTORY</b><br/>"
                f"<font size=8 color='#718096'>Permanent Patient ID:</font><br/>"
                f"<b><font size=11 color='#0D3B66'>{patient.patient_id}</font></b>",
                ParagraphStyle("HeaderR", parent=normal, alignment=2, leading=13)
            )
        ]
    ]
    t_banner = Table(banner, colWidths=[340, 200])
    t_banner.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'MIDDLE')]))
    story.append(t_banner)
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#0D3B66"), spaceBefore=4, spaceAfter=8))

    # 2. Section 1: Patient Information & Demographics
    demographics_data = [
        [
            Paragraph(f"<b>Full Name:</b> {patient.full_name}", body_style),
            Paragraph(f"<b>Age / Sex:</b> {patient.age} yrs / {patient.gender}", body_style),
            Paragraph(f"<b>Blood Group:</b> {patient.blood_group or 'N/A'}", body_style)
        ],
        [
            Paragraph(f"<b>Contact:</b> {patient.contact_number}", body_style),
            Paragraph(f"<b>Email:</b> {patient.email or 'N/A'}", body_style),
            Paragraph(f"<b>Emergency Contact:</b> {patient.emergency_contact_name or 'N/A'} ({patient.emergency_contact_phone or ''})", body_style)
        ],
        [
            Paragraph(f"<b>Smoking:</b> {patient.smoking_status}", body_style),
            Paragraph(f"<b>Alcohol:</b> {patient.alcohol_consumption}", body_style),
            Paragraph(f"<b>Exercise:</b> {patient.exercise_frequency}", body_style)
        ],
        [
            Paragraph(f"<b>Known Allergies:</b> {patient.known_allergies or 'None reported'}", body_style),
            Paragraph(f"<b>Chronic Illnesses:</b> {patient.chronic_conditions or 'None reported'}", body_style),
            Paragraph(f"<b>Family CAD History:</b> {'Yes (Elevated Risk)' if patient.family_history_cad else 'No / Unknown'}", body_style)
        ]
    ]
    t_demo = Table(demographics_data, colWidths=[180, 180, 180])
    t_demo.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#F7FAFC")),
        ('BOX', (0,0), (-1,-1), 1, colors.HexColor("#E2E8F0")),
        ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor("#EDF2F7")),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_demo)
    story.append(Spacer(1, 10))

    # 3. Section 2: Lifetime Multi-Hospital Visit Timeline
    story.append(Paragraph("<b>1. HOSPITAL VISIT TIMELINE ACROSS ALL FACILITIES</b>", section_h2))
    
    visits = (
        db.query(Visit)
        .filter(Visit.patient_id == patient_id)
        .order_by(Visit.visit_date.asc())
        .all()
    )

    visit_rows = [
        [
            Paragraph("<b>Visit ID</b>", body_bold),
            Paragraph("<b>Date</b>", body_bold),
            Paragraph("<b>Hospital / Clinic</b>", body_bold),
            Paragraph("<b>Consulting Doctor</b>", body_bold),
            Paragraph("<b>Visit Type</b>", body_bold),
            Paragraph("<b>Status</b>", body_bold)
        ]
    ]

    for v in visits:
        doc_obj = db.query(Doctor).filter(Doctor.doctor_id == v.doctor_id).first()
        doc_str = doc_obj.full_name if doc_obj else "Specialist"
        visit_rows.append([
            Paragraph(v.visit_id, body_style),
            Paragraph(v.visit_date.strftime("%d-%b-%Y"), body_style),
            Paragraph(v.hospital_name or "Hospital", body_style),
            Paragraph(doc_str, body_style),
            Paragraph(v.visit_type or "Consultation", body_style),
            Paragraph(f"<font color='green'><b>{v.status}</b></font>", body_style)
        ])

    if len(visit_rows) == 1:
        visit_rows.append([Paragraph("No visits on file", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style)])

    t_visits = Table(visit_rows, colWidths=[95, 65, 130, 110, 85, 55])
    t_visits.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#E2E8F0")),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E0")),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(t_visits)
    story.append(Spacer(1, 10))

    # 4. Section 3: Longitudinal Clinical Measurements & Labs
    story.append(Paragraph("<b>2. LONGITUDINAL CLINICAL MEASUREMENTS & LABORATORY PROFILE</b>", section_h2))

    lab_rows = [
        [
            Paragraph("<b>Visit Date</b>", body_bold),
            Paragraph("<b>Hospital</b>", body_bold),
            Paragraph("<b>BP (mmHg)</b>", body_bold),
            Paragraph("<b>HR (bpm)</b>", body_bold),
            Paragraph("<b>BMI</b>", body_bold),
            Paragraph("<b>Total Chol</b>", body_bold),
            Paragraph("<b>LDL</b>", body_bold),
            Paragraph("<b>HDL</b>", body_bold),
            Paragraph("<b>TG</b>", body_bold),
            Paragraph("<b>HbA1c</b>", body_bold)
        ]
    ]

    for v in visits:
        m = db.query(ClinicalMeasurement).filter(ClinicalMeasurement.visit_id == v.visit_id).first()
        if m:
            bp_val = f"{int(m.systolic_bp)}/{int(m.diastolic_bp)}" if (m.systolic_bp and m.diastolic_bp) else "-"
            hr_val = f"{int(m.heart_rate)}" if m.heart_rate else "-"
            bmi_val = f"{m.bmi:.1f}" if m.bmi else "-"
            tc_val = f"{int(m.total_cholesterol)}" if m.total_cholesterol else "-"
            ldl_val = f"{int(m.ldl_cholesterol)}" if m.ldl_cholesterol else "-"
            hdl_val = f"{int(m.hdl_cholesterol)}" if m.hdl_cholesterol else "-"
            tg_val = f"{int(m.triglycerides)}" if m.triglycerides else "-"
            hba1c_val = f"{m.hba1c:.1f}%" if m.hba1c else "-"

            lab_rows.append([
                Paragraph(v.visit_date.strftime("%d-%b-%y"), body_style),
                Paragraph(v.hospital_name or "Hospital", body_style),
                Paragraph(bp_val, body_style),
                Paragraph(hr_val, body_style),
                Paragraph(bmi_val, body_style),
                Paragraph(tc_val, body_style),
                Paragraph(f"<b>{ldl_val}</b>" if ldl_val != "-" and int(ldl_val) >= 130 else ldl_val, body_style),
                Paragraph(hdl_val, body_style),
                Paragraph(tg_val, body_style),
                Paragraph(f"<b>{hba1c_val}</b>" if hba1c_val != "-" and float(hba1c_val.replace('%','')) >= 6.5 else hba1c_val, body_style),
            ])

    t_labs = Table(lab_rows, colWidths=[55, 95, 60, 45, 40, 50, 50, 45, 45, 55])
    t_labs.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#EBF8FF")),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E0")),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(t_labs)
    story.append(Spacer(1, 10))

    # 5. Section 4: ECG Findings & Historical Conduction Intervals
    story.append(Paragraph("<b>3. 12-LEAD ECG EVALUATIONS & INTERVAL PROGRESSION</b>", section_h2))

    ecgs = (
        db.query(ECGResult)
        .filter(ECGResult.patient_id == patient_id)
        .order_by(ECGResult.recording_date.asc())
        .all()
    )

    ecg_rows = [
        [
            Paragraph("<b>Date</b>", body_bold),
            Paragraph("<b>Source</b>", body_bold),
            Paragraph("<b>HR</b>", body_bold),
            Paragraph("<b>PR Int</b>", body_bold),
            Paragraph("<b>QRS Dur</b>", body_bold),
            Paragraph("<b>QTc Int</b>", body_bold),
            Paragraph("<b>Clinical Guardrail & Findings</b>", body_bold)
        ]
    ]

    for ecg in ecgs:
        pr_str = f"{int(ecg.pr_interval_ms)} ms" if ecg.pr_interval_ms else "-"
        qrs_str = f"{int(ecg.qrs_duration_ms)} ms" if ecg.qrs_duration_ms else "-"
        qtc_str = f"{int(ecg.qtc_interval_ms)} ms" if ecg.qtc_interval_ms else "-"
        advisory = ecg.clinical_advisory or "Physiological intervals documented"
        if len(advisory) > 75:
            advisory = advisory[:72] + "..."

        ecg_rows.append([
            Paragraph(ecg.recording_date.strftime("%d-%b-%Y"), body_style),
            Paragraph(ecg.source_type or "PDF", body_style),
            Paragraph(f"{int(ecg.heart_rate)} bpm" if ecg.heart_rate else "-", body_style),
            Paragraph(pr_str, body_style),
            Paragraph(qrs_str, body_style),
            Paragraph(qtc_str, body_style),
            Paragraph(f"<font size=7.5>{advisory}</font>", body_style)
        ])

    if len(ecg_rows) == 1:
        ecg_rows.append([Paragraph("No ECG records on file", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style)])

    t_ecg = Table(ecg_rows, colWidths=[65, 55, 45, 45, 50, 50, 230])
    t_ecg.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#EDF2F7")),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E0")),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(t_ecg)
    story.append(Spacer(1, 10))

    # 6. Section 5: Prescriptions History
    story.append(Paragraph("<b>4. PRESCRIBED MEDICATIONS & CLINICAL ORDERS</b>", section_h2))

    prescriptions = (
        db.query(Prescription)
        .filter(Prescription.patient_id == patient_id)
        .order_by(Prescription.prescription_date.desc())
        .all()
    )

    rx_rows = [
        [
            Paragraph("<b>Date</b>", body_bold),
            Paragraph("<b>Prescription ID</b>", body_bold),
            Paragraph("<b>Diagnosis</b>", body_bold),
            Paragraph("<b>Prescribed Medications & Regimen</b>", body_bold),
            Paragraph("<b>Doctor</b>", body_bold)
        ]
    ]

    for rx in prescriptions:
        doc_obj = db.query(Doctor).filter(Doctor.doctor_id == rx.doctor_id).first()
        doc_str = doc_obj.full_name if doc_obj else "Doctor"
        med_summary = []
        for item in rx.items:
            med_summary.append(f"{item.medicine_name} {item.dosage} ({item.frequency})")
        med_text = "; ".join(med_summary) if med_summary else "No drugs logged"

        rx_rows.append([
            Paragraph(rx.prescription_date.strftime("%d-%b-%Y"), body_style),
            Paragraph(rx.prescription_id, body_style),
            Paragraph(rx.diagnosis, body_style),
            Paragraph(med_text, body_style),
            Paragraph(doc_str, body_style)
        ])

    if len(rx_rows) == 1:
        rx_rows.append([Paragraph("No prescriptions on file", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style)])

    t_rx = Table(rx_rows, colWidths=[65, 95, 110, 185, 85])
    t_rx.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#E2E8F0")),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E0")),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(t_rx)
    story.append(Spacer(1, 10))

    # 7. Section 6: AI-Based Longitudinal CAD Assessment Synthesis
    if include_ai:
        _append_ai_section(story, ai_report or generate_longitudinal_cad_report(patient_id, db, persist=False),
                           section_h2, body_style, body_bold, bullet_style)

    # 8. Disclaimer & Legal Regulatory Footnote
    footer_text = (
        "<font size=7 color='#718096'>"
        "MEDIS REGULATORY NOTICE: This document is an electronic consolidation of historical records created across "
        "authorized healthcare institutions under permanent Patient ID " + patient.patient_id + ". AI-generated observations "
        "are automated decision-support findings intended solely to assist licensed medical practitioners. AI outputs do not "
        "constitute an independent medical diagnosis. Generated on " + datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") + " UTC."
        "</font>"
    )
    story.append(HRFlowable(width="100%", thickness=0.8, color=colors.HexColor("#CBD5E0"), spaceBefore=4, spaceAfter=4))
    story.append(Paragraph(footer_text, normal))

    doc.build(story)
    return output_filename


def _append_ai_section(story, ai_report, section_h2, body_style, body_bold, bullet_style):
    story.append(Paragraph("<b>5. AI LONGITUDINAL CARDIOVASCULAR RISK ASSESSMENT</b>", section_h2))

    risk_cat = ai_report.get("review_priority", "INSUFFICIENT_DATA")
    color_map = {"NO_FLAGGED_PROGRESSION": "#2E7D32", "REVIEW": "#E65100", "URGENT_REVIEW": "#C62828"}
    risk_color = color_map.get(risk_cat, "#0D3B66")

    summary_box = [
        [
            Paragraph(
                f"<b>CLINICAL REVIEW PRIORITY:</b> <font color='{risk_color}'><b>{risk_cat.replace('_', ' ')}</b></font><br/>"
                f"<b>Visits Analyzed:</b> {ai_report.get('visits_analyzed_count', 0)} sequential visits across network hospitals.<br/>"
                f"<b>Clinical Summary:</b> {ai_report.get('overall_assessment', '')}<br/>"
                "Descriptive screening, not a probability or diagnosis. A 10-year ASCVD estimate requires separately confirmed model inputs and is not included in this export.",
                body_style
            )
        ]
    ]
    t_sum_box = Table(summary_box, colWidths=[540])
    t_sum_box.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#FFF5F5") if risk_cat == "URGENT_REVIEW" else colors.HexColor("#F7FAFC")),
        ('BOX', (0,0), (-1,-1), 1, colors.HexColor(risk_color)),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t_sum_box)
    story.append(Spacer(1, 6))

    story.append(Paragraph("<b>Longitudinal Trend Observations:</b>", body_bold))
    for obs in ai_report.get("observations", []):
        story.append(Paragraph(f"&bull; {obs}", bullet_style))

    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Clinical Decision Support Recommendations:</b>", body_bold))
    for rec in ai_report.get("recommendations", []):
        story.append(Paragraph(f"&bull; {rec}", bullet_style))

    story.append(Spacer(1, 14))

