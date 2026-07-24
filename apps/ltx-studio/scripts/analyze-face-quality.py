#!/usr/bin/env python3
"""Bounded CPU-only YuNet landmark measurements for one Studio output."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

FACE_MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return float(ordered[lower])
    weight = position - lower
    return float(ordered[lower] * (1 - weight) + ordered[upper] * weight)


def median(values: list[float]) -> float | None:
    return percentile(values, 0.5)


def coefficient_of_variation(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    center = sum(values) / len(values)
    if abs(center) < 1e-9:
        return None
    variance = sum((value - center) ** 2 for value in values) / len(values)
    return float(math.sqrt(variance) / abs(center))


def verify_model(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"YuNet model missing: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != FACE_MODEL_SHA256:
        raise RuntimeError(f"Unexpected YuNet checksum: {path}")


def finite_number(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def positive_number(value: object) -> float | None:
    parsed = finite_number(value)
    return parsed if parsed is not None and parsed > 0 else None


def parse_rate(value: object) -> float | None:
    if not isinstance(value, str) or value == "0/0":
        return None
    parts = value.split("/", 1)
    if len(parts) == 1:
        return positive_number(parts[0])
    numerator = finite_number(parts[0])
    denominator = positive_number(parts[1])
    if numerator is None or denominator is None:
        return None
    return positive_number(numerator / denominator)


def probe_constant_frame_rate(video_path: Path) -> bool | None:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            str(video_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode != 0:
        return None
    try:
        body = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    frames = body.get("frames") if isinstance(body.get("frames"), list) else []
    timestamps = [
        timestamp
        for frame in frames
        if isinstance(frame, dict)
        and (timestamp := finite_number(frame.get("best_effort_timestamp_time"))) is not None
    ]
    if len(timestamps) < 3:
        return None
    deltas = [right - left for left, right in zip(timestamps, timestamps[1:])]
    if len(deltas) != len(timestamps) - 1 or any(delta <= 0 for delta in deltas):
        return False
    center = median(deltas)
    if center is None or center <= 0:
        return None
    tolerance = max(0.0005, center * 0.02)
    return max(abs(delta - center) for delta in deltas) <= tolerance


def probe_technical(video_path: Path) -> dict[str, object]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "format=duration:"
            "stream=codec_type,nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate,"
            "duration,start_time",
            "-of",
            "json",
            str(video_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr[-500:]}")
    body = json.loads(result.stdout)
    streams = body.get("streams") if isinstance(body.get("streams"), list) else []
    video_streams = [item for item in streams if item.get("codec_type") == "video"]
    audio_streams = [item for item in streams if item.get("codec_type") == "audio"]
    if not video_streams:
        raise RuntimeError("Video stream missing")
    video = video_streams[0]
    audio = audio_streams[0] if audio_streams else None
    average_fps = parse_rate(video.get("avg_frame_rate"))
    nominal_fps = parse_rate(video.get("r_frame_rate"))
    fps = average_fps or nominal_fps
    format_body = body.get("format") if isinstance(body.get("format"), dict) else {}
    format_duration = positive_number(format_body.get("duration"))
    video_duration = positive_number(video.get("duration")) or format_duration
    audio_duration = positive_number(audio.get("duration")) if audio else None
    frames_value = (
        positive_number(video.get("nb_read_frames"))
        or positive_number(video.get("nb_frames"))
        or (video_duration * fps if video_duration is not None and fps is not None else None)
    )
    video_start = finite_number(video.get("start_time"))
    audio_start = finite_number(audio.get("start_time")) if audio else None
    return {
        "durationSeconds": video_duration,
        "fps": fps,
        "frames": int(round(frames_value)) if frames_value is not None else None,
        "hasAudio": bool(audio_streams),
        "constantFrameRate": probe_constant_frame_rate(video_path),
        "audioVideoDurationDeltaSeconds": (
            abs(video_duration - audio_duration)
            if video_duration is not None and audio_duration is not None
            else None
        ),
        "audioVideoStartDeltaSeconds": (
            abs(video_start - audio_start)
            if video_start is not None and audio_start is not None
            else None
        ),
    }


def normalized_geometry(points: object):
    import numpy as np

    landmarks = np.asarray(points, dtype=np.float64)
    if landmarks.shape != (5, 2) or not bool(np.isfinite(landmarks).all()):
        return None
    right_eye, left_eye, nose, right_mouth, left_mouth = landmarks
    eye_vector = left_eye - right_eye
    eye_span = float(np.linalg.norm(eye_vector))
    mouth_vector = left_mouth - right_mouth
    mouth_span = float(np.linalg.norm(mouth_vector))
    if eye_span < 8 or mouth_span < 6:
        return None
    eye_center = (right_eye + left_eye) * 0.5
    x_axis = eye_vector / eye_span
    y_axis = np.asarray([-x_axis[1], x_axis[0]], dtype=np.float64)

    def normalize(point: object):
        offset = np.asarray(point, dtype=np.float64) - eye_center
        return np.asarray(
            [float(np.dot(offset, x_axis) / eye_span), float(np.dot(offset, y_axis) / eye_span)],
            dtype=np.float64,
        )

    mouth_center = (right_mouth + left_mouth) * 0.5
    eye_angle = math.atan2(float(eye_vector[1]), float(eye_vector[0]))
    mouth_angle = math.atan2(float(mouth_vector[1]), float(mouth_vector[0]))
    relative_angle = math.atan2(
        math.sin(mouth_angle - eye_angle),
        math.cos(mouth_angle - eye_angle),
    )
    return {
        "nose": normalize(nose),
        "mouth_center": normalize(mouth_center),
        "mouth_span": mouth_span / eye_span,
        "mouth_angle_degrees": math.degrees(relative_angle),
        "eye_span": eye_span,
    }


def analyze(video_path: Path, model_path: Path, max_frames: int) -> dict[str, object]:
    import cv2
    import numpy as np

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Video cannot be decoded: {video_path}")
    total_frames = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not math.isfinite(fps) or fps <= 0:
        fps = 24.0
    stride = max(1, math.ceil(total_frames / max_frames)) if total_frames > 0 else 1
    detector = cv2.FaceDetectorYN.create(str(model_path), "", (320, 320), 0.55, 0.3, 5000)

    sampled = 0
    detected = 0
    valid = 0
    confidences: list[float] = []
    eye_spans: list[float] = []
    face_areas: list[float] = []
    nose_positions: list[tuple[float, object]] = []
    mouth_angles: list[tuple[float, float]] = []
    mouth_spans: list[float] = []
    previous_center = None
    frame_index = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % stride != 0:
                frame_index += 1
                continue
            sampled += 1
            position_ms = finite_number(capture.get(cv2.CAP_PROP_POS_MSEC))
            timestamp = (
                position_ms / 1000.0
                if position_ms is not None and position_ms >= 0
                else frame_index / fps
            )
            height, width = frame.shape[:2]
            detector.setInputSize((width, height))
            _result, faces = detector.detect(frame)
            if faces is not None and len(faces) > 0:
                candidates = [face for face in faces if float(face[14]) >= 0.55]
                if candidates:
                    if previous_center is None:
                        selected = max(candidates, key=lambda face: float(face[2] * face[3]))
                    else:
                        def candidate_score(face: object) -> float:
                            points = np.asarray(face[4:14], dtype=np.float64).reshape(5, 2)
                            center = points.mean(axis=0)
                            distance = float(np.linalg.norm(center - previous_center))
                            scale = max(float(face[2]), float(face[3]), 1.0)
                            return float(face[2] * face[3]) - distance * scale * 1.8

                        selected = max(candidates, key=candidate_score)
                    points = np.asarray(selected[4:14], dtype=np.float64).reshape(5, 2)
                    previous_center = points.mean(axis=0)
                    detected += 1
                    confidences.append(float(selected[14]))
                    face_areas.append(float(selected[2] * selected[3]) / max(float(width * height), 1.0))
                    geometry = normalized_geometry(points)
                    if geometry is not None:
                        valid += 1
                        eye_spans.append(float(geometry["eye_span"]))
                        nose_positions.append((timestamp, geometry["nose"]))
                        mouth_angles.append((timestamp, float(geometry["mouth_angle_degrees"])))
                        mouth_spans.append(float(geometry["mouth_span"]))
            frame_index += 1
            if sampled >= max_frames:
                break
    finally:
        capture.release()

    nose_velocities: list[float] = []
    for (time_a, point_a), (time_b, point_b) in zip(nose_positions, nose_positions[1:]):
        elapsed = time_b - time_a
        if elapsed > 0:
            nose_velocities.append(float(np.linalg.norm(point_b - point_a) / elapsed))
    nose_accelerations: list[float] = []
    velocity_times: list[float] = []
    for index, velocity in enumerate(nose_velocities):
        velocity_times.append((nose_positions[index][0] + nose_positions[index + 1][0]) * 0.5)
    for (time_a, velocity_a), (time_b, velocity_b) in zip(
        zip(velocity_times, nose_velocities),
        zip(velocity_times[1:], nose_velocities[1:]),
    ):
        elapsed = time_b - time_a
        if elapsed > 0:
            nose_accelerations.append(abs(velocity_b - velocity_a) / elapsed)
    mouth_angle_velocities: list[float] = []
    for (time_a, angle_a), (time_b, angle_b) in zip(mouth_angles, mouth_angles[1:]):
        elapsed = time_b - time_a
        if elapsed > 0:
            delta = (angle_b - angle_a + 180.0) % 360.0 - 180.0
            mouth_angle_velocities.append(abs(delta) / elapsed)

    return {
        "sampledFrames": sampled,
        "detectedFrames": detected,
        "validGeometryFrames": valid,
        "detectionCoverage": detected / sampled if sampled else 0.0,
        "geometryCoverage": valid / sampled if sampled else 0.0,
        "medianConfidence": median(confidences),
        "medianEyeSpanPixels": median(eye_spans),
        "medianFaceAreaRatio": median(face_areas),
        "noseVelocityP95PerSecond": percentile(nose_velocities, 0.95),
        "noseAccelerationP95PerSecond2": percentile(nose_accelerations, 0.95),
        "mouthAngleMedianDegrees": median([angle for _time, angle in mouth_angles]),
        "mouthAngleVelocityP95DegreesPerSecond": percentile(mouth_angle_velocities, 0.95),
        "mouthSpanCoefficientOfVariation": coefficient_of_variation(mouth_spans),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--face-model", required=True)
    parser.add_argument("--max-frames", type=int, default=240)
    args = parser.parse_args()
    video_path = Path(args.video).resolve()
    model_path = Path(args.face_model).resolve()
    if not video_path.is_file():
        raise FileNotFoundError(f"Video missing: {video_path}")
    if not 8 <= args.max_frames <= 1000:
        raise ValueError("--max-frames must be between 8 and 1000")
    verify_model(model_path)
    result = {
        "technical": probe_technical(video_path),
        "face": analyze(video_path, model_path, args.max_frames),
    }
    json.dump(result, sys.stdout, ensure_ascii=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
