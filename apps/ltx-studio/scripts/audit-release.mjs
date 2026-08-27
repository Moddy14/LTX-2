#!/usr/bin/env node

import { executeReleaseAuditCommand } from "./release-audit-command-lib.mjs";
import { canonicalJson } from "./release-manifest-lib.mjs";

const result = await executeReleaseAuditCommand("evidence", process.argv.slice(2));
process.stdout.write(`${canonicalJson(result.document)}\n`);
process.exitCode = result.exitCode;
