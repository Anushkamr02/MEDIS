"""Unified ECG inference — single entry point for all ECG input modalities.

Strict Clinical Modality Policy:
  1. Digital 10-second continuous signals (WFDB / PTB-XL):
     Validated and classified using the trained 10-second 1D CNN model.
  2. Sequential 2.5-second printout leads (PDF / JPG / PNG):
     Digitized authentically with exact time offsets and calibration.
     BLOCKED from 10-second CNN classification by default because a model
     trained on simultaneous 10s recordings is not clinically validated on
     asynchronous 2.5s lead segments.
  3. Continuous Rhythm Strip (typically Lead II, 10s):
     Preserved independently for rhythm analysis; not treated as a 12-lead signal.
"""

import json
import logging
from pathlib import Path
from typing import Optional, Union

import numpy as np

from .config import MODELS, OUT

logger = logging.getLogger(__name__)

LEADS = ["I", "II", "III", "aVR", "aVL", "aVF",
         "V1", "V2", "V3", "V4", "V5", "V6"]

FORMAT_MAP = {
    ".dat": "wfdb", ".hea": "wfdb", ".mat": "wfdb_mat",
    ".csv": "csv",
    ".npy": "npy",
    ".pdf": "pdf",
    ".png": "image", ".jpg": "image", ".jpeg": "image",
    ".bmp": "image", ".tiff": "image", ".tif": "image",
}


def detect_format(input_path: Union[str, Path]) -> str:
    """Detect ECG input format from file extension or sibling files."""
    path = Path(input_path)
    ext = path.suffix.lower()
    if ext in FORMAT_MAP:
        return FORMAT_MAP[ext]

    if path.with_suffix(".hea").exists() or path.with_suffix(".dat").exists():
        return "wfdb"

    if path.with_suffix(".hea").exists() or path.with_suffix(".mat").exists():
        return "wfdb_mat"

    raise ValueError(f"Unsupported ECG format: '{ext}'. Supported: {sorted(set(FORMAT_MAP.values()))}")


# ═══════════════════════════════════════════════════════════════════════════
# Loaders
# ═══════════════════════════════════════════════════════════════════════════

def load_wfdb(input_path: Union[str, Path]) -> tuple[np.ndarray, dict]:
    """Load a 10-second WFDB continuous recording and metadata.

    Automatically detects whether the companion signal file is a binary .dat
    (standard WFDB) or a MATLAB .mat (PhysioNet/CPSC format) and routes to the
    appropriate loader.
    """
    path = Path(input_path)
    stem = path.with_suffix("")

    # If companion is .mat (not .dat), delegate to the .mat loader
    if (stem.with_suffix(".mat")).exists() and not (stem.with_suffix(".dat")).exists():
        return load_wfdb_mat(input_path)

    # Neither .dat nor .mat present — give a friendly error before wfdb crashes
    dat_path = stem.with_suffix(".dat")
    mat_path = stem.with_suffix(".mat")
    if not dat_path.exists() and not mat_path.exists():
        raise FileNotFoundError(
            f"No signal file found for '{stem.name}.hea'. "
            f"Expected '{stem.name}.dat' (standard WFDB) or '{stem.name}.mat' (PhysioNet/CPSC). "
            f"Upload BOTH the .hea and its companion signal file together."
        )

    import wfdb
    record_path = str(stem)
    record = wfdb.rdsamp(record_path)
    signal = record[0]
    fields = record[1]
    fs = fields.get("fs", 100)

    if signal.shape[0] != 1000 or fs != 100:
        from .ecg_preprocessing import resample_signal
        signal = resample_signal(signal, orig_fs=fs, target_fs=100)

    sig_12 = signal[:, :12].astype(np.float32)
    meta = {
        "fs": 100,
        "duration_sec": 10.0,
        "is_simultaneous": True,
        "source": "wfdb_digital",
    }
    return sig_12, meta


def load_wfdb_mat(input_path: Union[str, Path]) -> tuple[np.ndarray, dict]:
    """Load a PhysioNet/CPSC-style WFDB record that uses .mat signal files.

    These records have a .hea header that references JS00001.mat (or similar),
    using the MATLAB-16 format.  wfdb.rdsamp() cannot read .mat files directly,
    so we parse the header manually and load the binary data with scipy.io.
    """
    import scipy.io

    path = Path(input_path)
    hea_path = path.with_suffix(".hea")
    mat_path = path.with_suffix(".mat")

    if not hea_path.exists():
        # Caller may have given the .mat; find the companion .hea
        hea_path = path.with_suffix(".hea")
        mat_path = path.with_suffix(".mat")

    if not hea_path.exists():
        raise FileNotFoundError(f"WFDB header not found: {hea_path}")
    if not mat_path.exists():
        raise FileNotFoundError(
            f"Missing companion signal file: '{mat_path.name}'. "
            f"This WFDB record requires BOTH files uploaded together: "
            f"'{hea_path.name}' (header) + '{mat_path.name}' (signal data). "
            f"Please upload both files simultaneously using the ECG file uploader."
        )

    # Parse header for sampling frequency and number of leads
    fs = 500
    n_leads = 12
    with open(hea_path, "r") as fh:
        first_line = fh.readline().strip().split()
        if len(first_line) >= 3:
            n_leads = int(first_line[1])
            fs = int(first_line[2])

    # Load .mat — CPSC/PhysioNet format stores signal as (leads, samples) matrix
    mat = scipy.io.loadmat(str(mat_path))
    # Common variable names used by CPSC2018 and PhysioNet datasets
    for key in ("val", "data", "ecg", "signal"):
        if key in mat:
            signal = mat[key].astype(np.float32)
            break
    else:
        # Fall back: find the first 2-D numeric array
        candidates = [v for k, v in mat.items()
                      if not k.startswith("_") and isinstance(v, np.ndarray) and v.ndim == 2]
        if not candidates:
            raise ValueError(f"Could not locate ECG signal array in {mat_path}")
        signal = candidates[0].astype(np.float32)

    # Normalise orientation to (samples, leads)
    if signal.shape[0] in (12, n_leads) and signal.shape[1] > signal.shape[0]:
        signal = signal.T          # (leads, samples) → (samples, leads)

    # Apply gain: CPSC files store raw ADC counts (gain = 1000 ADC/mV)
    # The .hea lines specify gain/mV on each signal line (field index 2 → "1000/mV")
    gain = 1000.0
    signal = signal / gain         # → millivolts

    # Resample to 100 Hz / 1000 samples for the CNN
    target_samples = 1000
    if signal.shape[0] != target_samples or fs != 100:
        from .ecg_preprocessing import resample_signal
        signal = resample_signal(signal, orig_fs=fs, target_fs=100)

    sig_12 = signal[:, :12].astype(np.float32)
    meta = {
        "fs": 100,
        "duration_sec": 10.0,
        "is_simultaneous": True,
        "source": "wfdb_mat",
        "original_fs": fs,
    }
    return sig_12, meta


def load_csv(input_path: Union[str, Path]) -> tuple[np.ndarray, dict]:
    """Load ECG from a CSV file (expects 12 numeric columns, 1000 samples)."""
    import pandas as pd
    df = pd.read_csv(input_path)

    if all(lead in df.columns for lead in LEADS):
        signal = df[LEADS].values
    else:
        num_cols = df.select_dtypes(include=[np.number]).columns
        signal = df[num_cols[:12]].values

    signal = np.nan_to_num(signal.astype(np.float32))

    if signal.shape[0] != 1000:
        from scipy.signal import resample
        signal = resample(signal, 1000, axis=0)

    meta = {
        "fs": 100,
        "duration_sec": 10.0,
        "is_simultaneous": True,
        "source": "csv_digital",
    }
    return signal.astype(np.float32), meta


def load_npy(input_path: Union[str, Path]) -> tuple[np.ndarray, dict]:
    """Load ECG from a numpy array file (.npy)."""
    signal = np.load(input_path)
    if signal.ndim == 2 and signal.shape[0] == 12 and signal.shape[1] != 12:
        signal = signal.T
    signal = np.nan_to_num(signal.astype(np.float32))
    if signal.shape[0] != 1000:
        from scipy.signal import resample
        signal = resample(signal, 1000, axis=0)
    meta = {
        "fs": 100,
        "duration_sec": 10.0,
        "is_simultaneous": True,
        "source": "npy_digital",
    }
    return signal.astype(np.float32), meta


# ═══════════════════════════════════════════════════════════════════════════
# CNN Prediction with Guardrails
# ═══════════════════════════════════════════════════════════════════════════

def load_cnn_model(model_name: str = "ecg_cnn"):
    """Load trained Keras CNN model."""
    model_path = MODELS / f"{model_name}.keras"
    if not model_path.exists():
        logger.error(f"CNN model not found at {model_path}")
        return None

    import tensorflow as tf
    return tf.keras.models.load_model(str(model_path))


def predict_ecg_cnn(signal: np.ndarray, model=None,
                    model_name: str = "ecg_cnn",
                    norm_params_path: Optional[Path] = None) -> dict:
    """Run ECG classification on a verified simultaneous 12-lead signal."""
    if model is None:
        model = load_cnn_model(model_name)
        if model is None:
            raise RuntimeError(f"Could not load model '{model_name}'")

    from .ecg_preprocessing import load_normalization_params, normalize_signal

    norm_path = norm_params_path or (MODELS / f"{model_name}_norm_params.json")
    if norm_path.exists():
        mean, std = load_normalization_params(norm_path)
        signal = normalize_signal(signal, mean=mean, std=std)
    else:
        signal = normalize_signal(signal)

    x = np.expand_dims(signal, axis=0).astype(np.float32)
    prob = float(model.predict(x, verbose=0)[0, 0])

    prediction = "MI" if prob >= 0.5 else "NORM"
    confidence = prob if prob >= 0.5 else (1.0 - prob)

    return {
        "prediction": prediction,
        "confidence": round(confidence, 4),
        "probability_MI": round(prob, 4),
        "class_probabilities": {
            "NORM": round(1.0 - prob, 4),
            "MI": round(prob, 4),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════
# Master Analysis Interface
# ═══════════════════════════════════════════════════════════════════════════

def analyze_ecg(input_path: Union[str, Path],
                format: Optional[str] = None,
                model_name: str = "ecg_cnn",
                validate: bool = True,
                allow_experimental_short_cnn: bool = False) -> dict:
    """Analyze an ECG input file with strict clinical modality guardrails.

    Parameters
    ----------
    input_path                   : path to the ECG file (WFDB, CSV, PDF, JPG, PNG).
    format                       : override auto-detection ("wfdb", "csv", "pdf", "image").
    model_name                   : name of the CNN model to use for verified 10s signals.
    validate                     : run signal quality and lead checks.
    allow_experimental_short_cnn : allow running 10s CNN on 2.5s signals for experimental
                                   research only (default: False, BLOCKED for safety).

    Returns
    -------
    dict with full extraction results, validation report, and classification status.
    """
    input_path = Path(input_path)
    fmt = format or detect_format(input_path)

    result = {
        "input_file": str(input_path),
        "input_format": fmt,
        "status": "pending",
        "is_simultaneous_12_lead": False,
        "signal_shape": None,
        "digitization": None,
        "validation": None,
        "classification": None,
        "clinical_notice": None,
        "success": False,
        "error": None,
    }

    try:
        # Case A: Digital ECG (WFDB / CSV / NPY) — Continuous 10-second recording
        if fmt in ("wfdb", "wfdb_mat", "csv", "npy"):
            if fmt == "wfdb":
                signal, meta = load_wfdb(input_path)
            elif fmt == "wfdb_mat":
                signal, meta = load_wfdb_mat(input_path)
            elif fmt == "csv":
                signal, meta = load_csv(input_path)
            else:
                signal, meta = load_npy(input_path)

            result["signal_shape"] = list(signal.shape)
            result["is_simultaneous_12_lead"] = True

            # Export per-lead voltage arrays for waveform visualizer in the UI
            lead_signals_path_a = {}
            for i, lead_name in enumerate(LEADS[:signal.shape[1]]):
                lead_signals_path_a[lead_name] = [round(float(v), 4) for v in signal[:, i]]
            result["lead_signals"] = lead_signals_path_a

            from .ecg_pdf_digitizer import compute_cardiac_intervals
            result["cardiac_intervals"] = compute_cardiac_intervals(signal[:, 1], fs=100)

            if validate:
                from .ecg_validation import validate_ecg_for_classification
                result["validation"] = validate_ecg_for_classification(signal)

            result["classification"] = predict_ecg_cnn(signal, model_name=model_name)
            result["status"] = "validated_continuous_10s_analysis"
            result["success"] = True
            result["clinical_notice"] = (
                "Continuous 10-second 12-lead digital ECG evaluated by 1D CNN (PTB-XL trained). "
                "Decision support output; doctor verification required."
            )
            return result

        # Case B: ECG PDF or Image Report — Multi-vendor hospital printout
        elif fmt in ("pdf", "image"):
            from .ecg_pdf_digitizer import digitize_ecg_pdf, digitize_ecg_image
            dig_res = digitize_ecg_pdf(input_path) if fmt == "pdf" else digitize_ecg_image(input_path)

            # Package digitization details for clinical review
            leads_summary = {}
            lead_signals = {}
            for lead_name, lead_obj in dig_res.leads.items():
                leads_summary[lead_name] = {
                    "is_missing": lead_obj.is_missing,
                    "duration_sec": lead_obj.duration_sec,
                    "time_start_sec": lead_obj.time_start_sec,
                    "time_end_sec": lead_obj.time_end_sec,
                    "amplitude_ptp_mV": lead_obj.amplitude_ptp_mV,
                    "samples_extracted": len(lead_obj.signal) if lead_obj.signal is not None else 0,
                }
                if lead_obj.signal is not None and len(lead_obj.signal) > 0:
                    lead_signals[lead_name] = [round(float(x), 4) for x in lead_obj.signal]

            rhythm_summary = None
            if dig_res.rhythm_strip is not None and dig_res.rhythm_strip.signal is not None:
                rhythm_summary = {
                    "lead_name": dig_res.rhythm_strip.lead_name,
                    "duration_sec": dig_res.rhythm_strip.duration_sec,
                    "samples_extracted": len(dig_res.rhythm_strip.signal),
                    "amplitude_ptp_mV": dig_res.rhythm_strip.amplitude_ptp_mV,
                }
                lead_signals["Rhythm_Strip_II"] = [round(float(x), 4) for x in dig_res.rhythm_strip.signal]

            result["digitization"] = {
                "success": dig_res.success,
                "lead_signals": lead_signals,
                "layout_detected": dig_res.layout_detected,
                "layout_confidence": dig_res.layout_confidence,
                "vendor_detected": dig_res.vendor_detected,
                "cardiac_intervals": dig_res.cardiac_intervals,
                "is_simultaneous_12_lead": dig_res.is_simultaneous_12_lead,
                "extraction_completeness": dig_res.extraction_completeness,
                "signal_continuity": dig_res.signal_continuity,
                "quality_metrics": {
                    "calibration_confidence_pct": dig_res.quality.calibration_confidence,
                    "lead_completeness_pct": dig_res.quality.extraction_completeness,
                    "signal_continuity_pct": dig_res.quality.signal_continuity,
                    "waveform_fidelity": "requires_digital_reference",
                },
                "calibration": {
                    "confidence": dig_res.calibration.confidence,
                    "is_fallback": dig_res.calibration.is_fallback,
                    "pixels_per_mm_x": round(dig_res.calibration.pixels_per_mm_x, 2),
                    "pixels_per_mm_y": round(dig_res.calibration.pixels_per_mm_y, 2),
                    "pixels_per_mV": round(dig_res.calibration.pixels_per_mV, 2),
                    "pixels_per_sec": round(dig_res.calibration.pixels_per_sec, 2),
                    "skew_angle_deg": dig_res.calibration.skew_angle_deg,
                    "is_deskewed": dig_res.calibration.is_deskewed,
                    "clahe_applied": dig_res.calibration.clahe_applied,
                    "vector_elements_detected": dig_res.calibration.vector_elements_detected,
                    "warning": dig_res.calibration.warning,
                },
                "missing_leads": dig_res.missing_leads,
                "leads": leads_summary,
                "rhythm_strip": rhythm_summary,
                "issues": dig_res.issues,
            }

            result["cardiac_intervals"] = dig_res.cardiac_intervals
            result["vendor_detected"] = dig_res.vendor_detected
            result["is_simultaneous_12_lead"] = dig_res.is_simultaneous_12_lead
            result["success"] = dig_res.success

            # CLINICAL GUARDRAIL (Path B): Automated CNN classification blocked for printouts
            result["status"] = "digitization_complete_cnn_blocked"
            result["classification"] = None
            result["clinical_notice"] = (
                f"CLINICAL GUARDRAIL (Path B): Digitization complete for '{dig_res.layout_detected}'. "
                "The 1D CNN model was trained exclusively on continuous 10-second digital recordings (PTB-XL). "
                "Direct CNN classification of short-segment printout waveforms is clinically unvalidated. "
                "Automated CNN classification has been intentionally blocked to preserve patient safety. "
                "Extracted lead waveforms, physiological cardiac intervals, and the continuous 10s rhythm strip "
                "are preserved for doctor visual review and verification."
            )

            # Optional override for research investigation only
            if allow_experimental_short_cnn and dig_res.signal_matrix is not None:
                experimental_clf = predict_ecg_cnn(dig_res.signal_matrix, model_name=model_name)
                experimental_clf["experimental_warning"] = (
                    "UNVALIDATED RESEARCH ONLY: Evaluated 2.5s signal on 10s model. "
                    "Do not use for clinical patient decisions."
                )
                result["classification"] = experimental_clf
                result["status"] = "experimental_unvalidated_research_inference"

            return result

        else:
            raise ValueError(f"Unknown format: {fmt}")

    except Exception as e:
        logger.error(f"ECG analysis failed: {e}")
        result["error"] = str(e)
        result["status"] = "failed"
        result["success"] = False

    return result


def save_analysis_result(result: dict, patient_id: str = "", visit_id: str = "") -> Path:
    """Save structured analysis result to outputs/ JSON for patient visit record."""
    from datetime import datetime
    out = {
        "timestamp": datetime.now().isoformat(),
        "patient_id": patient_id,
        "visit_id": visit_id,
        **result,
    }
    out = _make_json_safe(out)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = OUT / f"ecg_analysis_{patient_id or 'unknown'}_{ts}.json"
    path.write_text(json.dumps(out, indent=2))
    logger.info(f"Analysis saved to {path}")
    return path


def _make_json_safe(obj):
    if isinstance(obj, dict):
        return {k: _make_json_safe(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_make_json_safe(v) for v in obj]
    elif isinstance(obj, (np.integer, int)):
        return int(obj)
    elif isinstance(obj, (np.floating, float)):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj
