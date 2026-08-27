from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import os
from pathlib import Path

DISTRIBUTION = "torch"
EXPECTED_VERSION = "2.13.0+cu132"
ORIGINAL_REQUIREMENT = b'Requires-Dist: nvidia-cudnn-cu13==9.20.0.48; platform_system == "Linux"\n'
NORMALIZED_REQUIREMENT = b'Requires-Dist: nvidia-cudnn-cu13==9.24.0.43; platform_system == "Linux"\n'


def fail(message: str) -> None:
    raise SystemExit(f"Torch cuDNN metadata normalization refused: {message}")


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


def _csv_field(value: str) -> str:
    if any(character in value for character in ',"\r\n'):
        return f'"{value.replace(chr(34), chr(34) * 2)}"'
    return value


def update_record(record_path: Path, metadata_relative: str, metadata_content: bytes) -> None:
    with record_path.open(newline="") as handle:
        rows = list(csv.reader(handle))
    matching_rows = [row for row in rows if row and row[0] == metadata_relative]
    if len(matching_rows) != 1:
        fail(f"expected exactly one RECORD entry for {metadata_relative!r}")
    matching_rows[0][1:] = [record_digest(metadata_content), str(len(metadata_content))]
    output = [",".join(_csv_field(value) for value in row) for row in rows]
    atomic_write(record_path, ("\n".join(output) + "\n").encode())


def main() -> None:
    distribution = importlib.metadata.distribution(DISTRIBUTION)
    if distribution.version != EXPECTED_VERSION:
        fail(f"installed version is {distribution.version}, expected {EXPECTED_VERSION}")
    metadata_path, metadata_relative = distribution_file(distribution, ".dist-info/METADATA")
    record_path, _ = distribution_file(distribution, ".dist-info/RECORD")
    metadata_content = metadata_path.read_bytes()
    if NORMALIZED_REQUIREMENT in metadata_content and ORIGINAL_REQUIREMENT not in metadata_content:
        normalized_content = metadata_content
    elif metadata_content.count(ORIGINAL_REQUIREMENT) == 1 and NORMALIZED_REQUIREMENT not in metadata_content:
        normalized_content = metadata_content.replace(ORIGINAL_REQUIREMENT, NORMALIZED_REQUIREMENT)
        atomic_write(metadata_path, normalized_content)
    else:
        fail("cuDNN requirement is neither the exact known Torch pin nor the normalized pin")
    update_record(record_path, metadata_relative, normalized_content)
    print(f"normalized {DISTRIBUTION} {distribution.version} cuDNN requirement")  # noqa: T201


if __name__ == "__main__":
    main()
