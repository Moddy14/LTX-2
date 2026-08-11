#!/usr/bin/env python3
"""CLI entry point for rights-bound AV evaluator dataset freezes."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from ltx_trainer import logger
from ltx_trainer.av_eval import (
    ArtifactMeasurementError,
    AsrMeasurementError,
    CalibrationError,
    ComparatorMatrixError,
    ComparatorResourceError,
    ComparatorResultError,
    CompleteD1Error,
    ContentMeasurementError,
    CrossShotProtocolError,
    CrossShotResultError,
    D1BundleError,
    DesignError,
    FreezePreflightError,
    GovernanceError,
    HoldoutDecisionError,
    IdentityMeasurementError,
    OffsetMeasurementError,
    PilotError,
    ReadinessError,
    SharpnessMeasurementError,
    TechnicalEvidenceError,
    VBenchMeasurementError,
    VBenchRuntimeError,
    build_artifact_measurements,
    build_asr_measurements,
    build_calibration_gate_report,
    build_comparator_decision,
    build_comparator_matrix_report,
    build_comparator_resource_report,
    build_complete_d1_report,
    build_content_measurements,
    build_cross_shot_decision,
    build_cross_shot_protocol_report,
    build_design_pilot_binding_report,
    build_design_pilot_report,
    build_f0_preflight_report,
    build_fixed_d1_report,
    build_identity_measurements,
    build_offset_measurements,
    build_operational_readiness_evidence,
    build_power_report,
    build_product_readiness_report,
    build_q2_qualification_report,
    build_sharpness_measurements,
    build_technical_evidence_bundle,
    build_vbench_measurements,
    build_vbench_source_report,
    freeze_dataset,
    load_split_seed,
)


def _run_design_check(path: Path) -> int:
    try:
        report = build_power_report(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, DesignError) as error:
        logger.error("D0a design rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_vbench_runtime_check(config_path: Path, checkout: Path) -> int:
    try:
        report = build_vbench_source_report(
            json.loads(config_path.read_text(encoding="utf-8")),
            checkout=checkout,
        )
    except (OSError, json.JSONDecodeError, VBenchRuntimeError) as error:
        logger.error("VBench-I2V source rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_comparator_resource_check(profile_path: Path, landscape_path: Path) -> int:
    try:
        report = build_comparator_resource_report(
            json.loads(profile_path.read_text(encoding="utf-8")),
            landscape=json.loads(landscape_path.read_text(encoding="utf-8")),
        )
    except (OSError, json.JSONDecodeError, ComparatorResourceError) as error:
        logger.error("Comparator resource profile rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "resource-fit-pass" else 2


def _run_pilot_score(path: Path) -> int:
    try:
        report = build_design_pilot_report(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, PilotError) as error:
        logger.error("D0a pilot observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "evidence-complete" else 2


def _run_pilot_freeze_check(observations_path: Path, design_path: Path) -> int:
    try:
        report = build_design_pilot_binding_report(
            json.loads(observations_path.read_text(encoding="utf-8")),
            json.loads(design_path.read_text(encoding="utf-8")),
        )
    except (OSError, json.JSONDecodeError, PilotError) as error:
        logger.error("D0a pilot freeze rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_readiness_check(args: argparse.Namespace) -> int:
    try:
        package = json.loads(args.package.read_text(encoding="utf-8"))
        now = datetime.now(UTC).replace(microsecond=0)
        live_arguments = (
            args.operational_evidence,
            args.holdout_root,
            args.access_log_root,
            args.access_log,
            args.trust_policy,
        )
        if any(value is not None for value in live_arguments) and not all(
            value is not None for value in live_arguments
        ):
            raise ReadinessError("readiness-check live boundary arguments must be supplied together")
        operational_evidence = None
        if all(value is not None for value in live_arguments):
            operational_evidence = json.loads(args.operational_evidence.read_text(encoding="utf-8"))
            fresh_evidence = build_operational_readiness_evidence(
                package,
                holdout_root=args.holdout_root,
                access_log_root=args.access_log_root,
                access_log_path=args.access_log,
                trust_policy=json.loads(args.trust_policy.read_text(encoding="utf-8")),
                now=now,
            )
            if not isinstance(operational_evidence, dict):
                raise ReadinessError("operational evidence bundle must be an object")
            supplied_documents = operational_evidence.get("documents")
            fresh_documents = fresh_evidence["documents"]
            if not isinstance(supplied_documents, dict):
                raise ReadinessError("operational evidence bundle has no documents")
            for artifact_id in ("empty-access-log-report", "sealed-acl-report"):
                supplied = supplied_documents.get(artifact_id)
                fresh = fresh_documents[artifact_id]
                if not isinstance(supplied, dict) or {
                    key: value for key, value in supplied.items() if key != "checked_at"
                } != {key: value for key, value in fresh.items() if key != "checked_at"}:
                    raise ReadinessError(f"live operational boundary drifted: {artifact_id}")
            if (
                operational_evidence.get("operational_updates") != fresh_evidence["operational_updates"]
                or operational_evidence.get("trusted_key_policy_digest")
                != fresh_evidence["trusted_key_policy_digest"]
            ):
                raise ReadinessError("live operational identities or trusted keys drifted")
        report = build_product_readiness_report(package, now=now, operational_evidence=operational_evidence)
    except (OSError, json.JSONDecodeError, ReadinessError) as error:
        logger.error("D0 readiness package rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_operational_readiness_check(args: argparse.Namespace) -> int:
    try:
        report = build_operational_readiness_evidence(
            json.loads(args.package.read_text(encoding="utf-8")),
            holdout_root=args.holdout_root,
            access_log_root=args.access_log_root,
            access_log_path=args.access_log,
            trust_policy=json.loads(args.trust_policy.read_text(encoding="utf-8")),
            now=datetime.now(UTC).replace(microsecond=0),
        )
    except (OSError, json.JSONDecodeError, ReadinessError) as error:
        logger.error("D0 live operational boundary rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_calibration_check(path: Path) -> int:
    try:
        report = build_calibration_gate_report(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, CalibrationError) as error:
        logger.error("D1 calibration catalog rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_asr_score(path: Path) -> int:
    try:
        report = build_asr_measurements(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, AsrMeasurementError) as error:
        logger.error("ASR observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_artifact_score(path: Path) -> int:
    try:
        report = build_artifact_measurements(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ArtifactMeasurementError) as error:
        logger.error("Artifact observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_identity_score(path: Path) -> int:
    try:
        report = build_identity_measurements(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, IdentityMeasurementError) as error:
        logger.error("Identity pairs rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_offset_score(path: Path) -> int:
    try:
        report = build_offset_measurements(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, OffsetMeasurementError) as error:
        logger.error("Offset observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_content_score(path: Path) -> int:
    try:
        report = build_content_measurements(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ContentMeasurementError) as error:
        logger.error("Content observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_sharpness_score(path: Path) -> int:
    try:
        report = build_sharpness_measurements(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, SharpnessMeasurementError) as error:
        logger.error("Sharpness observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_fixed_d1(bundle_path: Path, catalog_path: Path) -> int:
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        report = build_fixed_d1_report(bundle, calibration_catalog=catalog)
    except (OSError, json.JSONDecodeError, D1BundleError) as error:
        logger.error("Fixed D1 bundle rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["verdict"] == "pass" else 2


def _run_vbench_score(observations_path: Path, design_path: Path) -> int:
    try:
        observations = json.loads(observations_path.read_text(encoding="utf-8"))
        design = json.loads(design_path.read_text(encoding="utf-8"))
        report = build_vbench_measurements(observations, design=design)
    except (OSError, json.JSONDecodeError, VBenchMeasurementError) as error:
        logger.error("VBench observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["verdict"] == "pass" else 2


def _run_complete_d1(bundle_path: Path, catalog_path: Path, design_path: Path) -> int:
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        design = json.loads(design_path.read_text(encoding="utf-8"))
        report = build_complete_d1_report(bundle, calibration_catalog=catalog, design=design)
    except (OSError, json.JSONDecodeError, CompleteD1Error) as error:
        logger.error("Complete D1 bundle rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["verdict"] == "pass" else 2


def _run_cross_shot_score(results_path: Path, protocol_path: Path, design_path: Path) -> int:
    try:
        results = json.loads(results_path.read_text(encoding="utf-8"))
        protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
        design = json.loads(design_path.read_text(encoding="utf-8"))
        report = build_cross_shot_decision(results, protocol=protocol, design=design)
    except (OSError, json.JSONDecodeError, CrossShotResultError) as error:
        logger.error("Q0 cross-shot results rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["verdict"] == "winner" else 2


def _run_cross_shot_check(protocol_path: Path, design_report_path: Path | None) -> int:
    try:
        protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
        design_report = (
            json.loads(design_report_path.read_text(encoding="utf-8")) if design_report_path is not None else None
        )
        report = build_cross_shot_protocol_report(protocol, design_report=design_report)
    except (OSError, json.JSONDecodeError, CrossShotProtocolError) as error:
        logger.error("Q0 cross-shot protocol rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_comparator_check(matrix_path: Path, landscape_path: Path) -> int:
    try:
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        landscape = json.loads(landscape_path.read_text(encoding="utf-8"))
        report = build_comparator_matrix_report(matrix, landscape=landscape, as_of=datetime.now(UTC).date())
    except (OSError, json.JSONDecodeError, ComparatorMatrixError) as error:
        logger.error("Q1 comparator matrix rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_comparator_score(results_path: Path, gates_path: Path, matrix_path: Path, landscape_path: Path) -> int:
    try:
        results = json.loads(results_path.read_text(encoding="utf-8"))
        gates = json.loads(gates_path.read_text(encoding="utf-8"))
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        landscape = json.loads(landscape_path.read_text(encoding="utf-8"))
        report = build_comparator_decision(
            results,
            gates=gates,
            matrix=matrix,
            landscape=landscape,
            as_of=datetime.now(UTC).date(),
        )
    except (OSError, json.JSONDecodeError, ComparatorResultError) as error:
        logger.error("Q1 comparator results rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


def _run_freeze(args: argparse.Namespace) -> int:
    try:
        root = freeze_dataset(
            args.manifest,
            args.rights,
            args.mapping,
            args.preregistration,
            args.output_root,
            split_seed=load_split_seed(args.split_seed_file),
            profile=args.profile,
        )
    except GovernanceError as error:
        logger.error("AV evaluator freeze rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps({"status": "frozen", "path": str(root)}, sort_keys=True) + "\n")
    return 0


def _run_f0_check(args: argparse.Namespace) -> int:
    try:
        report = build_f0_preflight_report(
            json.loads(args.candidate.read_text(encoding="utf-8")),
            candidate_signature=json.loads(args.candidate_signature.read_text(encoding="utf-8")),
            preregistration=json.loads(args.preregistration.read_text(encoding="utf-8")),
            preregistration_signature=json.loads(args.preregistration_signature.read_text(encoding="utf-8")),
            rights_attestation=json.loads(args.rights_attestation.read_text(encoding="utf-8")),
            rights_signature=json.loads(args.rights_signature.read_text(encoding="utf-8")),
            evaluation_authorization=json.loads(args.evaluation_authorization.read_text(encoding="utf-8")),
            evaluation_signature=json.loads(args.evaluation_signature.read_text(encoding="utf-8")),
            trust_policy=json.loads(args.trust_policy.read_text(encoding="utf-8")),
            surface=json.loads(args.surface.read_text(encoding="utf-8")),
            detailed_reports=json.loads(args.detailed_reports.read_text(encoding="utf-8")),
            qualification_bundle=json.loads(args.qualifications.read_text(encoding="utf-8")),
            now=datetime.now(UTC).replace(microsecond=0),
        )
    except (OSError, json.JSONDecodeError, FreezePreflightError) as error:
        logger.error("F0 preflight rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_q2_score(args: argparse.Namespace) -> int:
    try:
        report = build_q2_qualification_report(
            json.loads(args.results.read_text(encoding="utf-8")),
            f0_candidate=json.loads(args.candidate.read_text(encoding="utf-8")),
            candidate_signature=json.loads(args.candidate_signature.read_text(encoding="utf-8")),
            preregistration=json.loads(args.preregistration.read_text(encoding="utf-8")),
            preregistration_signature=json.loads(args.preregistration_signature.read_text(encoding="utf-8")),
            evaluation_authorization=json.loads(args.evaluation_authorization.read_text(encoding="utf-8")),
            evaluation_signature=json.loads(args.evaluation_signature.read_text(encoding="utf-8")),
            trust_policy=json.loads(args.trust_policy.read_text(encoding="utf-8")),
            surface=json.loads(args.surface.read_text(encoding="utf-8")),
            d1_report=json.loads(args.d1_report.read_text(encoding="utf-8")),
            design_report=json.loads(args.design_report.read_text(encoding="utf-8")),
            calibration_catalog=json.loads(args.calibration_catalog.read_text(encoding="utf-8")),
            comparator_gates=json.loads(args.comparator_gates.read_text(encoding="utf-8")),
            comparator_matrix=json.loads(args.comparator_matrix.read_text(encoding="utf-8")),
            landscape=json.loads(args.landscape.read_text(encoding="utf-8")),
            consumption_root=args.consumption_root,
            now=datetime.now(UTC).replace(microsecond=0),
        )
    except (OSError, json.JSONDecodeError, HoldoutDecisionError) as error:
        logger.error("Q2 holdout results rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _run_technical_score(observations_path: Path, surface_path: Path) -> int:
    try:
        report = build_technical_evidence_bundle(
            json.loads(observations_path.read_text(encoding="utf-8")),
            surface=json.loads(surface_path.read_text(encoding="utf-8")),
        )
    except (OSError, json.JSONDecodeError, TechnicalEvidenceError) as error:
        logger.error("R0/R3 technical observations rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0


def _add_comparator_commands(subcommands: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    comparator = subcommands.add_parser("comparator-check", help="validate the Q1 anchor and task matrix")
    comparator.add_argument("--matrix", type=Path, required=True)
    comparator.add_argument("--landscape", type=Path, required=True)
    comparator_score = subcommands.add_parser("comparator-score", help="evaluate the frozen paired Q1 pilot")
    comparator_score.add_argument("--results", type=Path, required=True)
    comparator_score.add_argument("--gates", type=Path, required=True)
    comparator_score.add_argument("--matrix", type=Path, required=True)
    comparator_score.add_argument("--landscape", type=Path, required=True)
    resource = subcommands.add_parser(
        "comparator-resource-check",
        help="validate three cold orchestrated resource-profile runs",
    )
    resource.add_argument("--profile", type=Path, required=True)
    resource.add_argument("--landscape", type=Path, required=True)


def _add_f0_command(subcommands: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    command = subcommands.add_parser("f0-check", help="verify the complete signed pre-Q2 freeze candidate")
    command.add_argument("--candidate", type=Path, required=True)
    command.add_argument("--candidate-signature", type=Path, required=True)
    command.add_argument("--preregistration", type=Path, required=True)
    command.add_argument("--preregistration-signature", type=Path, required=True)
    command.add_argument("--rights-attestation", type=Path, required=True)
    command.add_argument("--rights-signature", type=Path, required=True)
    command.add_argument("--evaluation-authorization", type=Path, required=True)
    command.add_argument("--evaluation-signature", type=Path, required=True)
    command.add_argument("--trust-policy", type=Path, required=True)
    command.add_argument("--surface", type=Path, required=True)
    command.add_argument("--detailed-reports", type=Path, required=True)
    command.add_argument("--qualifications", type=Path, required=True)


def _add_q2_command(subcommands: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    command = subcommands.add_parser("q2-score", help="assemble the one-shot signed-holdout qualification")
    command.add_argument("--results", type=Path, required=True)
    command.add_argument("--candidate", type=Path, required=True)
    command.add_argument("--candidate-signature", type=Path, required=True)
    command.add_argument("--preregistration", type=Path, required=True)
    command.add_argument("--preregistration-signature", type=Path, required=True)
    command.add_argument("--evaluation-authorization", type=Path, required=True)
    command.add_argument("--evaluation-signature", type=Path, required=True)
    command.add_argument("--trust-policy", type=Path, required=True)
    command.add_argument("--surface", type=Path, required=True)
    command.add_argument("--d1-report", type=Path, required=True)
    command.add_argument("--design-report", type=Path, required=True)
    command.add_argument("--calibration-catalog", type=Path, required=True)
    command.add_argument("--comparator-gates", type=Path, required=True)
    command.add_argument("--comparator-matrix", type=Path, required=True)
    command.add_argument("--landscape", type=Path, required=True)
    command.add_argument("--consumption-root", type=Path, required=True)


def main() -> int:  # noqa: PLR0915
    parser = argparse.ArgumentParser(description="LTX AV evaluator governance")
    subcommands = parser.add_subparsers(dest="command", required=True)
    freeze = subcommands.add_parser("freeze", help="validate evidence and freeze leakage-safe splits")
    freeze.add_argument("--manifest", type=Path, required=True)
    freeze.add_argument("--rights", type=Path, required=True)
    freeze.add_argument("--mapping", type=Path, required=True)
    freeze.add_argument("--preregistration", type=Path, required=True)
    freeze.add_argument("--output-root", type=Path, required=True)
    freeze.add_argument("--split-seed-file", type=Path, required=True)
    freeze.add_argument("--profile", choices=["development", "product"], default="product")
    fixed_d1 = subcommands.add_parser("fixed-d1", help="assemble the 37 non-VBench D1 gates")
    fixed_d1.add_argument("--bundle", type=Path, required=True)
    fixed_d1.add_argument("--catalog", type=Path, required=True)
    design_check = subcommands.add_parser("design-check", help="validate D0a gates and compute fixed sample sizes")
    design_check.add_argument("--design", type=Path, required=True)
    pilot_score = subcommands.add_parser(
        "pilot-score",
        help="estimate repeatability and cluster effects from paired D0a observations",
    )
    pilot_score.add_argument("--observations", type=Path, required=True)
    pilot_freeze = subcommands.add_parser(
        "pilot-freeze-check",
        help="bind raw D0a pilot evidence to the frozen power design",
    )
    pilot_freeze.add_argument("--observations", type=Path, required=True)
    pilot_freeze.add_argument("--design", type=Path, required=True)
    calibration_check = subcommands.add_parser("calibration-check", help="validate the complete D1 gate catalog")
    calibration_check.add_argument("--catalog", type=Path, required=True)
    content_score = subcommands.add_parser("content-score", help="score mouth-content and transition observations")
    content_score.add_argument("--observations", type=Path, required=True)
    complete_d1 = subcommands.add_parser("complete-d1", help="assemble and revalidate all 109 D1 gates")
    complete_d1.add_argument("--bundle", type=Path, required=True)
    complete_d1.add_argument("--catalog", type=Path, required=True)
    complete_d1.add_argument("--design", type=Path, required=True)
    asr_score = subcommands.add_parser("asr-score", help="score normalized ASR observations with cluster bootstrap")
    asr_score.add_argument("--observations", type=Path, required=True)
    artifact_score = subcommands.add_parser("artifact-score", help="score artifact and warp observations")
    artifact_score.add_argument("--observations", type=Path, required=True)
    identity_score = subcommands.add_parser("identity-score", help="score frozen-threshold SFace pairs")
    identity_score.add_argument("--pairs", type=Path, required=True)
    offset_score = subcommands.add_parser("offset-score", help="score AV offset and abstention observations")
    offset_score.add_argument("--observations", type=Path, required=True)
    sharpness_score = subcommands.add_parser("sharpness-score", help="score normalized face-crop sharpness")
    sharpness_score.add_argument("--observations", type=Path, required=True)
    vbench_score = subcommands.add_parser("vbench-score", help="score paired VBench observations with Holm control")
    vbench_score.add_argument("--observations", type=Path, required=True)
    vbench_score.add_argument("--design", type=Path, required=True)
    vbench_runtime = subcommands.add_parser(
        "vbench-runtime-check",
        help="verify the pinned official VBench-I2V source checkout",
    )
    vbench_runtime.add_argument("--config", type=Path, required=True)
    vbench_runtime.add_argument("--checkout", type=Path, required=True)
    cross_shot = subcommands.add_parser("cross-shot-check", help="validate the paired Q0 cross-shot protocol")
    cross_shot.add_argument("--protocol", type=Path, required=True)
    cross_shot.add_argument("--design-report", type=Path)
    cross_shot_score = subcommands.add_parser("cross-shot-score", help="evaluate the frozen paired Q0 factorial")
    cross_shot_score.add_argument("--results", type=Path, required=True)
    cross_shot_score.add_argument("--protocol", type=Path, required=True)
    cross_shot_score.add_argument("--design", type=Path, required=True)
    _add_comparator_commands(subcommands)
    _add_f0_command(subcommands)
    _add_q2_command(subcommands)
    readiness_check = subcommands.add_parser("readiness-check", help="validate the complete D0 ready-to-freeze package")
    readiness_check.add_argument("--package", type=Path, required=True)
    readiness_check.add_argument("--operational-evidence", type=Path)
    readiness_check.add_argument("--holdout-root", type=Path)
    readiness_check.add_argument("--access-log-root", type=Path)
    readiness_check.add_argument("--access-log", type=Path)
    readiness_check.add_argument("--trust-policy", type=Path)
    operational_check = subcommands.add_parser(
        "operational-readiness-check",
        help="inspect sealed D0 roots, the untouched audit log and independent keys",
    )
    operational_check.add_argument("--package", type=Path, required=True)
    operational_check.add_argument("--holdout-root", type=Path, required=True)
    operational_check.add_argument("--access-log-root", type=Path, required=True)
    operational_check.add_argument("--access-log", type=Path, required=True)
    operational_check.add_argument("--trust-policy", type=Path, required=True)
    technical_score = subcommands.add_parser("technical-score", help="assemble fail-closed R0/R3 live evidence")
    technical_score.add_argument("--observations", type=Path, required=True)
    technical_score.add_argument("--surface", type=Path, required=True)
    args = parser.parse_args()
    handlers = {
        "artifact-score": lambda: _run_artifact_score(args.observations),
        "asr-score": lambda: _run_asr_score(args.observations),
        "calibration-check": lambda: _run_calibration_check(args.catalog),
        "comparator-check": lambda: _run_comparator_check(args.matrix, args.landscape),
        "comparator-resource-check": lambda: _run_comparator_resource_check(args.profile, args.landscape),
        "comparator-score": lambda: _run_comparator_score(args.results, args.gates, args.matrix, args.landscape),
        "content-score": lambda: _run_content_score(args.observations),
        "complete-d1": lambda: _run_complete_d1(args.bundle, args.catalog, args.design),
        "cross-shot-check": lambda: _run_cross_shot_check(args.protocol, args.design_report),
        "cross-shot-score": lambda: _run_cross_shot_score(args.results, args.protocol, args.design),
        "design-check": lambda: _run_design_check(args.design),
        "freeze": lambda: _run_freeze(args),
        "fixed-d1": lambda: _run_fixed_d1(args.bundle, args.catalog),
        "f0-check": lambda: _run_f0_check(args),
        "identity-score": lambda: _run_identity_score(args.pairs),
        "offset-score": lambda: _run_offset_score(args.observations),
        "pilot-score": lambda: _run_pilot_score(args.observations),
        "pilot-freeze-check": lambda: _run_pilot_freeze_check(args.observations, args.design),
        "operational-readiness-check": lambda: _run_operational_readiness_check(args),
        "q2-score": lambda: _run_q2_score(args),
        "readiness-check": lambda: _run_readiness_check(args),
        "sharpness-score": lambda: _run_sharpness_score(args.observations),
        "technical-score": lambda: _run_technical_score(args.observations, args.surface),
        "vbench-score": lambda: _run_vbench_score(args.observations, args.design),
        "vbench-runtime-check": lambda: _run_vbench_runtime_check(args.config, args.checkout),
    }
    return handlers[args.command]()


if __name__ == "__main__":
    raise SystemExit(main())
