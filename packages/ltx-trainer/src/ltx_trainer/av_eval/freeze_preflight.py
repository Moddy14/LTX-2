"""F0 preflight binding frozen evidence before the one-shot Q2 authorization."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .authorization import (
    AuthorizationError,
    studio_sha256_document,
    validate_evaluation_authorization,
    verify_detached_signature,
)
from .comparator_result import DECISION_SCHEMA as Q1_DECISION_SCHEMA
from .complete import COMPLETE_D1_REPORT_SCHEMA
from .cross_shot_result import CROSS_SHOT_DECISION_SCHEMA
from .design import REPORT_SCHEMA as DESIGN_REPORT_SCHEMA
from .design import document_sha256
from .governance import GovernanceError, validate_preregistration
from .readiness import READINESS_REPORT_SCHEMA

F0_CANDIDATE_SCHEMA = "ltx-av-eval-f0-candidate.v1"
F0_REPORT_SCHEMA = "ltx-av-eval-f0-preflight-report.v1"
QUALIFICATION_BUNDLE_SCHEMA = "ltx-av-eval-f0-qualification-bundle.v1"
STUDIO_QUALIFICATION_SCHEMA = "ltx-studio-qualification-report.v1"
STUDIO_RIGHTS_SCHEMA = "ltx-studio-rights-attestation.v1"
STUDIO_TRUST_SCHEMA = "ltx-studio-trusted-keys.v1"
DETAILED_REPORT_IDS = {
    "d0-readiness",
    "d0a-design",
    "d1-calibration",
    "q0-cross-shot",
    "q1-comparators",
}
PRE_Q2_QUALIFICATION_KINDS = {
    "d1-calibration",
    "q0-cross-shot",
    "q1-comparators",
    "r0-control-plane",
    "r1-reproducible-build",
    "r3-canaries",
    "r3-pause-resume",
    "r3-soak",
}
RELEASE_GATE_IDS = {
    "asr-critical-token",
    "audio-quality",
    "av-sync",
    "cold-canary",
    "identity",
    "mos",
    "mouth-artifact",
    "phoneme-viseme",
    "playable-output",
    "provenance",
    "runtime-import",
    "sharpness",
    "vbench-i2v",
}
QUALIFICATION_GATE_OWNERSHIP = {
    "d1-calibration": {
        "asr-critical-token",
        "audio-quality",
        "av-sync",
        "identity",
        "mouth-artifact",
        "phoneme-viseme",
        "sharpness",
        "vbench-i2v",
    },
    "q0-cross-shot": {"av-sync", "identity", "mouth-artifact", "phoneme-viseme", "sharpness", "vbench-i2v"},
    "q1-comparators": {
        "asr-critical-token",
        "audio-quality",
        "av-sync",
        "identity",
        "mouth-artifact",
        "phoneme-viseme",
        "sharpness",
        "vbench-i2v",
    },
    "r0-control-plane": set(),
    "r1-reproducible-build": {"runtime-import"},
    "r3-canaries": {"cold-canary", "playable-output", "provenance"},
    "r3-pause-resume": set(),
    "r3-soak": set(),
}
STUDIO_TRUST_ROLES = {
    "audit-finalizer",
    "evaluation-authorizer",
    "holdout-scorer",
    "preregistration-freezer",
    "qualification-attestor",
    "release-authorizer",
    "rights-attestor",
}


class FreezePreflightError(ValueError):
    """Raised when F0 evidence cannot safely authorize the sealed Q2 run."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise FreezePreflightError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise FreezePreflightError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise FreezePreflightError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise FreezePreflightError(f"{context} must be a lowercase SHA-256")
    return value


def _timestamp(value: object, context: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise FreezePreflightError(f"{context} must be a whole-second UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise FreezePreflightError(f"{context} is invalid") from error
    if parsed.tzinfo != UTC or parsed.microsecond:
        raise FreezePreflightError(f"{context} must be a whole-second UTC timestamp")
    return parsed


def _digest_index(raw: object, *, expected: set[str], context: str, id_field: str) -> dict[str, str]:
    if not isinstance(raw, list):
        raise FreezePreflightError(f"{context} must be a list")
    result: dict[str, str] = {}
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise FreezePreflightError(f"{context} {index} must be an object")
        _exact_keys(item, {id_field, "sha256"}, f"{context} {index}")
        identifier = _identifier(item[id_field], f"{context} {index}.{id_field}")
        identifiers.append(identifier)
        result[identifier] = _sha256(item["sha256"], f"{context} {identifier}.sha256")
    if identifiers != sorted(expected):
        raise FreezePreflightError(f"{context} must exactly match its sorted required inventory")
    return result


def _validate_candidate(raw: object) -> tuple[dict[str, Any], dict[str, str], dict[str, str]]:
    if not isinstance(raw, dict):
        raise FreezePreflightError("F0 candidate must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "candidate_id",
            "release_digest",
            "surface_digest",
            "mapping_sha256",
            "rights_evidence_catalog_digest",
            "holdout_digest",
            "q2_runner_digest",
            "transaction_id",
            "nonce_sha256",
            "trust_policy_digest",
            "preregistration_digest",
            "rights_attestation_digest",
            "evaluation_authorization_digest",
            "target_sota_claim_ids",
            "detailed_reports",
            "qualification_reports",
            "invalidation_events",
        },
        "F0 candidate",
    )
    if raw["schema_version"] != F0_CANDIDATE_SCHEMA:
        raise FreezePreflightError("unsupported F0 candidate schema")
    _identifier(raw["candidate_id"], "candidate_id")
    for field in (
        "release_digest",
        "surface_digest",
        "mapping_sha256",
        "rights_evidence_catalog_digest",
        "holdout_digest",
        "q2_runner_digest",
        "nonce_sha256",
        "trust_policy_digest",
        "preregistration_digest",
        "rights_attestation_digest",
        "evaluation_authorization_digest",
    ):
        _sha256(raw[field], field)
    _identifier(raw["transaction_id"], "transaction_id")
    targets = raw["target_sota_claim_ids"]
    if not isinstance(targets, list) or not targets or targets != sorted(set(targets)):
        raise FreezePreflightError("F0 target_sota_claim_ids must be a non-empty sorted unique list")
    for index, target in enumerate(targets):
        _identifier(target, f"target_sota_claim_ids[{index}]")
    if raw["invalidation_events"] != []:
        raise FreezePreflightError("F0 cannot proceed with unresolved invalidation events")
    detailed = _digest_index(
        raw["detailed_reports"],
        expected=DETAILED_REPORT_IDS,
        context="detailed reports",
        id_field="report_id",
    )
    qualifications = _digest_index(
        raw["qualification_reports"],
        expected=PRE_Q2_QUALIFICATION_KINDS,
        context="qualification reports",
        id_field="kind",
    )
    return raw, detailed, qualifications


def validate_f0_candidate(raw: object) -> dict[str, Any]:
    """Validate and normalize the signed F0 candidate index for downstream Q2 tooling."""

    candidate, _detailed, _qualifications = _validate_candidate(raw)
    return candidate


def _validate_preregistration_binding(
    candidate: dict[str, Any],
    preregistration: object,
    signature: object,
    trust_policy: object,
    *,
    now: datetime,
) -> dict[str, Any]:
    try:
        validated = validate_preregistration(preregistration, mapping_sha256=candidate["mapping_sha256"])
        digest = verify_detached_signature(
            validated,
            signature,
            trust_policy,
            required_role="preregistration-freezer",
            now=now,
        )
    except (GovernanceError, AuthorizationError) as error:
        raise FreezePreflightError(f"frozen preregistration rejected: {error}") from error
    if validated["status"] != "frozen" or digest != candidate["preregistration_digest"]:
        raise FreezePreflightError("F0 preregistration is not frozen or digest-bound")
    if validated["target_sota_claim_ids"] != candidate["target_sota_claim_ids"]:
        raise FreezePreflightError("F0 target claims do not match the frozen preregistration")
    commitments = validated["holdout_commitments"]
    if commitments["evaluation_runner_sha256"] != candidate["q2_runner_digest"]:
        raise FreezePreflightError("Q2 runner does not match the frozen evaluation runner")
    return validated


def _validate_rights(
    candidate: dict[str, Any],
    raw: object,
    signature: object,
    trust_policy: object,
    *,
    now: datetime,
    required_until: datetime,
) -> None:
    if not isinstance(raw, dict):
        raise FreezePreflightError("rights attestation must be an object")
    _exact_keys(
        raw,
        {
            "schemaVersion",
            "releaseDigest",
            "surfaceDigest",
            "evidenceCatalogDigest",
            "policyVersion",
            "validAt",
            "expiresAt",
            "revocationState",
            "evidenceIds",
            "warnings",
        },
        "rights attestation",
    )
    if raw["schemaVersion"] != STUDIO_RIGHTS_SCHEMA or raw["policyVersion"] != "ltx-studio-release-rights.v1":
        raise FreezePreflightError("unsupported rights attestation schema or policy")
    evidence_ids = raw["evidenceIds"]
    if not isinstance(evidence_ids, list) or not evidence_ids or len(evidence_ids) != len(set(evidence_ids)):
        raise FreezePreflightError("rights attestation needs unique evidence IDs")
    for index, evidence_id in enumerate(evidence_ids):
        _identifier(evidence_id, f"rights evidenceIds[{index}]")
    if raw["warnings"] != [] or raw["revocationState"] != "clear":
        raise FreezePreflightError("rights attestation contains warnings or a revocation")
    valid_at = _timestamp(raw["validAt"], "rights validAt")
    expires_at = _timestamp(raw["expiresAt"], "rights expiresAt")
    if not valid_at <= now or expires_at < required_until:
        raise FreezePreflightError("rights window does not cover F0 through the Q2 completion deadline")
    expected = {
        "releaseDigest": candidate["release_digest"],
        "surfaceDigest": candidate["surface_digest"],
        "evidenceCatalogDigest": candidate["rights_evidence_catalog_digest"],
    }
    if any(raw[field] != value for field, value in expected.items()):
        raise FreezePreflightError("rights attestation is bound to different release evidence")
    try:
        digest = verify_detached_signature(
            raw,
            signature,
            trust_policy,
            required_role="rights-attestor",
            now=now,
        )
    except AuthorizationError as error:
        raise FreezePreflightError(f"rights signature rejected: {error}") from error
    if digest != candidate["rights_attestation_digest"]:
        raise FreezePreflightError("rights attestation digest mismatch")


def _validate_surface(  # noqa: PLR0912
    candidate: dict[str, Any], raw: object, rights_attestation: object
) -> dict[str, set[str]]:
    if not isinstance(raw, dict) or raw.get("schemaVersion") != "candidate-release-surface.v1":
        raise FreezePreflightError("candidate release surface schema mismatch")
    if studio_sha256_document(raw) != candidate["surface_digest"]:
        raise FreezePreflightError("candidate release surface digest mismatch")
    entries = raw.get("entries")
    if not isinstance(entries, list):
        raise FreezePreflightError("candidate release surface entries must be a list")
    candidate_entries: dict[str, set[str]] = {}
    candidate_claims: set[str] = set()
    required_rights: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise FreezePreflightError(f"surface entry {index} must be an object")
        if entry.get("targetStatus") != "candidate":
            continue
        entry_id = _identifier(entry.get("id"), f"surface entry {index}.id")
        claim_id = _identifier(entry.get("claimId"), f"surface entry {entry_id}.claimId")
        gates = entry.get("applicableGates")
        if (
            not isinstance(gates, list)
            or not gates
            or len(gates) != len(set(gates))
            or any(gate not in RELEASE_GATE_IDS for gate in gates)
        ):
            raise FreezePreflightError(f"surface entry {entry_id} has invalid applicable gates")
        rights = entry.get("rights")
        if not isinstance(rights, dict) or rights.get("status") != "conditional":
            raise FreezePreflightError(f"surface entry {entry_id} is not conditionally rights-gated")
        evidence_ids = rights.get("evidenceIds")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            raise FreezePreflightError(f"surface entry {entry_id} has no rights evidence")
        required_rights.update(evidence_ids)
        if entry_id in candidate_entries:
            raise FreezePreflightError(f"duplicate candidate surface entry: {entry_id}")
        candidate_entries[entry_id] = set(gates)
        candidate_claims.add(claim_id)
    if not candidate_entries:
        raise FreezePreflightError("candidate release surface has no candidate entries")
    if not set(candidate["target_sota_claim_ids"]).issubset(candidate_claims):
        raise FreezePreflightError("F0 target claim has no candidate release-surface entry")
    if not isinstance(rights_attestation, dict):
        raise FreezePreflightError("rights attestation must be an object")
    if not required_rights.issubset(set(rights_attestation.get("evidenceIds", []))):
        raise FreezePreflightError("rights attestation misses candidate surface evidence")
    return candidate_entries


def _validate_detailed_reports(  # noqa: PLR0912
    candidate: dict[str, Any],
    expected_digests: dict[str, str],
    reports: object,
    preregistration: dict[str, Any],
) -> dict[str, str]:
    if not isinstance(reports, dict) or set(reports) != DETAILED_REPORT_IDS:
        raise FreezePreflightError("detailed report documents must exactly match the F0 inventory")
    for report_id, report in reports.items():
        if document_sha256(report) != expected_digests[report_id]:
            raise FreezePreflightError(f"detailed report digest mismatch: {report_id}")
    d0 = reports["d0-readiness"]
    design = reports["d0a-design"]
    d1 = reports["d1-calibration"]
    q0 = reports["q0-cross-shot"]
    q1 = reports["q1-comparators"]
    if not isinstance(d0, dict) or d0.get("schema_version") != READINESS_REPORT_SCHEMA:
        raise FreezePreflightError("D0 readiness report schema mismatch")
    if d0.get("status") != "ready-to-freeze" or d0.get("blockers") != []:
        raise FreezePreflightError("D0 readiness report is not ready-to-freeze")
    if not isinstance(design, dict) or design.get("schema_version") != DESIGN_REPORT_SCHEMA:
        raise FreezePreflightError("D0a design report schema mismatch")
    if design.get("status") != "ready-to-freeze" or design.get("blockers") != []:
        raise FreezePreflightError("D0a design report is not ready-to-freeze")
    if not isinstance(d1, dict) or d1.get("schema_version") != COMPLETE_D1_REPORT_SCHEMA or d1.get("verdict") != "pass":
        raise FreezePreflightError("D1 report is not a complete pass")
    if not isinstance(q0, dict) or q0.get("schema_version") != CROSS_SHOT_DECISION_SCHEMA:
        raise FreezePreflightError("Q0 decision schema mismatch")
    if q0.get("verdict") not in {"winner", "abstention"}:
        raise FreezePreflightError("Q0 must contain a winner or an explicit abstention")
    if not isinstance(q1, dict) or q1.get("schema_version") != Q1_DECISION_SCHEMA:
        raise FreezePreflightError("Q1 decision schema mismatch")
    if q1.get("status") != "ready-to-freeze" or q1.get("sota_status") != "anchor-pilot-pass":
        raise FreezePreflightError("Q1 target comparator pilot did not pass")
    for report_id, report in (("D1", d1), ("Q0", q0), ("Q1", q1)):
        if report.get("release_digest") != candidate["release_digest"]:
            raise FreezePreflightError(f"{report_id} release digest mismatch")
        if report.get("preregistration_digest") != candidate["preregistration_digest"]:
            raise FreezePreflightError(f"{report_id} preregistration digest mismatch")
    if q1.get("target_sota_claim_ids") != candidate["target_sota_claim_ids"]:
        raise FreezePreflightError("Q1 target claims do not match F0")
    if d1.get("design_digest") != design.get("design_digest") or q0.get("design_digest") != design.get("design_digest"):
        raise FreezePreflightError("D0a design digest is not shared by D1 and Q0")
    if d1.get("dataset_digest") != q0.get("dataset_digest") or d1.get("dataset_digest") != q1.get(
        "calibration_dataset_digest"
    ):
        raise FreezePreflightError("D1, Q0, and Q1 do not share the calibration dataset")
    commitments = preregistration["holdout_commitments"]
    if commitments["prompt_set_sha256"] != q0.get("prompt_set_digest"):
        raise FreezePreflightError("Q0 prompt set does not match the frozen preregistration")
    if commitments["rating_protocol_sha256"] != q0.get("rating_protocol_digest"):
        raise FreezePreflightError("Q0 rating protocol does not match the frozen preregistration")
    if commitments["baseline_matrix_sha256"] != q1.get("comparator_matrix_digest"):
        raise FreezePreflightError("Q1 matrix does not match the frozen preregistration")
    return {
        "d1-calibration": expected_digests["d1-calibration"],
        "q0-cross-shot": expected_digests["q0-cross-shot"],
        "q1-comparators": expected_digests["q1-comparators"],
    }


def _validate_coverage(raw: object, *, context: str) -> list[tuple[str, set[str]]]:
    if not isinstance(raw, list):
        raise FreezePreflightError(f"{context} coverage must be a list")
    entry_ids: list[str] = []
    result: list[tuple[str, set[str]]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise FreezePreflightError(f"{context} coverage {index} must be an object")
        _exact_keys(entry, {"surfaceEntryId", "gates"}, f"{context} coverage {index}")
        entry_ids.append(_identifier(entry["surfaceEntryId"], f"{context} coverage {index}.surfaceEntryId"))
        gates = entry["gates"]
        if not isinstance(gates, list) or not gates or len(gates) != len(set(gates)):
            raise FreezePreflightError(f"{context} coverage gates must be non-empty and unique")
        if any(gate not in RELEASE_GATE_IDS for gate in gates):
            raise FreezePreflightError(f"{context} coverage contains an unknown release gate")
        result.append((entry_ids[-1], set(gates)))
    if len(entry_ids) != len(set(entry_ids)):
        raise FreezePreflightError(f"{context} coverage contains duplicate surface entries")
    return result


def _validate_qualification_reports(  # noqa: PLR0912
    candidate: dict[str, Any],
    expected_digests: dict[str, str],
    bundle: object,
    trust_policy: object,
    detailed_producers: dict[str, str],
    candidate_entries: dict[str, set[str]],
    *,
    now: datetime,
) -> None:
    if not isinstance(bundle, dict):
        raise FreezePreflightError("qualification bundle must be an object")
    _exact_keys(bundle, {"schema_version", "reports"}, "qualification bundle")
    if bundle["schema_version"] != QUALIFICATION_BUNDLE_SCHEMA or not isinstance(bundle["reports"], list):
        raise FreezePreflightError("unsupported qualification bundle")
    observed: list[str] = []
    passed_coverage = {entry_id: set() for entry_id in candidate_entries}
    for index, envelope in enumerate(bundle["reports"]):
        if not isinstance(envelope, dict):
            raise FreezePreflightError(f"qualification envelope {index} must be an object")
        _exact_keys(envelope, {"document", "signature"}, f"qualification envelope {index}")
        report = envelope["document"]
        if not isinstance(report, dict):
            raise FreezePreflightError(f"qualification report {index} must be an object")
        _exact_keys(
            report,
            {
                "schemaVersion",
                "kind",
                "releaseDigest",
                "preregistrationDigest",
                "surfaceDigest",
                "producerId",
                "producerDigest",
                "verdict",
                "warnings",
                "coverage",
                "claimResults",
            },
            f"qualification report {index}",
        )
        kind = _identifier(report["kind"], f"qualification report {index}.kind")
        observed.append(kind)
        if report["schemaVersion"] != STUDIO_QUALIFICATION_SCHEMA or kind not in PRE_Q2_QUALIFICATION_KINDS:
            raise FreezePreflightError(f"unsupported pre-Q2 qualification report: {kind}")
        if report["verdict"] != "pass" or report["warnings"] != [] or report["claimResults"] != []:
            raise FreezePreflightError(f"qualification report is not an unqualified pre-Q2 pass: {kind}")
        _identifier(report["producerId"], f"qualification report {kind}.producerId")
        _sha256(report["producerDigest"], f"qualification report {kind}.producerDigest")
        if (
            report["releaseDigest"] != candidate["release_digest"]
            or report["preregistrationDigest"] != candidate["preregistration_digest"]
            or report["surfaceDigest"] != candidate["surface_digest"]
        ):
            raise FreezePreflightError(f"qualification report binding mismatch: {kind}")
        coverage = _validate_coverage(report["coverage"], context=f"qualification report {kind}")
        allowed_gates = QUALIFICATION_GATE_OWNERSHIP[kind]
        for entry_id, gates in coverage:
            if entry_id not in candidate_entries:
                raise FreezePreflightError(f"qualification report {kind} covers a non-candidate entry")
            if not gates.issubset(allowed_gates):
                raise FreezePreflightError(f"qualification report {kind} claims gates it does not own")
            if not gates.issubset(candidate_entries[entry_id]):
                raise FreezePreflightError(f"qualification report {kind} claims non-applicable gates")
            passed_coverage[entry_id].update(gates)
        digest = studio_sha256_document(report)
        if digest != expected_digests[kind]:
            raise FreezePreflightError(f"qualification report digest mismatch: {kind}")
        try:
            verified = verify_detached_signature(
                report,
                envelope["signature"],
                trust_policy,
                required_role="qualification-attestor",
                now=now,
            )
        except AuthorizationError as error:
            raise FreezePreflightError(f"qualification signature rejected for {kind}: {error}") from error
        if verified != digest:
            raise FreezePreflightError(f"qualification signature digest mismatch: {kind}")
        if kind in detailed_producers and report["producerDigest"] != detailed_producers[kind]:
            raise FreezePreflightError(f"qualification producer does not bind the detailed {kind} report")
    if observed != sorted(PRE_Q2_QUALIFICATION_KINDS):
        raise FreezePreflightError("qualification bundle must exactly match the sorted pre-Q2 inventory")
    for entry_id, applicable_gates in candidate_entries.items():
        missing = (applicable_gates - {"mos"}) - passed_coverage[entry_id]
        if missing:
            raise FreezePreflightError(f"candidate {entry_id} lacks pre-Q2 qualification gates: {sorted(missing)}")


def _signature_key_id(signature: object, context: str) -> str:
    if not isinstance(signature, dict) or signature.get("schemaVersion") != "ltx-studio-detached-signature.v1":
        raise FreezePreflightError(f"{context} must use the canonical Studio detached-signature schema")
    return _identifier(signature.get("keyId"), f"{context}.keyId")


def _validate_studio_trust_policy(raw: dict[str, Any]) -> None:
    _exact_keys(raw, {"schemaVersion", "policyId", "keys"}, "trusted-key policy")
    _identifier(raw["policyId"], "trusted-key policyId")
    keys = raw["keys"]
    if not isinstance(keys, list) or not keys:
        raise FreezePreflightError("trusted-key policy must contain keys")
    key_ids: list[str] = []
    for index, key in enumerate(keys):
        if not isinstance(key, dict):
            raise FreezePreflightError(f"trusted key {index} must be an object")
        _exact_keys(
            key,
            {"keyId", "algorithm", "publicKeyBase64", "roles", "notBefore", "notAfter", "revokedAt"},
            f"trusted key {index}",
        )
        key_ids.append(_identifier(key["keyId"], f"trusted key {index}.keyId"))
        if key["algorithm"] != "ed25519" or not isinstance(key["publicKeyBase64"], str):
            raise FreezePreflightError(f"trusted key {index} is not an Ed25519 key")
        roles = key["roles"]
        if (
            not isinstance(roles, list)
            or not roles
            or len(roles) != len(set(roles))
            or any(role not in STUDIO_TRUST_ROLES for role in roles)
        ):
            raise FreezePreflightError(f"trusted key {index} has invalid roles")
        not_before = _timestamp(key["notBefore"], f"trusted key {index}.notBefore")
        not_after = _timestamp(key["notAfter"], f"trusted key {index}.notAfter")
        if not_before >= not_after:
            raise FreezePreflightError(f"trusted key {index} has an inconsistent validity window")
        if key["revokedAt"] is not None:
            _timestamp(key["revokedAt"], f"trusted key {index}.revokedAt")
        if "release-authorizer" in roles and "audit-finalizer" in roles:
            raise FreezePreflightError("release authorization and audit finalization require separate keys")
        if "evaluation-authorizer" in roles and ({"release-authorizer", "audit-finalizer"} & set(roles)):
            raise FreezePreflightError("evaluation and release/finalization authorization require separate keys")
        if "holdout-scorer" in roles and len(roles) != 1:
            raise FreezePreflightError("holdout scoring requires a dedicated signing key")
    if len(key_ids) != len(set(key_ids)):
        raise FreezePreflightError("trusted-key policy keys must be unique")


def _require_key_valid_until(raw: dict[str, Any], *, key_id: str, required_until: datetime, context: str) -> None:
    matches = [key for key in raw["keys"] if key["keyId"] == key_id]
    if len(matches) != 1:
        raise FreezePreflightError(f"{context} key is not uniquely present in the trust policy")
    key = matches[0]
    if _timestamp(key["notAfter"], f"{context} key notAfter") < required_until:
        raise FreezePreflightError(f"{context} signing key expires before Q2 complete_by")
    revoked_at = key["revokedAt"]
    if revoked_at is not None and _timestamp(revoked_at, f"{context} key revokedAt") <= required_until:
        raise FreezePreflightError(f"{context} signing key is revoked before Q2 complete_by")


def _require_unique_role_valid_until(
    raw: dict[str, Any],
    *,
    role: str,
    required_from: datetime,
    required_until: datetime,
) -> None:
    matches = [key for key in raw["keys"] if role in key["roles"]]
    if len(matches) != 1:
        raise FreezePreflightError(f"F0 requires exactly one trusted {role} key")
    if _timestamp(matches[0]["notBefore"], f"{role} key notBefore") > required_from:
        raise FreezePreflightError(f"{role} signing key is not active at F0")
    _require_key_valid_until(
        raw,
        key_id=matches[0]["keyId"],
        required_until=required_until,
        context=role,
    )


def build_f0_preflight_report(  # noqa: PLR0913
    raw: object,
    *,
    candidate_signature: object,
    preregistration: object,
    preregistration_signature: object,
    rights_attestation: object,
    rights_signature: object,
    evaluation_authorization: object,
    evaluation_signature: object,
    trust_policy: object,
    surface: object,
    detailed_reports: object,
    qualification_bundle: object,
    now: datetime,
) -> dict[str, Any]:
    """Verify every pre-Q2 F0 binding without granting production authority."""

    if now.tzinfo != UTC:
        raise FreezePreflightError("F0 verification time must be UTC")
    candidate, detailed_digests, qualification_digests = _validate_candidate(raw)
    if not isinstance(trust_policy, dict) or trust_policy.get("schemaVersion") != STUDIO_TRUST_SCHEMA:
        raise FreezePreflightError("F0 requires the canonical Studio trusted-key policy")
    _validate_studio_trust_policy(trust_policy)
    if studio_sha256_document(trust_policy) != candidate["trust_policy_digest"]:
        raise FreezePreflightError("F0 trusted-key policy digest mismatch")
    try:
        candidate_digest = verify_detached_signature(
            candidate,
            candidate_signature,
            trust_policy,
            required_role="preregistration-freezer",
            now=now,
        )
    except AuthorizationError as error:
        raise FreezePreflightError(f"signed F0 candidate rejected: {error}") from error
    prereg = _validate_preregistration_binding(
        candidate,
        preregistration,
        preregistration_signature,
        trust_policy,
        now=now,
    )
    try:
        authorization_digest = verify_detached_signature(
            evaluation_authorization,
            evaluation_signature,
            trust_policy,
            required_role="evaluation-authorizer",
            now=now,
        )
        authorization = validate_evaluation_authorization(
            evaluation_authorization,
            now=now,
            release_digest=candidate["release_digest"],
            preregistration_digest=candidate["preregistration_digest"],
            holdout_digest=candidate["holdout_digest"],
            q2_runner_digest=candidate["q2_runner_digest"],
            transaction_id=candidate["transaction_id"],
            nonce_sha256=candidate["nonce_sha256"],
            started=False,
        )
    except AuthorizationError as error:
        raise FreezePreflightError(f"evaluation authorization rejected: {error}") from error
    if authorization_digest != candidate["evaluation_authorization_digest"]:
        raise FreezePreflightError("evaluation authorization digest mismatch")
    if _signature_key_id(evaluation_signature, "evaluation signature") in {
        _signature_key_id(preregistration_signature, "preregistration signature"),
        _signature_key_id(rights_signature, "rights signature"),
    }:
        raise FreezePreflightError("evaluation authorization requires an independent signing key")
    complete_by = _timestamp(authorization["complete_by"], "evaluation complete_by")
    _require_key_valid_until(
        trust_policy,
        key_id=_signature_key_id(evaluation_signature, "evaluation signature"),
        required_until=complete_by,
        context="evaluation authorization",
    )
    _require_key_valid_until(
        trust_policy,
        key_id=_signature_key_id(rights_signature, "rights signature"),
        required_until=complete_by,
        context="rights attestation",
    )
    _require_unique_role_valid_until(
        trust_policy,
        role="holdout-scorer",
        required_from=now,
        required_until=complete_by,
    )
    _validate_rights(
        candidate,
        rights_attestation,
        rights_signature,
        trust_policy,
        now=now,
        required_until=complete_by,
    )
    candidate_entries = _validate_surface(candidate, surface, rights_attestation)
    detailed_producers = _validate_detailed_reports(
        candidate,
        detailed_digests,
        detailed_reports,
        prereg,
    )
    _validate_qualification_reports(
        candidate,
        qualification_digests,
        qualification_bundle,
        trust_policy,
        detailed_producers,
        candidate_entries,
        now=now,
    )
    return {
        "schema_version": F0_REPORT_SCHEMA,
        "candidate_digest": candidate_digest,
        "candidate_id": candidate["candidate_id"],
        "release_digest": candidate["release_digest"],
        "surface_digest": candidate["surface_digest"],
        "preregistration_digest": candidate["preregistration_digest"],
        "rights_attestation_digest": candidate["rights_attestation_digest"],
        "evaluation_authorization_digest": candidate["evaluation_authorization_digest"],
        "trust_policy_digest": candidate["trust_policy_digest"],
        "holdout_digest": candidate["holdout_digest"],
        "q2_runner_digest": candidate["q2_runner_digest"],
        "transaction_id": candidate["transaction_id"],
        "nonce_sha256": candidate["nonce_sha256"],
        "complete_by": authorization["complete_by"],
        "target_sota_claim_ids": candidate["target_sota_claim_ids"],
        "detailed_reports_digest": document_sha256(candidate["detailed_reports"]),
        "qualification_reports_digest": document_sha256(candidate["qualification_reports"]),
        "status": "f0-pass-ready-for-q2",
        "production_authorized": False,
        "q2_authorized": True,
    }
