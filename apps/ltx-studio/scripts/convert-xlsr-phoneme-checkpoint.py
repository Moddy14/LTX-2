#!/usr/bin/env python3
"""Convert one reviewed Meta XLSR phoneme checkpoint to sealed Safetensors.

The Hub checkpoint is a PyTorch ZIP/pickle container. This provisioning tool
accepts only the exact reviewed object, loads it from the same O_NOFOLLOW file
descriptor with ``weights_only=True``, verifies it a second time, and publishes
an immutable-by-contract directory only after every artifact is complete.

Run this script with ``python -I`` inside an offline, CPU-only systemd cgroup.
It intentionally refuses an ordinary shell process.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import gc
import hashlib
import json
import os
import secrets
import shutil
import socket
import stat
import sys
import tempfile
from pathlib import Path
from typing import BinaryIO


MODEL_REPOSITORY = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
MODEL_REVISION = "2c733782da5604684829819a5eb744c193fe9398"
SOURCE_WEIGHT_NAME = "pytorch_model.bin"
SOURCE_WEIGHT_SIZE = 1_263_535_127
SOURCE_WEIGHT_SHA256 = "04366b6c8d24099ef313cf02f0e58d26f5dddfda16edbfc8eb2c713d94a9f551"

PINNED_AUXILIARY_FILES = {
    "config.json": "4609fb49b7e1d28aecb2840da1926c40bd915bc6f1120a940afacf7159bbfb13",
    "preprocessor_config.json": "a2254a5b58f72cd4de3632f8eee64f3f098b7c1402128d2f419e7d00ae13e335",
    "special_tokens_map.json": "bb7068de1150661a10b55f9e4b12a0e77af8bf91f5e45e1b58afaf1d0e17f675",
    "tokenizer_config.json": "d663833dacef7d29f563e23029d448fe41415dbe5e8e6d5a98b598a5258c18d8",
    "vocab.json": "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0",
}

EXPECTED_PYTHON_VERSION = "3.12.3"
EXPECTED_TORCH_VERSION = "2.13.0+cu132"
EXPECTED_SAFETENSORS_VERSION = "0.8.0"
EXPECTED_TRANSFORMERS_VERSION = "5.14.1"

OUTPUT_WEIGHT_NAME = "model.safetensors"
OUTPUT_MANIFEST_NAME = "conversion-manifest.v1.json"
MAX_AUXILIARY_BYTES = 128 * 1024
HASH_CHUNK_BYTES = 8 * 1024 * 1024
MIN_AVAILABLE_MEMORY_BYTES = 8 * 1024**3
MIN_FREE_SWAP_BYTES = 8 * 1024**3
MIN_FREE_DISK_BYTES = SOURCE_WEIGHT_SIZE * 2 + 512 * 1024**2
MIN_CGROUP_HEADROOM_BYTES = 6 * 1024**3
EXPECTED_CGROUP_MEMORY_BYTES = 8 * 1024**3
EXPECTED_CGROUP_PIDS = 64
EXPECTED_CGROUP_CPU_MAX = "200000 100000"
MAX_TENSOR_COUNT = 10_000
MAX_TOTAL_NUMEL = 500_000_000
MAX_TENSOR_DIMENSIONS = 8
MAX_TENSOR_AXIS = 2_000_000
RENAME_NOREPLACE = 1


class ConversionError(RuntimeError):
    """The reviewed checkpoint or execution contract was not satisfied."""


class PublishedDurabilityUnknown(ConversionError):
    """Publication succeeded, but the parent directory durability sync failed."""

    def __init__(self, output_directory: Path, message: str):
        super().__init__(message)
        self.output_directory = output_directory


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def _directory_identity(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def _sha256_stream(handle: BinaryIO) -> str:
    digest = hashlib.sha256()
    while True:
        chunk = handle.read(HASH_CHUNK_BYTES)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)


def _open_regular_file(path: Path) -> tuple[BinaryIO, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ConversionError(f"Cannot open regular file {path.name}: {error}") from error
    handle = os.fdopen(descriptor, "rb", closefd=True)
    before = os.fstat(handle.fileno())
    if not stat.S_ISREG(before.st_mode):
        handle.close()
        raise ConversionError(f"File is not regular: {path.name}")
    return handle, before


def _hash_open_file(handle: BinaryIO) -> tuple[str, os.stat_result]:
    handle.seek(0)
    digest = _sha256_stream(handle)
    after = os.fstat(handle.fileno())
    handle.seek(0)
    return digest, after


def _open_pinned_weight(path: Path) -> tuple[BinaryIO, os.stat_result]:
    handle, before = _open_regular_file(path)
    try:
        if before.st_size != SOURCE_WEIGHT_SIZE:
            raise ConversionError(
                f"Pinned file size mismatch for {path.name}: "
                f"{before.st_size} != {SOURCE_WEIGHT_SIZE}",
            )
        digest, after = _hash_open_file(handle)
        if _stat_identity(after) != _stat_identity(before):
            raise ConversionError(f"Pinned file changed while hashing: {path.name}")
        if digest != SOURCE_WEIGHT_SHA256:
            raise ConversionError(f"Pinned file SHA-256 mismatch for {path.name}: {digest}")
        return handle, before
    except BaseException:
        handle.close()
        raise


def _read_pinned_auxiliary(path: Path, expected_sha256: str) -> bytes:
    handle, before = _open_regular_file(path)
    try:
        if before.st_size > MAX_AUXILIARY_BYTES:
            raise ConversionError(f"Pinned auxiliary file is too large: {path.name}")
        content = handle.read(MAX_AUXILIARY_BYTES + 1)
        after = os.fstat(handle.fileno())
        if _stat_identity(after) != _stat_identity(before) or len(content) != before.st_size:
            raise ConversionError(f"Pinned auxiliary file changed while reading: {path.name}")
        digest = hashlib.sha256(content).hexdigest()
        if digest != expected_sha256:
            raise ConversionError(f"Pinned file SHA-256 mismatch for {path.name}: {digest}")
        return content
    finally:
        handle.close()


def _read_meminfo_bytes(field: str) -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith(f"{field}:"):
            return int(line.split()[1]) * 1024
    raise ConversionError(f"Cannot read /proc/meminfo field: {field}")


def _read_cgroup_limit(name: str) -> str:
    cgroup_line = next(
        (line for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::")),
        None,
    )
    if cgroup_line is None:
        raise ConversionError("Unified cgroup-v2 membership is unavailable")
    relative = cgroup_line.split("::", 1)[1].lstrip("/")
    return (Path("/sys/fs/cgroup") / relative / name).read_text().strip()


def _strict_json_loads(content: bytes, *, description: str) -> object:
    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise ConversionError(f"Duplicate JSON key in {description}: {key}")
            value[key] = item
        return value

    def reject_constant(value: str) -> object:
        raise ConversionError(f"Non-finite JSON number in {description}: {value}")

    try:
        return json.loads(
            content,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConversionError(f"Invalid UTF-8 JSON in {description}") from error


def _verify_execution_boundary(output_parent: Path) -> dict[str, object]:
    if not sys.flags.isolated:
        raise ConversionError("Converter must run with python -I")
    if sys.version.split()[0] != EXPECTED_PYTHON_VERSION:
        raise ConversionError(f"Unexpected Python runtime: {sys.version.split()[0]}")
    if os.environ.get("CUDA_VISIBLE_DEVICES") != "":
        raise ConversionError("CUDA_VISIBLE_DEVICES must be empty")
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        raise ConversionError("Hugging Face and Transformers offline modes are required")

    for family, label in ((socket.AF_INET, "AF_INET"), (socket.AF_INET6, "AF_INET6")):
        network_socket: socket.socket | None = None
        try:
            network_socket = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            if error.errno != errno.EAFNOSUPPORT:
                raise ConversionError(
                    f"{label} socket creation failed with unexpected errno: {error.errno}",
                ) from error
        else:
            raise ConversionError(f"{label} socket creation must be blocked")
        finally:
            if network_socket is not None:
                network_socket.close()

    no_new_privileges = next(
        (
            line.split()[1]
            for line in Path("/proc/self/status").read_text().splitlines()
            if line.startswith("NoNewPrivs:")
        ),
        None,
    )
    if no_new_privileges != "1":
        raise ConversionError("NoNewPrivileges must be enabled")
    effective_capabilities = next(
        (
            line.split()[1]
            for line in Path("/proc/self/status").read_text().splitlines()
            if line.startswith("CapEff:")
        ),
        None,
    )
    if effective_capabilities is None or int(effective_capabilities, 16) != 0:
        raise ConversionError("Effective Linux capabilities must be empty")

    memory_max_raw = _read_cgroup_limit("memory.max")
    memory_current_raw = _read_cgroup_limit("memory.current")
    swap_max_raw = _read_cgroup_limit("memory.swap.max")
    pids_max_raw = _read_cgroup_limit("pids.max")
    cpu_max_raw = _read_cgroup_limit("cpu.max")
    if memory_max_raw == "max" or int(memory_max_raw) != EXPECTED_CGROUP_MEMORY_BYTES:
        raise ConversionError("Cgroup memory.max must equal the approved 8 GiB limit")
    if int(memory_max_raw) - int(memory_current_raw) < MIN_CGROUP_HEADROOM_BYTES:
        raise ConversionError("Cgroup has less than 6 GiB memory headroom")
    if swap_max_raw != "0":
        raise ConversionError("Cgroup memory.swap.max must be zero")
    if pids_max_raw == "max" or int(pids_max_raw) != EXPECTED_CGROUP_PIDS:
        raise ConversionError("Cgroup pids.max must equal the approved 64-process limit")
    if cpu_max_raw != EXPECTED_CGROUP_CPU_MAX:
        raise ConversionError("Cgroup CPUQuota must equal the approved 200 percent limit")

    available = _read_meminfo_bytes("MemAvailable")
    swap_free = _read_meminfo_bytes("SwapFree")
    disk_free = shutil.disk_usage(output_parent).free
    if available < MIN_AVAILABLE_MEMORY_BYTES:
        raise ConversionError("Less than 8 GiB host memory is available")
    if swap_free < MIN_FREE_SWAP_BYTES:
        raise ConversionError("Less than 8 GiB host swap is free")
    if disk_free < MIN_FREE_DISK_BYTES:
        raise ConversionError("Insufficient free disk for deterministic conversion")

    return {
        "isolatedPython": True,
        "ipSocketFamiliesBlocked": ["AF_INET", "AF_INET6"],
        "blockedNetworkErrno": errno.EAFNOSUPPORT,
        "noNewPrivileges": True,
        "effectiveCapabilities": "0000000000000000",
        "cudaVisibleDevices": "",
        "memoryMaxBytes": EXPECTED_CGROUP_MEMORY_BYTES,
        "minimumCgroupHeadroomBytes": MIN_CGROUP_HEADROOM_BYTES,
        "swapMaxBytes": 0,
        "pidsMax": EXPECTED_CGROUP_PIDS,
        "cpuMax": EXPECTED_CGROUP_CPU_MAX,
        "minimumAvailableMemoryBytes": MIN_AVAILABLE_MEMORY_BYTES,
        "minimumFreeSwapBytes": MIN_FREE_SWAP_BYTES,
        "minimumFreeDiskBytes": MIN_FREE_DISK_BYTES,
    }


def _verified_output_parent(output_dir: Path) -> tuple[Path, int, os.stat_result]:
    if not output_dir.name or output_dir.name in {".", ".."}:
        raise ConversionError("Output directory must have one explicit final component")
    parent = output_dir.parent.resolve(strict=True)
    final = parent / output_dir.name
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(parent, flags)
    parent_stat = os.fstat(descriptor)
    if not stat.S_ISDIR(parent_stat.st_mode):
        os.close(descriptor)
        raise ConversionError("Output parent is not a directory")
    if parent_stat.st_uid != os.getuid() or parent_stat.st_mode & 0o022:
        os.close(descriptor)
        raise ConversionError("Output parent must be owned by this user and not group/world writable")
    if final.exists() or final.is_symlink():
        os.close(descriptor)
        raise ConversionError(f"Output directory already exists: {final}")
    return final, descriptor, parent_stat


def _verify_parent_path_identity(path: Path, expected: os.stat_result) -> None:
    actual = path.stat(follow_symlinks=False)
    if not stat.S_ISDIR(actual.st_mode) or _directory_identity(actual) != _directory_identity(expected):
        raise ConversionError("Output parent pathname identity changed")


def _verify_directory_identity(path: Path, expected: os.stat_result) -> None:
    actual = path.stat(follow_symlinks=False)
    if not stat.S_ISDIR(actual.st_mode) or _directory_identity(actual) != _directory_identity(expected):
        raise ConversionError(f"Staging directory identity changed: {path.name}")


def _write_atomic(path: Path, content: bytes, *, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _hash_regular_path(path: Path) -> tuple[str, int]:
    handle, before = _open_regular_file(path)
    try:
        digest, after = _hash_open_file(handle)
        if _stat_identity(after) != _stat_identity(before):
            raise ConversionError(f"Output changed while hashing: {path.name}")
        return digest, before.st_size
    finally:
        handle.close()


def _fsync_regular_path(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode):
            raise ConversionError(f"Cannot fsync non-regular artifact: {path.name}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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
        raise ConversionError(f"Unsupported tensor dtype: {dtype}")
    return token


def _tensor_content_sha256(tensor: object) -> str:
    import torch  # noqa: PLC0415

    if not isinstance(tensor, torch.Tensor):
        raise ConversionError("Cannot hash a non-tensor value")
    contiguous = tensor.detach().contiguous().view(torch.uint8).numpy()
    view = memoryview(contiguous).cast("B")
    digest = hashlib.sha256()
    for offset in range(0, len(view), HASH_CHUNK_BYTES):
        digest.update(view[offset : offset + HASH_CHUNK_BYTES])
    return digest.hexdigest()


def _safe_cleanup_staging(path: Path, expected: os.stat_result) -> str | None:
    try:
        _verify_directory_identity(path, expected)
        os.chmod(path, 0o700)
        for child in path.iterdir():
            child_stat = child.stat(follow_symlinks=False)
            if not (stat.S_ISREG(child_stat.st_mode) or stat.S_ISLNK(child_stat.st_mode)):
                raise ConversionError(f"Unexpected staging child during cleanup: {child.name}")
            child.unlink()
        path.rmdir()
        return None
    except BaseException as cleanup_error:  # preserve the original conversion failure
        return str(cleanup_error)


def _rename_noreplace(parent_fd: int, source_name: str, target_name: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise ConversionError("renameat2(RENAME_NOREPLACE) is unavailable")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        parent_fd,
        os.fsencode(source_name),
        parent_fd,
        os.fsencode(target_name),
        RENAME_NOREPLACE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise ConversionError(f"Output directory appeared during publication: {target_name}")
        raise ConversionError(f"Atomic publication failed: {os.strerror(error_number)}")


def convert(source_dir: Path, requested_output_dir: Path) -> dict[str, object]:
    source_dir = source_dir.resolve(strict=True)
    output_dir, parent_fd, parent_stat = _verified_output_parent(requested_output_dir)
    staging: Path | None = None
    staging_stat: os.stat_result | None = None
    staging_name: str | None = None
    published = False
    script_handle: BinaryIO | None = None
    cleanup_error: str | None = None
    try:
        _verify_parent_path_identity(output_dir.parent, parent_stat)
        execution_boundary = _verify_execution_boundary(output_dir.parent)
        _verify_parent_path_identity(output_dir.parent, parent_stat)

        for _attempt in range(32):
            staging_name = f".xlsr-phoneme-stage.{secrets.token_hex(12)}"
            try:
                os.mkdir(staging_name, mode=0o700, dir_fd=parent_fd)
                break
            except FileExistsError:
                continue
        else:
            raise ConversionError("Cannot allocate a private staging directory")
        staging = Path(f"/proc/self/fd/{parent_fd}") / staging_name
        staging_stat = staging.stat(follow_symlinks=False)
        _verify_directory_identity(staging, staging_stat)
        script_handle, script_stat = _open_regular_file(Path(__file__))
        script_sha256, script_after = _hash_open_file(script_handle)
        if _stat_identity(script_after) != _stat_identity(script_stat):
            raise ConversionError("Converter script changed while binding")

        auxiliary_content = {
            name: _read_pinned_auxiliary(source_dir / name, expected_sha256)
            for name, expected_sha256 in PINNED_AUXILIARY_FILES.items()
        }
        config_value = _strict_json_loads(
            auxiliary_content["config.json"],
            description="pinned config.json",
        )
        if (
            not isinstance(config_value, dict)
            or config_value.get("model_type") != "wav2vec2"
            or config_value.get("architectures") != ["Wav2Vec2ForCTC"]
            or config_value.get("vocab_size") != 392
            or config_value.get("pad_token_id") != 0
            or config_value.get("bos_token_id") != 1
            or config_value.get("eos_token_id") != 2
        ):
            raise ConversionError("Pinned Wav2Vec2 configuration contract is invalid")

        os.environ.setdefault("OMP_NUM_THREADS", "2")
        os.environ.setdefault("MKL_NUM_THREADS", "2")
        import torch  # noqa: PLC0415
        import safetensors  # noqa: PLC0415
        import transformers  # noqa: PLC0415
        from safetensors import safe_open  # noqa: PLC0415
        from safetensors.torch import save_file  # noqa: PLC0415
        from transformers import Wav2Vec2Config, Wav2Vec2ForCTC  # noqa: PLC0415

        if torch.__version__ != EXPECTED_TORCH_VERSION:
            raise ConversionError(f"Unexpected Torch runtime: {torch.__version__}")
        if safetensors.__version__ != EXPECTED_SAFETENSORS_VERSION:
            raise ConversionError(f"Unexpected Safetensors runtime: {safetensors.__version__}")
        if transformers.__version__ != EXPECTED_TRANSFORMERS_VERSION:
            raise ConversionError(f"Unexpected Transformers runtime: {transformers.__version__}")
        if torch.cuda.is_available():
            raise ConversionError("CUDA must not be available to the converter")
        torch.set_num_threads(2)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass

        source_handle, source_stat = _open_pinned_weight(source_dir / SOURCE_WEIGHT_NAME)
        with source_handle:
            state = torch.load(source_handle, map_location="cpu", weights_only=True)
            second_sha256, source_after = _hash_open_file(source_handle)
        if _stat_identity(source_after) != _stat_identity(source_stat):
            raise ConversionError("Pinned checkpoint changed while loading")
        if second_sha256 != SOURCE_WEIGHT_SHA256:
            raise ConversionError("Pinned checkpoint changed between validation and load")
        if not isinstance(state, dict) or not state:
            raise ConversionError("Pinned checkpoint did not contain a non-empty state dictionary")
        if any(not isinstance(key, str) for key in state):
            raise ConversionError("Pinned checkpoint contains a non-string state key")

        tensors: dict[str, torch.Tensor] = {}
        tensor_inventory: list[dict[str, object]] = []
        tensor_content_inventory: list[dict[str, object]] = []
        total_numel = 0
        for key in sorted(state):
            tensor = state[key]
            if not isinstance(tensor, torch.Tensor):
                raise ConversionError(f"Pinned checkpoint entry is not a tensor: {key}")
            if tensor.device.type != "cpu" or tensor.layout != torch.strided:
                raise ConversionError(
                    f"Pinned checkpoint tensor has unsupported placement/layout: {key}",
                )
            if (
                tensor.ndim > MAX_TENSOR_DIMENSIONS
                or any(int(axis) < 0 or int(axis) > MAX_TENSOR_AXIS for axis in tensor.shape)
            ):
                raise ConversionError(f"Pinned checkpoint tensor shape is outside policy: {key}")
            source_content_sha256 = _tensor_content_sha256(tensor.detach().contiguous())
            sealed_tensor = tensor.detach().contiguous().clone()
            if _tensor_content_sha256(sealed_tensor) != source_content_sha256:
                raise ConversionError(f"Tensor clone differs from its source: {key}")
            tensors[key] = sealed_tensor
            total_numel += sealed_tensor.numel()
            tensor_inventory.append(
                {
                    "name": key,
                    "dtype": _torch_dtype_to_safetensors(sealed_tensor.dtype),
                    "shape": list(sealed_tensor.shape),
                    "numel": sealed_tensor.numel(),
                },
            )
            tensor_content_inventory.append(
                {
                    "name": key,
                    "contentSha256": source_content_sha256,
                },
            )
        if len(tensors) > MAX_TENSOR_COUNT or total_numel > MAX_TOTAL_NUMEL:
            raise ConversionError("Pinned checkpoint tensor inventory exceeds policy")
        del state
        gc.collect()

        tensor_inventory.sort(key=lambda item: str(item["name"]))
        tensor_content_inventory.sort(key=lambda item: str(item["name"]))
        tensors = dict(sorted(tensors.items()))

        temporary_weight = staging / f".{OUTPUT_WEIGHT_NAME}.tmp"
        save_file(tensors, temporary_weight, metadata={"format": "pt"})
        _fsync_regular_path(temporary_weight)
        os.chmod(temporary_weight, 0o444)
        output_weight = staging / OUTPUT_WEIGHT_NAME
        os.replace(temporary_weight, output_weight)
        _fsync_regular_path(output_weight)

        expected_inventory = {item["name"]: item for item in tensor_inventory}
        expected_content = {
            item["name"]: item["contentSha256"] for item in tensor_content_inventory
        }
        with safe_open(output_weight, framework="pt", device="cpu") as reader:
            if reader.metadata() != {"format": "pt"}:
                raise ConversionError("Safetensors metadata is not canonical")
            if list(reader.keys()) != sorted(expected_inventory):
                raise ConversionError("Safetensors key inventory differs from the source state")
            for key in reader.keys():
                item = expected_inventory[key]
                tensor_slice = reader.get_slice(key)
                if list(tensor_slice.get_shape()) != item["shape"]:
                    raise ConversionError(f"Safetensors shape mismatch: {key}")
                if str(tensor_slice.get_dtype()) != item["dtype"]:
                    raise ConversionError(f"Safetensors dtype mismatch: {key}")
                output_tensor = reader.get_tensor(key)
                if _tensor_content_sha256(output_tensor) != expected_content[key]:
                    raise ConversionError(f"Safetensors tensor-content mismatch: {key}")
                del output_tensor

        tensor_count = len(tensors)
        del tensors
        gc.collect()

        auxiliary_output_hashes: dict[str, str] = {}
        for name, content in auxiliary_content.items():
            _write_atomic(staging / name, content, mode=0o444)
            actual_sha256, _size = _hash_regular_path(staging / name)
            if actual_sha256 != PINNED_AUXILIARY_FILES[name]:
                raise ConversionError(f"Copied auxiliary hash mismatch: {name}")
            auxiliary_output_hashes[name] = actual_sha256

        roundtrip_config = Wav2Vec2Config.from_dict(config_value)
        roundtrip_model, loading_info = Wav2Vec2ForCTC.from_pretrained(
            staging,
            config=roundtrip_config,
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
            raise ConversionError(f"Transformers roundtrip loading was not exact: {loading_info}")
        del roundtrip_model
        gc.collect()

        output_sha256, output_size = _hash_regular_path(output_weight)

        tensor_inventory_sha256 = hashlib.sha256(_canonical_json(tensor_inventory)).hexdigest()
        tensor_content_inventory_sha256 = hashlib.sha256(
            _canonical_json(tensor_content_inventory),
        ).hexdigest()
        script_second_sha256, script_final = _hash_open_file(script_handle)
        if (
            _stat_identity(script_final) != _stat_identity(script_stat)
            or script_second_sha256 != script_sha256
        ):
            raise ConversionError("Converter script changed during execution")

        manifest = {
            "schemaVersion": "ltx-studio-xlsr-phoneme-conversion.v1",
            "source": {
                "repository": MODEL_REPOSITORY,
                "revision": MODEL_REVISION,
                "weight": {
                    "name": SOURCE_WEIGHT_NAME,
                    "sizeBytes": SOURCE_WEIGHT_SIZE,
                    "sha256": SOURCE_WEIGHT_SHA256,
                },
                "auxiliarySha256": PINNED_AUXILIARY_FILES,
            },
            "output": {
                "weight": {
                    "name": OUTPUT_WEIGHT_NAME,
                    "sizeBytes": output_size,
                    "sha256": output_sha256,
                    "tensorCount": tensor_count,
                    "totalNumel": total_numel,
                    "tensorInventorySha256": tensor_inventory_sha256,
                    "tensorContentInventorySha256": tensor_content_inventory_sha256,
                    "tensorContentVerified": True,
                },
                "auxiliarySha256": auxiliary_output_hashes,
            },
            "converter": {
                "scriptSha256": script_sha256,
                "python": EXPECTED_PYTHON_VERSION,
                "torch": EXPECTED_TORCH_VERSION,
                "safetensors": EXPECTED_SAFETENSORS_VERSION,
                "transformers": EXPECTED_TRANSFORMERS_VERSION,
                "weightsOnly": True,
                "sourceDescriptorBound": True,
                "sourceSecondHashVerified": True,
                "stateKeyMigration": "deferred-to-pinned-Wav2Vec2ForCTC.from_pretrained",
                "roundtripLoader": "Wav2Vec2ForCTC.from_pretrained",
                "roundtripExact": True,
                "threads": 2,
                "executionBoundary": execution_boundary,
            },
        }
        manifest_bytes = _canonical_json(manifest)
        _write_atomic(staging / OUTPUT_MANIFEST_NAME, manifest_bytes, mode=0o444)
        _fsync_regular_path(staging / OUTPUT_MANIFEST_NAME)
        manifest_sha256, _manifest_size = _hash_regular_path(staging / OUTPUT_MANIFEST_NAME)

        expected_names = {
            OUTPUT_WEIGHT_NAME,
            OUTPUT_MANIFEST_NAME,
            *PINNED_AUXILIARY_FILES.keys(),
        }
        if {item.name for item in staging.iterdir()} != expected_names:
            raise ConversionError("Staging directory contains unexpected files")

        os.chmod(staging, 0o555)
        staging_fd = os.open(staging, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(staging_fd)
        finally:
            os.close(staging_fd)
        _verify_parent_path_identity(output_dir.parent, parent_stat)
        _rename_noreplace(parent_fd, staging.name, output_dir.name)
        published = True
        try:
            os.fsync(parent_fd)
        except OSError as error:
            raise PublishedDurabilityUnknown(
                output_dir,
                f"Output was published but parent fsync failed: {error}",
            ) from error
        _verify_parent_path_identity(output_dir.parent, parent_stat)
        final_stat = output_dir.stat(follow_symlinks=False)
        if _directory_identity(final_stat) != _directory_identity(staging_stat):
            raise PublishedDurabilityUnknown(
                output_dir,
                "Output was published but final pathname identity differs",
            )
        final_manifest_sha256, _final_manifest_size = _hash_regular_path(
            output_dir / OUTPUT_MANIFEST_NAME,
        )
        if final_manifest_sha256 != manifest_sha256:
            raise PublishedDurabilityUnknown(
                output_dir,
                "Output was published but final manifest verification failed",
            )

        return {
            "manifest": manifest,
            "manifestSha256": manifest_sha256,
            "outputDirectory": str(output_dir),
        }
    except PublishedDurabilityUnknown:
        raise
    except BaseException as error:
        if published:
            raise PublishedDurabilityUnknown(
                output_dir,
                f"Output was published but final reconciliation failed: {error}",
            ) from error
        if not published and staging is not None and staging_stat is not None:
            cleanup_error = _safe_cleanup_staging(staging, staging_stat)
        elif not published and staging_name is not None:
            try:
                os.rmdir(staging_name, dir_fd=parent_fd)
            except BaseException as orphan_cleanup_error:
                cleanup_error = str(orphan_cleanup_error)
        raise
    finally:
        if script_handle is not None:
            script_handle.close()
        os.close(parent_fd)
        if cleanup_error is not None:
            print(json.dumps({"cleanupWarning": cleanup_error}), file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        result = convert(arguments.source_dir, arguments.output_dir)
    except PublishedDurabilityUnknown as error:
        print(
            json.dumps(
                {
                    "status": "published-durability-unknown",
                    "outputDirectory": str(error.output_directory),
                    "error": str(error),
                },
            ),
            file=sys.stderr,
        )
        return 3
    except Exception as error:  # deliberate signals still propagate
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        return 2
    print(json.dumps({"status": "converted", **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
