#!/usr/bin/env python3
"""Render and assemble a natural-speed, resumable LTX-2 production."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path("/home/moddy/LTX-2")
CURRENT_REPO = Path("/home/moddy/LTX-2-current")
OUTPUT_ROOT = ROOT / ".ltx-studio/outputs"
SEGMENT_ROOT = OUTPUT_ROOT / "natural-segments"
REPORT_PATH = OUTPUT_ROOT / "traumfrau-nummer1-natural-burlesque-2min-1080x1920-20260724.report.json"
OUTPUT_PATH = OUTPUT_ROOT / "traumfrau-nummer1-natural-burlesque-2min-1080x1920-20260724.mp4"
TEMPORARY_PATH = OUTPUT_PATH.with_suffix(".part.mp4")
REFERENCE_IMAGE = ROOT / ".ltx-studio/uploads/image/6d6d624b-12c3-4a97-9e4e-152a69423b6c.png"
COVERED_ANCHOR = SEGMENT_ROOT / "covered-frontal-anchor-v2-20260724.png"
REMOVED_ANCHOR = SEGMENT_ROOT / "removed-bra-frontal-anchor-20260724.png"
FIRST_SEGMENT = (
    OUTPUT_ROOT / "sources/traumfrau-nummer1-source-bf16-offload-10s-512x896-20260724.mp4"
)
CHECKPOINT = Path(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled.safetensors"
)
UPSCALER = Path(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/"
    "ltx-2.3-spatial-upscaler-x2-1.0.safetensors"
)
GEMMA_ROOT = Path("/home/moddy/LTX-2.3-max/DreamFast__gemma-3-12b-it-heretic")
PYTHON = Path("/home/moddy/comfyui-env/bin/python")
FRAME_RATE = 24
SEGMENT_FRAMES = 241
SEGMENT_DURATION = SEGMENT_FRAMES / FRAME_RATE
TRANSITION_SECONDS = 0.35
TARGET_DURATION_SECONDS = 120.5
SEGMENT_TRIMS = {7: 6.7, 9: 8.0}
THERMAL_PAUSE_C = 90.0
THERMAL_RESUME_C = 80.0
THERMAL_STREAK = 3
MIN_AVAILABLE_GIB = 20.0

BASE_PROMPT = (
    "Natural-speed continuous cinematic shot. Preserve the exact identity of the same adult brunette "
    "woman, her long dark hairstyle, realistic body proportions, the warm rustic bedroom, and the "
    "golden window-light direction. She remains front-facing or in a slight three-quarter pose toward "
    "the camera. Photorealistic skin, physically accurate black lace fabric, stable anatomy, restrained "
    "graceful motion, no cuts, no sudden camera movement. "
)


@dataclass(frozen=True)
class SegmentSpec:
    number: int
    seed: int
    reset_to_reference: bool
    action: str

    @property
    def path(self) -> Path:
        return SEGMENT_ROOT / f"segment-{self.number:02d}-512x896.mp4"

    @property
    def endpoint(self) -> Path:
        return SEGMENT_ROOT / f"segment-{self.number:02d}-endpoint.png"

    @property
    def prompt(self) -> str:
        return BASE_PROMPT + self.action + (
            " At all times, breasts and nipples remain fully concealed by the black lace bra, crossed "
            "forearms, long hair, or an opaque black fabric cover. No visible nipples, no exposed "
            "breasts, no transparent fabric. Quiet room ambience and faint fabric movement, no dialogue "
            "and no music."
        )


SPECS = [
    SegmentSpec(
        2,
        24072027,
        False,
        "The camera gently pulls back while she lowers her chin, breathes naturally, blinks, and returns "
        "her calm gaze to the lens. Her complete lingerie outfit remains unchanged.",
    ),
    SegmentSpec(
        3,
        24072028,
        False,
        "She performs a slow frontal burlesque sway and shifts her weight naturally, keeping both hands "
        "away from her face and her complete lingerie outfit securely in place.",
    ),
    SegmentSpec(
        4,
        24072029,
        False,
        "She keeps facing the camera, raises one hand gracefully to her hair, then lets it fall while the "
        "other hand rests near her hip. Her complete lingerie outfit remains securely in place.",
    ),
    SegmentSpec(
        5,
        24072030,
        True,
        "A new frontal shot begins from the exact reference pose. She starts a sensual but restrained "
        "burlesque routine, breathing naturally and tracing one bra strap with her fingertips while the "
        "bra remains fully worn and covering her chest.",
    ),
    SegmentSpec(
        6,
        24072031,
        False,
        "Still facing the camera, she slowly lowers the first bra strap over her shoulder and then the "
        "second strap. The opaque bra cups stay firmly in place and fully cover her chest.",
    ),
    SegmentSpec(
        7,
        24072132,
        False,
        "A new locked frontal shot begins from the composed crossed-arm pose with the black satin cloth "
        "held at her waist. Keeping both shoulders square to the camera, she lifts the wide opaque cloth "
        "straight upward until it covers her chest continuously from collarbones to waist. The bra stays "
        "in place behind the cloth. She finishes front-facing with the cloth pressed flat and secure. She "
        "never turns sideways or shows her back.",
    ),
    SegmentSpec(
        8,
        24072133,
        False,
        "Locked frontal camera. She raises the wide opaque black satin cover across her chest from "
        "collarbones to waist, holds it securely with crossed forearms, and then lowers it only to the "
        "upper waist. The bra remains worn and covering her chest during this preparatory movement. She "
        "keeps both shoulders square to the camera and never turns sideways or shows her back.",
    ),
    SegmentSpec(
        9,
        24072134,
        False,
        "Locked frontal camera. The wide opaque black satin cover is already wrapped firmly around her "
        "chest from collarbones to waist and never moves, opens, or becomes sheer. One final thin black "
        "bra strap is visible on her right shoulder. She slides that strap down, reaches beneath the side "
        "edge of the cover, pulls the complete detached black lace bra out from underneath, and clearly "
        "holds the removed bra beside her right hip. In the final pose no bra straps or cups remain on her "
        "body. She stays squarely front-facing and never turns sideways or shows her back.",
    ),
    SegmentSpec(
        10,
        24072135,
        False,
        "The removed black lace bra is clearly visible in her right hand beside her hip while the wide "
        "opaque black satin cover remains firmly secured across her chest. She slowly lowers the removed "
        "bra onto a nearby chair, returns her empty hand to the cover, breathes naturally, and stays "
        "squarely front-facing without turning away from the camera.",
    ),
    SegmentSpec(
        11,
        24072036,
        False,
        "Holding the wide opaque black satin cover securely from collarbones to waist, with no bra straps "
        "or cups worn underneath, she performs a slow natural sway and keeps her face toward the camera.",
    ),
    SegmentSpec(
        12,
        24072037,
        False,
        "She keeps the wide opaque black satin cover firmly secured from collarbones to waist, with no bra "
        "straps or cups worn underneath, shifts her weight, and gently brushes a few strands of hair away "
        "from her face without uncovering herself or turning away.",
    ),
    SegmentSpec(
        13,
        24072038,
        False,
        "She settles into a composed frontal final pose with the wide opaque black satin cover secured "
        "from collarbones to waist, with no bra straps or cups worn underneath, breathes naturally, blinks "
        "once, and holds a confident gaze without turning away.",
    ),
]


def log(message: str) -> None:
    print(f"[natural-production] {message}", flush=True)


def run_capture(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=True, capture_output=True, text=True)


def probe_video(path: Path) -> dict[str, Any]:
    result = run_capture(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,"
            "r_frame_rate,nb_frames,duration,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ]
    )
    return json.loads(result.stdout)


def validate_segment(path: Path) -> dict[str, Any]:
    probe = probe_video(path)
    video = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "audio"), None)
    duration = float(probe.get("format", {}).get("duration") or 0)
    if (
        video is None
        or video.get("width") != 512
        or video.get("height") != 896
        or video.get("avg_frame_rate") != "24/1"
        or int(video.get("nb_frames") or 0) != SEGMENT_FRAMES
        or duration < 10
    ):
        raise RuntimeError(f"invalid segment video contract: {path}: {probe}")
    if audio is None or audio.get("sample_rate") != "48000" or audio.get("channels") != 2:
        raise RuntimeError(f"invalid segment audio contract: {path}: {probe}")
    return probe


def read_max_temp_c() -> float | None:
    values: list[float] = []
    candidates = list(Path("/sys/class/thermal").glob("thermal_zone*/temp"))
    candidates.extend(Path("/sys/class/hwmon").glob("hwmon*/temp*_input"))
    for path in candidates:
        try:
            raw = float(path.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            continue
        value = raw / 1000 if raw > 150 else raw
        if 1 <= value <= 150:
            values.append(value)
    return max(values) if values else None


def available_gib() -> float:
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1024 / 1024
    return 0.0


def run_guarded(args: list[str], *, label: str) -> dict[str, float]:
    child = subprocess.Popen(args, cwd=CURRENT_REPO, start_new_session=True)
    paused = False
    hot_streak = 0
    cool_streak = 0
    low_memory_streak = 0
    peak_temp = 0.0
    minimum_available = float("inf")

    def stop_child() -> None:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)

    try:
        while child.poll() is None:
            temperature = read_max_temp_c()
            memory = available_gib()
            if temperature is not None:
                peak_temp = max(peak_temp, temperature)
            minimum_available = min(minimum_available, memory)

            if not paused:
                hot_streak = hot_streak + 1 if temperature is not None and temperature >= THERMAL_PAUSE_C else 0
                if hot_streak >= THERMAL_STREAK:
                    os.killpg(child.pid, signal.SIGSTOP)
                    paused = True
                    cool_streak = 0
                    log(f"{label}: thermally paused at {temperature:.1f} C without losing progress")
            else:
                cool_streak = (
                    cool_streak + 1
                    if temperature is not None and temperature <= THERMAL_RESUME_C
                    else 0
                )
                if cool_streak >= THERMAL_STREAK:
                    os.killpg(child.pid, signal.SIGCONT)
                    paused = False
                    hot_streak = 0
                    log(f"{label}: resumed at {temperature:.1f} C")

            low_memory_streak = low_memory_streak + 1 if memory < MIN_AVAILABLE_GIB else 0
            if low_memory_streak >= 3:
                stop_child()
                raise RuntimeError(f"{label}: aborted before OOM at {memory:.2f} GiB available")
            time.sleep(5)
    except BaseException:
        stop_child()
        raise

    if child.returncode != 0:
        raise subprocess.CalledProcessError(child.returncode, args)
    return {
        "peak_temp_c": round(peak_temp, 1),
        "minimum_available_gib": round(minimum_available, 2),
    }


def extract_endpoint(video: Path, endpoint: Path) -> None:
    endpoint.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-sseof",
            "-0.05",
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-y",
            str(endpoint),
        ],
        check=True,
    )


def render_segment(spec: SegmentSpec, conditioning_image: Path) -> dict[str, Any]:
    if spec.path.exists():
        try:
            probe = validate_segment(spec.path)
            extract_endpoint(spec.path, spec.endpoint)
            log(f"segment {spec.number:02d}: valid existing output reused")
            return {"probe": probe, "reused": True}
        except Exception:
            spec.path.unlink()

    args = [
        str(PYTHON),
        "-m",
        "ltx_pipelines.distilled",
        "--distilled-checkpoint-path",
        str(CHECKPOINT),
        "--gemma-root",
        str(GEMMA_ROOT),
        "--prompt",
        spec.prompt,
        "--output-path",
        str(spec.path),
        "--seed",
        str(spec.seed),
        "--height",
        "896",
        "--width",
        "512",
        "--num-frames",
        str(SEGMENT_FRAMES),
        "--frame-rate",
        str(FRAME_RATE),
        "--image",
        str(conditioning_image),
        "0",
        "1",
        "33",
        "--quantization",
        "fp8-cast",
        "--offload",
        "disk",
        "--max-batch-size",
        "1",
        "--spatial-upsampler-path",
        str(UPSCALER),
    ]
    if spec.number >= 7:
        if spec.number >= 10:
            end_anchor = REMOVED_ANCHOR
        elif spec.number == 9:
            end_anchor = COVERED_ANCHOR
        else:
            end_anchor = REFERENCE_IMAGE
        args.extend(
            [
                "--image",
                str(end_anchor),
                str(SEGMENT_FRAMES - 1),
                "0.25",
                "33",
            ]
        )
    log(f"segment {spec.number:02d}: rendering from {conditioning_image.name}")
    metrics = run_guarded(args, label=f"segment {spec.number:02d}")
    probe = validate_segment(spec.path)
    extract_endpoint(spec.path, spec.endpoint)
    log(f"segment {spec.number:02d}: complete ({metrics})")
    return {"probe": probe, "reused": False, "metrics": metrics}


def assemble(segment_paths: list[Path]) -> dict[str, Any]:
    input_args: list[str] = []
    filters: list[str] = []
    for index, path in enumerate(segment_paths):
        segment_number = index + 1
        duration = SEGMENT_TRIMS.get(segment_number, SEGMENT_DURATION)
        input_args.extend(["-i", str(path)])
        filters.append(
            f"[{index}:v]trim=duration={duration:.6f},fps=24,settb=AVTB,setpts=PTS-STARTPTS,"
            "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop=1080:1920,format=yuv420p[v{index}]"
        )
        filters.append(
            f"[{index}:a]atrim=duration={duration:.6f},aresample=48000,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"asetpts=PTS-STARTPTS[a{index}]"
        )

    video_label = "v0"
    audio_label = "a0"
    cumulative_duration = SEGMENT_TRIMS.get(1, SEGMENT_DURATION)
    for index in range(1, len(segment_paths)):
        next_video = f"vx{index}"
        next_audio = f"ax{index}"
        offset = cumulative_duration - TRANSITION_SECONDS
        filters.append(
            f"[{video_label}][v{index}]xfade=transition=fade:duration={TRANSITION_SECONDS}:"
            f"offset={offset:.6f}[{next_video}]"
        )
        filters.append(
            f"[{audio_label}][a{index}]acrossfade=d={TRANSITION_SECONDS}:c1=tri:c2=tri[{next_audio}]"
        )
        video_label = next_video
        audio_label = next_audio
        cumulative_duration += (
            SEGMENT_TRIMS.get(index + 1, SEGMENT_DURATION) - TRANSITION_SECONDS
        )

    filters.append(
        f"[{video_label}]trim=duration={TARGET_DURATION_SECONDS},setpts=PTS-STARTPTS,"
        "format=yuv420p[vout]"
    )
    filters.append(
        f"[{audio_label}]apad=pad_dur=2,atrim=duration={TARGET_DURATION_SECONDS},"
        "asetpts=PTS-STARTPTS[aout]"
    )
    TEMPORARY_PATH.unlink(missing_ok=True)
    args = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        *input_args,
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-level:v",
        "4.2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-metadata",
        "title=Traumfrau Nummer 1 - Natural Motion Master",
        str(TEMPORARY_PATH),
    ]
    metrics = run_guarded(args, label="master assembly")
    probe = probe_video(TEMPORARY_PATH)
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
    if (
        float(probe["format"]["duration"]) < 120
        or float(video.get("duration") or 0) < 120
        or video.get("width") != 1080
        or video.get("height") != 1920
        or video.get("avg_frame_rate") != "24/1"
        or int(video.get("nb_frames") or 0) < 2880
        or audio.get("sample_rate") != "48000"
        or audio.get("channels") != 2
    ):
        raise RuntimeError(f"invalid master contract: {probe}")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-i", str(TEMPORARY_PATH), "-f", "null", "-"],
        check=True,
    )
    TEMPORARY_PATH.replace(OUTPUT_PATH)
    return {"probe": probe, "metrics": metrics}


def main() -> int:
    if not os.environ.get("DGX_JOB_ID"):
        raise RuntimeError("DGX_JOB_ID is required; run only under an admitted orchestrator job")
    os.environ["PYTHONPATH"] = (
        f"{CURRENT_REPO}/.deps:{CURRENT_REPO}/packages/ltx-pipelines/src:"
        f"{CURRENT_REPO}/packages/ltx-core/src"
    )
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    for required in (
        REFERENCE_IMAGE,
        COVERED_ANCHOR,
        REMOVED_ANCHOR,
        FIRST_SEGMENT,
        CHECKPOINT,
        UPSCALER,
        GEMMA_ROOT,
        PYTHON,
    ):
        if not required.exists():
            raise FileNotFoundError(required)
    SEGMENT_ROOT.mkdir(parents=True, exist_ok=True)

    first_probe = validate_segment(FIRST_SEGMENT)
    first_endpoint = SEGMENT_ROOT / "segment-01-endpoint.png"
    extract_endpoint(FIRST_SEGMENT, first_endpoint)
    segment_paths = [FIRST_SEGMENT]
    segment_reports: list[dict[str, Any]] = [
        {"number": 1, "path": str(FIRST_SEGMENT), "probe": first_probe, "reused": True}
    ]
    previous_endpoint = first_endpoint
    for spec in SPECS:
        if spec.number == 7:
            conditioning = SEGMENT_ROOT / "segment-05-endpoint.png"
        elif spec.number == 9:
            conditioning = COVERED_ANCHOR
        elif spec.number >= 10:
            conditioning = REMOVED_ANCHOR
        else:
            conditioning = REFERENCE_IMAGE if spec.reset_to_reference else previous_endpoint
        report = render_segment(spec, conditioning)
        segment_paths.append(spec.path)
        segment_reports.append(
            {
                "number": spec.number,
                "path": str(spec.path),
                "seed": spec.seed,
                "conditioningImage": str(conditioning),
                "prompt": spec.prompt,
                **report,
            }
        )
        previous_endpoint = spec.endpoint

    master = assemble(segment_paths)
    report = {
        "schemaVersion": "ltx-natural-production-report.v1",
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dgxJobId": os.environ["DGX_JOB_ID"],
        "naturalSpeed": True,
        "timeStretch": False,
        "loopedSegments": False,
        "targetDurationSeconds": TARGET_DURATION_SECONDS,
        "segments": segment_reports,
        "outputPath": str(OUTPUT_PATH),
        "master": master,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"complete: {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log(f"FAILED: {error}")
        raise
