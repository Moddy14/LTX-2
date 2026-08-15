import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DataRecoveryCoordinator,
  DataRecoveryJournalStore,
  type DataRecoveryHead,
  type DataRecoveryHeadAnchor,
} from "../server/dataRecoveryJournal.js";
import type { StudioJob } from "../server/jobs.js";
import { OutputLibrary } from "../server/outputs.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

class MemoryAnchor implements DataRecoveryHeadAnchor {
  head: DataRecoveryHead | null = null;

  read(): DataRecoveryHead | null {
    return this.head ? structuredClone(this.head) : null;
  }

  commit(head: DataRecoveryHead): void {
    this.head = structuredClone(head);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function completedJob(outputName: string): StudioJob {
  const request = validRequest("two-stage");
  request.outputName = outputName;
  return {
    id: "2c8a5dc6-8864-49f7-a639-85caef918888",
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/2c8a5dc6-8864-49f7-a639-85caef918888/output`,
    createdAt: "2026-08-15T12:00:00.000Z",
    startedAt: "2026-08-15T12:00:00.000Z",
    finishedAt: "2026-08-15T12:01:00.000Z",
    progress: 100,
    error: null,
    logs: [],
    command: "python -m ltx_pipelines.ti2vid_two_stages",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 60_000,
    cancelledBy: null,
    dgxJobId: null,
    thermalProfile: null,
    identityEvidence: null,
    runProvenance: null,
  };
}

async function fixture(crashAt?: "after_prepare" | "after_target") {
  const root = await mkdtemp(join(tmpdir(), "ltx-output-recovery-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const outputRoot = join(dataRoot, "outputs");
  await mkdir(outputRoot, { recursive: true });
  const anchor = new MemoryAnchor();
  const journal = new DataRecoveryJournalStore(
    join(root, "control", "data-recovery.json"),
    anchor,
    "data-writer-001",
  );
  const coordinator = new DataRecoveryCoordinator(dataRoot, journal, "data-writer-001", {
    crash: (point) => {
      if (point === crashAt) throw new Error(`synthetic provenance crash ${point}`);
    },
  });
  return {
    root,
    dataRoot,
    outputRoot,
    anchor,
    journal,
    storage: { root: outputRoot, recovery: { coordinator, targetPrefix: "outputs" } },
  };
}

describe("output provenance RPO-0 persistence", () => {
  it("journals the complete output settings sidecar before recordCompleted returns", async () => {
    const data = await fixture();
    const job = completedJob("journaled-output.mp4");
    await writeFile(join(data.outputRoot, job.outputName), "video-bytes", "utf8");
    const library = new OutputLibrary(data.storage);
    library.recordCompleted([job]);

    const sidecar = JSON.parse(await readFile(
      join(data.outputRoot, `${job.outputName}.ltx-settings.json`),
      "utf8",
    ));
    expect(sidecar.jobId).toBe(job.id);
    expect(sidecar.request.outputName).toBe(job.outputName);
    expect(data.journal.readVerified().map(({ phase, targetKind }) => [phase, targetKind]))
      .toEqual([["prepared", "provenance"], ["committed", "provenance"]]);
  });

  it("recovers a renamed provenance sidecar before OutputLibrary becomes readable", async () => {
    const crashed = await fixture("after_target");
    const job = completedJob("crashed-output.mp4");
    await writeFile(join(crashed.outputRoot, job.outputName), "video-bytes", "utf8");
    const library = new OutputLibrary(crashed.storage);
    expect(() => library.recordCompleted([job])).toThrow(/synthetic provenance crash after_target/);

    const recoveredCoordinator = new DataRecoveryCoordinator(
      crashed.dataRoot,
      crashed.journal,
      "data-writer-001",
    );
    const restored = new OutputLibrary({
      root: crashed.outputRoot,
      recovery: { coordinator: recoveredCoordinator, targetPrefix: "outputs" },
    });
    expect(restored.list([job]).find(({ name }) => name === job.outputName)?.settingsAvailable).toBe(true);
    expect(crashed.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
  });
});
