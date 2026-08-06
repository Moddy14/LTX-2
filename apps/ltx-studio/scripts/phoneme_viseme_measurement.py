#!/usr/bin/env python3
"""CPU-only forced-alignment/MediaPipe lip-sync measurement.

This runner deliberately emits measurement-only evidence. It cannot grant
Product-GO; release gates and independent visual viseme classification remain
separate approvals.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

import cv2
import numpy as np

MAX_FILE_BYTES = 8 * 1024**3
MAX_JSON_BYTES = 1024 * 1024
MAX_SECONDS = 5.0
MAX_FRAMES = 300
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SILENCE_PHONES = {"", "<eps>", "sil", "sp", "spn"}
FFMPEG_PATH = Path("/usr/bin/ffmpeg")
FFPROBE_PATH = Path("/usr/bin/ffprobe")


class InsufficientEvidence(RuntimeError):
    pass


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_strict_json(path: Path) -> Any:
    raw = verified_read(path, MAX_JSON_BYTES)
    return json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=strict_object)


def file_sha256(path: Path, maximum_bytes: int = MAX_FILE_BYTES) -> tuple[int, str]:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or path.is_symlink():
        raise ValueError(f"not a regular artifact: {path}")
    if before.st_size <= 0 or before.st_size > maximum_bytes:
        raise ValueError(f"artifact size outside limit: {path}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or opened.st_size != before.st_size
            or opened.st_mtime_ns != before.st_mtime_ns
            or opened.st_ctime_ns != before.st_ctime_ns
        ):
            raise ValueError(f"artifact changed before hashing: {path}")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_dev != opened.st_dev
            or after.st_ino != opened.st_ino
            or after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise ValueError(f"artifact changed while hashing: {path}")
        return after.st_size, digest.hexdigest()
    finally:
        os.close(descriptor)


def verified_read(path: Path, maximum_bytes: int) -> bytes:
    expected_size, expected_sha = file_sha256(path, maximum_bytes)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        value = bytearray()
        while True:
            chunk = os.read(descriptor, 256 * 1024)
            if not chunk:
                break
            value.extend(chunk)
        if len(value) != expected_size or hashlib.sha256(value).hexdigest() != expected_sha:
            raise ValueError(f"artifact changed while reading: {path}")
        return bytes(value)
    finally:
        os.close(descriptor)


def safe_relative(root: Path, value: str) -> Path:
    if not value or "\\" in value or value.startswith("/"):
        raise ValueError(f"unsafe relative path: {value}")
    parts = value.split("/")
    if "." in parts or ".." in parts:
        raise ValueError(f"unsafe relative path: {value}")
    root = Path(os.path.realpath(root))
    result = Path(os.path.abspath(root / value))
    if os.path.commonpath([str(root), str(result)]) != str(root):
        raise ValueError(f"path escapes manifest root: {value}")
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"symlinked artifact path is forbidden: {value}")
    return result


def load_and_verify_manifest(path: Path) -> tuple[dict[str, Any], dict[str, Path], str]:
    manifest_size, manifest_sha = file_sha256(path, MAX_JSON_BYTES)
    if manifest_size > MAX_JSON_BYTES:
        raise ValueError("manifest is too large")
    manifest = read_strict_json(path)
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    schema_version = manifest.get("schemaVersion")
    if schema_version not in {
        "ltx-studio-phoneme-viseme-manifest.v2",
        "ltx-studio-phoneme-viseme-manifest.v3",
    }:
        raise ValueError("unsupported measurement manifest")
    expected_method = (
        "mfa-mediapipe-de.v1"
        if schema_version == "ltx-studio-phoneme-viseme-manifest.v2"
        else "ctc-espeak-mediapipe-de.v1"
    )
    if manifest.get("method") != expected_method:
        raise ValueError("unsupported measurement method")
    root = path.parent.resolve()
    evidence = manifest.get("legalEvidence")
    if not isinstance(evidence, list) or not evidence:
        raise ValueError("legal evidence is missing")
    evidence_ids: set[str] = set()
    approval = manifest.get("legalApproval")
    if not isinstance(approval, dict):
        raise ValueError("measurement approval is missing")
    commercial_scope = approval.get("scope") == "commercial-biometric-measurement-only"
    if approval.get("scope") not in {
        "commercial-biometric-measurement-only",
        "private-local-biometric-measurement-only",
    }:
        raise ValueError("unsupported measurement approval scope")
    for entry in evidence:
        if not isinstance(entry, dict) or not isinstance(entry.get("evidenceId"), str):
            raise ValueError("invalid legal evidence")
        evidence_id = entry["evidenceId"]
        if evidence_id in evidence_ids:
            raise ValueError(f"duplicate legal evidence: {evidence_id}")
        evidence_ids.add(evidence_id)
        if entry.get("biometricProcessingReviewed") is not True or (
            commercial_scope and entry.get("commercialUseReviewed") is not True
        ):
            raise ValueError(f"legal scope not approved: {evidence_id}")
        evidence_path = safe_relative(root, entry.get("path", ""))
        size, actual_sha = file_sha256(evidence_path, 16 * 1024 * 1024)
        if size <= 0 or actual_sha != entry.get("sha256"):
            raise ValueError(f"legal evidence hash mismatch: {evidence_id}")
    components = manifest.get("components")
    if not isinstance(components, dict):
        raise ValueError("components are missing")
    resolved: dict[str, Path] = {}
    for name, component in components.items():
        if component is None:
            continue
        if not isinstance(component, dict):
            raise ValueError(f"invalid component: {name}")
        component_path = safe_relative(root, component.get("path", ""))
        expected_size = component.get("sizeBytes")
        expected_sha = component.get("sha256")
        if not isinstance(expected_size, int) or not HASH_PATTERN.fullmatch(str(expected_sha)):
            raise ValueError(f"invalid component evidence: {name}")
        actual_size, actual_sha = file_sha256(component_path, expected_size)
        if actual_size != expected_size or actual_sha != expected_sha:
            raise ValueError(f"component evidence mismatch: {name}")
        licenses = component.get("licenseEvidenceIds")
        if not isinstance(licenses, list) or not licenses or any(item not in evidence_ids for item in licenses):
            raise ValueError(f"component license evidence mismatch: {name}")
        resolved[name] = component_path
    required = (
        {
            "mfaExecutable",
            "acousticModel",
            "dictionary",
            "faceLandmarker",
            "visemeMapping",
        }
        if schema_version == "ltx-studio-phoneme-viseme-manifest.v2"
        else {
            "phonemeModelWeights",
            "phonemeModelConfig",
            "phonemeVocabulary",
            "espeakExecutable",
            "faceLandmarker",
            "visemeMapping",
        }
    )
    if not required.issubset(resolved):
        raise ValueError(f"missing components: {sorted(required - set(resolved))}")
    return manifest, resolved, manifest_sha


def file_revision(path: Path) -> tuple[int, int, int, int, int, str]:
    before = os.lstat(path)
    size, digest = file_sha256(path)
    after = os.lstat(path)
    before_revision = (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )
    after_revision = (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )
    if before_revision != after_revision or size != after.st_size:
        raise ValueError(f"artifact changed while capturing revision: {path}")
    return (*after_revision, digest)


def component_snapshot(paths: dict[str, Path]) -> dict[str, tuple[int, int, int, int, int, str]]:
    return {name: file_revision(path) for name, path in paths.items()}


def verify_component_snapshot(
    paths: dict[str, Path],
    snapshot: dict[str, tuple[int, int, int, int, int, str]],
) -> None:
    for name, path in paths.items():
        if file_revision(path) != snapshot[name]:
            raise ValueError(f"component changed during measurement: {name}")


def command_output(command: list[str], timeout: float = 20.0) -> str:
    result = subprocess.run(
        command,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        env=os.environ.copy(),
    )
    return result.stdout.strip()


def verify_runtime(manifest: dict[str, Any], components: dict[str, Path]) -> None:
    import importlib.metadata

    runtime = manifest["runtime"]
    actual_python = ".".join(str(value) for value in sys.version_info[:3])
    if actual_python != runtime["pythonVersion"]:
        raise ValueError(f"Python version mismatch: {actual_python}")
    actual_mediapipe = importlib.metadata.version("mediapipe")
    if actual_mediapipe != runtime["mediaPipeVersion"]:
        raise ValueError(f"MediaPipe version mismatch: {actual_mediapipe}")
    if cv2.__version__ != runtime["openCvVersion"]:
        raise ValueError(f"OpenCV version mismatch: {cv2.__version__}")
    if np.__version__ != runtime["numpyVersion"]:
        raise ValueError(f"NumPy version mismatch: {np.__version__}")
    if manifest["method"] == "mfa-mediapipe-de.v1":
        mfa = str(components["mfaExecutable"])
        try:
            actual_mfa = command_output([mfa, "version"])
        except (subprocess.SubprocessError, OSError):
            actual_mfa = command_output([mfa, "--version"])
        if runtime["mfaVersion"] not in actual_mfa:
            raise ValueError(f"MFA version mismatch: {actual_mfa[:100]}")
    else:
        actual_torch = importlib.metadata.version("torch")
        actual_transformers = importlib.metadata.version("transformers")
        actual_phonemizer = importlib.metadata.version("phonemizer")
        if actual_torch != runtime["torchVersion"]:
            raise ValueError(f"Torch version mismatch: {actual_torch}")
        if actual_transformers != runtime["transformersVersion"]:
            raise ValueError(f"Transformers version mismatch: {actual_transformers}")
        if actual_phonemizer != runtime["phonemizerVersion"]:
            raise ValueError(f"Phonemizer version mismatch: {actual_phonemizer}")
        actual_espeak = command_output([str(components["espeakExecutable"]), "--version"])
        if runtime["espeakVersion"] not in actual_espeak:
            raise ValueError(f"eSpeak version mismatch: {actual_espeak[:100]}")
    ffmpeg_size, ffmpeg_sha = file_sha256(FFMPEG_PATH, 64 * 1024 * 1024)
    ffprobe_size, ffprobe_sha = file_sha256(FFPROBE_PATH, 64 * 1024 * 1024)
    if ffmpeg_size <= 0 or ffmpeg_sha != runtime["ffmpegSha256"]:
        raise ValueError("FFmpeg binary hash mismatch")
    if ffprobe_size <= 0 or ffprobe_sha != runtime["ffprobeSha256"]:
        raise ValueError("FFprobe binary hash mismatch")
    ffmpeg_version = command_output([str(FFMPEG_PATH), "-version"]).splitlines()[0]
    if runtime["ffmpegVersion"] not in ffmpeg_version:
        raise ValueError(f"FFmpeg version mismatch: {ffmpeg_version[:100]}")
    ffprobe_version = command_output([str(FFPROBE_PATH), "-version"]).splitlines()[0]
    if runtime["ffmpegVersion"] not in ffprobe_version:
        raise ValueError(f"FFprobe version mismatch: {ffprobe_version[:100]}")


def extract_audio(video: Path, output: Path) -> None:
    subprocess.run(
        [
            str(FFMPEG_PATH),
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(video),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-t",
            str(MAX_SECONDS),
            "-y",
            str(output),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=30,
        env=os.environ.copy(),
    )


def run_mfa(
    audio: Path,
    dialogue_path: Path,
    output: Path,
    temporary_directory: Path,
    components: dict[str, Path],
) -> None:
    command = [
        str(components["mfaExecutable"]),
        "align_one",
        str(audio),
        str(dialogue_path),
        str(components["dictionary"]),
        str(components["acousticModel"]),
        str(output),
        "--output_format",
        "long_textgrid",
        "--temporary_directory",
        str(temporary_directory),
        "--no_use_mp",
        "--no_use_postgres",
        "--single_speaker",
        "--clean",
        "--final_clean",
        "--quiet",
    ]
    if "g2pModel" in components:
        command.extend(["--g2p_model_path", str(components["g2pModel"])])
    subprocess.run(
        command,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
        env={**os.environ, "MFA_ROOT_DIR": str(temporary_directory / "root")},
    )
    if not output.is_file() or output.stat().st_size <= 0:
        raise InsufficientEvidence("MFA produced no alignment")


def ctc_viterbi_path(
    log_probabilities: np.ndarray,
    target_ids: list[int],
    blank_id: int,
) -> list[int]:
    if log_probabilities.ndim != 2 or not target_ids:
        raise InsufficientEvidence("CTC alignment input is empty")
    frame_count, class_count = log_probabilities.shape
    if blank_id < 0 or blank_id >= class_count:
        raise ValueError("CTC blank token is invalid")
    extended: list[int] = [blank_id]
    for target_id in target_ids:
        if target_id < 0 or target_id >= class_count:
            raise ValueError("CTC target token is invalid")
        extended.extend([target_id, blank_id])
    state_count = len(extended)
    repeated = sum(
        left == right for left, right in zip(target_ids, target_ids[1:])
    )
    if frame_count < len(target_ids) + repeated:
        raise InsufficientEvidence("audio is too short for the expected phone sequence")
    negative_infinity = -np.inf
    previous = np.full(state_count, negative_infinity, dtype=np.float64)
    backpointers = np.full((frame_count, state_count), -1, dtype=np.int8)
    previous[0] = float(log_probabilities[0, blank_id])
    if state_count > 1:
        previous[1] = float(log_probabilities[0, extended[1]])
    for frame_index in range(1, frame_count):
        current = np.full(state_count, negative_infinity, dtype=np.float64)
        for state_index, token_id in enumerate(extended):
            best_source = state_index
            best_score = previous[state_index]
            if state_index >= 1 and previous[state_index - 1] > best_score:
                best_source = state_index - 1
                best_score = previous[state_index - 1]
            if (
                state_index >= 2
                and token_id != blank_id
                and token_id != extended[state_index - 2]
                and previous[state_index - 2] > best_score
            ):
                best_source = state_index - 2
                best_score = previous[state_index - 2]
            if math.isfinite(float(best_score)):
                current[state_index] = (
                    float(best_score)
                    + float(log_probabilities[frame_index, token_id])
                )
                backpointers[frame_index, state_index] = state_index - best_source
        previous = current
    end_candidates = [state_count - 1]
    if state_count > 1:
        end_candidates.append(state_count - 2)
    final_state = max(end_candidates, key=lambda index: previous[index])
    if not math.isfinite(float(previous[final_state])):
        raise InsufficientEvidence("CTC forced alignment found no valid path")
    states = [0] * frame_count
    state = final_state
    for frame_index in range(frame_count - 1, -1, -1):
        states[frame_index] = state
        if frame_index == 0:
            break
        step = int(backpointers[frame_index, state])
        if step < 0:
            raise InsufficientEvidence("CTC forced alignment path is incomplete")
        state -= step
    return states


def ctc_phone_intervals(
    states: list[int],
    phones: list[str],
    duration: float,
) -> list[tuple[float, float, str]]:
    if not states or not phones or not math.isfinite(duration) or duration <= 0:
        raise InsufficientEvidence("CTC phone timing input is empty")
    frame_count = len(states)
    frame_seconds = duration / frame_count
    margin_frames = max(1, int(round(0.04 / frame_seconds)))
    spans: list[list[int]] = []
    for phone_index in range(len(phones)):
        target_state = phone_index * 2 + 1
        frames = [
            frame_index
            for frame_index, state_index in enumerate(states)
            if state_index == target_state
        ]
        if not frames:
            raise InsufficientEvidence(f"CTC alignment omitted phone {phone_index}")
        spans.append([frames[0], frames[-1] + 1])

    expanded = [span.copy() for span in spans]
    expanded[0][0] = max(0, expanded[0][0] - margin_frames)
    expanded[-1][1] = min(frame_count, expanded[-1][1] + margin_frames)
    for index in range(len(expanded) - 1):
        left_end = spans[index][1]
        right_start = spans[index + 1][0]
        gap = max(0, right_start - left_end)
        if gap <= margin_frames * 2:
            boundary = left_end + gap // 2
            expanded[index][1] = boundary
            expanded[index + 1][0] = boundary
        else:
            expanded[index][1] = min(right_start, left_end + margin_frames)
            expanded[index + 1][0] = max(left_end, right_start - margin_frames)

    return [
        (
            start * frame_seconds,
            end * frame_seconds,
            phone,
        )
        for (start, end), phone in zip(expanded, phones)
    ]


def espeak_phonemes(executable: Path, dialogue: str) -> list[str]:
    phone_text = command_output([
        str(executable),
        "-q",
        "-v",
        "de",
        "--ipa=1",
        "--sep=|",
        "--",
        dialogue,
    ])
    phones = [
        normalize_phone(value)
        for value in phone_text.replace("|", " ").split()
        if normalize_phone(value)
    ]
    if not phones:
        raise InsufficientEvidence("dialogue produced no German phonemes")
    return phones


def run_ctc_alignment(
    audio: Path,
    dialogue: str,
    components: dict[str, Path],
) -> list[tuple[float, float, str]]:
    import soundfile as sf
    import torch
    from transformers import Wav2Vec2Config, Wav2Vec2ForCTC

    vocabulary = read_strict_json(components["phonemeVocabulary"])
    if (
        not isinstance(vocabulary, dict)
        or not vocabulary
        or any(not isinstance(key, str) or not isinstance(value, int)
               for key, value in vocabulary.items())
    ):
        raise ValueError("CTC phoneme vocabulary is invalid")
    blank_id = vocabulary.get("<pad>")
    unknown_id = vocabulary.get("<unk>")
    if not isinstance(blank_id, int) or not isinstance(unknown_id, int):
        raise ValueError("CTC vocabulary lacks blank or unknown token")
    phones = espeak_phonemes(components["espeakExecutable"], dialogue)
    def vocabulary_id(phone: str) -> int:
        if phone in vocabulary:
            return vocabulary[phone]
        return vocabulary.get(phone.replace("ː", "").replace("ˑ", ""), unknown_id)

    target_ids = [vocabulary_id(phone) for phone in phones]
    waveform, sample_rate = sf.read(str(audio), dtype="float32", always_2d=False)
    if sample_rate != 16_000 or waveform.ndim != 1 or waveform.size < 1_600:
        raise InsufficientEvidence("CTC audio must be mono 16 kHz with at least 100 ms")
    if waveform.size > int(MAX_SECONDS * sample_rate):
        waveform = waveform[: int(MAX_SECONDS * sample_rate)]
    normalized = waveform.astype(np.float32, copy=False)
    variance = float(np.var(normalized))
    if not math.isfinite(variance) or variance <= 1e-10:
        raise InsufficientEvidence("CTC audio has no usable signal variance")
    normalized = (normalized - float(np.mean(normalized))) / math.sqrt(variance + 1e-7)
    config = Wav2Vec2Config.from_json_file(str(components["phonemeModelConfig"]))
    if config.vocab_size != len(vocabulary) or config.pad_token_id != blank_id:
        raise ValueError("CTC model config and vocabulary do not match")
    model = Wav2Vec2ForCTC(config)
    state = torch.load(
        str(components["phonemeModelWeights"]),
        map_location="cpu",
        weights_only=True,
    )
    if not isinstance(state, dict):
        raise ValueError("CTC model weights are not a state dictionary")
    model.load_state_dict(state, strict=True)
    model.eval()
    torch.set_num_threads(max(1, min(2, os.cpu_count() or 1)))
    with torch.inference_mode():
        logits = model(torch.from_numpy(normalized).unsqueeze(0)).logits[0]
        log_probabilities = torch.log_softmax(logits, dim=-1).cpu().numpy()
    states = ctc_viterbi_path(log_probabilities, target_ids, blank_id)
    duration = float(waveform.size / sample_rate)
    return ctc_phone_intervals(states, phones, duration)


def parse_textgrid_intervals(source: str, tier_name: str = "phones") -> list[tuple[float, float, str]]:
    item_pattern = re.compile(
        r"item\s*\[\d+\]\s*:(.*?)(?=\n\s*item\s*\[\d+\]\s*:|\Z)",
        re.DOTALL,
    )
    interval_pattern = re.compile(
        r"intervals\s*\[\d+\]\s*:\s*"
        r"xmin\s*=\s*([-+0-9.eE]+)\s*"
        r"xmax\s*=\s*([-+0-9.eE]+)\s*"
        r'text\s*=\s*"((?:[^"]|"")*)"',
        re.DOTALL,
    )
    for item in item_pattern.findall(source):
        name = re.search(r'name\s*=\s*"([^"]+)"', item)
        kind = re.search(r'class\s*=\s*"([^"]+)"', item)
        if not name or name.group(1).strip().lower() != tier_name.lower():
            continue
        if not kind or kind.group(1) != "IntervalTier":
            raise ValueError("phones tier is not an IntervalTier")
        intervals: list[tuple[float, float, str]] = []
        for start_text, end_text, label in interval_pattern.findall(item):
            start = float(start_text)
            end = float(end_text)
            if not math.isfinite(start) or not math.isfinite(end) or end < start:
                raise ValueError("invalid TextGrid interval")
            if intervals and start < intervals[-1][1] - 1e-6:
                raise ValueError("overlapping TextGrid intervals")
            intervals.append((start, end, label.replace('""', '"').strip()))
        if not intervals:
            raise InsufficientEvidence("phones tier contains no intervals")
        return intervals
    raise InsufficientEvidence("phones tier is missing")


def normalize_phone(value: str) -> str:
    # Vowel length is kept: CTC vocabularies may carry e.g. "i" and "iː" as
    # distinct tokens, and collapsing them aligns speech to the wrong logits.
    normalized = unicodedata.normalize("NFC", value.strip())
    normalized = re.sub(r"[ˈˌ']", "", normalized)
    normalized = re.sub(r"(?<=[A-Za-z])[012]$", "", normalized)
    return normalized


def viseme_phone(value: str) -> str:
    # Mouth shape does not depend on vowel length, so viseme classes stay
    # length-agnostic.
    return normalize_phone(value).replace("ː", "").replace("ˑ", "")


def load_viseme_mapping(path: Path) -> tuple[dict[str, int], dict[int, str]]:
    body = read_strict_json(path)
    if not isinstance(body, dict) or body.get("mappingVersion") != "viseme15-en-de.v1":
        raise ValueError("unsupported viseme mapping")
    classes = body.get("classes")
    if not isinstance(classes, list) or len(classes) != 15:
        raise ValueError("viseme mapping must contain 15 classes")
    owner: dict[str, int] = {}
    codes: dict[int, str] = {}
    for entry in classes:
        if not isinstance(entry, dict):
            raise ValueError("invalid viseme class")
        class_id = entry.get("id")
        code = entry.get("code")
        phones = entry.get("phones")
        if not isinstance(class_id, int) or not isinstance(code, str) or not isinstance(phones, list):
            raise ValueError("invalid viseme class")
        if class_id in codes:
            raise ValueError("duplicate viseme class")
        codes[class_id] = code
        for phone in phones:
            normalized = viseme_phone(str(phone))
            if normalized in owner:
                raise ValueError(f"duplicate mapped phone: {normalized}")
            owner[normalized] = class_id
    return owner, codes


def normalized_frame_centers(absolute_starts: list[float]) -> list[float]:
    if len(absolute_starts) < 2:
        raise InsufficientEvidence("video contains too few frame timestamps")
    if any(not math.isfinite(value) for value in absolute_starts):
        raise InsufficientEvidence("video frame timestamps are not finite")
    first_start = absolute_starts[0]
    frame_starts = [
        value - first_start
        for value in absolute_starts
        if value - first_start < MAX_SECONDS
    ][:MAX_FRAMES]
    if len(frame_starts) < 2 or any(
        right <= left for left, right in zip(frame_starts, frame_starts[1:])
    ):
        raise InsufficientEvidence("video frame timestamps are missing or non-monotonic")
    intervals = np.diff(np.asarray(frame_starts, dtype=np.float64))
    median_interval = float(np.median(intervals))
    if (
        not math.isfinite(median_interval)
        or median_interval <= 0
        or float(np.max(np.abs(intervals - median_interval))) > max(0.001, median_interval * 0.02)
    ):
        raise InsufficientEvidence("video frame timestamps are not constant-rate")
    fps = 1.0 / median_interval
    if min(abs(fps - allowed) for allowed in (24.0, 25.0, 30.0)) > 0.05:
        raise InsufficientEvidence(f"unsupported video frame rate: {fps:.3f}")
    return [value + median_interval / 2.0 for value in frame_starts]


def video_timestamps(video: Path) -> list[float]:
    result = subprocess.run(
        [
            str(FFPROBE_PATH),
            "-v",
            "error",
            "-read_intervals",
            "%+5.5",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            str(video),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if len(result.stdout) > 2 * 1024 * 1024:
        raise InsufficientEvidence("FFprobe frame output exceeds limit")
    body = json.loads(result.stdout)
    frames = body.get("frames", [])
    if not frames or any(
        not isinstance(frame, dict) or frame.get("best_effort_timestamp_time") is None
        for frame in frames
    ):
        raise InsufficientEvidence("video contains frames without timestamps")
    return normalized_frame_centers([
        float(frame["best_effort_timestamp_time"])
        for frame in frames
    ])


def stream_start_offset_seconds(video: Path) -> float:
    result = subprocess.run(
        [
            str(FFPROBE_PATH),
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,start_time",
            "-of",
            "json",
            str(video),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    if len(result.stdout) > MAX_JSON_BYTES:
        raise InsufficientEvidence("FFprobe stream output exceeds limit")
    body = json.loads(result.stdout)
    streams = body.get("streams", [])
    video_starts = [
        float(stream["start_time"])
        for stream in streams
        if isinstance(stream, dict)
        and stream.get("codec_type") == "video"
        and stream.get("start_time") is not None
    ]
    audio_starts = [
        float(stream["start_time"])
        for stream in streams
        if isinstance(stream, dict)
        and stream.get("codec_type") == "audio"
        and stream.get("start_time") is not None
    ]
    if not video_starts or not audio_starts:
        raise InsufficientEvidence("audio/video stream start timestamps are unavailable")
    offset = audio_starts[0] - video_starts[0]
    if not math.isfinite(offset) or abs(offset) > MAX_SECONDS:
        raise InsufficientEvidence("audio/video stream start offset is outside the measurement window")
    return offset


def align_intervals_to_video_timeline(
    intervals: list[tuple[float, float, str]],
    audio_start_offset_seconds: float,
) -> list[tuple[float, float, str]]:
    return [
        (
            start + audio_start_offset_seconds,
            end + audio_start_offset_seconds,
            phone,
        )
        for start, end, phone in intervals
    ]


def euclidean(left: Any, right: Any) -> float:
    return math.hypot(float(left.x) - float(right.x), float(left.y) - float(right.y))


def rotation_angles(matrix: np.ndarray) -> tuple[float, float]:
    rotation = np.asarray(matrix, dtype=np.float64)[:3, :3]
    sy = math.hypot(float(rotation[0, 0]), float(rotation[1, 0]))
    singular = sy < 1e-6
    if not singular:
        pitch = math.atan2(float(rotation[2, 1]), float(rotation[2, 2]))
        yaw = math.atan2(float(-rotation[2, 0]), sy)
    else:
        pitch = math.atan2(float(-rotation[1, 2]), float(rotation[1, 1]))
        yaw = math.atan2(float(-rotation[2, 0]), sy)
    return abs(math.degrees(yaw)), abs(math.degrees(pitch))


def track_face(video: Path, model_path: Path, timestamps: list[float]) -> dict[str, np.ndarray]:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    tracking_options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
    )
    multi_face_options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=2,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=False,
    )
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise InsufficientEvidence("video could not be decoded")
    measured_times: list[float] = []
    opening: list[float] = []
    rounding: list[float] = []
    closure: list[float] = []
    blur: list[float] = []
    yaw: list[float] = []
    pitch: list[float] = []
    face_tracked: list[bool] = []
    mouth_tracked: list[bool] = []
    multi: list[bool] = []
    last_timestamp_ms = -1
    try:
        with (
            vision.FaceLandmarker.create_from_options(tracking_options) as landmarker,
            vision.FaceLandmarker.create_from_options(multi_face_options) as multi_face_landmarker,
        ):
            for index, seconds in enumerate(timestamps):
                ok, frame = capture.read()
                if not ok:
                    break
                timestamp_ms = int(round(seconds * 1000))
                if timestamp_ms <= last_timestamp_ms:
                    raise InsufficientEvidence("rounded frame timestamps are non-monotonic")
                last_timestamp_ms = timestamp_ms
                image = mp.Image(
                    image_format=mp.ImageFormat.SRGB,
                    data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB),
                )
                result = landmarker.detect_for_video(image, timestamp_ms)
                multi_result = multi_face_landmarker.detect_for_video(image, timestamp_ms)
                face_count = len(result.face_landmarks)
                multiple_faces = len(multi_result.face_landmarks) > 1
                measured_times.append(seconds)
                multi.append(multiple_faces)
                if face_count != 1 or multiple_faces:
                    face_tracked.append(False)
                    mouth_tracked.append(False)
                    opening.append(float("nan"))
                    rounding.append(float("nan"))
                    closure.append(float("nan"))
                    blur.append(float("nan"))
                    yaw.append(float("nan"))
                    pitch.append(float("nan"))
                    continue
                face_tracked.append(True)
                points = result.face_landmarks[0]
                if len(points) <= 291:
                    mouth_tracked.append(False)
                    opening.append(float("nan"))
                    rounding.append(float("nan"))
                    closure.append(float("nan"))
                    blur.append(float("nan"))
                    yaw.append(float("nan"))
                    pitch.append(float("nan"))
                    continue
                eye_distance = euclidean(points[33], points[263])
                mouth_width = euclidean(points[61], points[291])
                mouth_opening = euclidean(points[13], points[14])
                if eye_distance <= 1e-6 or mouth_width <= 1e-6:
                    mouth_tracked.append(False)
                    opening.append(float("nan"))
                    rounding.append(float("nan"))
                    closure.append(float("nan"))
                    blur.append(float("nan"))
                    yaw.append(float("nan"))
                    pitch.append(float("nan"))
                    continue
                opening.append(mouth_opening / eye_distance)
                blendshapes = {
                    category.category_name: float(category.score)
                    for category in (result.face_blendshapes[0] if result.face_blendshapes else [])
                }
                pucker = blendshapes.get("mouthPucker")
                funnel = blendshapes.get("mouthFunnel")
                mouth_close = blendshapes.get("mouthClose")
                mouth_tracked.append(
                    mouth_close is not None and (pucker is not None or funnel is not None)
                )
                rounding.append(
                    max(value for value in (pucker, funnel) if value is not None)
                    if pucker is not None or funnel is not None
                    else float("nan")
                )
                closure.append(mouth_close if mouth_close is not None else float("nan"))
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                blur.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))
                if result.facial_transformation_matrixes:
                    face_yaw, face_pitch = rotation_angles(result.facial_transformation_matrixes[0])
                    yaw.append(face_yaw)
                    pitch.append(face_pitch)
                else:
                    yaw.append(float("nan"))
                    pitch.append(float("nan"))
                if index + 1 >= MAX_FRAMES:
                    break
    finally:
        capture.release()
    if len(measured_times) < 2:
        raise InsufficientEvidence("too few decoded frames")
    return {
        "times": np.asarray(measured_times, dtype=np.float64),
        "opening": np.asarray(opening, dtype=np.float64),
        "rounding": np.asarray(rounding, dtype=np.float64),
        "closure": np.asarray(closure, dtype=np.float64),
        "blur": np.asarray(blur, dtype=np.float64),
        "yaw": np.asarray(yaw, dtype=np.float64),
        "pitch": np.asarray(pitch, dtype=np.float64),
        "tracked": np.asarray(face_tracked, dtype=np.bool_),
        "mouthTracked": np.asarray(mouth_tracked, dtype=np.bool_),
        "multi": np.asarray(multi, dtype=np.bool_),
    }


def phone_targets(
    times: np.ndarray,
    intervals: list[tuple[float, float, str]],
    mapping: dict[str, int],
    codes: dict[int, str],
) -> dict[str, Any]:
    class_ids = np.zeros(times.shape, dtype=np.int16)
    phone_labels: list[str] = []
    unknown: set[str] = set()
    mapped_seconds = 0.0
    phone_seconds = 0.0
    for start, end, raw_phone in intervals:
        phone = viseme_phone(raw_phone)
        if phone in SILENCE_PHONES:
            class_id = 0
        else:
            phone_seconds += max(0.0, end - start)
            class_id = mapping.get(phone, -1)
            if class_id < 0:
                unknown.add(phone)
            else:
                mapped_seconds += max(0.0, end - start)
        active = (times >= start) & (times < end)
        class_ids[active] = class_id
        phone_labels.extend([phone] * int(np.count_nonzero(active)))
    codes_by_frame = np.asarray([codes.get(int(value), "UNKNOWN") for value in class_ids], dtype=object)
    known = class_ids >= 0
    speech = class_ids > 0
    bilabial = codes_by_frame == "P_B_M"
    rounded = (codes_by_frame == "W_UW_UH_OW_OY").astype(np.float64)
    opening_targets = np.zeros(times.shape, dtype=np.float64)
    medium_open = {"Y_IY_IH_EY", "EH_AE", "ER", "R", "L"}
    high_open = {"AA_AH_AW_AY"}
    opening_targets[np.isin(codes_by_frame, list(medium_open))] = 0.55
    opening_targets[np.isin(codes_by_frame, list(high_open))] = 1.0
    opening_targets[rounded == 1.0] = 0.45
    opening_targets[speech & (opening_targets == 0)] = 0.25
    opening_targets[bilabial] = 0.0
    opening_targets[~known] = np.nan
    rounded[~known] = np.nan
    return {
        "class_ids": class_ids,
        "speech": speech,
        "bilabial": bilabial,
        "rounded": rounded,
        "opening": opening_targets,
        "known": known,
        "unknown": sorted(value for value in unknown if value),
        "coverage": mapped_seconds / phone_seconds if phone_seconds > 0 else 0.0,
    }


def safe_correlation(left: np.ndarray, right: np.ndarray) -> float | None:
    valid = np.isfinite(left) & np.isfinite(right)
    if int(np.count_nonzero(valid)) < 8:
        return None
    left_values = left[valid]
    right_values = right[valid]
    if float(np.std(left_values)) <= 1e-8 or float(np.std(right_values)) <= 1e-8:
        return None
    return float(np.corrcoef(left_values, right_values)[0, 1])


def f1_score(expected: np.ndarray, observed: np.ndarray, valid: np.ndarray) -> float | None:
    usable = valid & np.isfinite(observed)
    if int(np.count_nonzero(expected & usable)) < 2:
        return None
    predicted = observed.astype(bool)
    true_positive = int(np.count_nonzero(expected & predicted & usable))
    false_positive = int(np.count_nonzero(~expected & predicted & usable))
    false_negative = int(np.count_nonzero(expected & ~predicted & usable))
    denominator = 2 * true_positive + false_positive + false_negative
    return (2 * true_positive / denominator) if denominator > 0 else None


def lag_measurement(
    target: np.ndarray,
    observed: np.ndarray,
    times: np.ndarray,
) -> tuple[int | None, float | None]:
    valid = np.isfinite(observed)
    if int(np.count_nonzero(valid)) < 24:
        return None, None
    frame_ms = float(np.median(np.diff(times))) * 1000.0
    if not math.isfinite(frame_ms) or frame_ms <= 0:
        return None, None
    max_shift = max(1, int(round(500.0 / frame_ms)))
    scores: list[tuple[int, float]] = []
    for shift in range(-max_shift, max_shift + 1):
        shifted = np.roll(observed, shift)
        shifted_valid = np.roll(valid, shift)
        if shift > 0:
            shifted_valid[:shift] = False
        elif shift < 0:
            shifted_valid[shift:] = False
        score = safe_correlation(target[shifted_valid], shifted[shifted_valid])
        if score is not None:
            scores.append((shift, score))
    if len(scores) < 3:
        return None, None
    scores.sort(key=lambda item: item[1], reverse=True)
    best_shift, best_score = scores[0]
    second_score = scores[1][1]
    confidence = max(0.0, min(1.0, (best_score - second_score) / max(1e-6, 1.0 - second_score)))
    # A positive result means the observed mouth follows the audio target.
    return int(round(-best_shift * frame_ms)), confidence


def finite_percentile(values: np.ndarray, percentile: float) -> float | None:
    finite = values[np.isfinite(values)]
    return float(np.percentile(finite, percentile)) if finite.size else None


def measurement(
    tracks: dict[str, np.ndarray],
    targets: dict[str, Any],
    runner_fingerprint: str,
    dialogue_sha256: str,
    evidence_policy: dict[str, Any],
    method: str = "mfa-mediapipe-de.v1",
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str, bool]:
    times = tracks["times"]
    opening = tracks["opening"]
    rounding = tracks["rounding"]
    closure = tracks["closure"]
    tracked = tracks["tracked"]
    mouth_tracked = tracks["mouthTracked"]
    multi = tracks["multi"]
    content_valid = mouth_tracked & targets["known"]
    normalized_opening = opening.copy()
    finite_opening = normalized_opening[content_valid & np.isfinite(normalized_opening)]
    if finite_opening.size >= 8:
        low, high = np.percentile(finite_opening, [10, 90])
        if high > low + 1e-8:
            normalized_opening = (normalized_opening - low) / (high - low)
    lag_ms, lag_confidence = lag_measurement(targets["opening"], normalized_opening, times)
    bilabial_valid = content_valid & targets["speech"]
    finite_closure = closure[bilabial_valid & np.isfinite(closure)]
    closure_signal_is_usable = (
        finite_closure.size >= 8
        and float(np.percentile(finite_closure, 95)) >= 0.35
        and float(np.percentile(finite_closure, 95) - np.percentile(finite_closure, 5)) >= 0.1
    )
    if closure_signal_is_usable:
        closure_threshold = max(0.35, float(np.percentile(finite_closure, 75)))
        observed_closure = closure >= closure_threshold
    else:
        closure_threshold = finite_percentile(opening[bilabial_valid], 25)
        observed_closure = (
            opening <= closure_threshold
            if closure_threshold is not None
            else np.zeros(opening.shape, dtype=bool)
        )
    bilabial_f1 = f1_score(targets["bilabial"], observed_closure, bilabial_valid)
    opening_correlation = safe_correlation(
        targets["opening"][content_valid],
        normalized_opening[content_valid],
    )
    rounding_correlation = safe_correlation(
        targets["rounded"][content_valid],
        rounding[content_valid],
    )
    movement = np.full(opening.shape, np.nan, dtype=np.float64)
    movement[1:] = np.abs(np.diff(opening))
    motion_valid = mouth_tracked & np.roll(mouth_tracked, 1) & targets["known"] & np.roll(targets["known"], 1)
    motion_valid[0] = False
    finite_movement = movement[motion_valid & np.isfinite(movement)]
    movement_threshold = max(0.0025, float(np.median(finite_movement) * 1.5)) if finite_movement.size else math.inf
    moving = movement >= movement_threshold
    speech_valid = targets["speech"] & motion_valid
    pause_valid = ~targets["speech"] & motion_valid
    speech_motion_recall = (
        float(np.count_nonzero(moving & speech_valid) / np.count_nonzero(speech_valid))
        if np.count_nonzero(speech_valid) >= 8
        else None
    )
    pause_leak_ratio = (
        float(np.count_nonzero(moving & pause_valid) / np.count_nonzero(pause_valid))
        if np.count_nonzero(pause_valid) >= 4
        else None
    )
    frame_interval = float(np.median(np.diff(times)))
    duration = min(MAX_SECONDS, float(np.count_nonzero(mouth_tracked)) * frame_interval)
    raw = {
        "method": method,
        "runnerFingerprint": runner_fingerprint,
        "expectedDialogueSha256": dialogue_sha256,
        "globalAvLagMilliseconds": lag_ms,
        "lagConfidence": lag_confidence,
        "bilabialClosureF1": bilabial_f1,
        "openingCorrelation": opening_correlation,
        "roundingCorrelation": rounding_correlation,
        "speechMotionRecall": speech_motion_recall,
        "pauseLeakRatio": pause_leak_ratio,
        "phoneCoverage": float(targets["coverage"]),
        "unknownPhones": targets["unknown"],
        "faceTrackCoverage": float(np.mean(tracked)),
        "mouthTrackCoverage": float(np.mean(mouth_tracked)),
        "multiFaceFrameRatio": float(np.mean(multi)),
        "medianBlurVariance": finite_percentile(tracks["blur"], 50),
        "yawP95Degrees": finite_percentile(tracks["yaw"], 95),
        "pitchP95Degrees": finite_percentile(tracks["pitch"], 95),
        "usableDurationSeconds": duration,
        "sampledFrames": int(times.size),
    }
    offset_status = "measured" if lag_ms is not None and lag_confidence is not None else "insufficient"
    offset = {
        "status": offset_status,
        "gatePassed": False,
        "estimatedOffsetMilliseconds": lag_ms,
        "confidence": lag_confidence,
    }
    content = {
        "status": "insufficient",
        "gatePassed": False,
        "frameMacroF1": None,
        "transitionF1": None,
    }
    evidence_issues: list[str] = []
    if raw["sampledFrames"] < evidence_policy["minimumSampledFrames"]:
        evidence_issues.append("sampled frame floor not met")
    if raw["faceTrackCoverage"] < evidence_policy["minimumFaceTrackCoverage"]:
        evidence_issues.append("face track coverage floor not met")
    if raw["mouthTrackCoverage"] < evidence_policy["minimumMouthTrackCoverage"]:
        evidence_issues.append("mouth track coverage floor not met")
    if raw["multiFaceFrameRatio"] > evidence_policy["maximumMultiFaceFrameRatio"]:
        evidence_issues.append("multiple-face ceiling exceeded")
    if raw["phoneCoverage"] < evidence_policy["minimumPhoneCoverage"]:
        evidence_issues.append("phone coverage floor not met")
    if evidence_policy["requireNoUnknownPhones"] and raw["unknownPhones"]:
        evidence_issues.append("unknown phones present")
    if raw["usableDurationSeconds"] < evidence_policy["minimumUsableDurationSeconds"]:
        evidence_issues.append("usable duration floor not met")
    if (
        raw["medianBlurVariance"] is None
        or raw["medianBlurVariance"] < evidence_policy["minimumMedianBlurVariance"]
    ):
        evidence_issues.append("image sharpness floor not met")
    if (
        raw["yawP95Degrees"] is None
        or raw["yawP95Degrees"] > evidence_policy["maximumYawP95Degrees"]
    ):
        evidence_issues.append("yaw ceiling exceeded")
    if (
        raw["pitchP95Degrees"] is None
        or raw["pitchP95Degrees"] > evidence_policy["maximumPitchP95Degrees"]
    ):
        evidence_issues.append("pitch ceiling exceeded")
    detail = "; ".join(evidence_issues) if evidence_issues else "raw evidence captured"
    return raw, offset, content, detail, not evidence_issues


def base_result(
    manifest: dict[str, Any],
    manifest_sha: str,
    status: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": "ltx-studio-mfa-mediapipe-runner.v1",
        "status": status,
        "error": reason,
        "manifestReleaseId": manifest.get("releaseId"),
        "manifestSha256": manifest_sha,
        "preprocessingVersion": manifest.get("preprocessing", {}).get("version"),
        "visemeMapVersion": manifest.get("visemeMap", {}).get("version"),
        "offset": {
            "status": "not-run",
            "estimatedOffsetMilliseconds": None,
            "confidence": None,
        },
        "measurement": None,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = Path(args.manifest).expanduser().absolute()
    video = Path(args.video).expanduser().absolute()
    if not HASH_PATTERN.fullmatch(args.expected_dialogue_sha256):
        raise ValueError("invalid dialogue hash")
    actual_dialogue_sha = hashlib.sha256(args.expected_dialogue.encode("utf-8")).hexdigest()
    if actual_dialogue_sha != args.expected_dialogue_sha256:
        raise ValueError("dialogue hash mismatch")
    manifest, components, manifest_sha = load_and_verify_manifest(manifest_path)
    if manifest_sha != args.manifest_sha256:
        raise ValueError("manifest hash mismatch")
    snapshot = component_snapshot(components)
    result: dict[str, Any]
    try:
        verify_runtime(manifest, components)
        runner_size, runner_sha = file_sha256(Path(__file__).absolute(), 2 * 1024 * 1024)
        if runner_size <= 0:
            raise ValueError("runner fingerprint unavailable")
        with tempfile.TemporaryDirectory(prefix="run-", dir=args.work_dir) as temporary:
            temp = Path(temporary)
            audio = temp / "audio.wav"
            extract_audio(video, audio)
            if manifest["method"] == "mfa-mediapipe-de.v1":
                dialogue = temp / "dialogue.txt"
                textgrid = temp / "alignment.TextGrid"
                dialogue_descriptor = os.open(
                    dialogue,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                )
                try:
                    os.write(dialogue_descriptor, args.expected_dialogue.encode("utf-8"))
                finally:
                    os.close(dialogue_descriptor)
                run_mfa(audio, dialogue, textgrid, temp / "mfa", components)
                intervals = parse_textgrid_intervals(
                    verified_read(textgrid, 4 * 1024 * 1024).decode(
                        "utf-8", errors="strict"
                    )
                )
            else:
                intervals = run_ctc_alignment(
                    audio,
                    args.expected_dialogue,
                    components,
                )
            intervals = align_intervals_to_video_timeline(
                intervals,
                stream_start_offset_seconds(video),
            )
            mapping, codes = load_viseme_mapping(components["visemeMapping"])
            timestamps = video_timestamps(video)
            tracks = track_face(video, components["faceLandmarker"], timestamps)
            targets = phone_targets(tracks["times"], intervals, mapping, codes)
            raw, offset, _content, detail, evidence_sufficient = measurement(
                tracks,
                targets,
                runner_sha,
                actual_dialogue_sha,
                manifest["evidencePolicy"],
                manifest["method"],
            )
        verify_component_snapshot(components, snapshot)
        method_label = (
            "MFA/MediaPipe"
            if manifest["method"] == "mfa-mediapipe-de.v1"
            else "CTC/eSpeak/MediaPipe"
        )
        reason = (
            f"{method_label} measurement-only: {detail}. "
            f"Product-GO remains blocked: {manifest['productGo']['reason']}"
        )
        result = base_result(
            manifest,
            manifest_sha,
            "measurement-only" if evidence_sufficient else "insufficient",
            reason,
        )
        result["offset"] = offset
        result["offset"].pop("gatePassed", None)
        result["measurement"] = raw
    except InsufficientEvidence as error:
        reason = f"Phoneme/viseme evidence insufficient: {error}"
        result = base_result(manifest, manifest_sha, "insufficient", reason)
    except Exception as error:
        reason = f"Phoneme/viseme evaluator failed: {type(error).__name__}: {error}"
        result = base_result(manifest, manifest_sha, "failed", reason)
    try:
        verify_component_snapshot(components, snapshot)
    except Exception as error:
        reason = f"Phoneme/viseme evaluator evidence changed: {type(error).__name__}: {error}"
        result = base_result(manifest, manifest_sha, "failed", reason)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--work-dir", required=True)
    cli = parser.parse_args()
    work_dir = Path(cli.work_dir).absolute()
    work_stat = work_dir.lstat()
    if not stat.S_ISDIR(work_stat.st_mode) or work_dir.is_symlink():
        raise ValueError("work directory is not a private regular directory")
    if stat.S_IMODE(work_stat.st_mode) & 0o077:
        raise ValueError("work directory permissions are too broad")
    request = read_strict_json(Path(cli.request).absolute())
    expected_keys = {
        "schemaVersion",
        "manifestPath",
        "manifestSha256",
        "videoPath",
        "expectedDialogue",
        "expectedDialogueSha256",
    }
    if not isinstance(request, dict) or set(request) != expected_keys:
        raise ValueError("invalid measurement request")
    if request.get("schemaVersion") != "ltx-studio-mfa-mediapipe-request.v1":
        raise ValueError("unsupported measurement request")
    if not all(
        isinstance(request.get(key), str)
        for key in expected_keys - {"schemaVersion"}
    ):
        raise ValueError("measurement request fields must be strings")
    return argparse.Namespace(
        manifest=request["manifestPath"],
        manifest_sha256=request["manifestSha256"],
        video=request["videoPath"],
        expected_dialogue=request["expectedDialogue"],
        expected_dialogue_sha256=request["expectedDialogueSha256"],
        work_dir=str(work_dir),
    )


def main() -> int:
    args = parse_args()
    try:
        result = run(args)
        print(json.dumps(result, allow_nan=False, separators=(",", ":"), sort_keys=True))
        return 0
    except Exception as error:
        print(f"phoneme-viseme runner bootstrap failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
