import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { appRoot } from "../server/config.js";
import {
  isPhonemeVisemeExecution,
  resolvePhonemeVisemeEvaluatorState,
} from "../server/evaluatorManifest.js";

const roots: string[] = [];
let sealedPythonExecutable = "";
let sealedRunnerPath = "";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-pv-sealed-runtime-"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "pyvenv.cfg"), "home = /usr/bin\n");
  await symlink("/usr/bin/python3", join(root, "bin", "python"));
  sealedRunnerPath = join(root, "phoneme_viseme_measurement.py");
  await copyFile(join(appRoot, "scripts", "phoneme_viseme_measurement.py"), sealedRunnerPath);
  await chmod(root, 0o755);
  await chmod(join(root, "bin"), 0o755);
  await chmod(join(root, "pyvenv.cfg"), 0o444);
  await chmod(sealedRunnerPath, 0o555);
  const sealed = spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/chown", "-R", "root:root", root],
    { encoding: "utf8" },
  );
  if (sealed.status !== 0) {
    throw new Error(`Testlaufzeit konnte nicht versiegelt werden: ${sealed.stderr}`);
  }
  const sealedLink = spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/chown", "-h", "root:root", join(root, "bin", "python")],
    { encoding: "utf8" },
  );
  if (sealedLink.status !== 0) {
    throw new Error(`Test-Python-Symlink konnte nicht versiegelt werden: ${sealedLink.stderr}`);
  }
  sealedPythonExecutable = join(root, "bin", "python");
});

afterAll(() => {
  if (!sealedPythonExecutable) return;
  spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/rm", "-rf", join(sealedPythonExecutable, "..", "..")],
    { stdio: "ignore" },
  );
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(overrides: {
  tamperDictionary?: boolean;
  symlinkLandmarker?: boolean;
  symlinkLandmarkerDirectory?: boolean;
  commercialUseReviewed?: boolean;
  unsealedMfa?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ltx-pv-v2-"));
  roots.push(root);
  const mapping = await readFile(join(
    appRoot,
    "evaluators",
    "phoneme-viseme",
    "viseme-mapping.v1.json",
  ));
  const files = {
    mfa: "#!/bin/sh\nexit 0\n",
    acoustic: "acoustic",
    dictionary: "dictionary",
    landmarker: "landmarker",
    mapping,
    codeLicense: "fixture code license",
    modelLicense: "fixture model license",
    modelCard: "fixture model card",
    trainingData: "fixture training data provenance",
    approval: "approved commercial biometric fixture evidence",
  };
  await Promise.all([
    writeFile(join(root, "mfa"), files.mfa),
    writeFile(join(root, "acoustic.zip"), files.acoustic),
    writeFile(join(root, "dictionary.dict"), files.dictionary),
    writeFile(join(root, "face.task.real"), files.landmarker),
    writeFile(join(root, "viseme.json"), files.mapping),
    writeFile(join(root, "CODE-LICENSE.txt"), files.codeLicense),
    writeFile(join(root, "MODEL-LICENSE.txt"), files.modelLicense),
    writeFile(join(root, "MODEL-CARD.txt"), files.modelCard),
    writeFile(join(root, "TRAINING-DATA.txt"), files.trainingData),
    writeFile(join(root, "LEGAL-APPROVAL.txt"), files.approval),
  ]);
  await Promise.all([
    chmod(join(root, "mfa"), overrides.unsealedMfa ? 0o700 : 0o555),
    chmod(join(root, "acoustic.zip"), 0o444),
    chmod(join(root, "dictionary.dict"), 0o444),
    chmod(join(root, "face.task.real"), 0o444),
    chmod(join(root, "viseme.json"), 0o444),
    chmod(join(root, "CODE-LICENSE.txt"), 0o444),
    chmod(join(root, "MODEL-LICENSE.txt"), 0o444),
    chmod(join(root, "MODEL-CARD.txt"), 0o444),
    chmod(join(root, "TRAINING-DATA.txt"), 0o444),
    chmod(join(root, "LEGAL-APPROVAL.txt"), 0o444),
  ]);
  let landmarkerPath = "face.task";
  if (overrides.symlinkLandmarkerDirectory) {
    await mkdir(join(root, "assets.real"));
    await writeFile(join(root, "assets.real", "face.task"), files.landmarker);
    await chmod(join(root, "assets.real", "face.task"), 0o444);
    await symlink(join(root, "assets.real"), join(root, "assets"));
    landmarkerPath = "assets/face.task";
  } else if (overrides.symlinkLandmarker) {
    await symlink(join(root, "face.task.real"), join(root, "face.task"));
  } else {
    await writeFile(join(root, "face.task"), files.landmarker);
    await chmod(join(root, "face.task"), 0o444);
  }
  const approvalEvidenceId = "fixture-approval";
  const modelEvidenceIds = [
    "fixture-model-license",
    "fixture-model-card",
    "fixture-training-data",
    approvalEvidenceId,
  ];
  const codeEvidenceIds = ["fixture-code-license", approvalEvidenceId];
  const artifact = (
    path: string,
    value: string | Buffer,
    kind: string,
    licenseEvidenceIds: string[],
  ) => ({
    path,
    sha256: digest(value),
    sizeBytes: Buffer.byteLength(value),
    kind,
    upstreamUrl: "https://example.invalid/component",
    revision: "fixture-revision",
    licenseEvidenceIds,
  });
  const manifest = {
    schemaVersion: "ltx-studio-phoneme-viseme-manifest.v2",
    releaseId: "pv-measurement-fixture",
    method: "mfa-mediapipe-de.v1",
    productGo: {
      status: "blocked",
      reason: "Measurement fixture has no Product-GO.",
      candidateCreatedAt: "2026-07-25T15:00:00.000Z",
    },
    preprocessing: {
      version: "mfa-mediapipe-de-pts.v1",
      maxSeconds: 5,
      frameRates: [24, 25, 30],
    },
    evidencePolicy: {
      minimumSampledFrames: 24,
      minimumUsableDurationSeconds: 1,
      minimumFaceTrackCoverage: 0.8,
      minimumMouthTrackCoverage: 0.8,
      maximumMultiFaceFrameRatio: 0.05,
      minimumPhoneCoverage: 0.9,
      requireNoUnknownPhones: true,
      minimumMedianBlurVariance: 20,
      maximumYawP95Degrees: 35,
      maximumPitchP95Degrees: 25,
    },
    visemeMap: {
      version: "viseme15-en-de.v1",
      classCount: 15,
      path: "viseme.json",
      sha256: digest(mapping),
    },
    runtime: {
      pythonVersion: "3.12.3",
      mfaVersion: "3.3.9",
      mediaPipeVersion: "0.10.31",
      openCvVersion: "4.13.0",
      numpyVersion: "2.4.2",
      ffmpegVersion: "7.1.1",
      ffmpegSha256: "1".repeat(64),
      ffprobeSha256: "2".repeat(64),
      cpuOnly: true,
    },
    components: {
      mfaExecutable: artifact("mfa", files.mfa, "mfa-executable", codeEvidenceIds),
      acousticModel: artifact("acoustic.zip", files.acoustic, "mfa-acoustic-model", modelEvidenceIds),
      dictionary: artifact(
        "dictionary.dict",
        overrides.tamperDictionary ? `${files.dictionary}-tampered` : files.dictionary,
        "mfa-dictionary",
        modelEvidenceIds,
      ),
      g2pModel: null,
      faceLandmarker: artifact(
        landmarkerPath,
        files.landmarker,
        "mediapipe-face-landmarker",
        modelEvidenceIds,
      ),
      visemeMapping: artifact("viseme.json", mapping, "viseme-mapping", codeEvidenceIds),
    },
    legalApproval: {
      evidenceId: approvalEvidenceId,
      reviewedBy: "Fixture Administrator",
      reviewedAt: "2026-07-25T15:00:00.000Z",
      policyVersion: "ltx-studio-evaluator-legal.v1",
      scope: "commercial-biometric-measurement-only",
    },
    legalEvidence: [
      ["fixture-code-license", "Code license", "CODE-LICENSE.txt", files.codeLicense, "code-license"],
      ["fixture-model-license", "Model license", "MODEL-LICENSE.txt", files.modelLicense, "model-license"],
      ["fixture-model-card", "Model card", "MODEL-CARD.txt", files.modelCard, "model-card"],
      ["fixture-training-data", "Training data", "TRAINING-DATA.txt", files.trainingData, "training-data-provenance"],
      [approvalEvidenceId, "Legal approval", "LEGAL-APPROVAL.txt", files.approval, "biometric-processing-approval"],
    ].map(([evidenceId, subject, path, value, evidenceType]) => ({
      evidenceId,
      subject,
      path,
      sha256: digest(value),
      upstreamUrl: "https://example.invalid/license",
      revision: "fixture-license-revision",
      evidenceType,
      commercialUseReviewed: overrides.commercialUseReviewed ?? true,
      biometricProcessingReviewed: true,
    })),
  };
  const manifestPath = join(root, "manifest.json");
  const manifestRaw = JSON.stringify(manifest);
  await writeFile(manifestPath, manifestRaw);
  await chmod(manifestPath, 0o444);
  const runner = await readFile(join(appRoot, "scripts", "phoneme_viseme_measurement.py"));
  return {
    root,
    manifest,
    manifestPath,
    trustPins: {
      manifestSha256: digest(manifestRaw),
      legalApprovalSha256: digest(files.approval),
      runnerSha256: digest(runner),
    },
  };
}

describe("MFA/MediaPipe measurement manifest", () => {
  it("binds every component and exposes only measurement execution", async () => {
    const input = await fixture();

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(state.fingerprint).toMatch(/^manifest-v2-measurement-ready:/);
    expect(state.result).toMatchObject({
      status: "not-available",
      blockerCode: "product-go-pending",
      productGo: { status: "blocked" },
      preprocessingVersion: "mfa-mediapipe-de-pts.v1",
    });
    expect(state.execution).toMatchObject({
      method: "mfa-mediapipe-de.v1",
      mfaExecutablePath: join(input.root, "mfa"),
      faceLandmarkerPath: join(input.root, "face.task"),
    });
    expect(state.execution?.runnerPath).toBe(sealedRunnerPath);
    expect(isPhonemeVisemeExecution(state.execution)).toBe(true);
  });

  it("fails closed for a component hash mismatch", async () => {
    const input = await fixture({ tamperDictionary: true });

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(state.execution).toBeNull();
    expect(state.result.status).toBe("failed");
    expect(state.result.blockerCode).toBe("artifact-invalid");
    expect(state.result.error).toContain("Komponenten");
  });

  it("rejects component permissions that the DynamicUser cannot use", async () => {
    const input = await fixture({ unsealedMfa: true });

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(state.execution).toBeNull();
    expect(state.result.blockerCode).toBe("artifact-invalid");
    expect(state.result.error).toMatch(/DynamicUser|versiegelt/u);
  });

  it("recomputes a cached artifact after an in-place revision change", async () => {
    const input = await fixture();
    expect(resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    ).execution).not.toBeNull();

    await chmod(join(input.root, "dictionary.dict"), 0o644);
    await writeFile(join(input.root, "dictionary.dict"), "dictionarz");
    const changed = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(changed.execution).toBeNull();
    expect(changed.result.blockerCode).toBe("artifact-invalid");
  });

  it("rejects symlinked component artifacts", async () => {
    const input = await fixture({ symlinkLandmarker: true });

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(state.execution).toBeNull();
    expect(state.result.blockerCode).toBe("artifact-invalid");
    expect(state.result.error).toContain("Symlink im Evaluator-Artefaktpfad");
  });

  it("rejects symlinks in component parent directories", async () => {
    const input = await fixture({ symlinkLandmarkerDirectory: true });

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(state.execution).toBeNull();
    expect(state.result.blockerCode).toBe("artifact-invalid");
    expect(state.result.error).toContain("Symlink im Evaluator-Artefaktpfad");
  });

  it("keeps measurement disabled until all legal scopes were reviewed", async () => {
    const input = await fixture({ commercialUseReviewed: false });

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      sealedRunnerPath,
    );

    expect(state.execution).toBeNull();
    expect(state.result.status).toBe("not-available");
    expect(state.result.blockerCode).toBe("legal-hold");
  });

  it("requires administrator-side manifest and approval trust pins", async () => {
    const input = await fixture();

    const state = resolvePhonemeVisemeEvaluatorState(input.manifestPath);

    expect(state.execution).toBeNull();
    expect(state.result.status).toBe("not-available");
    expect(state.result.blockerCode).toBe("legal-hold");
    expect(state.result.error).toContain("administratorseitig");
  });

  it("rejects a user-writable Python environment before starting the sandbox", async () => {
    const input = await fixture();
    const runtimeRoot = join(input.root, "runtime");
    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await writeFile(join(runtimeRoot, "pyvenv.cfg"), "home = /usr/bin\n");
    await symlink("/usr/bin/python3", join(runtimeRoot, "bin", "python"));

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      join(runtimeRoot, "bin", "python"),
      sealedRunnerPath,
    );

    expect(state.execution).toBeNull();
    expect(state.result.status).toBe("not-available");
    expect(state.result.blockerCode).toBe("runner-unavailable");
    expect(state.result.error).toContain("nicht administrativ versiegelt");
  });

  it("rejects a runner from the user-writable app worktree", async () => {
    const input = await fixture();

    const state = resolvePhonemeVisemeEvaluatorState(
      input.manifestPath,
      input.trustPins,
      sealedPythonExecutable,
      join(appRoot, "scripts", "phoneme_viseme_measurement.py"),
    );

    expect(state.execution).toBeNull();
    expect(state.result.status).toBe("not-available");
    expect(state.result.blockerCode).toBe("runner-unavailable");
    expect(state.result.error).toContain("nicht administrativ versiegelt");
  });
});
