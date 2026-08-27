#!/usr/bin/env python3
"""Strict, development-only selection of LipForcing's upstream video mux."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess


BASELINE_PROFILE = "h264-crf13-mux-crf18-v1"
MUX_COPY_PROFILE = "h264-crf13-mux-copy-v1"
RAW_OUTPUT_PROFILES = (BASELINE_PROFILE, MUX_COPY_PROFILE)
PAIRED_RECEIPT_SCHEMA = "ltx-studio-lipforcing-raw-mux-pair-receipt.v1"
PREMUX_EXPORT_RECEIPT_SCHEMA = "ltx-studio-lipforcing-premux-export-receipt.v1"
PAIRED_ROOT = Path("/paired")
PAIRED_ENVIRONMENT = {
    "pre_mux": "LTX_LIPFORCING_PAIRED_PREMUX_OUTPUT",
    "pre_mux_receipt": "LTX_LIPFORCING_PAIRED_PREMUX_RECEIPT_OUTPUT",
}
PAIRED_NAMES = {
    "pre_mux": "pre-mux-crf13.mp4",
    "pre_mux_receipt": "pre-mux-receipt.json",
}
CONTAINER_RUNNER = Path("/opt/ltx-studio/lipforcing-runner.py")


def video_codec_arguments(raw_output_profile: str) -> list[str]:
    if raw_output_profile == BASELINE_PROFILE:
        return ["-c:v", "libx264", "-crf", "18"]
    if raw_output_profile == MUX_COPY_PROFILE:
        return ["-c:v", "copy"]
    raise RuntimeError(f"Unsupported LipForcing raw-output profile: {raw_output_profile!r}")


def build_mux_command(
    ffmpeg: str,
    video_path: str | Path,
    audio_path: str | Path,
    output_path: str | Path,
    raw_output_profile: str,
    duration_s: float | None = None,
    *,
    overwrite: bool = True,
) -> list[str]:
    command = [
        ffmpeg, "-y" if overwrite else "-n", "-loglevel", "error", "-nostdin",
        "-i", str(video_path), "-i", str(audio_path),
        "-map", "0:v:0", "-map", "1:a:0",
        *video_codec_arguments(raw_output_profile),
        "-c:a", "aac", "-q:v", "0", "-q:a", "0",
    ]
    if duration_s is not None:
        command.extend(["-t", f"{duration_s:.4f}"])
    command.append(str(output_path))
    return command


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_fd(descriptor: int) -> str:
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, 8 * 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest()


def _sha256_command(command: list[str]) -> str:
    encoded = json.dumps(
        command,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf8")
    return hashlib.sha256(encoded).hexdigest()


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _require_regular_single_link(path: Path, label: str) -> os.stat_result:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise RuntimeError(f"{label} is missing: {path}") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_size <= 0
    ):
        raise RuntimeError(
            f"{label} must be a non-empty regular single-link file: {path}"
        )
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise RuntimeError(f"{label} changed while it was opened: {path}")
    finally:
        os.close(descriptor)
    return metadata


def _revision(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _receipt_revision(metadata: os.stat_result) -> dict[str, int | str]:
    return {
        "deviceId": str(metadata.st_dev),
        "fileId": str(metadata.st_ino),
        "mode": metadata.st_mode,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "nlink": metadata.st_nlink,
        "modifiedAtNs": str(metadata.st_mtime_ns),
        "changedAtNs": str(metadata.st_ctime_ns),
    }


def _open_verified_input(path: Path, label: str) -> tuple[int, os.stat_result, str]:
    before = _require_regular_single_link(path, label)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if _revision(opened) != _revision(before):
            raise RuntimeError(f"{label} changed while it was opened: {path}")
        digest = _sha256_fd(descriptor)
        after_hash = os.fstat(descriptor)
        if _revision(after_hash) != _revision(opened):
            raise RuntimeError(f"{label} changed while it was hashed: {path}")
        return descriptor, opened, digest
    except Exception:
        os.close(descriptor)
        raise


def _verify_held_input(
    descriptor: int,
    initial: os.stat_result,
    expected_sha256: str,
    label: str,
) -> None:
    before_hash = os.fstat(descriptor)
    if _revision(before_hash) != _revision(initial):
        raise RuntimeError(f"{label} revision changed during paired mux.")
    if _sha256_fd(descriptor) != expected_sha256:
        raise RuntimeError(f"{label} bytes changed during paired mux.")
    after_hash = os.fstat(descriptor)
    if _revision(after_hash) != _revision(initial):
        raise RuntimeError(f"{label} revision changed while it was rehashed.")


def _require_absent(path: Path, label: str) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise RuntimeError(f"Refusing to overwrite existing {label}: {path}")


def _copy_exclusive_fd(source_descriptor: int, destination: Path) -> None:
    _require_absent(destination, "LipForcing paired pre-mux export")
    destination_descriptor: int | None = None
    try:
        opened_source = os.fstat(source_descriptor)
        if not stat.S_ISREG(opened_source.st_mode) or opened_source.st_nlink != 1:
            raise RuntimeError("LipForcing CRF13 pre-mux source changed during export.")
        os.lseek(source_descriptor, 0, os.SEEK_SET)
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        while True:
            chunk = os.read(source_descriptor, 8 * 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(destination_descriptor, view)
                view = view[written:]
        os.fchmod(destination_descriptor, 0o400)
        os.fsync(destination_descriptor)
    finally:
        os.lseek(source_descriptor, 0, os.SEEK_SET)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
    _fsync_directory(destination.parent)
    _require_regular_single_link(destination, "LipForcing paired pre-mux export")


def _seal_generated_file(path: Path, label: str) -> tuple[os.stat_result, str]:
    before = _require_regular_single_link(path, label)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if _revision(opened) != _revision(before):
            raise RuntimeError(f"{label} changed while it was opened: {path}")
        os.fchmod(descriptor, 0o400)
        os.fsync(descriptor)
        sealed = os.fstat(descriptor)
        digest = _sha256_fd(descriptor)
        if _revision(os.fstat(descriptor)) != _revision(sealed):
            raise RuntimeError(f"{label} changed while it was hashed: {path}")
    finally:
        os.close(descriptor)
    _fsync_directory(path.parent)
    final = _require_regular_single_link(path, label)
    if _revision(final) != _revision(sealed):
        raise RuntimeError(f"{label} changed after it was sealed: {path}")
    return final, digest


def _write_receipt_exclusive(path: Path, payload: dict[str, object]) -> None:
    _require_absent(path, "LipForcing paired receipt")
    encoded = (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf8")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400,
    )
    try:
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    _fsync_directory(path.parent)
    _require_regular_single_link(path, "LipForcing paired receipt")


def _paired_paths_from_environment(
    output_path: str | Path,
) -> tuple[Path, Path] | None:
    raw_values = {
        name: os.environ.get(environment)
        for name, environment in PAIRED_ENVIRONMENT.items()
    }
    configured = {name for name, value in raw_values.items() if value is not None}
    if not configured:
        return None
    if configured != set(PAIRED_ENVIRONMENT) or any(not raw_values[name] for name in configured):
        raise RuntimeError("LipForcing paired mux environment must be complete and non-empty.")

    paired = {name: Path(str(value)) for name, value in raw_values.items()}
    expected = {
        "pre_mux": PAIRED_ROOT / PAIRED_NAMES["pre_mux"],
        "pre_mux_receipt": PAIRED_ROOT / PAIRED_NAMES["pre_mux_receipt"],
    }
    if paired != expected or Path(output_path) != expected["pre_mux"]:
        raise RuntimeError("LipForcing paired mux paths do not match the sealed /paired layout.")
    directory = PAIRED_ROOT.lstat()
    if (
        not stat.S_ISDIR(directory.st_mode)
        or stat.S_IMODE(directory.st_mode) != 0o700
        or directory.st_uid != os.geteuid()
    ):
        raise RuntimeError("LipForcing paired mux directory is not private and owned.")
    return paired["pre_mux"], paired["pre_mux_receipt"]


def _resolve_paired_ffmpeg(ffmpeg: str) -> Path:
    located = shutil.which(ffmpeg) if not Path(ffmpeg).is_absolute() else ffmpeg
    if located is None:
        raise RuntimeError("LipForcing paired mux cannot resolve ffmpeg.")
    resolved = Path(located).resolve(strict=True)
    if resolved != Path("/usr/bin/ffmpeg"):
        raise RuntimeError(f"LipForcing paired mux requires /usr/bin/ffmpeg, got {resolved}.")
    metadata = _require_regular_single_link(resolved, "paired mux ffmpeg executable")
    if (
        metadata.st_uid != 0
        or metadata.st_mode & 0o111 == 0
        or metadata.st_mode & 0o022 != 0
    ):
        raise RuntimeError("Paired mux ffmpeg must be root-owned, executable, and not writable by group/world.")
    return resolved


def _ffmpeg_version(ffmpeg: Path, ffmpeg_descriptor: int) -> str:
    result = subprocess.run(
        [str(ffmpeg), "-version"],
        check=True,
        capture_output=True,
        executable=f"/proc/self/fd/{ffmpeg_descriptor}",
        pass_fds=(ffmpeg_descriptor,),
        text=True,
    )
    first_line = result.stdout.splitlines()[0] if result.stdout else ""
    if not first_line.startswith("ffmpeg version "):
        raise RuntimeError("LipForcing paired mux received an invalid ffmpeg version response.")
    return first_line


def _run_mux(
    command: list[str],
    label: str,
    ffmpeg_descriptor: int,
    input_descriptors: tuple[int, int],
) -> None:
    result = subprocess.run(
        command,
        capture_output=True,
        executable=f"/proc/self/fd/{ffmpeg_descriptor}",
        pass_fds=(ffmpeg_descriptor, *input_descriptors),
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{label} failed: {result.stderr}")


def _run_legacy_mux(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg mux failed: {result.stderr}")


def _paired_export_pre_mux(
    ffmpeg: str,
    video_path: str | Path,
    audio_path: str | Path,
    output_path: str | Path,
    raw_output_profile: str,
    duration_s: float | None,
    paired_paths: tuple[Path, Path],
) -> None:
    if raw_output_profile != BASELINE_PROFILE:
        raise RuntimeError("LipForcing paired pre-mux export is restricted to the baseline profile.")
    if duration_s is not None and (not math.isfinite(duration_s) or duration_s <= 0):
        raise RuntimeError("LipForcing paired pre-mux duration must be finite and positive.")

    video = Path(video_path)
    pre_mux, receipt = paired_paths
    if Path(output_path) != pre_mux:
        raise RuntimeError("LipForcing paired output is not the registered silent pre-mux path.")
    for path, label in (
        (pre_mux, "pre-mux export"),
        (receipt, "pre-mux receipt"),
    ):
        _require_absent(path, label)
    video_descriptor, source_metadata, source_sha256 = _open_verified_input(
        video,
        "LipForcing CRF13 pre-mux source",
    )
    pre_mux_descriptor: int | None = None
    try:
        _copy_exclusive_fd(video_descriptor, pre_mux)
        pre_mux_metadata, pre_mux_sha256 = _seal_generated_file(
            pre_mux,
            "LipForcing paired pre-mux export",
        )
        if (
            pre_mux_sha256 != source_sha256
            or pre_mux_metadata.st_size != source_metadata.st_size
        ):
            raise RuntimeError("LipForcing paired pre-mux export is not byte-identical.")
        _verify_held_input(
            video_descriptor,
            source_metadata,
            source_sha256,
            "LipForcing CRF13 pre-mux source",
        )
        pre_mux_descriptor, held_pre_mux_metadata, held_pre_mux_sha256 = _open_verified_input(
            pre_mux,
            "LipForcing paired pre-mux export",
        )
        if held_pre_mux_sha256 != pre_mux_sha256:
            raise RuntimeError("LipForcing pre-mux export changed before receipt sealing.")
        _verify_held_input(
            video_descriptor,
            source_metadata,
            source_sha256,
            "LipForcing CRF13 pre-mux source",
        )
        source_fd_path = f"/proc/self/fd/{video_descriptor}"
        copy_command = [
            "ltx-studio-internal-held-fd-copy-v1",
            "--source", source_fd_path,
            "--output", str(pre_mux),
            "--exclusive",
        ]
        receipt_payload: dict[str, object] = {
            "schemaVersion": PREMUX_EXPORT_RECEIPT_SCHEMA,
            "durationArg": None if duration_s is None else f"{duration_s:.4f}",
            "source": {
                "sha256": source_sha256,
                "sizeBytes": source_metadata.st_size,
                "revision": _receipt_revision(source_metadata),
            },
            "export": {
                "sha256": pre_mux_sha256,
                "sizeBytes": pre_mux_metadata.st_size,
                "revision": _receipt_revision(pre_mux_metadata),
            },
            "byteIdentical": True,
            "copy": {
                "method": "python-os-read-write-held-fd-exclusive-v1",
                "command": {
                    "argv": copy_command,
                    "sha256": _sha256_command(copy_command),
                },
            },
            "code": {
                "rawOutputMuxSha256": _sha256_file(Path(__file__).resolve()),
                "containerRunnerSha256": _sha256_file(CONTAINER_RUNNER),
            },
        }
        _write_receipt_exclusive(receipt, receipt_payload)
        _verify_held_input(
            pre_mux_descriptor,
            held_pre_mux_metadata,
            held_pre_mux_sha256,
            "LipForcing paired pre-mux export",
        )
    finally:
        os.close(video_descriptor)
        if pre_mux_descriptor is not None:
            os.close(pre_mux_descriptor)


def mux_video_with_audio(
    ffmpeg: str,
    video_path: str | Path,
    audio_path: str | Path,
    output_path: str | Path,
    raw_output_profile: str,
    duration_s: float | None = None,
) -> None:
    paired_paths = _paired_paths_from_environment(output_path)
    if paired_paths is not None:
        _paired_export_pre_mux(
            ffmpeg,
            video_path,
            audio_path,
            output_path,
            raw_output_profile,
            duration_s,
            paired_paths,
        )
        return

    command = build_mux_command(
        ffmpeg,
        video_path,
        audio_path,
        output_path,
        raw_output_profile,
        duration_s,
    )
    _run_legacy_mux(command)
