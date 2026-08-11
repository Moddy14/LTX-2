"""Governance and training utilities for the owned phoneme/viseme evaluator."""

from .artifact import ArtifactMeasurementError, build_artifact_measurements
from .asr import AsrMeasurementError, build_asr_measurements
from .authorization import (
    AuthorizationError,
    build_consumption_event,
    record_consumption_event,
    record_signed_consumption_event,
    validate_consumption_events,
    validate_evaluation_authorization,
    validate_release_authorization,
    validate_trust_policy_bindings,
    verify_detached_signature,
)
from .bundle import D1BundleError, build_fixed_d1_report
from .calibration import CalibrationError, build_calibration_gate_report
from .comparator import ComparatorMatrixError, build_comparator_matrix_report
from .comparator_resource import ComparatorResourceError, build_comparator_resource_report
from .comparator_result import ComparatorResultError, build_comparator_decision, build_holdout_comparator_decision
from .complete import CompleteD1Error, build_complete_d1_report
from .content import ContentMeasurementError, build_content_measurements
from .cross_shot import CrossShotProtocolError, build_cross_shot_protocol_report
from .cross_shot_result import CrossShotResultError, build_cross_shot_decision
from .design import DesignError, build_power_report, document_sha256
from .freeze_preflight import FreezePreflightError, build_f0_preflight_report, validate_f0_candidate
from .governance import (
    FrozenDatasetSession,
    GovernanceError,
    freeze_dataset,
    load_frozen_split,
    load_split_seed,
    open_frozen_artifact,
    open_frozen_dataset,
    validate_preregistration,
)
from .holdout import HoldoutDecisionError, build_q2_qualification_report
from .identity import IdentityMeasurementError, build_identity_measurements
from .offset import OffsetMeasurementError, build_offset_measurements
from .pilot import (
    PilotError,
    build_design_pilot_binding_report,
    build_design_pilot_report,
    validate_design_pilot_binding_report,
    validate_design_pilot_report,
)
from .product import (
    ProductGovernanceError,
    append_signed_access_event,
    validate_measurement_report,
    validate_sealed_directory,
    verify_access_log,
)
from .readiness import ReadinessError, build_operational_readiness_evidence, build_product_readiness_report
from .sharpness import SharpnessMeasurementError, build_sharpness_measurements
from .technical import TechnicalEvidenceError, build_technical_evidence_bundle
from .vbench import VBenchMeasurementError, build_vbench_measurements
from .vbench_environment import VBenchEnvironmentError, build_vbench_runtime_report, validate_vbench_runtime_report
from .vbench_runtime import VBenchRuntimeError, build_vbench_source_report

__all__ = [
    "ArtifactMeasurementError",
    "AsrMeasurementError",
    "AuthorizationError",
    "CalibrationError",
    "ComparatorMatrixError",
    "ComparatorResourceError",
    "ComparatorResultError",
    "CompleteD1Error",
    "ContentMeasurementError",
    "CrossShotProtocolError",
    "CrossShotResultError",
    "D1BundleError",
    "DesignError",
    "FreezePreflightError",
    "FrozenDatasetSession",
    "GovernanceError",
    "HoldoutDecisionError",
    "IdentityMeasurementError",
    "OffsetMeasurementError",
    "PilotError",
    "ProductGovernanceError",
    "ReadinessError",
    "SharpnessMeasurementError",
    "TechnicalEvidenceError",
    "VBenchEnvironmentError",
    "VBenchMeasurementError",
    "VBenchRuntimeError",
    "append_signed_access_event",
    "build_artifact_measurements",
    "build_asr_measurements",
    "build_calibration_gate_report",
    "build_comparator_decision",
    "build_comparator_matrix_report",
    "build_comparator_resource_report",
    "build_complete_d1_report",
    "build_consumption_event",
    "build_content_measurements",
    "build_cross_shot_decision",
    "build_cross_shot_protocol_report",
    "build_design_pilot_binding_report",
    "build_design_pilot_report",
    "build_f0_preflight_report",
    "build_fixed_d1_report",
    "build_holdout_comparator_decision",
    "build_identity_measurements",
    "build_offset_measurements",
    "build_operational_readiness_evidence",
    "build_power_report",
    "build_product_readiness_report",
    "build_q2_qualification_report",
    "build_sharpness_measurements",
    "build_technical_evidence_bundle",
    "build_vbench_measurements",
    "build_vbench_runtime_report",
    "build_vbench_source_report",
    "document_sha256",
    "freeze_dataset",
    "load_frozen_split",
    "load_split_seed",
    "open_frozen_artifact",
    "open_frozen_dataset",
    "record_consumption_event",
    "record_signed_consumption_event",
    "validate_consumption_events",
    "validate_design_pilot_binding_report",
    "validate_design_pilot_report",
    "validate_evaluation_authorization",
    "validate_f0_candidate",
    "validate_measurement_report",
    "validate_preregistration",
    "validate_release_authorization",
    "validate_sealed_directory",
    "validate_trust_policy_bindings",
    "validate_vbench_runtime_report",
    "verify_access_log",
    "verify_detached_signature",
]
