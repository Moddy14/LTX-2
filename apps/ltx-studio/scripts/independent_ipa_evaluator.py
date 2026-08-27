#!/usr/bin/env python3
"""Target-independent free IPA observation with the pinned Meta XLSR model.

The request schema intentionally has no target text, word list, or candidate
phoneme sequence. Comparison with expected speech belongs to a separate,
hash-bound adjudicator.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import io
import json
import math
import os
import socket
import stat
import sys
import wave
from pathlib import Path
from typing import BinaryIO


REQUEST_SCHEMA = "ltx-studio-independent-ipa-request.v1"
RESULT_SCHEMA = "ltx-studio-independent-ipa-observation.v1"
METHOD = "xlsr53-espeak-cv-free-ctc-greedy.v1"
MODEL_REPOSITORY = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
MODEL_REVISION = "2c733782da5604684829819a5eb744c193fe9398"
SOURCE_WEIGHT_SHA256 = "04366b6c8d24099ef313cf02f0e58d26f5dddfda16edbfc8eb2c713d94a9f551"
EXPECTED_PYTHON_VERSION = "3.12.3"
EXPECTED_TORCH_VERSION = "2.13.0+cu132"
EXPECTED_TRANSFORMERS_VERSION = "5.14.1"
EXPECTED_SAFETENSORS_VERSION = "0.8.0"
APPROVED_MODEL_MANIFEST_SHA256 = "c401b4ecc2fe774a90e5c2acd6cfcb0bde5465e6c4672f2e5ef2574b47c264a0"
APPROVED_MODEL_WEIGHT_SHA256 = "cd23ca5a57a252ee44abfea3b06d28020285015b83b8bb0e59293193ef8c2bd4"
APPROVED_CONVERTER_SHA256 = "f76c51f1b535deb913a03ae940ce1c124e65c6f3d48228f35d2050f8a92fb1bd"
DECODER_POLICY = "ctc-collapse-runs-then-remove-blank.v1"

PINNED_AUXILIARY_FILES = {
    "config.json": "4609fb49b7e1d28aecb2840da1926c40bd915bc6f1120a940afacf7159bbfb13",
    "preprocessor_config.json": "a2254a5b58f72cd4de3632f8eee64f3f098b7c1402128d2f419e7d00ae13e335",
    "special_tokens_map.json": "bb7068de1150661a10b55f9e4b12a0e77af8bf91f5e45e1b58afaf1d0e17f675",
    "tokenizer_config.json": "d663833dacef7d29f563e23029d448fe41415dbe5e8e6d5a98b598a5258c18d8",
    "vocab.json": "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0",
}

MODEL_MANIFEST_NAME = "conversion-manifest.v1.json"
MODEL_WEIGHT_NAME = "model.safetensors"
MODEL_DIRECTORY_FILES = {
    MODEL_MANIFEST_NAME,
    MODEL_WEIGHT_NAME,
    *PINNED_AUXILIARY_FILES.keys(),
}

MAX_REQUEST_BYTES = 32 * 1024
MAX_RESULT_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 1024 * 1024
MAX_MODEL_WEIGHT_BYTES = 2 * 1024 * 1024 * 1024
MIN_SAMPLES = 1_600
MAX_SAMPLES = 336_000
SAMPLE_RATE_HZ = 16_000
EXPECTED_CGROUP_MEMORY_BYTES = 8 * 1024**3
MIN_CGROUP_HEADROOM_BYTES = 6 * 1024**3
EXPECTED_CGROUP_PIDS = 64
EXPECTED_CGROUP_CPU_MAX = "200000 100000"
HASH_CHUNK_BYTES = 8 * 1024 * 1024


class EvaluationError(RuntimeError):
    """The independent observation contract was not satisfied."""


def _strict_json_loads(content: bytes, *, description: str) -> object:
    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise EvaluationError(f"Duplicate JSON key in {description}: {key}")
            value[key] = item
        return value

    def reject_constant(value: str) -> object:
        raise EvaluationError(f"Non-finite JSON number in {description}: {value}")

    try:
        return json.loads(
            content,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvaluationError(f"Invalid UTF-8 JSON in {description}") from error


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def _open_regular(path: Path, *, max_bytes: int) -> tuple[BinaryIO, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise EvaluationError(f"Cannot open bound regular file {path.name}: {error}") from error
    handle = os.fdopen(descriptor, "rb", closefd=True)
    before = os.fstat(handle.fileno())
    if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > max_bytes:
        handle.close()
        raise EvaluationError(f"Bound file has invalid type or size: {path.name}")
    return handle, before


def _read_stable_regular(path: Path, *, max_bytes: int, expected_sha256: str) -> bytes:
    handle, before = _open_regular(path, max_bytes=max_bytes)
    try:
        content = handle.read(max_bytes + 1)
        after = os.fstat(handle.fileno())
        if _stat_identity(after) != _stat_identity(before) or len(content) != before.st_size:
            raise EvaluationError(f"Bound file changed while reading: {path.name}")
        digest = hashlib.sha256(content).hexdigest()
        if digest != expected_sha256:
            raise EvaluationError(f"Bound file hash mismatch: {path.name}")
        return content
    finally:
        handle.close()


def _hash_stable_regular(path: Path, *, max_bytes: int, expected_sha256: str) -> int:
    handle, before = _open_regular(path, max_bytes=max_bytes)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = handle.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(handle.fileno())
        if _stat_identity(after) != _stat_identity(before):
            raise EvaluationError(f"Bound file changed while hashing: {path.name}")
        if digest.hexdigest() != expected_sha256:
            raise EvaluationError(f"Bound file hash mismatch: {path.name}")
        return before.st_size
    finally:
        handle.close()


def _sha256_stable_regular(path: Path, *, max_bytes: int) -> str:
    handle, before = _open_regular(path, max_bytes=max_bytes)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = handle.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(handle.fileno())
        if _stat_identity(after) != _stat_identity(before):
            raise EvaluationError(f"Bound file changed while hashing: {path.name}")
        return digest.hexdigest()
    finally:
        handle.close()


def _read_request() -> dict[str, str]:
    payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not payload or len(payload) > MAX_REQUEST_BYTES:
        raise EvaluationError("Request is empty or too large")
    try:
        value = _strict_json_loads(payload, description="request")
    except EvaluationError:
        raise
    expected_keys = {
        "schemaVersion",
        "audioPath",
        "audioSha256",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise EvaluationError("Request fields differ from the target-independent schema")
    if value.get("schemaVersion") != REQUEST_SCHEMA:
        raise EvaluationError("Unsupported request schema")
    for key in expected_keys - {"schemaVersion"}:
        if not isinstance(value.get(key), str) or not value[key]:
            raise EvaluationError(f"Request field must be a non-empty string: {key}")
    for key in ("audioSha256",):
        if len(value[key]) != 64 or any(char not in "0123456789abcdef" for char in value[key]):
            raise EvaluationError(f"Request field must be a lowercase SHA-256: {key}")
    return value


def _read_cgroup_limit(name: str) -> str:
    line = next(
        (item for item in Path("/proc/self/cgroup").read_text().splitlines() if item.startswith("0::")),
        None,
    )
    if line is None:
        raise EvaluationError("Unified cgroup-v2 membership is unavailable")
    relative = line.split("::", 1)[1].lstrip("/")
    return (Path("/sys/fs/cgroup") / relative / name).read_text().strip()


def _verify_execution_boundary() -> dict[str, object]:
    if not sys.flags.isolated or sys.version.split()[0] != EXPECTED_PYTHON_VERSION:
        raise EvaluationError("Runner requires the pinned isolated Python runtime")
    if os.environ.get("CUDA_VISIBLE_DEVICES") != "":
        raise EvaluationError("CUDA_VISIBLE_DEVICES must be empty")
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        raise EvaluationError("Offline model modes are required")
    if os.getuid() == 0 or os.geteuid() == 0 or os.getuid() != os.geteuid():
        raise EvaluationError("Runner requires one stable non-root DynamicUser identity")

    for family, label in ((socket.AF_INET, "AF_INET"), (socket.AF_INET6, "AF_INET6")):
        candidate: socket.socket | None = None
        try:
            candidate = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            if error.errno != errno.EAFNOSUPPORT:
                raise EvaluationError(
                    f"{label} socket creation failed with unexpected errno: {error.errno}",
                ) from error
        else:
            raise EvaluationError(f"{label} socket creation must be blocked")
        finally:
            if candidate is not None:
                candidate.close()

    no_new_privileges = next(
        (
            line.split()[1]
            for line in Path("/proc/self/status").read_text().splitlines()
            if line.startswith("NoNewPrivs:")
        ),
        None,
    )
    if no_new_privileges != "1":
        raise EvaluationError("NoNewPrivileges must be enabled")
    effective_capabilities = next(
        (
            line.split()[1]
            for line in Path("/proc/self/status").read_text().splitlines()
            if line.startswith("CapEff:")
        ),
        None,
    )
    if effective_capabilities is None or int(effective_capabilities, 16) != 0:
        raise EvaluationError("Effective Linux capabilities must be empty")

    memory_max = _read_cgroup_limit("memory.max")
    memory_current = _read_cgroup_limit("memory.current")
    swap_max = _read_cgroup_limit("memory.swap.max")
    pids_max = _read_cgroup_limit("pids.max")
    cpu_max = _read_cgroup_limit("cpu.max")
    if memory_max == "max" or int(memory_max) != EXPECTED_CGROUP_MEMORY_BYTES:
        raise EvaluationError("Runner memory.max must equal the approved 8 GiB limit")
    if int(memory_max) - int(memory_current) < MIN_CGROUP_HEADROOM_BYTES:
        raise EvaluationError("Runner has less than 6 GiB cgroup memory headroom")
    if swap_max != "0":
        raise EvaluationError("Runner memory.swap.max must be zero")
    if pids_max == "max" or int(pids_max) != EXPECTED_CGROUP_PIDS:
        raise EvaluationError("Runner pids.max must equal the approved 64-process limit")
    if cpu_max != EXPECTED_CGROUP_CPU_MAX:
        raise EvaluationError("Runner CPUQuota must equal the approved 200 percent limit")
    return {
        "cpuOnly": True,
        "ipSocketFamiliesBlocked": ["AF_INET", "AF_INET6"],
        "blockedNetworkErrno": errno.EAFNOSUPPORT,
        "noNewPrivileges": True,
        "effectiveCapabilities": "0000000000000000",
        "memoryMaxBytes": EXPECTED_CGROUP_MEMORY_BYTES,
        "minimumCgroupHeadroomBytes": MIN_CGROUP_HEADROOM_BYTES,
        "swapMaxBytes": 0,
        "pidsMax": EXPECTED_CGROUP_PIDS,
        "cpuMax": EXPECTED_CGROUP_CPU_MAX,
    }


def _is_lower_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _validate_model_directory(
    directory: Path,
) -> tuple[Path, dict[str, object], dict[str, object], dict[str, object], dict[str, int]]:
    if not _is_lower_sha256(APPROVED_MODEL_MANIFEST_SHA256) or not _is_lower_sha256(
        APPROVED_MODEL_WEIGHT_SHA256,
    ) or not _is_lower_sha256(APPROVED_CONVERTER_SHA256):
        raise EvaluationError("Independent IPA model authority is not provisioned")
    directory_stat = directory.stat(follow_symlinks=False)
    if (
        not stat.S_ISDIR(directory_stat.st_mode)
        or directory_stat.st_uid != 0
        or directory_stat.st_mode & 0o222
    ):
        raise EvaluationError("Model directory must be root-owned and non-writable")
    if {child.name for child in directory.iterdir()} != MODEL_DIRECTORY_FILES:
        raise EvaluationError("Model directory inventory differs from the sealed contract")
    for child in directory.iterdir():
        child_stat = child.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(child_stat.st_mode)
            or child_stat.st_uid != 0
            or child_stat.st_mode & 0o222
        ):
            raise EvaluationError(f"Model artifact is not root-owned and non-writable: {child.name}")

    manifest_bytes = _read_stable_regular(
        directory / MODEL_MANIFEST_NAME,
        max_bytes=256 * 1024,
        expected_sha256=APPROVED_MODEL_MANIFEST_SHA256,
    )
    manifest = _strict_json_loads(manifest_bytes, description="conversion manifest")
    if not isinstance(manifest, dict) or set(manifest) != {"schemaVersion", "source", "output", "converter"}:
        raise EvaluationError("Model conversion manifest fields are invalid")
    if manifest.get("schemaVersion") != "ltx-studio-xlsr-phoneme-conversion.v1":
        raise EvaluationError("Model conversion manifest schema is invalid")

    source = manifest.get("source")
    output = manifest.get("output")
    converter = manifest.get("converter")
    if not isinstance(source, dict) or not isinstance(output, dict) or not isinstance(converter, dict):
        raise EvaluationError("Model conversion manifest sections are invalid")
    if (
        set(source) != {"repository", "revision", "weight", "auxiliarySha256"}
        or set(output) != {"weight", "auxiliarySha256"}
        or set(converter)
        != {
            "scriptSha256",
            "python",
            "torch",
            "safetensors",
            "transformers",
            "weightsOnly",
            "sourceDescriptorBound",
            "sourceSecondHashVerified",
            "stateKeyMigration",
            "roundtripLoader",
            "roundtripExact",
            "threads",
            "executionBoundary",
        }
    ):
        raise EvaluationError("Model conversion manifest nested fields are invalid")
    source_weight = source.get("weight")
    output_weight = output.get("weight")
    if (
        source.get("repository") != MODEL_REPOSITORY
        or source.get("revision") != MODEL_REVISION
        or source.get("auxiliarySha256") != PINNED_AUXILIARY_FILES
        or not isinstance(source_weight, dict)
        or set(source_weight) != {"name", "sizeBytes", "sha256"}
        or source_weight.get("name") != "pytorch_model.bin"
        or source_weight.get("sizeBytes") != 1_263_535_127
        or source_weight.get("sha256") != SOURCE_WEIGHT_SHA256
        or not isinstance(output_weight, dict)
        or set(output_weight)
        != {
            "name",
            "sizeBytes",
            "sha256",
            "tensorCount",
            "totalNumel",
            "tensorInventorySha256",
            "tensorContentInventorySha256",
            "tensorContentVerified",
        }
        or output_weight.get("name") != MODEL_WEIGHT_NAME
    ):
        raise EvaluationError("Model conversion provenance does not match the pinned source")
    output_weight_sha256 = output_weight.get("sha256")
    output_weight_size = output_weight.get("sizeBytes")
    if (
        not isinstance(output_weight_sha256, str)
        or len(output_weight_sha256) != 64
        or output_weight_sha256 != APPROVED_MODEL_WEIGHT_SHA256
        or not isinstance(output_weight_size, int)
        or output_weight_size <= 0
        or output_weight_size > MAX_MODEL_WEIGHT_BYTES
        or not isinstance(output_weight.get("tensorCount"), int)
        or not 0 < output_weight["tensorCount"] <= 10_000
        or not isinstance(output_weight.get("totalNumel"), int)
        or not 0 < output_weight["totalNumel"] <= 500_000_000
        or not _is_lower_sha256(output_weight.get("tensorInventorySha256"))
        or not _is_lower_sha256(output_weight.get("tensorContentInventorySha256"))
        or output_weight.get("tensorContentVerified") is not True
    ):
        raise EvaluationError("Converted weight declaration is invalid")
    if output.get("auxiliarySha256") != PINNED_AUXILIARY_FILES:
        raise EvaluationError("Converted auxiliary hashes differ from the pinned source")
    if (
        converter.get("scriptSha256") != APPROVED_CONVERTER_SHA256
        or converter.get("python") != EXPECTED_PYTHON_VERSION
        or converter.get("torch") != EXPECTED_TORCH_VERSION
        or converter.get("transformers") != EXPECTED_TRANSFORMERS_VERSION
        or converter.get("safetensors") != EXPECTED_SAFETENSORS_VERSION
        or converter.get("weightsOnly") is not True
        or converter.get("sourceDescriptorBound") is not True
        or converter.get("sourceSecondHashVerified") is not True
        or converter.get("stateKeyMigration")
        != "deferred-to-pinned-Wav2Vec2ForCTC.from_pretrained"
        or converter.get("roundtripLoader") != "Wav2Vec2ForCTC.from_pretrained"
        or converter.get("roundtripExact") is not True
        or converter.get("threads") != 2
    ):
        raise EvaluationError("Converter runtime or source-binding contract is invalid")
    expected_conversion_boundary = {
        "isolatedPython": True,
        "ipSocketFamiliesBlocked": ["AF_INET", "AF_INET6"],
        "blockedNetworkErrno": errno.EAFNOSUPPORT,
        "noNewPrivileges": True,
        "effectiveCapabilities": "0000000000000000",
        "cudaVisibleDevices": "",
        "memoryMaxBytes": 8 * 1024**3,
        "minimumCgroupHeadroomBytes": 6 * 1024**3,
        "swapMaxBytes": 0,
        "pidsMax": 64,
        "cpuMax": "200000 100000",
        "minimumAvailableMemoryBytes": 8 * 1024**3,
        "minimumFreeSwapBytes": 8 * 1024**3,
        "minimumFreeDiskBytes": 3_063_941_166,
    }
    if converter.get("executionBoundary") != expected_conversion_boundary:
        raise EvaluationError("Converter execution boundary differs from the approved contract")

    actual_size = _hash_stable_regular(
        directory / MODEL_WEIGHT_NAME,
        max_bytes=MAX_MODEL_WEIGHT_BYTES,
        expected_sha256=output_weight_sha256,
    )
    if actual_size != output_weight_size:
        raise EvaluationError("Converted weight size differs from its manifest")
    auxiliary_content: dict[str, bytes] = {}
    for name, expected_sha256 in PINNED_AUXILIARY_FILES.items():
        auxiliary_content[name] = _read_stable_regular(
            directory / name,
            max_bytes=MAX_AUDIO_BYTES,
            expected_sha256=expected_sha256,
        )
    config_value = _strict_json_loads(auxiliary_content["config.json"], description="config.json")
    preprocessor_value = _strict_json_loads(
        auxiliary_content["preprocessor_config.json"],
        description="preprocessor_config.json",
    )
    vocab_value = _strict_json_loads(auxiliary_content["vocab.json"], description="vocab.json")
    if (
        not isinstance(config_value, dict)
        or config_value.get("model_type") != "wav2vec2"
        or config_value.get("architectures") != ["Wav2Vec2ForCTC"]
        or config_value.get("vocab_size") != 392
        or config_value.get("pad_token_id") != 0
        or config_value.get("bos_token_id") != 1
        or config_value.get("eos_token_id") != 2
    ):
        raise EvaluationError("Pinned Wav2Vec2 configuration is invalid")
    if (
        not isinstance(preprocessor_value, dict)
        or preprocessor_value.get("feature_extractor_type") != "Wav2Vec2FeatureExtractor"
        or preprocessor_value.get("sampling_rate") != SAMPLE_RATE_HZ
        or preprocessor_value.get("feature_size") != 1
        or preprocessor_value.get("do_normalize") is not True
        or preprocessor_value.get("return_attention_mask") is not True
    ):
        raise EvaluationError("Pinned Wav2Vec2 preprocessor is invalid")
    if (
        not isinstance(vocab_value, dict)
        or len(vocab_value) != 392
        or any(not isinstance(key, str) or not isinstance(value, int) for key, value in vocab_value.items())
        or set(vocab_value.values()) != set(range(392))
        or vocab_value.get("<pad>") != 0
        or vocab_value.get("<s>") != 1
        or vocab_value.get("</s>") != 2
        or vocab_value.get("<unk>") != 3
    ):
        raise EvaluationError("Pinned Wav2Vec2 vocabulary is invalid")
    return directory, manifest, config_value, preprocessor_value, vocab_value


def _read_pcm_audio(path_value: str, expected_sha256: str) -> tuple[object, dict[str, object]]:
    audio_bytes = _read_stable_regular(
        Path(path_value),
        max_bytes=MAX_AUDIO_BYTES,
        expected_sha256=expected_sha256,
    )
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frame_count = source.getnframes()
            compression = source.getcomptype()
            frames = source.readframes(frame_count)
    except (wave.Error, EOFError) as error:
        raise EvaluationError("Audio is not a valid PCM WAV") from error
    if (
        channels != 1
        or sample_width != 2
        or sample_rate != SAMPLE_RATE_HZ
        or compression != "NONE"
        or frame_count < MIN_SAMPLES
        or frame_count > MAX_SAMPLES
        or len(frames) != frame_count * 2
    ):
        raise EvaluationError("Audio must be mono PCM-S16LE at 16 kHz and 0.1-21.0 seconds")

    import numpy as np  # noqa: PLC0415

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return samples, {
        "sha256": expected_sha256,
        "sampleRateHz": SAMPLE_RATE_HZ,
        "channels": 1,
        "sampleCount": frame_count,
        "durationMilliseconds": round(frame_count * 1000 / SAMPLE_RATE_HZ),
    }


def _convolution_geometry(config: object) -> tuple[int, int]:
    jump = 1
    receptive_field = 1
    for kernel, stride in zip(config.conv_kernel, config.conv_stride, strict=True):
        receptive_field += (int(kernel) - 1) * jump
        jump *= int(stride)
    return jump, receptive_field


def _percentile(values: list[float], probability: float) -> float:
    if not values:
        raise EvaluationError("Cannot summarize an empty posterior run")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - position) + ordered[high] * (position - low)


def _collapse_ctc_runs(frame_ids: list[int]) -> list[tuple[int, int, int]]:
    runs: list[tuple[int, int, int]] = []
    start = 0
    while start < len(frame_ids):
        token_id = int(frame_ids[start])
        end = start + 1
        while end < len(frame_ids) and int(frame_ids[end]) == token_id:
            end += 1
        runs.append((token_id, start, end))
        start = end
    return runs


def _decode_ctc_runs(frame_ids: list[int], blank_id: int) -> list[tuple[int, int, int]]:
    return [run for run in _collapse_ctc_runs(frame_ids) if run[0] != blank_id]


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def _torch_dtype_to_safetensors(dtype: object) -> str:
    mapping = {
        "torch.bool": "BOOL",
        "torch.uint8": "U8",
        "torch.int8": "I8",
        "torch.int16": "I16",
        "torch.int32": "I32",
        "torch.int64": "I64",
        "torch.float16": "F16",
        "torch.bfloat16": "BF16",
        "torch.float32": "F32",
        "torch.float64": "F64",
    }
    token = mapping.get(str(dtype))
    if token is None:
        raise EvaluationError(f"Unsupported tensor dtype in sealed model: {dtype}")
    return token


def _tensor_content_sha256(tensor: object) -> str:
    import torch  # noqa: PLC0415

    if not isinstance(tensor, torch.Tensor):
        raise EvaluationError("Sealed model contained a non-tensor value")
    contiguous = tensor.detach().contiguous().view(torch.uint8).numpy()
    view = memoryview(contiguous).cast("B")
    digest = hashlib.sha256()
    for offset in range(0, len(view), HASH_CHUNK_BYTES):
        digest.update(view[offset : offset + HASH_CHUNK_BYTES])
    return digest.hexdigest()


def _observe(request: dict[str, str], model_directory_argument: Path) -> dict[str, object]:
    boundary = _verify_execution_boundary()
    runner_sha256 = _sha256_stable_regular(Path(__file__), max_bytes=1024 * 1024)
    model_directory, manifest, config_value, preprocessor_value, vocab = _validate_model_directory(
        model_directory_argument,
    )
    samples, audio_summary = _read_pcm_audio(request["audioPath"], request["audioSha256"])

    import torch  # noqa: PLC0415
    import safetensors  # noqa: PLC0415
    import transformers  # noqa: PLC0415
    from safetensors import safe_open  # noqa: PLC0415
    from transformers import Wav2Vec2Config, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC  # noqa: PLC0415

    if (
        torch.__version__ != EXPECTED_TORCH_VERSION
        or transformers.__version__ != EXPECTED_TRANSFORMERS_VERSION
        or safetensors.__version__ != EXPECTED_SAFETENSORS_VERSION
        or torch.cuda.is_available()
    ):
        raise EvaluationError("Runner libraries or CPU-only state differ from the pinned contract")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)

    config = Wav2Vec2Config.from_dict(config_value)
    feature_extractor_arguments = dict(preprocessor_value)
    feature_extractor_arguments.pop("feature_extractor_type", None)
    feature_extractor = Wav2Vec2FeatureExtractor(**feature_extractor_arguments)
    output_weight = manifest["output"]["weight"]
    tensor_inventory: list[dict[str, object]] = []
    tensor_content_inventory: list[dict[str, object]] = []
    with safe_open(model_directory / MODEL_WEIGHT_NAME, framework="pt", device="cpu") as reader:
        if reader.metadata() != {"format": "pt"}:
            raise EvaluationError("Sealed Safetensors metadata differs from the conversion contract")
        for key in reader.keys():
            tensor_slice = reader.get_slice(key)
            shape = list(tensor_slice.get_shape())
            tensor = reader.get_tensor(key)
            tensor_inventory.append({
                "name": key,
                "dtype": _torch_dtype_to_safetensors(tensor.dtype),
                "shape": shape,
                "numel": tensor.numel(),
            })
            tensor_content_inventory.append({
                "name": key,
                "contentSha256": _tensor_content_sha256(tensor),
            })
            del tensor
    tensor_inventory.sort(key=lambda item: str(item["name"]))
    tensor_content_inventory.sort(key=lambda item: str(item["name"]))
    if (
        len(tensor_inventory) != output_weight["tensorCount"]
        or sum(int(item["numel"]) for item in tensor_inventory) != output_weight["totalNumel"]
        or hashlib.sha256(_canonical_json(tensor_inventory)).hexdigest()
        != output_weight["tensorInventorySha256"]
        or hashlib.sha256(_canonical_json(tensor_content_inventory)).hexdigest()
        != output_weight["tensorContentInventorySha256"]
    ):
        raise EvaluationError("Loaded Safetensors inventory differs from the conversion manifest")
    model, loading_info = Wav2Vec2ForCTC.from_pretrained(
        model_directory,
        config=config,
        local_files_only=True,
        output_loading_info=True,
        use_safetensors=True,
        weights_only=True,
    )
    if not isinstance(loading_info, dict) or set(loading_info) != {
        "missing_keys",
        "unexpected_keys",
        "mismatched_keys",
        "error_msgs",
    } or any(loading_info.values()):
        raise EvaluationError(f"Pinned Wav2Vec2 loading was not exact: {loading_info}")

    inputs = feature_extractor(samples, sampling_rate=SAMPLE_RATE_HZ, return_tensors="pt")
    with torch.inference_mode():
        logits = model(
            inputs.input_values,
            attention_mask=getattr(inputs, "attention_mask", None),
        ).logits[0].float()
        if logits.ndim != 2 or logits.shape[0] <= 0 or logits.shape[1] != 392:
            raise EvaluationError("Model emitted an invalid CTC logit geometry")
        probabilities = torch.softmax(logits, dim=-1)
        top_probability, top_ids = torch.max(probabilities, dim=-1)
        top_two = torch.topk(probabilities, k=2, dim=-1).values
        top_margin = top_two[:, 0] - top_two[:, 1]

    symbols = {value: key for key, value in vocab.items()}
    blank_id = vocab["<pad>"]
    unknown_id = vocab["<unk>"]
    special_ids = {vocab["<s>"], vocab["</s>"]}
    if (
        int(config.pad_token_id) != blank_id
        or int(config.bos_token_id) != vocab["<s>"]
        or int(config.eos_token_id) != vocab["</s>"]
    ):
        raise EvaluationError("Config and vocabulary special-token IDs differ")
    frame_ids = top_ids.tolist()
    frame_posteriors = top_probability.tolist()
    frame_margins = top_margin.tolist()
    tokens: list[dict[str, object]] = []
    unknown_count = 0
    special_count = 0
    decoded_symbols: list[str] = []
    for token_id, start, end in _decode_ctc_runs(frame_ids, blank_id):
        symbol = symbols.get(token_id)
        if symbol is None:
            raise EvaluationError(f"Model emitted an ID outside the pinned vocabulary: {token_id}")
        is_unknown = token_id == unknown_id
        is_special = token_id in special_ids
        unknown_count += int(is_unknown)
        special_count += int(is_special)
        decoded_symbols.append(symbol)
        run_posteriors = [float(value) for value in frame_posteriors[start:end]]
        run_margins = [float(value) for value in frame_margins[start:end]]
        tokens.append({
            "tokenId": token_id,
            "symbol": symbol,
            "startFrame": start,
            "endFrameExclusive": end,
            "medianPosterior": round(_percentile(run_posteriors, 0.5), 8),
            "p10Posterior": round(_percentile(run_posteriors, 0.1), 8),
            "minimumTop1Margin": round(min(run_margins), 8),
            "unknown": is_unknown,
            "special": is_special,
        })

    stride, receptive_field = _convolution_geometry(config)
    model_manifest_sha256 = APPROVED_MODEL_MANIFEST_SHA256
    model_fingerprint = hashlib.sha256(
        (
            f"{METHOD}\0{DECODER_POLICY}\0{runner_sha256}\0{model_manifest_sha256}\0"
            f"{APPROVED_MODEL_WEIGHT_SHA256}\0{EXPECTED_TRANSFORMERS_VERSION}"
        ).encode(),
    ).hexdigest()
    if _sha256_stable_regular(Path(__file__), max_bytes=1024 * 1024) != runner_sha256:
        raise EvaluationError("Independent IPA runner changed during execution")
    _hash_stable_regular(
        model_directory / MODEL_WEIGHT_NAME,
        max_bytes=MAX_MODEL_WEIGHT_BYTES,
        expected_sha256=APPROVED_MODEL_WEIGHT_SHA256,
    )
    blank_frames = sum(int(token_id) == blank_id for token_id in frame_ids)
    result = {
        "schemaVersion": RESULT_SCHEMA,
        "status": "measured",
        "error": None,
        "method": METHOD,
        "decoderPolicy": DECODER_POLICY,
        "targetConditioned": False,
        "runnerSha256": runner_sha256,
        "executionBoundary": boundary,
        "sourceAudio": audio_summary,
        "modelFingerprint": model_fingerprint,
        "modelManifestSha256": model_manifest_sha256,
        "modelWeightSha256": APPROVED_MODEL_WEIGHT_SHA256,
        "runtime": {
            "python": EXPECTED_PYTHON_VERSION,
            "torch": EXPECTED_TORCH_VERSION,
            "transformers": EXPECTED_TRANSFORMERS_VERSION,
            "safetensors": EXPECTED_SAFETENSORS_VERSION,
        },
        "observation": {
            "frameCount": len(frame_ids),
            "outputStrideSamples": stride,
            "receptiveFieldSamples": receptive_field,
            "blankTokenId": blank_id,
            "unknownTokenId": unknown_id,
            "decodedIpa": " ".join(decoded_symbols),
            "unknownTokenCount": unknown_count,
            "specialTokenCount": special_count,
            "blankFrameRatio": round(blank_frames / len(frame_ids), 8),
            "tokens": tokens,
        },
    }
    # Catch NaN/Infinity and bound the one-document transport before printing.
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_RESULT_BYTES:
        raise EvaluationError("Independent IPA observation exceeds the result limit")
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-directory", type=Path, required=True)
    return parser.parse_args()


def _bounded_error(error: BaseException) -> str:
    value = " ".join(str(error).split())
    return value[:500] if value else error.__class__.__name__


def main() -> int:
    arguments = parse_args()
    try:
        result = _observe(_read_request(), arguments.model_directory)
    except Exception as error:
        result = {
            "schemaVersion": RESULT_SCHEMA,
            "status": "failed",
            "error": _bounded_error(error),
            "method": METHOD,
            "targetConditioned": False,
        }
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode()) > MAX_RESULT_BYTES:
            encoded = json.dumps(
                {
                    "schemaVersion": RESULT_SCHEMA,
                    "status": "failed",
                    "error": "Bounded evaluator failure",
                    "method": METHOD,
                    "targetConditioned": False,
                },
                separators=(",", ":"),
            )
        print(encoded)
        return 2
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
