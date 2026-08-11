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
from .product import (
    ProductGovernanceError,
    append_signed_access_event,
    validate_measurement_report,
    validate_sealed_directory,
    verify_access_log,
)

__all__ = [
    "AuthorizationError",
    "DesignError",
    "FrozenDatasetSession",
    "GovernanceError",
    "ProductGovernanceError",
    "append_signed_access_event",
    "build_power_report",
    "document_sha256",
    "freeze_dataset",
    "load_frozen_split",
    "load_split_seed",
    "open_frozen_artifact",
    "open_frozen_dataset",
    "record_consumption_event",
    "validate_evaluation_authorization",
    "validate_measurement_report",
    "validate_release_authorization",
    "validate_sealed_directory",
    "verify_access_log",
    "verify_detached_signature",
]
