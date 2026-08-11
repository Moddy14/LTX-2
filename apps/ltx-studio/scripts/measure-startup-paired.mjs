import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { arch, cpus, loadavg, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

import { chromium } from "@playwright/test";

const [baselineUrl, candidateUrl, baselineCommit, bundlePath, outputPath, runCountValue = "40"] =
  process.argv.slice(2);
const runCount = Number.parseInt(runCountValue, 10);
if (
  !baselineUrl
  || !candidateUrl
  || !/^[0-9a-f]{7,40}$/.test(baselineCommit ?? "")
  || !bundlePath
  || !outputPath
  || !Number.isInteger(runCount)
  || runCount < 40
) {
  throw new Error(
    "usage: node scripts/measure-startup-paired.mjs <baseline-url> <candidate-url> <baseline-commit> <bundle-report> <output> [runs>=40]",
  );
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function summarize(samples) {
  const timings = samples.map(({ interactiveMs }) => interactiveMs);
  const transfers = samples.map(({ transferredBytes }) => transferredBytes);
  return {
    interactiveMs: {
      median: percentile(timings, 0.5),
      p95: percentile(timings, 0.95),
      mean: mean(timings),
      sampleStandardDeviation: standardDeviation(timings),
      min: Math.min(...timings),
      max: Math.max(...timings),
    },
    transferredBytes: {
      median: percentile(transfers, 0.5),
      p95: percentile(transfers, 0.95),
      mean: mean(transfers),
      sampleStandardDeviation: standardDeviation(transfers),
      min: Math.min(...transfers),
      max: Math.max(...transfers),
    },
  };
}

function percentDelta(candidate, baseline) {
  return Math.round(((candidate / baseline) - 1) * 10_000) / 100;
}

async function httpArtifact(rootUrl) {
  const indexResponse = await fetch(rootUrl);
  if (!indexResponse.ok) throw new Error(`Cannot read startup index: ${rootUrl}`);
  const html = await indexResponse.text();
  const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
  if (!entryMatch) throw new Error(`Startup entry is missing: ${rootUrl}`);
  const file = entryMatch[1];
  const response = await fetch(new URL(`/assets/${file}`, rootUrl));
  if (!response.ok) throw new Error(`Cannot read startup entry: ${rootUrl}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    file,
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function measure(browser, url, run, position) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.route("**/api/**", (route) => route.abort("blockedbyclient"));
  const startedAt = performance.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".mode-button").first().waitFor({ state: "visible" });
  const interactiveMs = performance.now() - startedAt;
  await page.waitForTimeout(100);
  const transferredBytes = await page.evaluate(() => performance.getEntriesByType("resource")
    .reduce((sum, entry) => sum + (entry instanceof PerformanceResourceTiming ? entry.transferSize : 0), 0));
  await context.close();
  return { run, position, interactiveMs, transferredBytes };
}

const bundleBytes = readFileSync(bundlePath);
const bundle = JSON.parse(bundleBytes.toString("utf8"));
if (bundle.schemaVersion !== "ltx-studio-bundle-report.v1" || bundle.staticGate !== "pass") {
  throw new Error("Candidate bundle report does not pass the static gate");
}
const baselineArtifact = await httpArtifact(baselineUrl);
const candidateArtifact = await httpArtifact(candidateUrl);
const bundleInitial = bundle.chunks?.find(({ initial }) => initial === true);
if (
  !bundleInitial
  || ["file", "rawBytes", "gzipBytes", "brotliBytes", "sha256"]
    .some((key) => bundleInitial[key] !== candidateArtifact[key])
) {
  throw new Error("Served candidate does not match the bundle report");
}

const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const loadAtStart = loadavg();
const baselineSamples = [];
const candidateSamples = [];
try {
  for (let index = 0; index < runCount; index += 1) {
    const baselineFirst = index % 2 === 0;
    if (baselineFirst) {
      baselineSamples.push(await measure(browser, baselineUrl, index + 1, "first"));
      candidateSamples.push(await measure(browser, candidateUrl, index + 1, "second"));
    } else {
      candidateSamples.push(await measure(browser, candidateUrl, index + 1, "first"));
      baselineSamples.push(await measure(browser, baselineUrl, index + 1, "second"));
    }
  }
} finally {
  await browser.close();
}

const baseline = summarize(baselineSamples);
const candidate = summarize(candidateSamples);
const verdict = candidate.interactiveMs.p95 <= baseline.interactiveMs.p95 ? "pass" : "fail";
const report = {
  schemaVersion: "ltx-studio-startup-comparison.v2",
  protocol: {
    baselineCommit,
    candidateCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runsPerArm: runCount,
    ordering: "alternating-paired-rounds",
    cache: "new-browser-context-per-run",
    apiRequests: "aborted-identically",
    viewport: "1440x1000",
    readiness: "first-visible-mode-button",
    transferWindowMsAfterReadiness: 100,
  },
  environment: {
    node: process.version,
    chromium: browserVersion,
    architecture: arch(),
    kernel: release(),
    cpuModel: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    loadAverageAtStart: loadAtStart,
    loadAverageAtEnd: loadavg(),
  },
  sources: {
    bundle: { path: bundlePath, sha256: createHash("sha256").update(bundleBytes).digest("hex") },
  },
  baselineArtifact,
  candidateArtifact,
  baseline,
  candidate,
  delta: {
    medianInteractivePercent: percentDelta(candidate.interactiveMs.median, baseline.interactiveMs.median),
    p95InteractivePercent: percentDelta(candidate.interactiveMs.p95, baseline.interactiveMs.p95),
    transferredBytesPercent: percentDelta(
      candidate.transferredBytes.median,
      baseline.transferredBytes.median,
    ),
  },
  samples: { baseline: baselineSamples, candidate: candidateSamples },
  verdict,
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o644,
});
process.stdout.write(`${JSON.stringify({ output: outputPath, verdict })}\n`);
if (verdict !== "pass") process.exitCode = 1;
