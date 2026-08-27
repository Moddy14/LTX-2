import { randomUUID } from "node:crypto";
import { readSync, renameSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hybridRoot, outputRoot } from "../server/config.js";
import {
  JobManager,
  JobPersistenceHoldError,
  quarantineUnreleasedArtifact,
  readProtectedJsonFile,
  type AtomicSnapshotFileOperations,
  type StudioJob,
} from "../server/jobs.js";
import { OutputLibrary } from "../server/outputs.js";
import {
  outputPublicationPath,
  readValidOutputPublicationAuthority,
  removeOutputPublicationAuthority,
} from "../server/outputPublication.js";
import { bindRunExecutionDecision } from "../server/runProvenance.js";
import { validRequest } from "./fixtures.js";
import { publishCompletedOutputFixture } from "./output-publication-fixture.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function archivedFixture(largeMetadata = false) {
  const stateRoot = await mkdtemp(join(tmpdir(), "ltx-output-authority-"));
  cleanupPaths.push(stateRoot);
  await mkdir(outputRoot, { recursive: true });
  const statePath = join(stateRoot, "jobs.json");
  const outputName = `archive-${randomUUID()}.mp4`;
  const outputPath = join(outputRoot, outputName);
  cleanupPaths.push(outputPath, outputPublicationPath(outputPath), `${outputPath}.ltx-settings.json`);
  const request = validRequest("audio-to-video");
  request.outputName = outputName;
  if (largeMetadata) request.prompt = "P".repeat(12_000);
  const manager = new JobManager(statePath, false);
  const created = manager.create(request, { deferStart: true });
  const runtime = (Reflect.get(manager, "jobs") as Map<string, StudioJob & { startDeferred: boolean }>)
    .get(created.id)!;
  runtime.status = "completed";
  runtime.startedAt = "2026-08-25T10:00:00.000Z";
  runtime.finishedAt = "2026-08-25T10:01:00.000Z";
  runtime.progress = 100;
  runtime.outputUrl = `/api/jobs/${runtime.id}/output`;
  runtime.startDeferred = false;
  runtime.executionClass = undefined;
  runtime.executionDecision = undefined;
  if (largeMetadata) runtime.logs = Array.from({ length: 600 }, () => "L".repeat(4_000));
  await writeFile(outputPath, "archive-authorized-video");
  publishCompletedOutputFixture(outputRoot, runtime);
  const archivePublishedJob = Reflect.get(manager, "archivePublishedJob") as (job: StudioJob) => void;
  archivePublishedJob.call(manager, runtime);
  const changed = Reflect.get(manager, "changed") as () => void;
  changed.call(manager);
  const library = new OutputLibrary(outputRoot);
  library.recordCompleted(manager.outputAuthorityList());
  return {
    manager,
    library,
    runtime,
    statePath,
    archivePath: `${statePath}.output-authority.v1.json`,
    outputName,
    outputPath,
  };
}

describe("durable output authority archive", () => {
  it("stays alive in sticky HOLD when an empty-startup archive rewrite fails before rename", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "ltx-output-authority-startup-hold-"));
    cleanupPaths.push(stateRoot);
    const statePath = join(stateRoot, "missing-jobs.json");
    const archivePath = `${statePath}.output-authority.v1.json`;
    await writeFile(archivePath, "{corrupt-ledger", { mode: 0o600 });

    const seed = new JobManager(join(stateRoot, "operations-seed.json"), false);
    const base = Reflect.get(seed, "jobPersistenceFileOperations") as AtomicSnapshotFileOperations;
    const manager = new JobManager({
      path: statePath,
      fileOperations: {
        ...base,
        rename: (source, target) => {
          if (target === archivePath) throw new Error("synthetic archive pre-rename failure");
          base.rename(source, target);
        },
      },
    }, false);

    expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(() => manager.outputAuthorityList()).toThrow(JobPersistenceHoldError);
    expect(() => manager.create(validRequest(), { deferStart: true })).toThrow(JobPersistenceHoldError);
    expect(await readFile(archivePath, "utf8")).toBe("{corrupt-ledger");
  });

  it("stays alive in sticky HOLD when archive bytes were renamed but directory durability is unprovable", async () => {
    const fixture = await archivedFixture();
    const base = Reflect.get(fixture.manager, "jobPersistenceFileOperations") as AtomicSnapshotFileOperations;
    await rm(fixture.archivePath, { force: true });
    let archiveRenameBecameVisible = false;
    const manager = new JobManager({
      path: fixture.statePath,
      fileOperations: {
        ...base,
        rename: (source, target) => {
          if (target !== fixture.archivePath) {
            base.rename(source, target);
            return;
          }
          base.rename(source, target);
          archiveRenameBecameVisible = true;
          throw new Error("synthetic archive post-rename failure");
        },
        fsync: (descriptor) => {
          if (archiveRenameBecameVisible) {
            throw new Error("synthetic archive directory fsync failure");
          }
          base.fsync(descriptor);
        },
      },
    }, false);

    expect(archiveRenameBecameVisible).toBe(true);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(() => manager.outputAuthorityList()).toThrow(JobPersistenceHoldError);
    expect(() => manager.create(validRequest(), { deferStart: true })).toThrow(JobPersistenceHoldError);
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8"))).toMatchObject({
      schemaVersion: "ltx-studio-output-authority-archive.v1",
      entries: [{ id: fixture.runtime.id, outputName: fixture.outputName }],
    });
  });

  it("keeps a pruned output authoritative across restart without archiving prompts or logs", async () => {
    const fixture = await archivedFixture(true);
    const persisted = JSON.parse(await readFile(fixture.statePath, "utf8")) as Array<Record<string, unknown>>;
    const oldEntry = persisted.find(({ id }) => id === fixture.runtime.id)!;
    expect(oldEntry.outputPublication).toEqual(fixture.runtime.outputPublication);
    expect(fixture.manager.get(fixture.runtime.id)).not.toHaveProperty("outputPublication");
    expect(fixture.manager.list().find(({ id }) => id === fixture.runtime.id))
      .not.toHaveProperty("outputPublication");
    const newer = Array.from({ length: 101 }, (_, index) => {
      const request = structuredClone(fixture.runtime.request);
      request.outputName = `newer-${index}-${randomUUID()}.mp4`;
      return {
        ...structuredClone(oldEntry),
        id: randomUUID(),
        status: "failed",
        createdAt: `2026-08-26T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
        finishedAt: "2026-08-26T23:59:00.000Z",
        outputName: request.outputName,
        request,
        outputPublication: undefined,
      };
    });
    await writeFile(fixture.statePath, JSON.stringify([...newer, oldEntry]));

    const archiveText = await readFile(fixture.archivePath, "utf8");
    expect(archiveText).not.toContain("\"prompt\"");
    expect(archiveText).not.toContain("\"logs\"");
    expect(archiveText).not.toContain("\"request\"");
    expect((await stat(fixture.archivePath)).size).toBeLessThan(16 * 1024);

    const restored = new JobManager(fixture.statePath, false);
    const archived = restored.outputAuthorityList().find(({ id }) => id === fixture.runtime.id);
    expect(restored.list().some(({ id }) => id === fixture.runtime.id)).toBe(false);
    expect(archived).toMatchObject({
      schemaVersion: "ltx-studio-archived-output-authority.v1",
      status: "completed",
      outputName: fixture.outputName,
    });
    const library = new OutputLibrary(outputRoot);
    library.wireJobSource(() => restored.outputAuthorityList());
    expect(library.list(restored.outputAuthorityList()).find(({ name }) => name === fixture.outputName))
      .toMatchObject({ settingsAvailable: true, jobId: fixture.runtime.id });
  });

  it("durably revokes the archive after the marker fence and never resurrects a deleted output", async () => {
    const fixture = await archivedFixture();
    fixture.library.wireJobSource(() => fixture.manager.outputAuthorityList());
    fixture.library.wireAuthorityRevoker((outputName, expectedJobId) => {
      fixture.manager.revokeOutputAuthority(outputName, expectedJobId);
    });

    expect(() => fixture.manager.assertHistoricalOutputReferenceMutationAllowed(
      fixture.runtime.id,
      fixture.outputName,
    )).not.toThrow();

    fixture.library.delete(fixture.outputName, fixture.manager.outputAuthorityList());

    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(access(outputPublicationPath(fixture.outputPath))).rejects.toThrow();
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8")).entries).toEqual([]);
    expect(fixture.library.list(fixture.manager.outputAuthorityList())).toEqual([]);
    expect(() => fixture.manager.assertHistoricalOutputReferenceMutationAllowed(
      fixture.runtime.id,
      fixture.outputName,
    )).toThrow("keine aktuell sichtbare");

    const restored = new JobManager(fixture.statePath, false);
    const restoredLibrary = new OutputLibrary(outputRoot);
    restoredLibrary.wireJobSource(() => restored.outputAuthorityList());
    expect(restoredLibrary.list(restored.outputAuthorityList())).toEqual([]);
    expect(restored.get(fixture.runtime.id)?.status).toBe("failed");
  });

  it("reserves current, archived, orphan-raw and marker-only output names fail-closed", async () => {
    const fixture = await archivedFixture();
    const sameName = structuredClone(fixture.runtime.request);
    expect(() => fixture.manager.create(sameName, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");

    (Reflect.get(fixture.manager, "jobs") as Map<string, StudioJob>).delete(fixture.runtime.id);
    expect(() => fixture.manager.create(sameName, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");

    await writeFile(fixture.statePath, "[]");
    const restored = new JobManager(fixture.statePath, false);
    expect(() => restored.create(sameName, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");

    const emptyState = join(dirname(fixture.statePath), "empty-jobs.json");
    const empty = new JobManager(emptyState, false);
    const orphanRequest = validRequest();
    orphanRequest.outputName = `orphan-${randomUUID()}.mp4`;
    const orphanPath = join(outputRoot, orphanRequest.outputName);
    cleanupPaths.push(orphanPath, outputPublicationPath(orphanPath));
    await writeFile(orphanPath, "unbound raw bytes");
    expect(() => empty.create(orphanRequest, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");
    await rm(orphanPath, { force: true });
    await writeFile(outputPublicationPath(orphanPath), "marker-only", { mode: 0o400 });
    expect(() => empty.create(orphanRequest, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");

    await rm(outputPublicationPath(orphanPath), { force: true });
    const first = empty.create(orphanRequest, { deferStart: true });
    expect(first.status).toBe("queued");
    expect(() => empty.create(orphanRequest, { deferStart: true }))
      .toThrow("bereits durch einen aktiven Job reserviert");
  });

  it("converges fail-closed when deletion stops after the durable marker fence", async () => {
    const fixture = await archivedFixture();
    cleanupPaths.push(join(hybridRoot, fixture.runtime.id));
    fixture.library.wireAuthorityRevoker(() => {
      throw new Error("synthetic crash after marker unlink");
    });

    expect(() => fixture.library.delete(fixture.outputName, fixture.manager.outputAuthorityList()))
      .toThrow("synthetic crash after marker unlink");
    expect(await readFile(fixture.outputPath, "utf8")).toBe("archive-authorized-video");
    await expect(access(outputPublicationPath(fixture.outputPath))).rejects.toThrow();
    expect(() => fixture.manager.assertHistoricalOutputReferenceMutationAllowed(
      fixture.runtime.id,
      fixture.outputName,
    )).toThrow("keine aktuell sichtbare");

    const restored = new JobManager(fixture.statePath, false);
    const library = new OutputLibrary(outputRoot);
    library.wireJobSource(() => restored.outputAuthorityList());
    await expect(access(fixture.outputPath)).rejects.toThrow();
    expect(library.list(restored.outputAuthorityList())).toEqual([]);
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8")).entries).toEqual([]);
  });

  it("never resurrects after a crash between ledger revocation and raw-byte unlink", async () => {
    const fixture = await archivedFixture();
    cleanupPaths.push(join(hybridRoot, fixture.runtime.id));
    removeOutputPublicationAuthority(fixture.outputPath);
    fixture.manager.revokeOutputAuthority(fixture.outputName, fixture.runtime.id);
    expect(await readFile(fixture.outputPath, "utf8")).toBe("archive-authorized-video");
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8")).entries).toEqual([]);

    const restored = new JobManager(fixture.statePath, false);
    const library = new OutputLibrary(outputRoot);
    library.wireJobSource(() => restored.outputAuthorityList());

    await expect(access(fixture.outputPath)).rejects.toThrow();
    expect(library.list(restored.outputAuthorityList())).toEqual([]);
    expect(restored.get(fixture.runtime.id)?.status).toBe("failed");
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8")).entries).toEqual([]);
  });

  it("quarantines marker/raw bytes when the only durable archive is corrupt", async () => {
    const fixture = await archivedFixture();
    await writeFile(fixture.statePath, "[]");
    await writeFile(fixture.archivePath, "{corrupt-ledger");
    const before = new Set(await readdir(hybridRoot).catch(() => []));

    const restored = new JobManager(fixture.statePath, false);

    const after = await readdir(hybridRoot).catch(() => []);
    for (const name of after) if (!before.has(name)) cleanupPaths.push(join(hybridRoot, name));
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(access(outputPublicationPath(fixture.outputPath))).rejects.toThrow();
    expect(restored.outputAuthorityList()).toEqual([]);
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8"))).toEqual({
      schemaVersion: "ltx-studio-output-authority-archive.v1",
      entries: [],
    });
  });

  it("preserves unclaimed raw bytes when marker revocation and quarantine both fail", async () => {
    const fixture = await archivedFixture();
    await writeFile(fixture.statePath, "[]");
    await writeFile(fixture.archivePath, "{corrupt-ledger");
    const markerPath = outputPublicationPath(fixture.outputPath);
    const rawBefore = await readFile(fixture.outputPath);
    const markerBefore = await readFile(markerPath);
    const rawStatsBefore = await stat(fixture.outputPath);
    let markerRemovalAttempts = 0;
    let quarantineAttempts = 0;

    const restored = new JobManager({
      path: fixture.statePath,
      outputAuthorityReconciliationOperations: {
        removePublicationAuthority: (outputPath) => {
          if (outputPath === fixture.outputPath) {
            markerRemovalAttempts += 1;
            throw new Error("synthetic marker revocation failure");
          }
          removeOutputPublicationAuthority(outputPath);
        },
        quarantineUnreleased: (outputPath, quarantineRoot) => {
          if (outputPath === fixture.outputPath) {
            quarantineAttempts += 1;
            throw new Error("synthetic quarantine failure");
          }
          return quarantineUnreleasedArtifact(outputPath, quarantineRoot);
        },
      },
    }, false);

    expect(markerRemovalAttempts).toBe(2);
    expect(quarantineAttempts).toBe(1);
    expect(await readFile(fixture.outputPath)).toEqual(rawBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
    expect(await stat(fixture.outputPath)).toMatchObject({
      dev: rawStatsBefore.dev,
      ino: rawStatsBefore.ino,
      size: rawStatsBefore.size,
      mtimeMs: rawStatsBefore.mtimeMs,
      ctimeMs: rawStatsBefore.ctimeMs,
    });
    // Exercise the strongest residue: marker and raw still form a valid
    // physical pair, but no public or mutation consumer may trust them without
    // the now-empty durable archive/job authority.
    expect(readValidOutputPublicationAuthority(outputRoot, fixture.outputName)).not.toBeNull();
    const authorities = restored.outputAuthorityList();
    expect(authorities).toEqual([]);
    const library = new OutputLibrary(outputRoot);
    library.wireJobSource(() => restored.outputAuthorityList());
    expect(library.readPublishedOutputAuthority(fixture.outputName, authorities)).toBeNull();
    expect(library.openReadableOutput(fixture.outputName, authorities)).toBeNull();
    expect(() => library.delete(fixture.outputName, authorities)).toThrow("Ausgabe nicht gefunden");

    const sameName = structuredClone(fixture.runtime.request);
    expect(() => restored.create(sameName, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");
    expect(await readFile(fixture.outputPath)).toEqual(rawBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
    expect(JSON.parse(await readFile(fixture.archivePath, "utf8"))).toEqual({
      schemaVersion: "ltx-studio-output-authority-archive.v1",
      entries: [],
    });
  });

  it("rejects symlink, pathname-replacement and same-inode ledger races through a held descriptor", async () => {
    const fixture = await archivedFixture();
    const valid = await readFile(fixture.archivePath, "utf8");
    const symlinkTarget = join(dirname(fixture.archivePath), "authority-symlink-target.json");
    const replacement = join(dirname(fixture.archivePath), "authority-replacement.json");
    const replacedOriginal = join(dirname(fixture.archivePath), "authority-replaced-original.json");
    cleanupPaths.push(symlinkTarget, replacement, replacedOriginal);

    await writeFile(symlinkTarget, valid, { mode: 0o600 });
    await rm(fixture.archivePath, { force: true });
    await symlink(symlinkTarget, fixture.archivePath);
    expect(() => readProtectedJsonFile(fixture.archivePath, 128 * 1024 * 1024))
      .toThrow("geschütztes reguläres Ledger");

    await rm(fixture.archivePath, { force: true });
    await writeFile(fixture.archivePath, valid, { mode: 0o600 });
    await writeFile(replacement, valid.replace("output-authority-archive.v1", "output-authority-archive.x1"), { mode: 0o600 });
    let replaced = false;
    expect(() => readProtectedJsonFile(fixture.archivePath, 128 * 1024 * 1024, {
      read: (fd, buffer, offset, length, position) => {
        const count = readSync(fd, buffer, offset, length, position);
        if (!replaced) {
          replaced = true;
          renameSync(fixture.archivePath, replacedOriginal);
          renameSync(replacement, fixture.archivePath);
        }
        return count;
      },
    })).toThrow("verändert oder ersetzt");

    await writeFile(fixture.archivePath, valid, { mode: 0o600 });
    await chmod(fixture.archivePath, 0o600);
    let mutated = false;
    expect(() => readProtectedJsonFile(fixture.archivePath, 128 * 1024 * 1024, {
      read: (fd, buffer, offset, length, position) => {
        const count = readSync(fd, buffer, offset, length, position);
        if (!mutated) {
          mutated = true;
          const changed = valid.replace("ltx-studio-output-authority-archive.v1", "ltx-studio-output-authority-archive.x1");
          expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(valid));
          writeFileSync(fixture.archivePath, changed, { mode: 0o600 });
        }
        return count;
      },
    })).toThrow("verändert oder ersetzt");
  });

  it("rejects rewritten provenance, identity, experiment and project metadata while allowing quality-only edits", async () => {
    const fixture = await archivedFixture();
    (Reflect.get(fixture.manager, "jobs") as Map<string, StudioJob>).delete(fixture.runtime.id);
    const archivedJobs = fixture.manager.outputAuthorityList();
    const quality = fixture.library.setQualityReview(fixture.outputName, {
      scores: {
        lipSync: 7,
        identity: 7,
        mouthNaturalness: 7,
        skinStability: 7,
        motion: 7,
        audio: 7,
      },
      note: "QualityReview is intentionally outside immutable authority metadata.",
    }, archivedJobs);
    expect(quality.qualityReview?.scores.lipSync).toBe(7);

    const sidecarPath = `${fixture.outputPath}.ltx-settings.json`;
    const original = JSON.parse(await readFile(sidecarPath, "utf8"));
    const rewrittenProvenance = structuredClone(original);
    rewrittenProvenance.runProvenance.runtime.kernelRelease = "rewritten-kernel";
    rewrittenProvenance.runProvenance = bindRunExecutionDecision(
      rewrittenProvenance.runProvenance,
      rewrittenProvenance.executionDecision,
    );
    const rewrittenIdentity = structuredClone(original);
    rewrittenIdentity.identityEvidence = {
      schemaVersion: "ltx-studio-identity-evidence.v1",
      status: "not-applicable",
      source: null,
      capturedAt: null,
      verifiedAt: null,
      reason: "forged metadata",
      references: [],
    };
    const rewrittenExperiment = structuredClone(original);
    rewrittenExperiment.experiment = {
      schemaVersion: "ltx-studio-experiment-run.v1",
      experimentId: randomUUID(),
      protocolSha256: "b".repeat(64),
      arm: "baseline",
      kind: "ablation",
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: original.executionDecision.requestSha256,
      requestSha256: original.executionDecision.requestSha256,
      baselineJobId: null,
      baselineOutputName: fixture.outputName,
    };
    const rewrittenProject = structuredClone(original);
    rewrittenProject.project = {
      schemaVersion: "ltx-studio-project-run.v1",
      projectId: randomUUID(),
      projectRevision: 1,
      projectRevisionSha256: "a".repeat(64),
      shotId: randomUUID(),
      requestRevisionId: randomUUID(),
      requestSha256: original.executionDecision.requestSha256,
      continuity: null,
    };
    for (const rewritten of [
      rewrittenProvenance,
      rewrittenIdentity,
      rewrittenExperiment,
      rewrittenProject,
    ]) {
      await writeFile(sidecarPath, JSON.stringify(rewritten));
      expect(fixture.library.list(archivedJobs).find(({ name }) => name === fixture.outputName))
        .toMatchObject({ settingsAvailable: false, request: null, provenance: null, project: null });
    }
  });
});
