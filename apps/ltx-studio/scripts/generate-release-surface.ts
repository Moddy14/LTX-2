import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  candidateReleaseSurfaceSchema,
  deriveReleaseSurfaceEntries,
} from "../shared/releaseSurface.js";

const appRoot = resolve(import.meta.dirname, "..");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

const requestSchemaPath = resolve(appRoot, "shared/pipelines.ts");
const capabilityMatrixPath = resolve(appRoot, "shared/releaseSurface.ts");
const outputPath = resolve(process.cwd(), argumentValue("--output"));
const surface = candidateReleaseSurfaceSchema.parse({
  schemaVersion: "candidate-release-surface.v1",
  policyVersion: "ltx-studio-release-rights.v1",
  inputs: {
    requestSchema: { path: "shared/pipelines.ts", sha256: sha256(requestSchemaPath) },
    capabilityMatrix: { path: "shared/releaseSurface.ts", sha256: sha256(capabilityMatrixPath) },
  },
  activationContract: {
    candidate: "requires-current-signed-rights-attest-and-all-applicable-gates",
    blocked: "must-not-run-in-production-or-support-release-claims",
  },
  entries: deriveReleaseSurfaceEntries(),
});

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, canonicalJson(surface), { mode: 0o644 });
chmodSync(outputPath, 0o644);
process.stdout.write(`${outputPath}\n`);
