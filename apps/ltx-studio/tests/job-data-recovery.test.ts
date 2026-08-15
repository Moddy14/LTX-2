import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DataRecoveryCoordinator,
  DataRecoveryJournalStore,
  type DataRecoveryHead,
  type DataRecoveryHeadAnchor,
} from "../server/dataRecoveryJournal.js";
import { JobManager } from "../server/jobs.js";
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

async function fixture(crashAt?: "after_prepare" | "after_target") {
  const root = await mkdtemp(join(tmpdir(), "ltx-job-recovery-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const storagePath = join(dataRoot, "jobs.json");
  const anchor = new MemoryAnchor();
  const journal = new DataRecoveryJournalStore(
    join(root, "control", "data-recovery.json"),
    anchor,
    "data-writer-001",
  );
  const coordinator = new DataRecoveryCoordinator(dataRoot, journal, "data-writer-001", {
    crash: (point) => {
      if (point === crashAt) throw new Error(`synthetic job-store crash ${point}`);
    },
  });
  const storage = {
    path: storagePath,
    recovery: { coordinator, targetRelativePath: "jobs.json" },
  };
  return { root, dataRoot, storagePath, anchor, journal, coordinator, storage };
}

describe("JobManager RPO-0 persistence", () => {
  it("persists every acknowledged JobManager change through the recovery journal", async () => {
    const data = await fixture();
    const manager = new JobManager(data.storage, false);
    const created = manager.create(validRequest());

    expect(JSON.parse(await readFile(data.storagePath, "utf8"))).toHaveLength(1);
    expect(data.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
    expect(data.anchor.head?.sequence).toBe(1);
    expect(new JobManager(data.storage, false).get(created.id)?.status).toBe("queued");
  });

  it("recovers a target-renamed but uncommitted job write before JobManager.restore", async () => {
    const crashed = await fixture("after_target");
    const manager = new JobManager(crashed.storage, false);
    expect(() => manager.create(validRequest())).toThrow(/synthetic job-store crash after_target/);
    expect(crashed.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared"]);

    const recoveredCoordinator = new DataRecoveryCoordinator(
      crashed.dataRoot,
      crashed.journal,
      "data-writer-001",
    );
    const restored = new JobManager({
      path: crashed.storagePath,
      recovery: { coordinator: recoveredCoordinator, targetRelativePath: "jobs.json" },
    }, false);
    expect(restored.list()).toHaveLength(1);
    expect(crashed.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
  });
});
