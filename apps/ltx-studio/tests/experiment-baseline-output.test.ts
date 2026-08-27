import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ExperimentStore } from "../server/experimentStore.js";
import { toPublicControlledExperiment } from "../server/publicOutput.js";
import { buildExperimentCreateInput } from "../src/experimentCreate.js";
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
  return toPublicControlledExperiment(experiment);
}

function adoptedOutput(overrides: Partial<StudioOutput> = {}): StudioOutput {
  return {
    name: "adopted-baseline.mp4",
    url: "/api/outputs/adopted-baseline.mp4",
    sizeBytes: 1024,
    modifiedAt: new Date(0).toISOString(),
    changedAt: new Date(0).toISOString(),
    revisionToken: "eq1_initial-revision",
    jobId: BASELINE_JOB_ID,
    jobStatus: "completed",
    request: null,
    settingsAvailable: true,
    qualityReview: null,
    analysis: null,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
    provenanceSummary: {
      schemaVersion: "ltx-studio-public-output-provenance-summary.v1",
      status: "verified",
      capturedAt: new Date(0).toISOString(),
      verifiedAt: new Date(0).toISOString(),
      release: null,
      equality: {
        run: "eq1_initial-run",
        inputs: null,
        models: null,
        code: null,
        runtime: "eq1_initial-runtime",
      },
    },
    ...overrides,
  } as StudioOutput;
}

describe("adopted experiment baselines", () => {
  it("never sends a reusable baseline for the raw-output experiment variable", () => {
    const request = validRequest("image-audio-to-video");
    request.postprocess.lipForcing.enabled = true;

    expect(buildExperimentCreateInput({
      title: "Frischer Rohvideovergleich",
      baselineRequest: request,
      candidate: { variable: "lipforcing-raw-output-profile" },
      reusableBaselineOutputName: "legacy-v1-baseline.mp4",
    })).not.toHaveProperty("baselineOutputName");
    expect(buildExperimentCreateInput({
      title: "Andere Variable",
      baselineRequest: request,
      candidate: { variable: "lipforcing-mouth-delay-ms", value: 25 },
      reusableBaselineOutputName: "reusable-baseline.mp4",
    })).toHaveProperty("baselineOutputName", "reusable-baseline.mp4");
  });

  it("resolves the adopted baseline through the stable public server confirmation", async () => {
    const experiment = await adoptedBaselineExperiment();

    expect(outputForArm(experiment, 0, [adoptedOutput()])).toBeDefined();
  });

  it("survives a server restart that rotates all public equality tokens", async () => {
    const experiment = await adoptedBaselineExperiment();
    const restarted = adoptedOutput({
      revisionToken: "eq1_after-restart",
      provenanceSummary: {
        ...adoptedOutput().provenanceSummary!,
        equality: {
          ...adoptedOutput().provenanceSummary!.equality,
          run: "eq1_after-restart-run",
          runtime: "eq1_after-restart-runtime",
        },
      },
    });

    expect(outputForArm(experiment, 0, [restarted])).toBeDefined();
  });

  it("rejects an adopted baseline without the server's verified status", async () => {
    const experiment = await adoptedBaselineExperiment();
    const unverified = adoptedOutput({
      provenanceSummary: {
        ...adoptedOutput().provenanceSummary!,
        status: "captured-unverified",
        verifiedAt: null,
      },
    });

    expect(outputForArm(experiment, 0, [unverified])).toBeUndefined();
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
