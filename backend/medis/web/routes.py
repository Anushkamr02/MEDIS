"""Static browser interface and multipart ECG preview endpoint."""
import math
import re
import tempfile
from pathlib import Path
from datetime import date
from typing import Literal

from fastapi import Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from medis.auth.security import decode_access_token
from medis.database.connection import get_db
from medis.database.models import DoctorCredential, PatientCredential, PatientDocument

STATIC = Path(__file__).resolve().parent / "static"
MAX_FILE_BYTES = 25 * 1024 * 1024
bearer = HTTPBearer(auto_error=False)


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


def web_identity(credentials: HTTPAuthorizationCredentials = Depends(bearer), db: Session = Depends(get_db)):
    payload = decode_access_token(credentials.credentials) if credentials else None
    if not payload or payload.get("role") not in {"DOCTOR", "PATIENT"}:
        raise HTTPException(401, "Sign in to continue")
    model, key = ((DoctorCredential, DoctorCredential.doctor_id) if payload["role"] == "DOCTOR"
                  else (PatientCredential, PatientCredential.patient_id))
    if not db.query(model).filter(key == payload.get("sub"), model.is_active.is_(True)).first():
        raise HTTPException(401, "Account is unavailable")
    return payload


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


def install_web_routes(app):
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/", include_in_schema=False)
    def web_home():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    @app.post("/api/ai/longitudinal/{patient_id}")
    def longitudinal_comparison(patient_id: str, inputs: LegacyRiskInputs,
                                identity=Depends(web_identity), db: Session = Depends(get_db)):
        if identity["role"] != "DOCTOR":
            raise HTTPException(403, "Doctor account required for confirmed risk inputs")
        from medis.ai.longitudinal_analysis import generate_longitudinal_cad_report
        report = generate_longitudinal_cad_report(patient_id, db, persist=False,
                                                  risk_inputs=inputs.model_dump(mode="json"))
        if "error" in report:
            raise HTTPException(404, "Patient not found")
        return report

    @app.get("/api/web/documents")
    def own_documents(identity=Depends(web_identity), db: Session = Depends(get_db)):
        if identity["role"] != "PATIENT":
            raise HTTPException(403, "Patient account required")
        docs = db.query(PatientDocument).filter(PatientDocument.patient_id == identity["sub"]).order_by(PatientDocument.uploaded_at.desc()).all()
        return [{"file_name": d.file_name, "category": d.category, "uploaded_at": d.uploaded_at,
                 "verified_by_doctor": d.verified_by_doctor} for d in docs]

    @app.post("/api/ecg/analyze")
    async def ecg_preview(files: list[UploadFile] = File(...), identity=Depends(web_identity)):
        if identity["role"] != "DOCTOR":
            raise HTTPException(403, "Doctor account required")
        if not 1 <= len(files) <= 16:
            raise HTTPException(422, "Upload between 1 and 16 files")
        with tempfile.TemporaryDirectory(prefix="medis-ecg-") as folder:
            paths = []
            for file in files:
                name = file.filename or ""
                if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name.startswith("."):
                    raise HTTPException(422, "Use filenames containing letters, digits, dots, hyphens or underscores")
                path = Path(folder) / name
                if path.suffix.lower() not in {".pdf", ".png", ".jpg", ".jpeg", ".hea", ".dat", ".mat", ".csv", ".npy"}:
                    raise HTTPException(415, "Unsupported ECG file type")
                if path.exists():
                    raise HTTPException(422, "Duplicate upload filename")
                content = await file.read(MAX_FILE_BYTES + 1)
                if not content or len(content) > MAX_FILE_BYTES:
                    raise HTTPException(413, "Each file must be nonempty and at most 25 MB")
                path.write_bytes(content)
                paths.append(path)
            try:
                return await run_in_threadpool(analyze_uploads, paths)
            except HTTPException:
                raise
            except (ValueError, UnicodeError) as exc:
                raise HTTPException(422, str(exc)) from exc
