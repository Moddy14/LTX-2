import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  candidateReleaseSurfaceSchema,
  deriveReleaseSurfaceEntries,
  releaseGateIds,
} from "../shared/releaseSurface.js";
import { generationRequestSchema } from "../shared/pipelines.js";
import { supportsCooperativeCheckpoint } from "../server/admission.js";
import { validRequest } from "./fixtures.js";

function requestFor(entry: ReturnType<typeof deriveReleaseSurfaceEntries>[number]) {
  const request = validRequest(entry.request.mode);
  if (entry.request.sourceMode !== "not-applicable") {
    request.sourceMode = entry.request.sourceMode;
    request.images = entry.request.sourceMode === "image"
      ? [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 18 }]
      : [];
  }
  if (entry.request.icLoraProfile) {
    request.icLora.profile = entry.request.icLoraProfile;
    if (entry.request.icLoraProfile === "ingredients") request.icLora.videoConditioning = [];
    if (["pixel-upscaler", "v2v-instant-shave", "inpainting", "outpainting", "hdr"].includes(entry.request.icLoraProfile)) {
      request.images = [];
    }
    if (entry.request.icLoraProfile === "inpainting") request.icLora.attentionMaskPath = "/inputs/mask.mp4";
    if (entry.request.icLoraProfile === "hdr") request.icLora.hdrTextEmbeddingsPath = "/models/hdr-embeddings.pt";
  }
  if (entry.request.lipDubPipelineProfile) {
    request.lipDub.pipelineProfile = entry.request.lipDubPipelineProfile;
  }
  if (entry.request.retakeCheckpoint) {
    request.retake.distilled = entry.request.retakeCheckpoint === "distilled";
  }
  if (entry.request.dialogueIntent === "required") {
    request.promptParts.dialogue = "The speaker says exactly this sentence.";
  }
  const postprocessor = entry.request.postprocessor;
  if (postprocessor === "longcat-lipsync") {
    request.postprocess.longcatLipsync.enabled = true;
    if (request.images.length === 0) {
      request.images = [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 18 }];
    }
  } else if (postprocessor === "latentsync-1.6") {
    request.postprocess.latentSync.enabled = true;
  } else if (postprocessor === "musetalk-1.5") {
    request.postprocess.museTalk.enabled = true;
  } else if (postprocessor.startsWith("lipforcing-14b")) {
    request.postprocess.lipForcing.enabled = true;
    request.postprocess.lipForcing.decoder = postprocessor.endsWith("streaming-taehv")
      ? "streaming-taehv"
      : "wan-vae";
  }
  return request;
}

describe("candidate release surface", () => {
  it("is deterministic, unique, and partitions every gate", () => {
    const first = deriveReleaseSurfaceEntries();
    const second = deriveReleaseSurfaceEntries();
    expect(second).toEqual(first);
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
    expect(first.map(({ id }) => id)).toEqual([...first.map(({ id }) => id)].sort());
    for (const entry of first) {
      expect([
        ...entry.applicableGates,
        ...entry.notApplicable.map(({ gate }) => gate),
      ].sort()).toEqual([...releaseGateIds].sort());
    }
  });

  it("never promotes a blocked-rights entry", () => {
    for (const entry of deriveReleaseSurfaceEntries()) {
      expect(entry.targetStatus === "blocked").toBe(entry.rights.status === "blocked");
    }
  });

  it("maps every entry to a schema-valid request and the real checkpoint capability", () => {
    for (const entry of deriveReleaseSurfaceEntries()) {
      const request = requestFor(entry);
      expect(generationRequestSchema.safeParse(request), entry.id).toMatchObject({ success: true });
      expect(supportsCooperativeCheckpoint(request), entry.id).toBe(entry.cooperativeCheckpoint);
    }
  });

  it("keeps the checked-in surface schema-valid and derived from current inputs", () => {
    const surface = candidateReleaseSurfaceSchema.parse(JSON.parse(readFileSync(
      new URL("../release/candidate-release-surface.v1.json", import.meta.url),
      "utf8",
    )));
    expect(surface.entries).toEqual(deriveReleaseSurfaceEntries());
    const digest = (path: URL) => createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(surface.inputs.requestSchema.sha256).toBe(digest(new URL("../shared/pipelines.ts", import.meta.url)));
    expect(surface.inputs.capabilityMatrix.sha256).toBe(digest(new URL("../shared/releaseSurface.ts", import.meta.url)));
  });

  it("blocks every currently InsightFace-backed refiner", () => {
    const refiners = deriveReleaseSurfaceEntries().filter(({ request }) =>
      request.postprocessor.startsWith("latentsync")
      || request.postprocessor.startsWith("musetalk")
      || request.postprocessor.startsWith("lipforcing"));
    expect(refiners.length).toBeGreaterThan(0);
    expect(refiners.every(({ targetStatus }) => targetStatus === "blocked")).toBe(true);
  });
});
