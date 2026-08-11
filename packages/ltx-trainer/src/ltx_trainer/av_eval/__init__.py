"""Governance and training utilities for the owned phoneme/viseme evaluator."""

from .authorization import (
    AuthorizationError,
    record_consumption_event,
    validate_evaluation_authorization,
    validate_release_authorization,
    verify_detached_signature,
)
from .design import DesignError, build_power_report, document_sha256
from .governance import (
    FrozenDatasetSession,
    GovernanceError,
    freeze_dataset,
    load_frozen_split,
    load_split_seed,
    open_frozen_artifact,
    open_frozen_dataset,
)

__all__ = [
    "AuthorizationError",
    "DesignError",
    "FrozenDatasetSession",
    "GovernanceError",
    "build_power_report",
    "document_sha256",
    "freeze_dataset",
    "load_frozen_split",
    "load_split_seed",
    "open_frozen_artifact",
    "open_frozen_dataset",
    "record_consumption_event",
    "validate_evaluation_authorization",
    "validate_release_authorization",
    "verify_detached_signature",
]
