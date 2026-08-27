#!/usr/bin/env python3
"""Pinned German eSpeak-ng reference-phone generation without a quality decision."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import NoReturn


DATA_MANIFEST_SCHEMA = "ltx-studio-espeak-ng-data-tree-manifest.v1"
RUNTIME_MANIFEST_SCHEMA = "ltx-studio-espeak-ng-runtime-manifest.v1"
REQUEST_SCHEMA = "ltx-studio-t2a-german-g2p-request.v1"
RESULT_SCHEMA = "ltx-studio-t2a-german-g2p-result.v1"
CANONICALIZATION = "ltx-studio-canonical-json.v1"
DIGEST_ALGORITHM = "sha256"

ESPEAK_PATH = Path("/usr/bin/espeak-ng")
DATA_ROOT = Path("/usr/lib/aarch64-linux-gnu/espeak-ng-data")
DATA_PARENT = "/usr/lib/aarch64-linux-gnu"
VOCAB_PATH = Path(
    "/var/lib/ltx-studio/models/facebook--wav2vec2-xlsr-53-espeak-cv-ft/"
    "2c733782da5604684829819a5eb744c193fe9398/vocab.json"
)
ESPEAK_BINARY_SHA256 = "89402b6a13d29ab2edb0570c809796751b22a5d031828897cfb1b370dafa9c29"
ESPEAK_DATA_MANIFEST_SHA256 = "a886ef7d07601c45d2982d91a546808f2cb1a99194ed07a443cb9d3839798658"
IPA_VOCABULARY_SHA256 = "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0"
IPA_VOCABULARY_SIZE_BYTES = 4_637
LOADER_POLICY_SHA256 = "b1dff4daabc84ba1e8384c1620526b3e499d554ab247e267d48d55d1ef981e6d"
ELF_CLOSURE_SHA256 = "6b3c725e5197a5fffffd2858cb8078d5f640626bed1e26d91f989ceedb6c1265"
RUNTIME_MANIFEST_SHA256 = "a29161e2a8d9ddc48735151319de1fcff03783262bbe63849ba2308bf0715939"
LD_PRELOAD_PATH = Path("/etc/ld.so.preload")

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
MAX_STDERR_BYTES = 4 * 1024
MAX_TOKENS = 1_049
TIMEOUT_SECONDS = 5.0
MAX_TREE_ENTRIES = 10_000
MAX_TREE_BYTES = 64 * 1024 * 1024

ESPEAK_ARGS = (
    "-q",
    "-b",
    "1",
    "-v",
    "de",
    "--stdin",
    "--ipa=1",
    "--sep=z",
    f"--path={DATA_PARENT}",
)
FIXED_ENVIRONMENT = {
    "LANG": "C",
    "LC_ALL": "C",
    "PATH": "/usr/bin:/bin",
    "TZ": "UTC",
}
NORMALIZATION_POLICY = {
    "schemaVersion": "ltx-studio-t2a-german-g2p-normalization-policy.v1",
    "locale": "de-DE",
    "sourceEncoding": "utf-8-strict.v1",
    "sourceDigest": "sha256-exact-source-utf8.v1",
    "textCanonicalization": "crlf-and-cr-to-lf-then-unicode-nfc.v1",
    "unicodeNormalizationAuthority": "unicode-normalization-stable-german-repertoire.v1",
    "sourceRepertoire": "ascii-latin-combining-general-punctuation-symbol-ranges.v1",
    "forbiddenInput": "nul-c0-c1-bom-bidi-and-default-ignorable-controls.v1",
    "whitespacePolicy": "preserve-except-line-ending-canonicalization.v1",
    "casePolicy": "preserve.v1",
    "punctuationPolicy": "preserve-for-pinned-espeak.v1",
    "espeakInvocation": "espeak-ng-1.51-de-ipa1-zwnj-fixed-argv-env.v1",
    "phoneDelimiter": "U+200C",
    "wordDelimiters": ["U+0020", "U+000A"],
    "languageSwitchMarkers": "remove-strict-parenthesized-lower-bcp47.v1",
    "stressMarksRemoved": ["U+02C8", "U+02CC"],
    "phoneNormalization": "none-after-marker-and-stress-removal.v1",
    "vocabularyPolicy": "exact-pinned-vocab-excluding-token-ids-0-through-3.v1",
    "doubleQuestionTokenPolicy": "allow-pinned-vocab-token-id-85.v1",
    "maximumSourceBytes": MAX_INPUT_BYTES,
    "maximumNormalizedBytes": MAX_INPUT_BYTES,
    "maximumEspeakStdoutBytes": MAX_OUTPUT_BYTES,
    "maximumEspeakStderrBytes": MAX_STDERR_BYTES,
    "maximumReferenceTokens": MAX_TOKENS,
}


class G2pError(RuntimeError):
    """The pinned G2P contract was not satisfied."""


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        separators=(",", ": "),
        sort_keys=True,
    ) + "\n"


def _sha256(content: bytes | str) -> str:
    if isinstance(content, str):
        content = content.encode("utf-8", errors="strict")
    return hashlib.sha256(content).hexdigest()


NORMALIZATION_POLICY_SHA256 = _sha256(_canonical_json(NORMALIZATION_POLICY))
EMPTY_SHA256 = _sha256(b"")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
LANGUAGE_MARKER_RE = re.compile(r"^\([a-z]{2,3}(?:-[a-z0-9]{2,8})*\)$")


def _is_default_ignorable_codepoint(codepoint: int) -> bool:
    return (
        codepoint in {0x00AD, 0x034F, 0x061C, 0x3164, 0xFEFF, 0xFFA0}
        or 0x115F <= codepoint <= 0x1160
        or 0x17B4 <= codepoint <= 0x17B5
        or 0x180B <= codepoint <= 0x180F
        or 0x200B <= codepoint <= 0x200F
        or 0x202A <= codepoint <= 0x202E
        or 0x2060 <= codepoint <= 0x206F
        or 0xFE00 <= codepoint <= 0xFE0F
        or 0xFFF0 <= codepoint <= 0xFFF8
        or 0x1BCA0 <= codepoint <= 0x1BCA3
        or 0x1D173 <= codepoint <= 0x1D17A
        or 0xE0000 <= codepoint <= 0xE0FFF
    )


def _is_frozen_german_source_codepoint(codepoint: int) -> bool:
    return (
        codepoint in {0x09, 0x0A, 0x0D}
        or 0x20 <= codepoint <= 0x7E
        or 0x00A0 <= codepoint <= 0x036F
        or 0x1E00 <= codepoint <= 0x1EFF
        or 0x2000 <= codepoint <= 0x22FF
        or 0x2500 <= codepoint <= 0x27BF
        or 0x2C60 <= codepoint <= 0x2C7F
        or 0xA720 <= codepoint <= 0xA7FF
        or 0xAB30 <= codepoint <= 0xAB6F
        or 0xFB00 <= codepoint <= 0xFB06
    )


def _is_forbidden_target_character(character: str) -> bool:
    codepoint = ord(character)
    return (
        codepoint <= 0x08
        or codepoint in {0x0B, 0x0C}
        or 0x0E <= codepoint <= 0x1F
        or 0x7F <= codepoint <= 0x9F
        or _is_default_ignorable_codepoint(codepoint)
        or not _is_frozen_german_source_codepoint(codepoint)
    )


def _reject_surrogates(value: object, description: str) -> None:
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise G2pError(f"Invalid Unicode in {description}")
    elif isinstance(value, list):
        for item in value:
            _reject_surrogates(item, description)
    elif isinstance(value, dict):
        for key, item in value.items():
            _reject_surrogates(key, description)
            _reject_surrogates(item, description)


def _strict_json_loads(content: bytes, *, description: str) -> object:
    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise G2pError(f"Duplicate JSON key in {description}")
            result[key] = value
        return result

    def reject_constant(_value: str) -> NoReturn:
        raise G2pError(f"Non-finite JSON number in {description}")

    try:
        value = json.loads(
            content.decode("utf-8", errors="strict"),
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise G2pError(f"Invalid UTF-8 JSON in {description}") from error
    _reject_surrogates(value, description)
    return value


def _expect_dict(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise G2pError(f"Unexpected fields in {label}")
    return value


def _expect_str(value: object, label: str, *, minimum: int = 1, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise G2pError(f"Invalid string in {label}")
    _reject_surrogates(value, label)
    return value


def _expect_literal(value: object, expected: object, label: str) -> None:
    if type(value) is not type(expected) or value != expected:
        raise G2pError(f"Unexpected literal in {label}")


def _expect_sha256(value: object, label: str, expected: str | None = None) -> str:
    digest = _expect_str(value, label, minimum=64, maximum=64)
    if SHA256_RE.fullmatch(digest) is None or (expected is not None and digest != expected):
        raise G2pError(f"Invalid SHA-256 in {label}")
    return digest


def _expect_int(value: object, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise G2pError(f"Invalid integer in {label}")
    return value


def _decode_canonical_document(
    encoded: object,
    *,
    maximum_bytes: int,
    description: str,
) -> tuple[dict[str, object], str]:
    value = _expect_str(encoded, f"encoded {description}", maximum=2 * maximum_bytes)
    try:
        content = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise G2pError(f"Invalid canonical base64 for {description}") from error
    if (
        not content
        or len(content) > maximum_bytes
        or base64.b64encode(content).decode("ascii") != value
    ):
        raise G2pError(f"Invalid canonical size or encoding for {description}")
    decoded = _strict_json_loads(content, description=description)
    document = _expect_dict(decoded, set(decoded) if isinstance(decoded, dict) else set(), description)
    if _canonical_json(document).encode("utf-8") != content:
        raise G2pError(f"Non-canonical JSON for {description}")
    return document, _sha256(content)


def _portable_path(value: object) -> str:
    path = _expect_str(value, "data manifest path")
    if path == ".":
        return path
    if (
        path != unicodedata.normalize("NFC", path)
        or path.startswith("/")
        or path.endswith("/")
        or "\\" in path
        or len(path.encode("utf-8")) > 4096
        or any(ord(character) < 0x20 or 0x7F <= ord(character) <= 0x9F for character in path)
        or any(segment in {"", ".", ".."} for segment in path.split("/"))
    ):
        raise G2pError("Invalid portable path in data manifest")
    return path


def _validate_data_manifest(value: dict[str, object]) -> dict[str, object]:
    manifest = _expect_dict(value, {
        "schemaVersion",
        "canonicalization",
        "digestAlgorithm",
        "rootLogicalName",
        "pathEncoding",
        "entryOrder",
        "entries",
        "summary",
    }, "eSpeak data manifest")
    expected_literals = {
        "schemaVersion": DATA_MANIFEST_SCHEMA,
        "canonicalization": CANONICALIZATION,
        "digestAlgorithm": DIGEST_ALGORITHM,
        "rootLogicalName": "espeak-ng-data",
        "pathEncoding": "utf8-nfc-posix-relative.v1",
        "entryOrder": "utf8-byte-lexicographic.v1",
    }
    for key, expected in expected_literals.items():
        _expect_literal(manifest[key], expected, f"data manifest {key}")
    raw_entries = manifest["entries"]
    if not isinstance(raw_entries, list) or not 1 <= len(raw_entries) <= MAX_TREE_ENTRIES:
        raise G2pError("Invalid eSpeak data manifest entry count")
    entries: list[dict[str, object]] = []
    seen: set[str] = set()
    directory_paths: set[str] = set()
    file_count = 0
    total_bytes = 0
    prior_path: str | None = None
    for index, raw_entry in enumerate(raw_entries):
        if not isinstance(raw_entry, dict):
            raise G2pError("Invalid eSpeak data manifest entry")
        entry_type = raw_entry.get("type")
        keys = {"path", "type", "mode"} if entry_type == "directory" else {
            "path", "type", "mode", "sizeBytes", "sha256"
        }
        entry = _expect_dict(raw_entry, keys, "eSpeak data manifest entry")
        path = _portable_path(entry["path"])
        if path in seen or (prior_path is not None and prior_path.encode("utf-8") >= path.encode("utf-8")):
            raise G2pError("eSpeak data manifest paths are not unique UTF-8-byte sorted values")
        seen.add(path)
        prior_path = path
        if entry_type == "directory":
            _expect_literal(entry["type"], "directory", "data directory type")
            if entry["mode"] not in {"0555", "0755"}:
                raise G2pError("Unsafe eSpeak data directory mode")
            directory_paths.add(path)
        elif entry_type == "regular":
            _expect_literal(entry["type"], "regular", "data file type")
            if entry["mode"] not in {"0444", "0644"}:
                raise G2pError("Unsafe eSpeak data file mode")
            size = _expect_int(entry["sizeBytes"], 0, MAX_TREE_BYTES, "data file size")
            _expect_sha256(entry["sha256"], "data file")
            total_bytes += size
            file_count += 1
            if total_bytes > MAX_TREE_BYTES:
                raise G2pError("eSpeak data manifest exceeds its byte bound")
        else:
            raise G2pError("Unsupported eSpeak data manifest entry type")
        if index == 0 and (path != "." or entry_type != "directory"):
            raise G2pError("eSpeak data manifest lacks its root directory")
        if path != ".":
            parent = path.rsplit("/", 1)[0] if "/" in path else "."
            if parent not in directory_paths:
                raise G2pError("eSpeak data manifest entry lacks a declared parent")
        entries.append(entry)
    summary = _expect_dict(
        manifest["summary"],
        {"directoryCount", "regularFileCount", "totalRegularFileBytes"},
        "eSpeak data manifest summary",
    )
    if (
        _expect_int(summary["directoryCount"], 1, MAX_TREE_ENTRIES, "directory count")
        != len(directory_paths)
        or _expect_int(summary["regularFileCount"], 0, MAX_TREE_ENTRIES, "file count")
        != file_count
        or _expect_int(summary["totalRegularFileBytes"], 0, MAX_TREE_BYTES, "tree bytes")
        != total_bytes
    ):
        raise G2pError("eSpeak data manifest summary mismatch")
    manifest["entries"] = entries
    return manifest


def _mode_string(details: os.stat_result) -> str:
    return f"{stat.S_IMODE(details.st_mode):04o}"


def _same_revision(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        left.st_mode,
        left.st_nlink,
        left.st_size,
        left.st_mtime_ns,
        left.st_ctime_ns,
    ) == (
        right.st_dev,
        right.st_ino,
        right.st_mode,
        right.st_nlink,
        right.st_size,
        right.st_mtime_ns,
        right.st_ctime_ns,
    )


def _capture_data_manifest(root: Path = DATA_ROOT) -> dict[str, object]:
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise G2pError("eSpeak data root is not canonical")
    entries: list[dict[str, object]] = []
    total_bytes = 0

    def walk(path: Path) -> None:
        nonlocal total_bytes
        if len(entries) >= MAX_TREE_ENTRIES:
            raise G2pError("eSpeak data tree exceeds its entry bound")
        before = path.lstat()
        portable = path.relative_to(root).as_posix() if path != root else "."
        _portable_path(portable)
        if before.st_uid != 0 or before.st_gid != 0:
            raise G2pError("eSpeak data entry is not root-owned")
        if stat.S_ISLNK(before.st_mode):
            raise G2pError("eSpeak data symlink is forbidden")
        if stat.S_ISDIR(before.st_mode):
            mode = _mode_string(before)
            if mode not in {"0555", "0755"}:
                raise G2pError("Unsafe eSpeak data directory mode")
            entries.append({"path": portable, "type": "directory", "mode": mode})
            children = sorted(os.scandir(path), key=lambda entry: os.fsencode(entry.name))
            normalized_names: set[str] = set()
            for child in children:
                name = child.name
                _reject_surrogates(name, "eSpeak data filename")
                normalized = unicodedata.normalize("NFC", name)
                if normalized != name or normalized in normalized_names:
                    raise G2pError("eSpeak data filename is not unique NFC")
                normalized_names.add(normalized)
                walk(path / name)
            after = path.lstat()
            if not _same_revision(before, after):
                raise G2pError("eSpeak data directory changed during capture")
            return
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise G2pError("eSpeak data entry is not a single-link regular file")
        mode = _mode_string(before)
        if mode not in {"0444", "0644"}:
            raise G2pError("Unsafe eSpeak data file mode")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            held_before = os.fstat(descriptor)
            if not _same_revision(before, held_before):
                raise G2pError("eSpeak data file was replaced before capture")
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                total_bytes += len(chunk)
                if total_bytes > MAX_TREE_BYTES:
                    raise G2pError("eSpeak data tree exceeds its byte bound")
                digest.update(chunk)
            held_after = os.fstat(descriptor)
            path_after = path.lstat()
            if not _same_revision(held_before, held_after) or not _same_revision(held_after, path_after):
                raise G2pError("eSpeak data file changed during capture")
            entries.append({
                "path": portable,
                "type": "regular",
                "mode": mode,
                "sizeBytes": size,
                "sha256": digest.hexdigest(),
            })
        finally:
            os.close(descriptor)

    walk(root)
    entries.sort(key=lambda entry: str(entry["path"]).encode("utf-8"))
    files = [entry for entry in entries if entry["type"] == "regular"]
    manifest = {
        "schemaVersion": DATA_MANIFEST_SCHEMA,
        "canonicalization": CANONICALIZATION,
        "digestAlgorithm": DIGEST_ALGORITHM,
        "rootLogicalName": "espeak-ng-data",
        "pathEncoding": "utf8-nfc-posix-relative.v1",
        "entryOrder": "utf8-byte-lexicographic.v1",
        "entries": entries,
        "summary": {
            "directoryCount": len(entries) - len(files),
            "regularFileCount": len(files),
            "totalRegularFileBytes": sum(int(entry["sizeBytes"]) for entry in files),
        },
    }
    return _validate_data_manifest(manifest)


def _validate_runtime_file(value: object, logical_name: str, *, expected_sha: str | None = None) -> dict[str, object]:
    runtime_file = _expect_dict(value, {"logicalName", "mode", "sizeBytes", "sha256"}, f"runtime file {logical_name}")
    _expect_literal(runtime_file["logicalName"], logical_name, f"runtime logical name {logical_name}")
    if runtime_file["mode"] not in {"0444", "0555", "0644", "0755"}:
        raise G2pError(f"Unsafe mode in runtime file {logical_name}")
    _expect_int(runtime_file["sizeBytes"], 1, MAX_TREE_BYTES, f"runtime file size {logical_name}")
    _expect_sha256(runtime_file["sha256"], logical_name, expected_sha)
    return runtime_file


def _expect_authority_path(value: object, label: str) -> str:
    path = _expect_str(value, label)
    if (
        not path.startswith("/")
        or os.path.normpath(path) != path
        or "\\" in path
        or len(path.encode("utf-8")) > 4096
    ):
        raise G2pError(f"Invalid canonical authority path in {label}")
    return path


def _validate_elf_authority_file(value: object, label: str) -> dict[str, object]:
    authority = _expect_dict(value, {"path", "sizeBytes", "mode", "sha256"}, label)
    _expect_authority_path(authority["path"], f"{label} path")
    _expect_int(authority["sizeBytes"], 0, MAX_TREE_BYTES, f"{label} size")
    _expect_int(authority["mode"], 0, 0o7777, f"{label} mode")
    _expect_sha256(authority["sha256"], label)
    return authority


def _validate_loader_preload(value: object) -> dict[str, object]:
    preload = _expect_dict(value, {"configuration", "entries"}, "loader preload")
    if preload["configuration"] is not None:
        _validate_elf_authority_file(preload["configuration"], "loader preload configuration")
    entries = preload["entries"]
    if not isinstance(entries, list) or len(entries) > 1024:
        raise G2pError("Invalid loader preload entries")
    for entry in entries:
        text = _expect_str(entry, "loader preload entry")
        if "\0" in text or ("/" in text and not text.startswith("/")):
            raise G2pError("Unsafe loader preload entry")
    if entries != sorted(set(entries)):
        raise G2pError("Loader preload entries are not unique sorted values")
    return preload


def _validate_loader_policy_document(value: object) -> dict[str, object]:
    policy = _expect_dict(value, {
        "ldconfig", "cache", "outputSha256", "preload", "entries",
    }, "loader policy document")
    ldconfig = _validate_elf_authority_file(policy["ldconfig"], "loader ldconfig")
    cache = _validate_elf_authority_file(policy["cache"], "loader cache")
    if ldconfig["path"] != "/usr/sbin/ldconfig" or cache["path"] != "/etc/ld.so.cache":
        raise G2pError("Loader policy uses unexpected authority paths")
    _expect_sha256(policy["outputSha256"], "loader inventory output")
    _validate_loader_preload(policy["preload"])
    entries = policy["entries"]
    if not isinstance(entries, dict) or len(entries) > 16_384:
        raise G2pError("Invalid loader cache inventory")
    for name, raw_paths in entries.items():
        _expect_str(name, "loader library name", maximum=512)
        if not isinstance(raw_paths, list) or not 1 <= len(raw_paths) <= 64:
            raise G2pError("Invalid loader library path list")
        paths = [_expect_authority_path(path, "loader library path") for path in raw_paths]
        if paths != sorted(set(paths)):
            raise G2pError("Loader library paths are not unique sorted values")
    if _sha256(_canonical_json(policy)) != LOADER_POLICY_SHA256:
        raise G2pError("Loader policy differs from the reviewed digest")
    return policy


def _validate_elf_closure_document(
    value: object,
    loader_policy: dict[str, object],
) -> dict[str, object]:
    closure = _expect_dict(value, {
        "schemaVersion", "executable", "interpreter", "loaderPolicy", "objects",
    }, "ELF closure document")
    _expect_literal(
        closure["schemaVersion"],
        "ltx-studio-elf-dependency-closure.v2",
        "ELF closure schema",
    )
    executable = _expect_authority_path(closure["executable"], "ELF executable")
    interpreter = _expect_authority_path(closure["interpreter"], "ELF interpreter")
    if executable != str(ESPEAK_PATH):
        raise G2pError("ELF closure is not rooted at pinned eSpeak")
    closure_loader = _expect_dict(
        closure["loaderPolicy"],
        {"ldconfig", "cache", "outputSha256", "preload"},
        "ELF closure loader subset",
    )
    expected_loader = {
        "ldconfig": loader_policy["ldconfig"],
        "cache": loader_policy["cache"],
        "outputSha256": loader_policy["outputSha256"],
        "preload": loader_policy["preload"],
    }
    if _canonical_json(closure_loader) != _canonical_json(expected_loader):
        raise G2pError("ELF closure and loader policy are not mutually bound")
    raw_objects = closure["objects"]
    if not isinstance(raw_objects, list) or not 2 <= len(raw_objects) <= 512:
        raise G2pError("Invalid ELF closure object count")
    objects: list[dict[str, object]] = []
    paths: set[str] = set()
    for raw_object in raw_objects:
        item = _expect_dict(raw_object, {"path", "sizeBytes", "mode", "sha256", "needed"}, "ELF closure object")
        authority = _validate_elf_authority_file(
            {key: item[key] for key in ("path", "sizeBytes", "mode", "sha256")},
            "ELF closure object",
        )
        path = str(authority["path"])
        if path in paths:
            raise G2pError("ELF closure object paths are not unique values")
        paths.add(path)
        needed = item["needed"]
        if not isinstance(needed, list) or len(needed) > 256:
            raise G2pError("Invalid ELF direct-dependency list")
        dependency_paths = [_expect_authority_path(entry, "ELF dependency path") for entry in needed]
        if dependency_paths != sorted(set(dependency_paths)):
            raise G2pError("ELF dependency paths are not unique sorted values")
        objects.append(item)
    if executable not in paths or interpreter not in paths:
        raise G2pError("ELF closure omits its executable or interpreter")
    if any(str(path) not in paths for item in objects for path in item["needed"]):
        raise G2pError("ELF closure omits a direct dependency")
    if _sha256(_canonical_json(closure)) != ELF_CLOSURE_SHA256:
        raise G2pError("ELF closure differs from the reviewed digest")
    return closure


def _expected_invocation() -> dict[str, object]:
    return {
        "executableBinding": "held-o_nofollow-proc-fd.v1",
        "arguments": list(ESPEAK_ARGS),
        "environment": dict(FIXED_ENVIRONMENT),
        "stdin": "normalized-target-utf8-no-added-newline.v1",
        "stdout": "espeak-ipa1-zwnj-strict-utf8.v1",
        "timeoutMilliseconds": int(TIMEOUT_SECONDS * 1000),
        "maximumStdoutBytes": MAX_OUTPUT_BYTES,
        "maximumStderrBytes": MAX_STDERR_BYTES,
    }


def _validate_runtime_manifest(value: dict[str, object]) -> dict[str, object]:
    manifest = _expect_dict(value, {
        "schemaVersion",
        "canonicalization",
        "digestAlgorithm",
        "platform",
        "package",
        "executable",
        "versionProbe",
        "elfClosureSha256",
        "loaderPolicySha256",
        "elfClosure",
        "loaderPolicy",
        "espeakDataManifestSha256",
        "ipaVocabularySha256",
        "normalizationPolicySha256",
        "localeFiles",
        "licenseFiles",
        "invocation",
    }, "eSpeak runtime manifest")
    for key, expected in {
        "schemaVersion": RUNTIME_MANIFEST_SCHEMA,
        "canonicalization": CANONICALIZATION,
        "digestAlgorithm": DIGEST_ALGORITHM,
    }.items():
        _expect_literal(manifest[key], expected, f"runtime manifest {key}")
    platform = _expect_dict(manifest["platform"], {"operatingSystem", "architecture", "elfMachine"}, "runtime platform")
    if platform != {"operatingSystem": "linux", "architecture": "arm64", "elfMachine": 183}:
        raise G2pError("Unexpected eSpeak runtime platform")
    package = _expect_dict(manifest["package"], {"source", "name", "version", "architecture"}, "runtime package")
    if package != {
        "source": "ubuntu-noble",
        "name": "espeak-ng",
        "version": "1.51+dfsg-12build1",
        "architecture": "arm64",
    }:
        raise G2pError("Unexpected eSpeak runtime package")
    _validate_runtime_file(manifest["executable"], "espeak-ng", expected_sha=ESPEAK_BINARY_SHA256)
    version = _expect_dict(manifest["versionProbe"], {"arguments", "exitCode", "stdoutSha256", "stderrSha256"}, "version probe")
    if version["arguments"] != ["--version"] or version["exitCode"] != 0:
        raise G2pError("Unexpected eSpeak version probe")
    _expect_sha256(version["stdoutSha256"], "version stdout")
    _expect_sha256(version["stderrSha256"], "version stderr", EMPTY_SHA256)
    _expect_sha256(manifest["elfClosureSha256"], "ELF closure", ELF_CLOSURE_SHA256)
    _expect_sha256(manifest["loaderPolicySha256"], "loader policy", LOADER_POLICY_SHA256)
    loader_policy = _validate_loader_policy_document(manifest["loaderPolicy"])
    _validate_elf_closure_document(manifest["elfClosure"], loader_policy)
    _expect_sha256(manifest["espeakDataManifestSha256"], "eSpeak data manifest", ESPEAK_DATA_MANIFEST_SHA256)
    _expect_sha256(manifest["ipaVocabularySha256"], "IPA vocabulary", IPA_VOCABULARY_SHA256)
    _expect_sha256(manifest["normalizationPolicySha256"], "normalization policy", NORMALIZATION_POLICY_SHA256)
    locale_files = manifest["localeFiles"]
    if not isinstance(locale_files, list) or len(locale_files) != 3:
        raise G2pError("Unexpected eSpeak locale closure")
    for item, name in zip(locale_files, ("C.utf8-LC_CTYPE", "locale-alias", "locale-archive"), strict=True):
        _validate_runtime_file(item, name)
    license_files = manifest["licenseFiles"]
    if not isinstance(license_files, list) or len(license_files) != 2:
        raise G2pError("Unexpected eSpeak license closure")
    for item, name in zip(
        license_files,
        ("espeak-ng-debian-copyright", "gnu-gpl-3-license"),
        strict=True,
    ):
        _validate_runtime_file(item, name)
    invocation = _expect_dict(manifest["invocation"], set(_expected_invocation()), "runtime invocation")
    if invocation != _expected_invocation():
        raise G2pError("eSpeak runtime invocation differs from the frozen policy")
    return manifest


def _capture_regular_file(path: Path, logical_name: str) -> tuple[dict[str, object], int]:
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise G2pError(f"Runtime authority is not canonical: {logical_name}")
    before = path.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or before.st_nlink != 1
        or before.st_uid != 0
        or before.st_gid != 0
    ):
        raise G2pError(f"Runtime authority is unsafe: {logical_name}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        held_before = os.fstat(descriptor)
        if not _same_revision(before, held_before):
            raise G2pError(f"Runtime authority was replaced: {logical_name}")
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_TREE_BYTES:
                raise G2pError(f"Runtime authority exceeds its bound: {logical_name}")
            digest.update(chunk)
        held_after = os.fstat(descriptor)
        path_after = path.lstat()
        if not _same_revision(held_before, held_after) or not _same_revision(held_after, path_after):
            raise G2pError(f"Runtime authority changed during capture: {logical_name}")
        return {
            "logicalName": logical_name,
            "mode": _mode_string(held_after),
            "sizeBytes": size,
            "sha256": digest.hexdigest(),
        }, descriptor
    except Exception:
        os.close(descriptor)
        raise


def _close_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=1)


def _run_bounded(
    executable_fd: int,
    arguments: tuple[str, ...],
    stdin_bytes: bytes,
    *,
    maximum_stdout_bytes: int,
    maximum_stderr_bytes: int,
    timeout_seconds: float = TIMEOUT_SECONDS,
) -> tuple[int, bytes, bytes]:
    deadline = time.monotonic() + timeout_seconds
    process = subprocess.Popen(
        [f"/proc/self/fd/{executable_fd}", *arguments],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd="/",
        env=dict(FIXED_ENVIRONMENT),
        close_fds=True,
        pass_fds=(executable_fd,),
        start_new_session=True,
    )
    if process.stdin is None or process.stdout is None or process.stderr is None:
        _close_process(process)
        raise G2pError("Pinned eSpeak pipes were not created")
    selector = selectors.DefaultSelector()
    try:
        if time.monotonic() >= deadline:
            raise G2pError("Pinned eSpeak timed out during process creation")
        os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        os.set_blocking(process.stderr.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        stdin_offset = 0
        if stdin_bytes:
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        stdout = bytearray()
        stderr = bytearray()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise G2pError("Pinned eSpeak timed out")
            events = selector.select(remaining)
            if not events and process.poll() is None:
                continue
            for key, _mask in events:
                stream = key.fileobj
                if key.data == "stdin":
                    try:
                        written = os.write(stream.fileno(), stdin_bytes[stdin_offset:])
                    except BrokenPipeError as error:
                        raise G2pError("Pinned eSpeak closed stdin before consuming its input") from error
                    if written <= 0:
                        raise G2pError("Pinned eSpeak stdin made no forward progress")
                    stdin_offset += written
                    if stdin_offset == len(stdin_bytes):
                        selector.unregister(stream)
                        stream.close()
                    continue
                chunk = os.read(stream.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(stream)
                    continue
                target = stdout if key.data == "stdout" else stderr
                target.extend(chunk)
                bound = maximum_stdout_bytes if key.data == "stdout" else maximum_stderr_bytes
                if len(target) > bound:
                    raise G2pError(f"Pinned eSpeak {key.data} exceeded its fixed bound")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise G2pError("Pinned eSpeak timed out")
        status = process.wait(timeout=remaining)
        return status, bytes(stdout), bytes(stderr)
    except (BrokenPipeError, subprocess.TimeoutExpired) as error:
        raise G2pError("Pinned eSpeak execution did not complete") from error
    finally:
        selector.close()
        if process.poll() is None:
            _close_process(process)


def _normalize_target_text(raw_text: object) -> tuple[str, str, str]:
    text = _expect_str(raw_text, "target text", maximum=MAX_INPUT_BYTES)
    try:
        source_bytes = text.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise G2pError("Invalid Unicode in target text") from error
    if not source_bytes or len(source_bytes) > MAX_INPUT_BYTES:
        raise G2pError("Target text exceeds its source byte bound")

    if any(_is_forbidden_target_character(character) for character in text):
        raise G2pError("Target text contains a forbidden control")
    normalized = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
    normalized_bytes = normalized.encode("utf-8", errors="strict")
    if (
        not normalized_bytes
        or len(normalized_bytes) > MAX_INPUT_BYTES
        or not any(not character.isspace() for character in normalized)
        or any(_is_forbidden_target_character(character) for character in normalized)
    ):
        raise G2pError("Normalized target text is invalid")
    return normalized, _sha256(source_bytes), _sha256(normalized_bytes)


def _load_vocabulary(descriptor: int) -> set[str]:
    os.lseek(descriptor, 0, os.SEEK_SET)
    content = os.read(descriptor, 1024 * 1024 + 1)
    if not content or len(content) > 1024 * 1024 or _sha256(content) != IPA_VOCABULARY_SHA256:
        raise G2pError("Pinned IPA vocabulary digest mismatch")
    value = _strict_json_loads(content, description="IPA vocabulary")
    vocabulary = _expect_dict(value, set(value) if isinstance(value, dict) else set(), "IPA vocabulary")
    if len(vocabulary) != 392:
        raise G2pError("Pinned IPA vocabulary has the wrong size")
    ids: set[int] = set()
    for token, raw_id in vocabulary.items():
        token_id = _expect_int(raw_id, 0, 391, "IPA vocabulary token ID")
        if token_id in ids or not token:
            raise G2pError("Pinned IPA vocabulary is not a token-ID bijection")
        ids.add(token_id)
    for token, expected_id in (("<pad>", 0), ("<s>", 1), ("</s>", 2), ("<unk>", 3), ("??", 85)):
        if vocabulary.get(token) != expected_id:
            raise G2pError("Pinned IPA vocabulary authority differs")
    return {token for token, token_id in vocabulary.items() if int(token_id) >= 4}


def _reference_tokens(stdout: bytes, vocabulary: set[str]) -> list[str]:
    if not stdout or len(stdout) > MAX_OUTPUT_BYTES:
        raise G2pError("eSpeak IPA stdout violates its byte bound")
    try:
        value = stdout.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise G2pError("eSpeak IPA stdout is not strict UTF-8") from error
    if value != unicodedata.normalize("NFC", value):
        raise G2pError("eSpeak IPA stdout is not NFC")
    if any(
        character in {"\t", "\r"}
        or ord(character) <= 0x08
        or ord(character) in {0x0B, 0x0C}
        or 0x0E <= ord(character) <= 0x1F
        or 0x7F <= ord(character) <= 0x9F
        for character in value
    ):
        raise G2pError("eSpeak IPA stdout violates its delimiter grammar")
    tokens: list[str] = []
    for raw_token in filter(None, re.split(r"[\u200c \n]+", value)):
        if LANGUAGE_MARKER_RE.fullmatch(raw_token):
            continue
        token = raw_token.replace("ˈ", "").replace("ˌ", "")
        if (
            not token
            or len(token) > 32
            or any(character.isspace() or ord(character) < 0x21 or 0x7F <= ord(character) <= 0x9F for character in token)
            or token not in vocabulary
        ):
            raise G2pError("eSpeak emitted a token outside the pinned IPA vocabulary")
        tokens.append(token)
    if not 1 <= len(tokens) <= MAX_TOKENS:
        raise G2pError("eSpeak emitted an invalid number of reference tokens")
    return tokens


def _validate_request(value: object) -> tuple[dict[str, object], dict[str, object], dict[str, object], str, str]:
    request = _expect_dict(value, {
        "schemaVersion",
        "targetText",
        "targetTextSha256",
        "g2pRunnerSha256",
        "espeakBinarySha256",
        "espeakDataManifestSha256",
        "espeakRuntimeManifestSha256",
        "ipaVocabularySha256",
        "normalizationPolicySha256",
        "dataManifestCanonicalJsonBase64",
        "runtimeManifestCanonicalJsonBase64",
    }, "German G2P request")
    _expect_literal(request["schemaVersion"], REQUEST_SCHEMA, "request schema")
    normalized, source_sha, normalized_sha = _normalize_target_text(request["targetText"])
    _expect_sha256(request["targetTextSha256"], "target text", source_sha)
    runner_sha = _sha256(Path(__file__).resolve(strict=True).read_bytes())
    _expect_sha256(request["g2pRunnerSha256"], "G2P runner", runner_sha)
    _expect_sha256(request["espeakBinarySha256"], "eSpeak binary", ESPEAK_BINARY_SHA256)
    _expect_sha256(request["espeakDataManifestSha256"], "eSpeak data", ESPEAK_DATA_MANIFEST_SHA256)
    _expect_sha256(
        request["espeakRuntimeManifestSha256"],
        "eSpeak runtime",
        RUNTIME_MANIFEST_SHA256,
    )
    _expect_sha256(request["ipaVocabularySha256"], "IPA vocabulary", IPA_VOCABULARY_SHA256)
    _expect_sha256(request["normalizationPolicySha256"], "normalization policy", NORMALIZATION_POLICY_SHA256)
    data_manifest, data_sha = _decode_canonical_document(
        request["dataManifestCanonicalJsonBase64"],
        maximum_bytes=1024 * 1024,
        description="eSpeak data manifest",
    )
    runtime_manifest, runtime_sha = _decode_canonical_document(
        request["runtimeManifestCanonicalJsonBase64"],
        maximum_bytes=256 * 1024,
        description="eSpeak runtime manifest",
    )
    _validate_data_manifest(data_manifest)
    _validate_runtime_manifest(runtime_manifest)
    if (
        data_sha != request["espeakDataManifestSha256"]
        or runtime_sha != request["espeakRuntimeManifestSha256"]
        or runtime_manifest["espeakDataManifestSha256"] != data_sha
        or runtime_manifest["ipaVocabularySha256"] != request["ipaVocabularySha256"]
        or runtime_manifest["normalizationPolicySha256"] != request["normalizationPolicySha256"]
        or _expect_dict(runtime_manifest["executable"], {"logicalName", "mode", "sizeBytes", "sha256"}, "runtime executable")["sha256"]
        != request["espeakBinarySha256"]
    ):
        raise G2pError("German G2P authority-manifest binding mismatch")
    request["targetText"] = normalized
    return request, data_manifest, runtime_manifest, source_sha, normalized_sha


def _verify_runtime_file(path: Path, expected: dict[str, object], logical_name: str) -> int:
    actual, descriptor = _capture_regular_file(path, logical_name)
    if actual != expected:
        os.close(descriptor)
        raise G2pError(f"Installed runtime authority differs: {logical_name}")
    return descriptor


def _open_elf_loader_authorities(
    runtime_manifest: dict[str, object],
) -> tuple[list[tuple[Path, dict[str, object], int]], int]:
    loader_policy = runtime_manifest["loaderPolicy"]
    elf_closure = runtime_manifest["elfClosure"]
    assert isinstance(loader_policy, dict) and isinstance(elf_closure, dict)
    authorities: list[dict[str, object]] = []
    for key in ("ldconfig", "cache"):
        item = loader_policy[key]
        assert isinstance(item, dict)
        authorities.append(item)
    preload = loader_policy["preload"]
    assert isinstance(preload, dict)
    configuration = preload["configuration"]
    if configuration is None:
        if os.path.lexists(LD_PRELOAD_PATH):
            raise G2pError("Unexpected ld.so preload authority is present")
    else:
        assert isinstance(configuration, dict)
        if configuration["path"] != str(LD_PRELOAD_PATH):
            raise G2pError("ld.so preload authority uses an unexpected path")
        authorities.append(configuration)
    objects = elf_closure["objects"]
    assert isinstance(objects, list)
    authorities.extend(item for item in objects if isinstance(item, dict))

    expected_by_path: dict[str, dict[str, object]] = {}
    for expected in authorities:
        path = str(expected["path"])
        prior = expected_by_path.get(path)
        if prior is not None and {
            key: prior[key] for key in ("path", "mode", "sizeBytes", "sha256")
        } != {
            key: expected[key] for key in ("path", "mode", "sizeBytes", "sha256")
        }:
            raise G2pError("ELF loader authority has contradictory file records")
        expected_by_path[path] = expected

    held: list[tuple[Path, dict[str, object], int]] = []
    try:
        for path_text in sorted(expected_by_path):
            expected = expected_by_path[path_text]
            path = Path(path_text)
            actual, descriptor = _capture_regular_file(path, path_text)
            comparable = {
                "path": path_text,
                "mode": int(str(actual["mode"]), 8),
                "sizeBytes": actual["sizeBytes"],
                "sha256": actual["sha256"],
            }
            expected_comparable = {
                key: expected[key] for key in ("path", "mode", "sizeBytes", "sha256")
            }
            if comparable != expected_comparable:
                os.close(descriptor)
                raise G2pError(f"Installed ELF loader authority differs: {path_text}")
            held.append((path, expected, descriptor))
        ldconfig_path = str(loader_policy["ldconfig"]["path"])
        ldconfig_fd = next(
            descriptor for path, _expected, descriptor in held if str(path) == ldconfig_path
        )
        return held, ldconfig_fd
    except Exception:
        for _path, _expected, descriptor in held:
            os.close(descriptor)
        raise


def _verify_held_elf_loader_authorities(
    held: list[tuple[Path, dict[str, object], int]],
    runtime_manifest: dict[str, object],
) -> None:
    for path, expected, descriptor in held:
        _verify_held_authority(
            path,
            descriptor,
            expected_mode=int(expected["mode"]),
            expected_size=int(expected["sizeBytes"]),
            expected_sha256=str(expected["sha256"]),
            label="ELF loader authority",
        )
    loader_policy = runtime_manifest["loaderPolicy"]
    assert isinstance(loader_policy, dict)
    preload = loader_policy["preload"]
    assert isinstance(preload, dict)
    if (preload["configuration"] is None) != (not os.path.lexists(LD_PRELOAD_PATH)):
        raise G2pError("ld.so preload presence changed during generation")


def _verify_held_authority(
    path: Path,
    descriptor: int,
    *,
    expected_mode: int,
    expected_size: int,
    expected_sha256: str,
    label: str,
) -> None:
    before = os.fstat(descriptor)
    current_before = path.lstat()
    if not _same_revision(before, current_before):
        raise G2pError(f"Held {label} path binding changed")
    os.lseek(descriptor, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_TREE_BYTES:
            raise G2pError(f"Held {label} exceeds its fixed bound")
        digest.update(chunk)
    after = os.fstat(descriptor)
    current_after = path.lstat()
    if (
        not _same_revision(before, after)
        or not _same_revision(after, current_after)
        or not stat.S_ISREG(after.st_mode)
        or after.st_nlink != 1
        or after.st_uid != 0
        or after.st_gid != 0
        or stat.S_IMODE(after.st_mode) != expected_mode
        or size != expected_size
        or digest.hexdigest() != expected_sha256
    ):
        raise G2pError(f"Held {label} changed during generation")


def _verify_held_runtime_authority(
    path: Path,
    expected: dict[str, object],
    descriptor: int,
    label: str,
) -> None:
    _verify_held_authority(
        path,
        descriptor,
        expected_mode=int(str(expected["mode"]), 8),
        expected_size=int(expected["sizeBytes"]),
        expected_sha256=str(expected["sha256"]),
        label=label,
    )


def _execute(request: dict[str, object], data_manifest: dict[str, object], runtime_manifest: dict[str, object], normalized_sha: str) -> dict[str, object]:
    captured_before = _capture_data_manifest()
    if _canonical_json(captured_before) != _canonical_json(data_manifest):
        raise G2pError("Installed eSpeak data tree differs from its manifest")
    executable_fd = -1
    vocab_fd = -1
    other_descriptors: list[tuple[Path, dict[str, object], int, str]] = []
    elf_loader_authorities: list[tuple[Path, dict[str, object], int]] = []
    try:
        elf_loader_authorities, ldconfig_fd = _open_elf_loader_authorities(runtime_manifest)
        executable_expected = _expect_dict(
            runtime_manifest["executable"],
            {"logicalName", "mode", "sizeBytes", "sha256"},
            "runtime executable",
        )
        executable_fd = _verify_runtime_file(ESPEAK_PATH, executable_expected, "espeak-ng")
        vocab_expected = {
            "logicalName": "IPA-vocabulary",
            "mode": "0444",
            "sizeBytes": IPA_VOCABULARY_SIZE_BYTES,
            "sha256": IPA_VOCABULARY_SHA256,
        }
        vocab_fd = _verify_runtime_file(VOCAB_PATH, vocab_expected, "IPA-vocabulary")
        locale_paths = (
            Path("/usr/lib/locale/C.utf8/LC_CTYPE"),
            Path("/etc/locale.alias"),
            Path("/usr/lib/locale/locale-archive"),
        )
        locale_expected = runtime_manifest["localeFiles"]
        assert isinstance(locale_expected, list)
        for path, expected, name in zip(
            locale_paths,
            locale_expected,
            ("C.utf8-LC_CTYPE", "locale-alias", "locale-archive"),
            strict=True,
        ):
            assert isinstance(expected, dict)
            other_descriptors.append((
                path,
                expected,
                _verify_runtime_file(path, expected, name),
                name,
            ))
        license_paths = (
            Path("/usr/share/doc/espeak-ng/copyright"),
            Path("/usr/share/common-licenses/GPL-3"),
        )
        license_expected = runtime_manifest["licenseFiles"]
        assert isinstance(license_expected, list)
        for path, expected, name in zip(
            license_paths,
            license_expected,
            ("espeak-ng-debian-copyright", "gnu-gpl-3-license"),
            strict=True,
        ):
            assert isinstance(expected, dict)
            other_descriptors.append((
                path,
                expected,
                _verify_runtime_file(path, expected, name),
                name,
            ))
        vocabulary = _load_vocabulary(vocab_fd)
        loader_status, loader_stdout, loader_stderr = _run_bounded(
            ldconfig_fd,
            ("-p", "-C", "/etc/ld.so.cache"),
            b"",
            maximum_stdout_bytes=16 * 1024 * 1024,
            maximum_stderr_bytes=MAX_STDERR_BYTES,
        )
        loader_policy = runtime_manifest["loaderPolicy"]
        assert isinstance(loader_policy, dict)
        if (
            loader_status != 0
            or loader_stderr
            or _sha256(loader_stdout) != loader_policy["outputSha256"]
        ):
            raise G2pError("Installed loader cache inventory differs")
        version_status, version_stdout, version_stderr = _run_bounded(
            executable_fd,
            ("--version",),
            b"",
            maximum_stdout_bytes=64 * 1024,
            maximum_stderr_bytes=MAX_STDERR_BYTES,
        )
        version_expected = _expect_dict(
            runtime_manifest["versionProbe"],
            {"arguments", "exitCode", "stdoutSha256", "stderrSha256"},
            "version probe",
        )
        if (
            version_status != 0
            or version_stderr
            or _sha256(version_stdout) != version_expected["stdoutSha256"]
            or _sha256(version_stderr) != version_expected["stderrSha256"]
        ):
            raise G2pError("Installed eSpeak version probe differs")
        normalized_text = _expect_str(request["targetText"], "normalized target", maximum=MAX_INPUT_BYTES)
        status, stdout, stderr = _run_bounded(
            executable_fd,
            ESPEAK_ARGS,
            normalized_text.encode("utf-8"),
            maximum_stdout_bytes=MAX_OUTPUT_BYTES,
            maximum_stderr_bytes=MAX_STDERR_BYTES,
        )
        if status != 0 or stderr:
            raise G2pError("Pinned eSpeak returned a non-clean execution")
        tokens = _reference_tokens(stdout, vocabulary)
        captured_after = _capture_data_manifest()
        if _canonical_json(captured_after) != _canonical_json(data_manifest):
            raise G2pError("eSpeak data tree changed during generation")
        _verify_held_elf_loader_authorities(elf_loader_authorities, runtime_manifest)
        _verify_held_runtime_authority(
            ESPEAK_PATH, executable_expected, executable_fd, "eSpeak executable",
        )
        _verify_held_runtime_authority(
            VOCAB_PATH, vocab_expected, vocab_fd, "IPA vocabulary",
        )
        for path, expected, descriptor, name in other_descriptors:
            _verify_held_runtime_authority(path, expected, descriptor, name)
        return {
            "schemaVersion": RESULT_SCHEMA,
            "status": "generated",
            "locale": "de-DE",
            "targetTextSha256": request["targetTextSha256"],
            "normalizedTargetTextSha256": normalized_sha,
            "g2pRunnerSha256": request["g2pRunnerSha256"],
            "espeakBinarySha256": request["espeakBinarySha256"],
            "espeakDataManifestSha256": request["espeakDataManifestSha256"],
            "espeakRuntimeManifestSha256": request["espeakRuntimeManifestSha256"],
            "ipaVocabularySha256": request["ipaVocabularySha256"],
            "normalizationPolicySha256": request["normalizationPolicySha256"],
            "espeakStdoutSha256": _sha256(stdout),
            "tokenization": "espeak-reference-ipa-token-sequence.v1",
            "referenceIpaTokens": tokens,
        }
    finally:
        for descriptor in [
            executable_fd,
            vocab_fd,
            *(descriptor for _path, _expected, descriptor, _name in other_descriptors),
            *(descriptor for _path, _expected, descriptor in elf_loader_authorities),
        ]:
            if descriptor < 0:
                continue
            try:
                os.close(descriptor)
            except OSError:
                pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate pinned German eSpeak reference IPA tokens without a quality decision."
    )
    return parser


def main() -> int:
    _parser().parse_args()
    content = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not content or len(content) > MAX_REQUEST_BYTES:
        raise G2pError("German G2P request is empty or oversized")
    raw_request = _strict_json_loads(content, description="German G2P request")
    if _canonical_json(raw_request).encode("utf-8") != content:
        raise G2pError("German G2P request is not canonical JSON")
    request, data_manifest, runtime_manifest, _source_sha, normalized_sha = _validate_request(raw_request)
    result = _execute(request, data_manifest, runtime_manifest, normalized_sha)
    sys.stdout.buffer.write(_canonical_json(result).encode("utf-8"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except G2pError as error:
        message = str(error).replace("\n", " ")[:500]
        print(f"German G2P failed: {message}", file=sys.stderr)
        raise SystemExit(2) from None
