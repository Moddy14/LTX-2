"""Frozen-dataset-bound v2 calibration for AV offset evidence.

Raw lag peak separation is an uncalibrated feature. This module is the only
supported bridge from that feature to correspondence probabilities consumed by
``offset-score``. It derives controls from a dataset freeze and split manifest,
enforces transitive independence and a balanced 24/25/30-fps control grid, and
binds the frozen operating point. It never emits a product or SOTA verdict.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from itertools import pairwise
from typing import Any

from .design import (
    CURRENT_PLANNING_HYPOTHESIS_COUNT,
    CURRENT_VBENCH_CLAIM_COUNT,
    CURRENT_VBENCH_GATE_COUNT,
    DesignError,
    build_power_report,
    document_sha256,
)
from .design import REPORT_SCHEMA as POWER_REPORT_SCHEMA
from .governance import (
    GROUP_FIELDS,
    HASH_GROUP_FIELDS,
    GovernanceError,
    build_transitive_components,
    validate_offset_preregistration,
)
from .offset import (
    BOOTSTRAP_REPLICATES,
    CONFIDENCE_LEVEL,
    OFFSET_OBSERVATIONS_SCHEMA,
    REQUIRED_FPS,
    REQUIRED_OFFSET_KINDS,
)

OFFSET_CONTROL_DECK_SCHEMA = "ltx-av-eval-offset-control-deck.v2"
OFFSET_CALIBRATOR_SCHEMA = "ltx-av-eval-offset-calibrator.v2"
OFFSET_CALIBRATION_APPLICATION_SCHEMA = "ltx-av-eval-offset-calibration-application.v2"
OFFSET_CALIBRATED_CASES_SCHEMA = "ltx-av-eval-offset-calibrated-cases.v2"
OFFSET_OBSERVATION_DECK_SCHEMA = "ltx-av-eval-offset-observation-deck.v2"
OPERATING_POINT_SCHEMA = "ltx-av-eval-offset-operating-point.v1"
DATASET_FREEZE_SCHEMA = "ltx-av-eval-dataset-freeze.v2"
DATASET_MANIFEST_SCHEMA = "ltx-av-eval-sample.v1"
CALIBRATION_METHOD = "speaker-disjoint-component-weighted-isotonic.v2"
SPLIT_ALGORITHM = "transitive-components-sha256.v1"
RAW_SCORE_SEMANTICS = "uncalibrated-lag-peak-separation.v1"
INTERPOLATION = "linear-clipped.v1"
WEIGHT_SEMANTICS = "equal-total-weight-per-transitive-component.v1"
CLASSIFICATION_RULE = "raw-score-greater-or-equal-is-correspondence.v1"
FIT_SPLIT = "tune"
EVALUATION_SPLIT = "calibration"
OUTPUT_SPLIT = "test"
GRID_REPLICATES_PER_CELL = 1
MAX_CASES = 900_000
MAX_MANIFEST_SAMPLES = 100_000
MAX_REGISTERED_STRATA = 64
MAX_COMPONENTS = 20_000
MAX_CALIBRATOR_KNOTS = 100_000
MIN_INDEPENDENT_UNITS = 2
MIN_D0A_INDEPENDENT_UNITS = 30
GRID_MULTIPLIERS = {
    "negative-multiframe": -2.0,
    "negative-one-frame": -1.0,
    "negative-subframe": -0.5,
    "positive-multiframe": 2.0,
    "positive-one-frame": 1.0,
    "positive-subframe": 0.5,
    "zero": 0.0,
}
INDEPENDENCE_FIELDS = (
    "voice_speaker_id",
    "face_identity_id",
    "recording_session_id",
    "source_asset_id",
    "source_collection_id",
    "leakage_component_id",
)
SOURCE_FIELDS = INDEPENDENCE_FIELDS[:-1]


class OffsetCalibrationError(ValueError):
    """Raised when offset calibration could leak or misstate confidence."""


class OffsetApplicationCaseError(OffsetCalibrationError):
    """Raised when an application case violates the frozen scoring contract."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise OffsetCalibrationError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise OffsetCalibrationError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise OffsetCalibrationError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise OffsetCalibrationError(f"{context} must be a lowercase SHA-256")
    return value


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise OffsetCalibrationError(f"{context} must be a finite number")
    result = float(value)
    return 0.0 if result == 0 else result


def _canonical_identifiers(raw: object, context: str, *, maximum: int = MAX_REGISTERED_STRATA) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise OffsetCalibrationError(f"{context} must be a non-empty list")
    if len(raw) > maximum:
        raise OffsetCalibrationError(f"{context} exceeds the {maximum}-identifier limit")
    values = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if len(values) != len(set(values)):
        raise OffsetCalibrationError(f"{context} must contain unique identifiers")
    return sorted(values)


def _governance_sha256(value: object) -> str:
    try:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise OffsetCalibrationError("dataset evidence is not canonical JSON") from error
    return hashlib.sha256(payload).hexdigest()


def _canonical_bootstrap(raw: object) -> dict[str, int | float]:
    if not isinstance(raw, dict):
        raise OffsetCalibrationError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise OffsetCalibrationError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return {"confidence_level": CONFIDENCE_LEVEL, "replicates": BOOTSTRAP_REPLICATES, "seed": seed}


def _canonical_power_report(  # noqa: PLR0912, PLR0915
    raw: object, design_raw: object
) -> tuple[dict[str, Any], dict[str, Any], int]:
    if not isinstance(design_raw, dict):
        raise OffsetCalibrationError("design must be a frozen D0a object")
    try:
        computed = build_power_report(design_raw)
    except DesignError as error:
        raise OffsetCalibrationError(f"D0a design rejected: {error}") from error
    if design_raw.get("status") != "frozen" or computed["status"] != "ready-to-freeze":
        raise OffsetCalibrationError("design must be frozen and produce a ready-to-freeze power report")
    if not isinstance(raw, dict):
        raise OffsetCalibrationError("power_report must be an object")
    expected = {
        "schema_version",
        "design_digest",
        "delta_catalog_digest",
        "vbench_gate_catalog_digest",
        "status",
        "blockers",
        "familywise_alpha",
        "planning_hypothesis_count",
        "per_endpoint_planning_alpha",
        "target_power",
        "endpoint_requirements",
        "required_independent_units",
        "required_clips",
        "strata_quotas_digest",
        "surface_digest",
        "candidate_surface_binding_digest",
        "candidate_surface_entry_count",
        "strata_quota_semantics_digest",
        "vbench_claim_count",
        "vbench_gate_count",
    }
    _exact_keys(raw, expected, "power_report")
    if raw["schema_version"] != POWER_REPORT_SCHEMA or raw["status"] != "ready-to-freeze":
        raise OffsetCalibrationError("power_report must be a ready-to-freeze D1 design report")
    if raw["blockers"] != []:
        raise OffsetCalibrationError("power_report must not contain blockers")
    for field in (
        "design_digest",
        "delta_catalog_digest",
        "vbench_gate_catalog_digest",
        "strata_quotas_digest",
        "surface_digest",
        "candidate_surface_binding_digest",
        "strata_quota_semantics_digest",
    ):
        _sha256(raw[field], f"power_report.{field}")
    required = raw["required_independent_units"]
    if isinstance(required, bool) or not isinstance(required, int) or required < MIN_D0A_INDEPENDENT_UNITS:
        raise OffsetCalibrationError("power_report.required_independent_units must be a non-null integer >= 30")
    required_clips = raw["required_clips"]
    if isinstance(required_clips, bool) or not isinstance(required_clips, int) or required_clips < required:
        raise OffsetCalibrationError("power_report.required_clips must cover required_independent_units")
    for field in ("familywise_alpha", "per_endpoint_planning_alpha", "target_power"):
        value = _number(raw[field], f"power_report.{field}")
        if not 0 < value < 1:
            raise OffsetCalibrationError(f"power_report.{field} must be between zero and one")
    count = raw["planning_hypothesis_count"]
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise OffsetCalibrationError("power_report.planning_hypothesis_count must be positive")
    if (
        count != CURRENT_PLANNING_HYPOTHESIS_COUNT
        or raw["vbench_claim_count"] != CURRENT_VBENCH_CLAIM_COUNT
        or raw["vbench_gate_count"] != CURRENT_VBENCH_GATE_COUNT
    ):
        raise OffsetCalibrationError("power_report does not cover the complete current D0a planning family")
    entry_count = raw["candidate_surface_entry_count"]
    if isinstance(entry_count, bool) or not isinstance(entry_count, int) or entry_count < CURRENT_VBENCH_CLAIM_COUNT:
        raise OffsetCalibrationError("power_report candidate surface entry count is incomplete")
    requirements = raw["endpoint_requirements"]
    if not isinstance(requirements, list) or not requirements:
        raise OffsetCalibrationError("power_report must contain endpoint requirements")
    endpoint_ids: list[str] = []
    endpoint_units: list[int] = []
    for index, requirement in enumerate(requirements):
        if not isinstance(requirement, dict):
            raise OffsetCalibrationError(f"power_report endpoint requirement {index} must be an object")
        _exact_keys(
            requirement,
            {"endpoint_id", "independent_units"},
            f"power_report endpoint requirement {index}",
        )
        endpoint_ids.append(
            _identifier(requirement["endpoint_id"], f"power_report endpoint requirement {index}.endpoint_id")
        )
        units = requirement["independent_units"]
        if isinstance(units, bool) or not isinstance(units, int) or units < 1:
            raise OffsetCalibrationError("power_report endpoint independent_units must be a positive integer")
        endpoint_units.append(units)
    if endpoint_ids != sorted(set(endpoint_ids)):
        raise OffsetCalibrationError("power_report endpoint requirements must be unique and sorted")
    if required < max(endpoint_units):
        raise OffsetCalibrationError("power_report.required_independent_units understates an endpoint requirement")
    if raw != computed:
        raise OffsetCalibrationError(
            "power_report is not the exact deterministic report for the supplied frozen design"
        )
    return raw, design_raw, required


def _canonical_operating_point(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OffsetCalibrationError("operating_point must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "classification_rule",
            "raw_score_threshold",
            "target_far_max",
            "target_frr_max",
            "basis_evidence_sha256",
        },
        "operating_point",
    )
    if (
        raw["schema_version"] != OPERATING_POINT_SCHEMA
        or raw["status"] != "frozen"
        or raw["classification_rule"] != CLASSIFICATION_RULE
    ):
        raise OffsetCalibrationError("unsupported correspondence operating point")
    threshold = _number(raw["raw_score_threshold"], "operating_point.raw_score_threshold")
    far = _number(raw["target_far_max"], "operating_point.target_far_max")
    frr = _number(raw["target_frr_max"], "operating_point.target_frr_max")
    if far != 0.01 or frr != 0.05:
        raise OffsetCalibrationError("operating_point must retain the preregistered FAR 0.01 / FRR 0.05 targets")
    return {
        "basis_evidence_sha256": _sha256(raw["basis_evidence_sha256"], "operating_point.basis_evidence_sha256"),
        "classification_rule": CLASSIFICATION_RULE,
        "raw_score_threshold": threshold,
        "schema_version": OPERATING_POINT_SCHEMA,
        "status": "frozen",
        "target_far_max": far,
        "target_frr_max": frr,
    }


def _canonical_dataset_context(  # noqa: PLR0912, PLR0915
    freeze_raw: object,
    manifest_raw: object,
    preregistration_raw: object,
    *,
    expected_dataset_digest: str,
    trusted_preregistration_digest: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, dict[str, Any]], dict[str, str]]:
    if not isinstance(freeze_raw, dict):
        raise OffsetCalibrationError("dataset_freeze must be an object")
    _exact_keys(freeze_raw, {"freeze_id", "core"}, "dataset_freeze")
    freeze_id = _sha256(freeze_raw["freeze_id"], "dataset_freeze.freeze_id")
    if freeze_id != _sha256(expected_dataset_digest, "expected_dataset_digest"):
        raise OffsetCalibrationError("dataset freeze does not match the externally expected dataset digest")
    core = freeze_raw["core"]
    if not isinstance(core, dict):
        raise OffsetCalibrationError("dataset_freeze.core must be an object")
    expected_core = {
        "schema_version",
        "profile",
        "manifest_sha256",
        "rights_ledger_sha256",
        "mapping_sha256",
        "preregistration_sha256",
        "governance_code_sha256",
        "preprocessing_version",
        "preprocessing_tools",
        "split_algorithm",
        "split_seed_sha256",
        "group_fields",
        "artifact_sha256",
        "sample_count",
        "component_count",
        "split_counts",
        "assignments",
        "components",
        "snapshot_sha256",
    }
    _exact_keys(core, expected_core, "dataset_freeze.core")
    if core["schema_version"] != DATASET_FREEZE_SCHEMA or core["profile"] != "product":
        raise OffsetCalibrationError("offset D1 requires a product-profile v2 dataset freeze")
    if core["split_algorithm"] != SPLIT_ALGORITHM:
        raise OffsetCalibrationError(f"dataset freeze split_algorithm must be {SPLIT_ALGORITHM}")
    if _governance_sha256(core) != freeze_id:
        raise OffsetCalibrationError("dataset freeze ID does not bind its core")
    for field in (
        "manifest_sha256",
        "rights_ledger_sha256",
        "mapping_sha256",
        "preregistration_sha256",
        "governance_code_sha256",
        "split_seed_sha256",
    ):
        _sha256(core[field], f"dataset_freeze.core.{field}")
    if not isinstance(core["preprocessing_version"], str) or not core["preprocessing_version"]:
        raise OffsetCalibrationError("dataset freeze lacks a preprocessing version")
    if not isinstance(core["preprocessing_tools"], dict) or not core["preprocessing_tools"]:
        raise OffsetCalibrationError("dataset freeze lacks preprocessing tool bindings")
    group_fields = _canonical_identifiers(core["group_fields"], "dataset_freeze.core.group_fields")
    expected_group_fields = [*GROUP_FIELDS, *HASH_GROUP_FIELDS, "perceptual_duplicate_id", "parent_sample_id"]
    if core["group_fields"] != expected_group_fields or set(group_fields) != set(expected_group_fields):
        raise OffsetCalibrationError("dataset freeze group fields differ from the governance transitive identity set")
    artifact_hashes = core["artifact_sha256"]
    if not isinstance(artifact_hashes, list) or not artifact_hashes:
        raise OffsetCalibrationError("dataset freeze lacks artifact hashes")
    if artifact_hashes != sorted({_sha256(value, "dataset_freeze.core.artifact_sha256") for value in artifact_hashes}):
        raise OffsetCalibrationError("dataset freeze artifact hashes must be unique and sorted")

    if not isinstance(manifest_raw, dict):
        raise OffsetCalibrationError("dataset_manifest must be an object")
    _exact_keys(manifest_raw, {"schema_version", "samples"}, "dataset_manifest")
    if manifest_raw["schema_version"] != DATASET_MANIFEST_SCHEMA:
        raise OffsetCalibrationError("unsupported dataset manifest schema")
    samples = manifest_raw["samples"]
    if (
        not isinstance(samples, list)
        or not samples
        or len(samples) > MAX_MANIFEST_SAMPLES
        or not all(isinstance(sample, dict) for sample in samples)
    ):
        raise OffsetCalibrationError("dataset_manifest.samples must be a non-empty object list")
    sample_ids = [
        _identifier(sample.get("sample_id"), f"dataset sample {index}.sample_id")
        for index, sample in enumerate(samples)
    ]
    if sample_ids != sorted(set(sample_ids)):
        raise OffsetCalibrationError("dataset manifest sample IDs must be unique and sorted")
    for index, sample in enumerate(samples):
        for field in SOURCE_FIELDS:
            _identifier(sample.get(field), f"dataset sample {index}.{field}")
        if not isinstance(sample.get("strata"), dict):
            raise OffsetCalibrationError(f"dataset sample {index}.strata must be an object")
        language = sample.get("language")
        if not isinstance(language, str) or len(language) != 2 or not language.isalpha():
            raise OffsetCalibrationError(f"dataset sample {index}.language must be a two-letter code")
    snapshot_hashes = core["snapshot_sha256"]
    if not isinstance(snapshot_hashes, dict):
        raise OffsetCalibrationError("dataset freeze snapshot hashes must be an object")
    if set(snapshot_hashes) != {
        "manifest.snapshot.json",
        "preregistration.snapshot.json",
        "rights.snapshot.json",
        "viseme-mapping.snapshot.json",
    }:
        raise OffsetCalibrationError("dataset freeze snapshot inventory is incomplete or contains unknown entries")
    expected_manifest_digest = _sha256(
        snapshot_hashes.get("manifest.snapshot.json"),
        "dataset_freeze.core.snapshot_sha256.manifest.snapshot.json",
    )
    if _governance_sha256(manifest_raw) != expected_manifest_digest:
        raise OffsetCalibrationError("dataset manifest does not match the frozen snapshot hash")
    if _governance_sha256(samples) != core["manifest_sha256"]:
        raise OffsetCalibrationError("dataset manifest sample hash does not match the freeze core")
    if core["sample_count"] != len(samples):
        raise OffsetCalibrationError("dataset freeze sample_count does not match the manifest")

    if not isinstance(preregistration_raw, dict) or preregistration_raw.get("status") != "frozen":
        raise OffsetCalibrationError("offset v2 requires a frozen v2 preregistration")
    try:
        preregistration = validate_offset_preregistration(
            preregistration_raw,
            mapping_sha256=core["mapping_sha256"],
            trusted_preregistration_sha256=trusted_preregistration_digest,
        )
    except GovernanceError as error:
        raise OffsetCalibrationError(f"offset preregistration rejected: {error}") from error
    if _governance_sha256(preregistration_raw) != core["preregistration_sha256"]:
        raise OffsetCalibrationError("preregistration does not match the freeze core")
    expected_preregistration_digest = _sha256(
        snapshot_hashes.get("preregistration.snapshot.json"),
        "dataset_freeze.core.snapshot_sha256.preregistration.snapshot.json",
    )
    if _governance_sha256(preregistration_raw) != expected_preregistration_digest:
        raise OffsetCalibrationError("preregistration does not match the frozen snapshot hash")

    assignments = core["assignments"]
    if not isinstance(assignments, dict) or set(assignments) != set(sample_ids):
        raise OffsetCalibrationError("dataset freeze assignments must exactly cover the manifest")
    allowed_splits = {"train", "tune", "design-pilot", "calibration", "test", "ood-test"}
    if not all(isinstance(split, str) and split in allowed_splits for split in assignments.values()):
        raise OffsetCalibrationError("dataset freeze assignments contain an invalid split")
    components = core["components"]
    if not isinstance(components, list) or not components or len(components) > MAX_COMPONENTS:
        raise OffsetCalibrationError("dataset freeze components must be a non-empty list")
    try:
        recomputed_components = build_transitive_components(samples)
    except GovernanceError as error:
        raise OffsetCalibrationError(f"dataset transitive components rejected: {error}") from error
    if components != recomputed_components:
        raise OffsetCalibrationError("dataset freeze components differ from governance recomputation")
    component_by_sample: dict[str, str] = {}
    canonical_components: list[list[str]] = []
    for index, component in enumerate(components):
        ids = _canonical_identifiers(
            component,
            f"dataset component {index}",
            maximum=MAX_MANIFEST_SAMPLES,
        )
        if ids != component:
            raise OffsetCalibrationError("dataset freeze component sample IDs must be sorted")
        component_id = document_sha256({"freeze_id": freeze_id, "sample_ids": ids})
        for sample_id in ids:
            if sample_id in component_by_sample:
                raise OffsetCalibrationError("dataset freeze components overlap")
            component_by_sample[sample_id] = component_id
        if len({assignments.get(sample_id) for sample_id in ids}) != 1:
            raise OffsetCalibrationError("dataset freeze component spans multiple splits")
        canonical_components.append(ids)
    if canonical_components != sorted(canonical_components) or set(component_by_sample) != set(sample_ids):
        raise OffsetCalibrationError("dataset freeze components must be sorted and exactly cover the manifest")
    if core["component_count"] != len(canonical_components):
        raise OffsetCalibrationError("dataset freeze component_count does not match components")
    split_counts = core["split_counts"]
    if not isinstance(split_counts, dict):
        raise OffsetCalibrationError("dataset freeze split_counts must be an object")
    observed_counts = Counter(assignments.values())
    expected_counts = {
        split: observed_counts.get(split, 0)
        for split in ("train", "tune", "design-pilot", "calibration", "test", "ood-test")
    }
    if split_counts != expected_counts:
        raise OffsetCalibrationError("dataset freeze split_counts do not match assignments")
    return (
        freeze_raw,
        manifest_raw,
        preregistration,
        {sample["sample_id"]: sample for sample in samples},
        component_by_sample,
    )


def _canonical_split_manifest(
    raw: object,
    *,
    split_name: str,
    freeze: dict[str, Any],
    samples_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OffsetCalibrationError(f"{split_name} split manifest must be an object")
    _exact_keys(raw, {"freeze_id", "sample_ids", "samples"}, f"{split_name} split manifest")
    if raw["freeze_id"] != freeze["freeze_id"]:
        raise OffsetCalibrationError(f"{split_name} split manifest freeze ID mismatch")
    sample_ids = _canonical_identifiers(
        raw["sample_ids"],
        f"{split_name} split sample_ids",
        maximum=MAX_MANIFEST_SAMPLES,
    )
    if sample_ids != raw["sample_ids"]:
        raise OffsetCalibrationError(f"{split_name} split sample IDs must be sorted")
    samples = raw["samples"]
    if (
        not isinstance(samples, list)
        or [sample.get("sample_id") for sample in samples if isinstance(sample, dict)] != sample_ids
    ):
        raise OffsetCalibrationError(f"{split_name} split samples do not bind sample_ids")
    assignments = freeze["core"]["assignments"]
    expected = sorted(sample_id for sample_id, assigned in assignments.items() if assigned == split_name)
    if sample_ids != expected:
        raise OffsetCalibrationError(f"{split_name} split manifest differs from frozen assignments")
    if any(samples_by_id.get(sample_id) != sample for sample_id, sample in zip(sample_ids, samples, strict=True)):
        raise OffsetCalibrationError(f"{split_name} split manifest differs from the frozen dataset manifest")
    return raw


def _derived_strata(sample: dict[str, Any], fps: int, registered: set[str]) -> list[str]:
    source_strata = sample["strata"]
    candidates = {
        f"fps.{fps}",
        f"language.{sample['language']}",
        f"lighting.{source_strata.get('lighting')}",
        f"motion.{source_strata.get('head_motion')}",
        f"skin.{source_strata.get('skin_tone_fitzpatrick')}",
        f"age.{source_strata.get('age_band')}",
        f"source-domain.{source_strata.get('source_domain')}",
    }
    return sorted(candidates.intersection(registered))


def _canonical_strata_quotas(
    design: dict[str, Any],
    power_report: dict[str, Any],
    registered: list[str],
) -> dict[str, int]:
    raw = design.get("strata_quotas")
    if not isinstance(raw, list) or not raw:
        raise OffsetCalibrationError("frozen D0a design lacks strata quotas")
    quotas: dict[str, int] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise OffsetCalibrationError(f"strata quota {index} must be an object")
        _exact_keys(item, {"stratum_id", "minimum_independent_units"}, f"strata quota {index}")
        stratum_id = _identifier(item["stratum_id"], f"strata quota {index}.stratum_id")
        minimum = item["minimum_independent_units"]
        if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < MIN_INDEPENDENT_UNITS:
            raise OffsetCalibrationError(f"strata quota {stratum_id} must require at least two independent units")
        if stratum_id in quotas:
            raise OffsetCalibrationError("strata quotas must be unique")
        quotas[stratum_id] = minimum
    if registered != sorted(quotas):
        raise OffsetCalibrationError("registered_strata must exactly equal the frozen D0a strata quota catalog")
    if power_report["strata_quotas_digest"] != document_sha256(raw):
        raise OffsetCalibrationError("power report does not bind the frozen D0a strata quotas")
    return dict(sorted(quotas.items()))


def _enforce_strata_quotas(
    cases: list[dict[str, Any]],
    *,
    quotas: dict[str, int],
    partition: str,
) -> None:
    for stratum, minimum in quotas.items():
        components = {
            case["leakage_component_id"]
            for case in cases
            if case.get("in_domain", True) and stratum in case["strata"]
        }
        if len(components) < minimum:
            raise OffsetCalibrationError(
                f"{partition} stratum {stratum} has {len(components)} components; frozen quota requires {minimum}"
            )


def _case_id(
    *,
    source_sample_id: str,
    replicate_id: str,
    fps: int,
    offset_kind: str,
    correspondence_label: bool | None,
) -> str:
    return document_sha256(
        {
            "correspondence_label": correspondence_label,
            "fps": fps,
            "offset_kind": offset_kind,
            "replicate_id": replicate_id,
            "source_sample_id": source_sample_id,
        }
    )


def _canonical_control_case(  # noqa: PLR0912, PLR0915
    raw: object,
    *,
    context: str,
    registered_strata: set[str],
    fit_case: bool,
    allowed_sample_ids: set[str],
    samples_by_id: dict[str, dict[str, Any]],
    component_by_sample: dict[str, str],
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OffsetCalibrationError(f"{context} must be an object")
    forbidden = {"lagConfidence", "lag_confidence", "within_one_frame_probability"}.intersection(raw)
    if forbidden:
        raise OffsetCalibrationError(
            f"{context} presents raw lagConfidence as probability; use correspondence_label plus raw_score"
        )
    expected_keys = {
        "case_id",
        "source_sample_id",
        "replicate_id",
        "strata",
        "in_domain",
        "offset_kind",
        "fps",
        "expected_offset_ms",
        "predicted_offset_ms",
        "raw_score",
        "correspondence_label",
        "abstained",
    }
    _exact_keys(raw, expected_keys, context)
    source_sample_id = _identifier(raw["source_sample_id"], f"{context}.source_sample_id")
    if source_sample_id not in allowed_sample_ids:
        raise OffsetCalibrationError(f"{context} source sample is absent from its frozen split")
    replicate_id = _identifier(raw["replicate_id"], f"{context}.replicate_id")
    fps = raw["fps"]
    if isinstance(fps, bool) or not isinstance(fps, int) or fps not in REQUIRED_FPS:
        raise OffsetCalibrationError(f"{context}.fps must be one of {list(REQUIRED_FPS)}")
    frame_duration = 1000.0 / fps
    strata = _canonical_identifiers(raw["strata"], f"{context}.strata")
    expected_strata = _derived_strata(samples_by_id[source_sample_id], fps, registered_strata)
    if strata != expected_strata or f"fps.{fps}" not in strata:
        raise OffsetCalibrationError(f"{context}.strata must be derived from the frozen sample and fps")
    in_domain = raw["in_domain"]
    abstained = raw["abstained"]
    if not isinstance(in_domain, bool) or not isinstance(abstained, bool):
        raise OffsetCalibrationError(f"{context}.in_domain and abstained must be boolean")
    if fit_case and (not in_domain or abstained):
        raise OffsetCalibrationError("fit_cases must be in-domain, non-abstained controls")
    label = raw["correspondence_label"]
    offset_kind = raw["offset_kind"]
    if in_domain:
        if not isinstance(label, bool):
            raise OffsetCalibrationError(f"{context}.correspondence_label must be boolean for in-domain controls")
        if offset_kind not in GRID_MULTIPLIERS:
            raise OffsetCalibrationError(f"{context}.offset_kind is not in the frozen seven-point grid")
        expected_offset = _number(raw["expected_offset_ms"], f"{context}.expected_offset_ms")
        grid_offset = GRID_MULTIPLIERS[offset_kind] * frame_duration
        if not math.isclose(expected_offset, grid_offset, rel_tol=0, abs_tol=1e-9):
            raise OffsetCalibrationError(f"{context}.expected_offset_ms is not the exact fps-derived grid point")
    else:
        if label is not None or raw["expected_offset_ms"] is not None or offset_kind != "ood":
            raise OffsetCalibrationError(f"{context} OOD control must use null correspondence/offset and ood kind")
        expected_offset = None
    predicted_raw = raw["predicted_offset_ms"]
    score_raw = raw["raw_score"]
    if abstained:
        if predicted_raw is not None or score_raw is not None:
            raise OffsetCalibrationError(f"{context} abstention must use null prediction and raw_score")
        predicted_offset = None
        raw_score = None
    else:
        predicted_offset = _number(predicted_raw, f"{context}.predicted_offset_ms")
        if not -5000 <= predicted_offset <= 5000:
            raise OffsetCalibrationError(f"{context}.predicted_offset_ms is outside -5000..5000")
        raw_score = _number(score_raw, f"{context}.raw_score")
    case_id = _sha256(raw["case_id"], f"{context}.case_id")
    derived_case_id = _case_id(
        source_sample_id=source_sample_id,
        replicate_id=replicate_id,
        fps=fps,
        offset_kind=offset_kind,
        correspondence_label=label,
    )
    if case_id != derived_case_id:
        raise OffsetCalibrationError(f"{context}.case_id is not derived from the frozen control identity")
    sample = samples_by_id[source_sample_id]
    return {
        "abstained": abstained,
        "case_id": case_id,
        "correspondence_label": label,
        "expected_offset_ms": expected_offset,
        "face_identity_id": sample["face_identity_id"],
        "fps": fps,
        "frame_duration_ms": frame_duration,
        "in_domain": in_domain,
        "leakage_component_id": component_by_sample[source_sample_id],
        "offset_kind": offset_kind,
        "predicted_offset_ms": predicted_offset,
        "raw_score": raw_score,
        "recording_session_id": sample["recording_session_id"],
        "replicate_id": replicate_id,
        "source_asset_id": sample["source_asset_id"],
        "source_collection_id": sample["source_collection_id"],
        "source_sample_id": source_sample_id,
        "strata": strata,
        "voice_speaker_id": sample["voice_speaker_id"],
    }


def _enforce_transitive_components(cases: list[dict[str, Any]]) -> None:
    for field in SOURCE_FIELDS:
        components_by_value: dict[str, set[str]] = defaultdict(set)
        for case in cases:
            components_by_value[case[field]].add(case["leakage_component_id"])
        inconsistent = sorted(value for value, components in components_by_value.items() if len(components) != 1)
        if inconsistent:
            raise OffsetCalibrationError(
                f"{field} maps to multiple transitive leakage components: " + ", ".join(inconsistent)
            )


def _enforce_partition_disjointness(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    *,
    left_name: str,
    right_name: str,
) -> None:
    for field in INDEPENDENCE_FIELDS:
        overlap = sorted({case[field] for case in left}.intersection(case[field] for case in right))
        if overlap:
            raise OffsetCalibrationError(f"{left_name}/{right_name} {field} overlap: " + ", ".join(overlap))


def _enforce_balanced_grid(
    cases: list[dict[str, Any]],
    *,
    partition: str,
    required_independent_units: int,
) -> None:
    in_domain = [case for case in cases if case["in_domain"]]
    components = sorted({case["leakage_component_id"] for case in in_domain})
    if len(components) < required_independent_units:
        raise OffsetCalibrationError(
            f"{partition} has {len(components)} independent units; D1 requires {required_independent_units}"
        )
    expected_cells = {
        (fps, kind, label) for fps in REQUIRED_FPS for kind in REQUIRED_OFFSET_KINDS for label in (False, True)
    }
    for component in components:
        counts = Counter(
            (case["fps"], case["offset_kind"], case["correspondence_label"])
            for case in in_domain
            if case["leakage_component_id"] == component
        )
        if counts != Counter(dict.fromkeys(expected_cells, GRID_REPLICATES_PER_CELL)):
            raise OffsetCalibrationError(
                f"{partition} component {component} must contain exactly one control for every seven-point "
                "24/25/30-fps and correspondence-label grid cell"
            )


def _canonical_partition(
    raw: object,
    *,
    name: str,
    registered_strata: set[str],
    fit_partition: bool,
    allowed_sample_ids: set[str],
    samples_by_id: dict[str, dict[str, Any]],
    component_by_sample: dict[str, str],
    required_independent_units: int,
    strata_quotas: dict[str, int],
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_CASES:
        raise OffsetCalibrationError(f"{name} must contain 2 to {MAX_CASES} controls")
    cases = [
        _canonical_control_case(
            item,
            context=f"{name}[{index}]",
            registered_strata=registered_strata,
            fit_case=fit_partition,
            allowed_sample_ids=allowed_sample_ids,
            samples_by_id=samples_by_id,
            component_by_sample=component_by_sample,
        )
        for index, item in enumerate(raw)
    ]
    case_ids = [case["case_id"] for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise OffsetCalibrationError(f"{name} must contain unique case IDs")
    cases.sort(key=lambda case: case["case_id"])
    _enforce_transitive_components(cases)
    _enforce_balanced_grid(cases, partition=name, required_independent_units=required_independent_units)
    _enforce_strata_quotas(cases, quotas=strata_quotas, partition=name)
    ood = [case for case in cases if not case["in_domain"]]
    if fit_partition and ood:
        raise OffsetCalibrationError("fit_cases must not contain OOD controls")
    if not fit_partition:
        ood_counts = Counter(case["leakage_component_id"] for case in ood)
        in_domain_components = {case["leakage_component_id"] for case in cases if case["in_domain"]}
        if set(ood_counts) != in_domain_components or set(ood_counts.values()) != {1}:
            raise OffsetCalibrationError(
                "evaluation_cases need exactly one OOD control for every powered in-domain component"
            )
    return cases


def build_offset_control_deck(
    raw: object,
    *,
    expected_dataset_digest: str,
    trusted_preregistration_digest: str,
) -> dict[str, Any]:
    """Validate and canonicalize a frozen-tune-split offset control deck."""

    if not isinstance(raw, dict):
        raise OffsetCalibrationError("offset control deck must be an object")
    expected = {
        "schema_version",
        "calibration_method",
        "split_algorithm",
        "raw_score_semantics",
        "dataset_freeze",
        "dataset_manifest",
        "preregistration",
        "fit_split_manifest",
        "design",
        "power_report",
        "operating_point",
        "offset_evaluator_digest",
        "registered_strata",
        "fit_cases",
    }
    _exact_keys(raw, expected, "offset control deck")
    if raw["schema_version"] != OFFSET_CONTROL_DECK_SCHEMA:
        raise OffsetCalibrationError("unsupported offset control deck schema")
    if raw["calibration_method"] != CALIBRATION_METHOD:
        raise OffsetCalibrationError(f"calibration_method must be {CALIBRATION_METHOD}")
    if raw["split_algorithm"] != SPLIT_ALGORITHM:
        raise OffsetCalibrationError(f"split_algorithm must be {SPLIT_ALGORITHM}")
    if raw["raw_score_semantics"] != RAW_SCORE_SEMANTICS:
        raise OffsetCalibrationError("raw score must be declared as uncalibrated lag peak-separation evidence")
    freeze, manifest, preregistration, samples_by_id, component_by_sample = _canonical_dataset_context(
        raw["dataset_freeze"],
        raw["dataset_manifest"],
        raw["preregistration"],
        expected_dataset_digest=expected_dataset_digest,
        trusted_preregistration_digest=trusted_preregistration_digest,
    )
    fit_split = _canonical_split_manifest(
        raw["fit_split_manifest"], split_name=FIT_SPLIT, freeze=freeze, samples_by_id=samples_by_id
    )
    power_report, design, required_units = _canonical_power_report(raw["power_report"], raw["design"])
    operating_point = _canonical_operating_point(raw["operating_point"])
    registered = _canonical_identifiers(raw["registered_strata"], "registered_strata")
    if not {f"fps.{fps}" for fps in REQUIRED_FPS}.issubset(registered):
        raise OffsetCalibrationError("registered_strata must include fps.24, fps.25, and fps.30")
    strata_quotas = _canonical_strata_quotas(design, power_report, registered)
    fit_cases = _canonical_partition(
        raw["fit_cases"],
        name="fit_cases",
        registered_strata=set(registered),
        fit_partition=True,
        allowed_sample_ids=set(fit_split["sample_ids"]),
        samples_by_id=samples_by_id,
        component_by_sample=component_by_sample,
        required_independent_units=required_units,
        strata_quotas=strata_quotas,
    )
    return {
        "calibration_method": CALIBRATION_METHOD,
        "dataset_freeze": freeze,
        "dataset_manifest": manifest,
        "design": design,
        "fit_cases": fit_cases,
        "fit_split_manifest": fit_split,
        "offset_evaluator_digest": _sha256(raw["offset_evaluator_digest"], "offset_evaluator_digest"),
        "operating_point": operating_point,
        "power_report": power_report,
        "preregistration": preregistration,
        "raw_score_semantics": RAW_SCORE_SEMANTICS,
        "registered_strata": registered,
        "schema_version": OFFSET_CONTROL_DECK_SCHEMA,
        "split_algorithm": SPLIT_ALGORITHM,
        "strata_quotas": strata_quotas,
    }


def _isotonic_knots(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter(case["leakage_component_id"] for case in cases)
    observations: dict[float, list[tuple[float, float]]] = defaultdict(list)
    labels: set[bool] = set()
    for case in cases:
        raw_score = case["raw_score"]
        label = case["correspondence_label"]
        if raw_score is None or not isinstance(label, bool):
            raise OffsetCalibrationError("fit_cases must have raw scores and correspondence labels")
        component_weight = 1.0 / counts[case["leakage_component_id"]]
        observations[raw_score].append((component_weight * int(label), component_weight))
        labels.add(label)
    if labels != {False, True}:
        raise OffsetCalibrationError("isotonic fit needs both correspondence labels")
    if len(observations) < 2:
        raise OffsetCalibrationError("isotonic fit needs at least two distinct raw scores")
    blocks: list[dict[str, Any]] = []
    ordered_scores = sorted(observations)
    for index, score in enumerate(ordered_scores):
        successes = sum(value[0] for value in observations[score])
        weight = sum(value[1] for value in observations[score])
        blocks.append({"first": index, "last": index, "successes": successes, "weight": weight})
        while len(blocks) >= 2:
            left = blocks[-2]
            right = blocks[-1]
            if left["successes"] / left["weight"] <= right["successes"] / right["weight"]:
                break
            blocks[-2:] = [
                {
                    "first": left["first"],
                    "last": right["last"],
                    "successes": left["successes"] + right["successes"],
                    "weight": left["weight"] + right["weight"],
                }
            ]
    fitted: list[float] = [0.0] * len(ordered_scores)
    for block in blocks:
        probability = block["successes"] / block["weight"]
        for index in range(block["first"], block["last"] + 1):
            fitted[index] = probability
    return [
        {
            "component_equivalent_weight": sum(value[1] for value in observations[score]),
            "correspondence_probability": fitted[index],
            "raw_score": score,
        }
        for index, score in enumerate(ordered_scores)
    ]


def fit_speaker_disjoint_isotonic(
    raw: object,
    *,
    expected_dataset_digest: str,
    trusted_preregistration_digest: str,
) -> dict[str, Any]:
    """Fit deterministic component-weighted PAVA without evaluation outcomes."""

    deck = build_offset_control_deck(
        raw,
        expected_dataset_digest=expected_dataset_digest,
        trusted_preregistration_digest=trusted_preregistration_digest,
    )
    fit_cases = deck["fit_cases"]
    freeze = deck["dataset_freeze"]
    power_report = deck["power_report"]
    operating_point = deck["operating_point"]
    core = {
        "calibration_method": CALIBRATION_METHOD,
        "control_deck_digest": document_sha256(deck),
        "dataset_digest": freeze["freeze_id"],
        "dataset_manifest_digest": document_sha256(deck["dataset_manifest"]),
        "design_digest": power_report["design_digest"],
        "design_report_digest": document_sha256(power_report),
        "fit_case_ids": sorted(case["case_id"] for case in fit_cases),
        "fit_face_identity_ids": sorted({case["face_identity_id"] for case in fit_cases}),
        "fit_leakage_component_ids": sorted({case["leakage_component_id"] for case in fit_cases}),
        "fit_recording_session_ids": sorted({case["recording_session_id"] for case in fit_cases}),
        "fit_source_asset_ids": sorted({case["source_asset_id"] for case in fit_cases}),
        "fit_source_collection_ids": sorted({case["source_collection_id"] for case in fit_cases}),
        "fit_split_manifest_digest": document_sha256(deck["fit_split_manifest"]),
        "fit_voice_speaker_ids": sorted({case["voice_speaker_id"] for case in fit_cases}),
        "interpolation": INTERPOLATION,
        "knots": _isotonic_knots(fit_cases),
        "offset_evaluator_digest": deck["offset_evaluator_digest"],
        "operating_point_digest": document_sha256(operating_point),
        "power_report_digest": document_sha256(power_report),
        "preregistration_digest": freeze["core"]["preregistration_sha256"],
        "raw_score_semantics": RAW_SCORE_SEMANTICS,
        "raw_score_threshold": operating_point["raw_score_threshold"],
        "required_independent_units": power_report["required_independent_units"],
        "schema_version": OFFSET_CALIBRATOR_SCHEMA,
        "strata_quotas_digest": power_report["strata_quotas_digest"],
        "weight_semantics": WEIGHT_SEMANTICS,
    }
    return {**core, "calibrator_sha256": document_sha256(core)}


def _validate_calibrator(raw: object) -> dict[str, Any]:  # noqa: PLR0912
    if not isinstance(raw, dict):
        raise OffsetCalibrationError("offset calibrator must be an object")
    expected = {
        "schema_version",
        "calibration_method",
        "raw_score_semantics",
        "weight_semantics",
        "interpolation",
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "fit_split_manifest_digest",
        "power_report_digest",
        "operating_point_digest",
        "raw_score_threshold",
        "required_independent_units",
        "strata_quotas_digest",
        "fit_case_ids",
        "fit_voice_speaker_ids",
        "fit_face_identity_ids",
        "fit_recording_session_ids",
        "fit_source_asset_ids",
        "fit_source_collection_ids",
        "fit_leakage_component_ids",
        "knots",
        "calibrator_sha256",
    }
    _exact_keys(raw, expected, "offset calibrator")
    if raw["schema_version"] != OFFSET_CALIBRATOR_SCHEMA:
        raise OffsetCalibrationError("unsupported offset calibrator schema")
    if (
        raw["calibration_method"] != CALIBRATION_METHOD
        or raw["raw_score_semantics"] != RAW_SCORE_SEMANTICS
        or raw["weight_semantics"] != WEIGHT_SEMANTICS
        or raw["interpolation"] != INTERPOLATION
    ):
        raise OffsetCalibrationError("offset calibrator method or score semantics changed")
    for field in (
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "fit_split_manifest_digest",
        "power_report_digest",
        "operating_point_digest",
        "strata_quotas_digest",
        "calibrator_sha256",
    ):
        _sha256(raw[field], field)
    threshold = _number(raw["raw_score_threshold"], "raw_score_threshold")
    required_units = raw["required_independent_units"]
    if (
        isinstance(required_units, bool)
        or not isinstance(required_units, int)
        or required_units < MIN_INDEPENDENT_UNITS
    ):
        raise OffsetCalibrationError("required_independent_units must be a non-null integer >= 2")
    identifier_fields = (
        "fit_case_ids",
        "fit_voice_speaker_ids",
        "fit_face_identity_ids",
        "fit_recording_session_ids",
        "fit_source_asset_ids",
        "fit_source_collection_ids",
        "fit_leakage_component_ids",
    )
    for field in identifier_fields:
        maximum = MAX_CASES if field == "fit_case_ids" else MAX_COMPONENTS
        values = _canonical_identifiers(raw[field], field, maximum=maximum)
        if values != raw[field]:
            raise OffsetCalibrationError(f"{field} must be canonical and sorted")
    knots_raw = raw["knots"]
    if not isinstance(knots_raw, list) or not 2 <= len(knots_raw) <= MAX_CALIBRATOR_KNOTS:
        raise OffsetCalibrationError(f"offset calibrator needs 2 to {MAX_CALIBRATOR_KNOTS} knots")
    knots: list[dict[str, Any]] = []
    for index, knot in enumerate(knots_raw):
        if not isinstance(knot, dict):
            raise OffsetCalibrationError(f"calibrator knot {index} must be an object")
        _exact_keys(
            knot,
            {"raw_score", "correspondence_probability", "component_equivalent_weight"},
            f"calibrator knot {index}",
        )
        score = _number(knot["raw_score"], f"calibrator knot {index}.raw_score")
        probability = _number(knot["correspondence_probability"], f"calibrator knot {index}.correspondence_probability")
        weight = _number(knot["component_equivalent_weight"], f"calibrator knot {index}.component_equivalent_weight")
        if not 0 <= probability <= 1 or weight <= 0:
            raise OffsetCalibrationError(f"calibrator knot {index} has invalid probability or weight")
        knots.append(
            {
                "component_equivalent_weight": weight,
                "correspondence_probability": probability,
                "raw_score": score,
            }
        )
    scores = [knot["raw_score"] for knot in knots]
    probabilities = [knot["correspondence_probability"] for knot in knots]
    if scores != sorted(set(scores)) or probabilities != sorted(probabilities):
        raise OffsetCalibrationError("calibrator knots must have increasing scores and monotone probabilities")
    canonical = {**raw, "knots": knots, "raw_score_threshold": threshold}
    core = {key: value for key, value in canonical.items() if key != "calibrator_sha256"}
    if canonical["calibrator_sha256"] != document_sha256(core):
        raise OffsetCalibrationError("offset calibrator digest mismatch")
    return canonical


def _interpolate(knots: list[dict[str, Any]], raw_score: float) -> float:
    if raw_score <= knots[0]["raw_score"]:
        return knots[0]["correspondence_probability"]
    if raw_score >= knots[-1]["raw_score"]:
        return knots[-1]["correspondence_probability"]
    for left, right in pairwise(knots):
        if raw_score <= right["raw_score"]:
            span = right["raw_score"] - left["raw_score"]
            fraction = (raw_score - left["raw_score"]) / span
            return left["correspondence_probability"] + fraction * (
                right["correspondence_probability"] - left["correspondence_probability"]
            )
    raise OffsetCalibrationError("raw score could not be interpolated")


def _application_cases(  # noqa: PLR0912, PLR0915
    raw: object, model: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[str], str]:
    if not isinstance(raw, dict):
        raise OffsetCalibrationError("offset calibration application must be an object")
    expected = {
        "schema_version",
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "evaluation_split_manifest_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "power_report_digest",
        "operating_point_digest",
        "strata_quotas_digest",
        "required_independent_units",
        "registered_strata",
        "cases",
    }
    _exact_keys(raw, expected, "offset calibration application")
    if raw["schema_version"] != OFFSET_CALIBRATION_APPLICATION_SCHEMA:
        raise OffsetCalibrationError("unsupported offset calibration application schema")
    bindings = (
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "power_report_digest",
        "operating_point_digest",
        "strata_quotas_digest",
    )
    for field in bindings:
        if _sha256(raw[field], f"calibration application {field}") != model[field]:
            raise OffsetCalibrationError(f"calibration application {field} mismatch")
    evaluation_digest = _sha256(
        raw["evaluation_split_manifest_digest"], "calibration application evaluation_split_manifest_digest"
    )
    if raw["required_independent_units"] != model["required_independent_units"]:
        raise OffsetCalibrationError("calibration application required_independent_units mismatch")
    registered = _canonical_identifiers(raw["registered_strata"], "registered_strata")
    cases_raw = raw["cases"]
    if not isinstance(cases_raw, list) or not 2 <= len(cases_raw) <= MAX_CASES:
        raise OffsetCalibrationError(
            f"calibration application cases must contain 2 to {MAX_CASES} observations"
        )
    cases: list[dict[str, Any]] = []
    expected_case_keys = {
        "abstained",
        "case_id",
        "correspondence_label",
        "expected_offset_ms",
        "face_identity_id",
        "fps",
        "frame_duration_ms",
        "in_domain",
        "leakage_component_id",
        "offset_kind",
        "predicted_offset_ms",
        "raw_score",
        "recording_session_id",
        "replicate_id",
        "source_asset_id",
        "source_collection_id",
        "source_sample_id",
        "strata",
        "voice_speaker_id",
    }
    for index, case in enumerate(cases_raw):
        if not isinstance(case, dict):
            raise OffsetCalibrationError(f"calibration application case {index} must be an object")
        context = f"calibration application case {index}"
        _exact_keys(case, expected_case_keys, context)
        canonical = dict(case)
        canonical["case_id"] = _sha256(case["case_id"], f"{context}.case_id")
        canonical["leakage_component_id"] = _sha256(
            case["leakage_component_id"], f"{context}.leakage_component_id"
        )
        for field in (
            "face_identity_id",
            "recording_session_id",
            "replicate_id",
            "source_asset_id",
            "source_collection_id",
            "source_sample_id",
            "voice_speaker_id",
        ):
            canonical[field] = _identifier(case[field], f"{context}.{field}")
        if not isinstance(case["in_domain"], bool) or not isinstance(case["abstained"], bool):
            raise OffsetCalibrationError(f"{context} in_domain and abstained must be boolean")
        fps = case["fps"]
        if isinstance(fps, bool) or not isinstance(fps, int) or fps not in REQUIRED_FPS:
            raise OffsetCalibrationError(f"{context}.fps must be one of {list(REQUIRED_FPS)}")
        canonical["strata"] = _canonical_identifiers(case["strata"], f"{context}.strata")
        if not set(canonical["strata"]).issubset(registered) or f"fps.{fps}" not in canonical["strata"]:
            raise OffsetCalibrationError(f"{context}.strata are unregistered or omit fps")
        frame_duration = _number(case["frame_duration_ms"], f"{context}.frame_duration_ms")
        if not math.isclose(frame_duration, 1000.0 / fps, rel_tol=0, abs_tol=1e-9):
            raise OffsetCalibrationError(f"{context}.frame_duration_ms is not fps-derived")
        canonical["frame_duration_ms"] = frame_duration
        if case["in_domain"]:
            if not isinstance(case["correspondence_label"], bool) or case["offset_kind"] not in GRID_MULTIPLIERS:
                raise OffsetCalibrationError(f"{context} has an invalid label or offset kind")
            expected_offset = _number(case["expected_offset_ms"], f"{context}.expected_offset_ms")
            if not math.isclose(
                expected_offset,
                GRID_MULTIPLIERS[case["offset_kind"]] * frame_duration,
                rel_tol=0,
                abs_tol=1e-9,
            ):
                raise OffsetCalibrationError(f"{context}.expected_offset_ms is outside the frozen grid")
            canonical["expected_offset_ms"] = expected_offset
        elif (
            case["correspondence_label"] is not None
            or case["offset_kind"] != "ood"
            or case["expected_offset_ms"] is not None
        ):
            raise OffsetCalibrationError(f"{context} has invalid OOD semantics")
        if case["abstained"]:
            if case["predicted_offset_ms"] is not None or case["raw_score"] is not None:
                raise OffsetCalibrationError(f"{context} abstention must null prediction and raw_score")
        else:
            canonical["predicted_offset_ms"] = _number(
                case["predicted_offset_ms"], f"{context}.predicted_offset_ms"
            )
            if not -5000 <= canonical["predicted_offset_ms"] <= 5000:
                raise OffsetCalibrationError(f"{context}.predicted_offset_ms is outside -5000..5000")
            canonical["raw_score"] = _number(case["raw_score"], f"{context}.raw_score")
        if canonical["case_id"] != _case_id(
            source_sample_id=canonical["source_sample_id"],
            replicate_id=canonical["replicate_id"],
            fps=fps,
            offset_kind=case["offset_kind"],
            correspondence_label=case["correspondence_label"],
        ):
            raise OffsetCalibrationError(f"{context}.case_id is not source-derived")
        cases.append(canonical)
    if [case["case_id"] for case in cases] != sorted({case["case_id"] for case in cases}):
        raise OffsetCalibrationError("calibration application case IDs must be unique and sorted")
    _enforce_balanced_grid(
        cases,
        partition="application cases",
        required_independent_units=model["required_independent_units"],
    )
    fit_fields = {
        "voice_speaker_id": "fit_voice_speaker_ids",
        "face_identity_id": "fit_face_identity_ids",
        "recording_session_id": "fit_recording_session_ids",
        "source_asset_id": "fit_source_asset_ids",
        "source_collection_id": "fit_source_collection_ids",
        "leakage_component_id": "fit_leakage_component_ids",
    }
    for field, fit_field in fit_fields.items():
        overlap = sorted(set(model[fit_field]).intersection(case[field] for case in cases))
        if overlap:
            raise OffsetCalibrationError(f"calibration application {field} overlap: " + ", ".join(overlap))
    _enforce_transitive_components(cases)
    return cases, registered, evaluation_digest


def apply_offset_calibrator(calibrator: object, raw: object) -> dict[str, Any]:
    """Apply a digest-bound calibrator to a manifest-validated disjoint deck."""

    model = _validate_calibrator(calibrator)
    try:
        cases, registered, evaluation_digest = _application_cases(raw, model)
    except OffsetCalibrationError as error:
        raise OffsetApplicationCaseError(str(error)) from error
    calibrated_cases: list[dict[str, Any]] = []
    for case in cases:
        probability = None if case["abstained"] else _interpolate(model["knots"], case["raw_score"])
        calibrated_cases.append({**case, "correspondence_probability": probability})
    core = {
        "calibrator_sha256": model["calibrator_sha256"],
        "cases": calibrated_cases,
        "control_deck_digest": model["control_deck_digest"],
        "evaluation_split_manifest_digest": evaluation_digest,
        "registered_strata": registered,
        "schema_version": OFFSET_CALIBRATED_CASES_SCHEMA,
    }
    return {**core, "calibrated_cases_sha256": document_sha256(core)}


def _canonical_output_cases(  # noqa: PLR0912
    raw: object,
    *,
    allowed_sample_ids: set[str],
    samples_by_id: dict[str, dict[str, Any]],
    component_by_sample: dict[str, str],
    model: dict[str, Any],
    registered_strata: set[str],
    strata_quotas: dict[str, int],
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_CASES:
        raise OffsetCalibrationError(f"output cases must contain 2 to {MAX_CASES} observations")
    cases: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise OffsetCalibrationError(f"output case {index} must be an object")
        _exact_keys(
            item,
            {"output_id", "source_sample_id", "replicate_id", "fps", "strata", "estimated_offset_ms"},
            f"output case {index}",
        )
        source_sample_id = _identifier(item["source_sample_id"], f"output case {index}.source_sample_id")
        if source_sample_id not in allowed_sample_ids:
            raise OffsetCalibrationError(f"output case {index} source sample is absent from evaluation split")
        replicate_id = _identifier(item["replicate_id"], f"output case {index}.replicate_id")
        fps = item["fps"]
        if isinstance(fps, bool) or not isinstance(fps, int) or fps not in REQUIRED_FPS:
            raise OffsetCalibrationError(f"output case {index}.fps must be one of {list(REQUIRED_FPS)}")
        strata = _canonical_identifiers(item["strata"], f"output case {index}.strata")
        expected_strata = _derived_strata(samples_by_id[source_sample_id], fps, registered_strata)
        if strata != expected_strata:
            raise OffsetCalibrationError(f"output case {index}.strata must be manifest- and fps-derived")
        output_id = _sha256(item["output_id"], f"output case {index}.output_id")
        if output_id != document_sha256(
            {"fps": fps, "replicate_id": replicate_id, "source_sample_id": source_sample_id}
        ):
            raise OffsetCalibrationError(f"output case {index}.output_id is not source-derived")
        estimate = _number(item["estimated_offset_ms"], f"output case {index}.estimated_offset_ms")
        if not -5000 <= estimate <= 5000:
            raise OffsetCalibrationError(f"output case {index}.estimated_offset_ms is outside -5000..5000")
        sample = samples_by_id[source_sample_id]
        cases.append(
            {
                "estimated_offset_ms": estimate,
                "face_identity_id": sample["face_identity_id"],
                "fps": fps,
                "leakage_component_id": component_by_sample[source_sample_id],
                "output_id": output_id,
                "recording_session_id": sample["recording_session_id"],
                "replicate_id": replicate_id,
                "source_asset_id": sample["source_asset_id"],
                "source_collection_id": sample["source_collection_id"],
                "source_sample_id": source_sample_id,
                "strata": strata,
                "voice_speaker_id": sample["voice_speaker_id"],
            }
        )
    output_ids = [case["output_id"] for case in cases]
    if len(output_ids) != len(set(output_ids)):
        raise OffsetCalibrationError("output cases must have unique output IDs")
    cases.sort(key=lambda case: case["output_id"])
    components = {case["leakage_component_id"] for case in cases}
    if len(components) < model["required_independent_units"]:
        raise OffsetCalibrationError(
            f"output cases have {len(components)} independent units; D1 requires {model['required_independent_units']}"
        )
    component_counts = Counter(case["leakage_component_id"] for case in cases)
    if set(component_counts.values()) != {1}:
        raise OffsetCalibrationError("output cases must contain exactly one final output per independent component")
    fit_fields = {
        "voice_speaker_id": "fit_voice_speaker_ids",
        "face_identity_id": "fit_face_identity_ids",
        "recording_session_id": "fit_recording_session_ids",
        "source_asset_id": "fit_source_asset_ids",
        "source_collection_id": "fit_source_collection_ids",
        "leakage_component_id": "fit_leakage_component_ids",
    }
    for field, fit_field in fit_fields.items():
        overlap = sorted(set(model[fit_field]).intersection(case[field] for case in cases))
        if overlap:
            raise OffsetCalibrationError(f"fit/output {field} overlap: " + ", ".join(overlap))
    _enforce_transitive_components(cases)
    _enforce_strata_quotas(cases, quotas=strata_quotas, partition="output cases")
    return cases


def _canonical_observation_deck(
    raw: object,
    *,
    control_deck: dict[str, Any],
    model: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OffsetCalibrationError("offset observation deck must be an object")
    expected = {
        "schema_version",
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "evaluation_split_manifest",
        "output_split_manifest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "power_report_digest",
        "operating_point_digest",
        "strata_quotas_digest",
        "required_independent_units",
        "abstention_policy_digest",
        "release_digest",
        "strata_plan_digest",
        "bootstrap",
        "registered_strata",
        "calibration_cases",
        "output_cases",
    }
    _exact_keys(raw, expected, "offset observation deck")
    if raw["schema_version"] != OFFSET_OBSERVATION_DECK_SCHEMA:
        raise OffsetCalibrationError("unsupported offset observation deck schema")
    model_bindings = (
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "power_report_digest",
        "operating_point_digest",
        "strata_quotas_digest",
    )
    for field in model_bindings:
        if _sha256(raw[field], f"observation {field}") != model[field]:
            raise OffsetCalibrationError(f"observation deck {field} mismatch")
    if raw["required_independent_units"] != model["required_independent_units"]:
        raise OffsetCalibrationError("observation deck required_independent_units mismatch")
    bound_digests = {
        field: _sha256(raw[field], f"observation {field}")
        for field in ("abstention_policy_digest", "release_digest", "strata_plan_digest")
    }
    if bound_digests["strata_plan_digest"] != model["strata_quotas_digest"]:
        raise OffsetCalibrationError("observation strata_plan_digest does not match frozen D0a quotas")
    registered = _canonical_identifiers(raw["registered_strata"], "observation registered_strata")
    if registered != control_deck["registered_strata"]:
        raise OffsetCalibrationError("observation deck registered strata mismatch")
    freeze = control_deck["dataset_freeze"]
    samples_by_id = {sample["sample_id"]: sample for sample in control_deck["dataset_manifest"]["samples"]}
    component_by_sample: dict[str, str] = {}
    for component in freeze["core"]["components"]:
        component_id = document_sha256({"freeze_id": freeze["freeze_id"], "sample_ids": component})
        component_by_sample.update(dict.fromkeys(component, component_id))
    evaluation_split = _canonical_split_manifest(
        raw["evaluation_split_manifest"],
        split_name=EVALUATION_SPLIT,
        freeze=freeze,
        samples_by_id=samples_by_id,
    )
    output_split = _canonical_split_manifest(
        raw["output_split_manifest"],
        split_name=OUTPUT_SPLIT,
        freeze=freeze,
        samples_by_id=samples_by_id,
    )
    strata_quotas = control_deck["strata_quotas"]
    calibration_cases = _canonical_partition(
        raw["calibration_cases"],
        name="observation calibration_cases",
        registered_strata=set(registered),
        fit_partition=False,
        allowed_sample_ids=set(evaluation_split["sample_ids"]),
        samples_by_id=samples_by_id,
        component_by_sample=component_by_sample,
        required_independent_units=model["required_independent_units"],
        strata_quotas=strata_quotas,
    )
    _enforce_partition_disjointness(
        control_deck["fit_cases"], calibration_cases, left_name="fit", right_name="evaluation"
    )
    output_cases = _canonical_output_cases(
        raw["output_cases"],
        allowed_sample_ids=set(output_split["sample_ids"]),
        samples_by_id=samples_by_id,
        component_by_sample=component_by_sample,
        model=model,
        registered_strata=set(registered),
        strata_quotas=strata_quotas,
    )
    _enforce_partition_disjointness(
        calibration_cases,
        output_cases,
        left_name="calibration",
        right_name="output",
    )
    return {
        "abstention_policy_digest": bound_digests["abstention_policy_digest"],
        "bootstrap": _canonical_bootstrap(raw["bootstrap"]),
        "calibration_cases": calibration_cases,
        "control_deck_digest": model["control_deck_digest"],
        "dataset_digest": model["dataset_digest"],
        "dataset_manifest_digest": model["dataset_manifest_digest"],
        "design_digest": model["design_digest"],
        "design_report_digest": model["design_report_digest"],
        "evaluation_split_manifest": evaluation_split,
        "fit_split_manifest_digest": model["fit_split_manifest_digest"],
        "offset_evaluator_digest": model["offset_evaluator_digest"],
        "operating_point_digest": model["operating_point_digest"],
        "output_split_manifest": output_split,
        "output_cases": output_cases,
        "power_report_digest": model["power_report_digest"],
        "preregistration_digest": model["preregistration_digest"],
        "registered_strata": registered,
        "release_digest": bound_digests["release_digest"],
        "required_independent_units": model["required_independent_units"],
        "schema_version": OFFSET_OBSERVATION_DECK_SCHEMA,
        "strata_quotas_digest": model["strata_quotas_digest"],
        "strata_plan_digest": bound_digests["strata_plan_digest"],
    }


def build_offset_observations(
    deck_raw: object,
    calibrator: object,
    observation_deck_raw: object,
    *,
    expected_dataset_digest: str,
    trusted_preregistration_digest: str,
) -> dict[str, Any]:
    """Build the v2 manifest-derived observation contract consumed by ``offset-score``."""

    deck = build_offset_control_deck(
        deck_raw,
        expected_dataset_digest=expected_dataset_digest,
        trusted_preregistration_digest=trusted_preregistration_digest,
    )
    model = _validate_calibrator(calibrator)
    deck_digest = document_sha256(deck)
    if model["control_deck_digest"] != deck_digest:
        raise OffsetCalibrationError("calibrator does not belong to this control deck")
    expected_model = fit_speaker_disjoint_isotonic(
        deck_raw,
        expected_dataset_digest=expected_dataset_digest,
        trusted_preregistration_digest=trusted_preregistration_digest,
    )
    if model != expected_model:
        raise OffsetCalibrationError("calibrator is not the canonical deterministic fit for this control deck")
    observation_deck = _canonical_observation_deck(observation_deck_raw, control_deck=deck, model=model)
    evaluation_split_digest = document_sha256(observation_deck["evaluation_split_manifest"])
    application = {
        "cases": observation_deck["calibration_cases"],
        "control_deck_digest": deck_digest,
        "dataset_digest": model["dataset_digest"],
        "dataset_manifest_digest": model["dataset_manifest_digest"],
        "design_digest": model["design_digest"],
        "design_report_digest": model["design_report_digest"],
        "evaluation_split_manifest_digest": evaluation_split_digest,
        "fit_split_manifest_digest": model["fit_split_manifest_digest"],
        "offset_evaluator_digest": model["offset_evaluator_digest"],
        "operating_point_digest": model["operating_point_digest"],
        "power_report_digest": model["power_report_digest"],
        "preregistration_digest": model["preregistration_digest"],
        "registered_strata": observation_deck["registered_strata"],
        "required_independent_units": model["required_independent_units"],
        "strata_quotas_digest": model["strata_quotas_digest"],
        "schema_version": OFFSET_CALIBRATION_APPLICATION_SCHEMA,
    }
    calibrated = apply_offset_calibrator(model, application)
    calibration_cases = [
        {
            "case_id": case["case_id"],
            "correspondence_label": case["correspondence_label"],
            "correspondence_probability": case["correspondence_probability"],
            "expected_offset_ms": case["expected_offset_ms"],
            "fps": case["fps"],
            "frame_duration_ms": case["frame_duration_ms"],
            "in_domain": case["in_domain"],
            "leakage_component_id": case["leakage_component_id"],
            "offset_kind": case["offset_kind"],
            "predicted_offset_ms": case["predicted_offset_ms"],
            "raw_score": case["raw_score"],
            "replicate_id": case["replicate_id"],
            "source_sample_id": case["source_sample_id"],
            "strata": case["strata"],
        }
        for case in calibrated["cases"]
    ]
    output_cases = [
        {
            "estimated_offset_ms": case["estimated_offset_ms"],
            "fps": case["fps"],
            "leakage_component_id": case["leakage_component_id"],
            "output_id": case["output_id"],
            "replicate_id": case["replicate_id"],
            "source_sample_id": case["source_sample_id"],
            "strata": case["strata"],
        }
        for case in observation_deck["output_cases"]
    ]
    return {
        "abstention_policy_digest": observation_deck["abstention_policy_digest"],
        "bootstrap": observation_deck["bootstrap"],
        "calibration_cases": calibration_cases,
        "calibration_policy_digest": model["calibrator_sha256"],
        "control_deck_digest": model["control_deck_digest"],
        "dataset_digest": model["dataset_digest"],
        "dataset_manifest_digest": model["dataset_manifest_digest"],
        "design_digest": model["design_digest"],
        "design_report_digest": model["design_report_digest"],
        "evaluation_split_manifest_digest": evaluation_split_digest,
        "fit_split_manifest_digest": model["fit_split_manifest_digest"],
        "offset_evaluator_digest": model["offset_evaluator_digest"],
        "operating_point_digest": model["operating_point_digest"],
        "output_split_manifest_digest": document_sha256(observation_deck["output_split_manifest"]),
        "output_cases": output_cases,
        "power_report_digest": model["power_report_digest"],
        "preregistration_digest": model["preregistration_digest"],
        "raw_score_threshold": model["raw_score_threshold"],
        "registered_strata": observation_deck["registered_strata"],
        "release_digest": observation_deck["release_digest"],
        "required_independent_units": model["required_independent_units"],
        "schema_version": OFFSET_OBSERVATIONS_SCHEMA,
        "strata_quotas_digest": model["strata_quotas_digest"],
        "strata_plan_digest": observation_deck["strata_plan_digest"],
    }


def validate_offset_scoring_contract(  # noqa: PLR0912, PLR0915
    raw: object,
    *,
    control_deck: object,
    calibrator: object,
    expected_dataset_digest: str,
    trusted_preregistration_digest: str,
) -> dict[str, Any]:
    """Revalidate every observation binding immediately before statistical scoring.

    The observation document is intentionally not a bearer credential. A scorer
    must receive the frozen deck, its canonical deterministic calibrator, and the
    two external governance anchors again. Probabilities and the operating
    threshold are then derived from those artifacts instead of trusted from JSON.
    """

    if not isinstance(raw, dict):
        raise OffsetCalibrationError("offset observations must be an object")
    deck = build_offset_control_deck(
        control_deck,
        expected_dataset_digest=expected_dataset_digest,
        trusted_preregistration_digest=trusted_preregistration_digest,
    )
    model = _validate_calibrator(calibrator)
    expected_model = fit_speaker_disjoint_isotonic(
        control_deck,
        expected_dataset_digest=expected_dataset_digest,
        trusted_preregistration_digest=trusted_preregistration_digest,
    )
    if model != expected_model:
        raise OffsetCalibrationError("scoring calibrator is not the canonical deterministic fit for this control deck")

    freeze = deck["dataset_freeze"]
    samples_by_id = {sample["sample_id"]: sample for sample in deck["dataset_manifest"]["samples"]}
    component_by_sample: dict[str, str] = {}
    for component in freeze["core"]["components"]:
        component_id = document_sha256({"freeze_id": freeze["freeze_id"], "sample_ids": component})
        component_by_sample.update(dict.fromkeys(component, component_id))

    def split_manifest(split_name: str) -> dict[str, Any]:
        sample_ids = sorted(
            sample_id
            for sample_id, assigned in freeze["core"]["assignments"].items()
            if assigned == split_name
        )
        return {
            "freeze_id": freeze["freeze_id"],
            "sample_ids": sample_ids,
            "samples": [samples_by_id[sample_id] for sample_id in sample_ids],
        }

    bindings = {
        "calibration_policy_digest": model["calibrator_sha256"],
        "control_deck_digest": model["control_deck_digest"],
        "dataset_digest": model["dataset_digest"],
        "dataset_manifest_digest": model["dataset_manifest_digest"],
        "design_digest": model["design_digest"],
        "design_report_digest": model["design_report_digest"],
        "evaluation_split_manifest_digest": document_sha256(split_manifest(EVALUATION_SPLIT)),
        "fit_split_manifest_digest": model["fit_split_manifest_digest"],
        "offset_evaluator_digest": model["offset_evaluator_digest"],
        "operating_point_digest": model["operating_point_digest"],
        "output_split_manifest_digest": document_sha256(split_manifest(OUTPUT_SPLIT)),
        "power_report_digest": model["power_report_digest"],
        "preregistration_digest": model["preregistration_digest"],
        "strata_quotas_digest": model["strata_quotas_digest"],
    }
    for field, expected in bindings.items():
        if _sha256(raw.get(field), f"scoring observations {field}") != expected:
            raise OffsetCalibrationError(f"scoring observations {field} mismatch")
    if raw.get("required_independent_units") != model["required_independent_units"]:
        raise OffsetCalibrationError("scoring observations required_independent_units mismatch")
    threshold = _number(raw.get("raw_score_threshold"), "scoring observations raw_score_threshold")
    if threshold != model["raw_score_threshold"]:
        raise OffsetCalibrationError("scoring observations threshold is not calibrator-derived")
    if raw.get("strata_plan_digest") != model["strata_quotas_digest"]:
        raise OffsetCalibrationError("scoring observations strata plan is not the frozen D0a quota plan")
    if raw.get("registered_strata") != deck["registered_strata"]:
        raise OffsetCalibrationError("scoring observations registered strata differ from the frozen D0a catalog")

    def validate_membership(case: object, *, index: int, split_name: str, output: bool) -> None:
        context = f"scoring {'output' if output else 'calibration'} case {index}"
        if not isinstance(case, dict):
            raise OffsetCalibrationError(f"{context} must be an object")
        sample_id = _identifier(case.get("source_sample_id"), f"{context}.source_sample_id")
        if freeze["core"]["assignments"].get(sample_id) != split_name:
            raise OffsetCalibrationError(f"{context} is absent from the frozen {split_name} split")
        expected_component = component_by_sample[sample_id]
        if _sha256(case.get("leakage_component_id"), f"{context}.leakage_component_id") != expected_component:
            raise OffsetCalibrationError(f"{context} leakage component is not manifest-derived")
        fps = case.get("fps")
        if isinstance(fps, bool) or not isinstance(fps, int) or fps not in REQUIRED_FPS:
            raise OffsetCalibrationError(f"{context}.fps must be one of {list(REQUIRED_FPS)}")
        strata = _canonical_identifiers(case.get("strata"), f"{context}.strata")
        expected_strata = _derived_strata(samples_by_id[sample_id], fps, set(deck["registered_strata"]))
        if strata != expected_strata:
            raise OffsetCalibrationError(f"{context}.strata are not manifest- and fps-derived")
        replicate_id = _identifier(case.get("replicate_id"), f"{context}.replicate_id")
        if output:
            expected_id = document_sha256(
                {"fps": fps, "replicate_id": replicate_id, "source_sample_id": sample_id}
            )
            if _sha256(case.get("output_id"), f"{context}.output_id") != expected_id:
                raise OffsetCalibrationError(f"{context}.output_id is not source-derived")
            return
        expected_id = _case_id(
            source_sample_id=sample_id,
            replicate_id=replicate_id,
            fps=fps,
            offset_kind=case.get("offset_kind"),
            correspondence_label=case.get("correspondence_label"),
        )
        if _sha256(case.get("case_id"), f"{context}.case_id") != expected_id:
            raise OffsetCalibrationError(f"{context}.case_id is not source-derived")
        raw_score = case.get("raw_score")
        probability = case.get("correspondence_probability")
        if raw_score is None:
            if probability is not None:
                raise OffsetCalibrationError(f"{context} abstention must have null probability")
        else:
            score = _number(raw_score, f"{context}.raw_score")
            observed = _number(probability, f"{context}.correspondence_probability")
            derived = _interpolate(model["knots"], score)
            if not math.isclose(observed, derived, rel_tol=0, abs_tol=1e-15):
                raise OffsetCalibrationError(f"{context} probability is not calibrator-derived")

    calibration_cases = raw.get("calibration_cases")
    output_cases = raw.get("output_cases")
    if not isinstance(calibration_cases, list) or not 2 <= len(calibration_cases) <= MAX_CASES:
        raise OffsetCalibrationError(f"scoring calibration_cases must contain 2 to {MAX_CASES} observations")
    if not isinstance(output_cases, list) or not 2 <= len(output_cases) <= MAX_CASES:
        raise OffsetCalibrationError(f"scoring output_cases must contain 2 to {MAX_CASES} observations")
    for index, case in enumerate(calibration_cases):
        validate_membership(case, index=index, split_name=EVALUATION_SPLIT, output=False)
    for index, case in enumerate(output_cases):
        validate_membership(case, index=index, split_name=OUTPUT_SPLIT, output=True)
    return raw
