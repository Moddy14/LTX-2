import { describe, expect, it, vi } from "vitest";

import {
  publicAssetListResponseSchema,
  publicImageCropResponseSchema,
  publicLipDubReferenceResponseSchema,
  publicOutputFrameResponseSchema,
  publicSequenceResponseSchema,
  publicStudioAssetSchema,
} from "../shared/assetPublic.js";
import {
  PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
  PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
  publicHealthSchema,
  publicJobPersistenceHoldErrorSchema,
} from "../shared/healthPublic.js";
import { publicModelInventorySchema } from "../shared/modelPublic.js";
import type { StudioAsset } from "../shared/assets.js";
import { recommendedModelAssets, type ModelInventory } from "../shared/models.js";
import { createDefaultRequest } from "../shared/pipelines.js";
import {
  publicAssetListResponse,
  publicImageCropResponse,
  publicLipDubReferenceResponse,
  publicOutputFrameResponse,
  publicSequenceResponse,
  toPublicStudioAsset,
} from "../server/publicAssets.js";
import {
  resolveT2aAudioEvaluatorCapability,
  T2aAudioEvaluatorUnavailableError,
  toPublicJobPersistenceHoldError,
  toPublicHealth,
} from "../server/publicHealth.js";
import { toPublicModelInventory } from "../server/publicModels.js";
import {
  getAssets,
  getHealth,
  getModels,
  prepareImageCrop,
  prepareLipDubReference,
  takeOutputFrame,
  takeRecommendedOutputFrame,
  uploadFile,
} from "../src/api.js";

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "source",
  "additionalSources",
  "fileId",
  "deviceId",
  "inode",
  "sha256",
  "command",
  "commands",
  "frame",
  "schemaVersion",
  "candidates",
  "frameIndex",
  "faceModelPath",
  "activation",
  "releaseDigest",
  "manifestSha256",
  "surfaceDigest",
  "sourceCommit",
  "runtimeInstallSealSha256",
  "runtimeTreeSha256",
  "runtimePolicySha256",
  "nodeExecutableSha256",
  "hostTcbAttestationSha256",
  "brokerAttestationSha256",
  "actualSha256",
  "expectedSha256",
  "expectedContents",
]);

function forbiddenKeyPaths(value: unknown, path = "$", allow = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenKeyPaths(item, `${path}[${index}]`, allow));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const itemPath = `${path}.${key}`;
    const own = FORBIDDEN_PUBLIC_KEYS.has(key) && !allow.has(itemPath) ? [itemPath] : [];
    return [...own, ...forbiddenKeyPaths(item, itemPath, allow)];
  });
}

function expectNoForbiddenKeys(value: unknown, allowedPaths: readonly string[] = []): void {
  expect(forbiddenKeyPaths(value, "$", new Set(allowedPaths))).toEqual([]);
}

function rawAsset(operation: NonNullable<StudioAsset["derivation"]>["operation"]): StudioAsset {
  const evidence = {
    role: "derived-source",
    path: "/private/source/input.mp4",
    kind: "file" as const,
    sizeBytes: 9_876,
    modifiedAtMs: 1_777_000_000_000,
    changedAtMs: 1_777_000_000_100,
    fileId: "44:55",
    sha256: "a".repeat(64),
    entries: [],
    deviceId: "44",
    inode: "55",
  };
  const secondEvidence = {
    ...evidence,
    role: "second-source",
    fileId: "66:77",
    inode: "77",
  };
  return {
    id: "11111111-2222-4333-8444-555555555555",
    path: "/operator/uploads/image/11111111-2222-4333-8444-555555555555.png",
    name: "operator-reference.png",
    size: 12_345,
    kind: operation === "sequence-assemble" || operation === "lipdub-reference-prepare" ? "video" : "image",
    url: `/api/uploads/${operation === "sequence-assemble" || operation === "lipdub-reference-prepare" ? "video" : "image"}/11111111-2222-4333-8444-555555555555.png`,
    createdAt: "2026-08-25T10:00:00.000Z",
    derivation: {
      schemaVersion: "ltx-studio-asset-derivation.v1",
      operation,
      source: evidence,
      additionalSources: [secondEvidence],
      parameters: {
        sourceAssetId: "private-asset-id",
        faceModelPath: "/private/models/face.onnx",
      },
      command: "/usr/bin/ffmpeg -i /private/source/input.mp4 /private/result.mp4",
      createdAt: "2026-08-25T10:00:01.000Z",
    },
  };
}

describe("public asset control plane", () => {
  it("maps upload and list responses to an explicit harmless derivation summary", () => {
    const internal = Object.assign(rawAsset("output-frame"), {
      command: "top-level private command",
      frame: { path: "/private/raw-frame.png" },
    });
    const upload = toPublicStudioAsset(internal);
    const list = publicAssetListResponse([internal]);

    expect(upload.derivation).toEqual({
      operation: "output-frame",
      sourceCount: 2,
      createdAt: "2026-08-25T10:00:01.000Z",
    });
    expect(list.assets).toEqual([upload]);
    expectNoForbiddenKeys(upload);
    expectNoForbiddenKeys(list);
    expect(publicStudioAssetSchema.safeParse({ ...upload, command: "injected" }).success).toBe(false);
    expect(publicAssetListResponseSchema.safeParse({ ...list, additionalSources: [] }).success).toBe(false);
  });

  it("retains crop operator dimensions while removing provenance and the FFmpeg command", () => {
    const internal = rawAsset("image-face-crop");
    const prepared = {
      source: { width: 1_248, height: 704 },
      crop: { x: 10, y: 20, width: 640, height: 576 },
      target: { width: 768, height: 1_344 },
      fit: "bokeh" as const,
      coverage: 0.94,
      feather: 90,
      scaleFilter: "lanczos" as const,
      command: "private ffmpeg crop command",
      sourcePath: "/private/source/input.png",
    };
    const result = publicImageCropResponse(internal, prepared);

    expect(result).toMatchObject({
      source: { width: 1_248, height: 704 },
      crop: { x: 10, y: 20, width: 640, height: 576 },
      target: { width: 768, height: 1_344 },
      fit: "bokeh",
      coverage: 0.94,
      feather: 90,
      scaleFilter: "lanczos",
    });
    expectNoForbiddenKeys(result, ["$.source"]);
    expect(publicImageCropResponseSchema.safeParse({ ...result, command: "injected" }).success).toBe(false);
    expect(publicImageCropResponseSchema.safeParse({
      ...result,
      source: { ...result.source, fileId: "private" },
    }).success).toBe(false);
  });

  it("maps both manual and recommended output-frame success responses without a raw frame", () => {
    const internal = rawAsset("output-frame");
    const recommendation = {
      atSeconds: 1.88,
      score: 0.91,
      sampledFrames: 40,
      eligibleFrames: 32,
      metrics: {
        faceSharpness: 123.4,
        faceAreaRatio: 0.12,
        faceConfidence: 0.98,
        stability: 0.94,
        exposure: 0.72,
        frontalness: 0.9,
        prominentFaceCount: 1,
      },
      candidates: [{ frameIndex: 42, path: "/private/frame.png" }],
      schemaVersion: "private-frame-recommendation.v1",
      command: "private selector command",
      faceModelPath: "/private/models/face.onnx",
    };
    const manual = publicOutputFrameResponse(internal, null);
    const recommended = publicOutputFrameResponse(internal, recommendation);

    expect(manual.recommendation).toBeNull();
    expect(recommended.recommendation).toMatchObject({ atSeconds: 1.88, score: 0.91 });
    expectNoForbiddenKeys(manual);
    expectNoForbiddenKeys(recommended);
    expect(publicOutputFrameResponseSchema.safeParse({
      ...recommended,
      frame: { command: "injected" },
    }).success).toBe(false);
    expect(publicOutputFrameResponseSchema.safeParse({
      ...recommended,
      recommendation: { ...recommended.recommendation, candidates: [] },
    }).success).toBe(false);
  });

  it("maps sequence and LipDub responses without shot paths or preparation commands", () => {
    const preparedSequence = {
      shots: [
        {
          outputName: "shot-a.mp4",
          path: "/private/outputs/shot-a.mp4",
          width: 1_280,
          height: 704,
          frames: 97,
          durationSeconds: 4.04,
          trimStartSeconds: 0.2,
          trimEndSeconds: 0.1,
          usedSeconds: 3.74,
        },
        {
          outputName: "shot-b.mp4",
          path: "/private/outputs/shot-b.mp4",
          width: 1_280,
          height: 704,
          frames: 121,
          durationSeconds: 5.04,
          trimStartSeconds: 0,
          trimEndSeconds: 0,
          usedSeconds: 5.04,
        },
      ],
      target: { width: 1_280, height: 704, durationSeconds: 8.78 },
      command: "private concat command",
    };
    const preparedLipDub = {
      target: { width: 768, height: 1_344, fps: 24 as const, frames: 97, durationSeconds: 4.0416667 },
      trim: { startSeconds: 0.25, requestedDurationSeconds: 4.2 },
      command: "private LipDub command",
    };
    const sequence = publicSequenceResponse(rawAsset("sequence-assemble"), preparedSequence);
    const lipDub = publicLipDubReferenceResponse(rawAsset("lipdub-reference-prepare"), preparedLipDub);

    expect(sequence.shots[0]).not.toHaveProperty("path");
    expect(lipDub.trim).toEqual({ startSeconds: 0.25, requestedDurationSeconds: 4.2 });
    expectNoForbiddenKeys(sequence);
    expectNoForbiddenKeys(lipDub);
    expect(publicSequenceResponseSchema.safeParse({ ...sequence, command: "injected" }).success).toBe(false);
    expect(publicLipDubReferenceResponseSchema.safeParse({ ...lipDub, command: "injected" }).success).toBe(false);
  });
});

describe("public health control plane", () => {
  const input = {
    state: "ready" as const,
    release: {
      sealed: false,
      verified: false,
      authorityIsolation: null,
      releaseDigest: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      surfaceDigest: "d".repeat(64),
      sourceCommit: "private-commit",
      runtimeInstallSealSha256: "e".repeat(64),
      runtimeTreeSha256: "f".repeat(64),
      runtimePolicySha256: "1".repeat(64),
      nodeExecutableSha256: "2".repeat(64),
    },
    activation: {
      journal: [{ command: "private activation command", sha256: "3".repeat(64) }],
    },
    resources: {
      availableMemoryGiB: 96,
      totalMemoryGiB: 128,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 512,
    },
    engine: "available" as const,
    analysisEngine: "available" as const,
    orchestrator: "available" as const,
    qwen: "ready" as const,
    runtimeOverall: "ready",
    workloads: [{ id: "qwen" as const, label: "Qwen", state: "resident_ready", protected: true, estimatedMemoryGiB: 19 }],
    evaluators: {
      phonemeViseme: {
        status: "measured" as const,
        blockerCode: "",
        message: null,
        productGo: "passed" as const,
        measurementReady: true,
        method: "ctc-espeak-mediapipe-de.v1" as const,
      },
      t2aAudio: {
        status: "development-measurement" as const,
        claimScope: "development" as const,
        blockerCode: "development-runtime-unattested" as const,
        message: "T2A-Audio-QA misst im Entwicklungsmodus; diese Messung ist keine Produktfreigabe.",
        productGo: "blocked" as const,
        measurementReady: true,
      },
    },
    queueDepth: 1,
  };

  it("publishes the development fallback without release hashes or the Activation journal", () => {
    const result = toPublicHealth(input);
    expect(result.release).toEqual({
      sealed: false,
      verified: false,
      authorityIsolation: {
        status: "hold",
        mechanism: "unattested-development",
        reasonCode: "runtime-trust-unavailable",
      },
    });
    expectNoForbiddenKeys(result);
    expect(publicHealthSchema.safeParse({ ...result, activation: input.activation }).success).toBe(false);
    expect(publicHealthSchema.safeParse({
      ...result,
      release: { ...result.release, releaseDigest: "a".repeat(64) },
    }).success).toBe(false);
  });

  it("reduces an attested authority record to the three public status fields", () => {
    const authorityIsolation = {
      status: "attested" as const,
      mechanism: "separate-studio-identity-proc-fd-isolation" as const,
      reasonCode: null,
      hostTcbAttestationSha256: "4".repeat(64),
      brokerAttestationSha256: null,
    };
    const attestedInput = {
      ...input,
      release: {
        ...input.release,
        sealed: true,
        verified: true,
        authorityIsolation,
      },
    };
    const result = toPublicHealth(attestedInput);
    expect(result.release.authorityIsolation).toEqual({
      status: "attested",
      mechanism: "separate-studio-identity-proc-fd-isolation",
      reasonCode: null,
    });
    expectNoForbiddenKeys(result);
  });

  it("derives an honest T2A capability for sealed and development runtimes", () => {
    expect(resolveT2aAudioEvaluatorCapability({
      sealed: false,
      verified: false,
      authorityIsolation: null,
      analysisRuntimeAvailable: true,
      developmentMeasurementEnabled: false,
    })).toMatchObject({
      status: "blocked",
      claimScope: null,
      blockerCode: "development-opt-in-required",
      productGo: "blocked",
      measurementReady: false,
    });
    expect(resolveT2aAudioEvaluatorCapability({
      sealed: false,
      verified: false,
      authorityIsolation: null,
      analysisRuntimeAvailable: true,
      developmentMeasurementEnabled: true,
    })).toMatchObject({
      status: "development-measurement",
      claimScope: "development",
      blockerCode: "development-runtime-unattested",
      productGo: "blocked",
      measurementReady: true,
    });
    expect(resolveT2aAudioEvaluatorCapability({
      sealed: true,
      verified: true,
      authorityIsolation: { status: "attested" },
      analysisRuntimeAvailable: true,
      developmentMeasurementEnabled: false,
    })).toMatchObject({
      status: "authoritative",
      claimScope: "sealed-release",
      blockerCode: "none",
      productGo: "blocked",
      measurementReady: true,
    });
  });

  it("fails sealed T2A capability closed with stable public blocker codes", () => {
    const base = {
      sealed: true,
      verified: true,
      authorityIsolation: { status: "attested" as const },
      analysisRuntimeAvailable: true,
      developmentMeasurementEnabled: false,
    };
    expect(resolveT2aAudioEvaluatorCapability({ ...base, verified: false }).blockerCode)
      .toBe("release-not-verified");
    expect(resolveT2aAudioEvaluatorCapability({
      ...base,
      authorityIsolation: { status: "hold" },
    }).blockerCode).toBe("authority-isolation-unattested");
    expect(resolveT2aAudioEvaluatorCapability({
      ...base,
      analysisRuntimeAvailable: false,
    }).blockerCode).toBe("analysis-runtime-unavailable");
  });

  it("rejects contradictory T2A public claims and redacts unknown start failures", () => {
    const result = toPublicHealth(input);
    expect(publicHealthSchema.safeParse({
      ...result,
      evaluators: {
        ...result.evaluators,
        t2aAudio: {
          ...result.evaluators.t2aAudio,
          productGo: "passed",
        },
      },
    }).success).toBe(false);
    const error = T2aAudioEvaluatorUnavailableError.startFailed(
      "8c8a5dc6-8864-49f7-a639-85caef918899",
    );
    expect(error).toMatchObject({
      statusCode: 503,
      blockerCode: "evaluator-start-failed",
      message: "T2A-Audio-QA konnte nicht sicher gestartet werden.",
      correlationId: "8c8a5dc6-8864-49f7-a639-85caef918899",
    });
  });
});

describe("public model control plane", () => {
  it("retains operator model fields while stripping every verification secret recursively", () => {
    const inventory: ModelInventory = {
      roots: ["/operator/models"],
      scannedAt: "2026-08-25T10:00:00.000Z",
      truncated: false,
      errors: [],
      items: [{
        kind: "transformer",
        path: "/operator/models/transformer.safetensors",
        name: "transformer.safetensors",
        sizeBytes: 42_018_190_584,
        modifiedAt: "2026-08-25T09:00:00.000Z",
        precision: "bf16",
      }],
      recommendations: [{
        id: "ltx25-transformer-bf16",
        kind: "transformer",
        label: "LTX-2.5 Transformer",
        repoId: "Lightricks/LTX-2.5",
        revision: "private-revision-but-operator-visible",
        sourcePath: "diffusion_models/transformer.safetensors",
        filename: "transformer.safetensors",
        localPath: "/operator/models/transformer.safetensors",
        present: true,
        access: "gated",
        expectedSizeBytes: 42_018_190_584,
        expectedSha256: "5".repeat(64),
        actualSha256: "6".repeat(64),
        expectedContents: [{
          relativePath: "nested/model.safetensors",
          expectedSizeBytes: 123,
          expectedSha256: "7".repeat(64),
        }],
        integrity: "verified",
      }],
    };
    const result = toPublicModelInventory(inventory);

    expect(result.recommendations[0]).toMatchObject({
      id: "ltx25-transformer-bf16",
      repoId: "Lightricks/LTX-2.5",
      revision: "private-revision-but-operator-visible",
      sourcePath: "diffusion_models/transformer.safetensors",
      localPath: "/operator/models/transformer.safetensors",
      expectedSizeBytes: 42_018_190_584,
      integrity: "verified",
    });
    expectNoForbiddenKeys(result);
    expect(publicModelInventorySchema.safeParse({
      ...result,
      recommendations: [{ ...result.recommendations[0], actualSha256: "8".repeat(64) }],
    }).success).toBe(false);
    expect(publicModelInventorySchema.safeParse({
      ...result,
      recommendations: [{ ...result.recommendations[0], expectedContents: [] }],
    }).success).toBe(false);
  });

  it("maps the complete current recommendation catalog through the public ID allowlist", () => {
    const result = toPublicModelInventory({
      roots: ["/operator/models"],
      scannedAt: "2026-08-25T10:00:00.000Z",
      truncated: false,
      errors: [],
      items: [],
      recommendations: recommendedModelAssets.map((asset) => ({ ...asset })),
    });

    expect(result.recommendations.map((asset) => asset.id)).toEqual(
      recommendedModelAssets.map((asset) => asset.id),
    );
    expectNoForbiddenKeys(result);
  });
});

describe("public client response gates", () => {
  it("rejects adversarial extra fields on every Asset, Health, and Model client path", async () => {
    const asset = toPublicStudioAsset(rawAsset("output-frame"));
    const health = toPublicHealth({
      state: "ready",
      release: { sealed: false, verified: false, authorityIsolation: null },
      resources: {
        availableMemoryGiB: 96,
        totalMemoryGiB: 128,
        swapFreeGiB: 8,
        swapTotalGiB: 16,
        outputFreeGiB: 512,
      },
      engine: "available",
      analysisEngine: "available",
      orchestrator: "available",
      qwen: "ready",
      runtimeOverall: "ready",
      workloads: [],
      evaluators: {
        phonemeViseme: {
          status: "not-available",
          blockerCode: "manifest-missing",
          message: null,
          productGo: "blocked",
          measurementReady: false,
          method: null,
        },
        t2aAudio: {
          status: "blocked",
          claimScope: null,
          blockerCode: "development-opt-in-required",
          message: "T2A-Audio-QA benoetigt ein ausdrueckliches Mess-Opt-in.",
          productGo: "blocked",
          measurementReady: false,
        },
      },
      queueDepth: 0,
    });
    const models = toPublicModelInventory({
      roots: ["/operator/models"],
      scannedAt: "2026-08-25T10:00:00.000Z",
      truncated: false,
      errors: [],
      items: [],
      recommendations: [{
        id: "ltx25-transformer-bf16",
        kind: "transformer",
        label: "LTX-2.5 Transformer",
        repoId: "Lightricks/LTX-2.5",
        filename: "transformer.safetensors",
        localPath: "/operator/models/transformer.safetensors",
        present: true,
        access: "gated",
        integrity: "unverified",
      }],
    });
    const frame = publicOutputFrameResponse(rawAsset("output-frame"), null);
    const recommendedFrame = publicOutputFrameResponse(rawAsset("output-frame"), {
      atSeconds: 1,
      score: 0.9,
      sampledFrames: 2,
      eligibleFrames: 1,
      metrics: {
        faceSharpness: 100,
        faceAreaRatio: 0.1,
        faceConfidence: 0.9,
        stability: 0.9,
        exposure: 0.8,
        frontalness: 0.9,
        prominentFaceCount: 1,
      },
    });
    const crop = publicImageCropResponse(rawAsset("image-face-crop"), {
      source: { width: 704, height: 1_248 },
      crop: { x: 0, y: 0, width: 576, height: 576 },
      target: { width: 576, height: 576 },
      fit: "stretch",
      coverage: null,
      feather: null,
      scaleFilter: "lanczos",
    });
    const lipDub = publicLipDubReferenceResponse(rawAsset("lipdub-reference-prepare"), {
      target: { width: 768, height: 1_344, fps: 24, frames: 97, durationSeconds: 4.0416667 },
      trim: { startSeconds: 0, requestedDurationSeconds: 4.2 },
    });
    const request = createDefaultRequest("lipdub");
    const cases: Array<{ name: string; body: unknown; call: () => Promise<unknown> }> = [
      {
        name: "health activation journal",
        body: { ...health, activation: { command: "private", sha256: "a".repeat(64) } },
        call: getHealth,
      },
      {
        name: "model verification digest",
        body: {
          ...models,
          recommendations: [{ ...models.recommendations[0], actualSha256: "b".repeat(64) }],
        },
        call: getModels,
      },
      {
        name: "asset-list provenance",
        body: { assets: [{ ...asset, additionalSources: [] }] },
        call: getAssets,
      },
      {
        name: "upload command",
        body: { ...asset, command: "private upload command" },
        call: () => uploadFile("image", new File(["image"], "image.png", { type: "image/png" })),
      },
      {
        name: "manual raw frame",
        body: { ...frame, frame: { path: "/private/frame.png" } },
        call: () => takeOutputFrame("output.mp4", 1),
      },
      {
        name: "recommended candidates",
        body: {
          ...recommendedFrame,
          recommendation: { ...recommendedFrame.recommendation, candidates: [{ frameIndex: 1 }] },
        },
        call: () => takeRecommendedOutputFrame("output.mp4"),
      },
      {
        name: "crop command",
        body: { ...crop, command: "private crop command" },
        call: () => prepareImageCrop({
          path: asset.path,
          x: 0,
          y: 0,
          width: 576,
          height: 576,
          outputWidth: 576,
          outputHeight: 576,
        }),
      },
      {
        name: "LipDub command",
        body: { ...lipDub, command: "private LipDub command" },
        call: () => prepareLipDubReference(request, { startSeconds: 0, durationSeconds: 4.2 }),
      },
    ];

    for (const testCase of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(testCase.body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })));
      try {
        await expect(testCase.call(), testCase.name).rejects.toThrow();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("parses a schema-valid 503 persistence HOLD as visible health instead of a transport error", async () => {
    const privateDigest = "a".repeat(64);
    const privateReason = `/home/moddy/private/jobs.json ${privateDigest} ${"raw-cause ".repeat(600)}`;
    const healthy = toPublicHealth({
      state: "blocked",
      release: { sealed: false, verified: false, authorityIsolation: null },
      resources: {
        availableMemoryGiB: 96,
        totalMemoryGiB: 128,
        swapFreeGiB: 8,
        swapTotalGiB: 16,
        outputFreeGiB: 512,
      },
      engine: "available",
      analysisEngine: "available",
      orchestrator: "available",
      qwen: "ready",
      runtimeOverall: "blocked",
      workloads: [],
      evaluators: {
        phonemeViseme: {
          status: "not-available",
          blockerCode: "manifest-missing",
          message: null,
          productGo: "blocked",
          measurementReady: false,
          method: null,
        },
        t2aAudio: {
          status: "blocked",
          claimScope: null,
          blockerCode: "development-opt-in-required",
          message: "T2A-Audio-QA benoetigt ein ausdrueckliches Mess-Opt-in.",
          productGo: "blocked",
          measurementReady: false,
        },
      },
      jobPersistence: {
        status: "hold",
        restartRequired: true,
        code: privateReason,
        reason: privateReason,
      },
      queueDepth: 1,
    });
    const serializedHealth = JSON.stringify(healthy);
    expect(publicHealthSchema.parse(healthy).jobPersistence).toEqual({
      status: "hold",
      restartRequired: true,
      code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
      reason: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
    });
    expect(serializedHealth).not.toContain("/home/moddy/private/jobs.json");
    expect(serializedHealth).not.toContain(privateDigest);
    expect(serializedHealth).not.toContain("raw-cause");
    expect(PUBLIC_JOB_PERSISTENCE_HOLD_REASON.length).toBeLessThanOrEqual(256);

    const errorBody = toPublicJobPersistenceHoldError();
    expect(publicJobPersistenceHoldErrorSchema.parse(errorBody)).toEqual({
      error: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
      code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
      restartRequired: true,
    });
    expect(JSON.stringify(errorBody)).not.toContain(privateDigest);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(healthy), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));
    try {
      await expect(getHealth()).resolves.toMatchObject({
        state: "blocked",
        jobPersistence: {
          status: "hold",
          restartRequired: true,
          code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
          reason: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
