import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  candidateReleaseSurfaceSchema,
  deriveReleaseSurfaceEntries,
  promptEncoderProfileForRequest,
  releaseSurfaceEntryForRequest,
  releaseGateIds,
} from "../shared/releaseSurface.js";
import { LTX25_WORKFLOW_CATALOG } from "../shared/ltx25Catalog.js";
import { generationRequestSchema } from "../shared/pipelines.js";
import { supportsCooperativeCheckpoint } from "../server/admission.js";
import { buildCommand, validateRequestPlan } from "../server/command.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

function requestFor(entry: ReturnType<typeof deriveReleaseSurfaceEntries>[number]) {
  const split = entry.request.modelProfile !== "ltx23-monolith";
  if (split && !["distilled", "dfr", "text-to-audio", "ic-lora", "image-audio-to-video"].includes(entry.request.mode)) {
    throw new Error(`Unexpected LTX-2.5 release mode: ${entry.request.mode}`);
  }
  const request = split
    ? validLtx25SplitRequest(
        entry.request.mode as "distilled" | "dfr" | "text-to-audio" | "ic-lora" | "image-audio-to-video",
      )
    : validRequest(entry.request.mode);
  if (entry.request.mode === "distilled" && split) {
    request.distilled.singleStage = entry.request.modelProfile === "ltx25-split-bf16-single-stage";
  }
  if (entry.request.mode === "dfr" && request.dfr) {
    request.dfr.temporalUpscalings = entry.request.dfrTemporalUpscalings ?? 0;
    request.dfr.spatialUpscalings = entry.request.dfrSpatialUpscalings ?? 1;
    request.dfr.temporalUpscalerPath = request.dfr.temporalUpscalings > 0
      ? "/models/ltx-2.5/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors"
      : "";
    request.dfr.detailingLoraPath =
      "/models/ltx-2.5/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors";
    if (request.dfr.spatialUpscalings === 2) request.height = 768;
  }
  if (entry.request.unionControlType) request.icLora.controlType = entry.request.unionControlType;
  request.models.gemmaLora.enabled = entry.request.promptEncoderProfile === "abliterated-lora";
  if (entry.request.sourceMode !== "not-applicable") {
    request.sourceMode = entry.request.sourceMode;
    request.images = entry.request.sourceMode === "image"
      ? [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 18 }]
      : [];
  }
  if (entry.request.icLoraProfile) {
    request.icLora.profile = entry.request.icLoraProfile;
    if (entry.request.icLoraProfile === "ingredients") request.icLora.videoConditioning = [];
    if (["pixel-upscaler", "v2v-deblur", "v2v-instant-shave", "inpainting", "outpainting", "hdr"].includes(entry.request.icLoraProfile)) {
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
      if (entry.rights.status === "blocked") expect(entry.targetStatus).toBe("blocked");
      expect(entry.targetStatus === "blocked").toBe(entry.targetReason !== null);
    }
  });

  it("maps every entry to a schema-valid request and the real checkpoint capability", () => {
    for (const entry of deriveReleaseSurfaceEntries()) {
      const request = requestFor(entry);
      expect(generationRequestSchema.safeParse(request), entry.id).toMatchObject({ success: true });
      expect(promptEncoderProfileForRequest(request), entry.id).toBe(entry.request.promptEncoderProfile);
      expect(releaseSurfaceEntryForRequest(request).id, entry.id).toBe(entry.id);
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

  it("keeps the experimental LipForcing mux-copy profile outside every declared release entry", () => {
    const request = validRequest("image-audio-to-video");
    request.postprocess.lipForcing.enabled = true;
    request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";

    expect(() => releaseSurfaceEntryForRequest(request))
      .toThrow("outside the declared release surface");
    expect(deriveReleaseSurfaceEntries().some(({ request: entry }) =>
      entry.postprocessor.includes("mux-copy"))).toBe(false);
  });

  it("separates release-safe Base-Gemma from the blocked optional abliterated LoRA", () => {
    const entries = deriveReleaseSurfaceEntries();
    const optionalModes = entries.filter(({ request }) =>
      request.promptEncoderProfile !== "not-applicable");
    const recipes = new Map<string, Set<string>>();
    for (const entry of optionalModes) {
      const recipe = [
        entry.request.mode,
        entry.request.sourceMode,
        entry.request.icLoraProfile ?? "none",
        entry.request.postprocessor,
      ].join(":");
      const profiles = recipes.get(recipe) ?? new Set<string>();
      profiles.add(entry.request.promptEncoderProfile);
      recipes.set(recipe, profiles);
    }
    for (const profiles of recipes.values()) {
      expect(profiles).toEqual(new Set(["base-gemma", "abliterated-lora"]));
    }

    const baseEntries = optionalModes.filter(({ request }) =>
      request.promptEncoderProfile === "base-gemma");
    const abliteratedEntries = optionalModes.filter(({ request }) =>
      request.promptEncoderProfile === "abliterated-lora");
    expect(baseEntries.length).toBeGreaterThan(0);
    expect(baseEntries.every(({ rights }) =>
      !rights.evidenceIds.includes("comfy-ltx2-abliterated-lora-license-undeclared"))).toBe(true);
    expect(abliteratedEntries.every(({ rights, targetStatus }) =>
      targetStatus === "blocked"
      && rights.evidenceIds.includes("comfy-ltx2-abliterated-lora-license-undeclared"))).toBe(true);
    expect(baseEntries.some(({ request, targetStatus }) =>
      request.postprocessor === "none" && targetStatus === "candidate")).toBe(true);
  });

  it("declares each native LTX-2.5 BF16 core path as its own conditional surface", () => {
    const entries = deriveReleaseSurfaceEntries().filter(({ request }) =>
      request.modelProfile !== "ltx23-monolith");
    expect(entries).toHaveLength(27);
    const nativeEntries = entries.filter(({ request }) => request.postprocessor === "none");
    expect(nativeEntries).toHaveLength(25);
    const qualifiedNativeEntries = nativeEntries.filter(({ request }) => request.mode !== "dfr");
    expect(qualifiedNativeEntries).toHaveLength(13);
    expect(qualifiedNativeEntries.every(({ request, rights }) =>
      request.postprocessor === "none"
      && request.promptEncoderProfile === "not-applicable"
      && rights.status === "conditional"
      && rights.evidenceIds.includes("ltx25-community-license-model-card-2026-08-21"))).toBe(true);
    expect(qualifiedNativeEntries.filter(({ targetStatus }) => targetStatus === "candidate"))
      .toHaveLength(10);
    expect(qualifiedNativeEntries.filter(({ targetStatus }) => targetStatus === "blocked"))
      .toHaveLength(3);
    const dfrEntries = nativeEntries.filter(({ request }) => request.mode === "dfr");
    expect(dfrEntries).toHaveLength(12);
    expect(dfrEntries.every(({ request, rights, targetStatus, targetReason, cooperativeCheckpoint }) =>
      request.modelProfile === "ltx25-split-bf16-dfr"
      && request.promptEncoderProfile === "not-applicable"
      && request.dfrTemporalUpscalings !== null
      && request.dfrSpatialUpscalings !== null
      && rights.status === "conditional"
      && rights.evidenceIds.includes("ltx25-dfr-detailing-lora-model-card-2026-08-25")
      && targetStatus === "blocked"
      && targetReason?.includes("mandatory Detailing IC-LoRA") === true
      && cooperativeCheckpoint === false)).toBe(true);
    const lipForcingEntries = entries.filter(({ request }) =>
      request.postprocessor.startsWith("lipforcing-14b"));
    expect(lipForcingEntries).toHaveLength(2);
    expect(lipForcingEntries.every(({ request, rights, targetStatus }) =>
      request.mode === "image-audio-to-video"
      && rights.evidenceIds.includes("lipforcing-apache-2.0")
      && targetStatus === "blocked")).toBe(true);
    expect(entries
      .filter(({ request }) => request.icLoraProfile === "union-control")
      .map(({ request }) => request.unionControlType)
      .sort()).toEqual(["canny", "depth", "pose"]);
    expect(entries
      .filter(({ request }) => request.modelProfile === "ltx25-split-bf16-two-stage"))
      .toHaveLength(8);
  });

  it("keeps implementation-required LTX-2.5 Union Control two-stage and fail-closed end to end", () => {
    const catalog = LTX25_WORKFLOW_CATALOG.find(({ id }) => id === "ic-lora-union-control");
    expect(catalog).toMatchObject({
      stages: 2,
      spatialUpscale: true,
      nativeStatus: "implementation-required",
      nativeBinding: { mode: "ic-lora", icLoraProfile: "union-control" },
    });
    if (catalog?.nativeBinding?.mode !== "ic-lora") {
      throw new Error("Union Control catalog binding must remain an IC-LoRA request");
    }
    const unionProfile = catalog.nativeBinding.icLoraProfile;

    const entries = deriveReleaseSurfaceEntries().filter(({ request }) =>
      request.modelProfile !== "ltx23-monolith"
      && request.icLoraProfile === unionProfile);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        request: { modelProfile: "ltx25-split-bf16-two-stage" },
        targetStatus: "blocked",
      });
      expect(entry.targetReason).toContain("Stage-2/spatial-upscaler implementation");

      const request = requestFor(entry);
      expect(validateRequestPlan(
        request,
        buildCommand(request),
        undefined,
        { enforceOfficialAssets: false },
      )).toEqual(expect.arrayContaining([
        expect.stringContaining("Stage-2-/Upscaler-Implementierung fehlt noch"),
      ]));
    }
  });

  it("separates generic LTX-2.5 T2A from verbatim dialogue and applies only audio-relevant speech gates", () => {
    const generic = validLtx25SplitRequest("text-to-audio");
    generic.promptParts.dialogue = "";
    const exact = structuredClone(generic);
    exact.promptParts.dialogue = "Dieser Wortlaut muss exakt gesprochen werden.";

    const genericEntry = releaseSurfaceEntryForRequest(generic);
    const exactEntry = releaseSurfaceEntryForRequest(exact);

    expect(genericEntry.id).not.toBe(exactEntry.id);
    expect(genericEntry).toMatchObject({
      inputContract: ["prompt"],
      request: { dialogueIntent: "optional" },
    });
    expect(genericEntry.applicableGates).not.toContain("asr-critical-token");
    expect(exactEntry).toMatchObject({
      claimId: "native-generation.ltx25.text-to-audio.single-stage.verbatim-dialogue",
      inputContract: ["prompt", "verbatim-dialogue"],
      request: { dialogueIntent: "required" },
    });
    expect(exactEntry.applicableGates).toContain("asr-critical-token");
    expect(exactEntry.applicableGates).not.toContain("phoneme-viseme");
    expect(exactEntry.applicableGates).not.toContain("mouth-artifact");
    expect(exactEntry.notApplicable.map(({ gate }) => gate)).toEqual(expect.arrayContaining([
      "phoneme-viseme",
      "mouth-artifact",
    ]));
  });

  it("separates official LTX-2.5 V2V Deblur from the LTX-2.3 Instant-Shave legacy arm", () => {
    const nativeV2v = deriveReleaseSurfaceEntries().filter(({ request }) =>
      request.postprocessor === "none"
      && ["v2v-deblur", "v2v-instant-shave"].includes(request.icLoraProfile ?? ""));

    expect(nativeV2v.map(({ request }) => ({
      profile: request.icLoraProfile,
      modelProfile: request.modelProfile,
    }))).toEqual([
      { profile: "v2v-instant-shave", modelProfile: "ltx23-monolith" },
      { profile: "v2v-deblur", modelProfile: "ltx25-split-bf16-single-stage" },
    ]);
  });
});
