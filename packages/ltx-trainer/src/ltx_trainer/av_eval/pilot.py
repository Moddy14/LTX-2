"""Deterministic D0a repeatability and cluster-effect evidence."""

from __future__ import annotations

import math
from collections import defaultdict
from statistics import NormalDist, fmean, stdev
from typing import Any

from .design import document_sha256

PILOT_SCHEMA = "ltx-sota-design-pilot-observations.v1"
PILOT_REPORT_SCHEMA = "ltx-sota-design-pilot-report.v1"
PILOT_BINDING_SCHEMA = "ltx-sota-design-pilot-binding.v1"
SPLIT_ROLE = "design-pilot"
ARMS = ("candidate", "reference")
ENDPOINT_MODELS = {"binomial-lower", "binomial-upper", "paired-mean"}


class PilotError(ValueError):
    """Raised when D0a observations are ambiguous or selection-prone."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise PilotError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise PilotError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise PilotError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise PilotError(f"{context} must be a lowercase SHA-256")
    return value


def _finite_number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PilotError(f"{context} must be a finite number")
    return float(value)


def _validate_endpoint_catalog(raw: object) -> dict[str, str]:
    if not isinstance(raw, list) or not raw:
        raise PilotError("endpoint_catalog must be a non-empty list")
    endpoints: dict[str, str] = {}
    identities: list[str] = []
    for index, endpoint in enumerate(raw):
        if not isinstance(endpoint, dict):
            raise PilotError(f"endpoint_catalog[{index}] must be an object")
        _exact_keys(endpoint, {"endpoint_id", "model"}, f"endpoint_catalog[{index}]")
        endpoint_id = _identifier(endpoint["endpoint_id"], f"endpoint_catalog[{index}].endpoint_id")
        model = endpoint["model"]
        if model not in ENDPOINT_MODELS:
            raise PilotError(f"endpoint {endpoint_id} has an unsupported model")
        identities.append(endpoint_id)
        endpoints[endpoint_id] = model
    if identities != sorted(set(identities)):
        raise PilotError("endpoint catalog must be unique and sorted")
    return endpoints


def _wilson_interval(successes: int, total: int, confidence: float = 0.95) -> tuple[float, float]:
    z = NormalDist().inv_cdf(0.5 + confidence / 2)
    proportion = successes / total
    denominator = 1 + z**2 / total
    centre = (proportion + z**2 / (2 * total)) / denominator
    half_width = z * math.sqrt(proportion * (1 - proportion) / total + z**2 / (4 * total**2)) / denominator
    return max(0.0, centre - half_width), min(1.0, centre + half_width)


def _cluster_statistics(values_by_unit: dict[str, list[float]]) -> dict[str, float]:
    unit_count = len(values_by_unit)
    observation_count = sum(len(values) for values in values_by_unit.values())
    unit_means = {unit_id: fmean(values) for unit_id, values in values_by_unit.items()}
    grand_mean = sum(len(values_by_unit[unit_id]) * mean for unit_id, mean in unit_means.items()) / observation_count
    between_sum = sum(
        len(values_by_unit[unit_id]) * (mean - grand_mean) ** 2 for unit_id, mean in unit_means.items()
    )
    within_sum = sum(
        sum((value - unit_means[unit_id]) ** 2 for value in values)
        for unit_id, values in values_by_unit.items()
    )
    between_mean_square = between_sum / (unit_count - 1)
    within_degrees = observation_count - unit_count
    within_mean_square = within_sum / within_degrees
    effective_cluster_size = (
        observation_count
        - sum(len(values) ** 2 for values in values_by_unit.values()) / observation_count
    ) / (unit_count - 1)
    denominator = between_mean_square + (effective_cluster_size - 1) * within_mean_square
    raw_icc = (between_mean_square - within_mean_square) / denominator if denominator > 0 else 0.0
    intraclass_correlation = min(1.0, max(0.0, raw_icc))
    mean_cluster_size = observation_count / unit_count
    cluster_size_variance = (
        sum((len(values) - mean_cluster_size) ** 2 for values in values_by_unit.values()) / (unit_count - 1)
    )
    coefficient_of_variation = math.sqrt(cluster_size_variance) / mean_cluster_size
    design_effect = 1 + (((1 + coefficient_of_variation**2) * mean_cluster_size) - 1) * intraclass_correlation
    return {
        "intraclass_correlation": intraclass_correlation,
        "mean_cluster_size": mean_cluster_size,
        "cluster_size_cv": coefficient_of_variation,
        "design_effect": max(1.0, design_effect),
        "test_retest_sd": math.sqrt(max(0.0, within_mean_square)),
        "repeatability_coefficient_95": 1.96 * math.sqrt(2 * max(0.0, within_mean_square)),
    }


def _build_endpoint_report(
    endpoint_id: str,
    model: str,
    paired_values: dict[str, list[tuple[int, float]]],
    arm_values: dict[str, list[float]],
    *,
    minimum_independent_units: int,
    minimum_repeats_per_unit: int,
) -> tuple[dict[str, Any], list[str]]:
    blockers: list[str] = []
    unit_count = len(paired_values)
    if unit_count < minimum_independent_units:
        blockers.append(f"pilot-independent-units-insufficient:{endpoint_id}:{unit_count}")
    incomplete_units = sorted(
        unit_id for unit_id, values in paired_values.items() if len(values) < minimum_repeats_per_unit
    )
    if incomplete_units:
        blockers.append(f"pilot-repeats-insufficient:{endpoint_id}:{len(incomplete_units)}")
    values_by_unit = {
        unit_id: [value for _, value in sorted(values)] for unit_id, values in paired_values.items()
    }
    unit_means = [fmean(values) for values in values_by_unit.values()]
    descriptive_variability = stdev(unit_means) if len(unit_means) >= 2 else None
    cluster = (
        _cluster_statistics(values_by_unit)
        if len(values_by_unit) >= 2 and all(len(values) >= 2 for values in values_by_unit.values())
        else None
    )
    planning_variability = None
    if descriptive_variability is not None and cluster is not None:
        planning_variability = max(descriptive_variability, cluster["test_retest_sd"])
    rates: dict[str, Any] | None = None
    if model.startswith("binomial"):
        rates = {}
        for arm in ARMS:
            values = arm_values[arm]
            if any(value not in {0.0, 1.0} for value in values):
                raise PilotError(f"binomial endpoint {endpoint_id} accepts only 0/1 observations")
            successes = sum(int(value) for value in values)
            lower, upper = _wilson_interval(successes, len(values))
            rates[arm] = {
                "events": successes,
                "observations": len(values),
                "rate": successes / len(values),
                "wilson95_lower": lower,
                "wilson95_upper": upper,
            }
    report = {
        "endpoint_id": endpoint_id,
        "model": model,
        "independent_units": unit_count,
        "paired_repeats": sum(len(values) for values in values_by_unit.values()),
        "observed_candidate_minus_reference": fmean(
            value for values in values_by_unit.values() for value in values
        ),
        "independent_unit_mean_sd": descriptive_variability,
        "planning_variability": planning_variability,
        "cluster": cluster,
        "rates": rates,
    }
    return report, blockers


def validate_design_pilot_report(raw: object) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
    """Validate an embedded D0a report before it can support a frozen design."""

    if not isinstance(raw, dict):
        raise PilotError("pilot report must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "pilot_evidence_digest",
            "endpoint_catalog_digest",
            "bindings",
            "minimum_independent_units",
            "minimum_repeats_per_unit",
            "status",
            "blockers",
            "conservative_design_effect",
            "endpoints",
            "freeze_policy",
        },
        "pilot report",
    )
    if raw["schema_version"] != PILOT_REPORT_SCHEMA:
        raise PilotError("unsupported pilot report schema")
    _sha256(raw["pilot_evidence_digest"], "pilot_evidence_digest")
    _sha256(raw["endpoint_catalog_digest"], "endpoint_catalog_digest")
    bindings = raw["bindings"]
    if not isinstance(bindings, dict):
        raise PilotError("pilot report bindings must be an object")
    expected_bindings = {
        "frozen_dataset_digest",
        "split_assignment_digest",
        "leakage_audit_digest",
        "evaluator_bundle_digest",
    }
    _exact_keys(bindings, expected_bindings, "pilot report bindings")
    for key in expected_bindings:
        _sha256(bindings[key], f"pilot report bindings.{key}")
    minimum_units = raw["minimum_independent_units"]
    minimum_repeats = raw["minimum_repeats_per_unit"]
    if not isinstance(minimum_units, int) or minimum_units < 2:
        raise PilotError("pilot report minimum_independent_units must be at least 2")
    if not isinstance(minimum_repeats, int) or minimum_repeats < 2:
        raise PilotError("pilot report minimum_repeats_per_unit must be at least 2")
    if raw["status"] != "evidence-complete" or raw["blockers"] != []:
        raise PilotError("only an evidence-complete pilot report can support a freeze")
    if raw["freeze_policy"] != "descriptive-only-no-automatic-delta-or-sample-size-selection":
        raise PilotError("pilot report permits outcome-driven planning")
    conservative_design_effect = _finite_number(
        raw["conservative_design_effect"],
        "pilot report conservative_design_effect",
    )
    if conservative_design_effect < 1:
        raise PilotError("pilot report conservative_design_effect must be at least 1")
    endpoints = raw["endpoints"]
    if not isinstance(endpoints, list) or not endpoints:
        raise PilotError("pilot report endpoints must be a non-empty list")
    endpoint_ids: list[str] = []
    for index, endpoint in enumerate(endpoints):
        if not isinstance(endpoint, dict):
            raise PilotError(f"pilot report endpoint {index} must be an object")
        _exact_keys(
            endpoint,
            {
                "endpoint_id",
                "model",
                "independent_units",
                "paired_repeats",
                "observed_candidate_minus_reference",
                "independent_unit_mean_sd",
                "planning_variability",
                "cluster",
                "rates",
            },
            f"pilot report endpoint {index}",
        )
        endpoint_id = _identifier(endpoint["endpoint_id"], f"pilot report endpoint {index}.endpoint_id")
        endpoint_ids.append(endpoint_id)
        model = endpoint["model"]
        if model not in ENDPOINT_MODELS:
            raise PilotError(f"pilot report endpoint {endpoint_id} has an unsupported model")
        independent_units = endpoint["independent_units"]
        paired_repeats = endpoint["paired_repeats"]
        if not isinstance(independent_units, int) or independent_units < minimum_units:
            raise PilotError(f"pilot report endpoint {endpoint_id} has insufficient independent units")
        if not isinstance(paired_repeats, int) or paired_repeats < independent_units * minimum_repeats:
            raise PilotError(f"pilot report endpoint {endpoint_id} has insufficient repeats")
        _finite_number(
            endpoint["observed_candidate_minus_reference"],
            f"pilot report endpoint {endpoint_id}.observed_candidate_minus_reference",
        )
        unit_sd = _finite_number(endpoint["independent_unit_mean_sd"], f"pilot report endpoint {endpoint_id}.sd")
        planning_sd = _finite_number(
            endpoint["planning_variability"],
            f"pilot report endpoint {endpoint_id}.planning_variability",
        )
        if unit_sd < 0 or planning_sd < unit_sd:
            raise PilotError(f"pilot report endpoint {endpoint_id} understates planning variability")
        cluster = endpoint["cluster"]
        if not isinstance(cluster, dict):
            raise PilotError(f"pilot report endpoint {endpoint_id} needs cluster estimates")
        _exact_keys(
            cluster,
            {
                "intraclass_correlation",
                "mean_cluster_size",
                "cluster_size_cv",
                "design_effect",
                "test_retest_sd",
                "repeatability_coefficient_95",
            },
            f"pilot report endpoint {endpoint_id}.cluster",
        )
        for key in cluster:
            value = _finite_number(cluster[key], f"pilot report endpoint {endpoint_id}.cluster.{key}")
            if value < 0 or (key == "design_effect" and value < 1):
                raise PilotError(f"pilot report endpoint {endpoint_id}.cluster.{key} is invalid")
        rates = endpoint["rates"]
        if model == "paired-mean":
            if rates is not None:
                raise PilotError(f"paired-mean pilot endpoint {endpoint_id} must not contain rates")
            continue
        if not isinstance(rates, dict):
            raise PilotError(f"binomial pilot endpoint {endpoint_id} needs arm rates")
        _exact_keys(rates, set(ARMS), f"pilot report endpoint {endpoint_id}.rates")
        for arm in ARMS:
            rate = rates[arm]
            if not isinstance(rate, dict):
                raise PilotError(f"pilot report endpoint {endpoint_id}.{arm} rate must be an object")
            _exact_keys(
                rate,
                {"events", "observations", "rate", "wilson95_lower", "wilson95_upper"},
                f"pilot report endpoint {endpoint_id}.{arm}",
            )
            events = rate["events"]
            total = rate["observations"]
            if not isinstance(events, int) or not isinstance(total, int) or not 0 <= events <= total or total < 1:
                raise PilotError(f"pilot report endpoint {endpoint_id}.{arm} counts are invalid")
            expected_lower, expected_upper = _wilson_interval(events, total)
            expected_values = (events / total, expected_lower, expected_upper)
            actual_values = tuple(
                _finite_number(rate[key], f"pilot report endpoint {endpoint_id}.{arm}.{key}")
                for key in ("rate", "wilson95_lower", "wilson95_upper")
            )
            statistics_drifted = any(
                not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12)
                for actual, expected in zip(actual_values, expected_values, strict=True)
            )
            if statistics_drifted:
                raise PilotError(f"pilot report endpoint {endpoint_id}.{arm} rate statistics drifted")
    if endpoint_ids != sorted(set(endpoint_ids)):
        raise PilotError("pilot report endpoint IDs must be unique and sorted")
    return raw


def build_design_pilot_report(raw: object) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
    """Validate paired D0a observations and estimate conservative planning inputs.

    This report is descriptive evidence only. It never chooses domain deltas,
    CI-width targets, strata quotas, or a final sample size from favorable
    outcomes.
    """

    if not isinstance(raw, dict):
        raise PilotError("pilot observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "split_role",
            "frozen_dataset_digest",
            "split_assignment_digest",
            "leakage_audit_digest",
            "evaluator_bundle_digest",
            "minimum_independent_units",
            "minimum_repeats_per_unit",
            "endpoint_catalog",
            "observations",
        },
        "pilot observations",
    )
    if raw["schema_version"] != PILOT_SCHEMA or raw["split_role"] != SPLIT_ROLE:
        raise PilotError("pilot input must use the registered design-pilot split")
    bindings = {
        key: _sha256(raw[key], key)
        for key in (
            "frozen_dataset_digest",
            "split_assignment_digest",
            "leakage_audit_digest",
            "evaluator_bundle_digest",
        )
    }
    minimum_independent_units = raw["minimum_independent_units"]
    minimum_repeats_per_unit = raw["minimum_repeats_per_unit"]
    if not isinstance(minimum_independent_units, int) or minimum_independent_units < 2:
        raise PilotError("minimum_independent_units must be at least 2")
    if not isinstance(minimum_repeats_per_unit, int) or minimum_repeats_per_unit < 2:
        raise PilotError("minimum_repeats_per_unit must be at least 2")
    endpoints = _validate_endpoint_catalog(raw["endpoint_catalog"])
    observations = raw["observations"]
    if not isinstance(observations, list) or not observations:
        raise PilotError("observations must be a non-empty list")

    observation_ids: list[str] = []
    sort_keys: list[tuple[str, str, str, int, str, str]] = []
    unit_components: dict[str, str] = {}
    component_units: dict[str, str] = {}
    values: dict[tuple[str, str, str, int], dict[str, float]] = defaultdict(dict)
    arm_values: dict[str, dict[str, list[float]]] = {
        endpoint_id: {arm: [] for arm in ARMS} for endpoint_id in endpoints
    }
    for index, observation in enumerate(observations):
        if not isinstance(observation, dict):
            raise PilotError(f"observations[{index}] must be an object")
        _exact_keys(
            observation,
            {
                "observation_id",
                "endpoint_id",
                "independent_unit_id",
                "leakage_component_id",
                "replicate_id",
                "arm",
                "value",
            },
            f"observations[{index}]",
        )
        observation_id = _identifier(observation["observation_id"], f"observations[{index}].observation_id")
        endpoint_id = _identifier(observation["endpoint_id"], f"observations[{index}].endpoint_id")
        unit_id = _identifier(observation["independent_unit_id"], f"observations[{index}].independent_unit_id")
        component_id = _identifier(observation["leakage_component_id"], f"observations[{index}].leakage_component_id")
        if endpoint_id not in endpoints:
            raise PilotError(f"observation references unregistered endpoint: {endpoint_id}")
        replicate_id = observation["replicate_id"]
        if not isinstance(replicate_id, int) or isinstance(replicate_id, bool) or replicate_id < 1:
            raise PilotError(f"observations[{index}].replicate_id must be a positive integer")
        arm = observation["arm"]
        if arm not in ARMS:
            raise PilotError(f"observations[{index}].arm must be candidate or reference")
        value = _finite_number(observation["value"], f"observations[{index}].value")
        known_component = unit_components.setdefault(unit_id, component_id)
        if known_component != component_id:
            raise PilotError(f"independent unit {unit_id} crosses leakage components")
        known_unit = component_units.setdefault(component_id, unit_id)
        if known_unit != unit_id:
            raise PilotError(f"leakage component {component_id} crosses independent units")
        key = (endpoint_id, unit_id, component_id, replicate_id)
        if arm in values[key]:
            raise PilotError(f"duplicate arm measurement for {key}:{arm}")
        values[key][arm] = value
        arm_values[endpoint_id][arm].append(value)
        observation_ids.append(observation_id)
        sort_keys.append((*key, arm, observation_id))

    if len(observation_ids) != len(set(observation_ids)):
        raise PilotError("observation IDs must be unique")
    if sort_keys != sorted(sort_keys):
        raise PilotError("observations must be canonically sorted by endpoint/unit/component/replicate/arm/id")
    incomplete_pairs = [key for key, pair in values.items() if set(pair) != set(ARMS)]
    if incomplete_pairs:
        raise PilotError(f"paired pilot contains {len(incomplete_pairs)} incomplete candidate/reference pairs")

    reports: list[dict[str, Any]] = []
    blockers: list[str] = []
    observed_endpoints = {key[0] for key in values}
    for endpoint_id, model in endpoints.items():
        if endpoint_id not in observed_endpoints:
            blockers.append(f"pilot-endpoint-missing:{endpoint_id}")
            continue
        paired_values: dict[str, list[tuple[int, float]]] = defaultdict(list)
        for (current_endpoint, unit_id, _component_id, replicate_id), pair in values.items():
            if current_endpoint == endpoint_id:
                paired_values[unit_id].append((replicate_id, pair["candidate"] - pair["reference"]))
        report, endpoint_blockers = _build_endpoint_report(
            endpoint_id,
            model,
            paired_values,
            arm_values[endpoint_id],
            minimum_independent_units=minimum_independent_units,
            minimum_repeats_per_unit=minimum_repeats_per_unit,
        )
        reports.append(report)
        blockers.extend(endpoint_blockers)

    conservative_design_effect = max(
        (
            endpoint["cluster"]["design_effect"]
            for endpoint in reports
            if endpoint["cluster"] is not None
        ),
        default=None,
    )
    blockers = sorted(set(blockers))
    return {
        "schema_version": PILOT_REPORT_SCHEMA,
        "pilot_evidence_digest": document_sha256(raw),
        "endpoint_catalog_digest": document_sha256(raw["endpoint_catalog"]),
        "bindings": bindings,
        "minimum_independent_units": minimum_independent_units,
        "minimum_repeats_per_unit": minimum_repeats_per_unit,
        "status": "evidence-complete" if not blockers else "hold",
        "blockers": blockers,
        "conservative_design_effect": conservative_design_effect,
        "endpoints": reports,
        "freeze_policy": "descriptive-only-no-automatic-delta-or-sample-size-selection",
    }


def build_design_pilot_binding_report(observations: object, design: object) -> dict[str, Any]:
    """Bind raw pilot evidence to a complete power design without optimistic drift."""

    from .design import DesignError, build_power_report

    pilot_report = build_design_pilot_report(observations)
    validate_design_pilot_report(pilot_report)
    try:
        power_report = build_power_report(design)
    except DesignError as error:
        raise PilotError(f"power design is invalid: {error}") from error
    if not isinstance(design, dict):
        raise PilotError("power design must be an object")
    endpoint_catalog = [
        {"endpoint_id": endpoint["endpoint_id"], "model": endpoint["model"]}
        for endpoint in design["power_endpoints"]
    ]
    if pilot_report["endpoint_catalog_digest"] != document_sha256(endpoint_catalog):
        raise PilotError("pilot endpoint catalog does not match the power design")
    pilot_endpoints = {endpoint["endpoint_id"]: endpoint for endpoint in pilot_report["endpoints"]}
    if set(pilot_endpoints) != {endpoint["endpoint_id"] for endpoint in design["power_endpoints"]}:
        raise PilotError("pilot evidence must cover every power endpoint exactly")
    blockers = list(pilot_report["blockers"])
    blockers.extend(f"power-design:{blocker}" for blocker in power_report["blockers"])
    design_effect = design["design_effect"]
    if design_effect is not None and design_effect < pilot_report["conservative_design_effect"]:
        blockers.append("design-effect-understates-pilot")
    for endpoint in design["power_endpoints"]:
        endpoint_id = endpoint["endpoint_id"]
        pilot_endpoint = pilot_endpoints[endpoint_id]
        if (
            endpoint["model"] == "paired-mean"
            and endpoint["variability"] is not None
            and endpoint["variability"] < pilot_endpoint["planning_variability"]
        ):
            blockers.append(f"variability-understates-pilot:{endpoint_id}")
        if (
            endpoint["model"] == "binomial-upper"
            and endpoint["alternative"] is not None
            and endpoint["alternative"] < pilot_endpoint["rates"]["candidate"]["rate"]
        ):
            blockers.append(f"alternative-more-optimistic-than-pilot:{endpoint_id}")
        if (
            endpoint["model"] == "binomial-lower"
            and endpoint["alternative"] is not None
            and endpoint["alternative"] > pilot_endpoint["rates"]["candidate"]["rate"]
        ):
            blockers.append(f"alternative-more-optimistic-than-pilot:{endpoint_id}")
    blockers = sorted(set(blockers))
    return {
        "schema_version": PILOT_BINDING_SCHEMA,
        "status": "ready-to-freeze" if not blockers else "hold",
        "blockers": blockers,
        "pilot_report_digest": document_sha256(pilot_report),
        "pilot_evidence_digest": pilot_report["pilot_evidence_digest"],
        "frozen_dataset_digest": pilot_report["bindings"]["frozen_dataset_digest"],
        "leakage_audit_digest": pilot_report["bindings"]["leakage_audit_digest"],
        "evaluator_bundle_digest": pilot_report["bindings"]["evaluator_bundle_digest"],
        "design_digest": document_sha256(design),
        "power_report_digest": document_sha256(power_report),
        "required_independent_units": power_report["required_independent_units"],
        "required_clips": power_report["required_clips"],
        "planning_hypothesis_count": power_report["planning_hypothesis_count"],
    }


def validate_design_pilot_binding_report(raw: object) -> dict[str, Any]:
    """Validate the exact D0a artifact consumed by D0 and F0."""

    if not isinstance(raw, dict):
        raise PilotError("pilot binding report must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "blockers",
            "pilot_report_digest",
            "pilot_evidence_digest",
            "frozen_dataset_digest",
            "leakage_audit_digest",
            "evaluator_bundle_digest",
            "design_digest",
            "power_report_digest",
            "required_independent_units",
            "required_clips",
            "planning_hypothesis_count",
        },
        "pilot binding report",
    )
    if raw["schema_version"] != PILOT_BINDING_SCHEMA:
        raise PilotError("unsupported pilot binding report schema")
    if raw["status"] != "ready-to-freeze" or raw["blockers"] != []:
        raise PilotError("pilot binding report is not ready-to-freeze")
    for field in (
        "pilot_report_digest",
        "pilot_evidence_digest",
        "frozen_dataset_digest",
        "leakage_audit_digest",
        "evaluator_bundle_digest",
        "design_digest",
        "power_report_digest",
    ):
        _sha256(raw[field], f"pilot binding report.{field}")
    required_units = raw["required_independent_units"]
    required_clips = raw["required_clips"]
    hypothesis_count = raw["planning_hypothesis_count"]
    if not isinstance(required_units, int) or required_units < 30:
        raise PilotError("pilot binding report must require at least 30 independent units")
    if not isinstance(required_clips, int) or required_clips < required_units * 3:
        raise PilotError("pilot binding report must require at least three clips per independent unit")
    if hypothesis_count != 157:
        raise PilotError("pilot binding report must preserve the 157-hypothesis planning family")
    return raw
