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
    ContentMeasurementError,
    CrossShotProtocolError,
    DesignError,
    GovernanceError,
    IdentityMeasurementError,
    OffsetMeasurementError,
    ReadinessError,
    build_artifact_measurements,
    build_asr_measurements,
    build_calibration_gate_report,
    build_comparator_matrix_report,
    build_content_measurements,
    build_cross_shot_protocol_report,
    build_identity_measurements,
    build_offset_measurements,
    build_power_report,
    build_product_readiness_report,
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


def _run_readiness_check(path: Path) -> int:
    try:
        package = json.loads(path.read_text(encoding="utf-8"))
        report = build_product_readiness_report(package, now=datetime.now(UTC).replace(microsecond=0))
    except (OSError, json.JSONDecodeError, ReadinessError) as error:
        logger.error("D0 readiness package rejected: %s", error)
        return 2
    sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
    return 0 if report["status"] == "ready-to-freeze" else 2


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


def main() -> int:
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
    design_check = subcommands.add_parser("design-check", help="validate D0a gates and compute fixed sample sizes")
    design_check.add_argument("--design", type=Path, required=True)
    calibration_check = subcommands.add_parser("calibration-check", help="validate the complete D1 gate catalog")
    calibration_check.add_argument("--catalog", type=Path, required=True)
    content_score = subcommands.add_parser("content-score", help="score mouth-content and transition observations")
    content_score.add_argument("--observations", type=Path, required=True)
    asr_score = subcommands.add_parser("asr-score", help="score normalized ASR observations with cluster bootstrap")
    asr_score.add_argument("--observations", type=Path, required=True)
    artifact_score = subcommands.add_parser("artifact-score", help="score artifact and warp observations")
    artifact_score.add_argument("--observations", type=Path, required=True)
    identity_score = subcommands.add_parser("identity-score", help="score frozen-threshold SFace pairs")
    identity_score.add_argument("--pairs", type=Path, required=True)
    offset_score = subcommands.add_parser("offset-score", help="score AV offset and abstention observations")
    offset_score.add_argument("--observations", type=Path, required=True)
    cross_shot = subcommands.add_parser("cross-shot-check", help="validate the paired Q0 cross-shot protocol")
    cross_shot.add_argument("--protocol", type=Path, required=True)
    cross_shot.add_argument("--design-report", type=Path)
    comparator = subcommands.add_parser("comparator-check", help="validate the Q1 anchor and task matrix")
    comparator.add_argument("--matrix", type=Path, required=True)
    comparator.add_argument("--landscape", type=Path, required=True)
    readiness_check = subcommands.add_parser("readiness-check", help="validate the complete D0 ready-to-freeze package")
    readiness_check.add_argument("--package", type=Path, required=True)
    args = parser.parse_args()
    handlers = {
        "artifact-score": lambda: _run_artifact_score(args.observations),
        "asr-score": lambda: _run_asr_score(args.observations),
        "calibration-check": lambda: _run_calibration_check(args.catalog),
        "comparator-check": lambda: _run_comparator_check(args.matrix, args.landscape),
        "content-score": lambda: _run_content_score(args.observations),
        "cross-shot-check": lambda: _run_cross_shot_check(args.protocol, args.design_report),
        "design-check": lambda: _run_design_check(args.design),
        "freeze": lambda: _run_freeze(args),
        "identity-score": lambda: _run_identity_score(args.pairs),
        "offset-score": lambda: _run_offset_score(args.observations),
        "readiness-check": lambda: _run_readiness_check(args.package),
    }
    return handlers[args.command]()


if __name__ == "__main__":
    raise SystemExit(main())
