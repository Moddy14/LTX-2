"""Strict validation for Studio RuntimeTrust bindings used by AV evaluation."""

from __future__ import annotations

import copy
from typing import Any

RUNTIME_TRUST_SCHEMA = "ltx-studio-runtime-trust-binding.v2"
AUTHORITY_ISOLATION_SCHEMA = "ltx-studio-authority-isolation.v1"
ATTESTED_AUTHORITY_MECHANISMS = {
    "external-signer-sealed-fd-broker",
    "separate-studio-identity-proc-fd-isolation",
}


class RuntimeTrustBindingError(ValueError):
    """Raised when an external Studio RuntimeTrust binding is absent or unsafe."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise RuntimeTrustBindingError(f"{context}: missing={missing}, unknown={unknown}")


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise RuntimeTrustBindingError(f"{context} must be a lowercase SHA-256")
    return value


def validate_runtime_trust_binding(raw: object) -> dict[str, Any]:
    """Return a defensive copy of an exact, release-capable RuntimeTrust v2 binding.

    This validates the document contract shared with ``runtimeTrustBindingSchema``
    in LTX Studio.  It deliberately does not synthesize any digest.  The caller
    must additionally bind the returned value to independently signed evidence.
    """

    if not isinstance(raw, dict):
        raise RuntimeTrustBindingError("qualification HOLD: an externally verified RuntimeTrust binding is required")
    _exact_keys(
        raw,
        {
            "schemaVersion",
            "hostTcbAttestationSha256",
            "hostTcbContractSha256",
            "servicePolicySha256",
            "buildTcbSha256",
            "authorityIsolation",
            "trustPolicyDigests",
        },
        "RuntimeTrust binding",
    )
    if raw["schemaVersion"] != RUNTIME_TRUST_SCHEMA:
        raise RuntimeTrustBindingError("qualification HOLD: unsupported RuntimeTrust binding schema")
    for field in (
        "hostTcbAttestationSha256",
        "hostTcbContractSha256",
        "servicePolicySha256",
        "buildTcbSha256",
    ):
        _sha256(raw[field], f"RuntimeTrust.{field}")

    policies = raw["trustPolicyDigests"]
    if not isinstance(policies, dict):
        raise RuntimeTrustBindingError("RuntimeTrust.trustPolicyDigests must be an object")
    _exact_keys(
        policies,
        {
            "release",
            "activationWriter",
            "qualificationAuthorizer",
            "runtimeRights",
            "bootstrapAuthority",
        },
        "RuntimeTrust.trustPolicyDigests",
    )
    for role, digest in policies.items():
        _sha256(digest, f"RuntimeTrust.trustPolicyDigests.{role}")

    isolation = raw["authorityIsolation"]
    if not isinstance(isolation, dict):
        raise RuntimeTrustBindingError("RuntimeTrust.authorityIsolation must be an object")
    if isolation.get("status") == "hold":
        _exact_keys(
            isolation,
            {"schemaVersion", "status", "mechanism", "attestationSha256", "reasonCode"},
            "RuntimeTrust.authorityIsolation",
        )
        if (
            isolation["schemaVersion"] != AUTHORITY_ISOLATION_SCHEMA
            or isolation["mechanism"] != "same-local-uid"
            or isolation["attestationSha256"] is not None
            or isolation["reasonCode"] != "same-uid-authority-not-authentic"
        ):
            raise RuntimeTrustBindingError("RuntimeTrust authority HOLD contract is invalid")
        raise RuntimeTrustBindingError(
            "qualification HOLD: RuntimeTrust authority isolation is not externally attested"
        )
    _exact_keys(
        isolation,
        {
            "schemaVersion",
            "status",
            "mechanism",
            "hostTcbAttestationSha256",
            "brokerAttestationSha256",
            "reasonCode",
        },
        "RuntimeTrust.authorityIsolation",
    )
    if (
        isolation["schemaVersion"] != AUTHORITY_ISOLATION_SCHEMA
        or isolation["status"] != "attested"
        or isolation["mechanism"] not in ATTESTED_AUTHORITY_MECHANISMS
        or isolation["reasonCode"] is not None
    ):
        raise RuntimeTrustBindingError(
            "qualification HOLD: RuntimeTrust authority isolation is not a supported attestation"
        )
    _sha256(
        isolation["hostTcbAttestationSha256"],
        "RuntimeTrust.authorityIsolation.hostTcbAttestationSha256",
    )
    if isolation["hostTcbAttestationSha256"] != raw["hostTcbAttestationSha256"]:
        raise RuntimeTrustBindingError("RuntimeTrust authority isolation does not bind the exact Host-TCB attestation")
    if isolation["mechanism"] == "external-signer-sealed-fd-broker":
        _sha256(
            isolation["brokerAttestationSha256"],
            "RuntimeTrust.authorityIsolation.brokerAttestationSha256",
        )
    elif isolation["brokerAttestationSha256"] is not None:
        raise RuntimeTrustBindingError("separate Studio identity RuntimeTrust must not claim a broker attestation")
    return copy.deepcopy(raw)
