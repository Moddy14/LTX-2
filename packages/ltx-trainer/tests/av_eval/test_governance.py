from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import ltx_trainer.av_eval.governance as governance_module
from ltx_trainer.av_eval import (
    GovernanceError,
    freeze_dataset,
    load_frozen_split,
    load_split_seed,
    open_frozen_artifact,
    open_frozen_dataset,
)
from ltx_trainer.av_eval.governance import TRUSTED_PREREGISTRATION_SHA256, _freeze_dataset

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
MAPPING_PATH = REPOSITORY_ROOT / "apps" / "ltx-studio" / "evaluators" / "phoneme-viseme" / "viseme-mapping.v1.json"
PREREGISTRATION_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "preregistration.v2.json"
TEST_SPLIT_SEED = "test-only-split-seed-v2"


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def _write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(f"{json.dumps(value, ensure_ascii=False, sort_keys=True)}\n" for value in values),
        encoding="utf-8",
    )


def _canonical_sha256(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    return _sha256(raw)


@cache
def _media_fixture(fps: int, index: int) -> tuple[bytes, bytes]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        media_path = root / "source.mkv"
        wav_path = root / "decoded.wav"
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color=c=0x{index + 1:02x}2030:s=32x32:r={fps}:d=2",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={440 + index * 20}:sample_rate=16000:duration=2",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "ffv1",
                "-level",
                "3",
                "-c:a",
                "pcm_s16le",
                str(media_path),
            ],
            check=False,
            capture_output=True,
        )
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(media_path),
                "-map",
                "0:a:0",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ],
            check=False,
            capture_output=True,
        )
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        return media_path.read_bytes(), wav_path.read_bytes()


@cache
def _vfr_media_fixture() -> tuple[bytes, bytes]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        media_path = root / "vfr.mkv"
        wav_path = root / "decoded.wav"
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=32x32:r=24:d=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=16000:duration=2",
                "-filter:v",
                "settb=AVTB,setpts=(floor(N/2)/12+mod(N\\,2)/48)/TB",
                "-fps_mode",
                "passthrough",
                "-enc_time_base:v",
                "1/1000",
                "-c:v",
                "ffv1",
                "-level",
                "3",
                "-c:a",
                "pcm_s16le",
                str(media_path),
            ],
            check=False,
            capture_output=True,
        )
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(media_path),
                "-map",
                "0:a:0",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ],
            check=False,
            capture_output=True,
        )
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        return media_path.read_bytes(), wav_path.read_bytes()


def _mouth_frames_fixture(fps: int, index: int) -> bytes:
    frames = np.zeros((fps * 2, 96, 96, 3), dtype=np.uint8)
    frames[:, 0, 0, 0] = index
    npy = io.BytesIO()
    np.save(npy, frames, allow_pickle=False)
    archive = io.BytesIO()
    member = zipfile.ZipInfo("frames.npy", date_time=(1980, 1, 1, 0, 0, 0))
    member.compress_type = zipfile.ZIP_DEFLATED
    member.external_attr = 0o444 << 16
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        output.writestr(member, npy.getvalue())
    return archive.getvalue()


def _fingerprint_fixture(index: int) -> bytes:
    fingerprint = np.zeros(256, dtype="<f4")
    fingerprint[index] = 1
    output = io.BytesIO()
    np.save(output, fingerprint, allow_pickle=False)
    return output.getvalue()


def _make_timeline(
    sample_id: str,
    language: str,
    transcript: str,
    decoded_pcm_sha256: str,
) -> dict[str, Any]:
    return {
        "schema_version": "ltx-av-eval-phoneme-timeline.v1",
        "sample_id": sample_id,
        "language": language,
        "time_base": "sample-relative-us",
        "verification_status": "human-verified",
        "annotation_guideline_version": "ltx-av-phoneme-guideline.v1",
        "adjudication_status": "independently-adjudicated",
        "annotator_id": f"annotator-{sample_id}",
        "verifier_id": f"verifier-{sample_id}",
        "adjudicator_id": f"adjudicator-{sample_id}",
        "verified_at": "2026-07-23T12:00:00Z",
        "transcript_sha256": _sha256(transcript.encode()),
        "decoded_pcm_sha256": decoded_pcm_sha256,
        "intervals": [
            {"phone": "h", "start_us": 0, "end_us": 500_000},
            {"phone": "a", "start_us": 500_000, "end_us": 1_000_000},
            {"phone": "l", "start_us": 1_000_000, "end_us": 1_500_000},
            {"phone": "o", "start_us": 1_500_000, "end_us": 2_000_000},
        ],
    }


def _make_dataset(
    root: Path,
    *,
    sample_count: int = 8,
    mutate: Callable[[list[dict[str, Any]], list[dict[str, Any]], Path], None] | None = None,
    preregistration_status: str = "draft",
) -> tuple[Path, Path, Path, Path]:
    root.mkdir()
    samples: list[dict[str, Any]] = []
    rights_records: list[dict[str, Any]] = []
    for index in range(sample_count):
        sample_id = f"sample-{index:03d}"
        language = "de" if index % 2 == 0 else "en"
        transcript = f"Testtranskript {index}"
        fps = (24, 25, 30)[index % 3]
        media_bytes, decoded_pcm_bytes = _media_fixture(fps, index)
        media_path = root / f"{sample_id}.mkv"
        media_path.write_bytes(media_bytes)
        decoded_pcm_path = root / f"{sample_id}.wav"
        decoded_pcm_path.write_bytes(decoded_pcm_bytes)
        mouth_frames_path = root / f"{sample_id}.mouth.npz"
        mouth_frames_path.write_bytes(_mouth_frames_fixture(fps, index))
        perceptual_fingerprint_path = root / f"{sample_id}.perceptual.npy"
        perceptual_fingerprint_path.write_bytes(_fingerprint_fixture(index))
        timeline_path = root / f"{sample_id}.timeline.json"
        _write_json(
            timeline_path,
            _make_timeline(
                sample_id,
                language,
                transcript,
                _sha256(decoded_pcm_path.read_bytes()),
            ),
        )
        evidence_path = root / f"rights-{index:03d}.txt"
        evidence_path.write_text(f"documented-grant-{index}", encoding="utf-8")
        rights_bundle_id = f"bundle-{index:03d}"
        rights_source_id = f"rights-source-{index:03d}"
        samples.append(
            {
                "schema_version": "ltx-av-eval-sample.v1",
                "sample_id": sample_id,
                "media_path": media_path.name,
                "media_sha256": _sha256(media_path.read_bytes()),
                "decoded_pcm_path": decoded_pcm_path.name,
                "decoded_pcm_sha256": _sha256(decoded_pcm_path.read_bytes()),
                "mouth_frames_path": mouth_frames_path.name,
                "mouth_frames_sha256": _sha256(mouth_frames_path.read_bytes()),
                "perceptual_fingerprint_path": perceptual_fingerprint_path.name,
                "perceptual_fingerprint_sha256": _sha256(perceptual_fingerprint_path.read_bytes()),
                "phoneme_timeline_path": timeline_path.name,
                "phoneme_timeline_sha256": _sha256(timeline_path.read_bytes()),
                "start_us": 0,
                "end_us": 2_000_000,
                "language": language,
                "transcript": transcript,
                "voice_speaker_id": f"speaker-{index:03d}",
                "face_identity_id": f"face-{index:03d}",
                "source_asset_id": f"asset-{index:03d}",
                "source_collection_id": f"collection-{index:03d}",
                "recording_session_id": f"session-{index:03d}",
                "utterance_id": f"utterance-{index:03d}",
                "derivative_group_id": f"derivative-{index:03d}",
                "rights_source_id": rights_source_id,
                "rights_bundle_id": rights_bundle_id,
                "parent_sample_id": None,
                "perceptual_duplicate_id": f"perceptual-component-{index:03d}",
                "strata": {
                    "fps": fps,
                    "speech_rate_wpm": 100 + index,
                    "head_motion": "static" if index % 2 == 0 else "light",
                    "lighting": "standard" if index % 2 == 0 else "difficult",
                    "gender_group": ("female", "male", "nonbinary", "not-disclosed")[index % 4],
                    "age_band": ("18-29", "30-44", "45-59", "60-plus")[index % 4],
                    "skin_tone_fitzpatrick": (index % 6) + 1,
                    "source_domain": ("consented-recording" if index % 2 == 0 else "ltx-generated-product-output"),
                    "absolute_yaw_degrees_max": 10,
                    "mouth_visible_ratio": 1,
                    "mouth_occlusion_ratio": 0,
                    "speaker_count": 1,
                    "active_speaker_visible": True,
                    "offscreen_speech": False,
                    "has_music": False,
                    "cut_count": 0,
                    "ood_kind": None,
                },
            }
        )
        rights_records.append(
            {
                "schema_version": "ltx-av-eval-rights.v1",
                "rights_bundle_id": rights_bundle_id,
                "rights_source_id": rights_source_id,
                "evidence_path": evidence_path.name,
                "evidence_sha256": _sha256(evidence_path.read_bytes()),
                "rights_holder": f"rights-holder-{index}",
                "legal_approval_id": f"legal-{index:03d}",
                "legal_basis": "documented explicit consent",
                "territory": "worldwide",
                "valid_from": "2026-01-01T00:00:00Z",
                "expires_at": None,
                "revoked_at": None,
                "training_allowed": True,
                "feature_extraction_allowed": True,
                "face_biometric_processing_allowed": True,
                "voice_biometric_processing_allowed": True,
                "derived_weights_allowed": True,
                "commercial_use_allowed": True,
                "redistribution_allowed": True,
                "adult_confirmed": True,
                "legal_approved": True,
                "dpia_id": f"dpia-{index:03d}",
                "dpa_id": f"dpa-{index:03d}",
                "processor_record_id": f"processor-{index:03d}",
            }
        )
    if mutate is not None:
        mutate(samples, rights_records, root)
    manifest_path = root / "manifest.jsonl"
    rights_path = root / "rights.jsonl"
    preregistration_path = root / "preregistration.json"
    _write_jsonl(manifest_path, samples)
    _write_jsonl(rights_path, rights_records)
    preregistration = json.loads(PREREGISTRATION_PATH.read_text(encoding="utf-8"))
    preregistration["status"] = preregistration_status
    preregistration["split_seed_sha256"] = _sha256(TEST_SPLIT_SEED.encode())
    _write_json(preregistration_path, preregistration)
    return manifest_path, rights_path, MAPPING_PATH, preregistration_path


def _freeze(
    paths: tuple[Path, Path, Path, Path],
    output_root: Path,
    *,
    profile: str = "development",
) -> Path:
    manifest, rights, mapping, preregistration = paths
    preregistration_document = json.loads(preregistration.read_text(encoding="utf-8"))
    return _freeze_dataset(
        manifest,
        rights,
        mapping,
        preregistration,
        output_root,
        split_seed=TEST_SPLIT_SEED,
        profile=profile,  # type: ignore[arg-type]
        trusted_preregistration_sha256=_canonical_sha256(preregistration_document),
    )


def test_freeze_is_reproducible_read_only_and_order_invariant(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    output_root = tmp_path / "freezes"
    first = _freeze(paths, output_root)
    manifest_path = paths[0]
    lines = manifest_path.read_text(encoding="utf-8").splitlines()
    manifest_path.write_text("\n".join(reversed(lines)) + "\n", encoding="utf-8")
    second = _freeze(paths, output_root)

    assert first == second
    assert stat_mode(first) == 0o500
    assert stat_mode(first / "freeze.json") == 0o444
    freeze = json.loads((first / "freeze.json").read_text(encoding="utf-8"))
    assert freeze["core"]["sample_count"] == 8
    assert sum(freeze["core"]["split_counts"].values()) == 8
    assert all(freeze["core"]["split_counts"][split] > 0 for split in ("train", "tune", "calibration", "test"))


def test_checked_in_preregistration_matches_trust_anchor_and_hides_real_seed() -> None:
    preregistration = json.loads(PREREGISTRATION_PATH.read_text(encoding="utf-8"))

    assert _canonical_sha256(preregistration) == TRUSTED_PREREGISTRATION_SHA256
    assert preregistration["split_seed_sha256"] != _sha256(TEST_SPLIT_SEED.encode())


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def test_transitive_identity_and_source_links_stay_in_one_split(tmp_path: Path) -> None:
    def link_samples(samples: list[dict[str, Any]], _rights: list[dict[str, Any]], _root: Path) -> None:
        samples[1]["voice_speaker_id"] = samples[0]["voice_speaker_id"]
        samples[2]["source_asset_id"] = samples[1]["source_asset_id"]

    paths = _make_dataset(tmp_path / "dataset", mutate=link_samples)
    freeze_root = _freeze(paths, tmp_path / "freezes")
    freeze = json.loads((freeze_root / "freeze.json").read_text(encoding="utf-8"))
    assignments = freeze["core"]["assignments"]

    assert assignments["sample-000"] == assignments["sample-001"] == assignments["sample-002"]
    assert any(
        set(component) >= {"sample-000", "sample-001", "sample-002"} for component in freeze["core"]["components"]
    )


def test_in_distribution_and_ood_cannot_share_a_leakage_component(tmp_path: Path) -> None:
    def mix_component(samples: list[dict[str, Any]], _rights: list[dict[str, Any]], root: Path) -> None:
        samples[1]["voice_speaker_id"] = samples[0]["voice_speaker_id"]
        samples[1]["strata"]["ood_kind"] = "silence"
        samples[1]["strata"]["speech_rate_wpm"] = 0
        samples[1]["strata"]["speaker_count"] = 0
        samples[1]["strata"]["active_speaker_visible"] = False
        timeline_path = root / samples[1]["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        for interval in timeline["intervals"]:
            interval["phone"] = "sil"
        _write_json(timeline_path, timeline)
        samples[1]["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    paths = _make_dataset(tmp_path / "dataset", mutate=mix_component)

    with pytest.raises(GovernanceError, match="mischt In-Distribution- und OOD"):
        _freeze(paths, tmp_path / "freezes")


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("expires_at", "2026-07-24T11:59:59Z", "abgelaufen"),
        ("revoked_at", "2026-07-24T11:59:59Z", "widerrufen"),
        ("training_allowed", False, "Rechtefreigabe fehlt"),
        ("feature_extraction_allowed", False, "Rechtefreigabe fehlt"),
        ("face_biometric_processing_allowed", False, "Rechtefreigabe fehlt"),
        ("voice_biometric_processing_allowed", False, "Rechtefreigabe fehlt"),
        ("derived_weights_allowed", False, "Rechtefreigabe fehlt"),
        ("commercial_use_allowed", False, "Rechtefreigabe fehlt"),
        ("redistribution_allowed", False, "Rechtefreigabe fehlt"),
        ("adult_confirmed", False, "Rechtefreigabe fehlt"),
        ("legal_approved", False, "Rechtefreigabe fehlt"),
    ],
)
def test_expired_revoked_or_incomplete_rights_are_rejected(
    tmp_path: Path,
    field: str,
    value: str | bool,
    message: str,
) -> None:
    def invalidate_rights(
        _samples: list[dict[str, Any]],
        rights: list[dict[str, Any]],
        _root: Path,
    ) -> None:
        rights[0][field] = value

    paths = _make_dataset(tmp_path / "dataset", mutate=invalidate_rights)

    with pytest.raises(GovernanceError, match=message):
        _freeze(paths, tmp_path / "freezes")


def test_rights_gate_runs_before_media_processing(tmp_path: Path) -> None:
    def invalidate_rights_and_media(
        samples: list[dict[str, Any]],
        rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        rights[0]["training_allowed"] = False
        (root / samples[0]["media_path"]).write_bytes(b"not-media")

    paths = _make_dataset(tmp_path / "dataset", mutate=invalidate_rights_and_media)

    with pytest.raises(GovernanceError, match="Rechtefreigabe fehlt: training_allowed"):
        _freeze(paths, tmp_path / "freezes")


def test_human_verified_timeline_and_known_phone_are_required(tmp_path: Path) -> None:
    def reuse_verifier(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        timeline_path = root / samples[0]["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        timeline["verifier_id"] = timeline["annotator_id"]
        _write_json(timeline_path, timeline)
        samples[0]["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    paths = _make_dataset(tmp_path / "verifier-dataset", mutate=reuse_verifier)
    with pytest.raises(GovernanceError, match="verschiedene IDs"):
        _freeze(paths, tmp_path / "verifier-freezes")

    def use_unknown_phone(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        timeline_path = root / samples[0]["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        timeline["intervals"][0]["phone"] = "not-a-phone"
        _write_json(timeline_path, timeline)
        samples[0]["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    phone_paths = _make_dataset(tmp_path / "phone-dataset", mutate=use_unknown_phone)
    with pytest.raises(GovernanceError, match="unbekanntes Phone"):
        _freeze(phone_paths, tmp_path / "phone-freezes")


def test_in_domain_timeline_requires_speech_and_registered_claim_evidence(tmp_path: Path) -> None:
    def replace_speech_with_silence(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        timeline_path = root / samples[0]["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        for interval in timeline["intervals"]:
            interval["phone"] = "sil"
        _write_json(timeline_path, timeline)
        samples[0]["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    silent_paths = _make_dataset(tmp_path / "silent-dataset", mutate=replace_speech_with_silence)
    with pytest.raises(GovernanceError, match="plausible Intervalle"):
        _freeze(silent_paths, tmp_path / "silent-freezes")

    def exceed_yaw(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        _root: Path,
    ) -> None:
        samples[0]["strata"]["absolute_yaw_degrees_max"] = 20.1

    yaw_paths = _make_dataset(tmp_path / "yaw-dataset", mutate=exceed_yaw)
    with pytest.raises(GovernanceError, match="Claim-Domain"):
        _freeze(yaw_paths, tmp_path / "yaw-freezes")


def test_ood_evidence_and_timeline_coverage_fail_closed(tmp_path: Path) -> None:
    def false_silence(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        _root: Path,
    ) -> None:
        samples[0]["strata"]["ood_kind"] = "silence"

    silence_paths = _make_dataset(tmp_path / "silence-dataset", mutate=false_silence)
    with pytest.raises(GovernanceError, match="silence benötigt"):
        _freeze(silence_paths, tmp_path / "silence-freezes")

    def timeline_gap(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        timeline_path = root / samples[0]["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        timeline["intervals"][0]["start_us"] = 1
        _write_json(timeline_path, timeline)
        samples[0]["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    gap_paths = _make_dataset(tmp_path / "gap-dataset", mutate=timeline_gap)
    with pytest.raises(GovernanceError, match="Lücke"):
        _freeze(gap_paths, tmp_path / "gap-freezes")


def test_symlink_in_artifact_path_is_rejected(tmp_path: Path) -> None:
    def insert_symlink(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        real_directory = root / "real"
        real_directory.mkdir()
        media_path = root / samples[0]["media_path"]
        media_path.rename(real_directory / media_path.name)
        (root / "alias").symlink_to(real_directory, target_is_directory=True)
        samples[0]["media_path"] = f"alias/{media_path.name}"

    paths = _make_dataset(tmp_path / "dataset", mutate=insert_symlink)

    with pytest.raises(GovernanceError, match="Symlink-Komponente"):
        _freeze(paths, tmp_path / "freezes")


def test_unknown_parent_and_revoked_rights_fail_closed_at_current_time(tmp_path: Path) -> None:
    def add_unknown_parent(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        _root: Path,
    ) -> None:
        samples[0]["parent_sample_id"] = "missing-parent"

    paths = _make_dataset(tmp_path / "dataset", mutate=add_unknown_parent)
    with pytest.raises(GovernanceError, match="Parent-Sample fehlt"):
        _freeze(paths, tmp_path / "freezes")

    def revoke_rights(
        _samples: list[dict[str, Any]],
        rights: list[dict[str, Any]],
        _root: Path,
    ) -> None:
        revoked_at = datetime.now(UTC) - timedelta(seconds=1)
        rights[0]["revoked_at"] = revoked_at.isoformat().replace("+00:00", "Z")

    revoked_paths = _make_dataset(tmp_path / "revoked-dataset", mutate=revoke_rights)
    with pytest.raises(GovernanceError, match="widerrufen"):
        _freeze(revoked_paths, tmp_path / "revoked-freezes")


def test_rights_are_rechecked_at_attestation_completion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = datetime(2026, 7, 24, 12, 0, tzinfo=UTC)

    def expire_during_freeze(
        _samples: list[dict[str, Any]],
        rights: list[dict[str, Any]],
        _root: Path,
    ) -> None:
        rights[0]["expires_at"] = "2026-07-24T12:05:00Z"

    class AdvancingDateTime(datetime):
        calls = 0

        @classmethod
        def now(cls, tz: object = None) -> AdvancingDateTime:
            cls.calls += 1
            value = base if cls.calls <= 2 else base + timedelta(minutes=10)
            return cls.fromtimestamp(value.timestamp(), tz=tz)

    paths = _make_dataset(tmp_path / "dataset", mutate=expire_during_freeze)
    monkeypatch.setattr(governance_module, "datetime", AdvancingDateTime)

    with pytest.raises(GovernanceError, match="abgelaufen"):
        _freeze(paths, tmp_path / "freezes")


def test_freeze_api_rejects_caller_controlled_audit_time(tmp_path: Path) -> None:
    manifest, rights, mapping, preregistration = _make_dataset(tmp_path / "dataset")

    with pytest.raises(TypeError, match="checked_at"):
        freeze_dataset(
            manifest,
            rights,
            mapping,
            preregistration,
            tmp_path / "freezes",
            split_seed=TEST_SPLIT_SEED,
            profile="development",
            checked_at=datetime(2026, 7, 24, 12, 0, tzinfo=UTC),  # type: ignore[call-arg]
        )


def test_split_seed_file_must_be_owner_only(tmp_path: Path) -> None:
    seed_path = tmp_path / "split-seed"
    seed_path.write_text(TEST_SPLIT_SEED + "\n", encoding="utf-8")
    seed_path.chmod(0o644)
    with pytest.raises(GovernanceError, match="Modus 0600"):
        load_split_seed(seed_path)

    seed_path.chmod(0o600)
    assert load_split_seed(seed_path) == TEST_SPLIT_SEED


def test_existing_freeze_split_tampering_is_detected(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    freeze_root = _freeze(paths, tmp_path / "freezes")
    split_path = freeze_root / "test.json"
    freeze_root.chmod(0o700)
    split_path.chmod(0o600)
    split = json.loads(split_path.read_text(encoding="utf-8"))
    split["sample_ids"] = split["sample_ids"][1:]
    split["samples"] = split["samples"][1:]
    _write_json(split_path, split)

    with pytest.raises(GovernanceError, match="Soll-Zuweisung"):
        load_frozen_split(freeze_root, "test")

    train = json.loads((freeze_root / "train.json").read_text(encoding="utf-8"))
    replacement = train["samples"][0]
    split["sample_ids"] = [replacement["sample_id"]]
    split["samples"] = [replacement]
    _write_json(split_path, split)
    with pytest.raises(GovernanceError, match="Soll-Zuweisung"):
        load_frozen_split(freeze_root, "test")

    with pytest.raises(GovernanceError, match="Freeze-Split wurde verändert"):
        _freeze(paths, tmp_path / "freezes")


def test_existing_freeze_rejects_unregistered_files(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    freeze_root = _freeze(paths, tmp_path / "freezes")
    freeze_root.chmod(0o700)
    (freeze_root / "unexpected.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(GovernanceError, match="unbekannte oder fehlende Dateien"):
        _freeze(paths, tmp_path / "freezes")


def test_concurrent_identical_freezes_are_idempotent(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    output_root = tmp_path / "freezes"
    barrier = threading.Barrier(2)

    def run_freeze() -> Path:
        barrier.wait()
        return _freeze(paths, output_root)

    with ThreadPoolExecutor(max_workers=2) as executor:
        roots = list(executor.map(lambda _index: run_freeze(), range(2)))

    assert roots[0] == roots[1]
    assert (roots[0] / "freeze.json").is_file()


def test_product_freeze_is_hard_blocked_until_release_attestations_exist(tmp_path: Path) -> None:
    draft_paths = _make_dataset(tmp_path / "draft-dataset")
    with pytest.raises(GovernanceError, match="Product-HOLD"):
        _freeze(draft_paths, tmp_path / "draft-freezes", profile="product")

    frozen_paths = _make_dataset(
        tmp_path / "frozen-dataset",
        preregistration_status="frozen",
    )
    with pytest.raises(GovernanceError, match="Product-HOLD"):
        _freeze(frozen_paths, tmp_path / "frozen-freezes", profile="product")
    with pytest.raises(GovernanceError, match="model_recipe_sha256"):
        _freeze(frozen_paths, tmp_path / "invalid-frozen-development", profile="development")


def test_split_seed_and_derived_feature_artifacts_are_bound(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "seed-dataset")
    manifest, rights, mapping, preregistration = paths
    preregistration_document = json.loads(preregistration.read_text(encoding="utf-8"))
    with pytest.raises(GovernanceError, match="Review-Digest versiegelt"):
        freeze_dataset(
            manifest,
            rights,
            mapping,
            preregistration,
            tmp_path / "unsealed-freezes",
            split_seed=TEST_SPLIT_SEED,
            profile="development",
        )
    with pytest.raises(GovernanceError, match="split_seed stimmt nicht"):
        _freeze_dataset(
            manifest,
            rights,
            mapping,
            preregistration,
            tmp_path / "seed-freezes",
            split_seed="seed-shopping-is-rejected",
            profile="development",
            trusted_preregistration_sha256=_canonical_sha256(preregistration_document),
        )

    def tamper_derived(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        (root / samples[0]["decoded_pcm_path"]).write_bytes(b"tampered-pcm")

    derived_paths = _make_dataset(tmp_path / "derived-dataset", mutate=tamper_derived)
    with pytest.raises(GovernanceError, match="Decoded-PCM-Hash stimmt nicht"):
        _freeze(derived_paths, tmp_path / "derived-freezes")


def test_rehashed_but_invalid_derived_artifacts_are_rejected(tmp_path: Path) -> None:
    def replace_pcm_with_text(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        sample = samples[0]
        pcm_path = root / sample["decoded_pcm_path"]
        pcm_path.write_bytes(b"not-a-wave")
        sample["decoded_pcm_sha256"] = _sha256(pcm_path.read_bytes())
        timeline_path = root / sample["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        timeline["decoded_pcm_sha256"] = sample["decoded_pcm_sha256"]
        _write_json(timeline_path, timeline)
        sample["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    pcm_paths = _make_dataset(tmp_path / "pcm-dataset", mutate=replace_pcm_with_text)
    with pytest.raises(GovernanceError, match="gültige WAV"):
        _freeze(pcm_paths, tmp_path / "pcm-freezes")

    def replace_mouth_tensor(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        sample = samples[0]
        path = root / sample["mouth_frames_path"]
        wrong_frames = np.zeros((1, 96, 96, 3), dtype=np.uint8)
        np.savez_compressed(path, frames=wrong_frames)
        sample["mouth_frames_sha256"] = _sha256(path.read_bytes())

    mouth_paths = _make_dataset(tmp_path / "mouth-dataset", mutate=replace_mouth_tensor)
    with pytest.raises(GovernanceError, match="Sampledauer"):
        _freeze(mouth_paths, tmp_path / "mouth-freezes")

    def replace_fingerprint(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        sample = samples[0]
        path = root / sample["perceptual_fingerprint_path"]
        output = io.BytesIO()
        np.save(output, np.zeros(256, dtype="<f4"), allow_pickle=False)
        path.write_bytes(output.getvalue())
        sample["perceptual_fingerprint_sha256"] = _sha256(path.read_bytes())

    fingerprint_paths = _make_dataset(tmp_path / "fingerprint-dataset", mutate=replace_fingerprint)
    with pytest.raises(GovernanceError, match="L2-normalisiert"):
        _freeze(fingerprint_paths, tmp_path / "fingerprint-freezes")


def test_vfr_video_is_rejected_even_when_average_rate_and_frame_count_match(tmp_path: Path) -> None:
    def replace_with_vfr(
        samples: list[dict[str, Any]],
        _rights: list[dict[str, Any]],
        root: Path,
    ) -> None:
        sample = samples[0]
        media_bytes, wav_bytes = _vfr_media_fixture()
        media_path = root / sample["media_path"]
        media_path.write_bytes(media_bytes)
        sample["media_sha256"] = _sha256(media_bytes)
        wav_path = root / sample["decoded_pcm_path"]
        wav_path.write_bytes(wav_bytes)
        sample["decoded_pcm_sha256"] = _sha256(wav_bytes)
        timeline_path = root / sample["phoneme_timeline_path"]
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        timeline["decoded_pcm_sha256"] = sample["decoded_pcm_sha256"]
        _write_json(timeline_path, timeline)
        sample["phoneme_timeline_sha256"] = _sha256(timeline_path.read_bytes())

    paths = _make_dataset(tmp_path / "dataset", mutate=replace_with_vfr)

    with pytest.raises(GovernanceError, match="nicht CFR"):
        _freeze(paths, tmp_path / "freezes")


def test_freeze_is_portable_and_cas_survives_source_removal(tmp_path: Path) -> None:
    first_paths = _make_dataset(tmp_path / "source-a")
    second_paths = _make_dataset(tmp_path / "source-b")
    first_root = _freeze(first_paths, tmp_path / "freezes-a")
    second_root = _freeze(second_paths, tmp_path / "freezes-b")

    assert first_root.name == second_root.name
    manifest_snapshot = json.loads((first_root / "manifest.snapshot.json").read_text(encoding="utf-8"))
    assert "source_root" not in manifest_snapshot
    media_sha256 = manifest_snapshot["samples"][0]["media_sha256"]
    expected_media = (first_paths[0].parent / "sample-000.mkv").read_bytes()
    shutil.rmtree(first_paths[0].parent)

    assert load_frozen_split(first_root, "train")
    with open_frozen_artifact(first_root, media_sha256) as artifact:
        assert artifact.read() == expected_media


def test_reusable_dataset_session_verifies_metadata_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    freeze_root = _freeze(paths, tmp_path / "freezes")

    with open_frozen_dataset(freeze_root) as dataset:
        samples = dataset.load_split("train")

        def fail_if_reverified(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("session revalidated O(N) metadata")

        monkeypatch.setattr(governance_module, "_load_verified_freeze_document", fail_if_reverified)
        monkeypatch.setattr(governance_module, "_validate_recent_rights_attestation", fail_if_reverified)
        for sha256 in (samples[0]["media_sha256"], samples[0]["decoded_pcm_sha256"]):
            with dataset.open_artifact(sha256) as artifact:
                assert artifact.read(1)

    with pytest.raises(GovernanceError, match="geschlossen"):
        dataset.load_split("train")


def test_existing_freeze_detects_cas_tampering(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    freeze_root = _freeze(paths, tmp_path / "freezes")
    manifest_snapshot = json.loads((freeze_root / "manifest.snapshot.json").read_text(encoding="utf-8"))
    media_path = freeze_root / manifest_snapshot["samples"][0]["media_path"]
    for parent in (media_path.parent, media_path.parent.parent, media_path.parent.parent.parent, freeze_root):
        parent.chmod(0o700)
    media_path.chmod(0o600)
    media_path.write_bytes(b"tampered")

    with pytest.raises(GovernanceError, match="Freeze-CAS-Artefakt wurde verändert"):
        _freeze(paths, tmp_path / "freezes")


def test_freeze_binds_core_and_validated_snapshots(tmp_path: Path) -> None:
    paths = _make_dataset(tmp_path / "dataset")
    freeze_root = _freeze(paths, tmp_path / "freezes")
    expected_snapshots = {
        "manifest.snapshot.json",
        "rights.snapshot.json",
        "viseme-mapping.snapshot.json",
        "preregistration.snapshot.json",
    }
    assert expected_snapshots.issubset({path.name for path in freeze_root.iterdir()})
    split = json.loads((freeze_root / "train.json").read_text(encoding="utf-8"))
    assert split["samples"]

    freeze_path = freeze_root / "freeze.json"
    freeze_root.chmod(0o700)
    freeze_path.chmod(0o600)
    freeze = json.loads(freeze_path.read_text(encoding="utf-8"))
    freeze["core"]["sample_count"] = 0
    _write_json(freeze_path, freeze)
    with pytest.raises(GovernanceError, match="Freeze wurde verändert"):
        _freeze(paths, tmp_path / "freezes")


def test_cli_rejects_unsealed_preregistration(tmp_path: Path) -> None:
    manifest, rights, mapping, preregistration = _make_dataset(tmp_path / "dataset")
    output_root = tmp_path / "freezes"
    seed_path = tmp_path / "split-seed"
    seed_path.write_text(TEST_SPLIT_SEED + "\n", encoding="utf-8")
    seed_path.chmod(0o600)
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "freeze",
            "--manifest",
            str(manifest),
            "--rights",
            str(rights),
            "--mapping",
            str(mapping),
            "--preregistration",
            str(preregistration),
            "--output-root",
            str(output_root),
            "--split-seed-file",
            str(seed_path),
            "--profile",
            "development",
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )

    assert result.returncode == 2
    assert "Review-Digest versiegelt" in result.stdout
    assert not output_root.exists()
