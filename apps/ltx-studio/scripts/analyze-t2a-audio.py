#!/usr/bin/env python3
"""Fail-closed T2A WAV measurements for technical IA2V input eligibility."""

from __future__ import annotations

import argparse
import array
import contextlib
import errno
import hashlib
import io
import json
import math
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path

SCHEMA_VERSION = "t2a-audio-quality.v2"
ELIGIBILITY_SCHEMA_VERSION = "t2a-ia2v-eligibility.v2"
SPOKEN_CONTENT_GATE_SCHEMA_VERSION = "t2a-spoken-content-gate.v1"
LOUDNESS_METHOD = "ffmpeg-ebur128-peak-true.v1"
INDEPENDENT_IPA_PHASE_SCHEMA = "ltx-studio-independent-ipa-phase.v2"
INDEPENDENT_IPA_REQUEST_SCHEMA = "ltx-studio-independent-ipa-request.v1"
INDEPENDENT_IPA_RESULT_SCHEMA = "ltx-studio-independent-ipa-observation.v1"
IPA_ADJUDICATION_RESULT_SCHEMA = "ltx-studio-t2a-ipa-adjudication-result.v1"
PHONEME_MEASUREMENT_METHOD = "pinned-espeak-reference-vs-independent-ipa-raw-edit.v1"
INDEPENDENT_IPA_NORMALIZATION_METHOD = "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1"
PINNED_FFMPEG_SHA256 = "de3099d88e092174168b4d436187b970eab6578c5987a4f09b0fee543794f31e"
PINNED_WHISPER_SMALL_SHA256 = "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794"
PINNED_IPA_ADJUDICATOR_RUNNER_SHA256 = "5e27fd4a86fd04c580fd756ad8be6daeab59b51c1fe8446d2cb82b514989ca53"
PINNED_IPA_ADJUDICATION_POLICY_SHA256 = "139d5130fbe0ed56a6bf7599c0c6891bd2b3ddbee65617337a134dcbadb16f8c"
PINNED_ESPEAK_RUNTIME_MANIFEST_SHA256 = "12370d2c3caea2c54afa50a4f95ab94eafdcaf71d46607d9bf0d7722225f3717"
PINNED_IPA_VOCABULARY_SHA256 = "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0"
PCM16_LSB_LINEAR = 1.0 / 32_768.0
MAX_AUDIO_BYTES = 1_073_741_824
MAX_EXECUTABLE_BYTES = 268_435_456
MAX_WHISPER_BYTES = 1_073_741_824
MAX_IPA_RUNNER_BYTES = 2 * 1024 * 1024
MAX_IPA_RESULT_BYTES = 256 * 1024
MAX_INDEPENDENT_IPA_PHASE_BYTES = 512 * 1024
MAX_IPA_ADJUDICATION_RESULT_BYTES = 512 * 1024
MAX_IPA_DURATION_SECONDS = 21.0
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
NUMBER_PATTERN = r"[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+)|inf)"
INTEGRATED_PATTERN = re.compile(rf"\bI:\s*({NUMBER_PATTERN})\s*LUFS\b", re.IGNORECASE)
TRUE_PEAK_PATTERN = re.compile(rf"\bPeak:\s*({NUMBER_PATTERN})\s*dBFS\b", re.IGNORECASE)

DialogueEvaluator = Callable[..., dict[str, object]]
LoudnessRunner = Callable[[Path, Path], tuple[float, float]]


class AnalysisError(RuntimeError):
    """A bounded, externally reportable analysis failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.independent_ipa_context: dict[str, object] | None = None


class JsonArgumentParser(argparse.ArgumentParser):
    """Keep argument failures inside the structured stdout contract."""

    def error(self, message: str) -> None:
        raise AnalysisError("arguments-invalid", message)

    def exit(self, _status: int = 0, message: str | None = None) -> None:
        detail = (message or "CLI-Hilfe wurde angefordert.").strip()
        raise AnalysisError("arguments-invalid", detail)


def _validate_sha256(value: str, label: str) -> str:
    normalized = value.strip().lower()
    if not SHA256_PATTERN.fullmatch(normalized):
        raise AnalysisError("arguments-invalid", f"{label} muss ein kleingeschriebener SHA-256-Wert sein.")
    return normalized


def _load_independent_ipa_phase(
    path: Path,
    *,
    expected_sha256: str,
    authority_audio_sha256: str,
) -> tuple[dict[str, object], str]:
    content, phase_sha256 = _read_stable_regular_file(
        path,
        expected_sha256=expected_sha256,
        maximum_bytes=MAX_INDEPENDENT_IPA_PHASE_BYTES,
        failure_code="arguments-invalid",
        label="Unabhängige IPA-Phase",
    )
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise AnalysisError(
            "arguments-invalid",
            "Die unabhängige IPA-Phase ist kein gültiges UTF-8-JSON-Dokument.",
        ) from error
    phase = _strict_json_loads(text, "Unabhängige IPA-Phase")
    if not isinstance(phase, dict):
        raise AnalysisError("arguments-invalid", "Die unabhängige IPA-Phase muss ein JSON-Objekt sein.")
    expected_fields = {
        "schemaVersion",
        "status",
        "reasonCode",
        "authorityAudioSha256",
        "sourceAudioSha256",
        "normalization",
        "observation",
        "error",
    }
    if set(phase) != expected_fields or phase.get("schemaVersion") != INDEPENDENT_IPA_PHASE_SCHEMA:
        raise AnalysisError("arguments-invalid", "Die unabhängige IPA-Phase erfüllt nicht Phase v2.")
    if phase.get("authorityAudioSha256") != authority_audio_sha256:
        raise AnalysisError(
            "arguments-invalid",
            "Die unabhängige IPA-Phase bindet nicht den autorisierten Audio-Snapshot.",
        )
    status = phase.get("status")
    if status not in {"measured", "insufficient", "failed"}:
        raise AnalysisError("arguments-invalid", "Der Status der unabhängigen IPA-Phase ist ungültig.")
    if status == "measured":
        observation = phase.get("observation")
        if not isinstance(observation, dict) or observation.get("targetConditioned") is not False:
            raise AnalysisError(
                "arguments-invalid",
                "Eine gemessene IPA-Phase muss nachweislich zieltextfrei sein.",
            )
    return phase, phase_sha256


def _load_ipa_adjudication_result(  # noqa: PLR0912, PLR0915
    path: Path,
    *,
    expected_sha256: str,
    expected_runner_sha256: str,
    expected_policy_sha256: str,
    expected_phase_sha256: str,
    expected_target_text_sha256: str,
    expected_source_phase_status: str,
) -> tuple[dict[str, object], str]:
    if _validate_sha256(
        expected_runner_sha256,
        "Erwarteter IPA-Adjudicator-Runner-Hash",
    ) != PINNED_IPA_ADJUDICATOR_RUNNER_SHA256:
        raise AnalysisError(
            "arguments-invalid",
            "Der IPA-Adjudicator-Runner weicht von der Worker-Authority ab.",
        )
    if _validate_sha256(
        expected_policy_sha256,
        "Erwarteter IPA-Adjudication-Policy-Hash",
    ) != PINNED_IPA_ADJUDICATION_POLICY_SHA256:
        raise AnalysisError(
            "arguments-invalid",
            "Die IPA-Adjudication-Policy weicht von der Worker-Authority ab.",
        )
    content, result_sha256 = _read_stable_regular_file(
        path,
        expected_sha256=expected_sha256,
        maximum_bytes=MAX_IPA_ADJUDICATION_RESULT_BYTES,
        failure_code="arguments-invalid",
        label="IPA-Adjudication-Ergebnis",
    )
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise AnalysisError(
            "arguments-invalid",
            "Das IPA-Adjudication-Ergebnis ist kein gueltiges UTF-8-JSON-Dokument.",
        ) from error
    raw = _strict_json_loads(text, "IPA-Adjudication-Ergebnis")
    expected_fields = {
        "schemaVersion",
        "status",
        "sourcePhaseStatus",
        "phaseSha256",
        "referenceSha256",
        "targetTextSha256",
        "normalizedTargetTextSha256",
        "espeakRuntimeManifestSha256",
        "ipaVocabularySha256",
        "espeakStdoutSha256",
        "g2pResultSha256",
        "runnerSha256",
        "policySha256",
        "measurement",
    }
    if not isinstance(raw, dict) or set(raw) != expected_fields:
        raise AnalysisError(
            "arguments-invalid",
            "Das IPA-Adjudication-Ergebnis enthaelt unerwartete oder fehlende Felder.",
        )
    result = raw
    if result.get("schemaVersion") != IPA_ADJUDICATION_RESULT_SCHEMA:
        raise AnalysisError("arguments-invalid", "Das IPA-Adjudication-Schema ist ungueltig.")
    expected_hashes = {
        "phaseSha256": _validate_sha256(expected_phase_sha256, "Erwarteter IPA-Phasenhash"),
        "targetTextSha256": _validate_sha256(
            expected_target_text_sha256,
            "Erwarteter Zieltexthash",
        ),
        "runnerSha256": PINNED_IPA_ADJUDICATOR_RUNNER_SHA256,
        "policySha256": PINNED_IPA_ADJUDICATION_POLICY_SHA256,
        "espeakRuntimeManifestSha256": PINNED_ESPEAK_RUNTIME_MANIFEST_SHA256,
        "ipaVocabularySha256": PINNED_IPA_VOCABULARY_SHA256,
    }
    if any(result.get(field) != digest for field, digest in expected_hashes.items()):
        raise AnalysisError(
            "arguments-invalid",
            "Das IPA-Adjudication-Ergebnis widerspricht der gebundenen Authority.",
        )
    for field in (
        "referenceSha256",
        "normalizedTargetTextSha256",
        "espeakStdoutSha256",
        "g2pResultSha256",
    ):
        value = result.get(field)
        if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
            raise AnalysisError("arguments-invalid", f"IPA-Adjudication-Feld {field} ist kein SHA-256.")
    source_status = result.get("sourcePhaseStatus")
    status = result.get("status")
    if (
        expected_source_phase_status not in {"measured", "insufficient", "failed"}
        or source_status != expected_source_phase_status
        or status not in {"measured", "unavailable"}
        or (status == "measured") is not (source_status == "measured")
    ):
        raise AnalysisError(
            "arguments-invalid",
            "IPA-Adjudication- und unabhaengiger IPA-Phasenstatus widersprechen einander.",
        )
    measurement = result.get("measurement")
    if status == "unavailable":
        if measurement is not None:
            raise AnalysisError(
                "arguments-invalid",
                "Eine nicht verfuegbare IPA-Adjudication darf keine Messung tragen.",
            )
        return result, result_sha256
    measurement_fields = {
        "substitutions",
        "deletions",
        "insertions",
        "editDistance",
        "referenceTokenCount",
        "hypothesisTokenCount",
        "normalizedPhoneErrorRate",
    }
    if not isinstance(measurement, dict) or set(measurement) != measurement_fields:
        raise AnalysisError("arguments-invalid", "Die rohe IPA-Editmessung ist unvollstaendig.")
    for field in (
        "substitutions",
        "deletions",
        "insertions",
        "editDistance",
        "hypothesisTokenCount",
    ):
        if not _plain_integer(measurement.get(field), 0, 1_049):
            raise AnalysisError("arguments-invalid", f"IPA-Messfeld {field} ist ungueltig.")
    if not _plain_integer(measurement.get("referenceTokenCount"), 1, 1_049):
        raise AnalysisError("arguments-invalid", "IPA-Referenztokenzahl ist ungueltig.")
    edit_distance = int(measurement["editDistance"])
    reference_count = int(measurement["referenceTokenCount"])
    rate = measurement.get("normalizedPhoneErrorRate")
    if (
        edit_distance
        != int(measurement["substitutions"])
        + int(measurement["deletions"])
        + int(measurement["insertions"])
        or not _finite_in_range(rate, 0, 1_049)
        or float(rate) != edit_distance / reference_count
    ):
        raise AnalysisError(
            "arguments-invalid",
            "IPA-S/D/I, Editdistanz und rohe normalisierte Fehlerrate sind inkonsistent.",
        )
    return result, result_sha256


def _strict_json_loads(content: str, label: str) -> object:
    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise AnalysisError("internal-error", f"{label} enthält den doppelten Schlüssel {key}.")
            value[key] = item
        return value

    def reject_constant(value: str) -> object:
        raise AnalysisError("internal-error", f"{label} enthält die nicht-endliche Zahl {value}.")

    try:
        return json.loads(
            content,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except json.JSONDecodeError as error:
        raise AnalysisError("internal-error", f"{label} ist kein gültiges JSON-Dokument.") from error


def _finite_number(value: object, label: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise AnalysisError("arguments-invalid", f"{label} muss eine Zahl sein.") from error
    if not math.isfinite(parsed):
        raise AnalysisError("arguments-invalid", f"{label} muss endlich sein.")
    return parsed


def _utf16_code_unit_length(value: str) -> int:
    return sum(2 if ord(character) > 0xFFFF else 1 for character in value)


def _truncate_utf16(value: str, maximum_units: int) -> str:
    used_units = 0
    characters: list[str] = []
    for character in value:
        character_units = 2 if ord(character) > 0xFFFF else 1
        if used_units + character_units > maximum_units:
            break
        characters.append(character)
        used_units += character_units
    return "".join(characters)


def _read_stable_regular_file(
    path: Path,
    *,
    expected_sha256: str,
    maximum_bytes: int,
    failure_code: str,
    label: str,
) -> tuple[bytes, str]:
    expected = _validate_sha256(expected_sha256, f"Erwarteter {label}-Hash")
    try:
        before = path.lstat()
    except OSError as error:
        raise AnalysisError(
            failure_code,
            f"{label} ist nicht als reguläre Datei verfügbar: {error.strerror}.",
        ) from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise AnalysisError(failure_code, f"{label} muss eine reguläre Datei ohne Symlink sein.")
    if before.st_size <= 0 or before.st_size > maximum_bytes:
        raise AnalysisError(failure_code, f"{label} hat eine unzulässige Dateigröße.")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or opened.st_size != before.st_size
            or opened.st_mtime_ns != before.st_mtime_ns
            or opened.st_ctime_ns != before.st_ctime_ns
        ):
            raise AnalysisError(failure_code, f"{label} wurde vor dem Snapshot ausgetauscht.")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(1_048_576, remaining))
            if not chunk:
                raise AnalysisError(failure_code, f"{label} endete vor der gebundenen Dateigröße.")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_dev != opened.st_dev
            or after.st_ino != opened.st_ino
            or after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
        ):
            raise AnalysisError(failure_code, f"{label} wurde während des Snapshots verändert.")
    except AnalysisError:
        raise
    except OSError as error:
        raise AnalysisError(failure_code, f"{label} konnte nicht stabil gelesen werden: {error.strerror}.") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    content = b"".join(chunks)
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        mismatch_code = "audio-hash-mismatch" if failure_code == "audio-snapshot-invalid" else failure_code
        raise AnalysisError(mismatch_code, f"{label}-Snapshot stimmt nicht mit dem erwarteten SHA-256 überein.")
    return content, actual


def _extract_wave_chunks(content: bytes) -> tuple[bytes, bytes]:
    if len(content) < 44 or content[:4] != b"RIFF" or content[8:12] != b"WAVE":
        raise AnalysisError("wav-container-invalid", "Nur ein vollständiger RIFF/WAVE-Snapshot ist zulässig.")
    riff_size = struct.unpack_from("<I", content, 4)[0]
    if riff_size + 8 != len(content):
        raise AnalysisError("wav-container-invalid", "Die RIFF-Längenangabe bindet nicht den vollständigen Snapshot.")

    format_payload: bytes | None = None
    audio_payload: bytes | None = None
    offset = 12
    while offset < len(content):
        if offset + 8 > len(content):
            raise AnalysisError("wav-container-invalid", "Ein WAV-Chunk-Header ist abgeschnitten.")
        chunk_id = content[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", content, offset + 4)[0]
        payload_start = offset + 8
        payload_end = payload_start + chunk_size
        padded_end = payload_end + (chunk_size & 1)
        if payload_end > len(content) or padded_end > len(content):
            raise AnalysisError("wav-container-invalid", "Ein WAV-Chunk überschreitet den gebundenen Snapshot.")
        payload = content[payload_start:payload_end]
        if chunk_id == b"fmt ":
            if format_payload is not None:
                raise AnalysisError("wav-format-unsupported", "Mehrere fmt-Chunks sind nicht zulässig.")
            format_payload = payload
        elif chunk_id == b"data":
            if audio_payload is not None:
                raise AnalysisError("wav-data-invalid", "Mehrere data-Chunks sind nicht zulässig.")
            audio_payload = payload
        offset = padded_end
    if offset != len(content):
        raise AnalysisError("wav-container-invalid", "Der WAV-Chunk-Snapshot endet nicht an der RIFF-Grenze.")
    if format_payload is None or audio_payload is None:
        raise AnalysisError("wav-container-invalid", "RIFF/WAVE benötigt genau einen fmt- und einen data-Chunk.")
    return format_payload, audio_payload


def _parse_pcm16_format(format_payload: bytes) -> tuple[int, int, int, int]:
    if len(format_payload) != 16:
        raise AnalysisError("wav-format-unsupported", "Nur der kanonische 16-Byte-PCM-fmt-Chunk ist zulässig.")

    format_tag, channels, sample_rate, byte_rate, block_align, bits_per_sample = struct.unpack(
        "<HHIIHH",
        format_payload,
    )
    if format_tag != 1 or bits_per_sample != 16:
        raise AnalysisError("wav-format-unsupported", "Nur unverpacktes RIFF/WAVE PCM16 ist zulässig.")
    if channels < 1 or channels > 32 or sample_rate < 1 or sample_rate > 384_000:
        raise AnalysisError("wav-format-unsupported", "Kanalzahl oder Samplerate liegt außerhalb des Messvertrags.")
    expected_block_align = channels * 2
    if block_align != expected_block_align or byte_rate != sample_rate * expected_block_align:
        raise AnalysisError("wav-format-unsupported", "PCM16-Blockausrichtung oder Byte-Rate ist inkonsistent.")
    return format_tag, channels, sample_rate, block_align


def parse_pcm16_wav(content: bytes) -> tuple[dict[str, object], dict[str, object]]:
    format_payload, audio_payload = _extract_wave_chunks(content)
    format_tag, channels, sample_rate, block_align = _parse_pcm16_format(format_payload)
    if not audio_payload or len(audio_payload) % block_align != 0:
        raise AnalysisError("wav-data-invalid", "Der PCM16-data-Chunk ist leer oder nicht framebündig.")

    samples = array.array("h")
    samples.frombytes(audio_payload)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples or not all(math.isfinite(float(sample)) for sample in samples):
        raise AnalysisError("wav-data-invalid", "PCM16 enthält keine endlichen Samples.")
    absolute_peak = max(abs(sample) for sample in samples)
    if absolute_peak == 0:
        raise AnalysisError("audio-silent", "Ein vollständig stiller PCM16-Snapshot ist nicht auswertbar.")

    total_samples = len(samples)
    sample_frames = len(audio_payload) // block_align
    peak_linear = absolute_peak / 32_768.0
    clipped_samples = sum(sample in (-32_768, 32_767) for sample in samples)
    wav = {
        "container": "RIFF/WAVE",
        "codec": "pcm_s16le",
        "formatTag": format_tag,
        "bitsPerSample": 16,
        "channels": channels,
        "sampleRateHz": sample_rate,
        "sampleFrames": sample_frames,
        "durationSeconds": sample_frames / sample_rate,
    }
    pcm = {
        "totalSamples": total_samples,
        "samplePeakLinear": peak_linear,
        "samplePeakDbfs": 20.0 * math.log10(peak_linear),
        "fullScaleClippedSamples": clipped_samples,
        "fullScaleClippedRatio": clipped_samples / total_samples,
    }
    return wav, pcm


def ffmpeg_ebur128_command(ffmpeg_path: Path, audio_path: Path) -> list[str]:
    return [
        str(ffmpeg_path),
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-v",
        "info",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        str(audio_path),
        "-filter_complex",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]


def parse_ebur128_output(output: str) -> tuple[float, float]:
    integrated_matches = INTEGRATED_PATTERN.findall(output)
    true_peak_matches = TRUE_PEAK_PATTERN.findall(output)
    if not integrated_matches or not true_peak_matches:
        raise AnalysisError(
            "loudness-measurement-failed",
            "FFmpeg ebur128 lieferte keine vollständige Abschlussmessung.",
        )
    try:
        integrated_lufs = float(integrated_matches[-1])
        true_peak_dbtp = float(true_peak_matches[-1])
    except ValueError as error:
        raise AnalysisError("loudness-measurement-failed", "FFmpeg ebur128 lieferte ungültige Zahlenwerte.") from error
    if not math.isfinite(integrated_lufs) or not math.isfinite(true_peak_dbtp):
        raise AnalysisError("loudness-measurement-failed", "LUFS und True Peak müssen vollständig und endlich sein.")
    return integrated_lufs, true_peak_dbtp


def measure_loudness(audio_path: Path, ffmpeg_path: Path) -> tuple[float, float]:
    environment = _offline_environment(ffmpeg_path.parent)
    try:
        result = subprocess.run(
            ffmpeg_ebur128_command(ffmpeg_path, audio_path),
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AnalysisError(
            "loudness-measurement-failed",
            f"FFmpeg ebur128 konnte nicht ausgeführt werden: {error}.",
        ) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unbekannter FFmpeg-Fehler").strip().splitlines()[-1]
        raise AnalysisError("loudness-measurement-failed", f"FFmpeg ebur128 ist fehlgeschlagen: {detail}"[:500])
    return parse_ebur128_output(f"{result.stdout}\n{result.stderr}")


def independent_ipa_normalization_command(
    ffmpeg_path: Path,
    audio_path: Path,
    output_path: Path,
) -> list[str]:
    return [
        str(ffmpeg_path),
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        str(audio_path),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        "-y",
        str(output_path),
    ]


def _validate_independent_ipa_result(
    value: object,
    *,
    expected_audio_sha256: str,
    expected_runner_sha256: str,
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise AnalysisError("independent-ipa-invalid", "Der unabhängige IPA-Runner lieferte kein Objekt.")
    common = {"schemaVersion", "status", "error", "method", "targetConditioned"}
    if value.get("schemaVersion") != INDEPENDENT_IPA_RESULT_SCHEMA or value.get("targetConditioned") is not False:
        raise AnalysisError("independent-ipa-invalid", "Der unabhängige IPA-Vertrag ist ungültig.")
    if value.get("status") == "failed":
        if set(value) != common or not isinstance(value.get("error"), str):
            raise AnalysisError("independent-ipa-invalid", "Das IPA-Fehlerdokument ist ungültig.")
        return value
    expected_fields = common | {
        "decoderPolicy",
        "runnerSha256",
        "executionBoundary",
        "sourceAudio",
        "modelFingerprint",
        "modelManifestSha256",
        "modelWeightSha256",
        "runtime",
        "observation",
    }
    if value.get("status") != "measured" or set(value) != expected_fields or value.get("error") is not None:
        raise AnalysisError("independent-ipa-invalid", "Das IPA-Messdokument ist unvollständig.")
    source_audio = value.get("sourceAudio")
    if (
        value.get("runnerSha256") != expected_runner_sha256
        or not isinstance(source_audio, dict)
        or source_audio.get("sha256") != expected_audio_sha256
        or source_audio.get("sampleRateHz") != 16_000
        or source_audio.get("channels") != 1
    ):
        raise AnalysisError("independent-ipa-invalid", "Die IPA-Messung ist nicht an Audio und Runner gebunden.")
    for key in ("modelFingerprint", "modelManifestSha256", "modelWeightSha256"):
        if not isinstance(value.get(key), str) or not SHA256_PATTERN.fullmatch(value[key]):
            raise AnalysisError("independent-ipa-invalid", f"IPA-Feld {key} ist kein SHA-256.")
    if not isinstance(value.get("observation"), dict) or not isinstance(value.get("runtime"), dict):
        raise AnalysisError("independent-ipa-invalid", "IPA-Beobachtung oder Laufzeitbeleg fehlt.")
    return value


def _analyze_independent_ipa_observation(
    *,
    audio_path: Path,
    authority_audio_sha256: str,
    ffmpeg_path: Path,
    independent_ipa_runner_path: Path,
    expected_independent_ipa_runner_sha256: str,
    independent_ipa_model_path: Path,
    phase_context: dict[str, object],
) -> dict[str, object]:
    enforce_offline_runtime()
    audio_content, audio_sha256 = _read_stable_regular_file(
        audio_path,
        expected_sha256=authority_audio_sha256,
        maximum_bytes=MAX_AUDIO_BYTES,
        failure_code="audio-snapshot-invalid",
        label="Audio",
    )
    phase_context["sourceAudioSha256"] = audio_sha256
    wav, _pcm = parse_pcm16_wav(audio_content)
    duration_seconds = float(wav["durationSeconds"])
    if duration_seconds > MAX_IPA_DURATION_SECONDS:
        return {
            "schemaVersion": INDEPENDENT_IPA_PHASE_SCHEMA,
            "status": "insufficient",
            "reasonCode": "duration-exceeds-independent-ipa-window",
            "authorityAudioSha256": authority_audio_sha256,
            "sourceAudioSha256": audio_sha256,
            "normalization": None,
            "observation": None,
            "error": None,
        }
    _, ffmpeg_sha256 = _read_stable_regular_file(
        ffmpeg_path,
        expected_sha256=PINNED_FFMPEG_SHA256,
        maximum_bytes=MAX_EXECUTABLE_BYTES,
        failure_code="ffmpeg-unverified",
        label="FFmpeg",
    )
    if not os.access(ffmpeg_path, os.X_OK):
        raise AnalysisError("ffmpeg-unverified", "Die verifizierte FFmpeg-Datei ist nicht ausführbar.")
    runner_content, runner_sha256 = _read_stable_regular_file(
        independent_ipa_runner_path,
        expected_sha256=expected_independent_ipa_runner_sha256,
        maximum_bytes=MAX_IPA_RUNNER_BYTES,
        failure_code="independent-ipa-unverified",
        label="IPA-Runner",
    )
    if not runner_content.startswith(b"#!/usr/bin/env python3\n"):
        raise AnalysisError("independent-ipa-unverified", "Der gebundene IPA-Runner ist ungültig.")
    if not independent_ipa_model_path.is_absolute():
        raise AnalysisError("independent-ipa-unverified", "Der IPA-Modellpfad muss absolut gebunden sein.")

    environment = {
        **_offline_environment(ffmpeg_path.parent),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONSAFEPATH": "1",
        "OMP_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "OPENBLAS_NUM_THREADS": "2",
        "TOKENIZERS_PARALLELISM": "false",
    }
    with tempfile.TemporaryDirectory(prefix="ltx-t2a-independent-ipa-") as temporary_directory:
        root = Path(temporary_directory)
        source_snapshot = root / "source.wav"
        normalized_snapshot = root / "normalized.wav"
        _write_bound_snapshot(source_snapshot, audio_content, 0o400)
        try:
            normalization = subprocess.run(
                independent_ipa_normalization_command(ffmpeg_path, source_snapshot, normalized_snapshot),
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
                env=environment,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise AnalysisError(
                "independent-ipa-normalization-failed",
                f"IPA-Audionormalisierung konnte nicht ausgeführt werden: {error}.",
            ) from error
        if normalization.returncode != 0:
            detail = (normalization.stderr or normalization.stdout or "FFmpeg-Fehler").strip()[-300:]
            raise AnalysisError(
                "independent-ipa-normalization-failed",
                f"IPA-Audionormalisierung ist fehlgeschlagen: {detail}",
            )
        try:
            normalized_bytes = normalized_snapshot.read_bytes()
        except OSError as error:
            raise AnalysisError(
                "independent-ipa-normalization-failed",
                "Die normalisierte IPA-Audiodatei fehlt.",
            ) from error
        normalized_sha256 = hashlib.sha256(normalized_bytes).hexdigest()
        normalized_content, _ = _read_stable_regular_file(
            normalized_snapshot,
            expected_sha256=normalized_sha256,
            maximum_bytes=1_048_576,
            failure_code="independent-ipa-normalization-failed",
            label="normalisiertes IPA-Audio",
        )
        normalized_wav, _normalized_pcm = parse_pcm16_wav(normalized_content)
        if (
            normalized_wav.get("sampleRateHz") != 16_000
            or normalized_wav.get("channels") != 1
            or float(normalized_wav["durationSeconds"]) > MAX_IPA_DURATION_SECONDS
        ):
            raise AnalysisError(
                "independent-ipa-normalization-failed",
                "Die IPA-Audionormalisierung erfüllt Mono/16-kHz/21-s nicht.",
            )
        normalization_evidence = {
            "method": INDEPENDENT_IPA_NORMALIZATION_METHOD,
            "ffmpegSha256": ffmpeg_sha256,
            "normalizedAudioSha256": normalized_sha256,
            "sampleRateHz": 16_000,
            "channels": 1,
            "durationMilliseconds": round(float(normalized_wav["durationSeconds"]) * 1000),
        }
        phase_context["normalization"] = normalization_evidence
        request = {
            "schemaVersion": INDEPENDENT_IPA_REQUEST_SCHEMA,
            "audioPath": str(normalized_snapshot),
            "audioSha256": normalized_sha256,
        }
        try:
            execution = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(independent_ipa_runner_path),
                    "--model-directory",
                    str(independent_ipa_model_path),
                ],
                input=json.dumps(request, ensure_ascii=True, allow_nan=False, separators=(",", ":")),
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
                env=environment,
                close_fds=True,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise AnalysisError(
                "independent-ipa-failed",
                f"Der unabhängige IPA-Runner konnte nicht abgeschlossen werden: {error}.",
            ) from error
        if len(execution.stdout.encode()) > MAX_IPA_RESULT_BYTES or len(execution.stderr.encode()) > 32 * 1024:
            raise AnalysisError("independent-ipa-invalid", "Die IPA-Runner-Ausgabe überschreitet das Limit.")
        lines = execution.stdout.strip().splitlines()
        if len(lines) != 1 or not lines[0]:
            raise AnalysisError("independent-ipa-invalid", "Der IPA-Runner lieferte nicht genau ein JSON-Dokument.")
        observation = _validate_independent_ipa_result(
            _strict_json_loads(lines[0], "IPA-Runner-Ausgabe"),
            expected_audio_sha256=normalized_sha256,
            expected_runner_sha256=runner_sha256,
        )
        if (execution.returncode == 0) != (observation.get("status") == "measured"):
            raise AnalysisError("independent-ipa-invalid", "IPA-Exitcode und Ergebnisstatus widersprechen einander.")

    if observation["status"] == "failed":
        runner_message = _truncate_utf16(str(observation["error"]).strip(), 500)
        if not runner_message:
            runner_message = "Der gebundene unabhängige IPA-Runner ist fehlgeschlagen."
        return {
            "schemaVersion": INDEPENDENT_IPA_PHASE_SCHEMA,
            "status": "failed",
            "reasonCode": "independent-ipa-runner-failed",
            "authorityAudioSha256": authority_audio_sha256,
            "sourceAudioSha256": audio_sha256,
            "normalization": normalization_evidence,
            "observation": None,
            "error": {
                "code": "independent-ipa-runner-failed",
                "message": runner_message,
            },
        }
    return {
        "schemaVersion": INDEPENDENT_IPA_PHASE_SCHEMA,
        "status": "measured",
        "reasonCode": None,
        "authorityAudioSha256": authority_audio_sha256,
        "sourceAudioSha256": audio_sha256,
        "normalization": normalization_evidence,
        "observation": observation,
        "error": None,
    }


def analyze_independent_ipa_observation(
    *,
    audio_path: Path,
    expected_audio_sha256: str,
    ffmpeg_path: Path,
    independent_ipa_runner_path: Path,
    expected_independent_ipa_runner_sha256: str,
    independent_ipa_model_path: Path,
) -> dict[str, object]:
    authority_audio_sha256 = _validate_sha256(
        expected_audio_sha256,
        "Erwarteter Audio-Hash",
    )
    phase_context: dict[str, object] = {
        "authorityAudioSha256": authority_audio_sha256,
        "sourceAudioSha256": None,
        "normalization": None,
    }
    try:
        return _analyze_independent_ipa_observation(
            audio_path=audio_path,
            authority_audio_sha256=authority_audio_sha256,
            ffmpeg_path=ffmpeg_path,
            independent_ipa_runner_path=independent_ipa_runner_path,
            expected_independent_ipa_runner_sha256=expected_independent_ipa_runner_sha256,
            independent_ipa_model_path=independent_ipa_model_path,
            phase_context=phase_context,
        )
    except AnalysisError as error:
        error.independent_ipa_context = phase_context
        raise
    except Exception as error:
        internal = AnalysisError("internal-error", f"{type(error).__name__}: {error}")
        internal.independent_ipa_context = phase_context
        raise internal from error


def _offline_environment(ffmpeg_directory: Path) -> dict[str, str]:
    return {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "PYTHONNOUSERSITE": "1",
        "CUDA_VISIBLE_DEVICES": "",
        "LC_ALL": "C",
        "LANG": "C",
        "PATH": str(ffmpeg_directory),
        "NO_PROXY": "",
        "no_proxy": "",
    }


@contextlib.contextmanager
def _offline_process_environment(ffmpeg_directory: Path) -> Iterator[None]:
    previous = dict(os.environ)
    os.environ.clear()
    os.environ.update(_offline_environment(ffmpeg_directory))
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


def _deny_ip_network(event: str, arguments: tuple[object, ...]) -> None:
    if event in {
        "socket.getaddrinfo",
        "socket.gethostbyaddr",
        "socket.gethostbyname",
        "socket.getnameinfo",
        "urllib.Request",
    }:
        raise RuntimeError("Netzwerkzugriffe sind im T2A-Audio-QA-Worker deaktiviert.")
    if event == "socket.__new__" and len(arguments) >= 2:
        if arguments[1] in (socket.AF_INET, socket.AF_INET6):
            raise RuntimeError("Netzwerkzugriffe sind im T2A-Audio-QA-Worker deaktiviert.")
        return
    if event not in {
        "socket.bind",
        "socket.connect",
        "socket.sendmsg",
        "socket.sendto",
    } or not arguments:
        return
    candidate = arguments[0]
    if isinstance(candidate, socket.socket) and candidate.family in (socket.AF_INET, socket.AF_INET6):
        raise RuntimeError("Netzwerkzugriffe sind im T2A-Audio-QA-Worker deaktiviert.")


_AUDIT_HOOK_INSTALLED = False
_INHERITED_FD_GATE_PASSED = False


def _assert_no_inherited_socket_descriptors() -> None:
    try:
        descriptor_paths = list(Path("/proc/self/fd").iterdir())
    except OSError as error:
        raise AnalysisError(
            "offline-runtime-unverified",
            f"Geerbte Dateideskriptoren konnten nicht fail-closed geprüft werden: {error.strerror}.",
        ) from error
    for descriptor_path in descriptor_paths:
        name = descriptor_path.name
        if not name.isdecimal():
            raise AnalysisError(
                "offline-runtime-unverified",
                "Die Prozessdeskriptoren konnten nicht eindeutig geprüft werden.",
            )
        descriptor = int(name)
        if descriptor <= 2:
            continue
        try:
            descriptor_mode = os.fstat(descriptor).st_mode
        except OSError as error:
            if error.errno == errno.EBADF:
                continue
            raise AnalysisError(
                "offline-runtime-unverified",
                f"Geerbter Deskriptor {descriptor} konnte nicht geprüft werden: {error.strerror}.",
            ) from error
        if stat.S_ISSOCK(descriptor_mode):
            raise AnalysisError(
                "offline-runtime-unverified",
                f"Geerbter Socket-Deskriptor {descriptor} verhindert eine nachweislich offline Analyse.",
            )


def enforce_offline_runtime() -> None:
    global _AUDIT_HOOK_INSTALLED, _INHERITED_FD_GATE_PASSED  # noqa: PLW0603
    if not _AUDIT_HOOK_INSTALLED:
        sys.addaudithook(_deny_ip_network)
        _AUDIT_HOOK_INSTALLED = True
    if not _INHERITED_FD_GATE_PASSED:
        _assert_no_inherited_socket_descriptors()
        _INHERITED_FD_GATE_PASSED = True


def _default_dialogue_evaluator(**arguments: object) -> dict[str, object]:
    scripts_directory = str(Path(__file__).resolve().parent)
    if scripts_directory not in sys.path:
        sys.path.insert(0, scripts_directory)
    from dialogue_word_evaluator import evaluate_dialogue  # noqa: PLC0415

    return evaluate_dialogue(**arguments)


AUDIO_DIALOGUE_FIELDS = (
    "status",
    "blockerCode",
    "error",
    "method",
    "modelName",
    "modelSha256",
    "packageVersion",
    "detectedLanguage",
    "expectedTranscriptSha256",
    "expectedWordCount",
    "recognizedWordCount",
    "recognizedTranscript",
    "wordErrorRate",
    "substitutions",
    "deletions",
    "insertions",
    "rawAsrContentGate",
    "phonemeVerification",
    "guidedAlignedWordCount",
    "guidedWordCoverage",
    "usableAlignedWordCount",
    "usableGuidedWordCoverage",
    "medianGuidedWordProbability",
    "p10GuidedWordProbability",
    "lowConfidenceAlignedWords",
    "alignmentStatus",
    "alignmentError",
    "timePrecisionMilliseconds",
    "guidedWords",
)
GUIDED_WORD_FIELDS = (
    "index",
    "word",
    "normalizedWord",
    "tokenIds",
    "startSeconds",
    "endSeconds",
    "probability",
    "usable",
)
RAW_ASR_GATE_FIELDS = (
    "status",
    "method",
    "targetConditioned",
    "exactTokenMatch",
    "expectedNormalizedWords",
    "recognizedNormalizedWords",
    "prefixInsertions",
    "internalInsertions",
    "suffixInsertions",
    "deletedExpectedWords",
    "substitutedWords",
    "repeatedInsertions",
)
PHONEME_VERIFICATION_FIELDS = ("status", "method", "reason")


def _dialogue_requirement(condition: bool, message: str) -> None:
    if not condition:
        raise AnalysisError("internal-error", f"Ungültige lokale Dialogauswertung: {message}")


def _plain_integer(value: object, minimum: int, maximum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _finite_in_range(value: object, minimum: float, maximum: float) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and minimum <= float(value) <= maximum
    )


def _nullable_bounded_text(value: object, minimum: int, maximum: int) -> bool:
    return value is None or (
        isinstance(value, str)
        and minimum <= _utf16_code_unit_length(value) <= maximum
    )


def _project_guided_words(value: object) -> list[dict[str, object]]:
    _dialogue_requirement(isinstance(value, list) and len(value) <= 200, "guidedWords ist keine begrenzte Liste.")
    projected: list[dict[str, object]] = []
    previous_start = -1.0
    previous_end = -1.0
    for index, candidate in enumerate(value):
        _dialogue_requirement(isinstance(candidate, dict), "Ein geführtes Wort ist kein Objekt.")
        _dialogue_requirement(
            all(field in candidate for field in GUIDED_WORD_FIELDS),
            "Ein geführtes Wort ist unvollständig.",
        )
        word = {field: candidate[field] for field in GUIDED_WORD_FIELDS}
        _dialogue_requirement(
            _plain_integer(word["index"], 0, 199) and word["index"] == index,
            "Wortindizes sind nicht lückenlos.",
        )
        _dialogue_requirement(
            isinstance(word["word"], str) and 1 <= _utf16_code_unit_length(word["word"]) <= 80,
            "Ein sichtbares Wort ist ungültig.",
        )
        _dialogue_requirement(
            isinstance(word["normalizedWord"], str)
            and 1 <= _utf16_code_unit_length(word["normalizedWord"]) <= 80,
            "Ein normalisiertes Wort ist ungültig.",
        )
        token_ids = word["tokenIds"]
        _dialogue_requirement(
            isinstance(token_ids, list)
            and 1 <= len(token_ids) <= 32
            and all(_plain_integer(token, 0, MAX_SAFE_INTEGER) for token in token_ids),
            "Whisper-Token-IDs sind ungültig.",
        )
        _dialogue_requirement(
            _finite_in_range(word["startSeconds"], 0, 30)
            and _finite_in_range(word["endSeconds"], 0, 30),
            "Wortzeiten sind nicht endlich oder außerhalb des Messfensters.",
        )
        start = float(word["startSeconds"])
        end = float(word["endSeconds"])
        _dialogue_requirement(
            end >= start >= previous_start and end >= previous_end,
            "Wortzeiten sind nicht monoton.",
        )
        _dialogue_requirement(
            _finite_in_range(word["probability"], 0, 1),
            "Wortwahrscheinlichkeit ist ungültig.",
        )
        _dialogue_requirement(isinstance(word["usable"], bool), "Wortnutzbarkeit ist kein Boolean.")
        expected_usable = float(word["probability"]) >= 0.15 and end > start
        _dialogue_requirement(
            word["usable"] is expected_usable,
            "Wortnutzbarkeit widerspricht Wahrscheinlichkeit oder Zeitfenster.",
        )
        previous_start = start
        previous_end = end
        projected.append(word)
    return projected


def _project_content_word_list(value: object, maximum: int, label: str) -> list[str]:
    _dialogue_requirement(isinstance(value, list) and len(value) <= maximum, f"{label} ist keine begrenzte Liste.")
    _dialogue_requirement(
        all(isinstance(word, str) and 1 <= _utf16_code_unit_length(word) <= 4_000 for word in value),
        f"{label} enthaelt ungueltige normalisierte Woerter.",
    )
    return list(value)


def _project_raw_asr_content_gate(value: object) -> dict[str, object]:  # noqa: PLR0915
    _dialogue_requirement(isinstance(value, dict), "Raw-ASR-Content-Gate ist kein Objekt.")
    _dialogue_requirement(
        all(field in value for field in RAW_ASR_GATE_FIELDS),
        "Raw-ASR-Content-Gate ist unvollstaendig.",
    )
    gate = {field: value[field] for field in RAW_ASR_GATE_FIELDS}
    _dialogue_requirement(gate["status"] in {"passed", "failed", "not-measured"}, "Raw-ASR-Gate-Status ist unbekannt.")
    _dialogue_requirement(
        gate["method"] == "whisper-small-independent-raw-asr-token-edits.v1"
        and gate["targetConditioned"] is False,
        "Raw-ASR-Content-Gate ist nicht unabhaengig gebunden.",
    )
    _dialogue_requirement(
        gate["exactTokenMatch"] is None or isinstance(gate["exactTokenMatch"], bool),
        "Raw-ASR-Exact-Match ist ungueltig.",
    )
    expected = _project_content_word_list(gate["expectedNormalizedWords"], 200, "Erwartete Raw-ASR-Woerter")
    recognized = _project_content_word_list(gate["recognizedNormalizedWords"], 400, "Erkannte Raw-ASR-Woerter")
    gate["expectedNormalizedWords"] = expected
    gate["recognizedNormalizedWords"] = recognized

    def insertion_facts(candidate: object, label: str) -> list[dict[str, object]]:
        _dialogue_requirement(isinstance(candidate, list) and len(candidate) <= 400, f"{label} ist ungueltig.")
        projected_facts = []
        for fact in candidate:
            _dialogue_requirement(
                isinstance(fact, dict) and all(field in fact for field in ("recognizedIndex", "word")),
                f"{label} enthaelt einen unvollstaendigen Befund.",
            )
            index = fact["recognizedIndex"]
            word = fact["word"]
            _dialogue_requirement(
                _plain_integer(index, 0, 399)
                and index < len(recognized)
                and isinstance(word, str)
                and recognized[index] == word,
                f"{label} ist nicht an die erkannten Woerter gebunden.",
            )
            projected_facts.append({"recognizedIndex": index, "word": word})
        return projected_facts

    for field in ("prefixInsertions", "internalInsertions", "suffixInsertions", "repeatedInsertions"):
        gate[field] = insertion_facts(gate[field], field)
    deletions = gate["deletedExpectedWords"]
    _dialogue_requirement(isinstance(deletions, list) and len(deletions) <= 200, "Delete-Befunde sind ungueltig.")
    projected_deletions = []
    for fact in deletions:
        _dialogue_requirement(
            isinstance(fact, dict) and all(field in fact for field in ("expectedIndex", "word")),
            "Ein Delete-Befund ist unvollstaendig.",
        )
        index = fact["expectedIndex"]
        word = fact["word"]
        _dialogue_requirement(
            _plain_integer(index, 0, 199) and index < len(expected) and expected[index] == word,
            "Ein Delete-Befund ist nicht an die erwarteten Woerter gebunden.",
        )
        projected_deletions.append({"expectedIndex": index, "word": word})
    gate["deletedExpectedWords"] = projected_deletions
    substitutions = gate["substitutedWords"]
    _dialogue_requirement(isinstance(substitutions, list) and len(substitutions) <= 200, "Substitutionsbefunde sind ungueltig.")
    projected_substitutions = []
    for fact in substitutions:
        required = ("expectedIndex", "recognizedIndex", "expectedWord", "recognizedWord")
        _dialogue_requirement(isinstance(fact, dict) and all(field in fact for field in required), "Substitutionsbefund ist unvollstaendig.")
        expected_index = fact["expectedIndex"]
        recognized_index = fact["recognizedIndex"]
        _dialogue_requirement(
            _plain_integer(expected_index, 0, 199)
            and expected_index < len(expected)
            and _plain_integer(recognized_index, 0, 399)
            and recognized_index < len(recognized)
            and fact["expectedWord"] == expected[expected_index]
            and fact["recognizedWord"] == recognized[recognized_index]
            and fact["expectedWord"] != fact["recognizedWord"],
            "Substitutionsbefund ist nicht an die Wortlisten gebunden.",
        )
        projected_substitutions.append({field: fact[field] for field in required})
    gate["substitutedWords"] = projected_substitutions
    exact = expected == recognized
    edit_count = (
        len(gate["prefixInsertions"])
        + len(gate["internalInsertions"])
        + len(gate["suffixInsertions"])
        + len(gate["deletedExpectedWords"])
        + len(gate["substitutedWords"])
    )
    if gate["status"] == "not-measured":
        _dialogue_requirement(
            gate["exactTokenMatch"] is None and not recognized and edit_count == 0 and not gate["repeatedInsertions"],
            "Ein ungepruefter Raw-ASR-Gate traegt erfundene Befunde.",
        )
    else:
        _dialogue_requirement(
            gate["exactTokenMatch"] is exact and (gate["status"] == "passed") is exact,
            "Raw-ASR-Gate-Status widerspricht den Wortlisten.",
        )
    return gate


def _project_phoneme_verification(value: object) -> dict[str, object]:
    _dialogue_requirement(isinstance(value, dict), "Phonempruefung ist kein Objekt.")
    _dialogue_requirement(
        all(field in value for field in PHONEME_VERIFICATION_FIELDS),
        "Phonempruefung ist unvollstaendig.",
    )
    projected = {field: value[field] for field in PHONEME_VERIFICATION_FIELDS}
    _dialogue_requirement(
        projected == {
            "status": "not-available",
            "method": None,
            "reason": "Kein unabhaengig gebundener Zweit-Recognizer oder Phonem-Scorer ist verfuegbar.",
        },
        "Nicht vorhandene Phonem-Evidenz darf nicht als Messung deklariert werden.",
    )
    return projected


def project_audio_dialogue_evaluation(  # noqa: PLR0915
    value: object,
    expected_transcript: str,
) -> dict[str, object]:
    _dialogue_requirement(isinstance(value, dict), "Ergebnis ist kein Objekt.")
    _dialogue_requirement(
        all(field in value for field in AUDIO_DIALOGUE_FIELDS),
        "Ergebnis enthält nicht alle Audio-Dialogfelder.",
    )
    projected = {field: value[field] for field in AUDIO_DIALOGUE_FIELDS}
    status = projected["status"]
    blocker = projected["blockerCode"]
    allowed_blockers = {
        "measured": {"none"},
        "insufficient": {
            "target-transcript-too-long",
            "audio-missing",
            "duration-out-of-range",
            "alignment-insufficient",
        },
        "failed": {"evaluator-failed"},
        "not-applicable": {"target-transcript-missing"},
        "not-available": {"model-missing", "model-invalid", "runtime-unavailable"},
    }
    _dialogue_requirement(isinstance(status, str) and status in allowed_blockers, "Status ist unbekannt.")
    _dialogue_requirement(
        isinstance(blocker, str) and blocker in allowed_blockers[status],
        "Status und Blocker widersprechen einander.",
    )
    _dialogue_requirement(
        projected["method"] == "whisper-small-guided-word-motion.v1",
        "Messmethode ist nicht gebunden.",
    )
    _dialogue_requirement(
        projected["modelName"] in (None, "OpenAI Whisper small"),
        "Modellname ist ungültig.",
    )
    for field in ("modelSha256", "expectedTranscriptSha256"):
        candidate = projected[field]
        _dialogue_requirement(
            candidate is None or (isinstance(candidate, str) and SHA256_PATTERN.fullmatch(candidate) is not None),
            f"{field} ist kein SHA-256-Wert.",
        )
    expected_transcript_sha256 = hashlib.sha256(expected_transcript.encode("utf-8")).hexdigest()
    _dialogue_requirement(
        projected["expectedTranscriptSha256"] == expected_transcript_sha256,
        "Zieltext-Hash ist nicht an den angeforderten Dialog gebunden.",
    )
    for field, minimum, maximum in (
        ("error", 1, 500),
        ("packageVersion", 1, 80),
        ("detectedLanguage", 1, 16),
        ("recognizedTranscript", 0, 4_000),
        ("alignmentError", 1, 500),
    ):
        _dialogue_requirement(
            _nullable_bounded_text(projected[field], minimum, maximum),
            f"{field} ist kein begrenzter Textwert.",
        )
    integer_limits = {
        "expectedWordCount": (0, 200),
        "recognizedWordCount": (0, 400),
        "substitutions": (0, 200),
        "deletions": (0, 200),
        "insertions": (0, 400),
        "guidedAlignedWordCount": (0, 200),
        "usableAlignedWordCount": (0, 200),
        "lowConfidenceAlignedWords": (0, 200),
    }
    for field, (minimum, maximum) in integer_limits.items():
        _dialogue_requirement(
            _plain_integer(projected[field], minimum, maximum),
            f"{field} ist keine begrenzte Ganzzahl.",
        )
    for field in ("guidedWordCoverage", "usableGuidedWordCoverage"):
        _dialogue_requirement(
            _finite_in_range(projected[field], 0, 1),
            f"{field} ist kein endlicher Verhältniswert.",
        )
    for field in ("medianGuidedWordProbability", "p10GuidedWordProbability"):
        candidate = projected[field]
        _dialogue_requirement(
            candidate is None or _finite_in_range(candidate, 0, 1),
            f"{field} ist kein endlicher Verhältniswert.",
        )
    word_error_rate = projected["wordErrorRate"]
    _dialogue_requirement(
        word_error_rate is None
        or (
            isinstance(word_error_rate, (int, float))
            and not isinstance(word_error_rate, bool)
            and math.isfinite(float(word_error_rate))
            and float(word_error_rate) >= 0
        ),
        "wordErrorRate ist ungültig.",
    )
    _dialogue_requirement(
        projected["alignmentStatus"] in {"measured", "insufficient", "failed", "not-applicable"},
        "Ausrichtungsstatus ist unbekannt.",
    )
    _dialogue_requirement(projected["timePrecisionMilliseconds"] == 20, "Zeitauflösung ist nicht gebunden.")
    guided_words = _project_guided_words(projected["guidedWords"])
    projected["guidedWords"] = guided_words
    raw_gate = _project_raw_asr_content_gate(projected["rawAsrContentGate"])
    projected["rawAsrContentGate"] = raw_gate
    projected["phonemeVerification"] = _project_phoneme_verification(projected["phonemeVerification"])

    expected_words = projected["expectedWordCount"]
    recognized_words = projected["recognizedWordCount"]
    substitutions = projected["substitutions"]
    deletions = projected["deletions"]
    insertions = projected["insertions"]
    guided_count = projected["guidedAlignedWordCount"]
    usable_count = projected["usableAlignedWordCount"]
    _dialogue_requirement(guided_count == len(guided_words), "Geführte Wortzahl ist inkonsistent.")
    _dialogue_requirement(
        usable_count == sum(word["usable"] is True for word in guided_words),
        "Nutzbare Wortzahl ist inkonsistent.",
    )
    _dialogue_requirement(
        projected["lowConfidenceAlignedWords"] <= guided_count,
        "Mehr unsichere als ausgerichtete Wörter sind nicht möglich.",
    )
    probabilities = [float(word["probability"]) for word in guided_words]
    sorted_probabilities = sorted(probabilities)
    if sorted_probabilities:
        middle = (len(sorted_probabilities) - 1) * 0.5
        lower_middle = math.floor(middle)
        upper_middle = math.ceil(middle)
        median_probability = (
            sorted_probabilities[lower_middle] * (upper_middle - middle)
            + sorted_probabilities[upper_middle] * (middle - lower_middle)
            if lower_middle != upper_middle
            else sorted_probabilities[lower_middle]
        )
        p10_position = (len(sorted_probabilities) - 1) * 0.1
        p10_lower = math.floor(p10_position)
        p10_upper = math.ceil(p10_position)
        p10_probability = (
            sorted_probabilities[p10_lower] * (p10_upper - p10_position)
            + sorted_probabilities[p10_upper] * (p10_position - p10_lower)
            if p10_lower != p10_upper
            else sorted_probabilities[p10_lower]
        )
        _dialogue_requirement(
            projected["medianGuidedWordProbability"] is not None
            and projected["p10GuidedWordProbability"] is not None,
            "Nichtleere Wortdaten benötigen beide Wahrscheinlichkeitsquantile.",
        )
        _dialogue_requirement(
            abs(float(projected["medianGuidedWordProbability"]) - median_probability) <= 1e-12
            and abs(float(projected["p10GuidedWordProbability"]) - p10_probability) <= 1e-12,
            "Wahrscheinlichkeitsquantile widersprechen den Wortdaten.",
        )
    else:
        _dialogue_requirement(
            projected["medianGuidedWordProbability"] is None
            and projected["p10GuidedWordProbability"] is None,
            "Leere Wortdaten dürfen keine Wahrscheinlichkeitsquantile tragen.",
        )
    _dialogue_requirement(
        projected["lowConfidenceAlignedWords"] == sum(probability < 0.25 for probability in probabilities),
        "Zahl unsicherer Wörter widerspricht den Wortwahrscheinlichkeiten.",
    )
    _dialogue_requirement(
        substitutions + deletions <= expected_words
        and substitutions + insertions <= recognized_words,
        "S/D/I widersprechen den Wortzahlen.",
    )
    insertion_facts = (
        len(raw_gate["prefixInsertions"])
        + len(raw_gate["internalInsertions"])
        + len(raw_gate["suffixInsertions"])
    )
    _dialogue_requirement(
        len(raw_gate["expectedNormalizedWords"]) == expected_words
        and len(raw_gate["recognizedNormalizedWords"]) == recognized_words
        and len(raw_gate["substitutedWords"]) == substitutions
        and len(raw_gate["deletedExpectedWords"]) == deletions
        and insertion_facts == insertions,
        "Raw-ASR-Content-Gate widerspricht den S/D/I-Wortzaehlern.",
    )
    if word_error_rate is not None and expected_words > 0:
        expected_rate = (substitutions + deletions + insertions) / expected_words
        _dialogue_requirement(
            abs(float(word_error_rate) - expected_rate) <= 1e-9,
            "Wortfehlerrate widerspricht S/D/I.",
        )
    expected_coverage = min(1.0, guided_count / expected_words) if expected_words > 0 else 0.0
    expected_usable_coverage = min(1.0, usable_count / expected_words) if expected_words > 0 else 0.0
    _dialogue_requirement(
        abs(float(projected["guidedWordCoverage"]) - expected_coverage) <= 1e-9
        and abs(float(projected["usableGuidedWordCoverage"]) - expected_usable_coverage) <= 1e-9,
        "Wortabdeckungen sind inkonsistent.",
    )
    alignment_status = projected["alignmentStatus"]
    alignment_error = projected["alignmentError"]
    _dialogue_requirement(
        not (alignment_status == "measured" and alignment_error is not None),
        "Gemessene Ausrichtung trägt einen Fehler.",
    )
    _dialogue_requirement(
        not (alignment_status == "insufficient" and alignment_error is None),
        "Unzureichende Ausrichtung hat keinen Fehler.",
    )
    if status == "measured":
        for field in (
            "modelName",
            "modelSha256",
            "packageVersion",
            "detectedLanguage",
            "expectedTranscriptSha256",
            "recognizedTranscript",
            "wordErrorRate",
            "medianGuidedWordProbability",
            "p10GuidedWordProbability",
        ):
            _dialogue_requirement(projected[field] is not None, f"Gemessener Wert {field} fehlt.")
        _dialogue_requirement(
            projected["error"] is None
            and expected_words >= 1
            and guided_count >= 1
            and alignment_status == "measured",
            "Gemessener Dialog ist nicht vollständig.",
        )
    else:
        _dialogue_requirement(projected["error"] is not None, "Nicht gemessener Dialog hat keinen Fehler.")
    return projected


def _write_bound_snapshot(path: Path, content: bytes, mode: int) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise AnalysisError(
                    "audio-snapshot-invalid",
                    "Der private Snapshot konnte nicht vollständig geschrieben werden.",
                )
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(content).digest():
        raise AnalysisError(
            "audio-snapshot-invalid",
            "Der private Snapshot stimmt nicht mit den verifizierten Bytes überein.",
        )


def _derive_spoken_content_gate(
    *,
    dialogue: dict[str, object],
    authority_audio_sha256: str,
    phase_document_sha256: str,
    independent_ipa_phase: dict[str, object],
    ipa_adjudication_result_sha256: str,
    ipa_adjudication_result: dict[str, object],
) -> dict[str, object]:
    blocker_codes = ["calibrated-holdout-not-qualified"]
    phase_status = independent_ipa_phase["status"]
    if phase_status == "insufficient":
        blocker_codes.append("independent-ipa-insufficient")
    elif phase_status == "failed":
        blocker_codes.append("independent-ipa-failed")
    if ipa_adjudication_result["status"] == "unavailable":
        blocker_codes.append("ipa-adjudication-unavailable")

    raw_gate = dialogue["rawAsrContentGate"]
    if not isinstance(raw_gate, dict):
        raise AnalysisError("internal-error", "Der gebundene Raw-ASR-Befund ist kein Objekt.")
    if raw_gate["status"] == "not-measured":
        blocker_codes.append("raw-asr-not-measured")
    if raw_gate["substitutedWords"]:
        blocker_codes.append("raw-asr-substitution-unqualified")
    if raw_gate["deletedExpectedWords"]:
        blocker_codes.append("raw-asr-deletion-present")
    if raw_gate["prefixInsertions"] or raw_gate["internalInsertions"] or raw_gate["suffixInsertions"]:
        blocker_codes.append("raw-asr-insertion-present")
    if raw_gate["repeatedInsertions"]:
        blocker_codes.append("raw-asr-repetition-present")

    return {
        "schemaVersion": SPOKEN_CONTENT_GATE_SCHEMA_VERSION,
        "evaluationMode": "measurement-only",
        "releaseDecision": "blocked",
        "blockerCodes": blocker_codes,
        "releaseQualification": {
            "status": "not-qualified",
            "requiredPositiveHoldoutCases": 300,
            "requiredNegativeHoldoutCases": 300,
            "maximumFalseAccepts": 0,
            "evidenceSha256": None,
        },
        "independentIpa": {
            "authorityAudioSha256": authority_audio_sha256,
            "phaseDocumentSha256": phase_document_sha256,
            "phase": independent_ipa_phase,
        },
        "ipaAdjudication": {
            "resultDocumentSha256": ipa_adjudication_result_sha256,
            "result": ipa_adjudication_result,
        },
    }


def _derive_phoneme_verification(
    result_document_sha256: str,
    ipa_adjudication_result: dict[str, object],
) -> dict[str, object]:
    return {
        "status": ipa_adjudication_result["status"],
        "method": PHONEME_MEASUREMENT_METHOD,
        "targetConditioned": True,
        "evaluationMode": "measurement-only",
        "releaseDecision": "blocked",
        "adjudicationResultSha256": result_document_sha256,
        "sourcePhaseStatus": ipa_adjudication_result["sourcePhaseStatus"],
        "measurement": ipa_adjudication_result["measurement"],
    }


def _technical_blockers(  # noqa: PLR0912
    pcm: dict[str, object],
    loudness: dict[str, object],
    dialogue: dict[str, object],
    *,
    ceiling_linear: float,
    duration_seconds: float,
) -> list[str]:
    blockers: list[str] = []
    if int(pcm["fullScaleClippedSamples"]) != 0:
        blockers.append("full-scale-clipping-detected")
    if float(pcm["samplePeakLinear"]) > ceiling_linear + PCM16_LSB_LINEAR:
        blockers.append("sample-peak-ceiling-exceeded")
    if not math.isfinite(float(loudness["truePeakDbtp"])) or float(loudness["truePeakDbtp"]) > 0:
        blockers.append("true-peak-above-zero-dbtp")
    if duration_seconds > 30:
        blockers.append("duration-exceeds-dialogue-window")
    if dialogue.get("status") != "measured":
        blockers.append("dialogue-not-measured")
    if (
        dialogue.get("modelName") != "OpenAI Whisper small"
        or dialogue.get("modelSha256") != PINNED_WHISPER_SMALL_SHA256
    ):
        blockers.append("dialogue-model-unverified")
    if dialogue.get("detectedLanguage") != "de":
        blockers.append("detected-language-not-de")
    raw_gate = dialogue.get("rawAsrContentGate")
    if not isinstance(raw_gate, dict) or raw_gate.get("status") != "passed" or raw_gate.get("exactTokenMatch") is not True:
        blockers.append("raw-asr-content-gate-not-passed")
    if dialogue.get("wordErrorRate") != 0:
        blockers.append("word-error-rate-not-zero")
    if any(dialogue[field] != 0 for field in ("substitutions", "deletions", "insertions")):
        blockers.append("word-edit-counts-not-zero")
    blockers.append("spoken-content-gate-not-passed")
    expected_words = dialogue["expectedWordCount"]
    if (
        expected_words < 1
        or dialogue["guidedAlignedWordCount"] != expected_words
        or dialogue["guidedWordCoverage"] != 1
    ):
        blockers.append("guided-word-coverage-incomplete")
    if (
        expected_words < 1
        or dialogue["usableAlignedWordCount"] != expected_words
        or dialogue["usableGuidedWordCoverage"] != 1
    ):
        blockers.append("usable-guided-word-coverage-incomplete")
    if dialogue["lowConfidenceAlignedWords"] != 0:
        blockers.append("low-confidence-aligned-words-present")
    if dialogue.get("alignmentStatus") != "measured":
        blockers.append("alignment-not-measured")
    return blockers


def analyze_audio(
    *,
    audio_path: Path,
    expected_audio_sha256: str,
    transcript: str,
    whisper_model_path: Path,
    ffmpeg_path: Path,
    independent_ipa_observation_path: Path,
    expected_independent_ipa_observation_sha256: str,
    ipa_adjudication_result_path: Path,
    expected_ipa_adjudication_result_sha256: str,
    expected_ipa_adjudicator_runner_sha256: str,
    expected_ipa_adjudication_policy_sha256: str,
    peak_ceiling_dbfs: float,
    dialogue_evaluator: DialogueEvaluator | None = None,
    loudness_runner: LoudnessRunner | None = None,
) -> dict[str, object]:
    enforce_offline_runtime()
    ceiling_dbfs = _finite_number(peak_ceiling_dbfs, "Peak-Grenze")
    if not -60 <= ceiling_dbfs <= 0:
        raise AnalysisError("arguments-invalid", "Peak-Grenze muss zwischen -60 und 0 dBFS liegen.")
    audio_content, audio_hash = _read_stable_regular_file(
        audio_path,
        expected_sha256=expected_audio_sha256,
        maximum_bytes=MAX_AUDIO_BYTES,
        failure_code="audio-snapshot-invalid",
        label="Audio",
    )
    wav, pcm = parse_pcm16_wav(audio_content)
    independent_ipa_phase, independent_ipa_phase_sha256 = _load_independent_ipa_phase(
        independent_ipa_observation_path,
        expected_sha256=expected_independent_ipa_observation_sha256,
        authority_audio_sha256=audio_hash,
    )
    target_text_sha256 = hashlib.sha256(transcript.encode("utf-8")).hexdigest()
    ipa_adjudication_result, ipa_adjudication_result_sha256 = (
        _load_ipa_adjudication_result(
            ipa_adjudication_result_path,
            expected_sha256=expected_ipa_adjudication_result_sha256,
            expected_runner_sha256=expected_ipa_adjudicator_runner_sha256,
            expected_policy_sha256=expected_ipa_adjudication_policy_sha256,
            expected_phase_sha256=independent_ipa_phase_sha256,
            expected_target_text_sha256=target_text_sha256,
            expected_source_phase_status=str(independent_ipa_phase["status"]),
        )
    )
    if not ffmpeg_path.is_absolute():
        raise AnalysisError("ffmpeg-unverified", "Der FFmpeg-Pfad muss absolut und hashgebunden sein.")
    _, ffmpeg_hash = _read_stable_regular_file(
        ffmpeg_path,
        expected_sha256=PINNED_FFMPEG_SHA256,
        maximum_bytes=MAX_EXECUTABLE_BYTES,
        failure_code="ffmpeg-unverified",
        label="FFmpeg",
    )
    if not os.access(ffmpeg_path, os.X_OK):
        raise AnalysisError("ffmpeg-unverified", "Die verifizierte FFmpeg-Datei ist nicht ausführbar.")
    whisper_content, _ = _read_stable_regular_file(
        whisper_model_path,
        expected_sha256=PINNED_WHISPER_SMALL_SHA256,
        maximum_bytes=MAX_WHISPER_BYTES,
        failure_code="whisper-unverified",
        label="Whisper",
    )

    evaluator = dialogue_evaluator or _default_dialogue_evaluator
    loudness_measurement = loudness_runner or measure_loudness
    with tempfile.TemporaryDirectory(prefix="ltx-t2a-audio-qa-") as temporary_directory:
        root = Path(temporary_directory)
        snapshot_path = root / "audio.wav"
        whisper_snapshot_path = root / "whisper-small.pt"
        _write_bound_snapshot(snapshot_path, audio_content, 0o400)
        _write_bound_snapshot(whisper_snapshot_path, whisper_content, 0o400)
        # FFmpeg is already a server-opened, digest-verified, read-only bind
        # mount. Copying it into TemporaryDirectory would lose that authority
        # binding and, on hardened hosts, place it on a noexec filesystem.
        integrated_lufs, true_peak_dbtp = loudness_measurement(snapshot_path, ffmpeg_path)
        if not math.isfinite(integrated_lufs) or not math.isfinite(true_peak_dbtp):
            raise AnalysisError("loudness-measurement-failed", "LUFS und True Peak fehlen oder sind nicht endlich.")
        with _offline_process_environment(ffmpeg_path.parent):
            raw_dialogue = evaluator(
                video_path=snapshot_path,
                expected_transcript=transcript,
                tracked_candidates=[],
                duration_seconds=float(wav["durationSeconds"]),
                has_audio=True,
                model_path=whisper_snapshot_path,
                expected_model_sha256=PINNED_WHISPER_SMALL_SHA256,
                audio_start_relative_video_seconds=None,
                word_motion_enabled=False,
                raw_asr_content_gate_enabled=True,
            )
            dialogue = project_audio_dialogue_evaluation(raw_dialogue, transcript)
            dialogue["phonemeVerification"] = _derive_phoneme_verification(
                ipa_adjudication_result_sha256,
                ipa_adjudication_result,
            )

    loudness = {
        "method": LOUDNESS_METHOD,
        "ffmpegSha256": ffmpeg_hash,
        "integratedLufs": integrated_lufs,
        "truePeakDbtp": true_peak_dbtp,
    }
    ceiling_linear = 10.0 ** (ceiling_dbfs / 20.0)
    spoken_content_gate = _derive_spoken_content_gate(
        dialogue=dialogue,
        authority_audio_sha256=audio_hash,
        phase_document_sha256=independent_ipa_phase_sha256,
        independent_ipa_phase=independent_ipa_phase,
        ipa_adjudication_result_sha256=ipa_adjudication_result_sha256,
        ipa_adjudication_result=ipa_adjudication_result,
    )
    blockers = _technical_blockers(
        pcm,
        loudness,
        dialogue,
        ceiling_linear=ceiling_linear,
        duration_seconds=float(wav["durationSeconds"]),
    )
    eligibility = {
        "schemaVersion": ELIGIBILITY_SCHEMA_VERSION,
        "status": "blocked" if blockers else "eligible",
        "blockers": blockers,
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "mediaKind": "audio",
        "analysisKind": "t2a-audio-qa",
        "analysisStatus": "measured",
        "sourceSnapshot": {
            "sha256": audio_hash,
            "byteLength": len(audio_content),
        },
        "wav": wav,
        "pcm": pcm,
        "loudness": loudness,
        "dialogueEvaluation": dialogue,
        "spokenContentGate": spoken_content_gate,
        "policy": {
            "peakCeilingDbfs": ceiling_dbfs,
            "peakCeilingLinear": ceiling_linear,
            "pcm16LsbToleranceLinear": PCM16_LSB_LINEAR,
        },
        "ia2vEligibility": eligibility,
    }


def failure_document(error: AnalysisError) -> dict[str, object]:
    allowed_codes = {
        "arguments-invalid",
        "audio-snapshot-invalid",
        "audio-hash-mismatch",
        "wav-container-invalid",
        "wav-format-unsupported",
        "wav-data-invalid",
        "audio-silent",
        "ffmpeg-unverified",
        "whisper-unverified",
        "loudness-measurement-failed",
        "offline-runtime-unverified",
        "internal-error",
    }
    code = error.code if error.code in allowed_codes else "internal-error"
    message = _truncate_utf16(str(error).strip(), 500) or "Die T2A-Audioanalyse ist fehlgeschlagen."
    return {
        "schemaVersion": SCHEMA_VERSION,
        "mediaKind": "audio",
        "analysisKind": "t2a-audio-qa",
        "analysisStatus": "failed",
        "error": {"code": code, "message": message},
        "ia2vEligibility": {
            "schemaVersion": ELIGIBILITY_SCHEMA_VERSION,
            "status": "blocked",
            "blockers": ["analysis-failed"],
        },
    }


def independent_ipa_failure_document(
    error: AnalysisError,
    *,
    authority_audio_sha256: str | None = None,
) -> dict[str, object]:
    allowed_codes = {
        "arguments-invalid",
        "audio-snapshot-invalid",
        "audio-hash-mismatch",
        "wav-container-invalid",
        "wav-format-unsupported",
        "wav-data-invalid",
        "audio-silent",
        "ffmpeg-unverified",
        "offline-runtime-unverified",
        "independent-ipa-unverified",
        "independent-ipa-normalization-failed",
        "independent-ipa-failed",
        "independent-ipa-invalid",
        "internal-error",
    }
    code = error.code if error.code in allowed_codes else "internal-error"
    message = _truncate_utf16(str(error).strip(), 500) or "Die unabhängige IPA-Analyse ist fehlgeschlagen."
    context = error.independent_ipa_context or {}
    context_authority = context.get("authorityAudioSha256")
    if isinstance(context_authority, str) and SHA256_PATTERN.fullmatch(context_authority):
        authority_audio_sha256 = context_authority
    source_audio_sha256 = context.get("sourceAudioSha256")
    if source_audio_sha256 is not None and source_audio_sha256 != authority_audio_sha256:
        code = "internal-error"
        message = "Die unabhängige IPA-Fehlerphase konnte nicht an den autorisierten Audiohash gebunden werden."
        source_audio_sha256 = None
    normalization = context.get("normalization")
    return {
        "schemaVersion": INDEPENDENT_IPA_PHASE_SCHEMA,
        "status": "failed",
        "reasonCode": code,
        "authorityAudioSha256": authority_audio_sha256,
        "sourceAudioSha256": source_audio_sha256,
        "normalization": normalization,
        "observation": None,
        "error": {"code": code, "message": message},
    }


def _raw_expected_audio_authority(arguments: Sequence[str]) -> str | None:
    values: list[str] = []
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--expected-audio-sha256":
            if index + 1 < len(arguments):
                values.append(arguments[index + 1])
                index += 1
        elif argument.startswith("--expected-audio-sha256="):
            values.append(argument.partition("=")[2])
        index += 1
    if len(values) != 1:
        return None
    normalized = values[0].strip().lower()
    return normalized if SHA256_PATTERN.fullmatch(normalized) else None


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("quality", "independent-ipa-observation"),
        default="quality",
    )
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--expected-audio-sha256", required=True)
    parser.add_argument("--transcript")
    parser.add_argument("--whisper-model", type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--peak-ceiling-dbfs")
    parser.add_argument("--independent-ipa-observation", type=Path)
    parser.add_argument("--expected-independent-ipa-observation-sha256")
    parser.add_argument("--ipa-adjudication-result", type=Path)
    parser.add_argument("--expected-ipa-adjudication-result-sha256")
    parser.add_argument("--expected-ipa-adjudicator-runner-sha256")
    parser.add_argument("--expected-ipa-adjudication-policy-sha256")
    parser.add_argument("--independent-ipa-runner", type=Path)
    parser.add_argument("--expected-independent-ipa-runner-sha256")
    parser.add_argument("--independent-ipa-model", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    exit_code = 0
    raw_arguments = list(argv) if argv is not None else sys.argv[1:]
    independent_mode = (
        "--mode" in raw_arguments and "independent-ipa-observation" in raw_arguments
    ) or "--mode=independent-ipa-observation" in raw_arguments
    authority_audio_sha256 = _raw_expected_audio_authority(raw_arguments)
    try:
        with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
            enforce_offline_runtime()
            arguments = build_parser().parse_args(argv)
            independent_mode = arguments.mode == "independent-ipa-observation"
            if independent_mode:
                authority_audio_sha256 = _validate_sha256(
                    arguments.expected_audio_sha256,
                    "Erwarteter Audio-Hash",
                )
                if (
                    arguments.independent_ipa_runner is None
                    or arguments.expected_independent_ipa_runner_sha256 is None
                    or arguments.independent_ipa_model is None
                    or arguments.transcript is not None
                    or arguments.whisper_model is not None
                    or arguments.peak_ceiling_dbfs is not None
                    or arguments.independent_ipa_observation is not None
                    or arguments.expected_independent_ipa_observation_sha256 is not None
                    or arguments.ipa_adjudication_result is not None
                    or arguments.expected_ipa_adjudication_result_sha256 is not None
                    or arguments.expected_ipa_adjudicator_runner_sha256 is not None
                    or arguments.expected_ipa_adjudication_policy_sha256 is not None
                ):
                    raise AnalysisError(
                        "arguments-invalid",
                        "Der unabhängige IPA-Modus akzeptiert nur Audio, FFmpeg, Runner und Modell.",
                    )
                document = analyze_independent_ipa_observation(
                    audio_path=arguments.audio,
                    expected_audio_sha256=arguments.expected_audio_sha256,
                    ffmpeg_path=arguments.ffmpeg,
                    independent_ipa_runner_path=arguments.independent_ipa_runner,
                    expected_independent_ipa_runner_sha256=(
                        arguments.expected_independent_ipa_runner_sha256
                    ),
                    independent_ipa_model_path=arguments.independent_ipa_model,
                )
                if document.get("status") == "failed":
                    exit_code = 2
            else:
                if (
                    arguments.transcript is None
                    or arguments.whisper_model is None
                    or arguments.peak_ceiling_dbfs is None
                    or arguments.independent_ipa_observation is None
                    or arguments.expected_independent_ipa_observation_sha256 is None
                    or arguments.ipa_adjudication_result is None
                    or arguments.expected_ipa_adjudication_result_sha256 is None
                    or arguments.expected_ipa_adjudicator_runner_sha256 is None
                    or arguments.expected_ipa_adjudication_policy_sha256 is None
                    or arguments.independent_ipa_runner is not None
                    or arguments.expected_independent_ipa_runner_sha256 is not None
                    or arguments.independent_ipa_model is not None
                ):
                    raise AnalysisError("arguments-invalid", "Der T2A-Qualitätsmodus ist unvollständig.")
                document = analyze_audio(
                    audio_path=arguments.audio,
                    expected_audio_sha256=arguments.expected_audio_sha256,
                    transcript=arguments.transcript,
                    whisper_model_path=arguments.whisper_model,
                    ffmpeg_path=arguments.ffmpeg,
                    independent_ipa_observation_path=arguments.independent_ipa_observation,
                    expected_independent_ipa_observation_sha256=(
                        arguments.expected_independent_ipa_observation_sha256
                    ),
                    ipa_adjudication_result_path=arguments.ipa_adjudication_result,
                    expected_ipa_adjudication_result_sha256=(
                        arguments.expected_ipa_adjudication_result_sha256
                    ),
                    expected_ipa_adjudicator_runner_sha256=(
                        arguments.expected_ipa_adjudicator_runner_sha256
                    ),
                    expected_ipa_adjudication_policy_sha256=(
                        arguments.expected_ipa_adjudication_policy_sha256
                    ),
                    peak_ceiling_dbfs=arguments.peak_ceiling_dbfs,
                )
    except AnalysisError as error:
        document = (
            independent_ipa_failure_document(
                error,
                authority_audio_sha256=authority_audio_sha256,
            )
            if independent_mode
            else failure_document(error)
        )
        exit_code = 2
    except Exception as error:
        internal = AnalysisError("internal-error", f"{type(error).__name__}: {error}")
        document = (
            independent_ipa_failure_document(
                internal,
                authority_audio_sha256=authority_audio_sha256,
            )
            if independent_mode
            else failure_document(internal)
        )
        exit_code = 2
    try:
        payload = json.dumps(document, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        exit_code = 2
        internal = AnalysisError("internal-error", f"Ungültiges Analyse-JSON: {error}")
        payload = json.dumps(
            independent_ipa_failure_document(
                internal,
                authority_audio_sha256=authority_audio_sha256,
            )
            if independent_mode
            else failure_document(internal),
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
        )
    sys.stdout.write(payload + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
