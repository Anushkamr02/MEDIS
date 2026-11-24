"""ECG upload validation, the confirmed PCE input model and JSON-safe conversion.

Moved out of the teammate's legacy web gateway (medis/web) so the AI service
no longer depends on its SQLite login and static UI.
"""
import math
import re
from datetime import date
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

MAX_FILE_BYTES = 25 * 1024 * 1024


class LegacyRiskInputs(BaseModel):
    """Explicit snapshot; never infer negative clinical flags from missing records."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    model_sex: Literal["Female", "Male", "Unsupported"]
    cohort: Literal["White", "Black", "Other"]
    age: int = Field(ge=40, le=79, strict=True)
    total_cholesterol: float = Field(ge=130, le=320)
    hdl_cholesterol: float = Field(ge=20, le=100)
    systolic_bp: float = Field(ge=90, le=200)
    bp_treated: StrictBool
    diabetes: StrictBool
    current_smoker: StrictBool
    known_ascvd: StrictBool
    snapshot_date: date


def json_safe(value):
    """Convert numpy outputs and nonfinite values to interoperable JSON."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if hasattr(value, "tolist"):
        return json_safe(value.tolist())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, Path):
        return value.name
    return value


def analyze_uploads(paths):
    """Analyse one uploaded ECG: a single file, or a WFDB header with every signal file it names."""
    headers = [p for p in paths if p.suffix.lower() == ".hea"]
    if headers:
        if len(headers) != 1:
            raise HTTPException(422, "Upload one WFDB record at a time")
        target = headers[0]
        lines = [line for line in target.read_text(encoding="utf-8").splitlines()
                 if line.strip() and not line.lstrip().startswith("#")]
        names = {p.name for p in paths}
        if not lines or "/" in lines[0].split()[0]:
            raise HTTPException(422, "Only single-record WFDB headers are supported")
        try:
            count = int(lines[0].split()[1])
        except (ValueError, IndexError):
            raise HTTPException(422, "Invalid WFDB header")
        if count < 1 or len(lines) < count + 1:
            raise HTTPException(422, "Incomplete WFDB header")
        for line in lines[1:count + 1]:
            name = line.split()[0]
            if name not in names or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
                raise HTTPException(422, "Upload every signal file referenced by the header")
    elif len(paths) == 1 and paths[0].suffix.lower() not in {".dat", ".mat"}:
        target = paths[0]
    else:
        raise HTTPException(422, "Upload one image/PDF/CSV/NPY, or a WFDB header with its signal files")
    from medis.ecg_inference import analyze_ecg
    return json_safe(analyze_ecg(str(target)))
