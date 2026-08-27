import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  LTX25_WORKFLOW_CATALOG,
  type Ltx25WorkflowId,
} from "../shared/ltx25Catalog.js";
import {
  analyzeLtx25Workflow,
  ComfyWorkflowSemanticError,
  type Ltx25WorkflowSemantics,
} from "../shared/ltx25WorkflowSemantics.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ltx25-workflows");
const FULL_SIGMA_BITS = [
  "3f800000",
  "3f7e6666",
  "3f7ccccd",
  "3f7b3333",
  "3f79999a",
  "3f68cccd",
  "3f39999a",
  "3ed80000",
  "00000000",
];
const THREE_STEP_SIGMA_BITS = ["3f59999a", "3f39999a", "3ed80347", "00000000"];
const TWO_STEP_SIGMA_BITS = ["3f39999a", "3ed80347", "00000000"];

type ExpectedStage = Pick<
  Ltx25WorkflowSemantics["stages"][number],
  "sampler" | "cfg" | "seed" | "sigmaFloat32Bits" | "spatialLatentUpscalerBefore"
>;

type ExpectedWorkflow = {
  stages: ExpectedStage[];
  sinks: string[];
  videoDecodes: number;
  audioDecodes: number;
};

function stage(
  sampler: string,
  sigmaFloat32Bits: string[],
  seed: number,
  spatialLatentUpscalerBefore = false,
): ExpectedStage {
  return { sampler, cfg: 1, seed, sigmaFloat32Bits, spatialLatentUpscalerBefore };
}

const EXPECTED = {
  "t2v-i2v-two-stage": {
    stages: [
      stage("euler_ancestral", FULL_SIGMA_BITS, 42),
      stage("euler", THREE_STEP_SIGMA_BITS, 42, true),
    ],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 1,
  },
  "t2v-i2v-single-stage": {
    stages: [stage("euler_ancestral", FULL_SIGMA_BITS, 42)],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 1,
  },
  "a2v-two-stage": {
    stages: [
      stage("euler_ancestral", FULL_SIGMA_BITS, 42),
      stage("euler", THREE_STEP_SIGMA_BITS, 42, true),
    ],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 0,
  },
  "t2a-single-stage": {
    stages: [stage("euler_ancestral", FULL_SIGMA_BITS, 50)],
    sinks: ["PreviewAudio", "SaveAudioAdvanced"],
    videoDecodes: 0,
    audioDecodes: 1,
  },
  "ic-lora-union-control": {
    stages: [
      stage("euler_ancestral", FULL_SIGMA_BITS, 42),
      stage("euler", THREE_STEP_SIGMA_BITS, 42, true),
    ],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 1,
  },
  "v2v-ic-lora": {
    stages: [stage("euler_ancestral", FULL_SIGMA_BITS, 42)],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 1,
  },
  "ic-lora-ingredients": {
    stages: [stage("euler_ancestral_cfg_pp", FULL_SIGMA_BITS, 42)],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 1,
  },
  "ic-lora-motion-track": {
    stages: [stage("euler_ancestral", FULL_SIGMA_BITS, 42)],
    sinks: ["SaveVideo"],
    videoDecodes: 1,
    audioDecodes: 1,
  },
  "ic-lora-inpaint-two-stage": {
    stages: [
      stage("euler_ancestral", FULL_SIGMA_BITS, 43),
      stage("euler", TWO_STEP_SIGMA_BITS, 42),
    ],
    sinks: ["SaveVideo"],
    videoDecodes: 2,
    audioDecodes: 1,
  },
  "ic-lora-outpaint-two-stage": {
    stages: [
      stage("euler_ancestral", FULL_SIGMA_BITS, 43),
      stage("euler", TWO_STEP_SIGMA_BITS, 42),
    ],
    sinks: ["SaveVideo"],
    videoDecodes: 2,
    audioDecodes: 1,
  },
} satisfies Record<Ltx25WorkflowId, ExpectedWorkflow>;

function fixture(entry: (typeof LTX25_WORKFLOW_CATALOG)[number]): {
  raw: Buffer;
  workflow: Record<string, unknown>;
} {
  const encoded = readFileSync(join(FIXTURE_ROOT, `${entry.filename}.gz.base64`), "utf8");
  const raw = gunzipSync(Buffer.from(encoded.replace(/\s/g, ""), "base64"));
  return { raw, workflow: JSON.parse(raw.toString("utf8")) as Record<string, unknown> };
}

function workflowById(id: Ltx25WorkflowId): Record<string, unknown> {
  const entry = LTX25_WORKFLOW_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing workflow ${id}`);
  return fixture(entry).workflow;
}

describe("LTX-2.5 executable workflow semantics", () => {
  it("audits the exact pinned bytes and sampler-to-decode lineage of all ten workflows", () => {
    for (const entry of LTX25_WORKFLOW_CATALOG) {
      const pinned = fixture(entry);
      expect(createHash("sha256").update(pinned.raw).digest("hex"), entry.id).toBe(entry.sha256);

      const actual = analyzeLtx25Workflow(pinned.workflow);
      const expected = EXPECTED[entry.id];
      expect(actual.stages, entry.id).toHaveLength(entry.stages);
      expect(actual.stages.map((value) => ({
        sampler: value.sampler,
        cfg: value.cfg,
        seed: value.seed,
        sigmaFloat32Bits: value.sigmaFloat32Bits,
        spatialLatentUpscalerBefore: value.spatialLatentUpscalerBefore,
      })), entry.id).toEqual(expected.stages);
      expect(actual.primarySinkTypes, entry.id).toEqual(expected.sinks);
      expect(actual.videoDecodeCount, entry.id).toBe(expected.videoDecodes);
      expect(actual.audioDecodeCount, entry.id).toBe(expected.audioDecodes);
    }
  });

  it("uses the outer stage-two sampler override instead of the misleading inner default", () => {
    const workflow = workflowById("t2v-i2v-two-stage");
    const definitions = (workflow.definitions as { subgraphs: Array<Record<string, unknown>> }).subgraphs;
    const stageTwo = definitions.find((definition) => definition.name === "Upscale and re-sampler (3 steps)");
    const innerSampler = (stageTwo?.nodes as Array<Record<string, unknown>>)
      .find((node) => node.type === "KSamplerSelect");

    expect(innerSampler?.widgets_values).toEqual(["euler_ancestral"]);
    expect(analyzeLtx25Workflow(workflow).stages[1]?.sampler).toBe("euler");
  });

  it("gives a connected outer input precedence over its widgets fallback", () => {
    const workflow = structuredClone(workflowById("t2v-i2v-two-stage"));
    const definitions = (workflow.definitions as { subgraphs: Array<Record<string, unknown>> }).subgraphs;
    const stageTwo = definitions.find((definition) => definition.name === "Upscale and re-sampler (3 steps)");
    if (!stageTwo) throw new Error("missing stage-two definition");
    const nodes = workflow.nodes as Array<Record<string, unknown>>;
    const instance = nodes.find((node) => node.type === stageTwo.id);
    if (!instance) throw new Error("missing stage-two instance");
    const cfg = (instance.inputs as Array<Record<string, unknown>>).find((input) => input.name === "cfg");
    if (!cfg) throw new Error("missing stage-two cfg input");
    cfg.link = 999_001;
    nodes.push({
      id: 999_002,
      type: "PrimitiveFloat",
      mode: 0,
      inputs: [],
      outputs: [{ name: "FLOAT", type: "FLOAT", links: [999_001] }],
      widgets_values: [7],
    });
    (workflow.links as unknown[]).push([999_001, 999_002, 0, instance.id, 0, "FLOAT"]);

    expect(instance.widgets_values).toEqual([false, 1, "euler", 1, 42]);
    expect(analyzeLtx25Workflow(workflow).stages[1]?.cfg).toBe(7);
  });

  it("keeps Comfy ManualSigmas float32 precision exact", () => {
    const semantics = analyzeLtx25Workflow(workflowById("t2v-i2v-two-stage"));
    expect(semantics.stages[1]?.sigmaTokens[2]).toBe("0.4219");
    expect(semantics.stages[1]?.sigmaFloat32Bits[2]).toBe("3ed80347");
    expect(semantics.stages[1]?.sigmaFloat32Bits[2]).not.toBe("3ed80000");
  });

  it("orders inpaint stages by executable dependency rather than definition order", () => {
    const semantics = analyzeLtx25Workflow(workflowById("ic-lora-inpaint-two-stage"));
    expect(semantics.stages.map(({ sampler, seed }) => ({ sampler, seed }))).toEqual([
      { sampler: "euler_ancestral", seed: 43 },
      { sampler: "euler", seed: 42 },
    ]);
    expect(semantics.stages[0]?.path).toContain("Generate - Low Res");
    expect(semantics.stages[1]?.path).toContain("Generate - High Res");
  });

  it("ignores the motion-track preview sink because it has no sampler-to-decode lineage", () => {
    const semantics = analyzeLtx25Workflow(workflowById("ic-lora-motion-track"));
    expect(semantics.stages).toHaveLength(1);
    expect(semantics.videoDecodeCount).toBe(1);
  });

  it("fails closed on unsupported execution modes, widget drift and a disconnected decode", () => {
    const modeDrift = structuredClone(workflowById("t2v-i2v-two-stage"));
    const modeStageTwo = (modeDrift.nodes as Array<Record<string, unknown>>)
      .find((node) => Array.isArray(node.widgets_values) && node.widgets_values.includes("euler"));
    if (!modeStageTwo) throw new Error("missing stage-two instance");
    modeStageTwo.mode = 4;
    expect(() => analyzeLtx25Workflow(modeDrift)).toThrow(ComfyWorkflowSemanticError);

    const widgetDrift = structuredClone(workflowById("t2v-i2v-two-stage"));
    const widgetStageTwo = (widgetDrift.nodes as Array<Record<string, unknown>>)
      .find((node) => Array.isArray(node.widgets_values) && node.widgets_values.includes("euler"));
    if (!widgetStageTwo) throw new Error("missing stage-two instance");
    (widgetStageTwo.widgets_values as unknown[]).pop();
    expect(() => analyzeLtx25Workflow(widgetDrift)).toThrow(/exposes 5 widget inputs but stores 4/);

    const disconnected = structuredClone(workflowById("t2v-i2v-two-stage"));
    const sink = (disconnected.nodes as Array<Record<string, unknown>>)
      .find((node) => node.type === "SaveVideo");
    if (!sink) throw new Error("missing video sink");
    (sink.inputs as Array<Record<string, unknown>>)[0]!.link = null;
    expect(() => analyzeLtx25Workflow(disconnected)).toThrow(/no sampler-to-decode media lineage/);
  });
});
