#!/usr/bin/env node

import { executeReleaseAuditCommand } from "./release-audit-command-lib.mjs";
import { canonicalJson } from "./release-manifest-lib.mjs";

const result = await executeReleaseAuditCommand("promotion", process.argv.slice(2));
process.stdout.write(`${canonicalJson(result.document)}\n`);
// A verified request is intentionally non-authoritative until the external,
// privileged ActivationWriter consumes it with expected-head CAS.
process.exitCode = result.exitCode;
