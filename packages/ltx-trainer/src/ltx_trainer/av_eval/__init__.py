"""Governance and training utilities for the owned phoneme/viseme evaluator."""

from .artifact import ArtifactMeasurementError, build_artifact_measurements
from .asr import AsrMeasurementError, build_asr_measurements
from .authorization import (
    AuthorizationError,
    record_consumption_event,
    validate_evaluation_authorization,
    validate_release_authorization,
    verify_detached_signature,
)
from .calibration import CalibrationError, build_calibration_gate_report
from .comparator import ComparatorMatrixError, build_comparator_matrix_report
from .cross_shot import CrossShotProtocolError, build_cross_shot_protocol_report
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
from .readiness import ReadinessError, build_product_readiness_report

__all__ = [
    "ArtifactMeasurementError",
    "AsrMeasurementError",
    "AuthorizationError",
    "CalibrationError",
    "ComparatorMatrixError",
    "CrossShotProtocolError",
    "DesignError",
    "FrozenDatasetSession",
    "GovernanceError",
    "ProductGovernanceError",
    "ReadinessError",
    "append_signed_access_event",
    "build_artifact_measurements",
    "build_asr_measurements",
    "build_calibration_gate_report",
    "build_comparator_matrix_report",
    "build_cross_shot_protocol_report",
    "build_power_report",
    "build_product_readiness_report",
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
