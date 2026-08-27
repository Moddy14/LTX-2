import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appRoot } from "../server/config.js";
import { resolvePhonemeVisemeEvaluatorState } from "../server/evaluatorManifest.js";
import {
  mfaMediaPipeMeasurementSchema,
  phonemeVisemeEvaluatorManifestSchema,
  visemeMappingSchema,
} from "../shared/phonemeVisemeEvaluator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function releaseCandidateManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "ltx-studio-phoneme-viseme-manifest.v1",
    releaseId: "pv-test-release",
    productGo: {
      status: "release-candidate",
      reason: "Synthetic negative test fixture only; no Product-GO is asserted.",
      candidateCreatedAt: "2026-07-24T20:00:00.000Z",
    },
    legal: {
      codeLicense: "fixture-code-grant",
      weightsLicense: "fixture-weight-grant",
      trainingDataGrant: "fixture-training-grant",
      featureExtractionGrant: "fixture-feature-grant",
      biometricProcessingGrant: "fixture-biometric-grant",
      derivedWeightsGrant: "fixture-derived-weight-grant",
      commercialUseGrant: "fixture-commercial-grant",
      redistributionGrant: "fixture-redistribution-grant",
    },
    artifacts: {
      offsetModel: {
        path: "offset.onnx",
        sha256: digest("offset"),
        format: "onnx",
        runtime: "cpu-onnx",
      },
      contentModel: {
        path: "content.onnx",
        sha256: digest("content"),
        format: "onnx",
        runtime: "cpu-onnx",
      },
    },
    calibration: {
      gateVersion: "ltx-pv-release-gates.v1",
      tuneReport: { path: "tune.json", sha256: digest("tune") },
      holdoutReport: { path: "holdout.json", sha256: digest("holdout") },
    },
    datasets: [{
      datasetId: "fixture-dataset",
      rightsGrantId: "fixture-rights",
      splitFreezeSha256: "a".repeat(64),
    }],
    preprocessing: {
      version: "mouth-npz-rgb96-audio-wav16k-cfr.v2",
      maxSeconds: 5,
      frameRates: [24, 25, 30],
    },
    visemeMap: {
      version: "viseme15-en-de.v1",
      classCount: 15,
      path: "viseme.json",
      sha256: digest("viseme"),
    },
    ...overrides,
  };
}

describe("phoneme/viseme evaluator manifest gate", () => {
  const privateManifestPath = join(appRoot, "evaluators", "phoneme-viseme", "manifest.v3.local.json");
  it("accepts the complete 10-second production window and keeps the bound", () => {
    const measurement = {
      method: "ctc-espeak-mediapipe-de.v1",
      runnerFingerprint: "a".repeat(64),
      expectedDialogueSha256: "b".repeat(64),
      globalAvLagMilliseconds: 0,
      lagConfidence: 0.5,
      bilabialClosureF1: 0.5,
      openingCorrelation: 0.5,
      roundingCorrelation: 0.5,
      speechMotionRecall: 0.5,
      pauseLeakRatio: 0.5,
      phoneCoverage: 1,
      unknownPhones: [],
      faceTrackCoverage: 1,
      mouthTrackCoverage: 1,
      multiFaceFrameRatio: 0,
      medianBlurVariance: 100,
      yawP95Degrees: 5,
      pitchP95Degrees: 4,
      usableDurationSeconds: 241 / 24,
      sampledFrames: 241,
    };

    expect(mfaMediaPipeMeasurementSchema.safeParse(measurement).success).toBe(true);
    expect(mfaMediaPipeMeasurementSchema.safeParse({
      ...measurement,
      usableDurationSeconds: 10.500_001,
    }).success).toBe(false);
  });

  it("pins a complete, duplicate-free 15-class German/English viseme mapping", async () => {
    const path = join(appRoot, "evaluators", "phoneme-viseme", "viseme-mapping.v1.json");
    const body = JSON.parse(await readFile(path, "utf8"));

    const mapping = visemeMappingSchema.parse(body);

    expect(mapping.classes).toHaveLength(15);
    expect(mapping.classes[0]).toMatchObject({ id: 0, code: "SIL" });
    expect(mapping.normalization.unknownPolicy).toBe("quarantine");
    expect(mapping.classes.find((entry) => entry.code === "W_UW_UH_OW_OY")?.phones)
      .toEqual(expect.arrayContaining(["y", "ʏ", "ø", "œ", "ɔɪ", "UW"]));
    expect(mapping.classes.find((entry) => entry.code === "AA_AH_AW_AY")?.phones)
      .toEqual(expect.arrayContaining(["aɪ", "aʊ"]));

    const duplicate = structuredClone(body);
    duplicate.classes[2].phones.push("p");
    expect(visemeMappingSchema.safeParse(duplicate).success).toBe(false);
  });

  it.skipIf(!existsSync(privateManifestPath))(
    "ships a schema-valid private-local ARM64 CTC measurement manifest",
    async () => {
      const body = JSON.parse(await readFile(privateManifestPath, "utf8"));

      const manifest = phonemeVisemeEvaluatorManifestSchema.parse(body);

      expect(manifest).toMatchObject({
        schemaVersion: "ltx-studio-phoneme-viseme-manifest.v3",
        method: "ctc-espeak-mediapipe-de.v1",
        productGo: { status: "blocked" },
        legalApproval: { scope: "private-local-biometric-measurement-only" },
        runtime: { cpuOnly: true },
      });
    },
  );

  it("reports a missing manifest without inventing evaluator availability", () => {
    const state = resolvePhonemeVisemeEvaluatorState("");

    expect(state.fingerprint).toBe("manifest-missing.v1");
    expect(state.result.status).toBe("not-available");
    expect(state.result.blockerCode).toBe("manifest-missing");
    expect(state.result.productGo.status).toBe("blocked");
    expect(state.result.manifestSha256).toBeNull();
    expect(state.result.offset.status).toBe("not-run");
    expect(state.result.content.status).toBe("not-run");
  });

  it("loads the shipped blocked manifest only as a Legal Hold", async () => {
    const path = join(appRoot, "evaluators", "phoneme-viseme", "manifest.blocked.json");
    const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    const state = resolvePhonemeVisemeEvaluatorState(path);

    expect(state.fingerprint).toBe(`manifest-blocked:${expectedSha256}`);
    expect(state.result).toMatchObject({
      status: "not-available",
      manifestReleaseId: "pv-evaluator-legal-hold",
      manifestSha256: expectedSha256,
      productGo: { status: "blocked" },
    });
    expect(state.result.error).toContain("Legal Hold");
    expect(state.result.blockerCode).toBe("legal-hold");
  });

  it("fails closed for invalid JSON instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-pv-invalid-"));
    roots.push(root);
    const path = join(root, "manifest.json");
    await writeFile(path, "{\"schemaVersion\":");

    const state = resolvePhonemeVisemeEvaluatorState(path);

    expect(state.result.status).toBe("failed");
    expect(state.result.productGo.status).toBe("blocked");
    expect(state.result.error).toContain("ungültiges JSON");
    expect(state.result.blockerCode).toBe("manifest-invalid");
  });

  it("rejects duplicate object keys before schema validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-pv-duplicate-key-"));
    roots.push(root);
    const path = join(root, "manifest.json");
    await writeFile(path, "{\"schemaVersion\":\"a\",\"schemaVersion\":\"b\"}");

    const state = resolvePhonemeVisemeEvaluatorState(path);

    expect(state.result.status).toBe("failed");
    expect(state.result.blockerCode).toBe("manifest-invalid");
    expect(state.result.error).toContain("Doppelter JSON-Schlüssel");
  });

  it("rejects malformed UTF-8 instead of normalizing it into manifest text", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-pv-invalid-utf8-"));
    roots.push(root);
    const path = join(root, "manifest.json");
    await writeFile(path, Buffer.from([
      ...Buffer.from("{\"schemaVersion\":\""),
      0xff,
      ...Buffer.from("\"}"),
    ]));

    const state = resolvePhonemeVisemeEvaluatorState(path);

    expect(state.result.status).toBe("failed");
    expect(state.result.blockerCode).toBe("manifest-invalid");
    expect(state.result.error).toContain("ungültiges JSON");
  });

  it("refuses a symlinked manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-pv-manifest-link-"));
    roots.push(root);
    const target = join(root, "target.json");
    const link = join(root, "manifest.json");
    await writeFile(target, JSON.stringify(releaseCandidateManifest()));
    await symlink(target, link);

    const state = resolvePhonemeVisemeEvaluatorState(link);

    expect(state.result.status).toBe("failed");
    expect(state.result.error).toContain("keine reguläre Datei");
    expect(state.result.manifestSha256).toBeNull();
  });

  it("keeps an approved-looking release candidate blocked until the Product-GO runner exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-pv-artifact-gate-"));
    roots.push(root);
    const manifestPath = join(root, "manifest.json");
    await writeFile(join(root, "real-offset.onnx"), "offset");
    await symlink(join(root, "real-offset.onnx"), join(root, "offset.onnx"));
    await writeFile(join(root, "content.onnx"), "tampered-content");
    await writeFile(join(root, "tune.json"), "tune");
    await writeFile(join(root, "holdout.json"), "holdout");
    await writeFile(join(root, "viseme.json"), "viseme");
    await writeFile(manifestPath, JSON.stringify(releaseCandidateManifest()));

    const state = resolvePhonemeVisemeEvaluatorState(manifestPath);

    expect(state.fingerprint).toBe(`manifest-runner-unavailable:${digest(
      JSON.stringify(releaseCandidateManifest()),
    )}`);
    expect(state.result.status).toBe("not-available");
    expect(state.result.blockerCode).toBe("runner-unavailable");
    expect(state.result.productGo.status).toBe("blocked");
    expect(state.result.error).toContain("Product-GO-Prüfung");
    expect(state.result.offset.status).toBe("not-run");
    expect(state.result.content.status).toBe("not-run");
  });
});
