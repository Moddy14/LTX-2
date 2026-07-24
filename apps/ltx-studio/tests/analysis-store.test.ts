import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  outputAnalysisPath,
  readOutputAnalysis,
  recoverInterruptedOutputAnalyses,
  writeOutputAnalysis,
} from "../server/analysisStore.js";
import type { OutputAnalysisRecord } from "../shared/objectiveQuality.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ltx-analysis-store-"));
  roots.push(directory);
  return directory;
}

function record(status: OutputAnalysisRecord["status"] = "running"): OutputAnalysisRecord {
  return {
    schemaVersion: "ltx-studio-output-analysis.v1",
    outputName: "speech.mp4",
    sizeBytes: 10_000,
    modifiedAtMs: Date.parse("2026-07-24T18:00:00.000Z"),
    changedAtMs: Date.parse("2026-07-24T18:00:01.000Z"),
    fileId: "12345",
    jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
    analysisId: "3c8a5dc6-8864-49f7-a639-85caef918888",
    attempt: 1,
    status,
    progress: status === "queued" ? 0 : 10,
    createdAt: "2026-07-24T18:00:01.000Z",
    startedAt: status === "queued" ? null : "2026-07-24T18:00:02.000Z",
    finishedAt: null,
    updatedAt: "2026-07-24T18:00:02.000Z",
    error: null,
    result: null,
  };
}

describe("objective analysis sidecar store", () => {
  it("round-trips a record only for its exact MP4 revision", async () => {
    const directory = await root();
    const value = record();
    writeOutputAnalysis(directory, value);

    expect(readOutputAnalysis(directory, value.outputName, value)).toEqual(value);
    expect(readOutputAnalysis(directory, value.outputName, { ...value, sizeBytes: value.sizeBytes + 1 })).toBeNull();
    expect(readOutputAnalysis(directory, value.outputName, { ...value, modifiedAtMs: value.modifiedAtMs + 1 })).toBeNull();
    expect(readOutputAnalysis(directory, value.outputName, { ...value, changedAtMs: value.changedAtMs + 1 })).toBeNull();
    expect(readOutputAnalysis(directory, value.outputName, { ...value, fileId: "54321" })).toBeNull();
    expect(readOutputAnalysis(directory, value.outputName, {
      ...value,
      jobId: "4c8a5dc6-8864-49f7-a639-85caef918888",
    })).toBeNull();
  });

  it("atomically recovers queued and running records after a Studio restart", async () => {
    const directory = await root();
    const value = record("queued");
    writeOutputAnalysis(directory, value);
    const interruptedAt = "2026-07-24T18:15:00.000Z";

    expect(recoverInterruptedOutputAnalyses(directory, interruptedAt)).toBe(1);
    const recovered = readOutputAnalysis(directory, value.outputName, value);
    expect(recovered).toMatchObject({
      status: "failed",
      finishedAt: interruptedAt,
      updatedAt: interruptedAt,
      error: {
        code: "studio-restarted",
      },
    });
    expect(outputAnalysisPath(directory, value.outputName)).toBe(join(directory, "speech.mp4.ltx-analysis.json"));
  });

  it("rejects record-controlled paths before writing a sidecar", async () => {
    const directory = await root();
    const malicious = { ...record(), outputName: "../../outside.mp4" };

    expect(() => writeOutputAnalysis(directory, malicious as OutputAnalysisRecord)).toThrow();
  });

  it("does not recover a valid record stored under a different output filename", async () => {
    const directory = await root();
    const mismatched = { ...record("queued"), outputName: "other.mp4" };
    writeOutputAnalysis(directory, mismatched);
    await rename(
      outputAnalysisPath(directory, mismatched.outputName),
      outputAnalysisPath(directory, "speech.mp4"),
    );

    expect(recoverInterruptedOutputAnalyses(directory)).toBe(0);
  });
});
