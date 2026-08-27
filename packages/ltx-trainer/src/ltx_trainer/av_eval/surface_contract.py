"""Canonical AV-v2 binding to the deployed candidate release surface."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .authorization import studio_sha256_document

SURFACE_SCHEMA = "candidate-release-surface.v1"
SURFACE_BINDING_SCHEMA = "ltx-av-eval-candidate-vbench-surface-binding.v2"
SURFACE_PROJECTION_SCHEMA = "ltx-av-eval-candidate-vbench-surface-projection.v2"
TARGET_STATUS = "candidate"
REQUIRED_GATE = "vbench-i2v"
CURRENT_VBENCH_CLAIM_IDS = (
    "audio-driven-video.image-audio-to-video",
    "audio-driven-video.image-audio-to-video.refined.longcat-lipsync",
    "audio-driven-video.ltx25.image-audio-to-video.two-stage",
    "controlled-video.first-last-frame",
    "controlled-video.ic-lora.hdr",
    "controlled-video.ic-lora.ingredients",
    "controlled-video.ic-lora.inpainting",
    "controlled-video.ic-lora.motion-track",
    "controlled-video.ic-lora.outpainting",
    "controlled-video.ic-lora.pixel-upscaler",
    "controlled-video.ic-lora.union-control",
    "controlled-video.ic-lora.v2v-instant-shave",
    "controlled-video.ltx25.ic-lora.ingredients",
    "controlled-video.ltx25.ic-lora.motion-track",
    "controlled-video.ltx25.ic-lora.v2v-deblur",
    "native-generation.image-to-video",
    "native-generation.ltx25.image-to-video.single-stage",
    "native-generation.ltx25.image-to-video.two-stage",
    "reference-video-redubbing.native-distilled",
    "reference-video-redubbing.official-comfy-hq",
    "video-edit.retake",
)


class SurfaceContractError(ValueError):
    """Raised when a release surface cannot be bound to the AV-v2 matrix."""


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 256:
        raise SurfaceContractError(f"{context} must contain 3 to 256 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise SurfaceContractError(f"{context} contains unsupported characters")
    return value


def build_candidate_vbench_surface_binding(surface: object) -> dict[str, Any]:
    """Bind the full surface and its complete candidate+VBench entry projection."""

    if not isinstance(surface, dict) or surface.get("schemaVersion") != SURFACE_SCHEMA:
        raise SurfaceContractError("candidate release surface schema mismatch")
    entries = surface.get("entries")
    if not isinstance(entries, list) or not entries:
        raise SurfaceContractError("candidate release surface entries must be a non-empty list")
    selected: list[dict[str, Any]] = []
    entry_ids: list[str] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise SurfaceContractError(f"surface entry {index} must be an object")
        if entry.get("targetStatus") != TARGET_STATUS:
            continue
        gates = entry.get("applicableGates")
        if not isinstance(gates, list) or len(gates) != len(set(gates)):
            raise SurfaceContractError(f"surface entry {index} has invalid applicableGates")
        if REQUIRED_GATE not in gates:
            continue
        entry_id = _identifier(entry.get("id"), f"surface entry {index}.id")
        _identifier(entry.get("claimId"), f"surface entry {entry_id}.claimId")
        entry_ids.append(entry_id)
        selected.append(deepcopy(entry))
    if entry_ids != sorted(set(entry_ids)):
        raise SurfaceContractError("candidate VBench surface entry IDs must be unique and sorted")
    claim_ids = sorted({entry["claimId"] for entry in selected})
    if claim_ids != list(CURRENT_VBENCH_CLAIM_IDS):
        raise SurfaceContractError("candidate VBench surface must cover the exact current claim matrix")
    projection = {
        "schema_version": SURFACE_PROJECTION_SCHEMA,
        "source_schema_version": SURFACE_SCHEMA,
        "target_status": TARGET_STATUS,
        "required_gate": REQUIRED_GATE,
        "entries": selected,
    }
    return {
        "schema_version": SURFACE_BINDING_SCHEMA,
        "surface_schema_version": SURFACE_SCHEMA,
        "surface_digest": studio_sha256_document(surface),
        "projection_digest": studio_sha256_document(projection),
        "candidate_entry_count": len(selected),
        "claim_ids": claim_ids,
    }


def validate_candidate_vbench_surface_binding(binding: object, *, surface: object) -> dict[str, Any]:
    """Require a stored binding to equal a freshly derived surface binding."""

    expected = build_candidate_vbench_surface_binding(surface)
    if not isinstance(binding, dict) or binding != expected:
        raise SurfaceContractError("candidate VBench surface binding mismatch")
    return expected
