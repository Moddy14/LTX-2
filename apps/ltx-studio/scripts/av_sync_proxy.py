#!/usr/bin/env python3
"""Checkpoint-free audio/mouth-motion lag measurements.

This module intentionally does not claim phoneme accuracy. It estimates only
whether visible lower-face activity follows audio modulation with a stable lag.
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import numpy as np

METHOD = "classical-audio-mouth-motion.v1"
SAMPLE_RATE = 16_000
WINDOW_SAMPLES = 400
HOP_SAMPLES = 160
MAX_DURATION_SECONDS = 30.0
LAG_LIMIT_SECONDS = 0.5


def finite(value: float | np.floating[object]) -> float | None:
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def robust_unit(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values.astype(np.float64)
    lower, upper = np.percentile(values, [10, 90])
    spread = float(upper - lower)
    if not math.isfinite(spread) or spread <= 1e-9:
        return np.zeros(values.shape, dtype=np.float64)
    return np.clip((values - lower) / spread, 0.0, 3.0).astype(np.float64)


def blank_result(
    status: str,
    error: str | None,
    *,
    sampled_video_frames: int,
    valid_motion_pairs: int = 0,
    motion_coverage: float = 0.0,
    audio_window_count: int = 0,
    audio_activity_ratio: float | None = None,
) -> dict[str, object]:
    return {
        "status": status,
        "error": error,
        "method": METHOD,
        "sampledVideoFrames": sampled_video_frames,
        "validMotionPairs": valid_motion_pairs,
        "motionCoverage": float(np.clip(motion_coverage, 0.0, 1.0)),
        "audioWindowCount": audio_window_count,
        "audioActivityRatio": audio_activity_ratio,
        "usableAudioActivitySeconds": 0.0,
        "mouthCoverageDuringAudioActivity": 0.0,
        "usableWindowCount": 0,
        "estimatedAudioLeadMilliseconds": None,
        "lagSearchLimitMilliseconds": int(round(LAG_LIMIT_SECONDS * 1000)),
        "lagResolutionMilliseconds": None,
        "effectiveVideoSampleMilliseconds": None,
        "correlationPeak": None,
        "zeroLagCorrelation": None,
        "peakProminence": None,
        "peakWidthMilliseconds": None,
        "featureLagAgreementMilliseconds": None,
        "windowLagIqrMilliseconds": None,
        "nullP95Correlation": None,
    }


def stabilized_face_patch(frame: object, landmarks: object) -> np.ndarray | None:
    """Return an eye/nose-aligned grayscale face patch for motion analysis."""

    import cv2

    points = np.asarray(landmarks, dtype=np.float32)
    if points.shape != (5, 2) or not bool(np.isfinite(points).all()):
        return None
    right_eye, left_eye, nose = points[:3]
    eye_span = float(np.linalg.norm(left_eye - right_eye))
    if eye_span < 8:
        return None
    source = np.asarray([right_eye, left_eye, nose], dtype=np.float32)
    target = np.asarray([[28.0, 26.0], [68.0, 26.0], [48.0, 49.0]], dtype=np.float32)
    transform = cv2.getAffineTransform(source, target)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    aligned = cv2.warpAffine(
        gray,
        transform,
        (96, 96),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    if aligned.shape != (96, 96):
        return None
    return cv2.GaussianBlur(aligned, (3, 3), 0).astype(np.uint8)


def motion_series(
    tracked_candidates: list[dict[str, object]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Measure lower-face flow after eye/nose alignment."""

    import cv2

    times: list[float] = []
    flow_motion: list[float] = []
    appearance_motion: list[float] = []
    for left, right in zip(tracked_candidates, tracked_candidates[1:]):
        left_patch = left.get("stabilized_patch")
        right_patch = right.get("stabilized_patch")
        if not isinstance(left_patch, np.ndarray) or not isinstance(right_patch, np.ndarray):
            continue
        left_time = float(left["timestamp"])
        right_time = float(right["timestamp"])
        elapsed = right_time - left_time
        if not 0.005 <= elapsed <= 0.2:
            continue
        flow = cv2.calcOpticalFlowFarneback(
            left_patch,
            right_patch,
            None,
            0.5,
            3,
            15,
            3,
            5,
            1.2,
            0,
        )
        magnitude = np.linalg.norm(flow, axis=2)
        mouth_region = magnitude[53:90, 16:80]
        stable_regions = np.concatenate(
            [
                magnitude[8:22, 20:76].reshape(-1),
                magnitude[34:52, 8:28].reshape(-1),
                magnitude[34:52, 68:88].reshape(-1),
            ]
        )
        residual_flow = max(
            0.0,
            float(np.percentile(mouth_region, 75) - np.median(stable_regions)),
        )
        left_mouth = left_patch[53:90, 16:80].astype(np.float32)
        right_mouth = right_patch[53:90, 16:80].astype(np.float32)
        left_mouth = (left_mouth - float(left_mouth.mean())) / max(float(left_mouth.std()), 1.0)
        right_mouth = (right_mouth - float(right_mouth.mean())) / max(float(right_mouth.std()), 1.0)
        appearance_change = float(np.mean(np.abs(right_mouth - left_mouth)))
        times.append((left_time + right_time) * 0.5)
        flow_motion.append(residual_flow)
        appearance_motion.append(appearance_change)
    return (
        np.asarray(times, dtype=np.float64),
        np.asarray(flow_motion, dtype=np.float64),
        np.asarray(appearance_motion, dtype=np.float64),
    )


def decode_audio_features(
    video_path: Path,
    audio_start_relative_video_seconds: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(video_path),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-t",
        str(MAX_DURATION_SECONDS),
        "-f",
        "s16le",
        "pipe:1",
    ]
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        timeout=40,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace")[-500:]
        raise RuntimeError(f"Audio decode failed: {message}")
    pcm = np.frombuffer(result.stdout, dtype="<i2").astype(np.float64) / 32768.0
    if pcm.size < WINDOW_SAMPLES * 2:
        return (
            np.asarray([], dtype=np.float64),
            np.asarray([], dtype=np.float64),
            np.asarray([], dtype=np.float64),
        )
    window_count = 1 + (pcm.size - WINDOW_SAMPLES) // HOP_SAMPLES
    frames = np.lib.stride_tricks.sliding_window_view(pcm, WINDOW_SAMPLES)[::HOP_SAMPLES]
    frames = frames[:window_count]
    analysis_window = np.hanning(WINDOW_SAMPLES)
    windowed = frames * analysis_window
    rms = np.sqrt(np.mean(windowed**2, axis=1) + 1e-12)
    log_rms = 20.0 * np.log10(rms + 1e-8)
    spectra = np.abs(np.fft.rfft(windowed, axis=1))
    spectra /= np.maximum(np.sum(spectra, axis=1, keepdims=True), 1e-12)
    positive_flux = np.zeros(window_count, dtype=np.float64)
    if window_count > 1:
        positive_flux[1:] = np.sum(np.maximum(spectra[1:] - spectra[:-1], 0.0), axis=1)
    energy_change = np.zeros(window_count, dtype=np.float64)
    if window_count > 1:
        energy_change[1:] = np.abs(np.diff(log_rms))
    onset = robust_unit(positive_flux) * 0.65 + robust_unit(energy_change) * 0.35
    if onset.size >= 3:
        onset = np.convolve(onset, np.ones(3, dtype=np.float64) / 3.0, mode="same")

    noise_floor = float(np.percentile(log_rms, 20))
    high_level = float(np.percentile(log_rms, 95))
    threshold = noise_floor + max(6.0, (high_level - noise_floor) * 0.25)
    speech = (log_rms >= threshold).astype(np.float64)
    if speech.size >= 11:
        speech = (np.convolve(speech, np.ones(11), mode="same") > 0).astype(np.float64)
    times = (
        np.arange(window_count, dtype=np.float64) * HOP_SAMPLES
        + WINDOW_SAMPLES * 0.5
    ) / SAMPLE_RATE + audio_start_relative_video_seconds
    return times, onset.astype(np.float64), speech


def pearson(left: np.ndarray, right: np.ndarray) -> float | None:
    if left.size < 12 or right.size != left.size:
        return None
    left_centered = left - float(left.mean())
    right_centered = right - float(right.mean())
    denominator = float(np.linalg.norm(left_centered) * np.linalg.norm(right_centered))
    if denominator <= 1e-9:
        return None
    return finite(float(np.dot(left_centered, right_centered) / denominator))


def estimate_lag(
    mouth_times: np.ndarray,
    mouth_flow: np.ndarray,
    mouth_appearance: np.ndarray,
    audio_times: np.ndarray,
    audio_onset: np.ndarray,
    audio_activity: np.ndarray,
) -> dict[str, object] | None:
    if mouth_times.size < 24 or audio_times.size < 24:
        return None
    periods = np.diff(mouth_times)
    periods = periods[(periods > 0.005) & (periods <= 0.2)]
    if periods.size < 12:
        return None
    effective_period = float(np.median(periods))
    lag_steps = max(1, int(math.floor(LAG_LIMIT_SECONDS / effective_period)))
    lags = np.arange(-lag_steps, lag_steps + 1, dtype=np.float64) * effective_period
    resolution_ms = max(10, int(math.ceil(effective_period * 1000.0)))
    flow_signal = robust_unit(mouth_flow)
    appearance_signal = robust_unit(mouth_appearance)
    if (
        float(np.percentile(flow_signal, 90) - np.percentile(flow_signal, 10)) < 0.2
        or float(np.percentile(appearance_signal, 90) - np.percentile(appearance_signal, 10)) < 0.2
    ):
        return None

    # Every lag is evaluated on exactly the same mouth samples. Otherwise a lag
    # could win merely because it moves convenient sparse motion into VAD spans.
    audio_hop = float(np.median(np.diff(audio_times)))
    activity_radius = max(1, int(math.ceil(LAG_LIMIT_SECONDS / audio_hop)))
    dilated_activity = (
        np.convolve(
            (audio_activity >= 0.25).astype(np.float64),
            np.ones(activity_radius * 2 + 1, dtype=np.float64),
            mode="same",
        ) > 0
    ).astype(np.float64)
    fixed_support = (
        (mouth_times >= audio_times[0] + LAG_LIMIT_SECONDS)
        & (mouth_times <= audio_times[-1] - LAG_LIMIT_SECONDS)
        & (np.interp(mouth_times, audio_times, dilated_activity) >= 0.25)
    )
    if int(np.count_nonzero(fixed_support)) < 24:
        return None

    def curves(
        onset: np.ndarray,
        support: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        flow_curve = np.full(lags.shape, np.nan, dtype=np.float64)
        appearance_curve = np.full(lags.shape, np.nan, dtype=np.float64)
        for index, lag in enumerate(lags):
            audio_values = np.interp(mouth_times[support] - lag, audio_times, onset)
            flow_value = pearson(flow_signal[support], audio_values)
            appearance_value = pearson(appearance_signal[support], audio_values)
            if flow_value is not None:
                flow_curve[index] = flow_value
            if appearance_value is not None:
                appearance_curve[index] = appearance_value
        feature_curves = np.stack([flow_curve, appearance_curve])
        feature_counts = np.sum(np.isfinite(feature_curves), axis=0)
        combined_curve = np.divide(
            np.nansum(feature_curves, axis=0),
            feature_counts,
            out=np.full(lags.shape, np.nan, dtype=np.float64),
            where=feature_counts > 0,
        )
        return flow_curve, appearance_curve, combined_curve

    flow_curve, appearance_curve, correlations = curves(audio_onset, fixed_support)
    finite_indices = np.flatnonzero(np.isfinite(correlations))
    if finite_indices.size < 5:
        return None
    best_index = int(finite_indices[np.argmax(correlations[finite_indices])])
    peak = float(correlations[best_index])
    best_lag = float(lags[best_index])
    zero_index = int(np.argmin(np.abs(lags)))
    zero = finite(correlations[zero_index]) if np.isfinite(correlations[zero_index]) else None
    finite_flow = np.flatnonzero(np.isfinite(flow_curve))
    finite_appearance = np.flatnonzero(np.isfinite(appearance_curve))
    if finite_flow.size == 0 or finite_appearance.size == 0:
        return None
    flow_best = int(finite_flow[np.argmax(flow_curve[finite_flow])])
    appearance_best = int(finite_appearance[np.argmax(appearance_curve[finite_appearance])])
    feature_agreement_ms = abs(float(lags[flow_best] - lags[appearance_best])) * 1000.0

    separated = np.abs(lags - best_lag) >= max(0.08, effective_period * 2)
    competing = correlations[np.isfinite(correlations) & separated]
    second_peak = float(np.max(competing)) if competing.size else peak
    prominence = max(0.0, peak - second_peak)
    near_peak = np.isfinite(correlations) & (
        correlations >= peak - max(0.04, prominence * 0.5)
    )
    peak_width = max(
        float(resolution_ms),
        float((lags[near_peak].max() - lags[near_peak].min()) * 1000.0)
        if bool(np.any(near_peak))
        else 1000.0,
    )

    window_seconds = max(0.6, effective_period * 12)
    window_step = window_seconds * 0.5
    window_lags: list[float] = []
    first_time = float(mouth_times[fixed_support].min())
    last_time = float(mouth_times[fixed_support].max())
    cursor = first_time
    while cursor + window_seconds <= last_time + effective_period:
        support = fixed_support & (mouth_times >= cursor) & (mouth_times < cursor + window_seconds)
        if int(np.count_nonzero(support)) >= 12:
            _window_flow, _window_appearance, window_curve = curves(audio_onset, support)
            finite_window = np.flatnonzero(np.isfinite(window_curve))
            if finite_window.size:
                window_best = int(finite_window[np.argmax(window_curve[finite_window])])
                if float(window_curve[window_best]) >= 0.1:
                    window_lags.append(float(lags[window_best]))
        cursor += window_step
    window_lag_iqr_ms = (
        float((np.percentile(window_lags, 75) - np.percentile(window_lags, 25)) * 1000.0)
        if len(window_lags) >= 2
        else 1000.0
    )

    rng = np.random.default_rng(0)
    minimum_roll = max(1, int(round(0.65 / (audio_times[1] - audio_times[0]))))
    maximum_roll = max(minimum_roll + 1, audio_onset.size - minimum_roll)
    null_peaks: list[float] = []
    if maximum_roll > minimum_roll:
        for offset in rng.integers(minimum_roll, maximum_roll, size=64):
            _null_flow, _null_appearance, null_curve = curves(
                np.roll(audio_onset, int(offset)),
                fixed_support,
            )
            finite_null = null_curve[np.isfinite(null_curve)]
            if finite_null.size:
                null_peaks.append(float(np.max(finite_null)))
    null_p95 = float(np.percentile(null_peaks, 95)) if null_peaks else 1.0
    validated = (
        peak >= 0.2
        and prominence >= 0.04
        and peak >= null_p95 + 0.03
        and feature_agreement_ms <= max(100.0, resolution_ms * 2.0)
        and len(window_lags) >= 2
        and window_lag_iqr_ms <= max(150.0, resolution_ms * 3.0)
        and peak_width <= max(250.0, resolution_ms * 4.0)
        and abs(best_lag) < LAG_LIMIT_SECONDS
    )
    return {
        "validated": validated,
        "estimatedAudioLeadMilliseconds": int(round(best_lag * 1000.0)),
        "lagResolutionMilliseconds": resolution_ms,
        "effectiveVideoSampleMilliseconds": effective_period * 1000.0,
        "correlationPeak": peak,
        "zeroLagCorrelation": zero,
        "peakProminence": prominence,
        "peakWidthMilliseconds": int(round(peak_width)),
        "featureLagAgreementMilliseconds": int(round(feature_agreement_ms)),
        "windowLagIqrMilliseconds": int(round(window_lag_iqr_ms)),
        "usableWindowCount": len(window_lags),
        "nullP95Correlation": null_p95,
    }


def analyze_audio_motion_sync(
    video_path: Path,
    tracked_candidates: list[dict[str, object]],
    sampled_video_frames: int,
    duration_seconds: float | None,
    has_audio: bool | None,
    audio_start_relative_video_seconds: float | None,
) -> dict[str, object]:
    if has_audio is not True:
        return blank_result(
            "not-applicable",
            "Keine Audiospur für den Audio-Mund-Bewegungsabgleich.",
            sampled_video_frames=sampled_video_frames,
        )
    if duration_seconds is None or duration_seconds <= 0 or duration_seconds > MAX_DURATION_SECONDS:
        return blank_result(
            "insufficient",
            f"Der Rohproxy unterstützt derzeit höchstens {MAX_DURATION_SECONDS:.0f} Sekunden.",
            sampled_video_frames=sampled_video_frames,
        )
    if audio_start_relative_video_seconds is None:
        return blank_result(
            "insufficient",
            "Die relative Audio-/Video-Startzeit ist nicht verlässlich messbar.",
            sampled_video_frames=sampled_video_frames,
        )
    mouth_times, mouth_flow, mouth_appearance = motion_series(tracked_candidates)
    possible_pairs = max(sampled_video_frames - 1, 1)
    motion_coverage = float(np.clip(mouth_times.size / possible_pairs, 0.0, 1.0))
    base = blank_result(
        "insufficient",
        None,
        sampled_video_frames=sampled_video_frames,
        valid_motion_pairs=int(mouth_times.size),
        motion_coverage=motion_coverage,
    )
    if mouth_times.size < 12 or motion_coverage < 0.6:
        base["error"] = "Zu wenige kontinuierlich verfolgte Mundbewegungspaare."
        return base
    audio_times, audio_onset, audio_activity = decode_audio_features(
        video_path,
        audio_start_relative_video_seconds,
    )
    base["audioWindowCount"] = int(audio_times.size)
    audio_activity_ratio = float(np.mean(audio_activity)) if audio_activity.size else None
    base["audioActivityRatio"] = audio_activity_ratio
    if (
        audio_times.size < 24
        or audio_activity_ratio is None
        or not 0.08 <= audio_activity_ratio <= 0.98
    ):
        base["error"] = "Keine ausreichend strukturierte Audioaktivität erkannt."
        return base
    expected_times = np.linspace(0.0, duration_seconds, max(sampled_video_frames - 1, 1))
    expected_active = int(np.count_nonzero(
        np.interp(expected_times, audio_times, audio_activity, left=0.0, right=0.0) >= 0.25
    ))
    tracked_active = int(np.count_nonzero(
        np.interp(mouth_times, audio_times, audio_activity, left=0.0, right=0.0) >= 0.25
    ))
    mouth_activity_coverage = (
        float(np.clip(tracked_active / expected_active, 0.0, 1.0))
        if expected_active > 0
        else 0.0
    )
    effective_period = float(np.median(np.diff(mouth_times))) if mouth_times.size >= 2 else 0.0
    usable_activity_seconds = tracked_active * max(effective_period, 0.0)
    base["mouthCoverageDuringAudioActivity"] = mouth_activity_coverage
    base["usableAudioActivitySeconds"] = usable_activity_seconds
    if mouth_activity_coverage < 0.7 or usable_activity_seconds < 1.0:
        base["error"] = "Mundtracking deckt die Audioaktivität nicht ausreichend ab."
        return base
    estimate = estimate_lag(
        mouth_times,
        mouth_flow,
        mouth_appearance,
        audio_times,
        audio_onset,
        audio_activity,
    )
    if estimate is None:
        base["error"] = "Audio- und Mundbewegung liefern kein auswertbares Korrelationssignal."
        return base
    validated = bool(estimate.pop("validated"))
    base.update(estimate)
    if validated:
        base["status"] = "measured"
        base["error"] = None
    else:
        base["error"] = (
            "Korrelationspeak besteht Feature-, Fenster- oder Nullmodellprüfung nicht."
        )
    return base
