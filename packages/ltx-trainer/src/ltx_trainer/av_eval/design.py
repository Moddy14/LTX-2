"""Deterministic D0a design-pilot validation and sample-size planning."""

from __future__ import annotations

import hashlib
import json
import math
from statistics import NormalDist
from typing import Any

from .surface_contract import (
    CURRENT_VBENCH_CLAIM_IDS,
    SURFACE_BINDING_SCHEMA,
    SURFACE_SCHEMA,
    SurfaceContractError,
    validate_candidate_vbench_surface_binding,
)

LEGACY_DESIGN_SCHEMA = "ltx-sota-design-pilot.v1"
DESIGN_SCHEMA = "ltx-sota-design-pilot.v2"
LEGACY_REPORT_SCHEMA = "ltx-sota-power-report.v1"
REPORT_SCHEMA = "ltx-sota-power-report.v2"
REPORT_SCHEMA_BY_DESIGN_SCHEMA = {
    LEGACY_DESIGN_SCHEMA: LEGACY_REPORT_SCHEMA,
    DESIGN_SCHEMA: REPORT_SCHEMA,
}
INDEPENDENT_UNIT = "identity-speaker-and-transitive-leakage-component"
ENDPOINT_MODELS = {"binomial-upper", "binomial-lower", "paired-mean"}
TEST_KINDS = {"superiority", "noninferiority", "equivalence", "absolute"}
DIRECTIONS = {"higher", "lower"}
VBench_DIMENSIONS = {
    "subject-consistency",
    "background-consistency",
    "motion-smoothness",
    "dynamic-degree",
    "aesthetic-quality",
    "imaging-quality",
}
STRATA_QUOTA_RELATIONSHIPS = {"overlapping", "disjoint", "partition"}
CURRENT_VBENCH_CLAIM_COUNT = len(CURRENT_VBENCH_CLAIM_IDS)
CURRENT_VBENCH_GATE_COUNT = CURRENT_VBENCH_CLAIM_COUNT * len(VBench_DIMENSIONS)
CURRENT_PLANNING_HYPOTHESIS_COUNT = 13 + 2 * CURRENT_VBENCH_GATE_COUNT
REQUIRED_VBENCH_ENDPOINT_IDS = {f"vbench-{dimension}" for dimension in VBench_DIMENSIONS}
REQUIRED_CRITICAL_TOKEN_DELTA_IDS = {
    "asr-critical-name-accuracy",
    "asr-critical-negation-accuracy",
    "asr-critical-number-accuracy",
}
REQUIRED_CRITICAL_TOKEN_ENDPOINT_IDS = {
    "asr-critical-name",
    "asr-critical-negation",
    "asr-critical-number",
}
REQUIRED_MOS_ENDPOINT_IDS = {
    "mos-audio-quality",
    "mos-identity-mouth",
    "mos-lip-sync",
}


class DesignError(ValueError):
    """Raised when a D0a design could permit outcome-driven decisions."""


def canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def document_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise DesignError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str, *, minimum_length: int = 3) -> str:
    if not isinstance(value, str) or not minimum_length <= len(value) <= 128:
        raise DesignError(f"{context} must contain {minimum_length} to 128 characters")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise DesignError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise DesignError(f"{context} must be a lowercase SHA-256")
    return value


def _revision(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise DesignError(f"{context} must be a lowercase 40-character Git revision")
    return value


def _number(
    value: object,
    context: str,
    *,
    minimum: float = 0.0,
    maximum: float = math.inf,
    nullable: bool = False,
) -> float | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise DesignError(f"{context} must be a finite number")
    result = float(value)
    if result < minimum or result > maximum:
        raise DesignError(f"{context} must be between {minimum} and {maximum}")
    return result


def _validate_delta_catalog(raw: object, status: str) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(raw, dict):
        raise DesignError("delta_catalog must be an object")
    _exact_keys(raw, {"schema_version", "metrics"}, "delta_catalog")
    if raw["schema_version"] != "ltx-sota-delta-catalog.v1":
        raise DesignError("unsupported delta catalog schema")
    if not isinstance(raw["metrics"], list) or not raw["metrics"]:
        raise DesignError("delta catalog needs metrics")
    blockers: list[str] = []
    identifiers: list[str] = []
    for index, metric in enumerate(raw["metrics"]):
        if not isinstance(metric, dict):
            raise DesignError(f"delta metric {index} must be an object")
        _exact_keys(
            metric,
            {"metric_id", "test", "direction", "delta", "unit", "basis_evidence_sha256"},
            f"delta metric {index}",
        )
        metric_id = _identifier(metric["metric_id"], f"delta metric {index}.metric_id")
        identifiers.append(metric_id)
        if metric["test"] not in TEST_KINDS or metric["direction"] not in DIRECTIONS:
            raise DesignError(f"delta metric {metric_id} has an unsupported test or direction")
        _identifier(metric["unit"], f"delta metric {metric_id}.unit", minimum_length=1)
        delta = _number(metric["delta"], f"delta metric {metric_id}.delta", nullable=True)
        evidence = _sha256(metric["basis_evidence_sha256"], f"delta metric {metric_id}.basis", nullable=True)
        if delta is None or delta <= 0:
            blockers.append(f"delta-missing:{metric_id}")
        if evidence is None:
            blockers.append(f"delta-basis-missing:{metric_id}")
    if identifiers != sorted(set(identifiers)):
        raise DesignError("delta metrics must be unique and sorted")
    if not REQUIRED_CRITICAL_TOKEN_DELTA_IDS.issubset(identifiers):
        raise DesignError("delta catalog must power names, numbers, and negations separately")
    if status == "frozen" and blockers:
        raise DesignError(f"frozen delta catalog is incomplete: {blockers}")
    return raw, blockers


def _validate_candidate_surface(raw: object) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(raw, dict):
        raise DesignError("candidate_surface must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "surface_schema_version",
            "surface_digest",
            "projection_digest",
            "candidate_entry_count",
            "claim_ids",
        },
        "candidate_surface",
    )
    if (
        raw["schema_version"] != SURFACE_BINDING_SCHEMA
        or raw["surface_schema_version"] != SURFACE_SCHEMA
    ):
        raise DesignError("candidate_surface must use the current canonical surface binding")
    _sha256(raw["surface_digest"], "candidate_surface.surface_digest")
    _sha256(raw["projection_digest"], "candidate_surface.projection_digest")
    candidate_entry_count = raw["candidate_entry_count"]
    if (
        isinstance(candidate_entry_count, bool)
        or not isinstance(candidate_entry_count, int)
        or candidate_entry_count < len(CURRENT_VBENCH_CLAIM_IDS)
    ):
        raise DesignError("candidate_surface must bind at least one entry for every current claim")
    if not isinstance(raw["claim_ids"], list) or not raw["claim_ids"]:
        raise DesignError("candidate_surface must enumerate claim_ids")
    claim_ids = [
        _identifier(claim_id, f"candidate_surface.claim_ids[{index}]")
        for index, claim_id in enumerate(raw["claim_ids"])
    ]
    if claim_ids != sorted(set(claim_ids)):
        raise DesignError("candidate_surface claim_ids must be unique and sorted")
    if claim_ids != list(CURRENT_VBENCH_CLAIM_IDS):
        raise DesignError("candidate_surface claim_ids do not match the current v2 contract")
    return raw, claim_ids


def _validate_vbench_catalog(  # noqa: PLR0912
    raw: object,
    status: str,
    *,
    design_schema: str,
) -> tuple[dict[str, Any], list[str], int, dict[str, Any] | None]:
    if not isinstance(raw, dict):
        raise DesignError("vbench_gate_catalog must be an object")
    catalog_schema = "vbench-gates.v2" if design_schema == DESIGN_SCHEMA else "vbench-gates.v1"
    expected_keys = {
        "schema_version",
        "repository",
        "commit",
        "config_sha256",
        "multiplicity",
        "confidence_level",
        "gates",
    }
    if design_schema == DESIGN_SCHEMA:
        expected_keys.add("candidate_surface")
    _exact_keys(
        raw,
        expected_keys,
        "vbench_gate_catalog",
    )
    if raw["schema_version"] != catalog_schema or raw["repository"] != "Vchitect/VBench":
        raise DesignError("unsupported VBench catalog")
    candidate_surface: dict[str, Any] | None = None
    candidate_claim_ids: list[str] | None = None
    if design_schema == DESIGN_SCHEMA:
        candidate_surface, candidate_claim_ids = _validate_candidate_surface(raw["candidate_surface"])
    commit = _revision(raw["commit"], "vbench commit", nullable=True)
    config_digest = _sha256(raw["config_sha256"], "vbench config", nullable=True)
    if raw["multiplicity"] != "holm" or raw["confidence_level"] != 0.95:
        raise DesignError("VBench gates require Holm-corrected 95% confidence")
    if not isinstance(raw["gates"], list) or not raw["gates"]:
        raise DesignError("VBench catalog needs claim-specific gates")
    blockers = [
        name
        for name, value in (("vbench-commit-missing", commit), ("vbench-config-missing", config_digest))
        if value is None
    ]
    identities: list[str] = []
    for index, gate in enumerate(raw["gates"]):
        if not isinstance(gate, dict):
            raise DesignError(f"VBench gate {index} must be an object")
        _exact_keys(
            gate,
            {"claim_id", "dimension", "direction", "absolute_minimum", "delta", "test", "basis_evidence_sha256"},
            f"VBench gate {index}",
        )
        claim_id = _identifier(gate["claim_id"], f"VBench gate {index}.claim_id")
        dimension = gate["dimension"]
        if dimension not in VBench_DIMENSIONS or gate["direction"] not in DIRECTIONS or gate["test"] not in TEST_KINDS:
            raise DesignError(f"VBench gate {index} has unsupported semantics")
        identity = f"{claim_id}:{dimension}"
        identities.append(identity)
        minimum = _number(gate["absolute_minimum"], f"VBench gate {identity}.absolute_minimum", nullable=True)
        delta = _number(gate["delta"], f"VBench gate {identity}.delta", nullable=True)
        evidence = _sha256(gate["basis_evidence_sha256"], f"VBench gate {identity}.basis", nullable=True)
        if minimum is None:
            blockers.append(f"vbench-minimum-missing:{identity}")
        if delta is None or delta <= 0:
            blockers.append(f"vbench-delta-missing:{identity}")
        if evidence is None:
            blockers.append(f"vbench-basis-missing:{identity}")
    if identities != sorted(set(identities)):
        raise DesignError("VBench claim/dimension gates must be unique and sorted")
    gate_claim_ids = sorted({identity.rsplit(":", 1)[0] for identity in identities})
    if candidate_claim_ids is not None:
        expected_identities = sorted(
            f"{claim_id}:{dimension}"
            for claim_id in candidate_claim_ids
            for dimension in VBench_DIMENSIONS
        )
        if identities != expected_identities:
            raise DesignError("VBench gates must exactly cover the candidate claim/dimension matrix")
    if status == "frozen" and blockers:
        raise DesignError(f"frozen VBench catalog is incomplete: {blockers}")
    return raw, blockers, len(gate_claim_ids), candidate_surface


def _endpoint_sample_size(endpoint: dict[str, Any], *, alpha: float, power: float, design_effect: float) -> int:
    model = endpoint["model"]
    max_ci_width = _number(endpoint["max_ci_width"], f"{endpoint['endpoint_id']}.max_ci_width", minimum=1e-12)
    z_alpha = NormalDist().inv_cdf(1 - alpha)
    z_power = NormalDist().inv_cdf(power)
    if model == "paired-mean":
        effect = _number(endpoint["effect"], f"{endpoint['endpoint_id']}.effect", minimum=1e-12)
        variability = _number(endpoint["variability"], f"{endpoint['endpoint_id']}.variability", minimum=1e-12)
        if effect is None or variability is None or max_ci_width is None:
            raise DesignError("frozen paired-mean endpoint contains null planning values")
        power_n = ((z_alpha + z_power) * variability / effect) ** 2
        precision_n = (2 * NormalDist().inv_cdf(0.975) * variability / max_ci_width) ** 2
    elif model in {"binomial-upper", "binomial-lower"}:
        null_value = _number(endpoint["null_value"], f"{endpoint['endpoint_id']}.null_value", minimum=0, maximum=1)
        alternative = _number(endpoint["alternative"], f"{endpoint['endpoint_id']}.alternative", minimum=0, maximum=1)
        if null_value is None or alternative is None or max_ci_width is None:
            raise DesignError("frozen binomial endpoint contains null planning values")
        if model == "binomial-upper" and not alternative < null_value:
            raise DesignError(f"{endpoint['endpoint_id']} requires alternative < null_value")
        if model == "binomial-lower" and not alternative > null_value:
            raise DesignError(f"{endpoint['endpoint_id']} requires alternative > null_value")
        difference = abs(alternative - null_value)
        power_n = (
            (z_alpha * math.sqrt(null_value * (1 - null_value)) + z_power * math.sqrt(alternative * (1 - alternative)))
            / difference
        ) ** 2
        precision_n = (
            2 * NormalDist().inv_cdf(0.975) * math.sqrt(max(alternative * (1 - alternative), 1e-6)) / max_ci_width
        ) ** 2
        if model == "binomial-upper" and alternative == 0:
            power_n = max(power_n, math.log(alpha) / math.log(1 - null_value))
    else:
        raise DesignError(f"unsupported endpoint model: {model}")
    return math.ceil(max(power_n, precision_n) * design_effect)


def _validate_design_settings(raw: dict[str, Any]) -> tuple[str, str, float, float, float | None]:
    design_schema = raw.get("schema_version")
    expected_keys = {
        "schema_version",
        "status",
        "design_id",
        "independent_unit",
        "familywise_alpha",
        "target_power",
        "multiplicity",
        "minimum_identities",
        "clips_per_identity",
        "design_effect",
        "delta_catalog",
        "vbench_gate_catalog",
        "power_endpoints",
        "strata_quotas",
    }
    if design_schema == DESIGN_SCHEMA:
        expected_keys.add("strata_quota_semantics")
    _exact_keys(
        raw,
        expected_keys,
        "design",
    )
    status = raw["status"]
    if design_schema not in REPORT_SCHEMA_BY_DESIGN_SCHEMA or status not in {"draft", "frozen"}:
        raise DesignError("unsupported design schema or status")
    _identifier(raw["design_id"], "design_id")
    if raw["independent_unit"] != INDEPENDENT_UNIT or raw["multiplicity"] != "holm":
        raise DesignError("design must use leakage-component units and Holm multiplicity")
    alpha = _number(raw["familywise_alpha"], "familywise_alpha", minimum=1e-6, maximum=0.05)
    power = _number(raw["target_power"], "target_power", minimum=0.9, maximum=0.999999)
    if alpha is None or power is None:
        raise DesignError("familywise_alpha and target_power must not be null")
    if not isinstance(raw["minimum_identities"], int) or raw["minimum_identities"] < 30:
        raise DesignError("minimum_identities must be at least 30")
    if not isinstance(raw["clips_per_identity"], int) or raw["clips_per_identity"] < 3:
        raise DesignError("clips_per_identity must be at least 3")
    design_effect = _number(raw["design_effect"], "design_effect", minimum=1, nullable=True)
    return design_schema, status, alpha, power, design_effect


def _validate_power_endpoints(
    raw: object,
    *,
    alpha: float,
    power: float,
    design_effect: float | None,
    vbench_gate_count: int,
) -> tuple[list[dict[str, Any]], list[str], float, int]:
    if not isinstance(raw, list) or not raw:
        raise DesignError("power_endpoints must be a non-empty list")
    raw_endpoint_ids = [endpoint.get("endpoint_id") for endpoint in raw if isinstance(endpoint, dict)]
    registered_vbench_endpoint_ids = {
        endpoint_id
        for endpoint_id in raw_endpoint_ids
        if isinstance(endpoint_id, str) and endpoint_id.startswith("vbench-")
    }
    if registered_vbench_endpoint_ids != REQUIRED_VBENCH_ENDPOINT_IDS:
        raise DesignError("power endpoints must exactly cover every registered VBench dimension")
    non_vbench_endpoint_count = len(raw) - len(REQUIRED_VBENCH_ENDPOINT_IDS)
    planning_hypothesis_count = non_vbench_endpoint_count + 2 * vbench_gate_count
    per_endpoint_alpha = alpha / planning_hypothesis_count
    endpoint_ids: list[str] = []
    requirements: list[dict[str, Any]] = []
    blockers: list[str] = []
    for index, endpoint in enumerate(raw):
        if not isinstance(endpoint, dict):
            raise DesignError(f"power endpoint {index} must be an object")
        _exact_keys(
            endpoint,
            {"endpoint_id", "model", "effect", "variability", "null_value", "alternative", "max_ci_width"},
            f"power endpoint {index}",
        )
        endpoint_id = _identifier(endpoint["endpoint_id"], f"power endpoint {index}.endpoint_id")
        endpoint_ids.append(endpoint_id)
        model = endpoint["model"]
        if model not in ENDPOINT_MODELS:
            raise DesignError(f"unsupported power model for {endpoint_id}")
        required_fields = (
            ("effect", "variability", "max_ci_width")
            if model == "paired-mean"
            else ("null_value", "alternative", "max_ci_width")
        )
        missing = [field for field in required_fields if endpoint[field] is None]
        blockers.extend(f"power-input-missing:{endpoint_id}:{field}" for field in missing)
        if not missing and design_effect is not None:
            requirements.append(
                {
                    "endpoint_id": endpoint_id,
                    "independent_units": _endpoint_sample_size(
                        endpoint,
                        alpha=per_endpoint_alpha,
                        power=power,
                        design_effect=design_effect,
                    ),
                }
            )
    if endpoint_ids != sorted(set(endpoint_ids)):
        raise DesignError("power endpoints must be unique and sorted")
    if not REQUIRED_CRITICAL_TOKEN_ENDPOINT_IDS.issubset(endpoint_ids):
        raise DesignError("power endpoints must cover names, numbers, and negations separately")
    if not REQUIRED_MOS_ENDPOINT_IDS.issubset(endpoint_ids):
        raise DesignError("power endpoints must cover audio quality, identity/mouth, and lip-sync MOS")
    return requirements, blockers, per_endpoint_alpha, planning_hypothesis_count


def _validate_strata_quotas(raw: object) -> tuple[list[str], dict[str, int | None]]:
    if not isinstance(raw, list) or not raw:
        raise DesignError("strata_quotas must be a non-empty quoted matrix")
    quota_ids: list[str] = []
    quota_minimums: dict[str, int | None] = {}
    blockers: list[str] = []
    for index, quota in enumerate(raw):
        if not isinstance(quota, dict):
            raise DesignError(f"strata quota {index} must be an object")
        _exact_keys(quota, {"stratum_id", "minimum_independent_units"}, f"strata quota {index}")
        quota_id = _identifier(quota["stratum_id"], f"strata quota {index}.stratum_id")
        quota_ids.append(quota_id)
        minimum = quota["minimum_independent_units"]
        if minimum is None:
            blockers.append(f"strata-quota-missing:{quota_id}")
        elif not isinstance(minimum, int) or minimum < 1:
            raise DesignError(f"strata quota {index} must require at least one independent unit")
        quota_minimums[quota_id] = minimum
    if quota_ids != sorted(set(quota_ids)):
        raise DesignError("strata quotas must be unique and sorted")
    return blockers, quota_minimums


def _validate_strata_quota_semantics(  # noqa: PLR0912
    raw: object,
    *,
    quota_minimums: dict[str, int | None],
) -> tuple[dict[str, int], int]:
    if not isinstance(raw, dict):
        raise DesignError("strata_quota_semantics must be an object")
    _exact_keys(
        raw,
        {"schema_version", "maximum_independent_units", "groups"},
        "strata_quota_semantics",
    )
    if raw["schema_version"] != "ltx-strata-quota-semantics.v1":
        raise DesignError("unsupported strata quota semantics schema")
    maximum_independent_units = raw["maximum_independent_units"]
    if (
        isinstance(maximum_independent_units, bool)
        or not isinstance(maximum_independent_units, int)
        or maximum_independent_units < 1
    ):
        raise DesignError("strata quota maximum_independent_units must be a positive integer")
    groups = raw["groups"]
    if not isinstance(groups, list) or not groups:
        raise DesignError("strata quota semantics must declare non-empty groups")
    group_ids: list[str] = []
    covered_strata: list[str] = []
    aggregate_requirements: dict[str, int] = {}
    for index, group in enumerate(groups):
        if not isinstance(group, dict):
            raise DesignError(f"strata quota group {index} must be an object")
        _exact_keys(
            group,
            {"group_id", "relationship", "stratum_ids"},
            f"strata quota group {index}",
        )
        group_id = _identifier(group["group_id"], f"strata quota group {index}.group_id")
        group_ids.append(group_id)
        relationship = group["relationship"]
        if relationship not in STRATA_QUOTA_RELATIONSHIPS:
            raise DesignError(f"strata quota group {group_id} has unsupported relationship semantics")
        stratum_ids_raw = group["stratum_ids"]
        if not isinstance(stratum_ids_raw, list) or not stratum_ids_raw:
            raise DesignError(f"strata quota group {group_id} must enumerate stratum_ids")
        stratum_ids = [
            _identifier(stratum_id, f"strata quota group {group_id}.stratum_ids[{item_index}]")
            for item_index, stratum_id in enumerate(stratum_ids_raw)
        ]
        if stratum_ids != sorted(set(stratum_ids)):
            raise DesignError(f"strata quota group {group_id} stratum_ids must be unique and sorted")
        unknown = sorted(set(stratum_ids) - quota_minimums.keys())
        if unknown:
            raise DesignError(f"strata quota group {group_id} references unknown strata: {unknown}")
        covered_strata.extend(stratum_ids)
        minimums = [quota_minimums[stratum_id] for stratum_id in stratum_ids]
        if all(minimum is not None for minimum in minimums):
            resolved_minimums = [minimum for minimum in minimums if minimum is not None]
            aggregate_requirements[group_id] = (
                sum(resolved_minimums)
                if relationship in {"disjoint", "partition"}
                else max(resolved_minimums)
            )
    if group_ids != sorted(set(group_ids)):
        raise DesignError("strata quota groups must be unique and sorted")
    if sorted(covered_strata) != sorted(quota_minimums):
        raise DesignError("strata quota semantics must cover every quota exactly once")
    return aggregate_requirements, maximum_independent_units


def build_power_report(raw: object, *, release_surface: object | None = None) -> dict[str, Any]:
    """Validate a D0a artifact and compute deterministic independent-unit requirements."""

    if not isinstance(raw, dict):
        raise DesignError("design must be an object")
    design_schema, status, alpha, power, design_effect = _validate_design_settings(raw)
    delta_catalog, blockers = _validate_delta_catalog(raw["delta_catalog"], status)
    vbench_catalog, vbench_blockers, vbench_claim_count, candidate_surface = _validate_vbench_catalog(
        raw["vbench_gate_catalog"],
        status,
        design_schema=design_schema,
    )
    blockers.extend(vbench_blockers)
    if design_schema == DESIGN_SCHEMA and release_surface is not None:
        try:
            validate_candidate_vbench_surface_binding(candidate_surface, surface=release_surface)
        except SurfaceContractError as error:
            raise DesignError(f"candidate release surface binding rejected: {error}") from error
    if design_effect is None:
        blockers.append("design-effect-missing")
    requirements, endpoint_blockers, per_endpoint_alpha, planning_hypothesis_count = _validate_power_endpoints(
        raw["power_endpoints"],
        alpha=alpha,
        power=power,
        design_effect=design_effect,
        vbench_gate_count=len(vbench_catalog["gates"]),
    )
    if design_schema == DESIGN_SCHEMA and planning_hypothesis_count != CURRENT_PLANNING_HYPOTHESIS_COUNT:
        raise DesignError(
            f"v2 planning family must contain exactly {CURRENT_PLANNING_HYPOTHESIS_COUNT} hypotheses"
        )
    blockers.extend(endpoint_blockers)
    quotas = raw["strata_quotas"]
    quota_blockers, quota_minimums = _validate_strata_quotas(quotas)
    blockers.extend(quota_blockers)
    aggregate_quota_requirements: dict[str, int] = {}
    maximum_independent_units: int | None = None
    if design_schema == DESIGN_SCHEMA:
        aggregate_quota_requirements, maximum_independent_units = _validate_strata_quota_semantics(
            raw["strata_quota_semantics"],
            quota_minimums=quota_minimums,
        )
        if maximum_independent_units < raw["minimum_identities"]:
            raise DesignError("maximum_independent_units cannot be smaller than minimum_identities")
    required_units = max(
        [
            raw["minimum_identities"],
            *(item["independent_units"] for item in requirements),
            *(minimum for minimum in quota_minimums.values() if minimum is not None),
            *aggregate_quota_requirements.values(),
        ],
    )
    if maximum_independent_units is not None:
        blockers.extend(
            f"strata-quota-exceeds-maximum:{quota_id}"
            for quota_id, minimum in quota_minimums.items()
            if minimum is not None and minimum > maximum_independent_units
        )
        blockers.extend(
            f"strata-quota-group-exceeds-maximum:{group_id}"
            for group_id, minimum in aggregate_quota_requirements.items()
            if minimum > maximum_independent_units
        )
        if (
            required_units > maximum_independent_units
            and not any(blocker.startswith("strata-quota") and "exceeds-maximum" in blocker for blocker in blockers)
        ):
            blockers.append("power-requirement-exceeds-maximum-independent-units")
    blockers = sorted(set(blockers))
    if status == "frozen" and blockers:
        raise DesignError(f"frozen design is incomplete: {blockers}")
    report = {
        "schema_version": REPORT_SCHEMA_BY_DESIGN_SCHEMA[design_schema],
        "design_digest": document_sha256(raw),
        "delta_catalog_digest": document_sha256(delta_catalog),
        "vbench_gate_catalog_digest": document_sha256(vbench_catalog),
        "status": "ready-to-freeze" if not blockers else "hold",
        "blockers": blockers,
        "familywise_alpha": alpha,
        "planning_hypothesis_count": planning_hypothesis_count,
        "per_endpoint_planning_alpha": per_endpoint_alpha,
        "target_power": power,
        "endpoint_requirements": requirements,
        "required_independent_units": required_units if not blockers else None,
        "required_clips": required_units * raw["clips_per_identity"] if not blockers else None,
        "strata_quotas_digest": document_sha256(quotas),
    }
    if design_schema == DESIGN_SCHEMA:
        if candidate_surface is None:
            raise DesignError("v2 design lost its candidate surface binding")
        report.update(
            {
                "surface_digest": candidate_surface["surface_digest"],
                "candidate_surface_binding_digest": candidate_surface["projection_digest"],
                "candidate_surface_entry_count": candidate_surface["candidate_entry_count"],
                "strata_quota_semantics_digest": document_sha256(raw["strata_quota_semantics"]),
                "vbench_claim_count": vbench_claim_count,
                "vbench_gate_count": len(vbench_catalog["gates"]),
            }
        )
    return report
