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
    AsrMeasurementError,
    CalibrationError,
    CrossShotProtocolError,
    DesignError,
    GovernanceError,
    ReadinessError,
    build_asr_measurements,
    build_calibration_gate_report,
    build_cross_shot_protocol_report,
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
    asr_score = subcommands.add_parser("asr-score", help="score normalized ASR observations with cluster bootstrap")
    asr_score.add_argument("--observations", type=Path, required=True)
    cross_shot = subcommands.add_parser("cross-shot-check", help="validate the paired Q0 cross-shot protocol")
    cross_shot.add_argument("--protocol", type=Path, required=True)
    cross_shot.add_argument("--design-report", type=Path)
    readiness_check = subcommands.add_parser("readiness-check", help="validate the complete D0 ready-to-freeze package")
    readiness_check.add_argument("--package", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "design-check":
        return _run_design_check(args.design)
    if args.command == "readiness-check":
        return _run_readiness_check(args.package)
    if args.command == "calibration-check":
        return _run_calibration_check(args.catalog)
    if args.command == "asr-score":
        return _run_asr_score(args.observations)
    if args.command == "cross-shot-check":
        return _run_cross_shot_check(args.protocol, args.design_report)
    return _run_freeze(args)


if __name__ == "__main__":
    raise SystemExit(main())
