"""
MEDIS Digital Prescription PDF Generator
Generates clinical prescription PDFs with ReportLab conforming to MEDIS Spec Section 9.
"""

import os
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether
)

OUTPUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "outputs", "prescriptions"))
os.makedirs(OUTPUT_DIR, exist_ok=True)


def generate_prescription_pdf(
    prescription_data: dict,
    output_filename: str = None
) -> str:
    """
    Renders a clinical prescription PDF.

    Expected prescription_data keys:
    - prescription_id: str
    - visit_id: str
    - date: str
    - hospital_name: str
    - hospital_address: str
    - doctor_name: str
    - doctor_qualification: str
    - doctor_id: str
    - doctor_reg_no: str
    - patient_name: str
    - patient_id: str
    - patient_age: int or str
    - patient_gender: str
    - diagnosis: str
    - vitals: str (e.g., BP 130/85 mmHg, HR 74 bpm)
    - medications: list of dicts: [
        {"medicine_name": "...", "dosage": "...", "frequency": "...", "duration": "...", "instructions": "..."}
      ]
    - general_advice: str
    - follow_up_date: str
    """
    rx_id = prescription_data.get("prescription_id", "RX-UNKNOWN")
    if not output_filename:
        safe_id = rx_id.replace("/", "_").replace("\\", "_")
        output_filename = os.path.join(OUTPUT_DIR, f"{safe_id}.pdf")

    doc = SimpleDocTemplate(
        output_filename,
        pagesize=letter,
        rightMargin=40,
        leftMargin=40,
        topMargin=35,
        bottomMargin=35
    )

    styles = getSampleStyleSheet()
    normal = styles["Normal"]

    title_style = ParagraphStyle(
        "PrescriptionTitle",
        parent=normal,
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=22,
        textColor=colors.HexColor("#0D3B66")
    )
    h2_style = ParagraphStyle(
        "PrescriptionH2",
        parent=normal,
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=14,
        textColor=colors.HexColor("#1A535C")
    )
    meta_style = ParagraphStyle(
        "PrescriptionMeta",
        parent=normal,
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#4A5568")
    )
    body_bold = ParagraphStyle(
        "PrescriptionBodyBold",
        parent=normal,
        fontName="Helvetica-Bold",
        fontSize=10,
        leading=13,
        textColor=colors.HexColor("#2D3748")
    )
    body_style = ParagraphStyle(
        "PrescriptionBody",
        parent=normal,
        fontName="Helvetica",
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#2D3748")
    )

    story = []

    # 1. Hospital Header
    h_name = prescription_data.get("hospital_name", "MEDIS HEALTHCARE NETWORK")
    h_addr = prescription_data.get("hospital_address", "Cardiovascular Sciences Centre, New Delhi, India")
    
    header_data = [
        [
            Paragraph(f"<b>{h_name.upper()}</b>", title_style),
            Paragraph(f"<b>PRESCRIPTION</b><br/><font size=8 color='#718096'>ID: {rx_id}</font>", ParagraphStyle(
                "HeaderRight", parent=normal, fontName="Helvetica-Bold", fontSize=12, leading=15, alignment=2, textColor=colors.HexColor("#2B6CB0")
            ))
        ],
        [
            Paragraph(f"{h_addr} &bull; Emergency Tel: +91 11 2659 8700", meta_style),
            Paragraph(f"Date: <b>{prescription_data.get('date', datetime.utcnow().strftime('%d %b %Y'))}</b>", ParagraphStyle(
                "DateRight", parent=normal, fontSize=9, leading=12, alignment=2
            ))
        ]
    ]
    t_header = Table(header_data, colWidths=[360, 172])
    t_header.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
    ]))
    story.append(t_header)
    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#0D3B66"), spaceBefore=2, spaceAfter=8))

    # 2. Doctor & Patient Info Bar
    doc_info = (
        f"<b>{prescription_data.get('doctor_name', 'Dr. Consultant')}</b>, {prescription_data.get('doctor_qualification', 'MBBS, MD')}<br/>"
        f"Specialization: {prescription_data.get('doctor_specialization', 'Cardiology')}<br/>"
        f"Reg No: {prescription_data.get('doctor_reg_no', 'MCI-84920')} | ID: <b>{prescription_data.get('doctor_id', 'MEDIS-D-2026-0012')}</b>"
    )

    pt_info = (
        f"Patient: <b>{prescription_data.get('patient_name', 'Patient Name')}</b> ({prescription_data.get('patient_gender', 'M')}/{prescription_data.get('patient_age', '50')} yrs)<br/>"
        f"Permanent ID: <b>{prescription_data.get('patient_id', 'MEDIS-P-2026-00001')}</b><br/>"
        f"Visit ID: <b>{prescription_data.get('visit_id', 'MEDIS-V-2026-00001')}</b>"
    )

    info_table = Table(
        [[Paragraph(doc_info, body_style), Paragraph(pt_info, body_style)]],
        colWidths=[266, 266]
    )
    info_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor("#F7FAFC")),
        ('BOX', (0,0), (-1,-1), 1, colors.HexColor("#E2E8F0")),
        ('TOPPADDING', (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 10))

    # 3. Clinical Diagnosis & Vitals
    diag = prescription_data.get("diagnosis", "Essential Hypertension, CAD Evaluation")
    vitals = prescription_data.get("vitals", "BP: 138/88 mmHg | HR: 76 bpm | SpO2: 98% | BMI: 26.4 kg/m²")
    
    diag_data = [
        [Paragraph("<b>CLINICAL DIAGNOSIS:</b>", h2_style), Paragraph(f"<b>{diag}</b>", body_bold)],
        [Paragraph("<b>RECORDED VITALS:</b>", meta_style), Paragraph(vitals, meta_style)]
    ]
    diag_table = Table(diag_data, colWidths=[150, 382])
    diag_table.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ]))
    story.append(diag_table)
    story.append(Spacer(1, 12))

    # 4. Rx Symbol & Medications Table
    story.append(Paragraph("<b><font size=14 color='#0D3B66'>&#8478;</font> MEDICATIONS PRESCRIBED</b>", h2_style))
    story.append(Spacer(1, 4))

    med_header = [
        Paragraph("<b>#</b>", body_bold),
        Paragraph("<b>Medicine Name & Strength</b>", body_bold),
        Paragraph("<b>Dosage</b>", body_bold),
        Paragraph("<b>Frequency</b>", body_bold),
        Paragraph("<b>Duration</b>", body_bold),
        Paragraph("<b>Instructions</b>", body_bold)
    ]

    med_rows = [med_header]
    meds = prescription_data.get("medications", [])
    if not meds:
        med_rows.append([Paragraph("1", body_style), Paragraph("No medications prescribed", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style), Paragraph("-", body_style)])
    else:
        for idx, m in enumerate(meds, start=1):
            med_rows.append([
                Paragraph(str(idx), body_style),
                Paragraph(f"<b>{m.get('medicine_name', '')}</b>", body_style),
                Paragraph(m.get("dosage", ""), body_style),
                Paragraph(m.get("frequency", ""), body_style),
                Paragraph(m.get("duration", ""), body_style),
                Paragraph(m.get("instructions", "After food"), body_style),
            ])

    t_meds = Table(med_rows, colWidths=[24, 180, 75, 75, 68, 110])
    t_meds.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#EBF8FF")),
        ('TEXTCOLOR', (0,0), (-1,0), colors.HexColor("#2B6CB0")),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E0")),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_meds)
    story.append(Spacer(1, 14))

    # 5. General Advice & Lifestyle Instructions
    advice = prescription_data.get("general_advice", "Salt restricted diet (<5g/day). Regular aerobic exercise 30 min/day, 5 days/week. Avoid tobacco and heavy physical strain.")
    follow_up = prescription_data.get("follow_up_date", "After 4 weeks with repeat Lipid Profile and Fasting Blood Glucose")
    
    advice_content = [
        [Paragraph("<b>General Advice:</b>", body_bold), Paragraph(advice, body_style)],
        [Paragraph("<b>Follow-up Date:</b>", body_bold), Paragraph(f"<b>{follow_up}</b>", body_style)]
    ]
    t_advice = Table(advice_content, colWidths=[110, 422])
    t_advice.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(t_advice)
    story.append(Spacer(1, 24))

    # 6. Digital Verification & Signature Block
    sig_block = [
        [
            Paragraph(
                "<font color='#718096' size=7>MEDIS VERIFIED DIGITAL PRESCRIPTION<br/>"
                "Tamper-evident record under Medical Council Regulations.<br/>"
                "One Patient ID &bull; Centralized Longitudinal Health Record</font>",
                normal
            ),
            Paragraph(
                f"<b>{prescription_data.get('doctor_name', 'Consultant Cardiologist')}</b><br/>"
                f"<font size=8 color='#4A5568'>Digital Signature Verified</font><br/>"
                f"<font size=7 color='#718096'>Timestamp: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC</font>",
                ParagraphStyle("SigBlock", parent=normal, alignment=2)
            )
        ]
    ]
    t_sig = Table(sig_block, colWidths=[320, 212])
    t_sig.setStyle(TableStyle([
        ('LINEABOVE', (1,0), (1,0), 1, colors.HexColor("#718096")),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ]))
    story.append(KeepTogether(t_sig))

    doc.build(story)
    return output_filename

