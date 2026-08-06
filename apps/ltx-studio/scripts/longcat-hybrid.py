#!/usr/bin/env python3
"""Optional LongCat lip-sync pass for LTX Studio.

The generate command submits exactly one file-queue job to the existing
LongCat supervisor. The composite command keeps the LTX video authoritative
and transfers only a feathered mouth region from the LongCat result.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path


CACHE_VERSION = "longcat-lips-v1"
CACHE_MISS_EXIT = 3
WORKER_CONTAINER = "longcat-avatar-worker"
DEFAULT_FACE_MODEL = (
    Path(__file__).resolve().parent.parent
    / "models"
    / "face_detection_yunet_2023mar.onnx"
)
FACE_MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
DEFAULT_PROMPT = (
    "A woman faces the camera and speaks naturally with precise lip movement, "
    "a steady head, a calm expression, and stable facial identity."
)


class Cancelled(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"LongCat: {message}", flush=True)


def valid_video(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 10_000


def sha256_file(path: Path, digest: "hashlib._Hash") -> None:
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)


def cache_key(
    image_path: Path,
    audio_path: Path,
    *,
    resolution: str,
    seed: int,
    prompt: str,
    audio_start: float,
    audio_duration: float | None,
) -> str:
    digest = hashlib.sha256()
    digest.update(CACHE_VERSION.encode())
    for value in (resolution, str(seed), prompt, str(audio_start), str(audio_duration)):
        digest.update(b"\0")
        digest.update(value.encode())
    sha256_file(image_path, digest)
    sha256_file(audio_path, digest)
    return digest.hexdigest()


def run_checked(command: list[str]) -> None:
    process = subprocess.run(command, text=True, capture_output=True, check=False)
    if process.returncode != 0:
        detail = (process.stderr or process.stdout).strip()[-1000:]
        raise RuntimeError(f"Befehl fehlgeschlagen ({process.returncode}): {detail}")


def prepare_audio(
    source: Path,
    target: Path,
    *,
    audio_start: float,
    audio_duration: float | None,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp.wav")
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if audio_start > 0:
        command.extend(["-ss", f"{audio_start:.6f}"])
    command.extend(["-i", str(source)])
    if audio_duration is not None:
        command.extend(["-t", f"{audio_duration:.6f}"])
    command.extend(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(temporary)])
    run_checked(command)
    temporary.replace(target)


def docker_worker_running() -> bool:
    process = subprocess.run(
        ["docker", "ps", "--filter", f"name=^{WORKER_CONTAINER}$", "--format", "{{.Names}}"],
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )
    if process.returncode != 0:
        raise RuntimeError(f"Docker-Status nicht lesbar: {process.stderr.strip()[-500:]}")
    return WORKER_CONTAINER in process.stdout.splitlines()


def copy_atomic(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    shutil.copy2(source, temporary)
    temporary.replace(target)


def has_durable_checkpoint(jobs_dir: Path, job_id: str) -> bool:
    root = jobs_dir / "checkpoints" / job_id
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(manifest, dict):
        return False
    completed = manifest.get("completed_segments")
    total = manifest.get("total_segments")
    segment_files = manifest.get("segment_files")
    state_file = manifest.get("state_file")
    if (
        manifest.get("schema_version") != "longcat-segment-checkpoint.v1"
        or manifest.get("job_id") != job_id
        or type(completed) is not int
        or type(total) is not int
        or not 1 <= completed < total
        or segment_files != [f"segment-{index:03d}.npz" for index in range(completed)]
        or not isinstance(state_file, str)
        or Path(state_file).name != state_file
    ):
        return False
    for path in [*(root / name for name in segment_files), root / state_file]:
        try:
            if not path.is_file() or path.is_symlink() or path.stat().st_size <= 0:
                return False
        except OSError:
            return False
    return True


def stream_process(process: subprocess.Popen[str]) -> threading.Thread:
    def forward() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            stripped = line.rstrip()
            if stripped:
                log(f"Supervisor: {stripped}")

    thread = threading.Thread(target=forward, name="longcat-supervisor-log", daemon=True)
    thread.start()
    return thread


def submit_job(
    jobs_dir: Path,
    *,
    image_path: Path,
    audio_path: Path,
    prompt: str,
    resolution: str,
    seed: int,
) -> tuple[str, Path]:
    job_id = f"ltx-studio-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    assets = jobs_dir / "assets" / job_id
    assets.mkdir(parents=True, exist_ok=False)
    image_suffix = image_path.suffix.lower() or ".png"
    image_target = assets / f"image{image_suffix}"
    audio_target = assets / "audio.wav"
    shutil.copy2(image_path, image_target)
    shutil.copy2(audio_path, audio_target)
    payload = {
        "schema_version": "longcat-avatar-job.v2",
        "job_id": job_id,
        "image": f"assets/{job_id}/{image_target.name}",
        "audio": f"assets/{job_id}/audio.wav",
        "prompt": prompt,
        "resolution": resolution,
        "max_segments": 32,
        "seed": seed,
    }
    queue_dir = jobs_dir / "queue"
    queue_dir.mkdir(parents=True, exist_ok=True)
    temporary = queue_dir / f".{job_id}.json.tmp"
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(queue_dir / f"{job_id}.json")
    return job_id, assets


def poll_job(jobs_dir: Path, job_id: str) -> tuple[str, dict]:
    if (jobs_dir / "queue" / f"{job_id}.json").exists():
        return "queued", {}
    if (jobs_dir / "work" / f"{job_id}.json").exists():
        return "rendering", {}
    for state in ("done", "failed"):
        result_path = jobs_dir / state / job_id / "result.json"
        if result_path.exists():
            try:
                result = json.loads(result_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                result = {}
            return state, result
    return "unknown", {}


def stop_owned_supervisor(
    process: subprocess.Popen[str] | None,
    jobs_dir: Path,
    *,
    cancelled: bool = False,
) -> None:
    if process is None:
        return
    if process.poll() is None:
        if cancelled:
            process.send_signal(signal.SIGTERM)
        else:
            (jobs_dir / "stop").touch()
        try:
            process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=600)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("LongCat-Supervisor konnte nicht kontrolliert beendet werden.") from error
    if process.returncode not in (0, 143, -signal.SIGTERM):
        log(f"Supervisor endete mit Code {process.returncode}.")


def generate(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    jobs_dir = project_root / "avatar" / "data" / "jobs"
    image_path = Path(args.image).resolve()
    source_audio = Path(args.audio).resolve()
    output_path = Path(args.output).resolve()
    cache_root = Path(args.cache_root).resolve()
    prepared_audio = output_path.parent / "longcat-audio.wav"
    for required in (image_path, source_audio):
        if not required.is_file():
            raise FileNotFoundError(required)
    key = cache_key(
        image_path,
        source_audio,
        resolution=args.resolution,
        seed=args.seed,
        prompt=args.prompt,
        audio_start=args.audio_start,
        audio_duration=args.audio_duration,
    )
    cache_dir = cache_root / key
    cache_video = cache_dir / "longcat.mp4"
    cache_root.mkdir(parents=True, exist_ok=True)
    lock_path = cache_root / f"{key}.lock"

    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if valid_video(cache_video):
            copy_atomic(cache_video, output_path)
            log(f"Cache-Treffer {key[:12]}; kein neuer LongCat-Render nötig.")
            return 0
        if args.cache_only:
            log(f"Kein Cache-Treffer {key[:12]}.")
            return CACHE_MISS_EXIT

        supervisor_path = project_root / "scripts" / "avatar_worker_supervisor.py"
        if not supervisor_path.is_file():
            raise FileNotFoundError(supervisor_path)
        prepare_audio(
            source_audio,
            prepared_audio,
            audio_start=args.audio_start,
            audio_duration=args.audio_duration,
        )

        jobs_dir.mkdir(parents=True, exist_ok=True)
        for child in ("queue", "work", "done", "failed", "assets"):
            (jobs_dir / child).mkdir(parents=True, exist_ok=True)

        owner_lock_path = jobs_dir / ".ltx-studio-supervisor.lock"
        supervisor: subprocess.Popen[str] | None = None
        job_id: str | None = None
        assets: Path | None = None
        last_state = ""
        cancelled = False

        def on_signal(signum: int, _frame: object) -> None:
            nonlocal cancelled
            cancelled = True
            raise Cancelled(f"Signal {signum}")

        old_handlers = {
            signum: signal.signal(signum, on_signal)
            for signum in (signal.SIGTERM, signal.SIGINT)
        }
        try:
            with owner_lock_path.open("w") as owner_lock:
                already_running = docker_worker_running()
                if not already_running:
                    fcntl.flock(owner_lock, fcntl.LOCK_EX)
                    already_running = docker_worker_running()

                job_id, assets = submit_job(
                    jobs_dir,
                    image_path=image_path,
                    audio_path=prepared_audio,
                    prompt=args.prompt,
                    resolution=args.resolution,
                    seed=args.seed,
                )
                log(f"Queuejob {job_id} eingereicht.")

                if already_running:
                    log("Vorhandener LongCat-Worker übernimmt den Job; er wird danach nicht gestoppt.")
                else:
                    run_id = f"ltx-studio-{job_id}"
                    supervisor = subprocess.Popen(
                        [
                            args.supervisor_python,
                            str(supervisor_path),
                            "--run-id",
                            run_id,
                            "--requested-by",
                            "ltx-studio",
                            "--worker-job-id",
                            job_id,
                        ],
                        cwd=project_root,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        env={**os.environ, "DGX_LONGCAT_STARTUP_LEASE": "1"},
                    )
                    stream_process(supervisor)
                    log("LongCat-Supervisor gestartet; dessen Admission-, Speicher- und Thermal-Gates gelten.")

                deadline = time.monotonic() + args.timeout
                while time.monotonic() < deadline:
                    state, result = poll_job(jobs_dir, job_id)
                    if state != last_state:
                        log(f"Jobstatus: {state}.")
                        last_state = state
                    if state == "done":
                        generated = jobs_dir / "done" / job_id / "output.mp4"
                        if not valid_video(generated):
                            raise RuntimeError("LongCat meldet Erfolg, aber output.mp4 fehlt oder ist leer.")
                        cache_dir.mkdir(parents=True, exist_ok=True)
                        copy_atomic(generated, cache_video)
                        copy_atomic(cache_video, output_path)
                        log(f"Mundspur fertig; Cache {key[:12]} gespeichert.")
                        return 0
                    if state == "failed":
                        detail = str(result.get("error") or "Unbekannter LongCat-Fehler")
                        raise RuntimeError(f"LongCat-Job fehlgeschlagen: {detail}")
                    if supervisor is not None and supervisor.poll() is not None:
                        state, result = poll_job(jobs_dir, job_id)
                        if state not in ("done", "failed"):
                            raise RuntimeError(
                                f"LongCat-Supervisor endete vor dem Jobabschluss mit Code {supervisor.returncode}."
                            )
                    time.sleep(2)
                raise TimeoutError(f"LongCat-Job überschritt das Zeitlimit von {args.timeout:.0f} Sekunden.")
        except Cancelled:
            cancelled = True
            raise
        finally:
            try:
                stop_owned_supervisor(supervisor, jobs_dir, cancelled=cancelled)
            finally:
                preserve_for_resume = (
                    job_id is not None
                    and (jobs_dir / "work" / f"{job_id}.json").is_file()
                    and has_durable_checkpoint(jobs_dir, job_id)
                )
                if preserve_for_resume:
                    log(f"Fortsetzbarer Segment-Checkpoint für {job_id} bleibt vollständig erhalten.")
                elif job_id is not None:
                    queue_file = jobs_dir / "queue" / f"{job_id}.json"
                    work_file = jobs_dir / "work" / f"{job_id}.json"
                    queue_file.unlink(missing_ok=True)
                    work_file.unlink(missing_ok=True)
                if assets is not None and not preserve_for_resume:
                    shutil.rmtree(assets, ignore_errors=True)
                for signum, handler in old_handlers.items():
                    signal.signal(signum, handler)


def verify_face_model(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"YuNet-Gesichtsmodell fehlt: {path}")
    digest = hashlib.sha256()
    sha256_file(path, digest)
    if digest.hexdigest() != FACE_MODEL_SHA256:
        raise RuntimeError(f"YuNet-Gesichtsmodell hat eine unerwartete Prüfsumme: {path}")


class LandmarkTracker:
    """Track YuNet's five face landmarks with optical-flow dropout recovery."""

    def __init__(self, model_path: Path):
        import cv2

        self.detector = cv2.FaceDetectorYN.create(
            str(model_path),
            "",
            (320, 320),
            0.55,
            0.3,
            5000,
        )
        self.previous_gray = None
        self.previous_points = None
        self.previous_box = None
        self.missed_frames = 0

    def _detect(self, frame: object):
        import numpy as np

        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _result, faces = self.detector.detect(frame)
        if faces is None or len(faces) == 0:
            return None

        candidates = [face for face in faces if float(face[14]) >= 0.55]
        if not candidates:
            return None
        if self.previous_points is None:
            selected = max(candidates, key=lambda face: float(face[2] * face[3]))
        else:
            previous_center = np.asarray(self.previous_points, dtype=np.float32).mean(axis=0)

            def score(face: object) -> float:
                landmarks = np.asarray(face[4:14], dtype=np.float32).reshape(5, 2)
                distance = float(np.linalg.norm(landmarks.mean(axis=0) - previous_center))
                return float(face[2] * face[3]) - distance * max(float(face[2]), float(face[3])) * 1.8

            selected = max(candidates, key=score)
        landmarks = np.asarray(selected[4:14], dtype=np.float32).reshape(5, 2)
        box = np.asarray(selected[:4], dtype=np.float32)
        return landmarks, box, float(selected[14])

    def update(self, frame: object):
        import cv2
        import numpy as np

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        tracked = None
        if self.previous_gray is not None and self.previous_points is not None:
            next_points, status, _errors = cv2.calcOpticalFlowPyrLK(
                self.previous_gray,
                gray,
                np.asarray(self.previous_points, dtype=np.float32).reshape(-1, 1, 2),
                None,
                winSize=(31, 31),
                maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
            )
            if next_points is not None and status is not None and int(status.sum()) >= 4:
                tracked = next_points.reshape(-1, 2)
                valid = status.reshape(-1).astype(bool)
                if not bool(np.all(valid)):
                    tracked[~valid] = self.previous_points[~valid]

        detection = self._detect(frame)
        fresh = detection is not None
        confidence = 0.0
        if detection is not None:
            detected_points, box, confidence = detection
            points = detected_points
            if tracked is not None:
                eye_span = max(float(np.linalg.norm(detected_points[1] - detected_points[0])), 1.0)
                residual = float(np.median(np.linalg.norm(detected_points - tracked, axis=1)))
                if residual <= eye_span * 0.35:
                    points = detected_points * 0.38 + tracked * 0.62
            self.previous_box = box
            self.missed_frames = 0
        elif tracked is not None and self.missed_frames < 6:
            points = tracked
            confidence = max(0.25, 0.8 - self.missed_frames * 0.1)
            self.missed_frames += 1
        else:
            points = None
            self.previous_box = None
            self.missed_frames += 1

        self.previous_gray = gray
        self.previous_points = points
        return points, fresh, confidence


def landmark_geometry_valid(points: object) -> bool:
    import numpy as np

    if points is None:
        return False
    points = np.asarray(points, dtype=np.float32)
    if points.shape != (5, 2) or not bool(np.isfinite(points).all()):
        return False
    right_eye, left_eye, nose, right_mouth, left_mouth = points
    eye_vector = left_eye - right_eye
    mouth_vector = left_mouth - right_mouth
    eye_span = float(np.linalg.norm(eye_vector))
    mouth_span = float(np.linalg.norm(mouth_vector))
    if eye_span < 8 or mouth_span < 6:
        return False
    if not 0.45 <= mouth_span / eye_span <= 1.35:
        return False
    eye_center = (right_eye + left_eye) * 0.5
    mouth_center = (right_mouth + left_mouth) * 0.5
    vertical_span = float(np.linalg.norm(mouth_center - eye_center))
    if not 0.55 <= vertical_span / eye_span <= 1.9:
        return False
    yaw = abs(float(np.dot(nose - eye_center, eye_vector) / max(eye_span * eye_span, 1.0)))
    if yaw > 0.58:
        return False
    eye_angle = math.atan2(float(eye_vector[1]), float(eye_vector[0]))
    mouth_angle = math.atan2(float(mouth_vector[1]), float(mouth_vector[0]))
    angle_difference = abs(math.atan2(math.sin(mouth_angle - eye_angle), math.cos(mouth_angle - eye_angle)))
    return angle_difference <= math.radians(32)


def smooth_angle(previous: float | None, current: float, weight: float = 0.42) -> float:
    if previous is None:
        return current
    delta = math.atan2(math.sin(current - previous), math.cos(current - previous))
    return previous + delta * weight


class MouthTransformSmoother:
    def __init__(self):
        self.rotation = None
        self.scale = None
        self.target_roll = None

    def build(self, source_points: object, target_points: object):
        import numpy as np

        source_landmarks = np.asarray(source_points, dtype=np.float32)
        target_landmarks = np.asarray(target_points, dtype=np.float32)
        source_mouth = source_landmarks[3:5]
        target_mouth = target_landmarks[3:5]
        target_eyes = target_landmarks[0:2]
        source_mouth_vector = source_mouth[1] - source_mouth[0]
        target_mouth_vector = target_mouth[1] - target_mouth[0]
        target_eye_vector = target_eyes[1] - target_eyes[0]
        source_span = max(float(np.linalg.norm(source_mouth_vector)), 1.0)
        target_span = max(float(np.linalg.norm(target_mouth_vector)), 1.0)
        raw_scale = (target_span * 0.82) / source_span
        if not 0.45 <= raw_scale <= 2.2:
            return None

        source_mouth_angle = math.atan2(
            float(source_mouth_vector[1]),
            float(source_mouth_vector[0]),
        )
        target_roll = math.atan2(float(target_eye_vector[1]), float(target_eye_vector[0]))
        raw_rotation = target_roll - source_mouth_angle
        self.rotation = smooth_angle(self.rotation, raw_rotation)
        self.target_roll = smooth_angle(self.target_roll, target_roll)
        self.scale = raw_scale if self.scale is None else self.scale * 0.72 + raw_scale * 0.28

        cosine = math.cos(self.rotation) * self.scale
        sine = math.sin(self.rotation) * self.scale
        linear = np.asarray([[cosine, -sine], [sine, cosine]], dtype=np.float32)
        source_center = source_mouth.mean(axis=0)
        target_center = target_mouth.mean(axis=0)
        translation = target_center - linear @ source_center
        matrix = np.column_stack((linear, translation)).astype(np.float32)
        return matrix, self.target_roll


def mouth_masks(
    shape: tuple[int, int, int],
    points: object,
    blend: float,
    target_roll: float,
):
    import cv2
    import numpy as np

    height, width = shape[:2]
    landmarks = np.asarray(points, dtype=np.float32)
    nose = landmarks[2]
    mouth = landmarks[3:5]
    mouth_vector = mouth[1] - mouth[0]
    mouth_span = float(np.linalg.norm(mouth_vector))
    mouth_center = mouth.mean(axis=0)
    center = tuple(int(round(float(value))) for value in mouth_center)
    angle = math.degrees(target_roll)
    core_axes = (
        max(5, int(round(mouth_span * 0.60))),
        max(4, int(round(mouth_span * 0.27))),
    )
    outer_axes = (
        max(core_axes[0] + 3, int(round(mouth_span * 0.76))),
        max(core_axes[1] + 3, int(round(mouth_span * 0.39))),
    )
    core_binary = np.zeros((height, width), dtype=np.uint8)
    opaque_binary = np.zeros((height, width), dtype=np.uint8)
    outer_binary = np.zeros((height, width), dtype=np.uint8)
    cv2.ellipse(core_binary, center, core_axes, angle, 0, 360, 255, -1, lineType=cv2.LINE_AA)
    opaque_axes = (
        max(4, int(round(mouth_span * 0.52))),
        max(3, int(round(mouth_span * 0.20))),
    )
    cv2.ellipse(opaque_binary, center, opaque_axes, angle, 0, 360, 255, -1, lineType=cv2.LINE_AA)
    cv2.ellipse(outer_binary, center, outer_axes, angle, 0, 360, 255, -1, lineType=cv2.LINE_AA)

    core = core_binary.astype(np.float32) / 255.0
    feather_sigma = max(1.2, mouth_span * (0.025 + 0.065 * float(blend)))
    feathered = cv2.GaussianBlur(core, (0, 0), sigmaX=feather_sigma, sigmaY=feather_sigma)
    opaque = opaque_binary.astype(np.float32) / 255.0
    alpha = np.maximum(opaque, feathered)

    nose_to_mouth = mouth_center - nose
    nose_distance = max(float(np.linalg.norm(nose_to_mouth)), 1.0)
    downward = nose_to_mouth / nose_distance
    grid_y, grid_x = np.indices((height, width), dtype=np.float32)
    along_face = (
        (grid_x - float(mouth_center[0])) * float(downward[0])
        + (grid_y - float(mouth_center[1])) * float(downward[1])
    )
    gate_start = -nose_distance * 0.65
    gate_end = -nose_distance * 0.30
    nose_gate = np.clip((along_face - gate_start) / max(gate_end - gate_start, 1.0), 0, 1)
    nose_gate = nose_gate * nose_gate * (3 - 2 * nose_gate)
    alpha *= nose_gate

    ring = cv2.bitwise_and(outer_binary, cv2.bitwise_not(core_binary))
    return np.clip(alpha, 0, 1), ring


class TemporalColorMatcher:
    def __init__(self):
        self.scales = None
        self.offsets = None

    def match(self, source: object, target: object, ring: object):
        import numpy as np

        selected = ring > 0
        if int(selected.sum()) < 32:
            return source
        source_float = source.astype(np.float32)
        target_float = target.astype(np.float32)
        scales = np.ones(3, dtype=np.float32)
        offsets = np.zeros(3, dtype=np.float32)
        for channel in range(3):
            src_values = source_float[:, :, channel][selected]
            dst_values = target_float[:, :, channel][selected]
            src_std = max(float(src_values.std()), 1.0)
            scales[channel] = float(np.clip(float(dst_values.std()) / src_std, 0.75, 1.35))
            offsets[channel] = float(dst_values.mean()) - float(src_values.mean()) * scales[channel]
        if self.scales is None or self.offsets is None:
            self.scales = scales
            self.offsets = offsets
        else:
            self.scales = self.scales * 0.82 + scales * 0.18
            self.offsets = self.offsets * 0.82 + offsets * 0.18
        matched = source_float * self.scales.reshape(1, 1, 3) + self.offsets.reshape(1, 1, 3)
        return np.clip(matched, 0, 255).astype(np.uint8)


def composite(args: argparse.Namespace) -> int:
    import cv2
    import numpy as np

    base_path = Path(args.base).resolve()
    longcat_path = Path(args.longcat).resolve()
    output_path = Path(args.output).resolve()
    if not valid_video(base_path):
        raise RuntimeError(f"LTX-Basisvideo fehlt oder ist leer: {base_path}")
    if not valid_video(longcat_path):
        raise RuntimeError(f"LongCat-Video fehlt oder ist leer: {longcat_path}")
    face_model = Path(args.face_model).resolve()
    verify_face_model(face_model)

    base = cv2.VideoCapture(str(base_path))
    lip = cv2.VideoCapture(str(longcat_path))
    if not base.isOpened() or not lip.isOpened():
        raise RuntimeError("Mindestens eines der Videos kann nicht dekodiert werden.")
    base_fps = float(base.get(cv2.CAP_PROP_FPS))
    lip_fps = float(lip.get(cv2.CAP_PROP_FPS))
    width = int(base.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(base.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(base.get(cv2.CAP_PROP_FRAME_COUNT))
    if base_fps <= 0 or lip_fps <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("Ungültige Video-Metadaten für den Lippenpass.")

    base_tracker = LandmarkTracker(face_model)
    lip_tracker = LandmarkTracker(face_model)
    mouth_transformer = MouthTransformSmoother()
    color_matcher = TemporalColorMatcher()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.stem}.hybrid-{uuid.uuid4().hex}.mp4")
    ffmpeg = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{width}x{height}",
            "-r",
            f"{base_fps:.8f}",
            "-i",
            "pipe:0",
            "-i",
            str(base_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-shortest",
            str(temporary),
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    current_lip_frame = None
    current_lip_index = -1
    tracked_base = 0
    tracked_lip = 0
    fresh_base = 0
    fresh_lip = 0
    transferred = 0
    skipped_pose = 0
    written = 0
    try:
        while True:
            ok, base_frame = base.read()
            if not ok:
                break
            wanted_lip_index = int(round((written / base_fps) * lip_fps))
            while current_lip_index < wanted_lip_index:
                lip_ok, next_lip_frame = lip.read()
                if not lip_ok:
                    break
                current_lip_frame = next_lip_frame
                current_lip_index += 1
            if current_lip_frame is None:
                raise RuntimeError("LongCat-Video enthält keine dekodierbaren Frames.")

            base_points, base_found, _base_confidence = base_tracker.update(base_frame)
            lip_points, lip_found, _lip_confidence = lip_tracker.update(current_lip_frame)
            if base_points is not None:
                tracked_base += 1
            if lip_points is not None:
                tracked_lip += 1
            if base_found:
                fresh_base += 1
            if lip_found:
                fresh_lip += 1

            composed = base_frame
            if landmark_geometry_valid(base_points) and landmark_geometry_valid(lip_points):
                transform = mouth_transformer.build(lip_points, base_points)
                if transform is None:
                    skipped_pose += 1
                else:
                    matrix, target_roll = transform
                    warped = cv2.warpAffine(
                        current_lip_frame,
                        matrix,
                        (width, height),
                        flags=cv2.INTER_LANCZOS4,
                        borderMode=cv2.BORDER_REFLECT_101,
                    )
                    alpha, color_ring = mouth_masks(
                        base_frame.shape,
                        base_points,
                        args.blend,
                        target_roll,
                    )
                    matched = color_matcher.match(warped, base_frame, color_ring)
                    alpha_3d = alpha[:, :, None]
                    composed = np.clip(
                        base_frame.astype(np.float32) * (1 - alpha_3d)
                        + matched.astype(np.float32) * alpha_3d,
                        0,
                        255,
                    ).astype(np.uint8)
                    transferred += 1
            else:
                skipped_pose += 1

            assert ffmpeg.stdin is not None
            ffmpeg.stdin.write(composed.tobytes())
            written += 1
            if frame_count > 0 and written % max(1, frame_count // 10) == 0:
                log(f"Compositing {min(100, round(written / frame_count * 100))} %")

        minimum = max(5, int(written * 0.25))
        if tracked_base < minimum or tracked_lip < minimum or transferred < minimum:
            raise RuntimeError(
                "Gesichtslandmarks nicht stabil genug verfolgt "
                f"(LTX {tracked_base}/{written}, LongCat {tracked_lip}/{written}, Transfer {transferred}/{written})."
            )
        assert ffmpeg.stdin is not None
        ffmpeg.stdin.close()
        return_code = ffmpeg.wait()
        if return_code != 0:
            detail = (ffmpeg.stderr.read() if ffmpeg.stderr else b"").decode(errors="replace")[-1000:]
            raise RuntimeError(f"FFmpeg-Compositing fehlgeschlagen ({return_code}): {detail}")
        if not valid_video(temporary):
            raise RuntimeError("Compositing erzeugte keine gültige MP4-Datei.")
        temporary.replace(output_path)
        log(
            f"Hybridvideo fertig: {written} Frames, dynamische Landmarks "
            f"LTX {tracked_base}/{written} ({fresh_base} frisch), "
            f"LongCat {tracked_lip}/{written} ({fresh_lip} frisch), "
            f"Mundtransfer {transferred}/{written}, sicher ausgelassen {skipped_pose}."
        )
        return 0
    finally:
        base.release()
        lip.release()
        if ffmpeg.poll() is None:
            if ffmpeg.stdin:
                try:
                    ffmpeg.stdin.close()
                except BrokenPipeError:
                    pass
            ffmpeg.terminate()
            ffmpeg.wait()
        if temporary.exists():
            temporary.unlink()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="LTX Studio LongCat lip-sync adapter")
    commands = root.add_subparsers(dest="command", required=True)

    generate_parser = commands.add_parser("generate")
    generate_parser.add_argument("--project-root", required=True)
    generate_parser.add_argument("--image", required=True)
    generate_parser.add_argument("--audio", required=True)
    generate_parser.add_argument("--output", required=True)
    generate_parser.add_argument("--cache-root", required=True)
    generate_parser.add_argument("--resolution", choices=("480p", "720p"), default="480p")
    generate_parser.add_argument("--seed", type=int, required=True)
    generate_parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    generate_parser.add_argument("--audio-start", type=float, default=0)
    generate_parser.add_argument("--audio-duration", type=float)
    generate_parser.add_argument("--supervisor-python", default="python3")
    generate_parser.add_argument("--timeout", type=float, default=21_600)
    generate_parser.add_argument("--cache-only", action="store_true")
    generate_parser.set_defaults(handler=generate)

    composite_parser = commands.add_parser("composite")
    composite_parser.add_argument("--base", required=True)
    composite_parser.add_argument("--longcat", required=True)
    composite_parser.add_argument("--output", required=True)
    composite_parser.add_argument("--blend", type=float, choices=None, default=0.9)
    composite_parser.add_argument("--face-model", default=str(DEFAULT_FACE_MODEL))
    composite_parser.set_defaults(handler=composite)
    return root


def main() -> int:
    args = parser().parse_args()
    if getattr(args, "blend", 0.9) < 0 or getattr(args, "blend", 0.9) > 1:
        raise ValueError("--blend muss zwischen 0 und 1 liegen.")
    return int(args.handler(args))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Cancelled as error:
        log(f"abgebrochen: {error}")
        raise SystemExit(130)
    except Exception as error:
        log(f"Fehler: {error}")
        raise SystemExit(1)
