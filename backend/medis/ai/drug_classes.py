"""Curated medicine classes for treatment-response monitoring.

Deliberately small: only classes whose effect shows up in a metric MEDIS records,
matched on generic names. Unknown medicines (and brand names) are ignored rather
than guessed. This is a prototype list, not a drug database.
"""
import re

# check = (metric, earliest day a follow-up reading counts, day it is due by)
DRUG_CLASSES = {
    "statin": {
        "label": "Statin",
        "generics": {"atorvastatin", "rosuvastatin", "simvastatin", "pravastatin",
                     "pitavastatin", "lovastatin", "fluvastatin"},
        "checks": [("ldl_cholesterol", 28, 84)],
    },
    "antihypertensive": {
        "label": "Blood-pressure medicine",
        "generics": {"amlodipine", "cilnidipine", "nifedipine", "telmisartan", "losartan",
                     "olmesartan", "valsartan", "irbesartan", "candesartan", "ramipril",
                     "enalapril", "lisinopril", "perindopril", "metoprolol", "atenolol",
                     "bisoprolol", "nebivolol", "carvedilol", "chlorthalidone",
                     "hydrochlorothiazide", "indapamide"},
        "checks": [("systolic_bp", 14, 42), ("diastolic_bp", 14, 42)],
    },
    "glucose_lowering": {
        "label": "Glucose-lowering medicine",
        "generics": {"metformin", "glimepiride", "gliclazide", "glipizide", "sitagliptin",
                     "vildagliptin", "teneligliptin", "linagliptin", "empagliflozin",
                     "dapagliflozin", "canagliflozin", "pioglitazone", "voglibose", "insulin"},
        # HbA1c reflects ~3 months; fasting glucose responds within weeks.
        "checks": [("hba1c", 84, 120), ("fasting_glucose", 14, 42)],
    },
}

_WORD = re.compile(r"[a-z]+")


def classify(medicine_name):
    """[(class_key, generic)] for every recognised generic in a medicine name.

    "Tab. Atorvastatin 20 mg" -> [("statin", "atorvastatin")]; a combination such as
    "Amlodipine + Atorvastatin" yields both classes.
    """
    words = set(_WORD.findall(str(medicine_name or "").casefold()))
    found = []
    for key, spec in DRUG_CLASSES.items():
        for generic in sorted(spec["generics"] & words):
            found.append((key, generic))
    return found
