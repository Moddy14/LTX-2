#!/usr/bin/env node

import {
  parsePreflightArguments,
  PREFLIGHT_SCHEMA_VERSION,
  runReleaseAuditPreflight,
} from "./release-audit-preflight-lib.mjs";
import { canonicalJson } from "./release-manifest-lib.mjs";

try {
  const options = parsePreflightArguments(process.argv.slice(2));
  const result = await runReleaseAuditPreflight(options);
  process.stdout.write(canonicalJson(result));
  if (!result.readyForFinalization) process.exitCode = 2;
} catch (error) {
  process.stdout.write(canonicalJson({
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    verdict: "invalid-invocation",
    readyForEvidenceCollection: false,
    readyForFinalization: false,
    error: {
      code: "preflight-invocation-invalid",
      message: error instanceof Error ? error.message : String(error),
    },
  }));
  process.exitCode = 64;
}
