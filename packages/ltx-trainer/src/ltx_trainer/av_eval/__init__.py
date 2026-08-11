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
from .bundle import D1BundleError, build_fixed_d1_report
from .calibration import CalibrationError, build_calibration_gate_report
from .comparator import ComparatorMatrixError, build_comparator_matrix_report
from .comparator_result import ComparatorResultError, build_comparator_decision
from .complete import CompleteD1Error, build_complete_d1_report
from .content import ContentMeasurementError, build_content_measurements
from .cross_shot import CrossShotProtocolError, build_cross_shot_protocol_report
from .cross_shot_result import CrossShotResultError, build_cross_shot_decision
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
from .identity import IdentityMeasurementError, build_identity_measurements
from .offset import OffsetMeasurementError, build_offset_measurements
from .product import (
    ProductGovernanceError,
    append_signed_access_event,
    validate_measurement_report,
    validate_sealed_directory,
    verify_access_log,
)
from .readiness import ReadinessError, build_product_readiness_report
from .sharpness import SharpnessMeasurementError, build_sharpness_measurements
from .vbench import VBenchMeasurementError, build_vbench_measurements

__all__ = [
    "ArtifactMeasurementError",
    "AsrMeasurementError",
    "AuthorizationError",
    "CalibrationError",
    "ComparatorMatrixError",
    "ComparatorResultError",
    "CompleteD1Error",
    "ContentMeasurementError",
    "CrossShotProtocolError",
    "CrossShotResultError",
    "D1BundleError",
    "DesignError",
    "FrozenDatasetSession",
    "GovernanceError",
    "IdentityMeasurementError",
    "OffsetMeasurementError",
    "ProductGovernanceError",
    "ReadinessError",
    "SharpnessMeasurementError",
    "VBenchMeasurementError",
    "append_signed_access_event",
    "build_artifact_measurements",
    "build_asr_measurements",
    "build_calibration_gate_report",
    "build_comparator_decision",
    "build_comparator_matrix_report",
    "build_complete_d1_report",
    "build_content_measurements",
    "build_cross_shot_decision",
    "build_cross_shot_protocol_report",
    "build_fixed_d1_report",
    "build_identity_measurements",
    "build_offset_measurements",
    "build_power_report",
    "build_product_readiness_report",
    "build_sharpness_measurements",
    "build_vbench_measurements",
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
