"""Identity-cluster bootstrap measurements for frozen SFace decisions."""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Any, Literal

from .design import document_sha256

IDENTITY_PAIRS_SCHEMA = "ltx-av-eval-identity-pairs.v1"
IDENTITY_MEASUREMENTS_SCHEMA = "ltx-av-eval-identity-measurements.v1"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
MAX_PAIRS = 1_000_000
REQUIRED_STRATUM_PREFIXES = ("fitzpatrick.", "lighting.", "pose.")


class IdentityMeasurementError(ValueError):
    """Raised when identity evidence is incomplete or statistically invalid."""


@dataclass(frozen=True)
class _Pair:
    pair_id: str
    probe_identity_id: str
    reference_identity_id: str
    component_id: str
    strata: tuple[str, ...]
    similarity: float

    @property
    def expected_same(self) -> bool:
        return self.probe_identity_id == self.reference_identity_id


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise IdentityMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise IdentityMeasurementError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise IdentityMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise IdentityMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise IdentityMeasurementError(f"{context} must be a finite number")
    return float(value)


def _sorted_ids(raw: object, context: str) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise IdentityMeasurementError(f"{context} must be a non-empty list")
    identifiers = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if identifiers != sorted(set(identifiers)):
        raise IdentityMeasurementError(f"{context} must be unique and sorted")
    return identifiers


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise IdentityMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise IdentityMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_strata(raw: object) -> list[str]:
    if not isinstance(raw, dict):
        raise IdentityMeasurementError("strata contract must be an object")
    _exact_keys(raw, {"registered", "far", "frr"}, "strata contract")
    registered = _sorted_ids(raw["registered"], "strata.registered")
    far = _sorted_ids(raw["far"], "strata.far")
    frr = _sorted_ids(raw["frr"], "strata.frr")
    if far != registered or frr != registered:
        raise IdentityMeasurementError("every registered identity stratum must have both FAR and FRR decisions")
    for prefix in REQUIRED_STRATUM_PREFIXES:
        if not any(stratum.startswith(prefix) for stratum in registered):
            raise IdentityMeasurementError(f"identity strata must include a registered {prefix[:-1]} stratum")
    return registered


def _validate_pairs(raw: object, *, registered: list[str]) -> list[_Pair]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_PAIRS:
        raise IdentityMeasurementError(f"pairs must contain 2 to {MAX_PAIRS} observations")
    pairs: list[_Pair] = []
    pair_ids: list[str] = []
    probe_components: dict[str, str] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise IdentityMeasurementError(f"pair {index} must be an object")
        _exact_keys(
            item,
            {
                "pair_id",
                "probe_identity_id",
                "reference_identity_id",
                "probe_leakage_component_id",
                "strata",
                "similarity",
            },
            f"pair {index}",
        )
        pair_id = _identifier(item["pair_id"], f"pair {index}.pair_id")
        pair_ids.append(pair_id)
        probe_id = _identifier(item["probe_identity_id"], f"pair {pair_id}.probe_identity_id")
        reference_id = _identifier(item["reference_identity_id"], f"pair {pair_id}.reference_identity_id")
        component_id = _identifier(
            item["probe_leakage_component_id"],
            f"pair {pair_id}.probe_leakage_component_id",
        )
        previous_component = probe_components.setdefault(probe_id, component_id)
        if previous_component != component_id:
            raise IdentityMeasurementError(f"probe identity {probe_id} maps to multiple leakage components")
        strata = _sorted_ids(item["strata"], f"pair {pair_id}.strata")
        if not set(strata).issubset(registered):
            raise IdentityMeasurementError(f"pair {pair_id} contains an unregistered stratum")
        similarity = _number(item["similarity"], f"pair {pair_id}.similarity")
        if not -1 <= similarity <= 1:
            raise IdentityMeasurementError(f"pair {pair_id}.similarity must be between -1 and 1")
        pairs.append(_Pair(pair_id, probe_id, reference_id, component_id, tuple(strata), similarity))
    if pair_ids != sorted(set(pair_ids)):
        raise IdentityMeasurementError("pairs must have unique, sorted pair IDs")
    if not any(pair.expected_same for pair in pairs) or not any(not pair.expected_same for pair in pairs):
        raise IdentityMeasurementError("pairs must contain genuine and impostor comparisons")
    return pairs


def _subset(pairs: list[_Pair], stratum: str | None) -> list[_Pair]:
    return [pair for pair in pairs if stratum is None or stratum in pair.strata]


def _error_parts(pair: _Pair, *, kind: Literal["far", "frr"], threshold: float) -> tuple[int, int]:
    predicted_same = pair.similarity >= threshold
    if kind == "far":
        return (int(predicted_same), 1) if not pair.expected_same else (0, 0)
    return (int(not predicted_same), 1) if pair.expected_same else (0, 0)


def _bootstrap_error_rate(
    pairs: list[_Pair],
    *,
    kind: Literal["far", "frr"],
    threshold: float,
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    groups: dict[str, tuple[int, int]] = {}
    for pair in pairs:
        numerator, denominator = _error_parts(pair, kind=kind, threshold=threshold)
        if denominator:
            old_numerator, old_denominator = groups.get(pair.component_id, (0, 0))
            groups[pair.component_id] = (old_numerator + numerator, old_denominator + denominator)
    group_ids = sorted(groups)
    if len(group_ids) < 2:
        raise IdentityMeasurementError(f"{label} needs at least two independent probe leakage components")
    point = sum(value[0] for value in groups.values()) / sum(value[1] for value in groups.values())
    derived_seed = int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")
    generator = random.Random(derived_seed)
    samples: list[float] = []
    for _replicate in range(BOOTSTRAP_REPLICATES):
        selected = [groups[generator.choice(group_ids)] for _group_id in group_ids]
        samples.append(sum(value[0] for value in selected) / sum(value[1] for value in selected))
    samples.sort()
    lower = samples[math.floor(0.025 * (BOOTSTRAP_REPLICATES - 1))]
    upper = samples[math.ceil(0.975 * (BOOTSTRAP_REPLICATES - 1))]
    return point, lower, upper, len(group_ids)


def _metric(metric_id: str, values: tuple[float, float, float, int], *, stratum: str) -> dict[str, Any]:
    estimate, lower, upper, units = values
    return {
        "metric_id": metric_id,
        "estimate": estimate,
        "ci_lower": lower,
        "ci_upper": upper,
        "decision_stratum_id": stratum,
        "independent_units": units,
    }


def build_identity_measurements(raw: object) -> dict[str, Any]:
    """Compute frozen-threshold SFace FAR, FRR and TAR measurements."""

    if not isinstance(raw, dict):
        raise IdentityMeasurementError("identity pairs must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "sface_model_digest",
            "preprocessing_digest",
            "reference_gallery_digest",
            "threshold_policy_digest",
            "strata_plan_digest",
            "similarity_threshold",
            "bootstrap",
            "strata",
            "pairs",
        },
        "identity pairs",
    )
    if raw["schema_version"] != IDENTITY_PAIRS_SCHEMA:
        raise IdentityMeasurementError("unsupported identity pairs schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "sface_model_digest",
        "preprocessing_digest",
        "reference_gallery_digest",
        "threshold_policy_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    threshold = _number(raw["similarity_threshold"], "similarity_threshold")
    if not -1 <= threshold <= 1:
        raise IdentityMeasurementError("similarity_threshold must be between -1 and 1")
    seed = _validate_bootstrap(raw["bootstrap"])
    registered = _validate_strata(raw["strata"])
    pairs = _validate_pairs(raw["pairs"], registered=registered)
    overall_far = _bootstrap_error_rate(pairs, kind="far", threshold=threshold, seed=seed, label="far:overall")
    overall_frr = _bootstrap_error_rate(pairs, kind="frr", threshold=threshold, seed=seed, label="frr:overall")
    strata_far = {
        stratum: _bootstrap_error_rate(
            _subset(pairs, stratum),
            kind="far",
            threshold=threshold,
            seed=seed,
            label=f"far:{stratum}",
        )
        for stratum in registered
    }
    strata_frr = {
        stratum: _bootstrap_error_rate(
            _subset(pairs, stratum),
            kind="frr",
            threshold=threshold,
            seed=seed,
            label=f"frr:{stratum}",
        )
        for stratum in registered
    }
    worst_far = max(strata_far, key=lambda key: (strata_far[key][2], key))
    worst_frr = max(strata_frr, key=lambda key: (strata_frr[key][2], key))
    tar = (1 - overall_frr[0], 1 - overall_frr[2], 1 - overall_frr[1], overall_frr[3])
    metrics = [
        _metric("identity-far-ci-upper", overall_far, stratum="overall"),
        _metric("identity-far-ci-upper-worst-stratum", strata_far[worst_far], stratum=worst_far),
        _metric("identity-frr-ci-upper", overall_frr, stratum="overall"),
        _metric("identity-frr-ci-upper-worst-stratum", strata_frr[worst_frr], stratum=worst_frr),
        _metric("identity-tar-ci-lower", tar, stratum="overall"),
    ]
    metrics.sort(key=lambda metric: metric["metric_id"])
    return {
        "schema_version": IDENTITY_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "dataset_digest": raw["dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "sface_model_digest": raw["sface_model_digest"],
        "preprocessing_digest": raw["preprocessing_digest"],
        "reference_gallery_digest": raw["reference_gallery_digest"],
        "threshold_policy_digest": raw["threshold_policy_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "similarity_threshold": threshold,
        "bootstrap": raw["bootstrap"],
        "pairs": len(pairs),
        "independent_probe_leakage_components": len({pair.component_id for pair in pairs}),
        "metrics": metrics,
    }
