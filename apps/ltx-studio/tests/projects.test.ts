import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectConflictError,
  ProjectStore,
  projectValueSha256,
} from "../server/projectStore.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];
const actorId = "studio-operator-01";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-projects-"));
  roots.push(root);
  return root;
}

function outputEvidence(
  requestRevisionId: string,
  requestSha256: string,
  recordedAt: string,
) {
  return {
    id: randomUUID(),
    requestRevisionId,
    requestSha256,
    jobId: randomUUID(),
    outputName: `project-shot-${randomUUID().slice(0, 8)}.mp4`,
    sizeBytes: 1_024,
    changedAt: recordedAt,
    fileId: "123456",
    provenanceFingerprint: "a".repeat(64),
    settingsSidecarSha256: "b".repeat(64),
    exportSha256: "c".repeat(64),
    recordedAt,
  };
}

describe("persistent project history", () => {
  it("preserves shot, continuity, retake, output and approval history in a hash chain", async () => {
    const store = new ProjectStore(await projectRoot());
    const created = store.create({
      title: "Kampagne Wien",
      description: "Drei verbundene Einstellungen",
      actorId,
    }, "2026-08-11T18:00:00.000Z");
    const firstRequest = validRequest("audio-to-video");
    firstRequest.outputName = "wien-shot-01.mp4";
    const firstShotRevision = store.addShot(created.projectId, {
      expectedRevision: 1,
      title: "Totale",
      request: firstRequest,
      continuity: null,
      actorId,
    }, "2026-08-11T18:01:00.000Z");
    const firstShot = firstShotRevision.project.shots[0];
    expect(firstShot).toBeDefined();
    const firstRequestRevision = firstShot?.requestRevisions[0];
    expect(firstRequestRevision?.requestSha256).toBe(projectValueSha256(firstRequest));

    const firstOutput = outputEvidence(
      firstRequestRevision?.id ?? "",
      firstRequestRevision?.requestSha256 ?? "",
      "2026-08-11T18:02:00.000Z",
    );
    const rendered = store.recordOutput(created.projectId, {
      expectedRevision: 2,
      shotId: firstShot?.id ?? "",
      evidence: firstOutput,
      actorId,
    }, firstOutput.recordedAt);
    const approved = store.approveOutput(created.projectId, {
      expectedRevision: 3,
      shotId: firstShot?.id ?? "",
      outputId: firstOutput.id,
      actorId,
    }, "2026-08-11T18:03:00.000Z");
    expect(rendered.project.shots[0]?.status).toBe("rendered");
    expect(approved.project.shots[0]?.status).toBe("approved");

    const secondRequest = validRequest("two-stage");
    secondRequest.outputName = "wien-shot-02.mp4";
    const chained = store.addShot(created.projectId, {
      expectedRevision: 4,
      title: "Nahaufnahme",
      request: secondRequest,
      continuity: {
        predecessorShotId: firstShot?.id ?? "",
        referenceOutputId: firstOutput.id,
      },
      actorId,
    }, "2026-08-11T18:04:00.000Z");
    const secondShot = chained.project.shots[1];
    expect(secondShot?.continuity?.referenceOutputId).toBe(firstOutput.id);

    const retakeRequest = validRequest("retake");
    retakeRequest.outputName = "wien-shot-02-retake.mp4";
    retakeRequest.retake.videoPath = `/outputs/${firstOutput.outputName}`;
    retakeRequest.retake.videoName = firstOutput.outputName;
    const revised = store.reviseShot(created.projectId, {
      expectedRevision: 5,
      shotId: secondShot?.id ?? "",
      request: retakeRequest,
      reason: "retake",
      sourceOutputId: firstOutput.id,
      actorId,
    }, "2026-08-11T18:05:00.000Z");
    expect(revised.project.shots[1]?.requestRevisions).toHaveLength(2);
    expect(revised.project.shots[1]?.requestRevisions[1]?.sourceOutputId).toBe(firstOutput.id);

    const history = store.history(created.projectId);
    expect(history).toHaveLength(6);
    history.slice(1).forEach((revision, index) => {
      expect(revision.revision).toBe(index + 2);
      expect(revision.previousRevisionSha256).toBe(projectValueSha256(history[index]));
    });
    expect(store.listAvailable()).toEqual({ projects: [revised], warnings: [] });

    const archived = store.archive(created.projectId, {
      expectedRevision: 6,
      actorId,
    }, "2026-08-11T18:06:00.000Z");
    expect(archived.project.status).toBe("archived");
    expect(() => store.addShot(created.projectId, {
      expectedRevision: 7,
      title: "Nicht zulässig",
      request: firstRequest,
      continuity: null,
      actorId,
    })).toThrow("archiviertes Projekt");
  });

  it("rejects stale writes, unknown continuity and unbound output evidence", async () => {
    const store = new ProjectStore(await projectRoot());
    const created = store.create({ title: "Fail closed", description: "", actorId });
    const request = validRequest("audio-to-video");
    const shotRevision = store.addShot(created.projectId, {
      expectedRevision: 1,
      title: "Shot 1",
      request,
      continuity: null,
      actorId,
    });
    const shot = shotRevision.project.shots[0];
    const requestRevision = shot?.requestRevisions[0];

    expect(() => store.addShot(created.projectId, {
      expectedRevision: 1,
      title: "Stale",
      request,
      continuity: null,
      actorId,
    })).toThrow("Stale Write");
    expect(() => store.addShot(created.projectId, {
      expectedRevision: 2,
      title: "Ungebundene Continuity",
      request,
      continuity: {
        predecessorShotId: shot?.id ?? "",
        referenceOutputId: randomUUID(),
      },
      actorId,
    })).toThrow("Continuity-Ausgabe existiert nicht");

    const evidence = outputEvidence(
      requestRevision?.id ?? "",
      "f".repeat(64),
      "2026-08-11T19:00:00.000Z",
    );
    expect(() => store.recordOutput(created.projectId, {
      expectedRevision: 2,
      shotId: shot?.id ?? "",
      evidence,
      actorId,
    }, evidence.recordedAt)).toThrow("keine exakte Request-Revision");

    expect(() => store.reviseShot(created.projectId, {
      expectedRevision: 2,
      shotId: shot?.id ?? "",
      request,
      reason: "retake",
      sourceOutputId: randomUUID(),
      actorId,
    })).toThrow("Retake-Quelle fehlt");
  });

  it("detects canonical-file, permission and chain tampering without hiding healthy projects", async () => {
    const root = await projectRoot();
    const store = new ProjectStore(root);
    const healthy = store.create({ title: "Gesund", description: "", actorId });
    const healthyCurrent = store.addShot(healthy.projectId, {
      expectedRevision: 1,
      title: "Shot",
      request: validRequest("audio-to-video"),
      continuity: null,
      actorId,
    });
    const corrupted = store.create({ title: "Manipuliert", description: "", actorId });
    const corruptedPath = join(root, corrupted.projectId, "00000001.json");
    const decoded = JSON.parse(await readFile(corruptedPath, "utf8"));
    decoded.project.title = "Nachträglich geändert";
    await writeFile(corruptedPath, `${JSON.stringify(decoded)}\n`, "utf8");

    expect(() => store.get(corrupted.projectId)).toThrow("nicht kanonisch");
    const available = store.listAvailable();
    expect(available.projects.map(({ projectId }) => projectId)).toEqual([healthyCurrent.projectId]);
    expect(available.warnings).toHaveLength(1);

    const healthyFirstPath = join(root, healthy.projectId, "00000001.json");
    const healthyFirst = JSON.parse(await readFile(healthyFirstPath, "utf8"));
    healthyFirst.project.title = "Kanonisch manipuliert";
    await writeFile(healthyFirstPath, `${canonicalJson(healthyFirst)}\n`, "utf8");
    expect(() => store.get(healthy.projectId)).toThrow("hashkonsistent");

    const loose = store.create({ title: "Zu offen", description: "", actorId });
    const loosePath = join(root, loose.projectId, "00000001.json");
    await chmod(loosePath, 0o644);
    expect(() => store.get(loose.projectId)).toThrow("nicht owner-only");
  });

  it("rejects a missing middle revision instead of accepting a truncated chain", async () => {
    const root = await projectRoot();
    const store = new ProjectStore(root);
    const created = store.create({ title: "Lückenlos", description: "", actorId });
    const request = validRequest("audio-to-video");
    store.addShot(created.projectId, {
      expectedRevision: 1,
      title: "Shot",
      request,
      continuity: null,
      actorId,
    });
    store.reviseShot(created.projectId, {
      expectedRevision: 2,
      shotId: store.get(created.projectId)?.project.shots[0]?.id ?? "",
      request: { ...request, seed: request.seed + 1 },
      reason: "edit",
      sourceOutputId: null,
      actorId,
    });
    const thirdPath = join(root, created.projectId, "00000003.json");
    const thirdPayload = await readFile(thirdPath, "utf8");
    const third = JSON.parse(thirdPayload);
    third.project.shots[0].title = "Verdeckte Titeländerung";
    await writeFile(thirdPath, `${canonicalJson(third)}\n`, "utf8");
    expect(() => store.get(created.projectId)).toThrow("Shot-Titel");
    await writeFile(thirdPath, thirdPayload, "utf8");
    await unlink(join(root, created.projectId, "00000002.json"));

    expect(() => store.get(created.projectId)).toThrow("lückenhafte");
  });

  it("rejects incompatible create and retake schemas before touching history", async () => {
    const store = new ProjectStore(await projectRoot());
    expect(() => store.create({ title: "\0", description: "", actorId })).toThrow();
    const created = store.create({ title: "Schema", description: "", actorId });
    const request = validRequest("audio-to-video");
    const added = store.addShot(created.projectId, {
      expectedRevision: 1,
      title: "Shot",
      request,
      continuity: null,
      actorId,
    });
    expect(() => store.reviseShot(created.projectId, {
      expectedRevision: 2,
      shotId: added.project.shots[0]?.id ?? "",
      request,
      reason: "edit",
      sourceOutputId: randomUUID(),
      actorId,
    })).toThrow("Retake-Revision");
    const requestRevision = added.project.shots[0]?.requestRevisions[0];
    const futureChangedAt = outputEvidence(
      requestRevision?.id ?? "",
      requestRevision?.requestSha256 ?? "",
      "2026-08-11T20:00:00.000Z",
    );
    futureChangedAt.changedAt = "2026-08-11T20:00:01.000Z";
    expect(() => store.recordOutput(created.projectId, {
      expectedRevision: 2,
      shotId: added.project.shots[0]?.id ?? "",
      evidence: futureChangedAt,
      actorId,
    }, futureChangedAt.recordedAt)).toThrow("Dateizeitpunkt");
    expect(store.get(created.projectId)?.revision).toBe(2);
  });

  it("uses a dedicated conflict type for operational failures", () => {
    expect(new ProjectConflictError("x").name).toBe("ProjectConflictError");
  });
});
