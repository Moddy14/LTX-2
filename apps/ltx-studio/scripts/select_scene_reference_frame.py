#!/usr/bin/env python3
"""Select a sharp, stable, single-face frame from a finished Studio video."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


SCHEMA_VERSION = "ltx-studio-scene-reference-frame.v1"


def _finite(value: float, fallback: float = 0.0) -> float:
    return float(value) if math.isfinite(float(value)) else fallback


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, _finite(value)))


def _robust_normalize(values: list[float]) -> list[float]:
    if not values:
        return []
    array = np.asarray(values, dtype=np.float64)
    low = float(np.percentile(array, 10))
    high = float(np.percentile(array, 90))
    if not math.isfinite(low) or not math.isfinite(high) or high - low < 1e-9:
        return [1.0 for _value in values]
    return [_clamp01((value - low) / (high - low)) for value in values]


def _face_geometry_score(face: np.ndarray) -> float:
    points = np.asarray(face[4:14], dtype=np.float64).reshape(5, 2)
    right_eye, left_eye, nose, right_mouth, left_mouth = points
    eye_span = float(np.linalg.norm(left_eye - right_eye))
    mouth_span = float(np.linalg.norm(left_mouth - right_mouth))
    if eye_span < 2.0 or mouth_span < 2.0:
        return 0.0
    eye_mid = (right_eye + left_eye) * 0.5
    mouth_mid = (right_mouth + left_mouth) * 0.5
    yaw_proxy = max(abs(float(nose[0] - eye_mid[0])) / eye_span, abs(float(nose[0] - mouth_mid[0])) / mouth_span)
    roll_proxy = abs(float(left_eye[1] - right_eye[1])) / eye_span
    return _clamp01(1.0 - (yaw_proxy / 0.38) * 0.75 - (roll_proxy / 0.35) * 0.25)


def _sample_indices(total_frames: int, fps: float, max_samples: int) -> list[int]:
    if total_frames <= 1:
        return [0]
    duration = total_frames / fps
    # Avoid the generation ramp at both ends. For normal Studio clips this is
    # at least half a second, while very short clips still retain a usable core.
    margin_seconds = min(duration * 0.35, max(0.5, duration * 0.1))
    start = max(1, int(round(margin_seconds * fps)))
    end = min(total_frames - 1, int(round((duration - margin_seconds) * fps)))
    if end < start:
        start, end = 0, total_frames - 1
    count = min(max_samples, end - start + 1)
    return sorted({int(round(value)) for value in np.linspace(start, end, count)})


def _candidate_for_frame(
    capture: cv2.VideoCapture,
    detector: cv2.FaceDetectorYN,
    frame_index: int,
    fps: float,
) -> dict[str, float | int] | None:
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_index - 1))
    ok, previous = capture.read()
    if not ok:
        return None
    if frame_index > 0:
        ok, frame = capture.read()
        if not ok:
            return None
    else:
        frame = previous
    height, width = frame.shape[:2]
    detector.setInputSize((width, height))
    _result, faces = detector.detect(frame)
    if faces is None:
        return None
    accepted = [face for face in faces if float(face[14]) >= 0.60]
    if not accepted:
        return None
    accepted.sort(key=lambda face: float(face[2] * face[3]), reverse=True)
    face = accepted[0]
    x, y, box_width, box_height = [float(value) for value in face[:4]]
    area_ratio = box_width * box_height / max(float(width * height), 1.0)
    if area_ratio < 0.006:
        return None

    padding_x = box_width * 0.10
    padding_y = box_height * 0.10
    x0 = max(0, int(math.floor(x - padding_x)))
    y0 = max(0, int(math.floor(y - padding_y)))
    x1 = min(width, int(math.ceil(x + box_width + padding_x)))
    y1 = min(height, int(math.ceil(y + box_height + padding_y)))
    if x1 - x0 < 32 or y1 - y0 < 32:
        return None

    face_gray = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    face_gray = cv2.resize(face_gray, (256, 256), interpolation=cv2.INTER_AREA)
    previous_gray = cv2.cvtColor(previous[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    previous_gray = cv2.resize(previous_gray, (256, 256), interpolation=cv2.INTER_AREA)
    sharpness = float(cv2.Laplacian(face_gray, cv2.CV_64F).var())
    frame_delta = float(np.mean(cv2.absdiff(face_gray, previous_gray))) / 255.0
    stability = _clamp01(1.0 - frame_delta / 0.12)
    brightness = float(np.mean(face_gray))
    dark_clip = float(np.mean(face_gray <= 12))
    bright_clip = float(np.mean(face_gray >= 245))
    exposure = _clamp01(1.0 - abs(brightness - 140.0) / 140.0 - dark_clip * 1.5 - bright_clip * 1.5)
    center_x = x + box_width * 0.5
    center_y = y + box_height * 0.5
    center_distance = math.hypot((center_x - width * 0.5) / width, (center_y - height * 0.5) / height)
    centered = _clamp01(1.0 - center_distance / 0.55)
    relative_face_areas = [
        float(candidate[2] * candidate[3]) / max(box_width * box_height, 1.0)
        for candidate in accepted
    ]
    second_area_ratio = relative_face_areas[1] if len(relative_face_areas) > 1 else 0.0
    single_face = _clamp01(1.0 - second_area_ratio)

    return {
        "frameIndex": frame_index,
        "atSeconds": frame_index / fps,
        "faceConfidence": float(face[14]),
        "faceAreaRatio": area_ratio,
        "faceSharpness": sharpness,
        "brightness": brightness,
        "exposure": exposure,
        "stability": stability,
        "frontalness": _face_geometry_score(face),
        "centeredness": centered,
        "prominentFaceCount": sum(area >= 0.35 for area in relative_face_areas),
        "singleFace": single_face,
    }


def recommend(
    video: Path,
    face_model: Path,
    max_samples: int,
    min_face_sharpness: float,
) -> dict[str, object]:
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"Video kann nicht dekodiert werden: {video}")
    total_frames = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    fps = _finite(capture.get(cv2.CAP_PROP_FPS), 25.0)
    if fps <= 0:
        fps = 25.0
    if total_frames <= 0:
        capture.release()
        raise RuntimeError("Das Video enthält keine lesbaren Frames.")
    detector = cv2.FaceDetectorYN.create(str(face_model), "", (320, 320), 0.60, 0.3, 5000)
    indices = _sample_indices(total_frames, fps, max_samples)
    candidates: list[dict[str, float | int]] = []
    try:
        for frame_index in indices:
            candidate = _candidate_for_frame(capture, detector, frame_index, fps)
            if candidate is not None:
                candidates.append(candidate)
    finally:
        capture.release()
    if not candidates:
        raise RuntimeError(
            "Kein geeigneter Referenzframe gefunden: Das Gesicht muss klar erkennbar und ausreichend groß sein."
        )

    best_measured_sharpness = max(float(item["faceSharpness"]) for item in candidates)
    candidates = [
        item for item in candidates
        if float(item["faceSharpness"]) >= min_face_sharpness
    ]
    if not candidates:
        raise RuntimeError(
            "Kein geeigneter Referenzframe: Das Gesicht ist im gesamten Video zu weich "
            f"(beste Schärfe {best_measured_sharpness:.1f}, benötigt mindestens {min_face_sharpness:g}). "
            "Verwende ein schärferes Ausgangsvideo oder ein Originalbild."
        )

    sharpness_scores = _robust_normalize([math.log1p(float(item["faceSharpness"])) for item in candidates])
    area_scores = _robust_normalize([math.sqrt(float(item["faceAreaRatio"])) for item in candidates])
    for item, sharpness_score, area_score in zip(candidates, sharpness_scores, area_scores):
        confidence = _clamp01((float(item["faceConfidence"]) - 0.60) / 0.40)
        score = (
            sharpness_score * 0.40
            + area_score * 0.16
            + confidence * 0.10
            + float(item["exposure"]) * 0.10
            + float(item["stability"]) * 0.10
            + float(item["frontalness"]) * 0.07
            + float(item["centeredness"]) * 0.04
            + float(item["singleFace"]) * 0.03
        )
        item["score"] = _clamp01(score)
    ranked = sorted(candidates, key=lambda item: float(item["score"]), reverse=True)
    best = ranked[0]
    public_fields = (
        "frameIndex", "atSeconds", "score", "faceConfidence", "faceAreaRatio", "faceSharpness",
        "brightness", "exposure", "stability", "frontalness", "prominentFaceCount",
    )

    def public(item: dict[str, float | int]) -> dict[str, float | int]:
        return {key: item[key] for key in public_fields}

    return {
        "schemaVersion": SCHEMA_VERSION,
        "atSeconds": best["atSeconds"],
        "score": best["score"],
        "sampledFrames": len(indices),
        "eligibleFrames": len(candidates),
        "metrics": public(best),
        "candidates": [public(item) for item in ranked[:5]],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--face-model", type=Path, required=True)
    parser.add_argument("--max-samples", type=int, default=48)
    parser.add_argument("--min-face-sharpness", type=float, default=35.0)
    args = parser.parse_args()
    if not args.video.is_file():
        raise FileNotFoundError(f"Video fehlt: {args.video}")
    if not args.face_model.is_file():
        raise FileNotFoundError(f"YuNet-Modell fehlt: {args.face_model}")
    if not 8 <= args.max_samples <= 120:
        raise ValueError("max-samples muss zwischen 8 und 120 liegen.")
    if not 0 < args.min_face_sharpness <= 10000:
        raise ValueError("min-face-sharpness muss größer als 0 und höchstens 10000 sein.")
    print(json.dumps(
        recommend(args.video, args.face_model, args.max_samples, args.min_face_sharpness),
        ensure_ascii=False,
    ))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CLI boundary
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from error
