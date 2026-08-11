"""Rights-bound, leakage-safe dataset freezes for AV evaluator training."""

from __future__ import annotations

import ast
import errno
import hashlib
import io
import json
import math
import os
import stat
import struct
import subprocess
import tempfile
import unicodedata
import wave
import zipfile
from collections import defaultdict
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from typing import Any, BinaryIO, Literal

SCHEMA_VERSION = "ltx-av-eval-dataset-freeze.v2"
SAMPLE_SCHEMA_VERSION = "ltx-av-eval-sample.v1"
RIGHTS_SCHEMA_VERSION = "ltx-av-eval-rights.v1"
PREREGISTRATION_SCHEMA_VERSION = "ltx-av-eval-preregistration.v2"
TIMELINE_SCHEMA_VERSION = "ltx-av-eval-phoneme-timeline.v1"
MAPPING_SCHEMA_VERSION = "ltx-studio-viseme-mapping.v1"
RIGHTS_ATTESTATION_SCHEMA_VERSION = "ltx-av-eval-rights-attestation.v1"
PREPROCESSING_VERSION = "mouth-npz-rgb96-audio-wav16k-cfr.v2"
FFMPEG_PATH = Path("/usr/bin/ffmpeg")
FFMPEG_SHA256 = "9f126bd755615d8c5d9aa2e67c568626be05389feb795478e0f14d41217270f4"
FFPROBE_PATH = Path("/usr/bin/ffprobe")
FFPROBE_SHA256 = "b98cabc72a01bf522a3eb85cae3cf7a8843817bfb0315ff14d8699cef5413f7d"
# This digest is updated only by reviewed code changes after the preregistration is
# externally approved. The corresponding split seed is intentionally absent here.
TRUSTED_PREREGISTRATION_SHA256 = "ab95c00f6c1a365262dbb43805166f59a85eb1f2dccbf44f78c9b54ad5419363"
SPLITS = ("train", "tune", "design-pilot", "calibration", "test")
OOD_KINDS = (
    "silence",
    "mouth-occluded",
    "no-active-speaker",
    "music",
    "multiple-speakers",
    "offscreen-speech",
    "synthetic-training-source",
)
GROUP_FIELDS = (
    "voice_speaker_id",
    "face_identity_id",
    "source_asset_id",
    "source_collection_id",
    "recording_session_id",
    "utterance_id",
    "derivative_group_id",
    "rights_source_id",
    "rights_bundle_id",
)
HASH_GROUP_FIELDS = (
    "media_sha256",
    "decoded_pcm_sha256",
    "mouth_frames_sha256",
    "perceptual_fingerprint_sha256",
)
COMMITMENT_HASH_FIELDS = (
    "model_recipe_sha256",
    "initial_weights_sha256",
    "training_runner_sha256",
    "evaluation_runner_sha256",
    "hyperparameter_search_space_sha256",
    "prompt_set_sha256",
    "rating_protocol_sha256",
    "baseline_matrix_sha256",
)
REQUIRED_RIGHTS = (
    "training_allowed",
    "feature_extraction_allowed",
    "face_biometric_processing_allowed",
    "voice_biometric_processing_allowed",
    "derived_weights_allowed",
    "commercial_use_allowed",
    "redistribution_allowed",
    "adult_confirmed",
    "legal_approved",
)
MAX_JSONL_BYTES = 64 * 1024 * 1024
MAX_EVIDENCE_BYTES = 256 * 1024 * 1024
MAX_MEDIA_BYTES = 8 * 1024 * 1024 * 1024
MAX_DECODED_AUDIO_BYTES = 5 * 16_000 * 2
MAX_RIGHTS_ATTESTATION_AGE_SECONDS = 5 * 60
MOUTH_FRAME_HEIGHT = 96
MOUTH_FRAME_WIDTH = 96
MOUTH_FRAME_CHANNELS = 3
PERCEPTUAL_FINGERPRINT_LENGTH = 256
ARTIFACT_PATH_FIELDS = (
    ("media_path", "media_sha256", MAX_MEDIA_BYTES),
    ("decoded_pcm_path", "decoded_pcm_sha256", MAX_DECODED_AUDIO_BYTES + 4096),
    ("mouth_frames_path", "mouth_frames_sha256", MAX_MEDIA_BYTES),
    ("perceptual_fingerprint_path", "perceptual_fingerprint_sha256", MAX_EVIDENCE_BYTES),
    ("phoneme_timeline_path", "phoneme_timeline_sha256", MAX_EVIDENCE_BYTES),
)
SPLIT_RATIOS = {"train": 0.60, "tune": 0.10, "design-pilot": 0.10, "calibration": 0.10, "test": 0.10}
AUTHORIZATION_CONTRACT = {
    "evaluation_authorization": "external-ed25519-after-f0-before-q2.v1",
    "release_authorization": "external-ed25519-after-q2-before-product-go.v2",
    "evaluation_is_not_release": True,
}
RELEASE_GATES = {
    "offset": {
        "median_absolute_error_ms_max": 20,
        "p95_absolute_error_ms_max": 40,
        "bootstrap95_upper_ms_max": 40,
        "within_one_frame_accuracy_min": 0.95,
        "worst_stratum_within_one_frame_accuracy_min": 0.90,
        "false_accept_rate_max": 0.01,
        "false_reject_rate_max": 0.05,
        "worst_stratum_false_accept_rate_max": 0.03,
        "worst_stratum_false_reject_rate_max": 0.10,
        "calibration_ece_max": 0.05,
        "brier_score_max": 0.10,
        "ood_abstention_recall_min": 0.95,
        "in_domain_false_abstention_rate_max": 0.05,
    },
    "content": {
        "frame_macro_f1_min": 0.85,
        "worst_stratum_frame_macro_f1_min": 0.75,
        "bootstrap95_lower_frame_macro_f1_min": 0.82,
        "worst_stratum_bootstrap95_lower_frame_macro_f1_min": 0.72,
        "transition_f1_min": 0.90,
        "worst_stratum_transition_f1_min": 0.80,
        "bootstrap95_lower_transition_f1_min": 0.87,
        "worst_stratum_bootstrap95_lower_transition_f1_min": 0.77,
    },
    "subgroups": {
        "minimum_test_clips": 90,
        "minimum_test_identities": 30,
        "minimum_test_voice_speakers": 30,
        "minimum_test_leakage_components": 30,
        "minimum_clips_per_language": 30,
        "minimum_identities_per_language": 10,
        "minimum_clips_per_gender_group": 10,
        "minimum_clips_per_age_band": 10,
        "minimum_clips_per_skin_tone": 6,
        "minimum_clips_per_speech_rate_bucket": 15,
        "minimum_clips_per_source_domain": 15,
        "minimum_clips_per_ood_kind": 5,
        "worst_language_macro_f1_min": 0.80,
        "maximum_language_macro_f1_gap": 0.05,
    },
    "independence": {
        "test_annotations_blinded": True,
        "test_split_sealed": True,
        "no_threshold_tuning_on_test": True,
    },
}
CLAIM_DOMAIN = {
    "languages": ["de", "en"],
    "duration_seconds": {"minimum": 2, "maximum": 5},
    "frame_rates": [24, 25, 30],
    "speech_rate_wpm": {"minimum": 65, "maximum": 220},
    "head_motion": ["static", "light"],
    "lighting": ["standard", "difficult"],
    "gender_groups": ["female", "male", "nonbinary", "not-disclosed"],
    "age_bands": ["18-29", "30-44", "45-59", "60-plus"],
    "skin_tone_fitzpatrick": [1, 2, 3, 4, 5, 6],
    "source_domains": ["consented-recording", "ltx-generated-product-output"],
    "absolute_yaw_degrees_max": 20,
    "mouth_visible_ratio_min": 0.99,
    "single_speaker_required": True,
    "music_allowed": False,
    "cuts_allowed": False,
    "ood_kinds": list(OOD_KINDS),
}
PRODUCT_PROFILE_ENABLED = False


class GovernanceError(ValueError):
    """Raised when rights, integrity, or split invariants are not satisfied."""


class _UnionFind:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if left_root < right_root:
            self.parent[right_root] = left_root
        else:
            self.parent[left_root] = right_root


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise GovernanceError(f"Doppelter JSON-Schlüssel: {key}")
        result[key] = value
    return result


def _load_json(path: Path) -> object:
    raw = _read_regular(path, MAX_JSONL_BYTES)
    return _parse_json_bytes(raw, str(path))


def _parse_json_bytes(raw: bytes, context: str) -> object:
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda value: (_ for _ in ()).throw(GovernanceError(f"Nicht-endliche JSON-Zahl: {value}")),
        )
    except UnicodeDecodeError as error:
        raise GovernanceError(f"JSON ist nicht UTF-8: {context}") from error
    except json.JSONDecodeError as error:
        raise GovernanceError(f"Ungültiges JSON in {context}: {error}") from error


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    raw = _read_regular(path, MAX_JSONL_BYTES)
    records: list[dict[str, Any]] = []
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise GovernanceError(f"JSONL ist nicht UTF-8: {path}") from error
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(
                line,
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=lambda item: (_ for _ in ()).throw(GovernanceError(f"Nicht-endliche JSON-Zahl: {item}")),
            )
        except json.JSONDecodeError as error:
            raise GovernanceError(f"Ungültiges JSONL in {path}, Zeile {line_number}: {error}") from error
        if not isinstance(value, dict):
            raise GovernanceError(f"JSONL-Zeile {line_number} ist kein Objekt: {path}")
        records.append(value)
    if not records:
        raise GovernanceError(f"JSONL enthält keine Datensätze: {path}")
    return records


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_regular(path: Path, maximum_bytes: int) -> bytes:
    try:
        before = path.lstat()
    except OSError as error:
        raise GovernanceError(f"Datei nicht lesbar: {path}: {error}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise GovernanceError(f"Nur reguläre Nicht-Symlink-Dateien sind erlaubt: {path}")
    if before.st_size <= 0 or before.st_size > maximum_bytes:
        raise GovernanceError(f"Dateigröße außerhalb des Limits: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or opened.st_size != before.st_size
            or opened.st_mtime_ns != before.st_mtime_ns
            or opened.st_ctime_ns != before.st_ctime_ns
        ):
            raise GovernanceError(f"Datei wurde während der Prüfung verändert: {path}")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise GovernanceError(f"Datei konnte nicht vollständig gelesen werden: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise GovernanceError(f"Datei wurde während des Lesens verändert: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _hash_regular(path: Path, maximum_bytes: int) -> str:
    try:
        before = path.lstat()
    except OSError as error:
        raise GovernanceError(f"Datei nicht lesbar: {path}: {error}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise GovernanceError(f"Nur reguläre Nicht-Symlink-Dateien sind erlaubt: {path}")
    if before.st_size <= 0 or before.st_size > maximum_bytes:
        raise GovernanceError(f"Dateigröße außerhalb des Limits: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or opened.st_size != before.st_size
            or opened.st_mtime_ns != before.st_mtime_ns
            or opened.st_ctime_ns != before.st_ctime_ns
        ):
            raise GovernanceError(f"Datei wurde während der Prüfung verändert: {path}")
        digest = hashlib.sha256()
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise GovernanceError(f"Datei konnte nicht vollständig gehasht werden: {path}")
            digest.update(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise GovernanceError(f"Datei wurde während des Hashens verändert: {path}")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def load_split_seed(path: Path) -> str:
    """Read a split seed from an owner-only regular file without following links."""

    try:
        metadata = path.lstat()
    except OSError as error:
        raise GovernanceError(f"Split-Seed-Datei ist nicht lesbar: {path}: {error}") from error
    raw = _read_regular(path, 1024)
    try:
        after = path.lstat()
    except OSError as error:
        raise GovernanceError(f"Split-Seed-Datei wurde während der Prüfung entfernt: {path}") from error
    if (
        metadata.st_dev != after.st_dev
        or metadata.st_ino != after.st_ino
        or metadata.st_ctime_ns != after.st_ctime_ns
        or after.st_uid != os.geteuid()
        or stat.S_IMODE(after.st_mode) != 0o600
    ):
        raise GovernanceError("Split-Seed-Datei muss stabil dem aktuellen Benutzer gehören und Modus 0600 haben.")
    try:
        seed = raw.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise GovernanceError("Split-Seed-Datei muss UTF-8 enthalten.") from error
    if not seed or len(seed) > 200 or any(character.isspace() for character in seed):
        raise GovernanceError("Split-Seed-Datei muss genau ein Secret mit 1 bis 200 Zeichen enthalten.")
    return seed


def _expect_exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    extra = sorted(value.keys() - expected)
    if missing or extra:
        raise GovernanceError(f"{context}: fehlend={missing}, unbekannt={extra}")


def _expect_identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise GovernanceError(f"{context} muss eine pseudonymisierte ID mit 3 bis 128 Zeichen sein.")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    if any(character not in allowed for character in value):
        raise GovernanceError(f"{context} enthält unzulässige Zeichen.")
    return value


def _expect_sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise GovernanceError(f"{context} muss eine kleingeschriebene SHA-256 sein.")
    return value


def _relative_parts(value: object, context: str) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or "\\" in value:
        raise GovernanceError(f"{context} muss ein normalisierter relativer Pfad sein.")
    relative = Path(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise GovernanceError(f"{context} muss innerhalb des Dataset-Roots liegen.")
    return relative.parts


def _open_relative_regular(
    root: Path,
    value: object,
    context: str,
    maximum_bytes: int,
) -> tuple[int, list[int], os.stat_result]:
    parts = _relative_parts(value, context)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
    directory_descriptors: list[int] = []
    try:
        current = os.open(root.resolve(strict=True), directory_flags)
        directory_descriptors.append(current)
        for part in parts[:-1]:
            current = os.open(part, directory_flags, dir_fd=current)
            directory_descriptors.append(current)
        try:
            descriptor = os.open(parts[-1], flags, dir_fd=current)
        except OSError as error:
            raise GovernanceError(f"{context} ist nicht sicher lesbar: {value}: {error}") from error
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            os.close(descriptor)
            raise GovernanceError(f"{context} ist keine reguläre Datei: {value}")
        if opened.st_size <= 0 or opened.st_size > maximum_bytes:
            os.close(descriptor)
            raise GovernanceError(f"{context} hat eine Dateigröße außerhalb des Limits: {value}")
        return descriptor, directory_descriptors, opened
    except OSError as error:
        for directory_descriptor in reversed(directory_descriptors):
            os.close(directory_descriptor)
        raise GovernanceError(
            f"{context} enthält eine unsichere Symlink-Komponente oder Pfadkomponente: {value}: {error}"
        ) from error
    except Exception:
        for directory_descriptor in reversed(directory_descriptors):
            os.close(directory_descriptor)
        raise


def _close_descriptors(descriptor: int, directory_descriptors: list[int]) -> None:
    os.close(descriptor)
    for directory_descriptor in reversed(directory_descriptors):
        os.close(directory_descriptor)


def _read_relative_regular(root: Path, value: object, context: str, maximum_bytes: int) -> bytes:
    descriptor, directories, opened = _open_relative_regular(root, value, context, maximum_bytes)
    try:
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise GovernanceError(f"{context} konnte nicht vollständig gelesen werden: {value}")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise GovernanceError(f"{context} wurde während des Lesens verändert: {value}")
        return b"".join(chunks)
    finally:
        _close_descriptors(descriptor, directories)


def _hash_relative_regular(root: Path, value: object, context: str, maximum_bytes: int) -> str:
    descriptor, directories, opened = _open_relative_regular(root, value, context, maximum_bytes)
    try:
        digest = hashlib.sha256()
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise GovernanceError(f"{context} konnte nicht vollständig gehasht werden: {value}")
            digest.update(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise GovernanceError(f"{context} wurde während des Hashens verändert: {value}")
        return digest.hexdigest()
    finally:
        _close_descriptors(descriptor, directories)


def _validate_preprocessing_tools() -> None:
    for path, expected_sha256, name in (
        (FFMPEG_PATH, FFMPEG_SHA256, "ffmpeg"),
        (FFPROBE_PATH, FFPROBE_SHA256, "ffprobe"),
    ):
        if _hash_regular(path, MAX_EVIDENCE_BYTES) != expected_sha256:
            raise GovernanceError(f"{name} entspricht nicht der preregistrierten DGX-Binary.")


def _run_media_tool(
    executable: Path,
    arguments: list[str],
    *,
    descriptor: int,
    context: str,
    maximum_stdout_bytes: int,
) -> bytes:
    try:
        result = subprocess.run(
            [str(executable), *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(descriptor,),
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GovernanceError(f"{context} konnte nicht mit {executable.name} geprüft werden: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[-1000:]
        raise GovernanceError(f"{context} ist kein dekodierbares Medienartefakt: {detail}")
    if len(result.stdout) > maximum_stdout_bytes:
        raise GovernanceError(f"{context} überschreitet das erlaubte Decode-Limit.")
    return result.stdout


def _parse_frame_rate(value: object) -> float:
    if not isinstance(value, str) or "/" not in value:
        raise GovernanceError("ffprobe lieferte keine gültige Bildrate.")
    numerator_text, denominator_text = value.split("/", 1)
    try:
        numerator = int(numerator_text)
        denominator = int(denominator_text)
    except ValueError as error:
        raise GovernanceError("ffprobe lieferte keine gültige Bildrate.") from error
    if numerator <= 0 or denominator <= 0:
        raise GovernanceError("ffprobe lieferte keine positive Bildrate.")
    return numerator / denominator


def _probe_media(
    root: Path,
    value: object,
    *,
    expected_duration_us: int,
    expected_fps: int,
) -> bytes:
    descriptor, directories, opened = _open_relative_regular(root, value, "media_path", MAX_MEDIA_BYTES)
    try:
        probe_raw = _run_media_tool(
            FFPROBE_PATH,
            [
                "-v",
                "error",
                "-show_entries",
                (
                    "format=duration:"
                    "stream=index,codec_type,avg_frame_rate,nb_read_frames:"
                    "frame=media_type,best_effort_timestamp_time"
                ),
                "-count_frames",
                "-show_frames",
                "-of",
                "json",
                f"/proc/self/fd/{descriptor}",
            ],
            descriptor=descriptor,
            context="Quellvideo",
            maximum_stdout_bytes=1024 * 1024,
        )
        try:
            probe = json.loads(probe_raw)
            streams = probe["streams"]
            frames = probe["frames"]
            duration_seconds = float(probe["format"]["duration"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise GovernanceError("ffprobe lieferte keine vollständigen Medienmetadaten.") from error
        video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
        audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
        if len(video_streams) != 1 or len(audio_streams) != 1:
            raise GovernanceError("Quellvideo benötigt genau einen Video- und einen Audio-Stream.")
        observed_fps = _parse_frame_rate(video_streams[0].get("avg_frame_rate"))
        if not math.isclose(observed_fps, expected_fps, rel_tol=0, abs_tol=0.001):
            raise GovernanceError("Quellvideo-Bildrate stimmt nicht mit strata.fps überein.")
        try:
            observed_frame_count = int(video_streams[0]["nb_read_frames"])
        except (KeyError, TypeError, ValueError) as error:
            raise GovernanceError("ffprobe konnte die dekodierbaren Videoframes nicht zählen.") from error
        expected_frame_count = round(expected_duration_us * expected_fps / 1_000_000)
        if observed_frame_count != expected_frame_count:
            raise GovernanceError("Quellvideo-Framezahl stimmt nicht mit Sampledauer und CFR überein.")
        try:
            video_timestamps = [
                float(frame["best_effort_timestamp_time"]) for frame in frames if frame.get("media_type") == "video"
            ]
        except (KeyError, TypeError, ValueError) as error:
            raise GovernanceError("ffprobe lieferte keine vollständigen Video-Zeitstempel.") from error
        if len(video_timestamps) != expected_frame_count:
            raise GovernanceError("Quellvideo-Zeitstempel decken nicht alle dekodierbaren Frames ab.")
        expected_step = 1 / expected_fps
        if not math.isclose(video_timestamps[0], 0, rel_tol=0, abs_tol=0.0011) or any(
            not math.isclose(right - left, expected_step, rel_tol=0, abs_tol=0.0011)
            for left, right in pairwise(video_timestamps)
        ):
            raise GovernanceError("Quellvideo ist nicht CFR oder beginnt nicht bei PTS 0.")
        expected_duration_seconds = expected_duration_us / 1_000_000
        if not math.isclose(
            duration_seconds,
            expected_duration_seconds,
            rel_tol=0,
            abs_tol=max(0.02, 1 / expected_fps),
        ):
            raise GovernanceError("Quellvideo-Dauer stimmt nicht mit der Sampledauer überein.")
        os.lseek(descriptor, 0, os.SEEK_SET)
        decoded_pcm = _run_media_tool(
            FFMPEG_PATH,
            [
                "-v",
                "error",
                "-i",
                f"/proc/self/fd/{descriptor}",
                "-map",
                "0:a:0",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "s16le",
                "pipe:1",
            ],
            descriptor=descriptor,
            context="Quellvideo-Audio",
            maximum_stdout_bytes=MAX_DECODED_AUDIO_BYTES,
        )
        after = os.fstat(descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise GovernanceError("Quellvideo wurde während der Dekodierung verändert.")
        return decoded_pcm
    finally:
        _close_descriptors(descriptor, directories)


def _validate_decoded_pcm(raw: bytes, *, duration_us: int) -> bytes:
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            if (
                wav.getnchannels() != 1
                or wav.getsampwidth() != 2
                or wav.getframerate() != 16_000
                or wav.getcomptype() != "NONE"
            ):
                raise GovernanceError("Decoded-PCM muss unkomprimiertes Mono-PCM16 mit 16 kHz sein.")
            expected_frames = round(duration_us * 16_000 / 1_000_000)
            if wav.getnframes() != expected_frames:
                raise GovernanceError("Decoded-PCM-Länge stimmt nicht mit der Sampledauer überein.")
            frames = wav.readframes(expected_frames)
            if len(frames) != expected_frames * 2:
                raise GovernanceError("Decoded-PCM enthält nicht alle deklarierten Samples.")
            return frames
    except (EOFError, wave.Error) as error:
        raise GovernanceError("Decoded-PCM ist keine gültige WAV-Datei.") from error


def _parse_npy(raw: bytes, context: str) -> tuple[str, tuple[int, ...], bytes]:
    if not raw.startswith(b"\x93NUMPY") or len(raw) < 10:
        raise GovernanceError(f"{context} enthält keinen gültigen NPY-Header.")
    major, minor = raw[6], raw[7]
    if (major, minor) == (1, 0):
        header_length_size = 2
    elif major in {2, 3} and minor == 0:
        header_length_size = 4
    else:
        raise GovernanceError(f"{context} verwendet eine nicht unterstützte NPY-Version.")
    header_start = 8 + header_length_size
    if len(raw) < header_start:
        raise GovernanceError(f"{context} enthält einen abgeschnittenen NPY-Header.")
    header_length = int.from_bytes(raw[8:header_start], "little")
    payload_start = header_start + header_length
    if header_length <= 0 or payload_start > len(raw):
        raise GovernanceError(f"{context} enthält einen ungültigen NPY-Header.")
    try:
        header = ast.literal_eval(raw[header_start:payload_start].decode("latin-1").strip())
    except (SyntaxError, ValueError, UnicodeDecodeError) as error:
        raise GovernanceError(f"{context} enthält keinen parsebaren NPY-Header.") from error
    if not isinstance(header, dict) or set(header) != {"descr", "fortran_order", "shape"}:
        raise GovernanceError(f"{context} enthält ein unbekanntes NPY-Schema.")
    shape = header["shape"]
    if (
        not isinstance(header["descr"], str)
        or header["fortran_order"] is not False
        or not isinstance(shape, tuple)
        or not all(isinstance(dimension, int) and dimension > 0 for dimension in shape)
    ):
        raise GovernanceError(f"{context} enthält ungültige NPY-Metadaten.")
    return header["descr"], shape, raw[payload_start:]


def _validate_mouth_frames(raw: bytes, *, duration_us: int, fps: int) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
            members = archive.infolist()
            if len(members) != 1 or members[0].filename != "frames.npy" or members[0].is_dir():
                raise GovernanceError("Mundframes-NPZ muss ausschließlich frames.npy enthalten.")
            member = members[0]
            expected_frames = round(duration_us * fps / 1_000_000)
            expected_payload_bytes = expected_frames * MOUTH_FRAME_HEIGHT * MOUTH_FRAME_WIDTH * MOUTH_FRAME_CHANNELS
            if member.file_size > expected_payload_bytes + 4096:
                raise GovernanceError("Mundframes-NPZ überschreitet die erwartete entpackte Größe.")
            npy_raw = archive.read(member)
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        raise GovernanceError("Mundframes sind kein gültiges NPZ-Archiv.") from error
    descriptor, shape, payload = _parse_npy(npy_raw, "Mundframes")
    expected_shape = (expected_frames, MOUTH_FRAME_HEIGHT, MOUTH_FRAME_WIDTH, MOUTH_FRAME_CHANNELS)
    if descriptor != "|u1" or shape != expected_shape or len(payload) != expected_payload_bytes:
        raise GovernanceError("Mundframes müssen CFR-RGB96-uint8 mit der exakten Sampledauer enthalten.")


def _validate_perceptual_fingerprint(raw: bytes) -> None:
    descriptor, shape, payload = _parse_npy(raw, "Perzeptionsfingerprint")
    if descriptor != "<f4" or shape != (PERCEPTUAL_FINGERPRINT_LENGTH,) or len(payload) != 4 * shape[0]:
        raise GovernanceError("Perzeptionsfingerprint muss ein little-endian float32-Vektor der Länge 256 sein.")
    values = [value[0] for value in struct.iter_unpack("<f", payload)]
    if not all(math.isfinite(value) for value in values):
        raise GovernanceError("Perzeptionsfingerprint enthält nicht-endliche Werte.")
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isclose(norm, 1, rel_tol=0, abs_tol=0.001):
        raise GovernanceError("Perzeptionsfingerprint muss L2-normalisiert sein.")


def _validate_timeline_identity(
    timeline: dict[str, Any],
    sample: dict[str, Any],
    checked_at: datetime,
) -> None:
    if timeline["schema_version"] != TIMELINE_SCHEMA_VERSION:
        raise GovernanceError("Unbekannte Phonem-Timeline-Schemaversion.")
    if timeline["sample_id"] != sample["sample_id"] or timeline["language"] != sample["language"]:
        raise GovernanceError(f"Phonem-Timeline gehört nicht zum Sample: {sample['sample_id']}")
    if timeline["time_base"] != "sample-relative-us":
        raise GovernanceError("Phonem-Timeline muss sample-relative-us verwenden.")
    if timeline["verification_status"] != "human-verified":
        raise GovernanceError("Phonem-Timeline benötigt den Status human-verified.")
    annotator_id = _expect_identifier(timeline["annotator_id"], "annotator_id")
    verifier_id = _expect_identifier(timeline["verifier_id"], "verifier_id")
    adjudicator_id = _expect_identifier(timeline["adjudicator_id"], "adjudicator_id")
    if len({annotator_id, verifier_id, adjudicator_id}) != 3:
        raise GovernanceError("Annotation, Verifikation und Adjudikation benötigen verschiedene IDs.")
    if timeline["annotation_guideline_version"] != "ltx-av-phoneme-guideline.v1":
        raise GovernanceError("Phonem-Timeline bindet nicht die freigegebene Annotationsrichtlinie.")
    if timeline["adjudication_status"] != "independently-adjudicated":
        raise GovernanceError("Phonem-Timeline benötigt unabhängige Adjudikation.")
    verified_at = _parse_datetime(timeline["verified_at"], "verified_at")
    if verified_at is None or verified_at > checked_at:
        raise GovernanceError("verified_at darf nicht in der Zukunft liegen.")
    expected_transcript_sha256 = _sha256_bytes(sample["transcript"].encode("utf-8"))
    if timeline["transcript_sha256"] != expected_transcript_sha256:
        raise GovernanceError(f"Transcript-Hash stimmt nicht: {sample['sample_id']}")
    if timeline["decoded_pcm_sha256"] != sample["decoded_pcm_sha256"]:
        raise GovernanceError(f"Timeline bindet nicht das geprüfte Decoded-PCM: {sample['sample_id']}")


def _validate_timeline_intervals(
    intervals: object,
    *,
    duration_us: int,
    allowed_phones: set[str],
) -> tuple[set[str], int]:
    if not isinstance(intervals, list) or not intervals:
        raise GovernanceError("Phonem-Timeline benötigt mindestens ein Intervall.")
    expected_start_us = 0
    observed_phones: set[str] = set()
    speech_interval_count = 0
    for index, interval in enumerate(intervals):
        if not isinstance(interval, dict):
            raise GovernanceError(f"Phonemintervall {index} ist kein Objekt.")
        _expect_exact_keys(interval, {"phone", "start_us", "end_us"}, f"Phonemintervall {index}")
        phone = interval["phone"]
        if not isinstance(phone, str) or unicodedata.normalize("NFC", phone) != phone or phone not in allowed_phones:
            raise GovernanceError(f"Phonemintervall {index} enthält ein unbekanntes Phone: {phone}")
        if (
            not isinstance(interval["start_us"], int)
            or isinstance(interval["start_us"], bool)
            or not isinstance(interval["end_us"], int)
            or isinstance(interval["end_us"], bool)
        ):
            raise GovernanceError(f"Phonemintervall {index} benötigt ganzzahlige Mikrosekunden.")
        if interval["start_us"] != expected_start_us or interval["end_us"] <= interval["start_us"]:
            raise GovernanceError(f"Phonemintervall {index} enthält eine Lücke, Überlappung oder leere Dauer.")
        if phone not in {"<eps>", "sil", "sp"}:
            speech_interval_count += 1
            if interval["end_us"] - interval["start_us"] > 750_000:
                raise GovernanceError(f"Sprachphonemintervall {index} ist unplausibel lang.")
        observed_phones.add(phone)
        expected_start_us = interval["end_us"]
    if expected_start_us != duration_us:
        raise GovernanceError("Phonem-Timeline muss die vollständige Sampledauer lückenlos abdecken.")
    return observed_phones, speech_interval_count


def _validate_timeline(
    timeline: object,
    *,
    sample: dict[str, Any],
    allowed_phones: set[str],
    checked_at: datetime,
) -> None:
    if not isinstance(timeline, dict):
        raise GovernanceError(f"Phonem-Timeline ist kein JSON-Objekt: {sample['phoneme_timeline_path']}")
    _expect_exact_keys(
        timeline,
        {
            "schema_version",
            "sample_id",
            "language",
            "time_base",
            "verification_status",
            "annotation_guideline_version",
            "adjudication_status",
            "annotator_id",
            "verifier_id",
            "adjudicator_id",
            "verified_at",
            "transcript_sha256",
            "decoded_pcm_sha256",
            "intervals",
        },
        "Phonem-Timeline",
    )
    _validate_timeline_identity(timeline, sample, checked_at)
    observed_phones, speech_interval_count = _validate_timeline_intervals(
        timeline["intervals"],
        duration_us=sample["end_us"] - sample["start_us"],
        allowed_phones=allowed_phones,
    )
    speech_phones = observed_phones - {"<eps>", "sil", "sp"}
    if sample["strata"]["ood_kind"] is None and (len(speech_phones) < 2 or speech_interval_count < 3):
        raise GovernanceError(
            "In-Domain-Sprache benötigt mindestens drei plausible Intervalle aus zwei Sprachphonemen."
        )
    if sample["strata"]["ood_kind"] == "silence" and not observed_phones <= {"<eps>", "sil", "sp"}:
        raise GovernanceError("OOD-Stratum silence darf keine Sprachphoneme enthalten.")


def _validate_strata_labels(raw: dict[str, Any]) -> None:
    if raw["fps"] not in {24, 25, 30}:
        raise GovernanceError("strata.fps muss 24, 25 oder 30 sein.")
    if raw["head_motion"] not in {"static", "light"}:
        raise GovernanceError("strata.head_motion muss static oder light sein.")
    if raw["lighting"] not in {"standard", "difficult"}:
        raise GovernanceError("strata.lighting muss standard oder difficult sein.")
    if raw["gender_group"] not in set(CLAIM_DOMAIN["gender_groups"]):
        raise GovernanceError("Unbekannte gender_group.")
    if raw["age_band"] not in set(CLAIM_DOMAIN["age_bands"]):
        raise GovernanceError("Unbekanntes age_band.")
    if raw["skin_tone_fitzpatrick"] not in set(CLAIM_DOMAIN["skin_tone_fitzpatrick"]):
        raise GovernanceError("skin_tone_fitzpatrick muss 1 bis 6 sein.")
    if raw["source_domain"] not in {
        *CLAIM_DOMAIN["source_domains"],
        "synthetic-negative",
    }:
        raise GovernanceError("Unbekannte source_domain.")
    if raw["ood_kind"] not in {None, *OOD_KINDS}:
        raise GovernanceError("Unbekanntes OOD-Stratum.")


def _validate_strata_numeric(raw: dict[str, Any]) -> None:
    if (
        not isinstance(raw["speech_rate_wpm"], int)
        or isinstance(raw["speech_rate_wpm"], bool)
        or not 0 <= raw["speech_rate_wpm"] <= 220
    ):
        raise GovernanceError("strata.speech_rate_wpm muss 0 bis 220 sein.")
    if (
        not isinstance(raw["absolute_yaw_degrees_max"], (int, float))
        or isinstance(raw["absolute_yaw_degrees_max"], bool)
        or not math.isfinite(raw["absolute_yaw_degrees_max"])
        or not 0 <= raw["absolute_yaw_degrees_max"] <= 180
    ):
        raise GovernanceError("strata.absolute_yaw_degrees_max muss 0 bis 180 Grad sein.")
    if (
        not isinstance(raw["mouth_visible_ratio"], (int, float))
        or isinstance(raw["mouth_visible_ratio"], bool)
        or not math.isfinite(raw["mouth_visible_ratio"])
        or not 0 <= raw["mouth_visible_ratio"] <= 1
    ):
        raise GovernanceError("strata.mouth_visible_ratio muss 0 bis 1 sein.")
    if (
        not isinstance(raw["speaker_count"], int)
        or isinstance(raw["speaker_count"], bool)
        or not 0 <= raw["speaker_count"] <= 20
    ):
        raise GovernanceError("strata.speaker_count muss 0 bis 20 sein.")
    if not isinstance(raw["has_music"], bool):
        raise GovernanceError("strata.has_music muss boolesch sein.")
    if not isinstance(raw["cut_count"], int) or isinstance(raw["cut_count"], bool) or not 0 <= raw["cut_count"] <= 100:
        raise GovernanceError("strata.cut_count muss 0 bis 100 sein.")


def _validate_strata_evidence(raw: dict[str, Any]) -> None:
    if (
        not isinstance(raw["mouth_occlusion_ratio"], (int, float))
        or isinstance(raw["mouth_occlusion_ratio"], bool)
        or not math.isfinite(raw["mouth_occlusion_ratio"])
        or not 0 <= raw["mouth_occlusion_ratio"] <= 1
    ):
        raise GovernanceError("strata.mouth_occlusion_ratio muss 0 bis 1 sein.")
    if not isinstance(raw["active_speaker_visible"], bool):
        raise GovernanceError("strata.active_speaker_visible muss boolesch sein.")
    if not isinstance(raw["offscreen_speech"], bool):
        raise GovernanceError("strata.offscreen_speech muss boolesch sein.")


def _validate_strata_claim_domain(raw: dict[str, Any]) -> None:
    if raw["ood_kind"] is None and (
        raw["absolute_yaw_degrees_max"] > CLAIM_DOMAIN["absolute_yaw_degrees_max"]
        or raw["mouth_visible_ratio"] < CLAIM_DOMAIN["mouth_visible_ratio_min"]
        or raw["speaker_count"] != 1
        or raw["has_music"]
        or raw["cut_count"] != 0
        or not 65 <= raw["speech_rate_wpm"] <= 220
        or raw["mouth_occlusion_ratio"] > 0.01
        or not raw["active_speaker_visible"]
        or raw["offscreen_speech"]
        or raw["source_domain"] not in CLAIM_DOMAIN["source_domains"]
    ):
        raise GovernanceError("In-Domain-Sample verletzt die vorab registrierte Claim-Domain.")
    if raw["ood_kind"] == "music" and not raw["has_music"]:
        raise GovernanceError("OOD-Stratum music benötigt has_music=true.")
    if raw["ood_kind"] == "multiple-speakers" and raw["speaker_count"] < 2:
        raise GovernanceError("OOD-Stratum multiple-speakers benötigt mindestens zwei Sprecher.")
    if raw["ood_kind"] == "silence" and (
        raw["speech_rate_wpm"] != 0 or raw["speaker_count"] != 0 or raw["active_speaker_visible"]
    ):
        raise GovernanceError("OOD-Stratum silence benötigt 0 WPM, 0 Sprecher und keinen sichtbaren Sprecher.")
    if raw["ood_kind"] == "mouth-occluded" and raw["mouth_occlusion_ratio"] < 0.5:
        raise GovernanceError("OOD-Stratum mouth-occluded benötigt mindestens 50 % Mundverdeckung.")
    if raw["ood_kind"] == "no-active-speaker" and raw["active_speaker_visible"]:
        raise GovernanceError("OOD-Stratum no-active-speaker darf keinen aktiven Sprecher zeigen.")
    if raw["ood_kind"] == "offscreen-speech" and (not raw["offscreen_speech"] or raw["active_speaker_visible"]):
        raise GovernanceError("OOD-Stratum offscreen-speech benötigt unsichtbare Offscreen-Sprache.")
    if raw["ood_kind"] == "synthetic-training-source" and raw["source_domain"] != "synthetic-negative":
        raise GovernanceError("OOD-Stratum synthetic-training-source benötigt source_domain synthetic-negative.")


def _validate_strata(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise GovernanceError("strata muss ein Objekt sein.")
    _expect_exact_keys(
        raw,
        {
            "fps",
            "speech_rate_wpm",
            "head_motion",
            "lighting",
            "gender_group",
            "age_band",
            "skin_tone_fitzpatrick",
            "source_domain",
            "absolute_yaw_degrees_max",
            "mouth_visible_ratio",
            "mouth_occlusion_ratio",
            "speaker_count",
            "active_speaker_visible",
            "offscreen_speech",
            "has_music",
            "cut_count",
            "ood_kind",
        },
        "strata",
    )
    _validate_strata_labels(raw)
    _validate_strata_numeric(raw)
    _validate_strata_evidence(raw)
    _validate_strata_claim_domain(raw)
    return raw


def _validate_sample_artifacts(
    sample: dict[str, Any],
    root: Path,
    *,
    allowed_phones: set[str],
    checked_at: datetime,
) -> None:
    media_sha256 = _expect_sha256(sample["media_sha256"], "media_sha256")
    timeline_sha256 = _expect_sha256(sample["phoneme_timeline_sha256"], "phoneme_timeline_sha256")
    if _hash_relative_regular(root, sample["media_path"], "media_path", MAX_MEDIA_BYTES) != media_sha256:
        raise GovernanceError(f"Medien-Hash stimmt nicht: {sample['sample_id']}")
    duration_us = sample["end_us"] - sample["start_us"]
    decoded_from_media = _probe_media(
        root,
        sample["media_path"],
        expected_duration_us=duration_us,
        expected_fps=sample["strata"]["fps"],
    )
    decoded_pcm_raw = _read_relative_regular(
        root,
        sample["decoded_pcm_path"],
        "decoded_pcm_path",
        MAX_DECODED_AUDIO_BYTES + 4096,
    )
    if _sha256_bytes(decoded_pcm_raw) != sample["decoded_pcm_sha256"]:
        raise GovernanceError(f"Decoded-PCM-Hash stimmt nicht: {sample['sample_id']}")
    if _validate_decoded_pcm(decoded_pcm_raw, duration_us=duration_us) != decoded_from_media:
        raise GovernanceError(f"Decoded-PCM stammt nicht reproduzierbar aus dem Quellvideo: {sample['sample_id']}")
    mouth_frames_raw = _read_relative_regular(
        root,
        sample["mouth_frames_path"],
        "mouth_frames_path",
        MAX_MEDIA_BYTES,
    )
    if _sha256_bytes(mouth_frames_raw) != sample["mouth_frames_sha256"]:
        raise GovernanceError(f"Mundframe-Hash stimmt nicht: {sample['sample_id']}")
    _validate_mouth_frames(
        mouth_frames_raw,
        duration_us=duration_us,
        fps=sample["strata"]["fps"],
    )
    fingerprint_raw = _read_relative_regular(
        root,
        sample["perceptual_fingerprint_path"],
        "perceptual_fingerprint_path",
        MAX_EVIDENCE_BYTES,
    )
    if _sha256_bytes(fingerprint_raw) != sample["perceptual_fingerprint_sha256"]:
        raise GovernanceError(f"Perzeptionsfingerprint-Hash stimmt nicht: {sample['sample_id']}")
    _validate_perceptual_fingerprint(fingerprint_raw)
    timeline_raw = _read_relative_regular(
        root,
        sample["phoneme_timeline_path"],
        "phoneme_timeline_path",
        MAX_EVIDENCE_BYTES,
    )
    if _sha256_bytes(timeline_raw) != timeline_sha256:
        raise GovernanceError(f"Phonem-Timeline-Hash stimmt nicht: {sample['sample_id']}")
    _validate_timeline(
        _parse_json_bytes(timeline_raw, str(sample["phoneme_timeline_path"])),
        sample=sample,
        allowed_phones=allowed_phones,
        checked_at=checked_at,
    )


def _validate_sample(
    raw: dict[str, Any],
    root: Path,
    *,
    allowed_phones: set[str],
    checked_at: datetime,
) -> dict[str, Any]:
    expected = {
        "schema_version",
        "sample_id",
        "media_path",
        "media_sha256",
        "decoded_pcm_path",
        "decoded_pcm_sha256",
        "mouth_frames_path",
        "mouth_frames_sha256",
        "perceptual_fingerprint_path",
        "perceptual_fingerprint_sha256",
        "phoneme_timeline_path",
        "phoneme_timeline_sha256",
        "start_us",
        "end_us",
        "language",
        "transcript",
        "voice_speaker_id",
        "face_identity_id",
        "source_asset_id",
        "source_collection_id",
        "recording_session_id",
        "utterance_id",
        "derivative_group_id",
        "rights_source_id",
        "rights_bundle_id",
        "parent_sample_id",
        "perceptual_duplicate_id",
        "strata",
    }
    _expect_exact_keys(raw, expected, "Sample")
    if raw["schema_version"] != SAMPLE_SCHEMA_VERSION:
        raise GovernanceError(f"Unbekannte Sample-Schemaversion: {raw['schema_version']}")
    sample = dict(raw)
    sample["sample_id"] = _expect_identifier(raw["sample_id"], "sample_id")
    for field in GROUP_FIELDS:
        sample[field] = _expect_identifier(raw[field], field)
    for field in ("parent_sample_id", "perceptual_duplicate_id"):
        if raw[field] is not None:
            sample[field] = _expect_identifier(raw[field], field)
    if raw["language"] not in {"de", "en"}:
        raise GovernanceError("language muss de oder en sein.")
    if not isinstance(raw["transcript"], str) or not raw["transcript"].strip() or len(raw["transcript"]) > 2000:
        raise GovernanceError("transcript muss 1 bis 2000 Zeichen enthalten.")
    if unicodedata.normalize("NFC", raw["transcript"]) != raw["transcript"]:
        raise GovernanceError("transcript muss NFC-normalisiert sein.")
    if (
        not isinstance(raw["start_us"], int)
        or isinstance(raw["start_us"], bool)
        or not isinstance(raw["end_us"], int)
        or isinstance(raw["end_us"], bool)
    ):
        raise GovernanceError("start_us und end_us müssen ganzzahlige Mikrosekunden sein.")
    duration_us = raw["end_us"] - raw["start_us"]
    if raw["start_us"] != 0 or not 2_000_000 <= duration_us <= 5_000_000:
        raise GovernanceError(
            "Sample muss auf start_us=0 vorgetrimmt und innerhalb der Claim-Domain 2 bis 5 Sekunden sein."
        )
    sample["decoded_pcm_sha256"] = _expect_sha256(raw["decoded_pcm_sha256"], "decoded_pcm_sha256")
    sample["mouth_frames_sha256"] = _expect_sha256(raw["mouth_frames_sha256"], "mouth_frames_sha256")
    sample["perceptual_fingerprint_sha256"] = _expect_sha256(
        raw["perceptual_fingerprint_sha256"],
        "perceptual_fingerprint_sha256",
    )
    sample["perceptual_duplicate_id"] = _expect_identifier(
        raw["perceptual_duplicate_id"],
        "perceptual_duplicate_id",
    )
    sample["strata"] = _validate_strata(raw["strata"])
    _validate_sample_artifacts(
        sample,
        root,
        allowed_phones=allowed_phones,
        checked_at=checked_at,
    )
    return sample


def _parse_datetime(value: object, context: str, *, nullable: bool = False) -> datetime | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str):
        raise GovernanceError(f"{context} muss ein ISO-8601-Zeitpunkt sein.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise GovernanceError(f"{context} ist kein gültiger ISO-8601-Zeitpunkt.") from error
    if parsed.tzinfo is None:
        raise GovernanceError(f"{context} benötigt eine Zeitzone.")
    return parsed.astimezone(UTC)


def _validate_rights_time_window(rights: dict[str, Any], checked_at: datetime) -> None:
    valid_from = _parse_datetime(rights["valid_from"], "valid_from")
    expires_at = _parse_datetime(rights["expires_at"], "expires_at", nullable=True)
    revoked_at = _parse_datetime(rights["revoked_at"], "revoked_at", nullable=True)
    if valid_from is None or valid_from > checked_at:
        raise GovernanceError(f"Rechte sind noch nicht gültig: {rights['rights_bundle_id']}")
    if expires_at is not None and expires_at <= checked_at:
        raise GovernanceError(f"Rechte sind abgelaufen: {rights['rights_bundle_id']}")
    if revoked_at is not None and revoked_at <= checked_at:
        raise GovernanceError(f"Rechte wurden widerrufen: {rights['rights_bundle_id']}")


def _validate_rights(raw: dict[str, Any], root: Path, checked_at: datetime) -> dict[str, Any]:
    expected = {
        "schema_version",
        "rights_bundle_id",
        "rights_source_id",
        "evidence_path",
        "evidence_sha256",
        "rights_holder",
        "legal_approval_id",
        "legal_basis",
        "territory",
        "valid_from",
        "expires_at",
        "revoked_at",
        "training_allowed",
        "feature_extraction_allowed",
        "face_biometric_processing_allowed",
        "voice_biometric_processing_allowed",
        "derived_weights_allowed",
        "commercial_use_allowed",
        "redistribution_allowed",
        "adult_confirmed",
        "legal_approved",
        "dpia_id",
        "dpa_id",
        "processor_record_id",
    }
    _expect_exact_keys(raw, expected, "Rechteledger")
    if raw["schema_version"] != RIGHTS_SCHEMA_VERSION:
        raise GovernanceError(f"Unbekannte Rechte-Schemaversion: {raw['schema_version']}")
    rights = dict(raw)
    for field in ("rights_bundle_id", "rights_source_id", "legal_approval_id"):
        rights[field] = _expect_identifier(raw[field], field)
    for field in ("rights_holder", "legal_basis", "territory", "dpia_id", "dpa_id", "processor_record_id"):
        if not isinstance(raw[field], str) or not raw[field].strip() or len(raw[field]) > 500:
            raise GovernanceError(f"{field} muss einen dokumentierten Wert enthalten.")
    for field in REQUIRED_RIGHTS:
        if raw[field] is not True:
            raise GovernanceError(f"Rechtefreigabe fehlt: {field} ({raw['rights_bundle_id']})")
    _validate_rights_time_window(rights, checked_at)
    expected_sha256 = _expect_sha256(raw["evidence_sha256"], "evidence_sha256")
    if _hash_relative_regular(root, raw["evidence_path"], "evidence_path", MAX_EVIDENCE_BYTES) != expected_sha256:
        raise GovernanceError(f"Rechtebeleg-Hash stimmt nicht: {raw['rights_bundle_id']}")
    return rights


def _validate_mapping_class(
    entry: object,
    *,
    phones: set[str],
    codes: set[str],
) -> None:
    if not isinstance(entry, dict):
        raise GovernanceError("Ungültige Visemklasse.")
    _expect_exact_keys(entry, {"id", "code", "phones"}, "Visemklasse")
    code = entry["code"]
    if (
        not isinstance(code, str)
        or not code
        or len(code) > 40
        or not code[0].isalpha()
        or not all(character in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for character in code)
        or code in codes
    ):
        raise GovernanceError(f"Ungültiger oder doppelter Visemcode: {code}")
    codes.add(code)
    if not isinstance(entry["phones"], list) or not entry["phones"]:
        raise GovernanceError("Visemklasse benötigt mindestens ein Phone.")
    for phone in entry["phones"]:
        if not isinstance(phone, str) or not phone or unicodedata.normalize("NFC", phone) != phone or phone in phones:
            raise GovernanceError(f"Ungültiges oder doppeltes Phone im Mapping: {phone}")
        phones.add(phone)


def _validate_mapping(mapping: object) -> dict[str, Any]:
    if not isinstance(mapping, dict) or mapping.get("schemaVersion") != MAPPING_SCHEMA_VERSION:
        raise GovernanceError("Unbekannte Visem-Mapping-Schemaversion.")
    _expect_exact_keys(
        mapping,
        {"schemaVersion", "mappingVersion", "classCount", "languages", "normalization", "classes"},
        "Visem-Mapping",
    )
    if mapping.get("mappingVersion") != "viseme15-en-de.v1" or mapping.get("classCount") != 15:
        raise GovernanceError("Freeze verlangt viseme15-en-de.v1 mit genau 15 Klassen.")
    if mapping.get("languages") != ["de", "en"]:
        raise GovernanceError("Visem-Mapping muss die geordnete Sprachdomäne de/en binden.")
    expected_normalization = {
        "unicodeForm": "NFC",
        "stripPrimaryAndSecondaryStress": True,
        "stripVowelLength": True,
        "mapAffricatesAtomically": True,
        "frameAssignment": "phoneme active at video-frame center",
        "transitionDefinition": "class id changes between adjacent non-silence frame centers",
        "unknownPolicy": "quarantine",
    }
    if mapping.get("normalization") != expected_normalization:
        raise GovernanceError("Visem-Mapping bindet nicht die vollständige Normalisierungsregel.")
    classes = mapping.get("classes")
    if not isinstance(classes, list) or len(classes) != 15:
        raise GovernanceError("Visem-Mapping muss genau 15 Klassen enthalten.")
    ids = [entry.get("id") for entry in classes if isinstance(entry, dict)]
    if ids != list(range(15)):
        raise GovernanceError("Visemklassen müssen aufsteigend 0 bis 14 sein.")
    if classes[0].get("code") != "SIL":
        raise GovernanceError("Visemklasse 0 muss SIL sein.")
    phones: set[str] = set()
    codes: set[str] = set()
    for entry in classes:
        _validate_mapping_class(entry, phones=phones, codes=codes)
    return mapping


def _validate_commitment_hashes(raw: dict[str, Any], status: str) -> None:
    for field in COMMITMENT_HASH_FIELDS:
        _expect_sha256(raw[field], field, nullable=True)
        if status == "frozen" and raw[field] is None:
            raise GovernanceError(f"Eingefrorene Preregistration benötigt {field}.")


def _validate_generation_seeds(raw: object) -> None:
    if (
        not isinstance(raw, list)
        or len(raw) != 3
        or len(set(raw)) != 3
        or any(not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 for seed in raw)
    ):
        raise GovernanceError("generation_seeds muss genau drei eindeutige nichtnegative Seeds binden.")


def _validate_comparator_arms(raw: object, status: str) -> None:
    if not isinstance(raw, list) or [arm.get("id") for arm in raw if isinstance(arm, dict)] != [
        "native-ltx-a2v",
        "longcat-video-avatar-1.5",
        "wan2.2-s2v-14b",
    ]:
        raise GovernanceError("Comparator-Matrix muss native LTX, LongCat und Wan2.2-S2V geordnet binden.")
    for arm in raw:
        if not isinstance(arm, dict):
            raise GovernanceError("Comparator-Arm muss ein Objekt sein.")
        _expect_exact_keys(
            arm,
            {
                "id",
                "code_revision",
                "weights_revision",
                "scope_ceiling",
                "execution_status",
            },
            "Comparator-Arm",
        )
        for field in ("code_revision", "weights_revision"):
            revision = arm[field]
            if revision is not None and (
                not isinstance(revision, str)
                or len(revision) != 40
                or any(character not in "0123456789abcdef" for character in revision)
            ):
                raise GovernanceError(f"Comparator-{field} muss ein 40-stelliger Commit oder null sein.")
            if status == "frozen" and revision is None:
                raise GovernanceError(f"Eingefrorene Preregistration benötigt Comparator-{field}.")
        if arm["scope_ceiling"] not in {"owned-candidate", "internal-benchmark-only"}:
            raise GovernanceError("Unbekannte Comparator-Nutzungsfreigabe.")
        expected_status = "pending-artifact-freeze" if arm["id"] == "native-ltx-a2v" else "conditional-legal-hold"
        if arm["execution_status"] != expected_status:
            raise GovernanceError("Comparator-Ausführungsstatus verletzt die vorab registrierte HOLD-Policy.")


def _validate_holdout_commitments(raw: object, status: str) -> None:
    if not isinstance(raw, dict):
        raise GovernanceError("holdout_commitments muss ein Objekt sein.")
    _expect_exact_keys(
        raw,
        {
            "model_family",
            *COMMITMENT_HASH_FIELDS,
            "generation_seeds",
            "selection_metric",
            "calibration_method",
            "operating_point",
            "comparator_arms",
            "human_mos_gates",
        },
        "holdout_commitments",
    )
    _validate_commitment_hashes(raw, status)
    if raw["model_family"] != "owned-dual-head-av-evaluator.v1":
        raise GovernanceError("Unbekannte Evaluator-Modellfamilie.")
    _validate_generation_seeds(raw["generation_seeds"])
    if raw["selection_metric"] != "speaker-bootstrap-worst-stratum-product-gates.v1":
        raise GovernanceError("Unbekannte Auswahlmetrik.")
    if raw["calibration_method"] != "speaker-disjoint-isotonic.v1":
        raise GovernanceError("Unbekanntes Kalibrationsverfahren.")
    if raw["operating_point"] != "far-0.01-frr-0.05.v1":
        raise GovernanceError("Unbekannter FAR/FRR-Arbeitspunkt.")
    _validate_comparator_arms(raw["comparator_arms"], status)
    expected_mos = {
        "lip_sync_min": 9.0,
        "identity_and_mouth_naturalness_min": 9.0,
        "candidate_lip_sync_margin_min": 0.5,
        "candidate_identity_and_mouth_margin_min": 0.3,
        "confidence_level": 0.95,
        "multiplicity_correction": "holm",
    }
    if raw["human_mos_gates"] != expected_mos:
        raise GovernanceError("Preregistration muss die vollständigen menschlichen MOS-Gates binden.")


def _validate_authorization_contract(raw: object) -> None:
    if raw != AUTHORIZATION_CONTRACT:
        raise GovernanceError(
            "Preregistration muss Auswertungs- und Release-Autorisierung extern, "
            "zeitlich getrennt und rollenfest binden."
        )


def _validate_target_sota_claims(raw: object, status: str) -> None:
    if not isinstance(raw, list):
        raise GovernanceError("target_sota_claim_ids muss eine sortierte Liste sein.")
    for index, target_claim in enumerate(raw):
        _expect_identifier(target_claim, f"target_sota_claim_ids[{index}]")
    if raw != sorted(set(raw)):
        raise GovernanceError("target_sota_claim_ids muss eindeutig und sortiert sein.")
    if status == "draft" and raw:
        raise GovernanceError("Draft-Preregistration darf noch keine SOTA-Zielclaims einfrieren.")
    if status == "frozen" and not raw:
        raise GovernanceError("Frozen-Preregistration benötigt mindestens einen SOTA-Zielclaim.")


def _validate_preregistration(preregistration: object, mapping_sha256: str) -> dict[str, Any]:
    if not isinstance(preregistration, dict):
        raise GovernanceError("Preregistration muss ein JSON-Objekt sein.")
    required = {
        "schema_version",
        "status",
        "mapping_sha256",
        "preprocessing_version",
        "split_algorithm",
        "split_seed_sha256",
        "bootstrap_replicates",
        "bootstrap_unit",
        "holdout_commitments",
        "authorization_contract",
        "target_sota_claim_ids",
        "claim_domain",
        "release_gates",
    }
    _expect_exact_keys(preregistration, required, "Preregistration")
    if preregistration["schema_version"] != PREREGISTRATION_SCHEMA_VERSION:
        raise GovernanceError("Unbekannte Preregistration-Schemaversion.")
    if preregistration["status"] not in {"draft", "frozen"}:
        raise GovernanceError("Preregistration.status muss draft oder frozen sein.")
    if preregistration["mapping_sha256"] != mapping_sha256:
        raise GovernanceError("Preregistration bindet nicht das aktuelle Visem-Mapping.")
    if preregistration["preprocessing_version"] != PREPROCESSING_VERSION:
        raise GovernanceError("Unbekannte Preprocessing-Version.")
    if preregistration["split_algorithm"] != "transitive-components-sha256.v1":
        raise GovernanceError("Unbekannter Split-Algorithmus.")
    _expect_sha256(preregistration["split_seed_sha256"], "split_seed_sha256")
    if preregistration["bootstrap_replicates"] != 10_000:
        raise GovernanceError("Release-Preregistration verlangt genau 10.000 Bootstrap-Replikate.")
    if preregistration["bootstrap_unit"] != "voice-speaker-and-leakage-component":
        raise GovernanceError("Bootstrap-Einheit muss unabhängige Sprecher/Leakage-Komponenten verwenden.")
    _validate_holdout_commitments(preregistration["holdout_commitments"], preregistration["status"])
    _validate_authorization_contract(preregistration["authorization_contract"])
    _validate_target_sota_claims(preregistration["target_sota_claim_ids"], preregistration["status"])
    if preregistration["claim_domain"] != CLAIM_DOMAIN:
        raise GovernanceError("Preregistration muss die vollständige Claim-Domain unverändert binden.")
    if preregistration["release_gates"] != RELEASE_GATES:
        raise GovernanceError("Preregistration muss die vorab definierten Release-Gates unverändert binden.")
    return preregistration


def _union_shared_value(
    union_find: _UnionFind,
    owners: dict[tuple[str, str], str],
    *,
    sample_id: str,
    field: str,
    value: str | None,
) -> None:
    if value is None:
        return
    key = (field, value)
    previous_owner = owners.setdefault(key, sample_id)
    union_find.union(sample_id, previous_owner)


def _union_parent(
    union_find: _UnionFind,
    samples_by_id: dict[str, dict[str, Any]],
    *,
    sample_id: str,
    parent_id: str | None,
) -> None:
    if parent_id is None:
        return
    if parent_id not in samples_by_id:
        raise GovernanceError(f"Parent-Sample fehlt: {parent_id}")
    union_find.union(sample_id, parent_id)


def _build_components(samples: list[dict[str, Any]]) -> dict[str, list[str]]:
    sample_ids = [sample["sample_id"] for sample in samples]
    if len(set(sample_ids)) != len(sample_ids):
        raise GovernanceError("sample_id muss eindeutig sein.")
    by_id = {sample["sample_id"]: sample for sample in samples}
    union_find = _UnionFind(sample_ids)
    owners: dict[tuple[str, str], str] = {}
    for sample in samples:
        sample_id = sample["sample_id"]
        for field in GROUP_FIELDS:
            _union_shared_value(
                union_find,
                owners,
                sample_id=sample_id,
                field=field,
                value=sample[field],
            )
        for field in HASH_GROUP_FIELDS:
            _union_shared_value(
                union_find,
                owners,
                sample_id=sample_id,
                field=field,
                value=sample[field],
            )
        _union_shared_value(
            union_find,
            owners,
            sample_id=sample_id,
            field="perceptual_duplicate_id",
            value=sample["perceptual_duplicate_id"],
        )
        _union_parent(
            union_find,
            by_id,
            sample_id=sample_id,
            parent_id=sample["parent_sample_id"],
        )
    components: dict[str, list[str]] = defaultdict(list)
    for sample_id in sorted(sample_ids):
        components[union_find.find(sample_id)].append(sample_id)
    return dict(sorted(components.items()))


def _assign_components(
    components: dict[str, list[str]],
    samples_by_id: dict[str, dict[str, Any]],
    split_seed: str,
) -> dict[str, str]:
    regular: list[tuple[str, list[str]]] = []
    ood: list[tuple[str, list[str]]] = []
    for root, sample_ids in components.items():
        ood_kinds = {samples_by_id[sample_id]["strata"]["ood_kind"] for sample_id in sample_ids}
        if None in ood_kinds and len(ood_kinds) > 1:
            raise GovernanceError("Leakage-Komponente mischt In-Distribution- und OOD-Samples.")
        (ood if None not in ood_kinds else regular).append((root, sample_ids))
    assignments: dict[str, str] = {}
    ordered = sorted(
        regular,
        key=lambda item: _sha256_bytes(f"{split_seed}\0{','.join(item[1])}".encode()),
    )
    total = sum(len(sample_ids) for _root, sample_ids in ordered)
    counts = dict.fromkeys(SPLITS, 0)
    for _root, sample_ids in ordered:
        deficits = {split: SPLIT_RATIOS[split] * total - counts[split] for split in SPLITS}
        split = max(SPLITS, key=lambda name: (deficits[name], -SPLITS.index(name)))
        for sample_id in sample_ids:
            assignments[sample_id] = split
        counts[split] += len(sample_ids)
    for _root, sample_ids in ood:
        for sample_id in sample_ids:
            assignments[sample_id] = "ood-test"
    return assignments


def _audit_assignments(
    samples: list[dict[str, Any]],
    components: dict[str, list[str]],
    assignments: dict[str, str],
) -> None:
    if set(assignments) != {sample["sample_id"] for sample in samples}:
        raise GovernanceError("Split-Zuweisung deckt nicht exakt alle Samples ab.")
    for sample_ids in components.values():
        splits = {assignments[sample_id] for sample_id in sample_ids}
        if len(splits) != 1:
            raise GovernanceError(f"Transitive Leakage-Komponente liegt in mehreren Splits: {sample_ids}")
    for field in GROUP_FIELDS:
        seen: dict[str, str] = {}
        for sample in samples:
            value = sample[field]
            split = assignments[sample["sample_id"]]
            if value in seen and seen[value] != split:
                raise GovernanceError(f"Leakage über {field}: {value}")
            seen[value] = split


def _speech_rate_bucket(value: int) -> str:
    if value <= 100:
        return "slow"
    if value <= 160:
        return "medium"
    return "fast"


def _enforce_evaluation_split_coverage(
    samples: list[dict[str, Any]],
    assignments: dict[str, str],
) -> None:
    requirements = (
        ("language", set(CLAIM_DOMAIN["languages"])),
        ("fps", set(CLAIM_DOMAIN["frame_rates"])),
        ("head_motion", set(CLAIM_DOMAIN["head_motion"])),
        ("lighting", set(CLAIM_DOMAIN["lighting"])),
        ("gender_group", set(CLAIM_DOMAIN["gender_groups"])),
        ("age_band", set(CLAIM_DOMAIN["age_bands"])),
        ("skin_tone_fitzpatrick", set(CLAIM_DOMAIN["skin_tone_fitzpatrick"])),
        ("source_domain", set(CLAIM_DOMAIN["source_domains"])),
    )
    for split in ("tune", "design-pilot", "calibration", "test"):
        split_samples = [
            sample
            for sample in samples
            if assignments[sample["sample_id"]] == split and sample["strata"]["ood_kind"] is None
        ]
        for field, expected in requirements:
            observed = {sample[field] if field == "language" else sample["strata"][field] for sample in split_samples}
            if not expected.issubset(observed):
                raise GovernanceError(f"Product-{split} deckt Stratum {field} nicht vollständig ab.")
        speech_rate_buckets = {_speech_rate_bucket(sample["strata"]["speech_rate_wpm"]) for sample in split_samples}
        if speech_rate_buckets != {"slow", "medium", "fast"}:
            raise GovernanceError(f"Product-{split} deckt die vorab registrierten WPM-Buckets nicht vollständig ab.")


def _enforce_test_stratum_minimums(
    test_samples: list[dict[str, Any]],
    subgroup_gates: dict[str, Any],
) -> None:
    requirements = (
        (
            "gender_group",
            set(CLAIM_DOMAIN["gender_groups"]),
            subgroup_gates["minimum_clips_per_gender_group"],
        ),
        ("age_band", set(CLAIM_DOMAIN["age_bands"]), subgroup_gates["minimum_clips_per_age_band"]),
        (
            "skin_tone_fitzpatrick",
            set(CLAIM_DOMAIN["skin_tone_fitzpatrick"]),
            subgroup_gates["minimum_clips_per_skin_tone"],
        ),
        (
            "source_domain",
            set(CLAIM_DOMAIN["source_domains"]),
            subgroup_gates["minimum_clips_per_source_domain"],
        ),
    )
    for field, values, minimum in requirements:
        for value in values:
            count = sum(sample["strata"][field] == value for sample in test_samples)
            if count < minimum:
                raise GovernanceError(f"Product-test hat zu wenige Clips für {field}={value}: {count} < {minimum}.")
    for bucket in ("slow", "medium", "fast"):
        count = sum(_speech_rate_bucket(sample["strata"]["speech_rate_wpm"]) == bucket for sample in test_samples)
        minimum = subgroup_gates["minimum_clips_per_speech_rate_bucket"]
        if count < minimum:
            raise GovernanceError(f"Product-test hat zu wenige Clips im WPM-Bucket {bucket}: {count} < {minimum}.")


def _enforce_profile(
    samples: list[dict[str, Any]],
    components: dict[str, list[str]],
    assignments: dict[str, str],
    profile: Literal["development", "product"],
    preregistration: dict[str, Any],
) -> None:
    if profile == "development":
        return
    if not PRODUCT_PROFILE_ENABLED:
        raise GovernanceError(
            "Product-HOLD: Signatur-, Blind-Scorer- und Release-Attestierungsprüfung ist noch nicht aktiviert."
        )
    if preregistration["status"] != "frozen":
        raise GovernanceError("Product-Freeze verlangt eine vorab eingefrorene Preregistration.")
    _enforce_evaluation_split_coverage(samples, assignments)
    subgroup_gates = preregistration["release_gates"]["subgroups"]
    test_samples = [sample for sample in samples if assignments[sample["sample_id"]] == "test"]
    test_identities = {sample["face_identity_id"] for sample in test_samples}
    test_speakers = {sample["voice_speaker_id"] for sample in test_samples}
    test_components = [sample_ids for sample_ids in components.values() if assignments[sample_ids[0]] == "test"]
    if (
        len(test_samples) < subgroup_gates["minimum_test_clips"]
        or len(test_identities) < subgroup_gates["minimum_test_identities"]
        or len(test_speakers) < subgroup_gates["minimum_test_voice_speakers"]
        or len(test_components) < subgroup_gates["minimum_test_leakage_components"]
    ):
        raise GovernanceError(
            "Product-Holdout benötigt mindestens 90 Testclips sowie je 30 unabhängige "
            "Identitäten, Sprecher und Leakage-Komponenten."
        )
    for language in CLAIM_DOMAIN["languages"]:
        language_samples = [sample for sample in test_samples if sample["language"] == language]
        language_identities = {sample["face_identity_id"] for sample in language_samples}
        if (
            len(language_samples) < subgroup_gates["minimum_clips_per_language"]
            or len(language_identities) < subgroup_gates["minimum_identities_per_language"]
        ):
            raise GovernanceError(f"Product-Holdout deckt Sprache {language} nicht ausreichend ab.")
    _enforce_test_stratum_minimums(test_samples, subgroup_gates)
    ood_samples = [sample for sample in samples if assignments[sample["sample_id"]] == "ood-test"]
    for ood_kind in OOD_KINDS:
        if (
            sum(sample["strata"]["ood_kind"] == ood_kind for sample in ood_samples)
            < subgroup_gates["minimum_clips_per_ood_kind"]
        ):
            raise GovernanceError(f"Product-Holdout deckt OOD-Stratum {ood_kind} nicht ausreichend ab.")
    for field, required_values in (
        ("fps", CLAIM_DOMAIN["frame_rates"]),
        ("head_motion", CLAIM_DOMAIN["head_motion"]),
        ("lighting", CLAIM_DOMAIN["lighting"]),
    ):
        observed = {sample["strata"][field] for sample in test_samples}
        if not set(required_values).issubset(observed):
            raise GovernanceError(f"Product-Holdout deckt Claim-Domain {field} nicht vollständig ab.")
    for split in SPLITS:
        if not any(value == split for value in assignments.values()):
            raise GovernanceError(f"Product-Freeze enthält keinen Split {split}.")


def _write_read_only_json(path: Path, value: object, *, mode: int = 0o444) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(_canonical_json(value))
            handle.write(b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(mode)
        temporary.replace(path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _expected_split_document(
    freeze_id: str,
    assignments: dict[str, str],
    split: str,
    samples_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    sample_ids = sorted(sample_id for sample_id, assigned in assignments.items() if assigned == split)
    return {
        "freeze_id": freeze_id,
        "sample_ids": sample_ids,
        "samples": [samples_by_id[sample_id] for sample_id in sample_ids],
    }


def _cas_relative_path(sha256: str) -> str:
    return f"objects/sha256/{sha256[:2]}/{sha256}"


def _build_frozen_records(
    samples: list[dict[str, Any]],
    rights_records: list[dict[str, Any]],
    *,
    manifest_root: Path,
    rights_root: Path,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, tuple[Path, str, int]],
]:
    sources: dict[str, tuple[Path, str, int]] = {}
    frozen_samples: list[dict[str, Any]] = []
    for sample in samples:
        frozen = dict(sample)
        for path_field, sha_field, maximum_bytes in ARTIFACT_PATH_FIELDS:
            sha256 = sample[sha_field]
            sources.setdefault(sha256, (manifest_root, sample[path_field], maximum_bytes))
            frozen[path_field] = _cas_relative_path(sha256)
        frozen_samples.append(frozen)
    frozen_rights: list[dict[str, Any]] = []
    for rights in rights_records:
        frozen = dict(rights)
        sha256 = rights["evidence_sha256"]
        sources.setdefault(sha256, (rights_root, rights["evidence_path"], MAX_EVIDENCE_BYTES))
        frozen["evidence_path"] = _cas_relative_path(sha256)
        frozen_rights.append(frozen)
    return frozen_samples, frozen_rights, sources


def _copy_source_to_cas(
    staging_root: Path,
    *,
    expected_sha256: str,
    source_root: Path,
    source_path: str,
    maximum_bytes: int,
) -> None:
    source_descriptor, source_directories, opened = _open_relative_regular(
        source_root,
        source_path,
        "CAS-Quellartefakt",
        maximum_bytes,
    )
    destination = staging_root / _cas_relative_path(expected_sha256)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination_descriptor: int | None = None
    try:
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        digest = hashlib.sha256()
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(source_descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise GovernanceError(f"CAS-Quellartefakt konnte nicht vollständig gelesen werden: {source_path}")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_descriptor, view)
                if written <= 0:
                    raise GovernanceError("CAS-Artefakt konnte nicht vollständig geschrieben werden.")
                view = view[written:]
            remaining -= len(chunk)
        after = os.fstat(source_descriptor)
        if (
            after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise GovernanceError(f"CAS-Quellartefakt wurde während des Kopierens verändert: {source_path}")
        if digest.hexdigest() != expected_sha256:
            raise GovernanceError(f"CAS-Quellartefakt stimmt nicht mit seinem geprüften Hash überein: {source_path}")
        os.fsync(destination_descriptor)
        os.fchmod(destination_descriptor, 0o444)
    finally:
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        _close_descriptors(source_descriptor, source_directories)
    _fsync_directory(destination.parent)


def _seal_cas_directories(objects_root: Path) -> None:
    directories = [objects_root, objects_root / "sha256"]
    directories.extend(path for path in (objects_root / "sha256").iterdir() if path.is_dir())
    for directory in reversed(directories):
        directory.chmod(0o500)
        _fsync_directory(directory)


def _validate_cas(freeze_root: Path, artifact_sources: dict[str, tuple[Path, str, int]]) -> None:
    objects_root = freeze_root / "objects"
    if stat.S_ISLNK(objects_root.lstat().st_mode) or not objects_root.is_dir():
        raise GovernanceError("Freeze-CAS ist kein reguläres Verzeichnis.")
    observed_files: set[str] = set()
    for directory, directory_names, file_names in os.walk(objects_root, followlinks=False):
        directory_path = Path(directory)
        for name in directory_names:
            child = directory_path / name
            if stat.S_ISLNK(child.lstat().st_mode) or not child.is_dir():
                raise GovernanceError(f"Freeze-CAS enthält eine unsichere Verzeichniskomponente: {child}")
        for name in file_names:
            child = directory_path / name
            relative = child.relative_to(freeze_root).as_posix()
            observed_files.add(relative)
    expected_files = {_cas_relative_path(sha256) for sha256 in artifact_sources}
    if observed_files != expected_files:
        raise GovernanceError("Freeze-CAS enthält unbekannte oder fehlende Artefakte.")
    for sha256, (_root, _path, maximum_bytes) in artifact_sources.items():
        frozen_path = freeze_root / _cas_relative_path(sha256)
        if _hash_regular(frozen_path, maximum_bytes) != sha256:
            raise GovernanceError(f"Freeze-CAS-Artefakt wurde verändert: {sha256}")


def _validate_existing_freeze(
    freeze_root: Path,
    *,
    freeze_id: str,
    core: dict[str, Any],
    assignments: dict[str, str],
    samples_by_id: dict[str, dict[str, Any]],
    snapshots: dict[str, object],
    artifact_sources: dict[str, tuple[Path, str, int]],
) -> None:
    expected_names = {
        "freeze.json",
        "objects",
        *snapshots,
        *(f"{split}.json" for split in (*SPLITS, "ood-test")),
    }
    if stat.S_ISLNK(freeze_root.lstat().st_mode) or not freeze_root.is_dir():
        raise GovernanceError(f"Freeze-Root ist kein reguläres Verzeichnis: {freeze_root}")
    if {child.name for child in freeze_root.iterdir()} != expected_names:
        raise GovernanceError(f"Vorhandener Freeze enthält unbekannte oder fehlende Dateien: {freeze_root}")
    existing = _load_json(freeze_root / "freeze.json")
    if (
        not isinstance(existing, dict)
        or set(existing) != {"freeze_id", "core"}
        or existing.get("freeze_id") != freeze_id
        or existing.get("core") != core
    ):
        raise GovernanceError(f"Vorhandener Freeze wurde verändert: {freeze_root}")
    for split in (*SPLITS, "ood-test"):
        document = _load_json(freeze_root / f"{split}.json")
        if document != _expected_split_document(freeze_id, assignments, split, samples_by_id):
            raise GovernanceError(f"Vorhandener Freeze-Split wurde verändert: {split}")
    for name, expected in snapshots.items():
        if _load_json(freeze_root / name) != expected:
            raise GovernanceError(f"Vorhandener Freeze-Snapshot wurde verändert: {name}")
    _validate_cas(freeze_root, artifact_sources)


def _discard_staging_directory(path: Path) -> None:
    if not path.exists():
        return
    for directory, directory_names, file_names in os.walk(path, topdown=False, followlinks=False):
        directory_path = Path(directory)
        directory_path.chmod(0o700)
        for name in file_names:
            child = directory_path / name
            child.chmod(0o600)
            child.unlink()
        for name in directory_names:
            child = directory_path / name
            child.chmod(0o700)
            child.rmdir()
    path.rmdir()


def _load_validated_inputs(
    manifest_path: Path,
    rights_path: Path,
    mapping_path: Path,
    preregistration_path: Path,
    *,
    checked_at: datetime,
    trusted_preregistration_sha256: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any], str]:
    manifest_root = manifest_path.resolve().parent
    rights_root = rights_path.resolve().parent
    mapping = _validate_mapping(_load_json(mapping_path))
    mapping_sha256 = _sha256_bytes(_canonical_json(mapping))
    preregistration = _validate_preregistration(_load_json(preregistration_path), mapping_sha256)
    if _sha256_bytes(_canonical_json(preregistration)) != trusted_preregistration_sha256:
        raise GovernanceError("Preregistration ist nicht durch den eingebauten Review-Digest versiegelt.")
    rights_records = [_validate_rights(record, rights_root, checked_at) for record in _load_jsonl(rights_path)]
    rights_by_bundle: dict[str, dict[str, Any]] = {}
    for rights in rights_records:
        bundle_id = rights["rights_bundle_id"]
        if bundle_id in rights_by_bundle:
            raise GovernanceError(f"rights_bundle_id ist nicht eindeutig: {bundle_id}")
        rights_by_bundle[bundle_id] = rights
    allowed_phones = {phone for entry in mapping["classes"] for phone in entry["phones"]}
    samples: list[dict[str, Any]] = []
    for record in _load_jsonl(manifest_path):
        bundle_id = _expect_identifier(record.get("rights_bundle_id"), "rights_bundle_id")
        source_id = _expect_identifier(record.get("rights_source_id"), "rights_source_id")
        rights = rights_by_bundle.get(bundle_id)
        if rights is None:
            raise GovernanceError(f"Rechtebundle fehlt: {bundle_id}")
        if rights["rights_source_id"] != source_id:
            raise GovernanceError(f"Rechtequelle stimmt nicht: {record.get('sample_id', '<unbekannt>')}")
        samples.append(
            _validate_sample(
                record,
                manifest_root,
                allowed_phones=allowed_phones,
                checked_at=checked_at,
            )
        )
    return samples, rights_records, mapping, preregistration, mapping_sha256


def _build_snapshots(
    samples: list[dict[str, Any]],
    rights_records: list[dict[str, Any]],
    mapping: dict[str, Any],
    preregistration: dict[str, Any],
) -> dict[str, object]:
    return {
        "manifest.snapshot.json": {
            "schema_version": SAMPLE_SCHEMA_VERSION,
            "samples": sorted(samples, key=lambda sample: sample["sample_id"]),
        },
        "rights.snapshot.json": {
            "schema_version": RIGHTS_SCHEMA_VERSION,
            "records": sorted(rights_records, key=lambda rights: rights["rights_bundle_id"]),
        },
        "viseme-mapping.snapshot.json": mapping,
        "preregistration.snapshot.json": preregistration,
    }


def _build_freeze_core(
    samples: list[dict[str, Any]],
    rights_records: list[dict[str, Any]],
    preregistration: dict[str, Any],
    mapping_sha256: str,
    components: dict[str, list[str]],
    assignments: dict[str, str],
    split_seed: str,
    profile: Literal["development", "product"],
    snapshots: dict[str, object],
    artifact_sha256: set[str],
) -> dict[str, Any]:
    canonical_samples = sorted(samples, key=lambda sample: sample["sample_id"])
    canonical_rights = sorted(rights_records, key=lambda rights: rights["rights_bundle_id"])
    split_counts = {
        split: sum(1 for value in assignments.values() if value == split) for split in (*SPLITS, "ood-test")
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "profile": profile,
        "manifest_sha256": _sha256_bytes(_canonical_json(canonical_samples)),
        "rights_ledger_sha256": _sha256_bytes(_canonical_json(canonical_rights)),
        "mapping_sha256": mapping_sha256,
        "preregistration_sha256": _sha256_bytes(_canonical_json(preregistration)),
        "governance_code_sha256": _hash_regular(Path(__file__).resolve(), MAX_EVIDENCE_BYTES),
        "preprocessing_version": PREPROCESSING_VERSION,
        "preprocessing_tools": {
            "ffmpeg": {"path": str(FFMPEG_PATH), "sha256": FFMPEG_SHA256},
            "ffprobe": {"path": str(FFPROBE_PATH), "sha256": FFPROBE_SHA256},
        },
        "split_algorithm": "transitive-components-sha256.v1",
        "split_seed_sha256": _sha256_bytes(split_seed.encode()),
        "group_fields": [*GROUP_FIELDS, *HASH_GROUP_FIELDS, "perceptual_duplicate_id", "parent_sample_id"],
        "artifact_sha256": sorted(artifact_sha256),
        "sample_count": len(samples),
        "component_count": len(components),
        "split_counts": split_counts,
        "assignments": dict(sorted(assignments.items())),
        "components": list(components.values()),
        "snapshot_sha256": {name: _sha256_bytes(_canonical_json(value)) for name, value in sorted(snapshots.items())},
    }


def _write_rights_attestation(
    output_root: Path,
    *,
    freeze_id: str,
    rights_ledger_sha256: str,
    checked_at: datetime,
) -> Path:
    core = {
        "schema_version": RIGHTS_ATTESTATION_SCHEMA_VERSION,
        "freeze_id": freeze_id,
        "rights_ledger_sha256": rights_ledger_sha256,
        "checked_at": checked_at.isoformat().replace("+00:00", "Z"),
    }
    attestation_id = _sha256_bytes(_canonical_json(core))
    document = {"attestation_id": attestation_id, "core": core}
    attestation_root = output_root / "attestations" / freeze_id
    attestation_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = attestation_root / f"{attestation_id}.json"
    if path.exists():
        if _load_json(path) != document:
            raise GovernanceError(f"Rechteattestation wurde verändert: {path}")
        return path
    _write_read_only_json(path, document)
    _fsync_directory(attestation_root)
    return path


def _revalidate_rights_before_attestation(
    rights_path: Path,
    expected_records: list[dict[str, Any]],
) -> datetime:
    started_at = datetime.now(UTC)
    current_records = [
        _validate_rights(record, rights_path.resolve().parent, started_at) for record in _load_jsonl(rights_path)
    ]
    canonical_current = sorted(current_records, key=lambda rights: rights["rights_bundle_id"])
    canonical_expected = sorted(expected_records, key=lambda rights: rights["rights_bundle_id"])
    if canonical_current != canonical_expected:
        raise GovernanceError("Rechteledger wurde während des Freeze-Vorgangs verändert.")
    final_records = sorted(
        _load_jsonl(rights_path),
        key=lambda rights: str(rights.get("rights_bundle_id", "")),
    )
    if final_records != canonical_current:
        raise GovernanceError("Rechteledger wurde während der finalen Attestierung verändert.")
    completed_at = datetime.now(UTC)
    for rights in canonical_current:
        _validate_rights_time_window(rights, completed_at)
    return completed_at


def _load_verified_freeze_document(freeze_root: Path) -> dict[str, Any]:
    if stat.S_ISLNK(freeze_root.lstat().st_mode) or not freeze_root.is_dir():
        raise GovernanceError("Freeze-Root ist kein reguläres Verzeichnis.")
    freeze_document = _load_json(freeze_root / "freeze.json")
    if not isinstance(freeze_document, dict) or set(freeze_document) != {"freeze_id", "core"}:
        raise GovernanceError("Freeze-Metadaten sind ungültig.")
    freeze_id = freeze_document["freeze_id"]
    core = freeze_document["core"]
    if (
        not isinstance(freeze_id, str)
        or not isinstance(core, dict)
        or core.get("schema_version") != SCHEMA_VERSION
        or _sha256_bytes(_canonical_json(core)) != freeze_id
        or freeze_root.name != freeze_id
    ):
        raise GovernanceError("Freeze-ID bindet nicht die aktuellen Freeze-Metadaten.")
    snapshot_hashes = core.get("snapshot_sha256")
    if not isinstance(snapshot_hashes, dict) or not snapshot_hashes:
        raise GovernanceError("Freeze enthält keine gebundenen Snapshots.")
    expected_names = {
        "freeze.json",
        "objects",
        *snapshot_hashes,
        *(f"{split}.json" for split in (*SPLITS, "ood-test")),
    }
    if {child.name for child in freeze_root.iterdir()} != expected_names:
        raise GovernanceError("Freeze enthält unbekannte oder fehlende Dateien.")
    for name, expected_sha256 in snapshot_hashes.items():
        if not isinstance(name, str) or _expect_sha256(expected_sha256, f"snapshot_sha256.{name}") is None:
            raise GovernanceError("Freeze enthält einen ungültigen Snapshot-Hash.")
        snapshot = _load_json(freeze_root / name)
        if _sha256_bytes(_canonical_json(snapshot)) != expected_sha256:
            raise GovernanceError(f"Freeze-Snapshot wurde verändert: {name}")
    return freeze_document


def _validate_recent_rights_attestation(freeze_root: Path, freeze: dict[str, Any]) -> None:
    freeze_id = freeze["freeze_id"]
    attestation_root = freeze_root.parent / "attestations" / freeze_id
    if not attestation_root.is_dir() or stat.S_ISLNK(attestation_root.lstat().st_mode):
        raise GovernanceError("Für den Freeze fehlt eine aktuelle Rechteattestation.")
    newest: datetime | None = None
    expected_rights_hash = freeze["core"].get("rights_ledger_sha256")
    for path in attestation_root.iterdir():
        if path.suffix != ".json":
            raise GovernanceError(f"Unbekannte Datei im Rechteattestationsverzeichnis: {path}")
        document = _load_json(path)
        if not isinstance(document, dict) or set(document) != {"attestation_id", "core"}:
            raise GovernanceError(f"Ungültige Rechteattestation: {path}")
        core = document["core"]
        if (
            not isinstance(core, dict)
            or set(core) != {"schema_version", "freeze_id", "rights_ledger_sha256", "checked_at"}
            or core["schema_version"] != RIGHTS_ATTESTATION_SCHEMA_VERSION
            or core["freeze_id"] != freeze_id
            or core["rights_ledger_sha256"] != expected_rights_hash
            or document["attestation_id"] != _sha256_bytes(_canonical_json(core))
            or path.name != f"{document['attestation_id']}.json"
        ):
            raise GovernanceError(f"Rechteattestation bindet nicht den Freeze: {path}")
        checked_at = _parse_datetime(core["checked_at"], "Rechteattestation.checked_at")
        if checked_at is None:
            raise GovernanceError(f"Rechteattestation enthält keinen Prüfzeitpunkt: {path}")
        newest = checked_at if newest is None else max(newest, checked_at)
    now = datetime.now(UTC)
    if newest is None or newest > now or (now - newest).total_seconds() > MAX_RIGHTS_ATTESTATION_AGE_SECONDS:
        raise GovernanceError("Für den Freeze fehlt eine höchstens fünf Minuten alte Rechteattestation.")


@contextmanager
def _open_verified_cas_artifact(
    freeze_root: Path,
    artifact_sha256: set[str],
    expected_sha256: str,
) -> Iterator[BinaryIO]:
    sha256 = _expect_sha256(expected_sha256, "expected_sha256")
    if sha256 not in artifact_sha256:
        raise GovernanceError("Artefakt gehört nicht zum angegebenen Freeze.")
    descriptor, directories, opened = _open_relative_regular(
        freeze_root,
        _cas_relative_path(sha256),
        "Freeze-CAS-Artefakt",
        MAX_MEDIA_BYTES,
    )
    try:
        digest = hashlib.sha256()
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise GovernanceError("Freeze-CAS-Artefakt konnte nicht vollständig geprüft werden.")
            digest.update(chunk)
            remaining -= len(chunk)
        if digest.hexdigest() != sha256:
            raise GovernanceError("Freeze-CAS-Artefakt wurde verändert.")
        os.lseek(descriptor, 0, os.SEEK_SET)
        for directory_descriptor in reversed(directories):
            os.close(directory_descriptor)
        directories.clear()
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            yield handle
    finally:
        if descriptor >= 0:
            _close_descriptors(descriptor, directories)


class FrozenDatasetSession:
    """One metadata-verified training session with per-open CAS verification."""

    def __init__(self, freeze_root: Path) -> None:
        self.freeze_root = freeze_root
        self._freeze = _load_verified_freeze_document(freeze_root)
        _validate_recent_rights_attestation(freeze_root, self._freeze)
        manifest = _load_json(freeze_root / "manifest.snapshot.json")
        if not isinstance(manifest, dict) or not isinstance(manifest.get("samples"), list):
            raise GovernanceError("Manifest-Snapshot ist ungültig.")
        samples = manifest["samples"]
        if not all(isinstance(sample, dict) for sample in samples):
            raise GovernanceError("Manifest-Snapshot enthält ungültige Samples.")
        self._manifest_by_id = {sample.get("sample_id"): sample for sample in samples}
        if len(self._manifest_by_id) != len(samples) or None in self._manifest_by_id:
            raise GovernanceError("Manifest-Snapshot enthält fehlende oder doppelte sample_id.")
        core = self._freeze["core"]
        assignments = core.get("assignments")
        if (
            not isinstance(assignments, dict)
            or set(assignments) != set(self._manifest_by_id)
            or any(value not in {*SPLITS, "ood-test"} for value in assignments.values())
        ):
            raise GovernanceError("Freeze-Core enthält keine vollständige Split-Sollzuweisung.")
        self._assignments = assignments
        artifact_sha256 = core.get("artifact_sha256")
        if not isinstance(artifact_sha256, list) or any(
            _expect_sha256(value, "artifact_sha256") is None for value in artifact_sha256
        ):
            raise GovernanceError("Freeze-Core enthält ungültige Artefakt-Hashes.")
        self._artifact_sha256 = set(artifact_sha256)
        self._closed = False

    def __enter__(self) -> FrozenDatasetSession:
        return self

    def __exit__(self, _exc_type: object, _exc_value: object, _traceback: object) -> None:
        self.close()

    def close(self) -> None:
        self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise GovernanceError("FrozenDatasetSession ist bereits geschlossen.")

    def load_split(self, split: str) -> list[dict[str, Any]]:
        self._ensure_open()
        if split not in {*SPLITS, "ood-test"}:
            raise GovernanceError("Unbekannter Freeze-Split.")
        document = _load_json(self.freeze_root / f"{split}.json")
        if not isinstance(document, dict) or set(document) != {"freeze_id", "sample_ids", "samples"}:
            raise GovernanceError(f"Freeze-Split ist ungültig: {split}")
        samples = document["samples"]
        sample_ids = document["sample_ids"]
        if (
            document["freeze_id"] != self._freeze["freeze_id"]
            or not isinstance(samples, list)
            or not all(isinstance(sample, dict) for sample in samples)
            or not isinstance(sample_ids, list)
            or sample_ids != sorted(sample_ids)
            or sample_ids != [sample.get("sample_id") for sample in samples]
            or len(set(sample_ids)) != len(sample_ids)
        ):
            raise GovernanceError(f"Freeze-Split bindet nicht seine Sample-Liste: {split}")
        expected_sample_ids = sorted(
            sample_id for sample_id, assigned_split in self._assignments.items() if assigned_split == split
        )
        if sample_ids != expected_sample_ids:
            raise GovernanceError(f"Freeze-Split weicht von der gebundenen Soll-Zuweisung ab: {split}")
        if any(
            self._manifest_by_id.get(sample_id) != sample for sample_id, sample in zip(sample_ids, samples, strict=True)
        ):
            raise GovernanceError(f"Freeze-Split weicht vom Manifest-Snapshot ab: {split}")
        for sample in samples:
            for path_field, sha_field, _maximum_bytes in ARTIFACT_PATH_FIELDS:
                sha256 = sample.get(sha_field)
                if sha256 not in self._artifact_sha256 or sample.get(path_field) != _cas_relative_path(sha256):
                    raise GovernanceError(f"Freeze-Split enthält einen ungebundenen Artefaktpfad: {split}")
        return samples

    @contextmanager
    def open_artifact(self, expected_sha256: str) -> Iterator[BinaryIO]:
        self._ensure_open()
        with _open_verified_cas_artifact(
            self.freeze_root,
            self._artifact_sha256,
            expected_sha256,
        ) as artifact:
            yield artifact


def open_frozen_dataset(freeze_root: Path) -> FrozenDatasetSession:
    """Verify a freeze once and return a reusable training session."""

    return FrozenDatasetSession(freeze_root)


@contextmanager
def open_frozen_artifact(freeze_root: Path, expected_sha256: str) -> Iterator[BinaryIO]:
    """Open one CAS artifact through a one-shot verified session."""

    with open_frozen_dataset(freeze_root) as dataset, dataset.open_artifact(expected_sha256) as artifact:
        yield artifact


def load_frozen_split(freeze_root: Path, split: str) -> list[dict[str, Any]]:
    """Load one split through a one-shot verified session."""

    with open_frozen_dataset(freeze_root) as dataset:
        return dataset.load_split(split)


def freeze_dataset(
    manifest_path: Path,
    rights_path: Path,
    mapping_path: Path,
    preregistration_path: Path,
    output_root: Path,
    *,
    profile: Literal["development", "product"] = "product",
    split_seed: str,
) -> Path:
    """Freeze a dataset against the reviewed preregistration trust anchor."""

    return _freeze_dataset(
        manifest_path,
        rights_path,
        mapping_path,
        preregistration_path,
        output_root,
        profile=profile,
        split_seed=split_seed,
        trusted_preregistration_sha256=TRUSTED_PREREGISTRATION_SHA256,
    )


def _freeze_dataset(
    manifest_path: Path,
    rights_path: Path,
    mapping_path: Path,
    preregistration_path: Path,
    output_root: Path,
    *,
    profile: Literal["development", "product"],
    split_seed: str,
    trusted_preregistration_sha256: str,
) -> Path:
    """Validate all evidence and write an immutable, content-addressed split freeze."""

    if profile not in {"development", "product"}:
        raise GovernanceError("profile muss development oder product sein.")
    if profile == "product" and not PRODUCT_PROFILE_ENABLED:
        raise GovernanceError(
            "Product-HOLD: Signatur-, Blind-Scorer- und Release-Attestierungsprüfung ist noch nicht aktiviert."
        )
    if not split_seed or len(split_seed) > 200:
        raise GovernanceError("split_seed muss 1 bis 200 Zeichen enthalten.")
    _expect_sha256(trusted_preregistration_sha256, "trusted_preregistration_sha256")
    _validate_preprocessing_tools()
    rights_evaluated_at = datetime.now(UTC)
    samples, rights_records, mapping, preregistration, mapping_sha256 = _load_validated_inputs(
        manifest_path,
        rights_path,
        mapping_path,
        preregistration_path,
        checked_at=rights_evaluated_at,
        trusted_preregistration_sha256=trusted_preregistration_sha256,
    )
    if _sha256_bytes(split_seed.encode()) != preregistration["split_seed_sha256"]:
        raise GovernanceError("split_seed stimmt nicht mit der vorab registrierten Verpflichtung überein.")
    components = _build_components(samples)
    samples_by_id = {sample["sample_id"]: sample for sample in samples}
    assignments = _assign_components(components, samples_by_id, split_seed)
    _audit_assignments(samples, components, assignments)
    _enforce_profile(samples, components, assignments, profile, preregistration)
    frozen_samples, frozen_rights_records, artifact_sources = _build_frozen_records(
        samples,
        rights_records,
        manifest_root=manifest_path.resolve().parent,
        rights_root=rights_path.resolve().parent,
    )
    frozen_samples_by_id = {sample["sample_id"]: sample for sample in frozen_samples}
    snapshots = _build_snapshots(
        frozen_samples,
        frozen_rights_records,
        mapping,
        preregistration,
    )

    core = _build_freeze_core(
        frozen_samples,
        frozen_rights_records,
        preregistration,
        mapping_sha256,
        components,
        assignments,
        split_seed,
        profile,
        snapshots,
        set(artifact_sources),
    )
    freeze_id = _sha256_bytes(_canonical_json(core))
    freeze_root = output_root.resolve() / freeze_id
    if freeze_root.exists():
        _validate_existing_freeze(
            freeze_root,
            freeze_id=freeze_id,
            core=core,
            assignments=assignments,
            samples_by_id=frozen_samples_by_id,
            snapshots=snapshots,
            artifact_sources=artifact_sources,
        )
    else:
        resolved_output_root = output_root.resolve()
        resolved_output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        staging_root = Path(tempfile.mkdtemp(prefix=f".{freeze_id}.", dir=resolved_output_root))
        freeze = {"freeze_id": freeze_id, "core": core}
        try:
            _write_read_only_json(staging_root / "freeze.json", freeze)
            for name, snapshot in snapshots.items():
                _write_read_only_json(staging_root / name, snapshot)
            for split in (*SPLITS, "ood-test"):
                _write_read_only_json(
                    staging_root / f"{split}.json",
                    _expected_split_document(freeze_id, assignments, split, frozen_samples_by_id),
                )
            for sha256, (source_root, source_path, maximum_bytes) in artifact_sources.items():
                _copy_source_to_cas(
                    staging_root,
                    expected_sha256=sha256,
                    source_root=source_root,
                    source_path=source_path,
                    maximum_bytes=maximum_bytes,
                )
            _seal_cas_directories(staging_root / "objects")
            staging_root.chmod(0o500)
            try:
                staging_root.rename(freeze_root)
            except OSError as error:
                if error.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                    raise
                _validate_existing_freeze(
                    freeze_root,
                    freeze_id=freeze_id,
                    core=core,
                    assignments=assignments,
                    samples_by_id=frozen_samples_by_id,
                    snapshots=snapshots,
                    artifact_sources=artifact_sources,
                )
            _fsync_directory(resolved_output_root)
        finally:
            _discard_staging_directory(staging_root)
    attested_at = _revalidate_rights_before_attestation(rights_path, rights_records)
    _write_rights_attestation(
        output_root.resolve(),
        freeze_id=freeze_id,
        rights_ledger_sha256=core["rights_ledger_sha256"],
        checked_at=attested_at,
    )
    return freeze_root
