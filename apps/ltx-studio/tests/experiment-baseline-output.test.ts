import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ExperimentStore } from "../server/experimentStore.js";
import { outputForArm } from "../src/experimentOutputs.js";
import type { StudioOutput } from "../src/types.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FINGERPRINT = "c".repeat(64);
const BASELINE_JOB_ID = "11111111-2222-4333-8444-555555555555";

async function adoptedBaselineExperiment() {
  const root = await mkdtemp(join(tmpdir(), "ltx-experiments-"));
  roots.push(root);
  const store = new ExperimentStore(root);
  const baseline = validRequest("audio-to-video");
  baseline.outputName = "adopted-baseline.mp4";
  baseline.videoGuidance.modalityScale = 5;
  const experiment = store.create(
    {
      title: "Adoptierte Baseline",
      baselineRequest: baseline,
      baselineOutputName: baseline.outputName,
      candidate: { variable: "a2v-guidance", value: 3 },
    },
    new Date(0).toISOString(),
    {
      outputName: baseline.outputName,
      jobId: BASELINE_JOB_ID,
      sizeBytes: 1024,
      changedAt: new Date(0).toISOString(),
      fileId: "1",
      provenanceFingerprint: FINGERPRINT,
    },
  );
  return experiment;
}

function adoptedOutput(overrides: Partial<StudioOutput> = {}): StudioOutput {
  return {
    name: "adopted-baseline.mp4",
    jobId: BASELINE_JOB_ID,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
    provenance: { verifiedAt: new Date(0).toISOString(), fingerprint: FINGERPRINT },
    ...overrides,
  } as StudioOutput;
}

describe("adopted experiment baselines", () => {
  it("resolves the adopted baseline through its pinned provenance fingerprint", async () => {
    const experiment = await adoptedBaselineExperiment();

    expect(outputForArm(experiment, 0, [adoptedOutput()])).toBeDefined();
  });

  it("rejects an adopted baseline whose provenance fingerprint changed", async () => {
    const experiment = await adoptedBaselineExperiment();
    const tampered = adoptedOutput({
      provenance: { verifiedAt: new Date(0).toISOString(), fingerprint: "d".repeat(64) },
    } as Partial<StudioOutput>);

    expect(outputForArm(experiment, 0, [tampered])).toBeUndefined();
  });

  it("still requires the full experiment binding for the candidate arm", async () => {
    const experiment = await adoptedBaselineExperiment();
    const unbound = adoptedOutput({
      name: experiment.arms[1].request.outputName,
      jobId: null,
    } as Partial<StudioOutput>);

    expect(outputForArm(experiment, 1, [unbound])).toBeUndefined();
  });
});
