"""Report digitisation: PDF/image -> text (OCR) -> structured clinical fields (NLP/regex) -> model inputs."""
import re
from pathlib import Path

import numpy as np

NUM = r"(-?\d+(?:[.,]\d+)?)"

# (field, include regex, exclude regex)  - applied line by line on lower-cased text
RULES = [
    ("total_chol", r"(total\s*cholesterol|cholesterol[\s,]*total|serum\s*cholesterol|^\s*cholesterol)", r"ldl|hdl|vldl|non[- ]?hdl|ratio"),
    ("ldl", r"\bldl\b", r"ratio"),
    ("hdl", r"\bhdl\b", r"non[- ]?hdl|ratio"),
    ("triglycerides", r"triglyceride|\btg\b", None),
    ("fasting_glucose", r"(fasting\s*(blood\s*)?(glucose|sugar)|\bfbs\b|\bfbg\b|glucose[\s,]*fasting)", None),
    ("hba1c", r"hba[1il]c|glycated\s*h(a)?emoglobin|glycosylated", None),
    ("creatinine", r"creatinine", r"clearance|egfr"),
    ("egfr", r"\begfr\b", None),
    ("c_peptide", r"c[- ]?peptide", None),
    ("alpha_gal", r"(alpha|α)[\s-]*gal(actosidase)?[\s-]*a?|a-gal\s*a|\bgla\s*activity", None),
    ("lyso_gb3", r"lyso[\s-]*(gb3|gl[\s-]?3)", None),
    ("iop", r"\biop\b|intra[\s-]*ocular\s*pressure", None),
    ("cdr", r"cup[\s-]*(to[\s-]*)?disc\s*ratio|\bcdr\b", None),
    ("rnfl", r"\brnfl\b", None),
    ("vf_md", r"mean\s*deviation|\bvf\s*md\b", None),
    ("bmi", r"\bbmi\b|body\s*mass\s*index", None),
    ("max_hr", r"(maximum|max\.?|peak)\s*heart\s*rate|\bthalach\b", None),
    ("oldpeak", r"st\s*depression|oldpeak", None),
]


def read_text(path):
    path = Path(path)
    if path.suffix.lower() == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(path) as pdf:
                txt = "\n".join((pg.extract_text() or "") for pg in pdf.pages)
            if len(txt.strip()) > 40:  # digital PDF
                return txt
        except Exception:
            pass
        from pdf2image import convert_from_path
        return "\n".join(_ocr(np.array(im)) for im in convert_from_path(str(path), dpi=250))
    import cv2
    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"cannot read image {path}")
    return _ocr(img)


def _ocr(img):
    import cv2
    import pytesseract
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if g.shape[1] < 1600:
        g = cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    g = cv2.fastNlMeansDenoising(g, None, 10)
    g = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    return pytesseract.image_to_string(g, config="--psm 6")


def _f(s):
    return float(s.replace(",", "."))


def _unit_after(line, end, width=14):
    return line[end:end + width].lower().replace(" ", "")


def extract_fields(text):
    """Return {field: value} (standardised to mg/dL, %, ng/mL, umol/L/h ...) + provenance."""
    out, src = {}, {}
    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        if not low:
            continue
        # blood pressure
        m = re.search(r"(?:blood\s*pressure|\bbp\b)[^0-9]{0,15}(\d{2,3})\s*/\s*(\d{2,3})", low)
        if m:
            out["bp_sys"], out["bp_dia"] = _f(m.group(1)), _f(m.group(2))
            src["bp_sys"] = src["bp_dia"] = line
        # age / sex
        m = re.search(r"age\s*(?:/\s*sex)?\s*[:\-]?\s*(\d{1,3})\s*(?:y|yrs|years)?\s*(?:/\s*|,\s*|\s+)?(male|female|m|f)?\b", low)
        if m and "age" not in out:
            out["age"] = _f(m.group(1)); src["age"] = line
            if m.group(2):
                out["sex"] = 1.0 if m.group(2).startswith("m") else 0.0; src["sex"] = line
        m = re.search(r"\bsex\s*[:\-]?\s*(male|female|m|f)\b", low)
        if m:
            out["sex"] = 1.0 if m.group(1).startswith("m") else 0.0; src["sex"] = line
        # lab fields
        for field, inc, exc in RULES:
            if field in out:
                continue
            mi = re.search(inc, low)
            if not mi or (exc and re.search(exc, low)):
                continue
            mn = re.search(NUM, low[mi.end():])
            if not mn:
                continue
            val = _f(mn.group(1))
            unit = _unit_after(low, mi.end() + mn.end())
            val = _convert(field, val, unit)
            out[field] = val
            src[field] = line
    return {"fields": out, "source_lines": src}


def _convert(field, val, unit):
    if field in ("total_chol", "ldl", "hdl") and "mmol" in unit:
        return val * 38.67
    if field == "triglycerides" and "mmol" in unit:
        return val * 88.57
    if field == "fasting_glucose" and "mmol" in unit:
        return val * 18.016
    if field == "hba1c" and "mmol" in unit:  # IFCC -> NGSP %
        return val / 10.929 + 2.15
    if field == "creatinine" and ("umol" in unit or "µmol" in unit):
        return val / 88.4
    return val


def to_model_inputs(fields: dict) -> dict:
    """Map extracted report fields to the feature names used by the disease models."""
    f = fields
    m = {}
    if "age" in f: m["age"] = f["age"]
    if "sex" in f: m["sex"] = f["sex"]
    if "bp_sys" in f: m["trestbps"] = f["bp_sys"]
    if "total_chol" in f: m["chol"] = f["total_chol"]
    if "fasting_glucose" in f: m["fbs"] = float(f["fasting_glucose"] > 120)
    if "max_hr" in f: m["thalach"] = f["max_hr"]
    if "oldpeak" in f: m["oldpeak"] = f["oldpeak"]
    # MODY
    for k in ("hba1c", "c_peptide", "bmi", "hdl"):
        if k in f: m[k] = f[k]
    # Fabry
    for k in ("alpha_gal", "lyso_gb3", "egfr"):
        if k in f: m[k] = f[k]
    # Glaucoma
    for k in ("iop", "cdr", "rnfl", "vf_md"):
        if k in f: m[k] = f[k]
    return m
