"""ECG signal validation module for 12-lead ECG quality assurance.

This module validates 12-lead ECG signals before they are passed to
classification models (e.g. NORM vs MI).  It ensures signals meet minimum
quality standards whether they originate from WFDB files (PTB-XL) or from
PDF / image digitisation pipelines.

Validation stages
-----------------
1. **Signal-level** – shape, length, presence of all leads.
2. **Per-lead quality** – amplitude range, flatline detection, noise level.
3. **Physiological plausibility** – heart-rate bounds, QRS detectability,
   amplitude within physiological range.
4. **Master validation** – aggregates all stages into a single report with a
   composite quality score (0–100).

Standard 12-lead order
    I, II, III, aVR, aVL, aVF, V1, V2, V3, V4, V5, V6
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

import numpy as np
from numpy.typing import NDArray
from scipy.signal import find_peaks

from .config import DATA, MODELS  # noqa: F401 – keep config import per project convention

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

LEADS: List[str] = [
    "I", "II", "III", "aVR", "aVL", "aVF",
    "V1", "V2", "V3", "V4", "V5", "V6",
]
"""Standard 12-lead ECG labels in canonical order."""

_NUM_LEADS: int = len(LEADS)

# Physiological amplitude bounds (mV).  Typical surface ECG amplitudes
# rarely exceed ±5 mV; most QRS complexes are within ±3 mV.
_PHYSIO_AMP_MIN_MV: float = -5.0
_PHYSIO_AMP_MAX_MV: float = 5.0

# Heart-rate plausibility window (bpm).
_HR_MIN_BPM: float = 20.0
_HR_MAX_BPM: float = 300.0

# Minimum number of samples (supports standard 2.5-second hospital printouts @ 100 Hz).
_MIN_SAMPLES: int = 200

# Flatline: consecutive identical samples exceeding this fraction of total
# signal length are flagged.
_FLATLINE_THRESHOLD_PCT: float = 10.0

# Noise: ratio of high-frequency power to total power.  A simple proxy is
# the standard deviation of the first-difference signal relative to the
# signal's own standard deviation.
_NOISE_THRESHOLD: float = 0.8

# Lead amplitude range below this value (mV) is suspicious (flat / dead lead).
_MIN_AMPLITUDE_RANGE_MV: float = 0.05

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 1. Signal-level validation
# ---------------------------------------------------------------------------


def validate_12_lead_signal(signal: NDArray[np.floating]) -> Dict[str, Any]:
    """Validate the overall shape and completeness of a 12-lead ECG signal.

    The function checks that the input array has the expected shape
    ``(N, 12)`` with ``N >= 500``, that all 12 leads are present, and that
    no lead is entirely NaN.

    Parameters
    ----------
    signal : np.ndarray
        ECG signal array.  Expected shape ``(N, 12)`` where *N* is the
        number of time-domain samples and each column corresponds to one
        of the standard 12 leads.

    Returns
    -------
    dict
        Validation result with keys:

        * ``valid`` (*bool*) – ``True`` if all checks pass.
        * ``issues`` (*list[str]*) – Human-readable list of problems found.
        * ``shape`` (*tuple*) – Actual shape of the input array.
        * ``duration_sec`` (*float*) – Estimated duration assuming 100 Hz
          sampling rate (``N / 100``).  Set to ``0.0`` when the shape is
          invalid.

    Examples
    --------
    >>> import numpy as np
    >>> sig = np.random.randn(1000, 12)
    >>> result = validate_12_lead_signal(sig)
    >>> result["valid"]
    True
    """
    issues: List[str] = []

    # --- Ensure numpy array ---
    try:
        signal = np.asarray(signal, dtype=float)
    except (ValueError, TypeError) as exc:
        logger.error("Cannot cast input to numpy array: %s", exc)
        return {
            "valid": False,
            "issues": [f"Input cannot be converted to a numeric numpy array: {exc}"],
            "shape": (),
            "duration_sec": 0.0,
        }

    shape: Tuple[int, ...] = signal.shape

    # --- Dimensionality ---
    if signal.ndim != 2:
        issues.append(
            f"Expected 2-D array with shape (N, 12), got {signal.ndim}-D array "
            f"with shape {shape}."
        )
        return {
            "valid": False,
            "issues": issues,
            "shape": shape,
            "duration_sec": 0.0,
        }

    n_samples, n_leads = shape

    # --- Number of leads ---
    if n_leads != _NUM_LEADS:
        issues.append(
            f"Expected 12 leads (columns), got {n_leads}."
        )

    # --- Minimum sample count ---
    if n_samples < _MIN_SAMPLES:
        issues.append(
            f"Signal length {n_samples} samples is below the minimum "
            f"of {_MIN_SAMPLES} samples."
        )

    # --- All-NaN leads ---
    if n_leads == _NUM_LEADS:
        for idx, lead_name in enumerate(LEADS):
            if np.all(np.isnan(signal[:, idx])):
                issues.append(f"Lead {lead_name} (index {idx}) is entirely NaN.")

    duration_sec: float = float(n_samples / 100.0) if n_leads == _NUM_LEADS else 0.0

    valid: bool = len(issues) == 0
    if not valid:
        logger.warning("12-lead signal validation failed: %s", issues)

    return {
        "valid": valid,
        "issues": issues,
        "shape": shape,
        "duration_sec": duration_sec,
    }


# ---------------------------------------------------------------------------
# 2. Per-lead quality
# ---------------------------------------------------------------------------


def check_lead_quality(
    signal: NDArray[np.floating],
    lead_idx: int,
    fs: int = 100,
) -> Dict[str, Any]:
    """Assess the quality of a single ECG lead.

    The function evaluates three quality dimensions for the lead at
    ``signal[:, lead_idx]``:

    * **Amplitude range** – the peak-to-peak span in millivolts.  Very
      small ranges indicate a dead or disconnected lead.
    * **Flatline percentage** – the proportion of consecutive identical
      samples.  High percentages may indicate lead-off or digitisation
      artefacts.
    * **Noise level** – estimated as the ratio of the standard deviation of
      the first-order difference to the standard deviation of the raw
      signal.  Values close to or above 1.0 suggest significant
      high-frequency noise.

    Parameters
    ----------
    signal : np.ndarray
        ECG signal array of shape ``(N, 12)``.
    lead_idx : int
        Column index (0–11) of the lead to check.
    fs : int, optional
        Sampling frequency in Hz (default 100).

    Returns
    -------
    dict
        Per-lead quality report:

        * ``lead`` (*str*) – Lead name (e.g. ``"II"``).
        * ``valid`` (*bool*) – ``True`` if the lead passes all quality checks.
        * ``amplitude_range_mV`` (*float*) – Peak-to-peak amplitude.
        * ``flatline_pct`` (*float*) – Percentage of signal classified as
          flatline.
        * ``noise_level`` (*float*) – Noise ratio estimate.
        * ``issues`` (*list[str]*) – Descriptions of any problems detected.
    """
    issues: List[str] = []
    lead_name: str = LEADS[lead_idx] if 0 <= lead_idx < _NUM_LEADS else f"unknown({lead_idx})"

    # --- Extract lead and sanitise ---
    try:
        lead_signal: NDArray[np.floating] = np.asarray(signal[:, lead_idx], dtype=float)
    except (IndexError, TypeError) as exc:
        logger.error("Cannot extract lead %s: %s", lead_name, exc)
        return {
            "lead": lead_name,
            "valid": False,
            "amplitude_range_mV": 0.0,
            "flatline_pct": 100.0,
            "noise_level": 0.0,
            "issues": [f"Cannot extract lead data: {exc}"],
        }

    n_samples = len(lead_signal)
    if n_samples == 0:
        return {
            "lead": lead_name,
            "valid": False,
            "amplitude_range_mV": 0.0,
            "flatline_pct": 100.0,
            "noise_level": 0.0,
            "issues": ["Lead signal has zero length."],
        }

    # Replace NaNs with 0 for computation but flag them.
    nan_mask = np.isnan(lead_signal)
    nan_pct = float(nan_mask.sum() / n_samples * 100.0)
    if nan_pct > 0:
        issues.append(f"{nan_pct:.1f}% of samples are NaN.")
    lead_clean = np.nan_to_num(lead_signal, nan=0.0)

    # --- Amplitude range ---
    amp_min = float(np.min(lead_clean))
    amp_max = float(np.max(lead_clean))
    amplitude_range_mV = amp_max - amp_min

    if amplitude_range_mV < _MIN_AMPLITUDE_RANGE_MV:
        issues.append(
            f"Amplitude range ({amplitude_range_mV:.4f} mV) is below the "
            f"minimum threshold of {_MIN_AMPLITUDE_RANGE_MV} mV – possible "
            f"dead or disconnected lead."
        )

    # --- Flatline detection ---
    # Count runs of consecutive identical values.
    if n_samples >= 2:
        diffs = np.diff(lead_clean)
        is_flat = diffs == 0.0
        flatline_samples = int(np.sum(is_flat))
        flatline_pct = float(flatline_samples / (n_samples - 1) * 100.0)
    else:
        flatline_pct = 0.0

    if flatline_pct > _FLATLINE_THRESHOLD_PCT:
        issues.append(
            f"Flatline detected in {flatline_pct:.1f}% of adjacent sample "
            f"pairs (threshold: {_FLATLINE_THRESHOLD_PCT}%)."
        )

    # --- Noise level ---
    sig_std = float(np.std(lead_clean))
    if sig_std > 1e-9:
        diff_std = float(np.std(np.diff(lead_clean)))
        noise_level = diff_std / sig_std
    else:
        # Constant signal – no noise but also no useful content.
        noise_level = 0.0

    if noise_level > _NOISE_THRESHOLD:
        issues.append(
            f"High noise level ({noise_level:.3f}) exceeds threshold "
            f"({_NOISE_THRESHOLD})."
        )

    valid = len(issues) == 0

    if not valid:
        logger.debug("Lead %s quality issues: %s", lead_name, issues)

    return {
        "lead": lead_name,
        "valid": valid,
        "amplitude_range_mV": round(amplitude_range_mV, 4),
        "flatline_pct": round(flatline_pct, 2),
        "noise_level": round(noise_level, 4),
        "issues": issues,
    }


# ---------------------------------------------------------------------------
# 3. All-lead validation
# ---------------------------------------------------------------------------


def validate_all_leads(
    signal: NDArray[np.floating],
    fs: int = 100,
) -> Dict[str, Any]:
    """Run :func:`check_lead_quality` on every lead and aggregate results.

    Parameters
    ----------
    signal : np.ndarray
        ECG signal array of shape ``(N, 12)``.
    fs : int, optional
        Sampling frequency in Hz (default 100).

    Returns
    -------
    dict
        Summary report:

        * ``overall_valid`` (*bool*) – ``True`` when **all** 12 leads pass.
        * ``num_valid_leads`` (*int*) – Count of leads that passed quality
          checks.
        * ``num_invalid_leads`` (*int*) – Count of leads that failed.
        * ``per_lead`` (*list[dict]*) – Individual results from
          :func:`check_lead_quality` for each lead.
        * ``invalid_lead_names`` (*list[str]*) – Names of leads that failed.
    """
    per_lead: List[Dict[str, Any]] = []
    invalid_names: List[str] = []

    # Determine actual number of columns to iterate safely.
    try:
        signal_arr = np.asarray(signal, dtype=float)
    except (ValueError, TypeError) as exc:
        logger.error("Cannot convert signal: %s", exc)
        return {
            "overall_valid": False,
            "num_valid_leads": 0,
            "num_invalid_leads": _NUM_LEADS,
            "per_lead": [],
            "invalid_lead_names": list(LEADS),
        }

    n_cols = signal_arr.shape[1] if signal_arr.ndim == 2 else 0
    n_to_check = min(n_cols, _NUM_LEADS)

    for idx in range(n_to_check):
        result = check_lead_quality(signal_arr, idx, fs=fs)
        per_lead.append(result)
        if not result["valid"]:
            invalid_names.append(result["lead"])

    # If fewer than 12 columns were present, mark missing leads as invalid.
    for idx in range(n_to_check, _NUM_LEADS):
        lead_name = LEADS[idx]
        per_lead.append({
            "lead": lead_name,
            "valid": False,
            "amplitude_range_mV": 0.0,
            "flatline_pct": 100.0,
            "noise_level": 0.0,
            "issues": [f"Lead {lead_name} is missing from the signal."],
        })
        invalid_names.append(lead_name)

    num_valid = sum(1 for r in per_lead if r["valid"])
    overall_valid = num_valid == _NUM_LEADS

    if not overall_valid:
        logger.info(
            "Lead validation: %d / %d leads valid.  Invalid: %s",
            num_valid, _NUM_LEADS, invalid_names,
        )

    return {
        "overall_valid": overall_valid,
        "num_valid_leads": num_valid,
        "num_invalid_leads": _NUM_LEADS - num_valid,
        "per_lead": per_lead,
        "invalid_lead_names": invalid_names,
    }


# ---------------------------------------------------------------------------
# 4. Physiological plausibility
# ---------------------------------------------------------------------------


def check_physiological_plausibility(
    signal: NDArray[np.floating],
    fs: int = 100,
) -> Dict[str, Any]:
    """Check whether the ECG signal is physiologically plausible.

    Three criteria are evaluated:

    1. **Heart rate** – Estimated from R–R intervals on Lead II (index 1).
       Must fall within [20, 300] bpm.
    2. **QRS detectability** – At least 3 R-peaks must be detected for
       reliable rate estimation.
    3. **Amplitude range** – Overall signal amplitudes should lie within
       the physiological range (−5 to +5 mV for surface ECG).

    R-peak detection uses :func:`scipy.signal.find_peaks` with a minimum
    inter-peak distance of ``0.2 × fs`` samples (corresponding to 300 bpm)
    and adaptive prominence.

    Parameters
    ----------
    signal : np.ndarray
        ECG signal array of shape ``(N, 12)``.
    fs : int, optional
        Sampling frequency in Hz (default 100).

    Returns
    -------
    dict
        Plausibility report:

        * ``valid`` (*bool*) – ``True`` if all checks pass.
        * ``issues`` (*list[str]*) – Descriptions of any failed checks.
        * ``estimated_hr_bpm`` (*float | None*) – Mean heart rate if
          detectable, otherwise ``None``.
        * ``num_r_peaks`` (*int*) – Number of detected R-peaks.
        * ``amplitude_in_range`` (*bool*) – Whether peak amplitudes across
          all leads fall within physiological bounds.
        * ``amplitude_min_mV`` (*float*) – Global signal minimum.
        * ``amplitude_max_mV`` (*float*) – Global signal maximum.
    """
    issues: List[str] = []

    try:
        signal_arr = np.asarray(signal, dtype=float)
    except (ValueError, TypeError) as exc:
        logger.error("Cannot convert signal for plausibility check: %s", exc)
        return {
            "valid": False,
            "issues": [f"Input conversion failed: {exc}"],
            "estimated_hr_bpm": None,
            "num_r_peaks": 0,
            "amplitude_in_range": False,
            "amplitude_min_mV": 0.0,
            "amplitude_max_mV": 0.0,
        }

    signal_clean = np.nan_to_num(signal_arr, nan=0.0)

    # --- Amplitude range (global) ---
    amp_min = float(np.min(signal_clean))
    amp_max = float(np.max(signal_clean))
    amplitude_in_range = (_PHYSIO_AMP_MIN_MV <= amp_min) and (amp_max <= _PHYSIO_AMP_MAX_MV)

    if not amplitude_in_range:
        issues.append(
            f"Signal amplitude [{amp_min:.2f}, {amp_max:.2f}] mV exceeds "
            f"physiological range [{_PHYSIO_AMP_MIN_MV}, {_PHYSIO_AMP_MAX_MV}] mV."
        )

    # --- R-peak detection on Lead II (index 1) ---
    # Fall back to Lead I (index 0) if Lead II is unavailable or flat.
    if signal_clean.ndim == 2 and signal_clean.shape[1] >= 2:
        ref_lead = signal_clean[:, 1]
        if np.std(ref_lead) < 1e-9 and signal_clean.shape[1] >= 1:
            ref_lead = signal_clean[:, 0]
    elif signal_clean.ndim == 2 and signal_clean.shape[1] >= 1:
        ref_lead = signal_clean[:, 0]
    else:
        ref_lead = signal_clean.ravel() if signal_clean.size > 0 else np.array([])

    estimated_hr: float | None = None
    num_r_peaks: int = 0

    if len(ref_lead) >= _MIN_SAMPLES:
        # Adaptive prominence: fraction of the signal's standard deviation.
        prominence = max(0.3 * float(np.std(ref_lead)), 1e-6)
        min_distance = max(int(0.2 * fs), 1)  # 300 bpm ceiling

        peaks, _ = find_peaks(
            ref_lead,
            distance=min_distance,
            prominence=prominence,
        )
        num_r_peaks = len(peaks)

        required_peaks = 2 if len(ref_lead) < 500 else 3
        if num_r_peaks >= required_peaks:
            rr_intervals = np.diff(peaks) / fs  # seconds
            mean_rr = float(np.mean(rr_intervals))
            if mean_rr > 0:
                estimated_hr = 60.0 / mean_rr

                if estimated_hr < _HR_MIN_BPM or estimated_hr > _HR_MAX_BPM:
                    issues.append(
                        f"Estimated heart rate ({estimated_hr:.1f} bpm) is outside "
                        f"the plausible range [{_HR_MIN_BPM}, {_HR_MAX_BPM}] bpm."
                    )
        else:
            issues.append(
                f"Only {num_r_peaks} R-peak(s) detected (minimum {required_peaks} required "
                f"for reliable heart-rate estimation).  Signal may be too "
                f"short, too noisy, or non-cardiac."
            )
    else:
        issues.append(
            f"Reference lead has {len(ref_lead)} samples, fewer than the "
            f"minimum {_MIN_SAMPLES} required for QRS detection."
        )

    valid = len(issues) == 0

    if not valid:
        logger.info("Physiological plausibility issues: %s", issues)

    return {
        "valid": valid,
        "issues": issues,
        "estimated_hr_bpm": round(estimated_hr, 1) if estimated_hr is not None else None,
        "num_r_peaks": num_r_peaks,
        "amplitude_in_range": amplitude_in_range,
        "amplitude_min_mV": round(amp_min, 4),
        "amplitude_max_mV": round(amp_max, 4),
    }


# ---------------------------------------------------------------------------
# 5. Master validation
# ---------------------------------------------------------------------------


def _compute_quality_score(
    sig_result: Dict[str, Any],
    lead_result: Dict[str, Any],
    physio_result: Dict[str, Any],
) -> float:
    """Compute a composite quality score in [0, 100].

    Scoring breakdown (weights chosen heuristically):

    * **Signal structure** (30 pts) – passes shape / length / NaN checks.
    * **Lead quality** (40 pts) – proportional to the number of valid leads
      (each lead worth 40/12 ≈ 3.33 pts).
    * **Physiological plausibility** (30 pts):
        - Heart rate detectable & in range: 15 pts
        - Amplitude within physiological bounds: 15 pts

    Parameters
    ----------
    sig_result : dict
        Output of :func:`validate_12_lead_signal`.
    lead_result : dict
        Output of :func:`validate_all_leads`.
    physio_result : dict
        Output of :func:`check_physiological_plausibility`.

    Returns
    -------
    float
        Quality score between 0 and 100.
    """
    score = 0.0

    # Signal structure: 30 pts
    if sig_result.get("valid", False):
        score += 30.0

    # Lead quality: 40 pts, proportional to valid leads
    num_valid = lead_result.get("num_valid_leads", 0)
    score += (num_valid / _NUM_LEADS) * 40.0

    # Physiological plausibility: 30 pts
    if physio_result.get("estimated_hr_bpm") is not None:
        hr = physio_result["estimated_hr_bpm"]
        if _HR_MIN_BPM <= hr <= _HR_MAX_BPM:
            score += 15.0
        else:
            # Partial credit if HR is detectable but out of range.
            score += 5.0

    if physio_result.get("amplitude_in_range", False):
        score += 15.0

    return round(min(max(score, 0.0), 100.0), 1)


def validate_ecg_for_classification(
    signal: NDArray[np.floating],
    fs: int = 100,
) -> Dict[str, Any]:
    """Master validation: run all checks and produce a classification-readiness report.

    This is the primary entry point for ECG quality gating before feeding
    signals into diagnostic classifiers (e.g. NORM vs MI).  It orchestrates
    all sub-validations and computes a composite quality score.

    Parameters
    ----------
    signal : np.ndarray
        ECG signal array, expected shape ``(N, 12)``.
    fs : int, optional
        Sampling frequency in Hz (default 100).

    Returns
    -------
    dict
        Comprehensive validation report:

        * ``overall_valid`` (*bool*) – ``True`` only if **all** sub-checks pass.
        * ``quality_score`` (*float*) – Composite score between 0 and 100.
          A score ≥ 80 is recommended before classification; scores below 50
          should trigger manual review.
        * ``signal_validation`` (*dict*) – Output of
          :func:`validate_12_lead_signal`.
        * ``lead_validation`` (*dict*) – Output of :func:`validate_all_leads`.
        * ``physiological_validation`` (*dict*) – Output of
          :func:`check_physiological_plausibility`.
        * ``all_issues`` (*list[str]*) – Flattened list of every issue
          found across all checks.

    Examples
    --------
    >>> import numpy as np
    >>> sig = np.random.randn(1000, 12) * 0.5
    >>> report = validate_ecg_for_classification(sig, fs=100)
    >>> report["quality_score"] > 0
    True
    """
    logger.info("Running master ECG validation (fs=%d Hz).", fs)

    sig_result = validate_12_lead_signal(signal)
    lead_result = validate_all_leads(signal, fs=fs)
    physio_result = check_physiological_plausibility(signal, fs=fs)

    # Aggregate all issues.
    all_issues: List[str] = list(sig_result.get("issues", []))
    all_issues.extend(lead_result.get("invalid_lead_names", []))
    for lead_report in lead_result.get("per_lead", []):
        all_issues.extend(lead_report.get("issues", []))
    all_issues.extend(physio_result.get("issues", []))
    # De-duplicate while preserving order.
    seen: set[str] = set()
    unique_issues: List[str] = []
    for issue in all_issues:
        if issue not in seen:
            seen.add(issue)
            unique_issues.append(issue)

    overall_valid: bool = (
        sig_result.get("valid", False)
        and lead_result.get("overall_valid", False)
        and physio_result.get("valid", False)
    )

    quality_score = _compute_quality_score(sig_result, lead_result, physio_result)

    if overall_valid:
        logger.info("ECG validation PASSED.  Quality score: %.1f / 100.", quality_score)
    else:
        logger.warning(
            "ECG validation FAILED.  Quality score: %.1f / 100.  Issues: %s",
            quality_score,
            unique_issues,
        )

    return {
        "overall_valid": overall_valid,
        "quality_score": quality_score,
        "signal_validation": sig_result,
        "lead_validation": lead_result,
        "physiological_validation": physio_result,
        "all_issues": unique_issues,
    }
