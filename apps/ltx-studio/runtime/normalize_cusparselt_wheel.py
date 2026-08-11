from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import os
from pathlib import Path

DISTRIBUTION = "nvidia-cusparselt-cu13"
EXPECTED_VERSION = "0.8.0"
ORIGINAL_TAG = b"Tag: py3-none-manylinux2014_sbsa\n"
NORMALIZED_TAG = b"Tag: py3-none-manylinux2014_aarch64\n"
AARCH64_ELF_MACHINE = 183


def fail(message: str) -> None:
    raise SystemExit(f"cuSPARSELt wheel normalization refused: {message}")


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(content)
    temporary.chmod(path.stat().st_mode)
    temporary.replace(path)


def record_digest(content: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def distribution_file(
    distribution: importlib.metadata.Distribution,
    suffix: str,
) -> tuple[Path, str]:
    matches = [entry for entry in distribution.files or () if str(entry).endswith(suffix)]
    if len(matches) != 1:
        fail(f"expected exactly one {suffix!r} entry, found {len(matches)}")
    relative = str(matches[0])
    return Path(distribution.locate_file(matches[0])), relative


def assert_aarch64_library(distribution: importlib.metadata.Distribution) -> None:
    library, _ = distribution_file(distribution, "nvidia/cusparselt/lib/libcusparseLt.so.0")
    with library.open("rb") as handle:
        header = handle.read(20)
    if header[:4] != b"\x7fELF" or header[4:6] != b"\x02\x01":
        fail("libcusparseLt is not a 64-bit little-endian ELF binary")
    machine = int.from_bytes(header[18:20], "little")
    if machine != AARCH64_ELF_MACHINE:
        fail(f"libcusparseLt ELF machine is {machine}, expected AArch64 ({AARCH64_ELF_MACHINE})")


def update_record(record_path: Path, wheel_relative: str, wheel_content: bytes) -> None:
    with record_path.open(newline="") as handle:
        rows = list(csv.reader(handle))
    matching_rows = [row for row in rows if row and row[0] == wheel_relative]
    if len(matching_rows) != 1:
        fail(f"expected exactly one RECORD entry for {wheel_relative!r}")
    matching_rows[0][1:] = [record_digest(wheel_content), str(len(wheel_content))]

    output = []
    for row in rows:
        output.append(",".join(_csv_field(value) for value in row))
    atomic_write(record_path, ("\n".join(output) + "\n").encode())


def _csv_field(value: str) -> str:
    if any(character in value for character in ',"\r\n'):
        return f'"{value.replace(chr(34), chr(34) * 2)}"'
    return value


def main() -> None:
    distribution = importlib.metadata.distribution(DISTRIBUTION)
    version = distribution.version
    if version != EXPECTED_VERSION:
        fail(f"installed version is {version}, expected {EXPECTED_VERSION}")

    wheel_path, wheel_relative = distribution_file(distribution, ".dist-info/WHEEL")
    record_path, _ = distribution_file(distribution, ".dist-info/RECORD")
    wheel_content = wheel_path.read_bytes()
    if NORMALIZED_TAG in wheel_content and ORIGINAL_TAG not in wheel_content:
        normalized_content = wheel_content
    elif wheel_content.count(ORIGINAL_TAG) == 1 and NORMALIZED_TAG not in wheel_content:
        assert_aarch64_library(distribution)
        normalized_content = wheel_content.replace(ORIGINAL_TAG, NORMALIZED_TAG)
        atomic_write(wheel_path, normalized_content)
    else:
        fail("WHEEL tag is neither the exact known NVIDIA tag nor the normalized tag")

    update_record(record_path, wheel_relative, normalized_content)
    print(f"normalized {DISTRIBUTION} {version} metadata for AArch64")  # noqa: T201


if __name__ == "__main__":
    main()
