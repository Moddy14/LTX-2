from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import json
import sys
import warnings
from pathlib import Path

EXPECTED_DISTRIBUTIONS = (
    "ltx-core",
    "ltx-pipelines",
    "openai-whisper",
    "requests",
    "torch",
    "torchaudio",
)
EXPECTED_CUSPARSELT_VERSION = "0.8.0"
EXPECTED_CUSPARSELT_TAG = "Tag: py3-none-manylinux2014_aarch64\n"


def verify_cusparselt_metadata() -> None:
    distribution = importlib.metadata.distribution("nvidia-cusparselt-cu13")
    if distribution.version != EXPECTED_CUSPARSELT_VERSION:
        raise SystemExit("unexpected nvidia-cusparselt-cu13 version")
    files = distribution.files or ()
    wheel_relative = next((entry for entry in files if str(entry).endswith(".dist-info/WHEEL")), None)
    record_relative = next((entry for entry in files if str(entry).endswith(".dist-info/RECORD")), None)
    if wheel_relative is None or record_relative is None:
        raise SystemExit("cuSPARSELt wheel metadata is incomplete")
    wheel_content = Path(distribution.locate_file(wheel_relative)).read_bytes()
    if wheel_content.decode().count(EXPECTED_CUSPARSELT_TAG) != 1:
        raise SystemExit("cuSPARSELt wheel does not carry the normalized AArch64 tag")
    digest = base64.urlsafe_b64encode(hashlib.sha256(wheel_content).digest()).rstrip(b"=").decode()
    expected_record = (f"sha256={digest}", str(len(wheel_content)))
    with Path(distribution.locate_file(record_relative)).open(newline="") as handle:
        rows = [row for row in csv.reader(handle) if row and row[0] == str(wheel_relative)]
    if len(rows) != 1 or tuple(rows[0][1:]) != expected_record:
        raise SystemExit("cuSPARSELt normalized WHEEL hash is not bound in RECORD")


def main() -> None:
    verify_cusparselt_metadata()
    try:
        importlib.metadata.version("chardet")
    except importlib.metadata.PackageNotFoundError:
        pass
    else:
        raise SystemExit("chardet must not be installed in the native release runtime")

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        import requests  # noqa: F401, PLC0415

    import cv2  # noqa: F401, PLC0415
    import torch  # noqa: PLC0415
    import whisper  # noqa: F401, PLC0415

    import ltx_core  # noqa: F401, PLC0415
    import ltx_pipelines  # noqa: F401, PLC0415
    from ltx_pipelines.utils.cooperative_checkpoint import (  # noqa: PLC0415
        BOUNDARY_DECISION_SCHEMA,
        BOUNDARY_READY_SCHEMA,
    )

    if torch.tensor([1.0], device="cpu").add(1).item() != 2:
        raise SystemExit("torch CPU smoke failed")
    if not BOUNDARY_READY_SCHEMA.endswith(".v1") or not BOUNDARY_DECISION_SCHEMA.endswith(".v1"):
        raise SystemExit("cooperative boundary schema smoke failed")

    print(json.dumps({  # noqa: T201
        "python": sys.version.split()[0],
        "packages": {
            name: importlib.metadata.version(name)
            for name in EXPECTED_DISTRIBUTIONS
        },
        "torch_cuda": torch.version.cuda,
        "verdict": "ok",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
