import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, readFileSync, writeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { outputRoot } from "../server/config.js";
import {
  JobConflictError,
  JobManager,
  JobPersistenceHoldError,
} from "../server/jobs.js";
import {
  OutputLibrary,
  OutputQualityError,
  OutputSnapshotMaterializationError,
} from "../server/outputs.js";
import { createVerifiedLegacyOutputSnapshot } from "../server/legacyOutput.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { migrateGenerationRequest, type PipelineMode } from "../shared/pipelines.js";
import { validRequest } from "./fixtures.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function legacyCompletedFixture(mode: PipelineMode = "image-audio-to-video") {
  const stateRoot = await mkdtemp(join(tmpdir(), "ltx-legacy-upgrade-"));
  cleanupPaths.push(stateRoot);
  await mkdir(outputRoot, { recursive: true });
  const id = randomUUID();
  const dgxJobId = `dgx-job-20260827-120000-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
  const request = validRequest(mode);
  request.outputName = `legacy-upgrade-${id}.mp4`;
  const outputPath = join(outputRoot, request.outputName);
  const settingsPath = `${outputPath}.ltx-settings.json`;
  cleanupPaths.push(outputPath, settingsPath);
  const bytes = Buffer.from(`preserved legacy output ${id}\n`);
  await writeFile(outputPath, bytes);
  const outputStats = await stat(outputPath);
  const finishedAt = "2026-08-10T14:18:44.065Z";
  const sidecar = {
    schemaVersion: "ltx-studio-output.v6",
    outputName: request.outputName,
    jobId: id,
    completedAt: finishedAt,
    sizeBytes: outputStats.size,
    modifiedAtMs: outputStats.mtimeMs,
    changedAtMs: outputStats.ctimeMs,
    fileId: String(outputStats.ino),
    request,
    qualityReview: null,
    identityEvidence: null,
    runProvenance: null,
    experiment: null,
  };
  await writeFile(settingsPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const path = join(stateRoot, "jobs.json");
  const job = {
    id,
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: `/api/jobs/${id}/output`,
    createdAt: "2026-08-10T13:55:04.027Z",
    startedAt: "2026-08-10T14:09:35.260Z",
    finishedAt,
    progress: 100,
    error: null,
    logs: ["Video erfolgreich erzeugt."],
    command: "historical command",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 548_805,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId,
    identityEvidence: null,
    runProvenance: null,
  };
  await writeFile(path, `${JSON.stringify([job], null, 2)}\n`);
  return { path, id, dgxJobId, request, outputPath, settingsPath, bytes };
}

it("imports a v1.0 completed output once as read-only legacy history without inventing authority", async () => {
  const fixture = await legacyCompletedFixture();
  const manager = new JobManager(fixture.path, false);

  expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
  expect(manager.get(fixture.id)).toMatchObject({
    status: "completed",
    outputUrl: `/api/jobs/${fixture.id}/output`,
    dgxJobId: null,
    historyStatus: "legacy-unattested",
    historicalDgxJobId: fixture.dgxJobId,
    executionClass: undefined,
    executionDecision: undefined,
  });
  expect(manager.get(fixture.id)?.logs.at(-1)).toContain("keine ExecutionDecision");

  const persisted = JSON.parse(await readFile(fixture.path, "utf8"))[0];
  expect(persisted).toMatchObject({
    dgxJobId: null,
    legacyHistory: {
      schemaVersion: "ltx-studio-legacy-terminal-history.v1",
      trust: "legacy-unattested",
      historicalDgxJobId: fixture.dgxJobId,
      artifactUnavailableReason: null,
      artifact: {
        output: { sha256: createHash("sha256").update(fixture.bytes).digest("hex") },
        settings: { path: fixture.settingsPath },
      },
    },
  });
  expect(persisted).not.toHaveProperty("dgxLeaseReceipt");
  expect(persisted).not.toHaveProperty("dgxTerminalReceipt");
  expect(persisted).not.toHaveProperty("executionDecision");
  expect(persisted).not.toHaveProperty("outputPublication");

  const library = new OutputLibrary(outputRoot);
  const authorities = manager.outputAuthorityList();
  expect(library.readPublishedOutputAuthority(fixture.request.outputName, authorities)).toBeNull();
  expect(library.openPublishedOutput(fixture.request.outputName, authorities)).toBeNull();
  expect(library.reusableLtxBaseCandidates(authorities)).toEqual([]);
  expect(() => library.resolveAnalysisTarget(fixture.request.outputName, authorities))
    .toThrow(OutputQualityError);
  expect(library.list(authorities)).toContainEqual(expect.objectContaining({
    name: fixture.request.outputName,
    trustStatus: "legacy-unattested",
    settingsAvailable: false,
    analysis: null,
    provenance: null,
    experiment: null,
  }));

  const readable = library.openReadableOutput(fixture.request.outputName, authorities, fixture.id);
  expect(readable).not.toBeNull();
  try {
    expect(readFileSync(readable!.fd)).toEqual(fixture.bytes);
  } finally {
    readable!.release();
  }
  const stateBeforeMutationAttempts = await readFile(fixture.path);
  const outputBeforeMutationAttempts = await readFile(fixture.outputPath);
  const settingsBeforeMutationAttempts = await readFile(fixture.settingsPath);
  const outputNamesBeforeMutationAttempts = await readdir(outputRoot);
  expect(() => manager.assertJobMutationAllowed(fixture.id)).toThrow(JobConflictError);
  expect(() => manager.assertOutputMutationAllowed(fixture.request.outputName)).toThrow(JobConflictError);
  expect(() => manager.assertHistoricalOutputReferenceMutationAllowed(
    fixture.id,
    fixture.request.outputName,
  )).toThrow(JobConflictError);
  expect(() => manager.experimentRetryAuthority(fixture.id)).toThrow(JobConflictError);
  expect(() => manager.assertJobMutationAllowed(randomUUID())).toThrow(JobConflictError);
  expect(() => manager.experimentRetryAuthority(randomUUID())).toThrow(JobConflictError);
  expect(() => manager.setFavorite(fixture.id, true)).toThrow(JobConflictError);
  expect(() => manager.cancel(fixture.id)).toThrow(JobConflictError);
  expect(() => manager.rerun(fixture.id, "exact")).toThrow(JobConflictError);
  expect(() => manager.remove(fixture.id)).toThrow(JobConflictError);
  expect(() => library.delete(fixture.request.outputName, authorities)).toThrow();
  expect(() => library.setQualityReview(fixture.request.outputName, {
    scores: {
      lipSync: 10,
      identity: 10,
      mouthNaturalness: 10,
      skinStability: 10,
      motion: 10,
      audio: 10,
    },
    note: "Dieser Schreibversuch muss vollständig verworfen werden.",
  }, authorities)).toThrow(OutputQualityError);
  await expect(library.materializePublishedOutputs(
    [fixture.request.outputName],
    authorities,
  )).rejects.toThrow(OutputQualityError);
  expect(manager.get(fixture.id)?.favorite).toBe(false);
  expect(await readFile(fixture.path)).toEqual(stateBeforeMutationAttempts);
  expect(await readFile(fixture.outputPath)).toEqual(outputBeforeMutationAttempts);
  expect(await readFile(fixture.settingsPath)).toEqual(settingsBeforeMutationAttempts);
  expect(await readdir(outputRoot)).toEqual(outputNamesBeforeMutationAttempts);

  const once = await readFile(fixture.path, "utf8");
  const restoredAgain = new JobManager(fixture.path, false);
  expect(restoredAgain.get(fixture.id)?.historyStatus).toBe("legacy-unattested");
  expect(await readFile(fixture.path, "utf8")).toBe(once);
  expect(await readFile(fixture.outputPath)).toEqual(fixture.bytes);
});

it("imports a byte-identical restore before the first upgrade despite inode and mtime drift", async () => {
  const fixture = await legacyCompletedFixture();
  const originalOutputStats = await stat(fixture.outputPath);
  const originalSettingsStats = await stat(fixture.settingsPath);
  const settingsBytes = await readFile(fixture.settingsPath);
  const declaredSettings = JSON.parse(settingsBytes.toString("utf8")) as {
    fileId: string;
    modifiedAtMs: number;
    changedAtMs: number;
  };
  const restoredOutputPath = `${fixture.outputPath}.pre-import-restore`;
  const restoredSettingsPath = `${fixture.settingsPath}.pre-import-restore`;
  cleanupPaths.push(restoredOutputPath, restoredSettingsPath);
  await writeFile(restoredOutputPath, fixture.bytes);
  await writeFile(restoredSettingsPath, settingsBytes);
  const restoredMtime = new Date("2025-01-02T03:04:05.000Z");
  await utimes(restoredOutputPath, restoredMtime, restoredMtime);
  await rename(restoredOutputPath, fixture.outputPath);
  await rename(restoredSettingsPath, fixture.settingsPath);

  const restoredOutputStats = await stat(fixture.outputPath);
  const restoredSettingsStats = await stat(fixture.settingsPath);
  expect(String(restoredOutputStats.ino)).not.toBe(String(originalOutputStats.ino));
  expect(String(restoredSettingsStats.ino)).not.toBe(String(originalSettingsStats.ino));
  expect(String(restoredOutputStats.ino)).not.toBe(declaredSettings.fileId);
  expect(Math.abs(restoredOutputStats.mtimeMs - declaredSettings.modifiedAtMs)).toBeGreaterThan(1);

  const manager = new JobManager(fixture.path, false);
  expect(manager.get(fixture.id)).toMatchObject({
    status: "completed",
    outputUrl: `/api/jobs/${fixture.id}/output`,
    historyStatus: "legacy-unattested",
    executionDecision: undefined,
  });
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8"));
  expect(persisted.legacyHistory).toMatchObject({
    artifactUnavailableReason: null,
    artifact: {
      output: {
        sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
        revision: { fileId: String(restoredOutputStats.ino) },
      },
      settings: {
        sha256: createHash("sha256").update(settingsBytes).digest("hex"),
        revision: { fileId: String(restoredSettingsStats.ino) },
      },
    },
  });
  expect(await readFile(fixture.outputPath)).toEqual(fixture.bytes);
  expect(await readFile(fixture.settingsPath)).toEqual(settingsBytes);
});

it("accepts only the known one-way default additions and ID-LoRA strength rename", async () => {
  const fixture = await legacyCompletedFixture();
  const jobs = JSON.parse(await readFile(fixture.path, "utf8"));
  const sidecar = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
  jobs[0].request.postprocess.lipForcing = { enabled: false, decoder: "wan-vae" };
  sidecar.request = structuredClone(jobs[0].request);
  delete sidecar.request.icLora.profile;
  delete sidecar.request.icLora.hdrTextEmbeddingsPath;
  delete sidecar.request.icLora.hdrHighQuality;
  sidecar.request.idLora.stage2ImageStrength = sidecar.request.idLora.stage1ImageStrength;
  delete sidecar.request.idLora.stage1ImageStrength;
  delete sidecar.request.lipDub.pipelineProfile;
  delete sidecar.request.postprocess.latentSync;
  delete sidecar.request.postprocess.museTalk;
  delete sidecar.request.postprocess.lipForcing;
  expect(canonicalJson(sidecar.request)).not.toBe(canonicalJson(jobs[0].request));
  expect(canonicalJson(migrateGenerationRequest(structuredClone(sidecar.request))))
    .toBe(canonicalJson(migrateGenerationRequest(structuredClone(jobs[0].request))));
  await writeFile(fixture.path, `${JSON.stringify(jobs, null, 2)}\n`);
  await writeFile(fixture.settingsPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  const manager = new JobManager(fixture.path, false);
  expect(manager.get(fixture.id)).toMatchObject({
    status: "completed",
    outputUrl: `/api/jobs/${fixture.id}/output`,
    historyStatus: "legacy-unattested",
    executionDecision: undefined,
  });
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8"));
  expect(persisted.legacyHistory).toMatchObject({
    artifactUnavailableReason: null,
    artifact: { output: { path: fixture.outputPath } },
  });
});

it("accepts the exact inert parent defaults missing from the oldest LipDub sidecars", async () => {
  const fixture = await legacyCompletedFixture("lipdub");
  const jobs = JSON.parse(await readFile(fixture.path, "utf8"));
  const sidecar = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
  jobs[0].request.models.gemmaLora = { path: "", strength: 1 };
  jobs[0].request.lipDub.pipelineProfile = "native-distilled";
  jobs[0].request.postprocess.lipForcing = { enabled: false, decoder: "wan-vae" };
  sidecar.request = structuredClone(jobs[0].request);
  for (const field of [
    "profile", "controlType", "lora", "mogeModelPath", "hdrTextEmbeddingsPath", "hdrHighQuality",
  ]) delete sidecar.request.icLora[field];
  delete sidecar.request.idLora;
  delete sidecar.request.lipDub.pipelineProfile;
  delete sidecar.request.models.gemmaLora;
  delete sidecar.request.postprocess.latentSync;
  delete sidecar.request.postprocess.museTalk;
  delete sidecar.request.postprocess.lipForcing;
  expect(canonicalJson(sidecar.request)).not.toBe(canonicalJson(jobs[0].request));
  expect(canonicalJson(migrateGenerationRequest(structuredClone(sidecar.request))))
    .toBe(canonicalJson(migrateGenerationRequest(structuredClone(jobs[0].request))));
  await writeFile(fixture.path, `${JSON.stringify(jobs, null, 2)}\n`);
  await writeFile(fixture.settingsPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  const manager = new JobManager(fixture.path, false);
  expect(manager.get(fixture.id)).toMatchObject({
    outputUrl: `/api/jobs/${fixture.id}/output`,
    historyStatus: "legacy-unattested",
    executionDecision: undefined,
  });
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8"));
  expect(persisted.legacyHistory.artifactUnavailableReason).toBeNull();
  expect(persisted.legacyHistory.artifact).not.toBeNull();
});

it("does not fill a missing legacy field from an explicit non-default job value", async () => {
  const fixture = await legacyCompletedFixture();
  const jobs = JSON.parse(await readFile(fixture.path, "utf8"));
  const sidecarBytes = await readFile(fixture.settingsPath);
  const sidecar = JSON.parse(sidecarBytes.toString("utf8"));
  jobs[0].request.icLora.hdrHighQuality = true;
  delete sidecar.request.icLora.hdrHighQuality;
  await writeFile(fixture.path, `${JSON.stringify(jobs, null, 2)}\n`);

  const manager = new JobManager(fixture.path, false);
  expect(manager.get(fixture.id)).toMatchObject({
    outputUrl: null,
    historyStatus: "legacy-unattested",
  });
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8"));
  expect(persisted.legacyHistory).toMatchObject({
    artifact: null,
    artifactUnavailableReason: "legacy-sidecar-mismatch",
  });
  expect(await readFile(fixture.settingsPath)).toEqual(sidecarBytes);
});

it("rejects raw job and sidecar requests that only converge after migration", async () => {
  const fixture = await legacyCompletedFixture();
  const jobs = JSON.parse(await readFile(fixture.path, "utf8"));
  const sidecarBytes = await readFile(fixture.settingsPath);
  const sidecar = JSON.parse(sidecarBytes.toString("utf8"));
  delete jobs[0].request.textToAudio;
  const migratedJobRequest = migrateGenerationRequest(structuredClone(jobs[0].request));
  const migratedSidecarRequest = migrateGenerationRequest(structuredClone(sidecar.request));
  expect(migratedJobRequest).not.toBeNull();
  expect(canonicalJson(migratedJobRequest)).toBe(canonicalJson(migratedSidecarRequest));
  expect(canonicalJson(jobs[0].request)).not.toBe(canonicalJson(sidecar.request));
  await writeFile(fixture.path, `${JSON.stringify(jobs, null, 2)}\n`);

  const manager = new JobManager(fixture.path, false);
  expect(manager.get(fixture.id)).toMatchObject({
    status: "completed",
    outputUrl: null,
    historyStatus: "legacy-unattested",
    executionDecision: undefined,
  });
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8"));
  expect(persisted.legacyHistory).toMatchObject({
    artifact: null,
    artifactUnavailableReason: "legacy-sidecar-mismatch",
  });
  expect(await readFile(fixture.outputPath)).toEqual(fixture.bytes);
  expect(await readFile(fixture.settingsPath)).toEqual(sidecarBytes);
});

it("fails a detectably corrupted pre-import medium closed without changing its bytes", async () => {
  const fixture = await legacyCompletedFixture();
  const corrupted = Buffer.concat([fixture.bytes, Buffer.from("corrupt")]);
  await writeFile(fixture.outputPath, corrupted);

  const manager = new JobManager(fixture.path, false);
  expect(manager.get(fixture.id)).toMatchObject({
    status: "completed",
    outputUrl: null,
    historyStatus: "legacy-unattested",
  });
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8"));
  expect(persisted.legacyHistory).toMatchObject({
    artifact: null,
    artifactUnavailableReason: "legacy-sidecar-mismatch",
  });
  expect(await readFile(fixture.outputPath)).toEqual(corrupted);
});

it("closes both verified legacy sources when anonymous allocation fails and leaves no named snapshot", async () => {
  const fixture = await legacyCompletedFixture();
  const manager = new JobManager(fixture.path, false);
  const authority = manager.outputAuthorityList().find(({ id }) => id === fixture.id);
  if (!authority || !("legacyHistory" in authority) || !authority.legacyHistory) {
    throw new Error("fixture requires legacy history");
  }
  const descriptorsBefore = (await readdir("/proc/self/fd")).length;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect(createVerifiedLegacyOutputSnapshot(authority.legacyHistory, {
      openAnonymousSnapshot: () => {
        throw new Error("synthetic anonymous allocation failure");
      },
    })).toBeNull();
  }
  expect((await readdir("/proc/self/fd")).length).toBe(descriptorsBefore);

  const beforeNames = await readdir(outputRoot);
  const snapshot = createVerifiedLegacyOutputSnapshot(authority.legacyHistory);
  expect(snapshot).not.toBeNull();
  if (snapshot) closeSync(snapshot.fd);
  const afterNames = await readdir(outputRoot);
  expect(afterNames).toEqual(beforeNames);
  expect(afterNames.some((name) => name.startsWith(".ltx-legacy-readable-"))).toBe(false);
});

it("reports legacy snapshot storage failure as a redacted retryable API error", async () => {
  const fixture = await legacyCompletedFixture();
  const manager = new JobManager(fixture.path, false);
  const storageFailure = Object.assign(
    new Error(`EDQUOT at secret legacy path ${fixture.outputPath}`),
    { code: "EDQUOT" },
  );
  const library = new OutputLibrary(outputRoot, {
    openAnonymousReadableSnapshot: () => { throw storageFailure; },
  });

  let exposed: unknown;
  try {
    library.openReadableOutput(
      fixture.request.outputName,
      manager.outputAuthorityList(),
      fixture.id,
    );
  } catch (error) {
    exposed = error;
  }
  expect(exposed).toBeInstanceOf(OutputSnapshotMaterializationError);
  expect(exposed).toMatchObject({
    statusCode: 503,
    retryAfterSeconds: 1,
    cause: storageFailure,
  });
  expect((exposed as Error).message).not.toContain(fixture.outputPath);

  await writeFile(fixture.outputPath, Buffer.from("locally changed historical bytes\n"));
  expect(library.openReadableOutput(
    fixture.request.outputName,
    manager.outputAuthorityList(),
    fixture.id,
  )).toBeNull();
});

it("fails a changed legacy output closed without deleting or quarantining its bytes", async () => {
  const fixture = await legacyCompletedFixture();
  const first = new JobManager(fixture.path, false);
  expect(first.get(fixture.id)?.outputUrl).not.toBeNull();
  const changed = Buffer.from("locally changed historical bytes\n");
  await writeFile(fixture.outputPath, changed);

  const restored = new JobManager(fixture.path, false);
  expect(restored.persistenceHealth().status).toBe("ok");
  expect(restored.get(fixture.id)).toMatchObject({
    status: "completed",
    outputUrl: null,
    historyStatus: "legacy-unattested",
  });
  expect(await readFile(fixture.outputPath)).toEqual(changed);
  expect(new OutputLibrary(outputRoot).openReadableOutput(
    fixture.request.outputName,
    restored.outputAuthorityList(),
  )).toBeNull();
});

it("keeps byte-identical Borg-restored media playable without trusting the old inode revision", async () => {
  const fixture = await legacyCompletedFixture();
  const first = new JobManager(fixture.path, false);
  expect(first.get(fixture.id)?.outputUrl).not.toBeNull();
  const oldOutputStats = await stat(fixture.outputPath);
  const oldSettingsStats = await stat(fixture.settingsPath);
  const settingsBytes = await readFile(fixture.settingsPath);

  const restoredOutputPath = `${fixture.outputPath}.borg-restore`;
  const restoredSettingsPath = `${fixture.settingsPath}.borg-restore`;
  cleanupPaths.push(restoredOutputPath, restoredSettingsPath);
  await writeFile(restoredOutputPath, fixture.bytes);
  await writeFile(restoredSettingsPath, settingsBytes);
  await rename(restoredOutputPath, fixture.outputPath);
  await rename(restoredSettingsPath, fixture.settingsPath);
  const restoredOutputStats = await stat(fixture.outputPath);
  const restoredSettingsStats = await stat(fixture.settingsPath);
  expect(String(restoredOutputStats.ino)).not.toBe(String(oldOutputStats.ino));
  expect(String(restoredSettingsStats.ino)).not.toBe(String(oldSettingsStats.ino));

  const restarted = new JobManager(fixture.path, false);
  expect(restarted.get(fixture.id)?.outputUrl).toBe(`/api/jobs/${fixture.id}/output`);
  const readable = new OutputLibrary(outputRoot).openReadableOutput(
    fixture.request.outputName,
    restarted.outputAuthorityList(),
    fixture.id,
  );
  expect(readable).not.toBeNull();
  try {
    expect(readFileSync(readable!.fd)).toEqual(fixture.bytes);
  } finally {
    readable!.release();
  }
});

it("treats the migrated-request digest as import-time audit evidence, not future migration authority", async () => {
  const fixture = await legacyCompletedFixture();
  new JobManager(fixture.path, false);
  const [persisted] = JSON.parse(await readFile(fixture.path, "utf8")) as Array<{
    legacyHistory: { artifact: { migratedRequestSha256: string } };
  }>;
  // Models a valid receipt written by an older release whose migration added
  // different defaults. Raw request, sidecar and media bindings stay exact.
  persisted.legacyHistory.artifact.migratedRequestSha256 = "f".repeat(64);
  await writeFile(fixture.path, `${JSON.stringify([persisted], null, 2)}\n`);

  const restarted = new JobManager(fixture.path, false);
  expect(restarted.persistenceHealth().status).toBe("ok");
  expect(restarted.get(fixture.id)?.outputUrl).toBe(`/api/jobs/${fixture.id}/output`);
  const readable = new OutputLibrary(outputRoot).openReadableOutput(
    fixture.request.outputName,
    restarted.outputAuthorityList(),
  );
  expect(readable).not.toBeNull();
  readable?.release();
});

it("reuses one read-only anonymous legacy snapshot across Range-style opens and revokes it on source drift", async () => {
  const fixture = await legacyCompletedFixture();
  const manager = new JobManager(fixture.path, false);
  const library = new OutputLibrary(outputRoot);
  const authorities = manager.outputAuthorityList();
  const first = library.openReadableOutput(fixture.request.outputName, authorities, fixture.id);
  const second = library.openReadableOutput(fixture.request.outputName, authorities, fixture.id);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  try {
    const firstStats = fstatSync(first!.fd);
    const secondStats = fstatSync(second!.fd);
    expect(first!.fd).not.toBe(second!.fd);
    expect({ dev: firstStats.dev, ino: firstStats.ino, nlink: firstStats.nlink, mode: firstStats.mode & 0o777 })
      .toEqual({ dev: secondStats.dev, ino: secondStats.ino, nlink: 0, mode: 0o400 });
    expect(readFileSync(first!.fd)).toEqual(fixture.bytes);
    expect(readFileSync(second!.fd)).toEqual(fixture.bytes);
    expect(() => writeSync(first!.fd, Buffer.from("x"), 0, 1, 0)).toThrow();
  } finally {
    first?.release();
    second?.release();
  }

  const originalSettings = await readFile(fixture.settingsPath);
  const driftedSettings = Buffer.from(originalSettings);
  driftedSettings[0] = driftedSettings[0] === 0x7b ? 0x5b : 0x7b;
  await writeFile(fixture.settingsPath, driftedSettings);
  expect(library.openReadableOutput(fixture.request.outputName, authorities, fixture.id)).toBeNull();
  await writeFile(fixture.settingsPath, originalSettings);
  const rebound = library.openReadableOutput(fixture.request.outputName, authorities, fixture.id);
  expect(rebound).not.toBeNull();
  rebound?.release();

  const drifted = Buffer.from(fixture.bytes);
  drifted[0] = drifted[0] === 0x70 ? 0x71 : 0x70;
  await writeFile(fixture.outputPath, drifted);
  expect(library.openReadableOutput(fixture.request.outputName, authorities, fixture.id)).toBeNull();
  expect(await readFile(fixture.outputPath)).toEqual(drifted);
});

it("retains read-only legacy playback beyond the executable job history window and across restart", async () => {
  const fixture = await legacyCompletedFixture();
  const manager = new JobManager(fixture.path, false);

  // MAX_JOBS is intentionally an internal implementation detail. More than
  // the current bounded window proves both live trim and restart retention
  // without making the test depend on the exact production constant.
  for (let index = 0; index < 110; index += 1) {
    const request = validRequest("one-stage");
    request.outputName = `post-upgrade-${fixture.id}-${index}.mp4`;
    const created = manager.create(request);
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
  }

  const retained = manager.get(fixture.id);
  expect(retained).toMatchObject({
    status: "completed",
    historyStatus: "legacy-unattested",
    dgxJobId: null,
    executionClass: undefined,
    executionDecision: undefined,
  });
  expect(() => manager.rerun(fixture.id, "exact")).toThrow(JobConflictError);
  expect(() => manager.remove(fixture.id)).toThrow(JobConflictError);

  const restarted = new JobManager(fixture.path, false);
  expect(restarted.get(fixture.id)).toMatchObject({
    status: "completed",
    historyStatus: "legacy-unattested",
    dgxJobId: null,
    executionClass: undefined,
    executionDecision: undefined,
  });
  const authorities = restarted.outputAuthorityList();
  const library = new OutputLibrary(outputRoot);
  expect(library.readPublishedOutputAuthority(fixture.request.outputName, authorities)).toBeNull();
  expect(library.openPublishedOutput(fixture.request.outputName, authorities)).toBeNull();
  const readable = library.openReadableOutput(fixture.request.outputName, authorities, fixture.id);
  expect(readable).not.toBeNull();
  try {
    expect(readFileSync(readable!.fd)).toEqual(fixture.bytes);
  } finally {
    readable!.release();
  }
});

it("imports a legacy playback entry even when it starts beyond the bounded job window", async () => {
  const fixture = await legacyCompletedFixture();
  const [completed] = JSON.parse(await readFile(fixture.path, "utf8")) as Record<string, unknown>[];
  const olderTerminalHistory = Array.from({ length: 110 }, (_, index) => {
    const request = validRequest("one-stage");
    request.outputName = `legacy-terminal-${fixture.id}-${index}.mp4`;
    const id = randomUUID();
    return {
      ...completed,
      id,
      status: "failed",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date(Date.parse("2026-08-11T00:00:00.000Z") + index * 1_000).toISOString(),
      startedAt: null,
      finishedAt: new Date(Date.parse("2026-08-11T00:00:01.000Z") + index * 1_000).toISOString(),
      progress: 0,
      error: "historical failure",
      request,
      runtimeMs: null,
      dgxJobId: null,
    };
  });
  // Persisted v1 snapshots are newest-first. Put the completed playback entry
  // behind more than the normal executable history window.
  await writeFile(fixture.path, `${JSON.stringify([...olderTerminalHistory, completed], null, 2)}\n`);

  const manager = new JobManager(fixture.path, false);
  const retainedFailureId = olderTerminalHistory[0]!.id as string;
  expect(manager.get(retainedFailureId)).toMatchObject({
    status: "failed",
    historyStatus: "legacy-unattested",
  });
  expect(() => manager.assertJobMutationAllowed(retainedFailureId)).toThrow(JobConflictError);
  expect(() => manager.experimentRetryAuthority(retainedFailureId)).toThrow(JobConflictError);
  expect(manager.get(fixture.id)?.historyStatus).toBe("legacy-unattested");
  const authorities = manager.outputAuthorityList();
  const library = new OutputLibrary(outputRoot);
  const readable = library.openReadableOutput(fixture.request.outputName, authorities, fixture.id);
  expect(readable).not.toBeNull();
  try {
    expect(readFileSync(readable!.fd)).toEqual(fixture.bytes);
  } finally {
    readable!.release();
  }
  expect(manager.get(fixture.id)).toMatchObject({
    dgxJobId: null,
    executionClass: undefined,
    executionDecision: undefined,
  });
  const restarted = new JobManager(fixture.path, false);
  expect(restarted.get(retainedFailureId)).toMatchObject({
    status: "failed",
    historyStatus: "legacy-unattested",
  });
  expect(() => restarted.experimentRetryAuthority(retainedFailureId)).toThrow(JobConflictError);
});

it("keeps an active markerless legacy DGX claim in startup HOLD and performs no queue mutation", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "ltx-active-legacy-hold-"));
  cleanupPaths.push(stateRoot);
  const path = join(stateRoot, "jobs.json");
  const request = validRequest();
  const id = randomUUID();
  await writeFile(path, JSON.stringify([{
    id,
    status: "running",
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: 20,
    error: null,
    logs: [],
    command: "legacy command",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: null,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: `dgx-job-20260827-120000-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`,
    identityEvidence: null,
    runProvenance: null,
  }]));
  const read = vi.fn();
  const transition = vi.fn();
  const submit = vi.fn();
  const manager = new JobManager(
    path,
    true,
    null,
    undefined,
    { read, transition },
    null,
    { submit },
  );

  expect(manager.persistenceHealth().status).toBe("hold");
  expect(() => manager.outputAuthorityList()).toThrow(JobPersistenceHoldError);
  expect(read).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
