import { cpus, totalmem, arch, release } from "node:os";
import { performance } from "node:perf_hooks";

import { chromium } from "@playwright/test";

const [url, label, runCountValue = "40"] = process.argv.slice(2);
const runCount = Number.parseInt(runCountValue, 10);
if (!url || !label || !Number.isInteger(runCount) || runCount < 1) {
  throw new Error("usage: node scripts/measure-startup.mjs <url> <label> [runs]");
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

const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const samples = [];
try {
  for (let index = 0; index < runCount; index += 1) {
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
    samples.push({ run: index + 1, interactiveMs, transferredBytes });
    await context.close();
  }
} finally {
  await browser.close();
}

const timings = samples.map((sample) => sample.interactiveMs);
const transfers = samples.map((sample) => sample.transferredBytes);
const report = {
  schemaVersion: "ltx-studio-startup-benchmark.v1",
  label,
  url,
  protocol: {
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
  },
  summary: {
    runs: samples.length,
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
  },
  samples,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
