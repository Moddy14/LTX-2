#!/usr/bin/env python3
"""Harden the exact pinned LipForcing inference tree for offline Studio use."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path("/workspace/LipForcing")
PROVENANCE_PATH = Path("/opt/ltx-studio/runtime-patch-provenance.v1.json")
LOCAL_RUNTIME_ROOT = Path("/opt/ltx-studio")
PATCHSET_ID = "ltx-studio-lipforcing-runtime.v4"
MODIFICATION_NOTICE = (
    "# Modified by LTX Studio from pinned LipForcing commit "
    "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184.\n"
    "# Exact changes are recorded in /opt/ltx-studio/runtime-patch-provenance.v1.json.\n"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_patch_provenance() -> dict[str, object]:
    payload = json.loads(PROVENANCE_PATH.read_text(encoding="utf8"))
    if not isinstance(payload, dict) or set(payload) != {
        "schemaVersion", "patchSetId", "upstream", "patchedFiles", "localArtifacts",
    }:
        raise RuntimeError("LipForcing runtime patch provenance has an unexpected shape.")
    if (
        payload.get("schemaVersion") != "ltx-studio-lipforcing-runtime-patch.v1"
        or payload.get("patchSetId") != PATCHSET_ID
    ):
        raise RuntimeError("LipForcing runtime patch provenance targets an unexpected patchset.")
    upstream = payload.get("upstream")
    if not isinstance(upstream, dict) or set(upstream) != {
        "repository", "commit", "tree", "license",
    }:
        raise RuntimeError("LipForcing runtime patch provenance has invalid upstream evidence.")
    if (
        upstream.get("repository") != "https://github.com/cvlab-kaist/LipForcing"
        or upstream.get("commit") != "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184"
        or upstream.get("tree") != "e89930c267ffe75d6d19a9d6a8fcad4afd6672c9"
    ):
        raise RuntimeError("LipForcing runtime patch provenance does not match the official pin.")
    license_evidence = upstream.get("license")
    if not isinstance(license_evidence, dict) or license_evidence != {
        "path": "LICENSE",
        "sha256": "e27d3412810eb8420110b2595aa86a013628e8f441d65cf75f00e14973f051b7",
        "spdx": "Apache-2.0",
        "noticeFilePresent": False,
    }:
        raise RuntimeError("LipForcing runtime patch provenance has invalid license evidence.")
    if sha256_file(ROOT / "LICENSE") != license_evidence["sha256"]:
        raise RuntimeError("Pinned LipForcing LICENSE does not match patch provenance.")
    return payload


def verified_patch_records(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    raw_records = payload.get("patchedFiles")
    if not isinstance(raw_records, list):
        raise RuntimeError("LipForcing runtime patch provenance has no patched-file list.")
    records: dict[str, dict[str, object]] = {}
    for raw in raw_records:
        if not isinstance(raw, dict) or set(raw) != {
            "path", "sourceSha256", "patchedSha256", "changes", "modificationNotice",
        }:
            raise RuntimeError("LipForcing runtime patch provenance has an invalid file record.")
        relative = raw.get("path")
        if not isinstance(relative, str) or relative in records:
            raise RuntimeError("LipForcing runtime patch provenance has duplicate file paths.")
        if raw.get("modificationNotice") != MODIFICATION_NOTICE.rstrip("\n"):
            raise RuntimeError(f"LipForcing patch notice is missing for {relative}.")
        if not isinstance(raw.get("changes"), list) or not raw["changes"]:
            raise RuntimeError(f"LipForcing patch changes are missing for {relative}.")
        for field in ("sourceSha256", "patchedSha256"):
            value = raw.get(field)
            if not isinstance(value, str) or len(value) != 64 or any(
                character not in "0123456789abcdef" for character in value
            ):
                raise RuntimeError(f"LipForcing patch hash {field} is invalid for {relative}.")
        records[relative] = raw
    expected = {
        "scripts/inference/_loader.py",
        "scripts/inference/_common.py",
        "OmniAvatar/utils/latentsync/face_detector.py",
    }
    if set(records) != expected:
        raise RuntimeError("LipForcing runtime patch provenance has an unexpected file set.")
    return records


def verify_local_artifacts(payload: dict[str, object]) -> None:
    artifacts = payload.get("localArtifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 2:
        raise RuntimeError("LipForcing runtime patch provenance has invalid local artifacts.")
    expected = {
        "raw_output_mux.py": "paired-premux-export-and-legacy-audio-mux",
        "lipforcing-runner.py": "verified-offline-container-entrypoint",
    }
    records: dict[str, dict[str, object]] = {}
    for artifact in artifacts:
        if not isinstance(artifact, dict) or set(artifact) != {"path", "sha256", "role"}:
            raise RuntimeError("LipForcing runtime patch provenance has an invalid local artifact.")
        relative = artifact.get("path")
        if not isinstance(relative, str) or relative in records:
            raise RuntimeError("LipForcing runtime patch provenance has duplicate local artifacts.")
        records[relative] = artifact
    if set(records) != set(expected):
        raise RuntimeError("LipForcing runtime patch provenance names unexpected local artifacts.")
    for relative, role in expected.items():
        artifact = records[relative]
        expected_sha256 = artifact.get("sha256")
        if (
            artifact.get("role") != role
            or not isinstance(expected_sha256, str)
            or sha256_file(LOCAL_RUNTIME_ROOT / relative) != expected_sha256
        ):
            raise RuntimeError(f"LipForcing local artifact does not match provenance: {relative}")


def verify_patched_files(
    records: dict[str, dict[str, object]],
    hash_field: str,
) -> None:
    for relative, record in records.items():
        actual = sha256_file(ROOT / relative)
        if actual != record[hash_field]:
            raise RuntimeError(
                f"LipForcing source hash mismatch for {relative} at {hash_field}: "
                f"{actual} != {record[hash_field]}"
            )


def replace_exact(path: Path, old: str, new: str, expected: int) -> None:
    source = path.read_text(encoding="utf8")
    count = source.count(old)
    if count != expected:
        raise RuntimeError(
            f"Refusing to patch unexpected LipForcing source {path}: "
            f"found {count} occurrences, expected {expected}."
        )
    path.write_text(source.replace(old, new), encoding="utf8")


def main() -> int:
    provenance = load_patch_provenance()
    records = verified_patch_records(provenance)
    verify_local_artifacts(provenance)
    verify_patched_files(records, "sourceSha256")

    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        '"""Shared student-model loader for the inference scripts.\n',
        MODIFICATION_NOTICE + '"""Shared student-model loader for the inference scripts.\n',
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_common.py",
        '"""Shared helpers for the inference scripts.\n',
        MODIFICATION_NOTICE + '"""Shared helpers for the inference scripts.\n',
        1,
    )
    replace_exact(
        ROOT / "OmniAvatar" / "utils" / "latentsync" / "face_detector.py",
        "# Adapted from LatentSync\n",
        MODIFICATION_NOTICE + "# Adapted from LatentSync\n",
        1,
    )

    # Every file reachable from the production inference command contains
    # tensors/state dictionaries only. Refuse arbitrary pickle globals.
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "weights_only=False",
        "weights_only=True",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        'torch.load(args.ckpt_path, map_location="cpu", weights_only=True)',
        'torch.load(args.ckpt_path, map_location="cpu", weights_only=True, mmap=True)',
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "model.load_state_dict(state_dict, strict=False)",
        "model.load_state_dict(state_dict, strict=False, assign=True)",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "model.load_state_dict(prefixed_sd, strict=False)",
        "model.load_state_dict(prefixed_sd, strict=False, assign=True)",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        'constructor_merge_lora = (args.model_size == "1.3B")',
        "constructor_merge_lora = True",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "    model = CausalOmniAvatarWan(\n",
        '    with torch.device("meta"):\n        model = CausalOmniAvatarWan(\n',
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        """        use_dynamic_rope=args.use_dynamic_rope,
    )

    # Load Self-Forcing checkpoint on top
""",
        """        use_dynamic_rope=args.use_dynamic_rope,
        )

    # Load Self-Forcing checkpoint on top
""",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_common.py",
        "weights_only=False",
        "weights_only=True",
        8,
    )

    # The upstream H200 path constructs random CPU weights, then retains the
    # loaded checkpoint tensors until after model.to(cuda). On GB10 unified
    # memory that makes the transfer briefly require several full 14B copies.
    # The production patch constructs on meta, assigns the released checkpoint
    # directly, and drops temporary references before the transfer.
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        """    model = model.to(device=device, dtype=dtype)
    model.eval()
""",
        """    del state_dict
    if "ckpt" in locals():
        del ckpt
    if "prefixed_sd" in locals():
        del prefixed_sd
    import gc
    gc.collect()

    model.reset_parameters()
    model = model.to(device=device, dtype=dtype)
    model.eval()
""",
        1,
    )

    # Bind InsightFace to the read-only, hash-verified Studio mount. The
    # container has no network, so a missing model is a hard error.
    replace_exact(
        ROOT / "scripts" / "inference" / "_common.py",
        'insightface_root=os.path.join(LIPFORCING_ROOT, "checkpoints", "auxiliary"),',
        'insightface_root=os.environ["LIPFORCING_INSIGHTFACE_ROOT"],',
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_common.py",
        '''def mux_video_with_audio(video_path, audio_path, output_path, duration_s=None):
    """Mux silent video with audio via ffmpeg."""
    cmd = [
        _get_ffmpeg(), "-y", "-loglevel", "error", "-nostdin",
        "-i", video_path, "-i", audio_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-crf", "18",
        "-c:a", "aac", "-q:v", "0", "-q:a", "0",
    ]
    if duration_s is not None:
        cmd.extend(["-t", f"{duration_s:.4f}"])
    cmd.append(output_path)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg mux failed: {result.stderr}")
''',
        '''def mux_video_with_audio(video_path, audio_path, output_path, duration_s=None):
    """Mux silent video with audio under the verified Studio raw-output profile."""
    from raw_output_mux import mux_video_with_audio as studio_mux_video_with_audio

    studio_mux_video_with_audio(
        _get_ffmpeg(),
        video_path,
        audio_path,
        output_path,
        os.environ.get(
            "LTX_LIPFORCING_RAW_OUTPUT_PROFILE",
            "h264-crf13-mux-crf18-v1",
        ),
        duration_s,
    )
''',
        1,
    )
    replace_exact(
        ROOT / "OmniAvatar" / "utils" / "latentsync" / "face_detector.py",
        "self.app = FaceAnalysis(\n            allowed_modules=",
        'self.app = FaceAnalysis(\n            name="buffalo_l",\n            allowed_modules=',
        1,
    )
    verify_patched_files(records, "patchedSha256")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
