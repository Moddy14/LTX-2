#!/usr/bin/env python3
"""Run pinned LipForcing 14B inside an existing LTX DGX queue allocation."""

from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid


LIPFORCING_COMMIT = "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184"
LIPFORCING_PATCHSET_ID = "ltx-studio-lipforcing-runtime.v4"
DOCKER_EXECUTABLE = "/usr/bin/docker"
DOCKER_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LC_ALL": "C",
}
RAW_OUTPUT_PROFILES = (
    "h264-crf13-mux-crf18-v1",
    "h264-crf13-mux-copy-v1",
)
DEFAULT_RAW_OUTPUT_PROFILE = RAW_OUTPUT_PROFILES[0]
PAIRED_CANDIDATE_PROFILE = RAW_OUTPUT_PROFILES[1]
PREMUX_EXPORT_RECEIPT_SCHEMA = "ltx-studio-lipforcing-premux-export-receipt.v1"
PAIRED_RECEIPT_SCHEMA = "ltx-studio-lipforcing-raw-mux-pair-receipt.v1"
TIMELINE_RECEIPT_SCHEMA = "ltx-studio-lipforcing-paired-timeline-receipt.v1"
PAIR_DIRECTORY_NAME = "raw-mux-pair"
CONTAINER_PREMUX_OUTPUT = "/paired/pre-mux-crf13.mp4"
PAIR_ARTIFACT_NAMES = {
    "pre_mux": "pre-mux-crf13.mp4",
    "pre_mux_receipt": "pre-mux-receipt.json",
    "baseline_raw": "baseline-raw.mp4",
    "candidate_raw": "candidate-raw.mp4",
    "candidate_final": "candidate-final.mp4",
    "raw_receipt": "pair-receipt.json",
    "timeline_receipt": "timeline-receipt.json",
}
FFMPEG_EXECUTABLE = Path("/usr/bin/ffmpeg")
FFPROBE_EXECUTABLE = Path("/usr/bin/ffprobe")
MODEL_SHA256 = "ea9f111f374a208a80b6604e2c698639f03ad666bb7cda72c727a93cd43e4307"
VAE_SHA256 = "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981"
WAV2VEC_MODEL_SHA256 = "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a"
WAV2VEC_CONFIG_SHA256 = "d3ec255c063d9f95057b553b19c20135b259875834a4fe9deb218a6be25b4cf3"
WAV2VEC_PREPROCESSOR_SHA256 = "b225d617c025463b9e157e06afea8b90dc7078fc70b013c533328423e0486b4a"
WAV2VEC_FEATURE_EXTRACTOR_SHA256 = "d3de0c797bf9b65f90bc65c30cb7b303ebeda341f6fc80af33628c4b26b95632"
TAEHV_SHA256 = "d26151e76cdc2c9424bef988de874b33d9a53f30ef3060cd556c429c469c797e"
MASK_SHA256 = "aa233251b9ff5691a1565a4108f0910ab1e5e7ad79a7bb2b741ab4d92c81053c"
INSIGHTFACE_DETECTOR_SHA256 = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"
INSIGHTFACE_LANDMARK_SHA256 = "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf"
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
REPO_DIGEST_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*@sha256:[0-9a-f]{64}$")


def log(message: str) -> None:
    print(f"LipForcing: {message}", flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_command(command: list[str]) -> str:
    return hashlib.sha256(
        json.dumps(
            command,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf8")
    ).hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def file_revision(metadata: os.stat_result) -> tuple[int, ...]:
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


def sha256_descriptor(descriptor: int) -> str:
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, 8 * 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest()


def open_held_file(
    path: Path,
    label: str,
    *,
    require_private: bool = False,
) -> tuple[int, os.stat_result, dict[str, int | str]]:
    before = path.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or before.st_size <= 0
        or (require_private and stat.S_IMODE(before.st_mode) != 0o400)
        or (require_private and before.st_uid != os.geteuid())
    ):
        raise RuntimeError(f"{label} ist kein gültiges Einzeldatei-Artefakt: {path}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if file_revision(opened) != file_revision(before):
            raise RuntimeError(f"{label} wurde beim Öffnen ausgetauscht: {path}")
        digest = sha256_descriptor(descriptor)
        if file_revision(os.fstat(descriptor)) != file_revision(opened):
            raise RuntimeError(f"{label} änderte sich während der Hash-Bildung: {path}")
        return descriptor, opened, {"sha256": digest, "sizeBytes": opened.st_size}
    except Exception:
        os.close(descriptor)
        raise


def verify_held_file(
    descriptor: int,
    initial: os.stat_result,
    evidence: dict[str, int | str],
    label: str,
) -> None:
    if file_revision(os.fstat(descriptor)) != file_revision(initial):
        raise RuntimeError(f"{label} änderte seine Revision während A/B.")
    if sha256_descriptor(descriptor) != evidence["sha256"]:
        raise RuntimeError(f"{label} änderte seine Bytes während A/B.")
    if file_revision(os.fstat(descriptor)) != file_revision(initial):
        raise RuntimeError(f"{label} änderte sich während der Abschlussprüfung.")


def open_held_executable(
    path: Path,
) -> tuple[int, os.stat_result, dict[str, str]]:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_nlink != 1
        or metadata.st_mode & 0o111 == 0
        or metadata.st_mode & 0o022 != 0
    ):
        raise RuntimeError(f"Ausführbare TCB-Datei ist nicht root-owned und geschützt: {path}")
    descriptor, revision, evidence = open_held_file(path, f"TCB-Datei {path}")
    result = subprocess.run(
        [str(path), "-version"],
        check=True,
        capture_output=True,
        env=DOCKER_ENV,
        executable=f"/proc/self/fd/{descriptor}",
        pass_fds=(descriptor,),
        text=True,
    )
    version = result.stdout.splitlines()[0] if result.stdout else ""
    if not version.startswith(path.name + " version "):
        os.close(descriptor)
        raise RuntimeError(f"Unerwartete Versionsausgabe von {path}.")
    return descriptor, revision, {
        "path": str(path),
        "sha256": str(evidence["sha256"]),
        "version": version,
    }


def verify_held_executable(
    path: Path,
    descriptor: int,
    revision: os.stat_result,
    expected: dict[str, str],
) -> dict[str, str]:
    verify_held_file(
        descriptor,
        revision,
        {"sha256": expected["sha256"], "sizeBytes": revision.st_size},
        f"TCB-Datei {path}",
    )
    result = subprocess.run(
        [str(path), "-version"],
        check=True,
        capture_output=True,
        env=DOCKER_ENV,
        executable=f"/proc/self/fd/{descriptor}",
        pass_fds=(descriptor,),
        text=True,
    )
    actual = {
        "path": str(path),
        "sha256": expected["sha256"],
        "version": result.stdout.splitlines()[0] if result.stdout else "",
    }
    if actual != expected:
        raise RuntimeError(f"TCB-Autorität änderte sich während A/B: {path}")
    return actual


def secure_file_evidence(
    path: Path,
    label: str,
    *,
    require_private: bool = False,
) -> dict[str, int | str]:
    try:
        before = path.lstat()
    except FileNotFoundError as error:
        raise RuntimeError(f"{label} fehlt: {path}") from error
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or before.st_size <= 0
        or (require_private and stat.S_IMODE(before.st_mode) != 0o400)
        or (require_private and before.st_uid != os.geteuid())
    ):
        raise RuntimeError(f"{label} ist kein versiegeltes Einzeldatei-Artefakt: {path}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if file_revision(opened) != file_revision(before):
            raise RuntimeError(f"{label} wurde beim Öffnen ausgetauscht: {path}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 8 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        if file_revision(after) != file_revision(opened):
            raise RuntimeError(f"{label} änderte sich während der Hash-Bildung: {path}")
    finally:
        os.close(descriptor)
    return {"sha256": digest.hexdigest(), "sizeBytes": before.st_size}


def require_absent(path: Path, label: str) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise RuntimeError(f"Vorhandenes {label} wird nicht überschrieben: {path}")


def create_private_pair_directory(argument: str, stage_root: Path) -> Path:
    pair_directory = Path(os.path.abspath(argument))
    expected = stage_root / PAIR_DIRECTORY_NAME
    if pair_directory != expected:
        raise RuntimeError(
            "LipForcing-Paarartefakte müssen exakt unter <stage-root>/raw-mux-pair liegen."
        )
    require_absent(pair_directory, "LipForcing-Paarverzeichnis")
    os.mkdir(pair_directory, 0o700)
    os.chmod(pair_directory, 0o700)
    metadata = pair_directory.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or metadata.st_uid != os.geteuid()
    ):
        raise RuntimeError("LipForcing-Paarverzeichnis ist nicht privat und im eigenen Besitz.")
    fsync_directory(stage_root)
    return pair_directory


def open_held_private_directory(path: Path) -> tuple[int, tuple[int, ...]]:
    before = path.lstat()
    if (
        not stat.S_ISDIR(before.st_mode)
        or stat.S_IMODE(before.st_mode) != 0o700
        or before.st_uid != os.geteuid()
    ):
        raise RuntimeError("LipForcing-Paarverzeichnis ist nicht owner-privat.")
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = os.fstat(descriptor)
    stable = (
        opened.st_dev,
        opened.st_ino,
        opened.st_mode,
        opened.st_uid,
        opened.st_gid,
        opened.st_nlink,
    )
    before_stable = (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_uid,
        before.st_gid,
        before.st_nlink,
    )
    if stable != before_stable:
        os.close(descriptor)
        raise RuntimeError("LipForcing-Paarverzeichnis wurde beim Öffnen ausgetauscht.")
    return descriptor, stable


def verify_held_private_directory(
    path: Path,
    descriptor: int,
    expected_stable_revision: tuple[int, ...],
) -> None:
    opened = os.fstat(descriptor)
    current = path.lstat()
    opened_stable = (
        opened.st_dev,
        opened.st_ino,
        opened.st_mode,
        opened.st_uid,
        opened.st_gid,
        opened.st_nlink,
    )
    current_stable = (
        current.st_dev,
        current.st_ino,
        current.st_mode,
        current.st_uid,
        current.st_gid,
        current.st_nlink,
    )
    if (
        opened_stable != expected_stable_revision
        or current_stable != expected_stable_revision
        or not stat.S_ISDIR(current.st_mode)
        or stat.S_IMODE(current.st_mode) != 0o700
        or current.st_uid != os.geteuid()
    ):
        raise RuntimeError("LipForcing-Paarverzeichnis driftete während des Host-Mux.")


def receipt_revision(metadata: os.stat_result) -> dict[str, int | str]:
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


def seal_private_artifact(path: Path, label: str) -> dict[str, int | str]:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size <= 0:
        raise RuntimeError(f"{label} ist kein reguläres Einzeldatei-Artefakt: {path}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if file_revision(opened) != file_revision(before):
            raise RuntimeError(f"{label} wurde beim Öffnen ausgetauscht: {path}")
        os.fchmod(descriptor, 0o400)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)
    return secure_file_evidence(path, label, require_private=True)


def copy_file_exclusive(source: Path, destination: Path, label: str) -> Path:
    source_evidence = secure_file_evidence(source, f"Quelle für {label}")
    require_absent(destination, label)
    source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    destination_descriptor: int | None = None
    try:
        source_revision = os.fstat(source_descriptor)
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
        )
        while True:
            chunk = os.read(source_descriptor, 8 * 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(destination_descriptor, view)
                view = view[written:]
        if file_revision(os.fstat(source_descriptor)) != file_revision(source_revision):
            raise RuntimeError(f"Quelle für {label} änderte sich während des Kopierens.")
        os.fsync(destination_descriptor)
    finally:
        os.close(source_descriptor)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
    fsync_directory(destination.parent)
    destination_evidence = secure_file_evidence(destination, label, require_private=True)
    if destination_evidence != source_evidence:
        raise RuntimeError(f"{label} ist nicht byteidentisch mit seiner Quelle.")
    return destination


def write_private_json_exclusive(path: Path, payload: dict[str, object]) -> None:
    require_absent(path, "Receipt")
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
    fsync_directory(path.parent)
    secure_file_evidence(path, "Timeline-Receipt", require_private=True)


def executable_evidence(path: Path) -> dict[str, str]:
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_nlink != 1
        or metadata.st_mode & 0o111 == 0
        or metadata.st_mode & 0o022 != 0
    ):
        raise RuntimeError(
            f"Gebundene ausführbare Datei ist nicht root-owned/sicher ausführbar: {path}"
        )
    file_evidence = secure_file_evidence(path, f"gebundene ausführbare Datei {path}")
    result = subprocess.run(
        [str(path), "-version"],
        check=True,
        capture_output=True,
        env=DOCKER_ENV,
        text=True,
    )
    version = result.stdout.splitlines()[0] if result.stdout else ""
    if not version.startswith(path.name + " version "):
        raise RuntimeError(f"Unerwartete Versionsausgabe von {path}.")
    return {"path": str(path), "sha256": str(file_evidence["sha256"]), "version": version}


def require_object_keys(value: object, expected: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != expected:
        raise RuntimeError(f"{label} besitzt ein unerwartetes Schema.")
    return value


def read_private_json(path: Path, label: str) -> tuple[dict[str, object], str]:
    before = path.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_IMODE(before.st_mode) != 0o400
        or before.st_nlink != 1
        or before.st_size <= 0
        or before.st_uid != os.geteuid()
    ):
        raise RuntimeError(f"{label} ist kein privates Einzeldatei-Artefakt.")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if file_revision(opened) != file_revision(before):
            raise RuntimeError(f"{label} wurde beim Öffnen ausgetauscht.")
        chunks: list[bytes] = []
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            chunks.append(chunk)
        if file_revision(os.fstat(descriptor)) != file_revision(opened):
            raise RuntimeError(f"{label} änderte sich während des Lesens.")
    finally:
        os.close(descriptor)
    try:
        payload = json.loads(b"".join(chunks).decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} ist kein gültiges UTF-8-JSON.") from error
    return require_object_keys(payload, set(payload) if isinstance(payload, dict) else set(), label), digest.hexdigest()


def valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def artifact_matches(
    declared: object,
    actual: dict[str, int | str],
    label: str,
) -> None:
    value = require_object_keys(declared, {"sha256", "sizeBytes"}, label)
    if value != actual:
        raise RuntimeError(f"{label} stimmt nicht mit dem privaten Artefakt überein.")


def validate_receipt_revision(value: object, label: str) -> dict[str, int | str]:
    revision = require_object_keys(
        value,
        {
            "deviceId", "fileId", "mode", "uid", "gid", "nlink",
            "modifiedAtNs", "changedAtNs",
        },
        label,
    )
    if (
        any(
            not isinstance(revision[field], str)
            or re.fullmatch(r"[0-9]{1,32}", revision[field]) is None
            for field in ("deviceId", "fileId", "modifiedAtNs", "changedAtNs")
        )
        or any(
            not isinstance(revision[field], int)
            or isinstance(revision[field], bool)
            or revision[field] < 0
            for field in ("mode", "uid", "gid")
        )
        or revision["nlink"] != 1
    ):
        raise RuntimeError(f"{label} ist keine gültige Einzeldatei-Revision.")
    return revision  # type: ignore[return-value]


def validate_pre_mux_export_receipt(
    pair_directory: Path,
) -> tuple[str | None, dict[str, int | str]]:
    paths = {
        name: pair_directory / filename
        for name, filename in PAIR_ARTIFACT_NAMES.items()
    }
    expected = {
        PAIR_ARTIFACT_NAMES["pre_mux"],
        PAIR_ARTIFACT_NAMES["pre_mux_receipt"],
    }
    if {entry.name for entry in pair_directory.iterdir()} != expected:
        raise RuntimeError("Container darf im Paarmodus nur Pre-Mux und Pre-Mux-Receipt exportieren.")
    pre_mux_path = paths["pre_mux"]
    actual = secure_file_evidence(pre_mux_path, "CRF13-Pre-Mux", require_private=True)
    receipt, _receipt_sha256 = read_private_json(
        paths["pre_mux_receipt"],
        "Pre-Mux-Export-Receipt",
    )
    receipt = require_object_keys(
        receipt,
        {
            "schemaVersion", "durationArg", "source", "export", "byteIdentical",
            "copy", "code",
        },
        "Pre-Mux-Export-Receipt",
    )
    duration_arg = receipt["durationArg"]
    if (
        receipt["schemaVersion"] != PREMUX_EXPORT_RECEIPT_SCHEMA
        or not (
            duration_arg is None
            or (
                isinstance(duration_arg, str)
                and re.fullmatch(r"(?:0|[1-9][0-9]*)\.[0-9]{4}", duration_arg) is not None
                and float(duration_arg) > 0
            )
        )
        or receipt["byteIdentical"] is not True
    ):
        raise RuntimeError("Pre-Mux-Export-Receipt besitzt ungültige Grunddaten.")
    declared_artifacts: dict[str, dict[str, object]] = {}
    for name in ("source", "export"):
        artifact = require_object_keys(
            receipt[name],
            {"sha256", "sizeBytes", "revision"},
            f"Pre-Mux-{name}",
        )
        if (
            not valid_sha256(artifact["sha256"])
            or not isinstance(artifact["sizeBytes"], int)
            or isinstance(artifact["sizeBytes"], bool)
            or artifact["sizeBytes"] <= 0
        ):
            raise RuntimeError(f"Pre-Mux-{name} besitzt ungültige Hash-/Größenevidence.")
        validate_receipt_revision(artifact["revision"], f"Pre-Mux-{name}-Revision")
        declared_artifacts[name] = artifact
    if (
        declared_artifacts["source"]["sha256"] != declared_artifacts["export"]["sha256"]
        or declared_artifacts["source"]["sizeBytes"] != declared_artifacts["export"]["sizeBytes"]
        or declared_artifacts["export"]["sha256"] != actual["sha256"]
        or declared_artifacts["export"]["sizeBytes"] != actual["sizeBytes"]
        or declared_artifacts["export"]["revision"] != receipt_revision(pre_mux_path.lstat())
    ):
        raise RuntimeError("Pre-Mux-Export ist nicht byteidentisch/revisionsgleich zum Containerbeleg.")
    copy = require_object_keys(receipt["copy"], {"method", "command"}, "Pre-Mux-Copy")
    command = require_object_keys(copy["command"], {"argv", "sha256"}, "Pre-Mux-Copy-Befehl")
    argv = command["argv"]
    if (
        copy["method"] != "python-os-read-write-held-fd-exclusive-v1"
        or not isinstance(argv, list)
        or len(argv) != 6
        or argv[0] != "ltx-studio-internal-held-fd-copy-v1"
        or argv[1] != "--source"
        or not isinstance(argv[2], str)
        or re.fullmatch(r"/proc/self/fd/[0-9]+", argv[2]) is None
        or argv[3:] != ["--output", CONTAINER_PREMUX_OUTPUT, "--exclusive"]
        or command["sha256"] != sha256_command(argv)
    ):
        raise RuntimeError("Pre-Mux-Copy-Evidence bindet nicht die exklusive gehaltene FD-Kopie.")
    code = require_object_keys(
        receipt["code"],
        {"rawOutputMuxSha256", "containerRunnerSha256"},
        "Pre-Mux-Containercode",
    )
    local_deploy = Path(__file__).resolve().parent.parent / "deploy" / "lipforcing"
    expected_code = {
        "rawOutputMuxSha256": sha256_file(local_deploy / "raw_output_mux.py"),
        "containerRunnerSha256": sha256_file(local_deploy / "container_runner.py"),
    }
    if code != expected_code:
        raise RuntimeError("Pre-Mux-Receipt stammt nicht aus dem lokal gebundenen Containercode.")
    return duration_arg, actual


def run_host_raw_mux_pair(
    pair_directory: Path,
    control_audio: Path,
    duration_arg: str | None,
    expected_pre_mux: dict[str, int | str],
) -> tuple[str, dict[str, dict[str, int | str]]]:
    paths = {
        name: pair_directory / filename
        for name, filename in PAIR_ARTIFACT_NAMES.items()
    }
    for name, label in (
        ("baseline_raw", "Baseline-Rohausgabe"),
        ("candidate_raw", "Candidate-Rohausgabe"),
        ("raw_receipt", "Raw-Mux-Receipt"),
    ):
        require_absent(paths[name], label)

    held_descriptors: list[int] = []
    try:
        ffmpeg_fd, ffmpeg_revision, ffmpeg_identity = open_held_executable(
            FFMPEG_EXECUTABLE
        )
        held_descriptors.append(ffmpeg_fd)
        pre_mux_fd, pre_mux_revision, pre_mux_evidence = open_held_file(
            paths["pre_mux"],
            "CRF13-Pre-Mux für Host-Mux",
            require_private=True,
        )
        held_descriptors.append(pre_mux_fd)
        control_fd, control_revision, control_evidence = open_held_file(
            control_audio,
            "gemeinsames LipForcing-Steueraudio für Host-Mux",
        )
        held_descriptors.append(control_fd)
        directory_fd, directory_revision = open_held_private_directory(pair_directory)
        held_descriptors.append(directory_fd)
        if pre_mux_evidence != expected_pre_mux:
            raise RuntimeError("Gehaltenes Pre-Mux weicht vom Container-Exportbeleg ab.")
        if len({ffmpeg_fd, pre_mux_fd, control_fd, directory_fd}) != 4:
            raise RuntimeError("Host-Mux konnte keine eindeutigen gehaltenen FDs binden.")

        video_fd_path = f"/proc/self/fd/{pre_mux_fd}"
        audio_fd_path = f"/proc/self/fd/{control_fd}"
        output_root = f"/proc/self/fd/{directory_fd}"
        baseline_command = expected_raw_mux_command(
            video_fd_path,
            audio_fd_path,
            ["-c:v", "libx264", "-crf", "18"],
            duration_arg,
            f"{output_root}/{PAIR_ARTIFACT_NAMES['baseline_raw']}",
        )
        candidate_command = expected_raw_mux_command(
            video_fd_path,
            audio_fd_path,
            ["-c:v", "copy"],
            duration_arg,
            f"{output_root}/{PAIR_ARTIFACT_NAMES['candidate_raw']}",
        )
        inherited = (ffmpeg_fd, pre_mux_fd, control_fd, directory_fd)
        for command, output_name, label in (
            (baseline_command, "baseline_raw", "Host-CRF18-Baseline-Mux"),
            (candidate_command, "candidate_raw", "Host-Stream-copy-Candidate-Mux"),
        ):
            result = subprocess.run(
                command,
                capture_output=True,
                env=DOCKER_ENV,
                executable=f"/proc/self/fd/{ffmpeg_fd}",
                pass_fds=inherited,
                text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(f"{label} scheiterte: {result.stderr}")
            seal_private_artifact(paths[output_name], label)
            verify_held_file(
                pre_mux_fd,
                pre_mux_revision,
                pre_mux_evidence,
                "CRF13-Pre-Mux für Host-Mux",
            )
            verify_held_file(
                control_fd,
                control_revision,
                control_evidence,
                "gemeinsames LipForcing-Steueraudio für Host-Mux",
            )
            verify_held_executable(
                FFMPEG_EXECUTABLE,
                ffmpeg_fd,
                ffmpeg_revision,
                ffmpeg_identity,
            )
            verify_held_private_directory(
                pair_directory,
                directory_fd,
                directory_revision,
            )
            os.fsync(directory_fd)

        baseline_evidence = secure_file_evidence(
            paths["baseline_raw"], "Baseline-Rohausgabe", require_private=True
        )
        candidate_evidence = secure_file_evidence(
            paths["candidate_raw"], "Candidate-Rohausgabe", require_private=True
        )
        receipt_payload: dict[str, object] = {
            "schemaVersion": PAIRED_RECEIPT_SCHEMA,
            "profiles": {
                "baseline": DEFAULT_RAW_OUTPUT_PROFILE,
                "candidate": PAIRED_CANDIDATE_PROFILE,
            },
            "durationArg": duration_arg,
            "ffmpeg": verify_held_executable(
                FFMPEG_EXECUTABLE,
                ffmpeg_fd,
                ffmpeg_revision,
                ffmpeg_identity,
            ),
            "inputs": {
                "preMuxSourceSha256": str(pre_mux_evidence["sha256"]),
                "preMuxExportSha256": str(pre_mux_evidence["sha256"]),
                "preMuxSizeBytes": int(pre_mux_evidence["sizeBytes"]),
                "audioSha256": str(control_evidence["sha256"]),
                "audioSizeBytes": int(control_evidence["sizeBytes"]),
            },
            "commands": {
                "baseline": {
                    "argv": baseline_command,
                    "sha256": sha256_command(baseline_command),
                },
                "candidate": {
                    "argv": candidate_command,
                    "sha256": sha256_command(candidate_command),
                },
            },
            "outputs": {
                "baselineRaw": baseline_evidence,
                "candidateRaw": candidate_evidence,
            },
        }
        write_private_json_exclusive(paths["raw_receipt"], receipt_payload)
        verify_held_file(
            pre_mux_fd,
            pre_mux_revision,
            pre_mux_evidence,
            "CRF13-Pre-Mux nach Receipt-Seal",
        )
        verify_held_file(
            control_fd,
            control_revision,
            control_evidence,
            "Steueraudio nach Receipt-Seal",
        )
        verify_held_private_directory(pair_directory, directory_fd, directory_revision)
        os.fsync(directory_fd)
    finally:
        for descriptor in reversed(held_descriptors):
            os.close(descriptor)
    return validate_raw_mux_receipt(pair_directory, control_audio)


def expected_raw_mux_command(
    video_fd_path: str,
    audio_fd_path: str,
    codec: list[str],
    duration_arg: str | None,
    output: str,
) -> list[str]:
    command = [
        "/usr/bin/ffmpeg", "-n", "-loglevel", "error", "-nostdin",
        "-i", video_fd_path, "-i", audio_fd_path,
        "-map", "0:v:0", "-map", "1:a:0",
        *codec,
        "-c:a", "aac", "-q:v", "0", "-q:a", "0",
    ]
    if duration_arg is not None:
        command.extend(["-t", duration_arg])
    command.append(output)
    return command


def validate_raw_mux_receipt(
    pair_directory: Path,
    control_audio: Path,
) -> tuple[str, dict[str, dict[str, int | str]]]:
    expected_five = {
        PAIR_ARTIFACT_NAMES["pre_mux"],
        PAIR_ARTIFACT_NAMES["pre_mux_receipt"],
        PAIR_ARTIFACT_NAMES["baseline_raw"],
        PAIR_ARTIFACT_NAMES["candidate_raw"],
        PAIR_ARTIFACT_NAMES["raw_receipt"],
    }
    if {entry.name for entry in pair_directory.iterdir()} != expected_five:
        raise RuntimeError("LipForcing-Raw-Paar enthält fehlende oder unerwartete Artefakte.")
    paths = {
        name: pair_directory / filename
        for name, filename in PAIR_ARTIFACT_NAMES.items()
    }
    pre_mux = secure_file_evidence(paths["pre_mux"], "CRF13-Pre-Mux", require_private=True)
    baseline = secure_file_evidence(
        paths["baseline_raw"], "Baseline-Rohausgabe", require_private=True
    )
    candidate = secure_file_evidence(
        paths["candidate_raw"], "Candidate-Rohausgabe", require_private=True
    )
    audio = secure_file_evidence(control_audio, "gemeinsames LipForcing-Steueraudio")
    receipt, receipt_sha256 = read_private_json(paths["raw_receipt"], "Raw-Mux-Receipt")
    receipt = require_object_keys(
        receipt,
        {"schemaVersion", "profiles", "durationArg", "ffmpeg", "inputs", "commands", "outputs"},
        "Raw-Mux-Receipt",
    )
    if receipt["schemaVersion"] != PAIRED_RECEIPT_SCHEMA:
        raise RuntimeError("Raw-Mux-Receipt hat eine unerwartete Schema-Version.")
    profiles = require_object_keys(receipt["profiles"], {"baseline", "candidate"}, "Raw-Mux-Profile")
    if profiles != {
        "baseline": DEFAULT_RAW_OUTPUT_PROFILE,
        "candidate": PAIRED_CANDIDATE_PROFILE,
    }:
        raise RuntimeError("Raw-Mux-Receipt bindet unerwartete Profile.")
    duration_arg = receipt["durationArg"]
    if duration_arg is not None and (
        not isinstance(duration_arg, str)
        or re.fullmatch(r"(?:0|[1-9][0-9]*)\.[0-9]{4}", duration_arg) is None
        or float(duration_arg) <= 0
    ):
        raise RuntimeError("Raw-Mux-Receipt enthält ein ungültiges Dauerargument.")
    ffmpeg = require_object_keys(receipt["ffmpeg"], {"path", "sha256", "version"}, "Raw-Mux-FFmpeg")
    if (
        ffmpeg["path"] != "/usr/bin/ffmpeg"
        or not valid_sha256(ffmpeg["sha256"])
        or not isinstance(ffmpeg["version"], str)
        or not ffmpeg["version"].startswith("ffmpeg version ")
    ):
        raise RuntimeError("Raw-Mux-Receipt enthält keine gültige FFmpeg-Autorität.")
    if ffmpeg != executable_evidence(FFMPEG_EXECUTABLE):
        raise RuntimeError("Raw-Mux-Receipt bindet nicht den aktuellen Host-FFmpeg-Build.")
    inputs = require_object_keys(
        receipt["inputs"],
        {
            "preMuxSourceSha256", "preMuxExportSha256", "preMuxSizeBytes",
            "audioSha256", "audioSizeBytes",
        },
        "Raw-Mux-Eingaben",
    )
    if (
        inputs["preMuxSourceSha256"] != pre_mux["sha256"]
        or inputs["preMuxExportSha256"] != pre_mux["sha256"]
        or inputs["preMuxSizeBytes"] != pre_mux["sizeBytes"]
        or inputs["audioSha256"] != audio["sha256"]
        or inputs["audioSizeBytes"] != audio["sizeBytes"]
    ):
        raise RuntimeError("Raw-Mux-Receipt bindet nicht die gemeinsamen Eingabebytes.")
    commands = require_object_keys(receipt["commands"], {"baseline", "candidate"}, "Raw-Mux-Befehle")
    parsed_commands: dict[str, list[str]] = {}
    for name in ("baseline", "candidate"):
        command = require_object_keys(commands[name], {"argv", "sha256"}, f"Raw-Mux-Befehl {name}")
        argv = command["argv"]
        if not isinstance(argv, list) or not argv or any(not isinstance(item, str) for item in argv):
            raise RuntimeError(f"Raw-Mux-Befehl {name} besitzt keine String-argv.")
        parsed_commands[name] = argv
        if command["sha256"] != sha256_command(argv):
            raise RuntimeError(f"Raw-Mux-Befehl {name} besitzt einen ungültigen Digest.")
    baseline_argv = parsed_commands["baseline"]
    candidate_argv = parsed_commands["candidate"]
    if len(baseline_argv) < 9 or len(candidate_argv) < 9:
        raise RuntimeError("Raw-Mux-Baseline-Befehl ist unvollständig.")
    video_fd_path = baseline_argv[6]
    audio_fd_path = baseline_argv[8]
    baseline_output = baseline_argv[-1]
    candidate_output = candidate_argv[-1]
    baseline_output_match = re.fullmatch(
        r"/proc/self/fd/([0-9]+)/baseline-raw\.mp4",
        baseline_output,
    ) if isinstance(baseline_output, str) else None
    candidate_output_match = re.fullmatch(
        r"/proc/self/fd/([0-9]+)/candidate-raw\.mp4",
        candidate_output,
    ) if isinstance(candidate_output, str) else None
    if (
        re.fullmatch(r"/proc/self/fd/[0-9]+", video_fd_path) is None
        or re.fullmatch(r"/proc/self/fd/[0-9]+", audio_fd_path) is None
        or video_fd_path == audio_fd_path
        or candidate_argv[6] != video_fd_path
        or candidate_argv[8] != audio_fd_path
        or baseline_output_match is None
        or candidate_output_match is None
        or baseline_output_match.group(1) != candidate_output_match.group(1)
        or f"/proc/self/fd/{baseline_output_match.group(1)}" in {video_fd_path, audio_fd_path}
    ):
        raise RuntimeError("Raw-Mux-Befehl bindet keine getrennten gehaltenen Ein-/Ausgabe-FDs.")
    expected_baseline = expected_raw_mux_command(
        video_fd_path,
        audio_fd_path,
        ["-c:v", "libx264", "-crf", "18"],
        duration_arg,
        baseline_output,
    )
    expected_candidate = expected_raw_mux_command(
        video_fd_path,
        audio_fd_path,
        ["-c:v", "copy"],
        duration_arg,
        candidate_output,
    )
    if baseline_argv != expected_baseline or candidate_argv != expected_candidate:
        raise RuntimeError("Raw-Mux-A/B-Befehle weichen außerhalb Codec und Ausgabe voneinander ab.")
    outputs = require_object_keys(receipt["outputs"], {"baselineRaw", "candidateRaw"}, "Raw-Mux-Ausgaben")
    artifact_matches(outputs["baselineRaw"], baseline, "Baseline-Rohausgabe")
    artifact_matches(outputs["candidateRaw"], candidate, "Candidate-Rohausgabe")
    return receipt_sha256, {
        "preMux": pre_mux,
        "baselineRaw": baseline,
        "candidateRaw": candidate,
    }


def build_timeline_command(
    timeline_script: Path,
    refined: str | Path,
    source: str | Path,
    program_audio: str | Path,
    output: Path,
    program_audio_delay_ms: int,
    ffmpeg_descriptor: int,
    ffprobe_descriptor: int,
    input_descriptors: tuple[int, ...],
) -> list[str]:
    command = [
        sys.executable, str(timeline_script),
        "--refined", str(refined),
        "--source", str(source),
        "--audio", str(program_audio),
        "--program-audio-delay-ms", str(program_audio_delay_ms),
        "--exclusive-output",
        "--emit-command-evidence",
        "--paired-ffmpeg-fd", str(ffmpeg_descriptor),
        "--paired-ffprobe-fd", str(ffprobe_descriptor),
        "--output", str(output),
    ]
    for descriptor in input_descriptors:
        command.extend(["--paired-input-fd", str(descriptor)])
    return command


def run_timeline_with_evidence(
    command: list[str],
    inherited_descriptors: tuple[int, ...],
) -> tuple[dict[str, object], list[str]]:
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        env=DOCKER_ENV,
        pass_fds=inherited_descriptors,
        text=True,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Timeline-Verarbeitung lieferte keine gültige Evidence.") from error
    payload = require_object_keys(
        payload,
        {"frame_rate", "frame_count", "width", "height", "has_audio", "command"},
        "Timeline-Evidence",
    )
    internal_command = payload.pop("command")
    if (
        not isinstance(internal_command, list)
        or not internal_command
        or any(not isinstance(item, str) for item in internal_command)
    ):
        raise RuntimeError("Timeline-Evidence enthält keinen vollständigen internen FFmpeg-Befehl.")
    timeline = {
        "frameRate": payload["frame_rate"],
        "frameCount": payload["frame_count"],
        "width": payload["width"],
        "height": payload["height"],
        "hasAudio": payload["has_audio"],
    }
    if (
        not isinstance(timeline["frameRate"], str)
        or re.fullmatch(r"[1-9][0-9]*/[1-9][0-9]*", timeline["frameRate"]) is None
        or any(
            not isinstance(timeline[field], int)
            or isinstance(timeline[field], bool)
            or timeline[field] <= 0
            for field in ("frameCount", "width", "height")
        )
        or timeline["hasAudio"] is not True
    ):
        raise RuntimeError("Timeline-Evidence besitzt ungültige Messwerte.")
    return timeline, internal_command


def normalized_timeline_command(command: list[str]) -> list[str]:
    normalized = list(command)
    try:
        first_input = normalized.index("-i") + 1
    except ValueError as error:
        raise RuntimeError("Timeline-Befehl besitzt keinen Refined-Input.") from error
    normalized[first_input] = "<paired-refined>"
    normalized[-1] = "<paired-output>"
    return normalized


def decoded_pcm_evidence(
    ffmpeg_descriptor: int,
    input_descriptor: int,
) -> tuple[list[str], str]:
    input_path = f"/proc/self/fd/{input_descriptor}"
    command = [
        str(FFMPEG_EXECUTABLE), "-v", "error", "-i", input_path,
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
        "-f", "s16le", "pipe:1",
    ]
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        env=DOCKER_ENV,
        executable=f"/proc/self/fd/{ffmpeg_descriptor}",
        pass_fds=(ffmpeg_descriptor, input_descriptor),
    )
    if not result.stdout:
        raise RuntimeError("Timeline-Ausgabe besitzt kein dekodierbares Audio.")
    return command, hashlib.sha256(result.stdout).hexdigest()


def require_file(path: Path, label: str, expected_sha256: str | None = None) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} fehlt oder ist leer: {resolved}")
    if expected_sha256 is not None and sha256_file(resolved) != expected_sha256:
        raise RuntimeError(f"{label} hat eine unerwartete SHA-256-Prüfsumme: {resolved}")
    return resolved


def verify_text_embedding(model_root: Path) -> None:
    provenance_path = require_file(
        model_root / "text-embedding-provenance.json",
        "LipForcing-Text-Embedding-Provenienz",
    )
    provenance = json.loads(provenance_path.read_text(encoding="utf8"))
    if (
        provenance.get("schema_version") != "ltx-studio-lipforcing-text-embedding.v1"
        or provenance.get("prompt") != "a person talking"
        or provenance.get("lipforcing_commit") != LIPFORCING_COMMIT
    ):
        raise RuntimeError("LipForcing-Text-Embedding-Provenienz ist nicht freigegeben.")
    artifact = provenance.get("artifact")
    if not isinstance(artifact, dict):
        raise RuntimeError("LipForcing-Text-Embedding-Artefakt fehlt in der Provenienz.")
    embedding = require_file(model_root / "text_emb.pt", "LipForcing-Text-Embedding")
    if (
        embedding.stat().st_size != int(artifact.get("size_bytes", 0))
        or sha256_file(embedding) != artifact.get("sha256")
    ):
        raise RuntimeError("LipForcing-Text-Embedding stimmt nicht mit seiner Provenienz überein.")


def verify_image_revision(image: str) -> None:
    if not IMAGE_ID_PATTERN.fullmatch(image) and not REPO_DIGEST_PATTERN.fullmatch(image):
        raise RuntimeError(
            "LipForcing-Ausführung benötigt eine vorab gebundene unveränderliche Image-ID oder RepoDigest."
        )
    result = subprocess.run(
        [
            DOCKER_EXECUTABLE, "image", "inspect",
            "--format", "{{json .}}",
            image,
        ],
        check=True,
        capture_output=True,
        env=DOCKER_ENV,
        text=True,
    )
    inspection = json.loads(result.stdout)
    config = inspection.get("Config") if isinstance(inspection, dict) else None
    labels = config.get("Labels") if isinstance(config, dict) else None
    image_id = inspection.get("Id") if isinstance(inspection, dict) else None
    repo_digests = inspection.get("RepoDigests") if isinstance(inspection, dict) else None
    if (
        not isinstance(labels, dict)
        or not isinstance(image_id, str)
        or not IMAGE_ID_PATTERN.fullmatch(image_id)
        or (IMAGE_ID_PATTERN.fullmatch(image) and image_id != image)
        or (
            REPO_DIGEST_PATTERN.fullmatch(image)
            and (not isinstance(repo_digests, list) or image not in repo_digests)
        )
        or labels.get("org.opencontainers.image.revision") != LIPFORCING_COMMIT
        or labels.get("com.moddy.ltx-studio.lipforcing.patchset") != LIPFORCING_PATCHSET_ID
    ):
        raise RuntimeError(
            f"LipForcing-Container {image} ist nicht auf Revision {LIPFORCING_COMMIT} "
            f"und Patchset {LIPFORCING_PATCHSET_ID} gebaut."
        )


def video_duration_seconds(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,duration",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    if len(streams) != 1:
        raise RuntimeError(f"LipForcing-Eingabevideo hat keine eindeutige Videospur: {path}")
    stream = streams[0]
    raw_rate = stream.get("avg_frame_rate")
    if not raw_rate or raw_rate == "0/0":
        raw_rate = stream.get("r_frame_rate")
    raw_count = stream.get("nb_frames")
    if raw_rate and raw_rate != "0/0" and raw_count and raw_count != "N/A":
        duration = float(Fraction(int(raw_count), 1) / Fraction(str(raw_rate)))
    else:
        duration = float(stream.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"LipForcing-Eingabevideo hat keine belastbare Dauer: {path}")
    return duration


def prepare_source_video(source: Path, output: Path) -> Path:
    """Convert the source cadence to LipForcing's fixed 25 fps training domain."""
    source = require_file(source, "LipForcing-Eingabevideo")
    source_duration = video_duration_seconds(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source), "-map", "0:v:0", "-an",
        "-vf", "fps=fps=25:round=near",
        "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ], check=True)
    normalized = require_file(output, "LipForcing-25-fps-CFR-Eingabe")
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,duration",
            "-of", "json", str(normalized),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    stream = (json.loads(result.stdout).get("streams") or [{}])[0]
    raw_rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate")
    if not raw_rate or Fraction(str(raw_rate)) != 25:
        raise RuntimeError("LipForcing-Eingabe konnte nicht auf exakt 25 fps CFR normalisiert werden.")
    frame_count = int(stream.get("nb_frames") or 0)
    normalized_duration = frame_count / 25 if frame_count > 0 else float(stream.get("duration") or 0)
    if abs(normalized_duration - source_duration) > (1 / 25) + 1e-6:
        raise RuntimeError("LipForcing-25-fps-Eingabe hat die Quellzeitachse verändert.")
    log(
        f"Quellvideo für die trainierte 25-fps-CFR-Domäne normalisiert "
        f"({frame_count} Frames, {normalized_duration:.3f} s)."
    )
    return normalized


def prepare_driving_audio(
    source_audio: Path,
    source_video: Path,
    output: Path,
    start_seconds: float,
    max_duration_seconds: float | None,
) -> Path:
    if not math.isfinite(start_seconds) or start_seconds < 0:
        raise RuntimeError("LipForcing-Audiostart muss eine endliche, nichtnegative Zahl sein.")
    if (
        max_duration_seconds is not None
        and (not math.isfinite(max_duration_seconds) or max_duration_seconds <= 0)
    ):
        raise RuntimeError("LipForcing-Audiodauer muss eine endliche, positive Zahl sein.")
    source_audio = require_file(source_audio, "LipForcing-Führungsaudio")
    target_duration = video_duration_seconds(source_video)
    trim = f"atrim=start={start_seconds:.9f}"
    if max_duration_seconds is not None:
        trim += f":duration={max_duration_seconds:.9f}"
    audio_filter = (
        f"{trim},asetpts=PTS-STARTPTS,apad,"
        f"atrim=duration={target_duration:.9f},asetpts=PTS-STARTPTS"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source_audio), "-map", "0:a:0", "-vn",
        "-af", audio_filter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ], check=True)
    return require_file(output, "vorbereitete LipForcing-Führungsaudiospur")


def prepare_control_audio(
    program_audio: Path,
    output: Path,
    target_duration_seconds: float,
    mouth_delay_ms: int,
) -> Path:
    """Shift only model conditioning while leaving the audible program track intact."""
    if not isinstance(mouth_delay_ms, int) or isinstance(mouth_delay_ms, bool):
        raise RuntimeError("LipForcing-Lippenverzögerung muss eine ganze Millisekundenzahl sein.")
    if mouth_delay_ms < -500 or mouth_delay_ms > 500:
        raise RuntimeError("LipForcing-Lippenverzögerung muss zwischen -500 und 500 ms liegen.")
    program_audio = require_file(program_audio, "LipForcing-Programmaudio")
    if mouth_delay_ms == 0:
        return program_audio
    if mouth_delay_ms > 0:
        shift_filter = f"adelay={mouth_delay_ms}:all=1"
    else:
        shift_filter = f"atrim=start={abs(mouth_delay_ms) / 1000:.9f},asetpts=PTS-STARTPTS"
    audio_filter = (
        f"{shift_filter},apad,atrim=duration={target_duration_seconds:.9f},"
        "asetpts=PTS-STARTPTS"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(program_audio), "-map", "0:a:0", "-vn",
        "-af", audio_filter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ], check=True)
    return require_file(output, "zeitkorrigierte LipForcing-Modellführung")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--audio-start", type=float, default=0)
    parser.add_argument("--audio-duration", type=float)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-root", required=True)
    parser.add_argument("--paired-raw-experiment-dir")
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--insightface-root", required=True)
    parser.add_argument("--image", default="ltx-studio-lipforcing:14b-cu131")
    parser.add_argument("--container-name")
    parser.add_argument("--decoder", choices=["wan-vae", "streaming-taehv"], default="wan-vae")
    parser.add_argument(
        "--raw-output-profile",
        choices=RAW_OUTPUT_PROFILES,
        default=DEFAULT_RAW_OUTPUT_PROFILE,
    )
    parser.add_argument("--mouth-delay-ms", type=int, default=0)
    parser.add_argument("--program-audio-delay-ms", type=int, default=0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.program_audio_delay_ms < -500 or args.program_audio_delay_ms > 500:
        raise RuntimeError("LipForcing-Tonversatz muss zwischen -500 und 500 ms liegen.")
    if (
        args.paired_raw_experiment_dir is not None
        and args.raw_output_profile != DEFAULT_RAW_OUTPUT_PROFILE
    ):
        raise RuntimeError("LipForcing-Raw-Paarmodus ist ausschließlich im Baseline-Profil erlaubt.")

    video = require_file(Path(args.video), "LipForcing-Eingabevideo")
    output = Path(args.output).resolve()
    stage_root = Path(args.stage_root).resolve()
    model_root = Path(args.model_root).resolve()
    insightface_root = Path(args.insightface_root).resolve()
    stage_root.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    if args.paired_raw_experiment_dir is not None:
        require_absent(output, "gepaarte Baseline-Finalausgabe")

    require_file(model_root / "lipforcing_14b.pth", "LipForcing-14B-Modell", MODEL_SHA256)
    require_file(model_root / "Wan2.1_VAE.pth", "LipForcing-Wan-VAE", VAE_SHA256)
    require_file(
        model_root / "wav2vec2-base-960h" / "model.safetensors",
        "LipForcing-wav2vec2",
        WAV2VEC_MODEL_SHA256,
    )
    require_file(
        model_root / "wav2vec2-base-960h" / "config.json",
        "LipForcing-wav2vec2-Konfiguration",
        WAV2VEC_CONFIG_SHA256,
    )
    require_file(
        model_root / "wav2vec2-base-960h" / "preprocessor_config.json",
        "LipForcing-wav2vec2-Vorverarbeitung",
        WAV2VEC_PREPROCESSOR_SHA256,
    )
    require_file(
        model_root / "wav2vec2-base-960h" / "feature_extractor_config.json",
        "LipForcing-wav2vec2-Merkmalsextraktion",
        WAV2VEC_FEATURE_EXTRACTOR_SHA256,
    )
    require_file(model_root / "mask.png", "LipForcing-Mundmaske", MASK_SHA256)
    if args.decoder == "streaming-taehv":
        require_file(model_root / "taew2_1.pth", "LipForcing-TAEHV", TAEHV_SHA256)
    verify_text_embedding(model_root)
    require_file(
        insightface_root / "models" / "buffalo_l" / "det_10g.onnx",
        "InsightFace-SCRFD-Gesichtsmodell",
        INSIGHTFACE_DETECTOR_SHA256,
    )
    require_file(
        insightface_root / "models" / "buffalo_l" / "2d106det.onnx",
        "InsightFace-106-Punkt-Landmark-Modell",
        INSIGHTFACE_LANDMARK_SHA256,
    )
    verify_image_revision(args.image)

    program_audio = prepare_driving_audio(
        Path(args.audio).resolve() if args.audio else video,
        video,
        stage_root / "lipforcing-program-audio.wav",
        args.audio_start if args.audio else 0,
        args.audio_duration if args.audio else None,
    )
    control_audio_path = stage_root / "lipforcing-control-audio.wav"
    control_audio = prepare_control_audio(
        program_audio,
        control_audio_path,
        video_duration_seconds(video),
        args.mouth_delay_ms,
    )
    if args.paired_raw_experiment_dir is not None and control_audio == program_audio:
        control_audio = copy_file_exclusive(
            program_audio,
            control_audio_path,
            "dediziertes LipForcing-Paar-Steueraudio",
        )
    if args.mouth_delay_ms:
        log(
            f"Modellführung um {args.mouth_delay_ms:+d} ms verschoben; "
            "die hörbare Sprachspur bleibt unverändert."
        )
    normalized_video = prepare_source_video(
        video,
        stage_root / "lipforcing-source-25fps.mp4",
    )

    pair_directory = (
        create_private_pair_directory(args.paired_raw_experiment_dir, stage_root)
        if args.paired_raw_experiment_dir is not None
        else None
    )

    raw_name = args.container_name or f"ltx-lipforcing-{os.environ.get('DGX_JOB_ID', uuid.uuid4().hex[:12])}"
    container_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", raw_name)[:120]
    work_root = stage_root / "lipforcing-work"
    work_root.mkdir(parents=True, exist_ok=True)
    raw_output = (
        pair_directory / PAIR_ARTIFACT_NAMES["baseline_raw"]
        if pair_directory is not None
        else output.with_name(f".{output.name}.lipforcing-raw-{uuid.uuid4().hex}.mp4")
    )
    final_output = output.with_name(f".{output.name}.lipforcing-final-{uuid.uuid4().hex}.mp4")
    candidate_final = (
        pair_directory / PAIR_ARTIFACT_NAMES["candidate_final"]
        if pair_directory is not None
        else None
    )
    timeline_receipt = (
        pair_directory / PAIR_ARTIFACT_NAMES["timeline_receipt"]
        if pair_directory is not None
        else None
    )
    if pair_directory is None:
        raw_output.unlink(missing_ok=True)
    else:
        for path, label in (
            (raw_output, "Baseline-Rohausgabe"),
            (candidate_final, "Candidate-Timeline-Ausgabe"),
            (timeline_receipt, "Timeline-Receipt"),
        ):
            assert path is not None
            require_absent(path, label)
    final_output.unlink(missing_ok=True)
    timeline_script = Path(__file__).resolve().parent.parent / "deploy" / "lipforcing" / "timeline.py"
    output_mount = (
        ["-v", f"{pair_directory}:/paired"]
        if pair_directory is not None
        else ["-v", f"{raw_output.parent}:/output"]
    )
    container_output = (
        "/paired/pre-mux-crf13.mp4"
        if pair_directory is not None
        else f"/output/{raw_output.name}"
    )
    paired_runner_arguments = (
        [
            "--paired-premux-output", "/paired/pre-mux-crf13.mp4",
            "--paired-premux-receipt-output", "/paired/pre-mux-receipt.json",
        ]
        if pair_directory is not None
        else []
    )
    command = [
        DOCKER_EXECUTABLE, "run", "--pull", "never", "--rm", "--gpus", "all", "--ipc", "host",
        "--network", "none",
        "--name", container_name,
        "--label", "dgx.runtime=ltx2_native",
        "--label", f"dgx.job={os.environ.get('DGX_JOB_ID', 'unknown')}",
        "--label", "dgx.source_app=ltx-studio",
        "-e", "HF_HUB_OFFLINE=1",
        "-e", "TRANSFORMERS_OFFLINE=1",
        "-e", "TOKENIZERS_PARALLELISM=false",
        "-e", "NO_ALBUMENTATIONS_UPDATE=1",
        "-e", "HOME=/work",
        "-e", "LIPFORCING_INSIGHTFACE_ROOT=/models/insightface",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{normalized_video}:/input/video.mp4:ro",
        "-v", f"{control_audio}:/input/audio.wav:ro",
        *output_mount,
        "-v", f"{work_root}:/work",
        "-v", f"{model_root}:/models/lipforcing:ro",
        "-v", f"{insightface_root}:/models/insightface:ro",
        args.image,
        "--video", "/input/video.mp4",
        "--audio", "/input/audio.wav",
        "--output", container_output,
        "--model-root", "/models/lipforcing",
        "--decoder", args.decoder,
        "--raw-output-profile", args.raw_output_profile,
        *paired_runner_arguments,
        "--seed", str(args.seed),
    ]

    child: subprocess.Popen[str] | None = None
    try:
        log(f"Container {container_name} startet innerhalb der bestehenden LTX-Zuteilung.")
        child = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=DOCKER_ENV,
            text=True,
            bufsize=1,
        )
        assert child.stdout is not None
        for line in child.stdout:
            if line.rstrip():
                print(line.rstrip(), flush=True)
        code = child.wait()
        if code != 0:
            raise RuntimeError(f"LipForcing-Container endete mit Code {code}.")
        if pair_directory is not None:
            assert candidate_final is not None
            assert timeline_receipt is not None
            duration_arg, pre_mux_evidence = validate_pre_mux_export_receipt(
                pair_directory,
            )
            raw_receipt_sha256, raw_artifact_evidence = run_host_raw_mux_pair(
                pair_directory,
                control_audio,
                duration_arg,
                pre_mux_evidence,
            )
            held_descriptors: list[int] = []
            try:
                ffmpeg_fd, ffmpeg_revision, ffmpeg_identity = open_held_executable(
                    FFMPEG_EXECUTABLE
                )
                held_descriptors.append(ffmpeg_fd)
                ffprobe_fd, ffprobe_revision, ffprobe_identity = open_held_executable(
                    FFPROBE_EXECUTABLE
                )
                held_descriptors.append(ffprobe_fd)
                source_fd, source_revision, source_evidence = open_held_file(
                    video,
                    "gemeinsame LTX-Quelle",
                )
                held_descriptors.append(source_fd)
                program_audio_fd, program_audio_revision, program_audio_evidence = open_held_file(
                    program_audio,
                    "gemeinsames Timeline-Programmaudio",
                )
                held_descriptors.append(program_audio_fd)
                baseline_raw_fd, baseline_raw_revision, baseline_raw_evidence = open_held_file(
                    raw_output,
                    "Baseline-Rohausgabe",
                    require_private=True,
                )
                held_descriptors.append(baseline_raw_fd)
                candidate_raw_path = pair_directory / PAIR_ARTIFACT_NAMES["candidate_raw"]
                candidate_raw_fd, candidate_raw_revision, candidate_raw_evidence = open_held_file(
                    candidate_raw_path,
                    "Candidate-Rohausgabe",
                    require_private=True,
                )
                held_descriptors.append(candidate_raw_fd)
                if (
                    baseline_raw_evidence != raw_artifact_evidence["baselineRaw"]
                    or candidate_raw_evidence != raw_artifact_evidence["candidateRaw"]
                ):
                    raise RuntimeError("Gehaltene Timeline-Rohinputs weichen vom Raw-Mux-Receipt ab.")

                input_descriptors = (
                    source_fd,
                    program_audio_fd,
                    baseline_raw_fd,
                    candidate_raw_fd,
                )
                inherited_descriptors = (ffmpeg_fd, ffprobe_fd, *input_descriptors)
                baseline_timeline_cli = build_timeline_command(
                    timeline_script,
                    f"/proc/self/fd/{baseline_raw_fd}",
                    f"/proc/self/fd/{source_fd}",
                    f"/proc/self/fd/{program_audio_fd}",
                    output,
                    args.program_audio_delay_ms,
                    ffmpeg_fd,
                    ffprobe_fd,
                    input_descriptors,
                )
                candidate_timeline_cli = build_timeline_command(
                    timeline_script,
                    f"/proc/self/fd/{candidate_raw_fd}",
                    f"/proc/self/fd/{source_fd}",
                    f"/proc/self/fd/{program_audio_fd}",
                    candidate_final,
                    args.program_audio_delay_ms,
                    ffmpeg_fd,
                    ffprobe_fd,
                    input_descriptors,
                )
                baseline_timeline, baseline_internal_command = run_timeline_with_evidence(
                    baseline_timeline_cli,
                    inherited_descriptors,
                )
                verify_held_file(
                    source_fd, source_revision, source_evidence, "gemeinsame LTX-Quelle"
                )
                verify_held_file(
                    program_audio_fd,
                    program_audio_revision,
                    program_audio_evidence,
                    "gemeinsames Timeline-Programmaudio",
                )
                verify_held_file(
                    baseline_raw_fd,
                    baseline_raw_revision,
                    baseline_raw_evidence,
                    "Baseline-Rohausgabe",
                )
                verify_held_file(
                    candidate_raw_fd,
                    candidate_raw_revision,
                    candidate_raw_evidence,
                    "Candidate-Rohausgabe",
                )
                verify_held_executable(
                    FFMPEG_EXECUTABLE,
                    ffmpeg_fd,
                    ffmpeg_revision,
                    ffmpeg_identity,
                )
                verify_held_executable(
                    FFPROBE_EXECUTABLE,
                    ffprobe_fd,
                    ffprobe_revision,
                    ffprobe_identity,
                )
                candidate_timeline, candidate_internal_command = run_timeline_with_evidence(
                    candidate_timeline_cli,
                    inherited_descriptors,
                )
                if baseline_timeline != candidate_timeline:
                    raise RuntimeError("A/B-Timeline-Ergebnisse sind nicht identisch.")
                if (
                    normalized_timeline_command(baseline_internal_command)
                    != normalized_timeline_command(candidate_internal_command)
                    or baseline_internal_command[0] != str(FFMPEG_EXECUTABLE)
                    or candidate_internal_command[0] != str(FFMPEG_EXECUTABLE)
                    or "-n" not in baseline_internal_command
                    or "-n" not in candidate_internal_command
                ):
                    raise RuntimeError(
                        "A/B-Timeline-Befehle weichen außerhalb Refined-Input und Ausgabe ab."
                    )
                verify_held_file(
                    source_fd, source_revision, source_evidence, "gemeinsame LTX-Quelle"
                )
                verify_held_file(
                    program_audio_fd,
                    program_audio_revision,
                    program_audio_evidence,
                    "gemeinsames Timeline-Programmaudio",
                )
                verify_held_file(
                    baseline_raw_fd,
                    baseline_raw_revision,
                    baseline_raw_evidence,
                    "Baseline-Rohausgabe",
                )
                verify_held_file(
                    candidate_raw_fd,
                    candidate_raw_revision,
                    candidate_raw_evidence,
                    "Candidate-Rohausgabe",
                )
                candidate_final_evidence = seal_private_artifact(
                    candidate_final,
                    "Candidate-Ausgabe mit LTX-Zeitachse",
                )
                baseline_final_fd, baseline_final_revision, baseline_final_evidence = open_held_file(
                    output,
                    "Baseline-Ausgabe mit LTX-Zeitachse",
                )
                held_descriptors.append(baseline_final_fd)
                candidate_final_fd, candidate_final_revision, held_candidate_final_evidence = open_held_file(
                    candidate_final,
                    "Candidate-Ausgabe mit LTX-Zeitachse",
                    require_private=True,
                )
                held_descriptors.append(candidate_final_fd)
                if held_candidate_final_evidence != candidate_final_evidence:
                    raise RuntimeError("Candidate-Final änderte sich vor der PCM-Prüfung.")
                baseline_pcm_command, baseline_pcm_sha256 = decoded_pcm_evidence(
                    ffmpeg_fd,
                    baseline_final_fd,
                )
                candidate_pcm_command, candidate_pcm_sha256 = decoded_pcm_evidence(
                    ffmpeg_fd,
                    candidate_final_fd,
                )
                if baseline_pcm_sha256 != candidate_pcm_sha256:
                    raise RuntimeError("A/B-Timeline-Ausgaben besitzen nicht dieselben PCM-Audiobytes.")
                verify_held_file(
                    baseline_final_fd,
                    baseline_final_revision,
                    baseline_final_evidence,
                    "Baseline-Ausgabe mit LTX-Zeitachse",
                )
                verify_held_file(
                    candidate_final_fd,
                    candidate_final_revision,
                    candidate_final_evidence,
                    "Candidate-Ausgabe mit LTX-Zeitachse",
                )
                executables_before = {
                    "ffmpeg": ffmpeg_identity,
                    "ffprobe": ffprobe_identity,
                }
                executables_after = {
                    "ffmpeg": verify_held_executable(
                        FFMPEG_EXECUTABLE,
                        ffmpeg_fd,
                        ffmpeg_revision,
                        ffmpeg_identity,
                    ),
                    "ffprobe": verify_held_executable(
                        FFPROBE_EXECUTABLE,
                        ffprobe_fd,
                        ffprobe_revision,
                        ffprobe_identity,
                    ),
                }
                timeline_receipt_payload: dict[str, object] = {
                    "schemaVersion": TIMELINE_RECEIPT_SCHEMA,
                    "rawMuxReceiptSha256": raw_receipt_sha256,
                    "programAudioDelayMs": args.program_audio_delay_ms,
                    "inputs": {
                        "source": source_evidence,
                        "programAudio": program_audio_evidence,
                    },
                    "executables": {
                        "before": executables_before,
                        "after": executables_after,
                    },
                    "commands": {
                        "baseline": {
                            "argv": baseline_internal_command,
                            "sha256": sha256_command(baseline_internal_command),
                        },
                        "candidate": {
                            "argv": candidate_internal_command,
                            "sha256": sha256_command(candidate_internal_command),
                        },
                    },
                    "timeline": {
                        "baseline": baseline_timeline,
                        "candidate": candidate_timeline,
                    },
                    "decodedPcm": {
                        "format": "s16le-mono-48000",
                        "commands": {
                            "baseline": {
                                "argv": baseline_pcm_command,
                                "sha256": sha256_command(baseline_pcm_command),
                            },
                            "candidate": {
                                "argv": candidate_pcm_command,
                                "sha256": sha256_command(candidate_pcm_command),
                            },
                        },
                    },
                    "outputs": {
                        "baselineFinal": {
                            **baseline_final_evidence,
                            "decodedPcmSha256": baseline_pcm_sha256,
                        },
                        "candidateFinal": {
                            **candidate_final_evidence,
                            "decodedPcmSha256": candidate_pcm_sha256,
                        },
                    },
                }
                write_private_json_exclusive(timeline_receipt, timeline_receipt_payload)
                expected_six = set(PAIR_ARTIFACT_NAMES.values())
                if {entry.name for entry in pair_directory.iterdir()} != expected_six:
                    raise RuntimeError("LipForcing-Paar enthält nach Timeline unerwartete Artefakte.")
                log(f"kausales Raw-Mux-A/B versiegelt: {pair_directory}")
            finally:
                for descriptor in reversed(held_descriptors):
                    os.close(descriptor)
        else:
            require_file(raw_output, "LipForcing-Rohausgabe")
            timeline_command = [
                sys.executable, str(timeline_script),
                "--refined", str(raw_output),
                "--source", str(video),
                "--output", str(final_output),
            ]
            if args.audio:
                timeline_command.extend(["--audio", str(program_audio)])
            elif args.program_audio_delay_ms:
                timeline_command.extend(["--audio", str(program_audio)])
            timeline_command.extend([
                "--program-audio-delay-ms", str(args.program_audio_delay_ms),
            ])
            subprocess.run(timeline_command, check=True)
            require_file(final_output, "LipForcing-Ausgabe mit LTX-Zeitachse")
            final_output.replace(output)
        if args.program_audio_delay_ms:
            log(
                f"hörbare Sprachspur im Endmix um {args.program_audio_delay_ms:+d} ms verschoben."
            )
        log(f"verfeinertes Video fertig: {output}")
        return 0
    finally:
        if pair_directory is None:
            raw_output.unlink(missing_ok=True)
        final_output.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log(f"Fehler: {error}")
        raise SystemExit(1)
