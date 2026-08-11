import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

import { loadVerifiedReleaseRoot } from "./release-audit-io-lib.mjs";

const distRoot = new URL("../dist/", import.meta.url).pathname;
const assetsRoot = join(distRoot, "assets");
const html = readFileSync(join(distRoot, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
if (!entryMatch) throw new Error("Vite entry chunk not found in dist/index.html");
const entry = entryMatch[1];

function sizes(file) {
  const content = readFileSync(join(assetsRoot, file));
  return {
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function performanceEvidence(path, initialChunk) {
  if (!path) {
    return { gate: "pending-40-cold-context-runs" };
  }

  const bytes = readFileSync(path);
  const evidence = JSON.parse(bytes.toString("utf8"));
  const artifact = evidence.candidateArtifact;
  const valid =
    ["ltx-studio-startup-comparison.v1", "ltx-studio-startup-comparison.v2"].includes(
      evidence.schemaVersion,
    ) &&
    evidence.verdict === "pass" &&
    evidence.protocol?.runsPerArm >= 40 &&
    evidence.candidate?.interactiveMs?.p95 <= evidence.baseline?.interactiveMs?.p95 &&
    artifact?.file === initialChunk.file &&
    artifact?.rawBytes === initialChunk.rawBytes &&
    artifact?.gzipBytes === initialChunk.gzipBytes &&
    artifact?.brotliBytes === initialChunk.brotliBytes &&
    artifact?.sha256 === initialChunk.sha256;
  if (!valid) {
    throw new Error(`Performance evidence ${path} does not match the current entry artifact or gate`);
  }

  return {
    gate: "pass",
    evidence: {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

const chunks = readdirSync(assetsRoot)
  .filter((file) => file.endsWith(".js"))
  .sort()
  .map((file) => ({ file, initial: file === entry, ...sizes(file) }));
const initial = chunks.find((chunk) => chunk.initial);
if (!initial) throw new Error(`Entry chunk ${basename(entry)} is missing`);
const measuredPerformance = performanceEvidence(
  argumentValue("--performance-evidence"),
  initial,
);
const expectedReleaseDigest = argumentValue("--release");
const releaseRoot = argumentValue("--release-root");
if (Boolean(expectedReleaseDigest) !== Boolean(releaseRoot)) {
  throw new Error("--release and --release-root must be provided together");
}
const releaseBinding = expectedReleaseDigest
  ? loadVerifiedReleaseRoot(releaseRoot, expectedReleaseDigest)
  : null;
if (releaseBinding) {
  const releaseDistRoot = join(releaseBinding.releaseRoot, "apps", "ltx-studio", "dist");
  const releaseHtml = readFileSync(join(releaseDistRoot, "index.html"));
  const releaseEntryMatch = releaseHtml.toString("utf8").match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
  const releaseEntry = releaseEntryMatch?.[1];
  const releaseEntryBytes = releaseEntry
    ? readFileSync(join(releaseDistRoot, "assets", releaseEntry))
    : null;
  if (
    !releaseEntryBytes
    || !releaseHtml.equals(readFileSync(join(distRoot, "index.html")))
    || releaseEntry !== initial.file
    || releaseEntryBytes.byteLength !== initial.rawBytes
    || createHash("sha256").update(releaseEntryBytes).digest("hex") !== initial.sha256
  ) {
    throw new Error("Current bundle does not match the verified release root");
  }
}

const report = {
  schemaVersion: "ltx-studio-bundle-report.v1",
  build: {
    node: process.version,
    vite: JSON.parse(readFileSync(new URL("../node_modules/vite/package.json", import.meta.url))).version,
  },
  baseline: { initialRawBytes: 533_430, initialGzipBytes: 155_280 },
  target: { initialRawBytesMax: 450_000, initialGzipBytesMax: 140_000 },
  initial: {
    file: initial.file,
    rawBytes: initial.rawBytes,
    gzipBytes: initial.gzipBytes,
    brotliBytes: initial.brotliBytes,
  },
  chunks,
  staticGate: initial.rawBytes <= 450_000 && initial.gzipBytes <= 140_000 ? "pass" : "fail",
  performanceGate: measuredPerformance.gate,
  ...(releaseBinding
    ? {
        release: {
          digest: releaseBinding.releaseDigest,
          gitCommit: releaseBinding.manifest.source.gitCommit,
          gitTree: releaseBinding.manifest.source.gitTree,
        },
      }
    : {}),
  ...(measuredPerformance.evidence
    ? { performanceEvidence: measuredPerformance.evidence }
    : {}),
};

const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = argumentValue("--output");
if (outputPath) {
  writeFileSync(outputPath, reportBytes, { encoding: "utf8", flag: "wx", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, staticGate: report.staticGate })}\n`);
} else {
  process.stdout.write(reportBytes);
}
