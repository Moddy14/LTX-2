"""Q1 anchor-landscape and comparator-matrix validation."""

from __future__ import annotations

from datetime import date
from typing import Any

from .design import document_sha256

LANDSCAPE_SCHEMA = "ltx-av-eval-anchor-landscape.v1"
MATRIX_SCHEMA = "ltx-av-eval-comparator-matrix.v1"
MATRIX_REPORT_SCHEMA = "ltx-av-eval-comparator-matrix-report.v1"
CLAIM_SPECS = {
    "audio-driven-video.image-audio-to-video": (
        "driving-audio-portrait",
        ["driving-audio", "prompt", "reference-image"],
        "ltx-audio-driven",
    ),
    "native-generation.text-to-video": (
        "native-dialog-generation",
        ["prompt-with-dialogue"],
        "ltx-native-generation",
    ),
    "native-generation.image-to-video": (
        "native-dialog-generation",
        ["one-or-more-reference-images", "prompt-with-dialogue"],
        "ltx-native-image-generation",
    ),
    "reference-video-redubbing.native-distilled": (
        "reference-video-redubbing",
        ["exact-target-dialogue", "reference-video", "single-speaker-acknowledgement", "target-language"],
        "ltx-lipdub-native-distilled",
    ),
    "reference-video-redubbing.official-comfy-hq": (
        "reference-video-redubbing",
        ["exact-target-dialogue", "reference-video", "single-speaker-acknowledgement", "target-language"],
        "ltx-lipdub-official-comfy-hq",
    ),
}
EXCLUSION_REASONS = {
    "input-contract-incompatible",
    "reproducibility-failed",
    "resource-fit-failed",
    "rights-blocked",
    "technical-minimum-failed",
}


class ComparatorMatrixError(ValueError):
    """Raised when comparator selection could be unfair or result-driven."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ComparatorMatrixError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ComparatorMatrixError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise ComparatorMatrixError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ComparatorMatrixError(f"{context} must be a lowercase SHA-256")
    return value


def _revision(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ComparatorMatrixError(f"{context} must be a lowercase 40-character content revision")
    return value


def _validate_landscape(  # noqa: PLR0912
    raw: object,
    *,
    as_of: date,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    if not isinstance(raw, dict):
        raise ComparatorMatrixError("anchor landscape must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "landscape_id",
            "cutoff_date",
            "search_protocol_sha256",
            "rights_policy_sha256",
            "candidates",
        },
        "anchor landscape",
    )
    if raw["schema_version"] != LANDSCAPE_SCHEMA or raw["status"] not in {"draft", "verified"}:
        raise ComparatorMatrixError("unsupported anchor landscape schema or status")
    _identifier(raw["landscape_id"], "landscape_id")
    blockers: list[str] = []
    cutoff = raw["cutoff_date"]
    if cutoff is None:
        blockers.append("landscape-cutoff-missing")
    elif not isinstance(cutoff, str):
        raise ComparatorMatrixError("landscape cutoff must be YYYY-MM-DD")
    else:
        try:
            cutoff_date = date.fromisoformat(cutoff)
        except ValueError as error:
            raise ComparatorMatrixError("landscape cutoff must be YYYY-MM-DD") from error
        if cutoff_date > as_of:
            raise ComparatorMatrixError("anchor landscape cutoff cannot be in the future")
    for field in ("search_protocol_sha256", "rights_policy_sha256"):
        if _sha256(raw[field], field, nullable=True) is None:
            blockers.append(f"{field.replace('_', '-')}-missing")
    candidates = raw["candidates"]
    if not isinstance(candidates, list) or not candidates:
        raise ComparatorMatrixError("anchor landscape needs external candidates")
    indexed: dict[str, dict[str, Any]] = {}
    identifiers: list[str] = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise ComparatorMatrixError(f"landscape candidate {index} must be an object")
        _exact_keys(
            candidate,
            {
                "candidate_id",
                "official_source",
                "code_revision",
                "weights_revision",
                "code_license_sha256",
                "weights_license_sha256",
                "resource_profile_sha256",
            },
            f"landscape candidate {index}",
        )
        candidate_id = _identifier(candidate["candidate_id"], f"landscape candidate {index}.candidate_id")
        identifiers.append(candidate_id)
        source = candidate["official_source"]
        if not isinstance(source, str) or not source.startswith("https://"):
            raise ComparatorMatrixError(f"landscape candidate {candidate_id} needs an HTTPS official source")
        for field in ("code_revision", "weights_revision"):
            if _revision(candidate[field], f"candidate {candidate_id}.{field}", nullable=True) is None:
                blockers.append(f"candidate-artifact-missing:{candidate_id}:{field}")
        for field in ("code_license_sha256", "weights_license_sha256", "resource_profile_sha256"):
            if _sha256(candidate[field], f"candidate {candidate_id}.{field}", nullable=True) is None:
                blockers.append(f"candidate-artifact-missing:{candidate_id}:{field}")
        indexed[candidate_id] = candidate
    if identifiers != sorted(set(identifiers)):
        raise ComparatorMatrixError("landscape candidates must be unique and sorted")
    if raw["status"] == "verified" and blockers:
        raise ComparatorMatrixError(f"verified anchor landscape is incomplete: {sorted(blockers)}")
    return indexed, blockers


def _validate_commitments(raw: object) -> list[str]:
    expected = {
        "applicable_gates",
        "failure_policy",
        "inclusion_criteria",
        "input_normalization",
        "prompt_set",
        "seed_policy",
    }
    if not isinstance(raw, list):
        raise ComparatorMatrixError("commitments must be a list")
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, commitment in enumerate(raw):
        if not isinstance(commitment, dict):
            raise ComparatorMatrixError(f"commitment {index} must be an object")
        _exact_keys(commitment, {"artifact_id", "sha256"}, f"commitment {index}")
        artifact_id = _identifier(commitment["artifact_id"], f"commitment {index}.artifact_id")
        identifiers.append(artifact_id)
        if _sha256(commitment["sha256"], f"commitment {artifact_id}.sha256", nullable=True) is None:
            blockers.append(f"commitment-missing:{artifact_id}")
    if identifiers != sorted(expected):
        raise ComparatorMatrixError("commitments must exactly match the sorted fairness inventory")
    return blockers


def _validate_arm(  # noqa: PLR0912
    raw: object,
    *,
    context: str,
    candidate_id: str,
    landscape: dict[str, dict[str, Any]],
) -> list[str]:
    if not isinstance(raw, dict):
        raise ComparatorMatrixError(f"{context} must be an object")
    _exact_keys(
        raw,
        {
            "arm_id",
            "provider",
            "inclusion_status",
            "input_compatibility",
            "rights_status",
            "technical_status",
            "code_revision",
            "weights_revision",
            "exclusion_reason",
            "quality_evidence_seen",
        },
        context,
    )
    arm_id = _identifier(raw["arm_id"], f"{context}.arm_id")
    if arm_id != candidate_id:
        raise ComparatorMatrixError(f"{context} is not sorted by its declared arm ID")
    if raw["quality_evidence_seen"] is not False:
        raise ComparatorMatrixError(f"{context} must be selected before quality evidence is seen")
    external = raw["provider"] == "external"
    if raw["provider"] not in {"owned", "external"} or external != (arm_id in landscape):
        raise ComparatorMatrixError(f"{context} provider does not match the anchor landscape")
    inclusion = raw["inclusion_status"]
    if inclusion not in {"pending", "included", "excluded"}:
        raise ComparatorMatrixError(f"{context} has an unsupported inclusion status")
    for field, allowed in (
        ("input_compatibility", {"pending", "compatible", "incompatible"}),
        ("rights_status", {"pending", "clear", "blocked"}),
        ("technical_status", {"pending", "pass", "fail"}),
    ):
        if raw[field] not in allowed:
            raise ComparatorMatrixError(f"{context}.{field} is unsupported")
    code = _revision(raw["code_revision"], f"{context}.code_revision", nullable=True)
    weights = _revision(raw["weights_revision"], f"{context}.weights_revision", nullable=True)
    blockers: list[str] = []
    if inclusion == "pending":
        blockers.append(f"arm-pending:{arm_id}")
    elif inclusion == "included":
        if (raw["input_compatibility"], raw["rights_status"], raw["technical_status"]) != (
            "compatible",
            "clear",
            "pass",
        ):
            raise ComparatorMatrixError(f"included arm {arm_id} is not compatible, rights-clear, and functional")
        if code is None or weights is None:
            blockers.append(f"arm-artifacts-missing:{arm_id}")
        if raw["exclusion_reason"] is not None:
            raise ComparatorMatrixError(f"included arm {arm_id} cannot have an exclusion reason")
    else:
        if raw["exclusion_reason"] not in EXCLUSION_REASONS:
            raise ComparatorMatrixError(f"excluded arm {arm_id} needs an objective exclusion reason")
        reason = raw["exclusion_reason"]
        if reason == "input-contract-incompatible" and raw["input_compatibility"] != "incompatible":
            raise ComparatorMatrixError(f"excluded arm {arm_id} does not prove input incompatibility")
        if reason == "rights-blocked" and raw["rights_status"] != "blocked":
            raise ComparatorMatrixError(f"excluded arm {arm_id} does not prove a rights block")
        if (
            reason in {"reproducibility-failed", "resource-fit-failed", "technical-minimum-failed"}
            and raw["technical_status"] != "fail"
        ):
            raise ComparatorMatrixError(f"excluded arm {arm_id} does not prove its technical failure")
    if external and code is not None and code != landscape[arm_id]["code_revision"]:
        raise ComparatorMatrixError(f"arm {arm_id} code does not match the anchor landscape")
    if external and weights is not None and weights != landscape[arm_id]["weights_revision"]:
        raise ComparatorMatrixError(f"arm {arm_id} weights do not match the anchor landscape")
    return blockers


def _validate_claim(  # noqa: PLR0912
    raw: object,
    landscape: dict[str, dict[str, Any]],
) -> tuple[str, list[str]]:
    if not isinstance(raw, dict):
        raise ComparatorMatrixError("claim row must be an object")
    _exact_keys(
        raw,
        {"claim_id", "task_type", "input_contract", "claim_status", "sota_anchor_arm_id", "arms"},
        "claim row",
    )
    claim_id = _identifier(raw["claim_id"], "claim_id")
    if claim_id not in CLAIM_SPECS:
        raise ComparatorMatrixError(f"unsupported comparator claim: {claim_id}")
    task_type, input_contract, owned_arm_id = CLAIM_SPECS[claim_id]
    if raw["task_type"] != task_type or raw["input_contract"] != input_contract:
        raise ComparatorMatrixError(f"input contract changed for {claim_id}")
    arms = raw["arms"]
    if not isinstance(arms, list):
        raise ComparatorMatrixError(f"arms for {claim_id} must be a list")
    expected_arm_ids = sorted([owned_arm_id, *landscape])
    actual_arm_ids = [arm.get("arm_id") if isinstance(arm, dict) else None for arm in arms]
    if actual_arm_ids != expected_arm_ids:
        raise ComparatorMatrixError(f"arms for {claim_id} must include every landscape candidate and the owned arm")
    blockers: list[str] = []
    for arm, arm_id in zip(arms, expected_arm_ids, strict=True):
        blockers.extend(
            _validate_arm(arm, context=f"claim {claim_id} arm {arm_id}", candidate_id=arm_id, landscape=landscape)
        )
    status = raw["claim_status"]
    anchor_id = raw["sota_anchor_arm_id"]
    indexed = {arm["arm_id"]: arm for arm in arms}
    if indexed[owned_arm_id]["inclusion_status"] != "included":
        blockers.append(f"owned-candidate-not-included:{claim_id}")
    if status == "undecided":
        blockers.append(f"claim-undecided:{claim_id}")
    elif status == "sota-target":
        if anchor_id not in landscape or indexed[anchor_id]["inclusion_status"] != "included":
            raise ComparatorMatrixError(f"SOTA target {claim_id} needs an included external anchor")
    elif status == "local-only":
        if anchor_id is not None:
            raise ComparatorMatrixError(f"local-only claim {claim_id} cannot name a SOTA anchor")
    else:
        raise ComparatorMatrixError(f"unsupported claim status for {claim_id}")
    return claim_id, blockers


def build_comparator_matrix_report(raw: object, *, landscape: object, as_of: date) -> dict[str, Any]:
    """Validate Q1 comparator fairness before any calibration quality result."""

    if not isinstance(raw, dict):
        raise ComparatorMatrixError("comparator matrix must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "matrix_id",
            "landscape_sha256",
            "commitments",
            "target_sota_claim_ids",
            "claims",
        },
        "comparator matrix",
    )
    if raw["schema_version"] != MATRIX_SCHEMA or raw["status"] not in {"draft", "frozen"}:
        raise ComparatorMatrixError("unsupported comparator matrix schema or status")
    _identifier(raw["matrix_id"], "matrix_id")
    blockers = _validate_commitments(raw["commitments"])
    landscape_index, landscape_blockers = _validate_landscape(landscape, as_of=as_of)
    blockers.extend(landscape_blockers)
    if isinstance(landscape, dict) and landscape.get("status") != "verified":
        blockers.append("anchor-landscape-not-verified")
    digest = document_sha256(landscape)
    bound = _sha256(raw["landscape_sha256"], "landscape_sha256", nullable=True)
    if bound is None:
        blockers.append("landscape-sha256-missing")
    elif bound != digest:
        raise ComparatorMatrixError("anchor landscape digest does not match the matrix")
    claims = raw["claims"]
    if not isinstance(claims, list):
        raise ComparatorMatrixError("claims must be a list")
    claim_ids: list[str] = []
    for claim in claims:
        claim_id, claim_blockers = _validate_claim(claim, landscape_index)
        claim_ids.append(claim_id)
        blockers.extend(claim_blockers)
    if claim_ids != sorted(CLAIM_SPECS):
        raise ComparatorMatrixError("claims must exactly match the sorted Q1 claim inventory")
    targets = raw["target_sota_claim_ids"]
    if not isinstance(targets, list) or targets != sorted(set(targets)):
        raise ComparatorMatrixError("target_sota_claim_ids must be unique and sorted")
    declared_targets = sorted(claim["claim_id"] for claim in claims if claim["claim_status"] == "sota-target")
    if targets != declared_targets:
        raise ComparatorMatrixError("target_sota_claim_ids do not match the target claim rows")
    blockers = sorted(set(blockers))
    if raw["status"] == "frozen" and blockers:
        raise ComparatorMatrixError(f"frozen comparator matrix is incomplete: {blockers}")
    return {
        "schema_version": MATRIX_REPORT_SCHEMA,
        "matrix_digest": document_sha256(raw),
        "status": "ready-to-freeze" if not blockers else "hold",
        "sota_status": "anchor-ready" if not blockers and targets else "hold",
        "blockers": blockers,
        "target_sota_claim_ids": targets,
        "commitments_digest": document_sha256(raw["commitments"]),
        "claims_digest": document_sha256(raw["claims"]),
    }
