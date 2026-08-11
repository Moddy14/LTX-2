import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [baselinePath, candidatePath, bundlePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !bundlePath || !outputPath) {
  throw new Error(
    "usage: node scripts/compare-startup.mjs <baseline-comparison> <candidate-benchmark> <bundle-report> <output>",
  );
}

function readJson(path) {
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function percentDelta(candidate, baseline) {
  return Math.round(((candidate / baseline) - 1) * 10_000) / 100;
}

const baseline = readJson(baselinePath);
const candidate = readJson(candidatePath);
const bundle = readJson(bundlePath);
assert(
  baseline.value.schemaVersion === "ltx-studio-startup-comparison.v1"
    && baseline.value.verdict === "pass"
    && baseline.value.protocol?.runsPerArm >= 40,
  "Baseline comparison is not a passing 40-run R2 artifact",
);
assert(
  candidate.value.schemaVersion === "ltx-studio-startup-benchmark.v1"
    && candidate.value.summary?.runs >= 40
    && candidate.value.samples?.length === candidate.value.summary.runs,
  "Candidate benchmark is not a complete 40-run startup artifact",
);
assert(
  bundle.value.schemaVersion === "ltx-studio-bundle-report.v1"
    && bundle.value.staticGate === "pass",
  "Candidate bundle does not pass the static R2 gate",
);

const protocolPairs = [
  ["cache", baseline.value.protocol.cache, candidate.value.protocol.cache],
  ["apiRequests", baseline.value.protocol.apiRequests, candidate.value.protocol.apiRequests],
  ["viewport", baseline.value.protocol.viewport, candidate.value.protocol.viewport],
  ["readiness", baseline.value.protocol.readiness, candidate.value.protocol.readiness],
  [
    "transferWindowMsAfterReadiness",
    baseline.value.protocol.transferWindowMsAfterReadiness,
    candidate.value.protocol.transferWindowMsAfterReadiness,
  ],
];
for (const [label, expected, actual] of protocolPairs) {
  assert(expected === actual, `Startup protocol mismatch for ${label}`);
}
for (const key of ["node", "chromium", "architecture", "kernel", "cpuCount", "totalMemoryBytes"]) {
  assert(
    baseline.value.environment?.[key] === candidate.value.environment?.[key],
    `Startup environment mismatch for ${key}`,
  );
}

const initialChunk = bundle.value.chunks?.find((chunk) => chunk.initial === true);
assert(initialChunk, "Bundle report has no initial chunk");
for (const key of ["file", "rawBytes", "gzipBytes", "brotliBytes"]) {
  assert(bundle.value.initial?.[key] === initialChunk[key], `Initial bundle mismatch for ${key}`);
}
assert(/^[0-9a-f]{64}$/.test(initialChunk.sha256), "Initial chunk has no SHA-256 binding");

const baselineSummary = baseline.value.baseline;
const candidateSummary = candidate.value.summary;
const verdict = candidateSummary.interactiveMs.p95 <= baselineSummary.interactiveMs.p95
  ? "pass"
  : "fail";
const report = {
  schemaVersion: "ltx-studio-startup-comparison.v1",
  protocol: {
    baselineCommit: baseline.value.protocol.baselineCommit,
    candidateCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runsPerArm: Math.min(baseline.value.protocol.runsPerArm, candidateSummary.runs),
    cache: candidate.value.protocol.cache,
    apiRequests: candidate.value.protocol.apiRequests,
    viewport: candidate.value.protocol.viewport,
    readiness: candidate.value.protocol.readiness,
    transferWindowMsAfterReadiness: candidate.value.protocol.transferWindowMsAfterReadiness,
  },
  environment: {
    node: candidate.value.environment.node,
    chromium: candidate.value.environment.chromium,
    architecture: candidate.value.environment.architecture,
    kernel: candidate.value.environment.kernel,
    cpuCount: candidate.value.environment.cpuCount,
    totalMemoryBytes: candidate.value.environment.totalMemoryBytes,
  },
  sources: {
    baseline: { path: baselinePath, sha256: sha256(baseline.bytes) },
    candidate: { path: candidatePath, sha256: sha256(candidate.bytes) },
    bundle: { path: bundlePath, sha256: sha256(bundle.bytes) },
  },
  candidateArtifact: {
    file: initialChunk.file,
    rawBytes: initialChunk.rawBytes,
    gzipBytes: initialChunk.gzipBytes,
    brotliBytes: initialChunk.brotliBytes,
    sha256: initialChunk.sha256,
  },
  baseline: baselineSummary,
  candidate: candidateSummary,
  delta: {
    medianInteractivePercent: percentDelta(
      candidateSummary.interactiveMs.median,
      baselineSummary.interactiveMs.median,
    ),
    p95InteractivePercent: percentDelta(
      candidateSummary.interactiveMs.p95,
      baselineSummary.interactiveMs.p95,
    ),
    transferredBytesPercent: percentDelta(
      candidateSummary.transferredBytes.median,
      baselineSummary.transferredBytes.median,
    ),
  },
  verdict,
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o644,
});
process.stdout.write(`${JSON.stringify({ output: outputPath, verdict })}\n`);
if (verdict !== "pass") process.exitCode = 1;
