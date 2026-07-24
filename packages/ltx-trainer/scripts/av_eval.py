#!/usr/bin/env python3
"""CLI entry point for rights-bound AV evaluator dataset freezes."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ltx_trainer import logger
from ltx_trainer.av_eval import GovernanceError, freeze_dataset, load_split_seed


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
    args = parser.parse_args()
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


if __name__ == "__main__":
    raise SystemExit(main())
