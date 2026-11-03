"""ECG signal preprocessing pipeline for 12-lead ECG data.

This module provides a complete preprocessing pipeline for 12-lead ECG signals
before they are fed into the CNN classifier. It is designed to work identically
for both digital ECG inputs (WFDB / PTB-XL records100 at 100 Hz) and signals
reconstructed from PDF/image digitisation, ensuring that the model receives
signals in a consistent, clean format regardless of the acquisition source.

Pipeline stages (executed by :func:`preprocess_ecg`):
    1. **Validation** – reject signals with NaN values, flat-line channels,
       or extreme amplitudes.
    2. **Resampling** – convert any native sampling rate to the 100 Hz target.
    3. **Filtering** – bandpass (0.5–40 Hz), baseline-wander removal (median
       filter), and power-line notch filter (50/60 Hz).
    4. **Normalisation** – per-channel z-score normalisation using training
       statistics saved alongside the model weights.

Signal shape convention
-----------------------
All functions expect and return arrays of shape ``(num_samples, 12)`` where
the 12 columns correspond to the standard leads in the order:
``I, II, III, aVR, aVL, aVF, V1, V2, V3, V4, V5, V6``.

Dependencies
------------
- numpy
- scipy (signal processing)
- json (serialisation of normalisation parameters)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
from numpy.typing import NDArray
from scipy.signal import (
    butter,
    filtfilt,
    iirnotch,
    medfilt,
    resample_poly,
)

from .config import MODELS

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)

LEADS: List[str] = [
    "I", "II", "III", "aVR", "aVL", "aVF",
    "V1", "V2", "V3", "V4", "V5", "V6",
]
"""Standard 12-lead order used throughout the project."""

NUM_LEADS: int = 12
"""Expected number of ECG leads."""

TARGET_FS: int = 100
"""Target sampling frequency in Hz (PTB-XL records100)."""

DEFAULT_NORM_FILENAME: str = "ecg_norm_params.json"
"""Default file name for persisted normalisation parameters."""

# Physiological amplitude limits (mV) – used in quality assessment.
# A typical QRS complex rarely exceeds ±5 mV; values beyond ±10 mV almost
# certainly indicate artefact or a unit-conversion error.
_AMP_WARN_MV: float = 5.0
_AMP_REJECT_MV: float = 20.0

# Minimum signal duration (in samples at target fs) considered usable.
_MIN_SAMPLES: int = 50  # 0.5 s at 100 Hz

# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------


def bandpass_filter(
    signal: NDArray[np.floating],
    fs: float,
    lowcut: float = 0.5,
    highcut: float = 40.0,
    order: int = 4,
) -> NDArray[np.floating]:
    """Apply a zero-phase Butterworth bandpass filter to a multi-lead ECG.

    The bandpass removes DC offset and slow baseline drift (< *lowcut* Hz)
    as well as high-frequency noise and EMG artefact (> *highcut* Hz).  A
    fourth-order Butterworth is a good balance between roll-off steepness
    and minimal ringing in the time domain.

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        Raw ECG signal.  Each column is one lead.
    fs : float
        Sampling frequency in Hz.
    lowcut : float, optional
        Lower cut-off frequency in Hz (default 0.5).
    highcut : float, optional
        Upper cut-off frequency in Hz (default 40.0).
    order : int, optional
        Butterworth filter order (default 4).

    Returns
    -------
    ndarray, shape ``(N, 12)``
        Bandpass-filtered signal.

    Raises
    ------
    ValueError
        If *lowcut* ≥ *highcut* or *highcut* ≥ Nyquist frequency.

    Notes
    -----
    ``scipy.signal.filtfilt`` is used to achieve zero phase distortion by
    applying the filter forwards and backwards.  Padding is handled
    internally by ``filtfilt`` using the ``padtype='odd'`` default.
    """
    nyquist = fs / 2.0
    if lowcut >= highcut:
        raise ValueError(
            f"lowcut ({lowcut}) must be less than highcut ({highcut})."
        )
    if highcut >= nyquist:
        raise ValueError(
            f"highcut ({highcut} Hz) must be below Nyquist ({nyquist} Hz)."
        )

    signal = np.asarray(signal, dtype=np.float64)
    _validate_shape(signal)

    b, a = butter(order, [lowcut / nyquist, highcut / nyquist], btype="band")

    # filtfilt requires padlen < signal length; for very short signals we
    # reduce padlen to avoid errors.
    default_padlen = 3 * max(len(b), len(a))
    padlen = min(default_padlen, signal.shape[0] - 1)
    if padlen < 1:
        logger.warning(
            "Signal too short (%d samples) for bandpass filter – returning unfiltered.",
            signal.shape[0],
        )
        return signal

    filtered = np.empty_like(signal)
    for ch in range(signal.shape[1]):
        filtered[:, ch] = filtfilt(b, a, signal[:, ch], padlen=padlen)

    logger.debug(
        "Bandpass filter applied: %.1f–%.1f Hz, order %d, fs=%.1f Hz.",
        lowcut, highcut, order, fs,
    )
    return filtered


def remove_baseline_wander(
    signal: NDArray[np.floating],
    fs: float,
    window_sec: float = 0.6,
) -> NDArray[np.floating]:
    """Remove baseline wander using a two-pass median filter.

    Baseline wander is a low-frequency artefact (< 0.5 Hz) caused by
    respiration, patient movement, and electrode impedance changes.  This
    implementation follows the approach described by de Chazal *et al.*
    (2004): the baseline is estimated with a median filter whose window is
    set to approximately one cardiac cycle (~0.6 s) and then subtracted.

    A second, longer median filter (2× the first window) smooths residual
    step-like transitions introduced by the first pass.

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        ECG signal.
    fs : float
        Sampling frequency in Hz.
    window_sec : float, optional
        Window size in seconds for the first median-filter pass
        (default 0.6 s ≈ one cardiac cycle at rest).

    Returns
    -------
    ndarray, shape ``(N, 12)``
        Signal with baseline wander removed.
    """
    signal = np.asarray(signal, dtype=np.float64)
    _validate_shape(signal)

    # Median filter kernel must be odd.
    kernel_1 = int(round(window_sec * fs))
    kernel_1 = kernel_1 if kernel_1 % 2 == 1 else kernel_1 + 1
    kernel_1 = max(kernel_1, 3)  # scipy requires kernel_size >= 3

    kernel_2 = int(round(2.0 * window_sec * fs))
    kernel_2 = kernel_2 if kernel_2 % 2 == 1 else kernel_2 + 1
    kernel_2 = max(kernel_2, 3)

    corrected = np.empty_like(signal)
    for ch in range(signal.shape[1]):
        baseline = medfilt(signal[:, ch], kernel_size=kernel_1)
        baseline = medfilt(baseline, kernel_size=kernel_2)
        corrected[:, ch] = signal[:, ch] - baseline

    logger.debug(
        "Baseline wander removed (window=%.2f s, kernels=%d/%d at fs=%.1f Hz).",
        window_sec, kernel_1, kernel_2, fs,
    )
    return corrected


def notch_filter(
    signal: NDArray[np.floating],
    fs: float,
    freq: float = 50.0,
    Q: float = 30.0,
) -> NDArray[np.floating]:
    """Remove power-line interference with a zero-phase IIR notch filter.

    Power-line noise manifests as a narrow spectral peak at 50 Hz (Europe,
    Asia, Africa) or 60 Hz (Americas).  A second-order IIR notch filter
    with quality factor *Q* ≈ 30 is narrow enough to suppress the
    interference without distorting adjacent ECG spectral content.

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        ECG signal.
    fs : float
        Sampling frequency in Hz.
    freq : float, optional
        Notch frequency in Hz (default 50.0).
    Q : float, optional
        Quality factor – higher values give a narrower notch (default 30.0).

    Returns
    -------
    ndarray, shape ``(N, 12)``
        Signal with power-line noise suppressed.

    Notes
    -----
    If *freq* ≥ Nyquist the filter cannot be designed, so the original
    signal is returned unchanged with a warning.
    """
    signal = np.asarray(signal, dtype=np.float64)
    _validate_shape(signal)

    nyquist = fs / 2.0
    if freq >= nyquist:
        logger.warning(
            "Notch frequency (%.1f Hz) >= Nyquist (%.1f Hz) – skipping notch filter.",
            freq, nyquist,
        )
        return signal

    b, a = iirnotch(freq, Q, fs)

    default_padlen = 3 * max(len(b), len(a))
    padlen = min(default_padlen, signal.shape[0] - 1)
    if padlen < 1:
        logger.warning(
            "Signal too short (%d samples) for notch filter – returning unfiltered.",
            signal.shape[0],
        )
        return signal

    filtered = np.empty_like(signal)
    for ch in range(signal.shape[1]):
        filtered[:, ch] = filtfilt(b, a, signal[:, ch], padlen=padlen)

    logger.debug("Notch filter applied: %.1f Hz, Q=%.1f, fs=%.1f Hz.", freq, Q, fs)
    return filtered


# ---------------------------------------------------------------------------
# Resampling
# ---------------------------------------------------------------------------


def resample_signal(
    signal: NDArray[np.floating],
    orig_fs: float,
    target_fs: float = 100.0,
) -> NDArray[np.floating]:
    """Resample a multi-lead ECG to *target_fs* using polyphase filtering.

    This is essential when mixing data acquired at different sampling rates
    (e.g. PTB-XL records500 at 500 Hz, or a digitised ECG image at an
    arbitrary rate) so that the downstream CNN always receives a consistent
    temporal resolution.

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        ECG signal at original sampling rate.
    orig_fs : float
        Original sampling rate in Hz.
    target_fs : float, optional
        Desired sampling rate in Hz (default 100).

    Returns
    -------
    ndarray, shape ``(M, 12)``
        Resampled signal, where ``M ≈ N * target_fs / orig_fs``.

    Notes
    -----
    ``scipy.signal.resample_poly`` is preferred over ``scipy.signal.resample``
    because the polyphase approach preserves signal morphology better for
    integer-ratio resampling and is more efficient.

    For non-integer ratios the function finds the closest rational
    approximation ``up / down`` using :func:`_rational_approx`.
    """
    signal = np.asarray(signal, dtype=np.float64)
    _validate_shape(signal)

    if abs(orig_fs - target_fs) < 1e-6:
        logger.debug("Sampling rates equal (%.1f Hz) – no resampling needed.", orig_fs)
        return signal

    up, down = _rational_approx(target_fs, orig_fs)

    resampled = np.empty(
        (int(np.round(signal.shape[0] * up / down)), signal.shape[1]),
        dtype=signal.dtype,
    )
    for ch in range(signal.shape[1]):
        resampled[:, ch] = resample_poly(signal[:, ch], up, down)

    logger.info(
        "Resampled ECG: %.1f → %.1f Hz (up=%d, down=%d), %d → %d samples.",
        orig_fs, target_fs, up, down, signal.shape[0], resampled.shape[0],
    )
    return resampled


def _rational_approx(p: float, q: float, max_denominator: int = 1000) -> Tuple[int, int]:
    """Return integers ``(up, down)`` such that ``up/down ≈ p/q``.

    Uses the standard continued-fraction algorithm capped at
    *max_denominator* to keep the polyphase filter tractable.
    """
    from fractions import Fraction

    frac = Fraction(p / q).limit_denominator(max_denominator)
    return frac.numerator, frac.denominator


# ---------------------------------------------------------------------------
# Signal quality assessment
# ---------------------------------------------------------------------------


def check_signal_quality(
    signal: NDArray[np.floating],
    fs: float = 100.0,
) -> Dict[str, Any]:
    """Assess the quality of a 12-lead ECG signal.

    The function runs a series of heuristic checks and returns a summary
    dictionary.  Downstream code can use the ``valid`` flag to decide
    whether to proceed with classification or request a re-acquisition.

    Checks performed
    ~~~~~~~~~~~~~~~~
    1. **NaN / Inf** – any non-finite value fails the signal immediately.
    2. **Flat lines** – channels whose standard deviation is < 1 µV
       (≈ 0.001 mV) are flagged; if *all* 12 leads are flat the signal
       is rejected.
    3. **Extreme amplitudes** – absolute values > ``_AMP_REJECT_MV``
       (20 mV) suggest a unit-conversion error or clipping artefact.
    4. **Duration** – signals shorter than ``_MIN_SAMPLES`` (50 samples ≈
       0.5 s at 100 Hz) are too short for reliable analysis.

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        ECG signal (assumed to be in millivolts).
    fs : float, optional
        Sampling frequency in Hz (default 100).

    Returns
    -------
    dict
        ``valid`` : bool
            ``True`` if the signal passes all critical checks.
        ``issues`` : list[str]
            Human-readable descriptions of each detected issue.
        ``quality_score`` : float
            Score in [0, 1] where 1 = perfect.  The score is a simple
            weighted count of checks passed (not a calibrated metric).
    """
    signal = np.asarray(signal, dtype=np.float64)

    issues: List[str] = []
    checks_passed: int = 0
    total_checks: int = 5  # NaN, flat-all, flat-partial, amplitude, duration

    # --- Shape sanity ---
    if signal.ndim != 2 or signal.shape[1] != NUM_LEADS:
        issues.append(
            f"Unexpected shape {signal.shape}; expected (N, {NUM_LEADS})."
        )
        return {"valid": False, "issues": issues, "quality_score": 0.0}

    n_samples = signal.shape[0]

    # 1. NaN / Inf
    if np.any(~np.isfinite(signal)):
        nan_count = int(np.sum(~np.isfinite(signal)))
        issues.append(
            f"Signal contains {nan_count} non-finite value(s) (NaN/Inf)."
        )
    else:
        checks_passed += 1

    # 2. Duration
    if n_samples < _MIN_SAMPLES:
        issues.append(
            f"Signal too short: {n_samples} samples "
            f"({n_samples / fs:.2f} s); minimum is {_MIN_SAMPLES} samples "
            f"({_MIN_SAMPLES / fs:.2f} s)."
        )
    else:
        checks_passed += 1

    # 3. Flat lines (per-channel)
    stds = np.nanstd(signal, axis=0)
    flat_threshold = 0.001  # mV
    flat_leads = [LEADS[i] for i in range(NUM_LEADS) if stds[i] < flat_threshold]
    all_flat = len(flat_leads) == NUM_LEADS
    if all_flat:
        issues.append("All 12 leads are flat (zero variance).")
    elif flat_leads:
        issues.append(f"Flat-line detected on lead(s): {', '.join(flat_leads)}.")
        checks_passed += 1  # partial flat is a warning, not a failure
    else:
        checks_passed += 2  # both flat checks pass

    # 4. Extreme amplitudes
    max_abs = float(np.nanmax(np.abs(signal)))
    if max_abs > _AMP_REJECT_MV:
        issues.append(
            f"Extreme amplitude detected: {max_abs:.2f} mV "
            f"(threshold {_AMP_REJECT_MV} mV). Check units."
        )
    elif max_abs > _AMP_WARN_MV:
        issues.append(
            f"High amplitude: {max_abs:.2f} mV (warning threshold {_AMP_WARN_MV} mV)."
        )
        checks_passed += 1  # warning only
    else:
        checks_passed += 1

    # --- Aggregate ---
    quality_score = round(checks_passed / total_checks, 3)

    # A signal is *invalid* if any critical issue is present.
    critical = (
        np.any(~np.isfinite(signal))
        or all_flat
        or n_samples < _MIN_SAMPLES
        or max_abs > _AMP_REJECT_MV
    )
    valid = not critical

    result: Dict[str, Any] = {
        "valid": valid,
        "issues": issues,
        "quality_score": quality_score,
    }

    if not valid:
        logger.warning("Signal quality check FAILED: %s", "; ".join(issues))
    elif issues:
        logger.info("Signal quality check PASSED with warnings: %s", "; ".join(issues))
    else:
        logger.debug("Signal quality check PASSED (score=%.2f).", quality_score)

    return result


# ---------------------------------------------------------------------------
# Normalisation (z-score per channel)
# ---------------------------------------------------------------------------


def save_normalization_params(
    mean: NDArray[np.floating],
    std: NDArray[np.floating],
    path: Union[str, Path, None] = None,
) -> Path:
    """Persist per-channel normalisation statistics to a JSON file.

    The saved parameters allow the exact same z-score transform to be
    applied at inference time, guaranteeing train/test consistency.

    Parameters
    ----------
    mean : ndarray, shape ``(12,)``
        Per-channel mean computed from the training set.
    std : ndarray, shape ``(12,)``
        Per-channel standard deviation computed from the training set.
    path : str or Path, optional
        Destination file path.  Defaults to
        ``<MODELS>/<DEFAULT_NORM_FILENAME>``.

    Returns
    -------
    Path
        Absolute path to the saved file.
    """
    mean = np.asarray(mean, dtype=np.float64).ravel()
    std = np.asarray(std, dtype=np.float64).ravel()

    if mean.shape[0] != NUM_LEADS or std.shape[0] != NUM_LEADS:
        raise ValueError(
            f"mean and std must each have {NUM_LEADS} elements; "
            f"got {mean.shape[0]} and {std.shape[0]}."
        )

    dest = Path(path) if path is not None else MODELS / DEFAULT_NORM_FILENAME
    dest.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "leads": LEADS,
        "mean": mean.tolist(),
        "std": std.tolist(),
    }
    dest.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info("Normalisation parameters saved to %s.", dest)
    return dest


def load_normalization_params(
    path: Union[str, Path, None] = None,
) -> Tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Load per-channel normalisation statistics from a JSON file.

    Parameters
    ----------
    path : str or Path, optional
        Source file.  Defaults to ``<MODELS>/<DEFAULT_NORM_FILENAME>``.

    Returns
    -------
    mean : ndarray, shape ``(12,)``
    std : ndarray, shape ``(12,)``

    Raises
    ------
    FileNotFoundError
        If the parameter file does not exist.
    """
    src = Path(path) if path is not None else MODELS / DEFAULT_NORM_FILENAME
    if not src.exists():
        raise FileNotFoundError(
            f"Normalisation parameter file not found: {src}"
        )

    payload = json.loads(src.read_text(encoding="utf-8"))
    mean = np.asarray(payload["mean"], dtype=np.float64)
    std = np.asarray(payload["std"], dtype=np.float64)

    if mean.shape[0] != NUM_LEADS or std.shape[0] != NUM_LEADS:
        raise ValueError(
            f"Expected {NUM_LEADS} values per statistic in {src}; "
            f"got mean={mean.shape[0]}, std={std.shape[0]}."
        )

    logger.debug("Normalisation parameters loaded from %s.", src)
    return mean, std


def normalize_signal(
    signal: NDArray[np.floating],
    mean: Optional[NDArray[np.floating]] = None,
    std: Optional[NDArray[np.floating]] = None,
) -> NDArray[np.floating]:
    """Apply per-channel z-score normalisation to a 12-lead ECG.

    If *mean* and *std* are ``None`` the statistics are computed directly
    from the input signal (useful during training-set statistics
    computation, but **not recommended** for single-record inference).

    Channels with zero standard deviation are left at zero to avoid
    division-by-zero artefacts.

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        ECG signal.
    mean : ndarray, shape ``(12,)`` or None
        Per-channel mean.  If ``None``, computed from *signal*.
    std : ndarray, shape ``(12,)`` or None
        Per-channel std.  If ``None``, computed from *signal*.

    Returns
    -------
    ndarray, shape ``(N, 12)``
        Normalised signal.
    """
    signal = np.asarray(signal, dtype=np.float64)
    _validate_shape(signal)

    if mean is None:
        mean = signal.mean(axis=0)
        logger.debug("Normalisation mean computed from signal: %s", mean)
    if std is None:
        std = signal.std(axis=0)
        logger.debug("Normalisation std computed from signal: %s", std)

    mean = np.asarray(mean, dtype=np.float64).ravel()
    std = np.asarray(std, dtype=np.float64).ravel()

    # Guard against zero-std channels (e.g. flat leads).
    safe_std = np.where(std > 1e-12, std, 1.0)

    normalised = (signal - mean[np.newaxis, :]) / safe_std[np.newaxis, :]

    # Zero out channels that had zero std to avoid misleading values.
    zero_std_mask = std <= 1e-12
    if np.any(zero_std_mask):
        normalised[:, zero_std_mask] = 0.0
        flat_leads = [LEADS[i] for i, m in enumerate(zero_std_mask) if m]
        logger.warning(
            "Zero-std channels zeroed during normalisation: %s",
            ", ".join(flat_leads),
        )

    return normalised


# ---------------------------------------------------------------------------
# Main preprocessing pipeline
# ---------------------------------------------------------------------------


def preprocess_ecg(
    signal: NDArray[np.floating],
    fs: float = 100.0,
    normalize: bool = True,
    norm_params_path: Optional[Union[str, Path]] = None,
    lowcut: float = 0.5,
    highcut: float = 40.0,
    notch_freq: float = 50.0,
    baseline_window_sec: float = 0.6,
    target_fs: float = 100.0,
) -> NDArray[np.floating]:
    """End-to-end preprocessing pipeline for a single 12-lead ECG record.

    Execution order:

    1. **Validate** – :func:`check_signal_quality` screens for NaN values,
       flat lines, extreme amplitudes, and insufficient duration.  If the
       signal is invalid, non-finite values are replaced with zeros and a
       warning is logged, but processing continues so that callers can
       inspect the result (the quality report is available separately).
    2. **Resample** – :func:`resample_signal` converts to *target_fs* if
       the input sampling rate differs.
    3. **Filter** – sequential application of
       :func:`remove_baseline_wander`, :func:`bandpass_filter`, and
       :func:`notch_filter`.
    4. **Normalise** – :func:`normalize_signal` applies per-channel z-score
       using training-set statistics loaded from *norm_params_path* (if
       provided and the file exists).

    Parameters
    ----------
    signal : ndarray, shape ``(N, 12)``
        Raw ECG signal.
    fs : float, optional
        Sampling frequency of the input signal in Hz (default 100).
    normalize : bool, optional
        Whether to apply z-score normalisation (default ``True``).
    norm_params_path : str, Path, or None
        Path to a JSON file containing ``mean`` and ``std`` arrays.  If
        ``None``, defaults to ``<MODELS>/ecg_norm_params.json``.  If the
        file does not exist, normalisation is computed from the signal
        itself (with a warning).
    lowcut : float, optional
        Bandpass lower cut-off in Hz (default 0.5).
    highcut : float, optional
        Bandpass upper cut-off in Hz (default 40.0).
    notch_freq : float, optional
        Power-line notch frequency in Hz (default 50.0).
    baseline_window_sec : float, optional
        Median-filter window for baseline-wander removal (default 0.6 s).
    target_fs : float, optional
        Target sampling rate after resampling (default 100.0 Hz).

    Returns
    -------
    ndarray, shape ``(M, 12)``
        Preprocessed signal (M = resampled length).

    Examples
    --------
    >>> import numpy as np
    >>> from medis.ecg_preprocessing import preprocess_ecg
    >>> raw = np.random.randn(1000, 12) * 0.5  # 10 s at 100 Hz
    >>> clean = preprocess_ecg(raw, fs=100)
    >>> clean.shape
    (1000, 12)
    """
    signal = np.asarray(signal, dtype=np.float64)
    _validate_shape(signal)

    # ------------------------------------------------------------------
    # 1. Validate
    # ------------------------------------------------------------------
    quality = check_signal_quality(signal, fs=fs)
    if not quality["valid"]:
        logger.warning(
            "Signal failed quality check (%s). Replacing non-finite values "
            "and continuing.",
            "; ".join(quality["issues"]),
        )
        signal = np.nan_to_num(signal, nan=0.0, posinf=0.0, neginf=0.0)

    # ------------------------------------------------------------------
    # 2. Resample (before filtering so filter design matches target fs)
    # ------------------------------------------------------------------
    if abs(fs - target_fs) > 1e-6:
        signal = resample_signal(signal, orig_fs=fs, target_fs=target_fs)
        fs = target_fs  # update effective fs for subsequent filters

    # ------------------------------------------------------------------
    # 3. Filter
    # ------------------------------------------------------------------
    # Order matters: baseline wander first (it is the lowest-frequency
    # component), then bandpass, then notch.
    signal = remove_baseline_wander(signal, fs=fs, window_sec=baseline_window_sec)

    # Only apply bandpass if the signal is long enough and parameters are valid.
    nyquist = fs / 2.0
    if highcut < nyquist and signal.shape[0] > 2 * 4 * 3 + 1:
        signal = bandpass_filter(signal, fs=fs, lowcut=lowcut, highcut=highcut)
    else:
        logger.warning(
            "Bandpass filter skipped (highcut=%.1f Hz, Nyquist=%.1f Hz, "
            "samples=%d).",
            highcut, nyquist, signal.shape[0],
        )

    # Notch filter – only meaningful if fs > 2 * notch_freq.
    if notch_freq < nyquist:
        signal = notch_filter(signal, fs=fs, freq=notch_freq)
    else:
        logger.debug(
            "Notch filter skipped (notch_freq=%.1f Hz >= Nyquist=%.1f Hz).",
            notch_freq, nyquist,
        )

    # ------------------------------------------------------------------
    # 4. Normalise
    # ------------------------------------------------------------------
    if normalize:
        mean, std = None, None
        params_path = (
            Path(norm_params_path) if norm_params_path is not None
            else MODELS / DEFAULT_NORM_FILENAME
        )
        if params_path.exists():
            try:
                mean, std = load_normalization_params(params_path)
                logger.info(
                    "Using saved normalisation parameters from %s.", params_path
                )
            except (json.JSONDecodeError, KeyError, ValueError) as exc:
                logger.warning(
                    "Failed to load normalisation params from %s: %s. "
                    "Falling back to per-signal normalisation.",
                    params_path, exc,
                )
        else:
            logger.info(
                "Normalisation parameter file not found (%s); computing "
                "statistics from the input signal.",
                params_path,
            )
        signal = normalize_signal(signal, mean=mean, std=std)

    logger.info(
        "ECG preprocessing complete. Output shape: %s.", signal.shape
    )
    return signal


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _validate_shape(signal: NDArray) -> None:
    """Raise ``ValueError`` if *signal* does not have the expected shape.

    Parameters
    ----------
    signal : ndarray
        Expected to be 2-D with exactly ``NUM_LEADS`` (12) columns.

    Raises
    ------
    ValueError
        If the shape constraint is violated.
    """
    if signal.ndim != 2:
        raise ValueError(
            f"ECG signal must be 2-D (num_samples, {NUM_LEADS}); "
            f"got {signal.ndim}-D array with shape {signal.shape}."
        )
    if signal.shape[1] != NUM_LEADS:
        raise ValueError(
            f"ECG signal must have {NUM_LEADS} channels (columns); "
            f"got {signal.shape[1]}."
        )
