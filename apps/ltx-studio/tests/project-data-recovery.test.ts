import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DataRecoveryCoordinator,
  DataRecoveryJournalStore,
  type DataRecoveryHead,
  type DataRecoveryHeadAnchor,
} from "../server/dataRecoveryJournal.js";
import { ProjectStore } from "../server/projectStore.js";
import { canonicalJson } from "../shared/canonicalJson.js";

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
  const root = await mkdtemp(join(tmpdir(), "ltx-project-recovery-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const projectRoot = join(dataRoot, "projects");
  const anchor = new MemoryAnchor();
  const journal = new DataRecoveryJournalStore(
    join(root, "control", "data-recovery.json"),
    anchor,
    "data-writer-001",
  );
  const coordinator = new DataRecoveryCoordinator(dataRoot, journal, "data-writer-001", {
    crash: (point) => {
      if (point === crashAt) throw new Error(`synthetic project-store crash ${point}`);
    },
  });
  return {
    root,
    dataRoot,
    projectRoot,
    anchor,
    journal,
    storage: { root: projectRoot, recovery: { coordinator, targetPrefix: "projects" } },
  };
}

describe("ProjectStore RPO-0 persistence", () => {
  it("writes new project revisions as canonical journaled targets", async () => {
    const data = await fixture();
    const store = new ProjectStore(data.storage);
    const created = store.create({
      title: "Recovery Project",
      description: "Journaled",
      actorId: "studio-operator-01",
    }, "2026-08-15T12:00:00.000Z");
    const revisionPath = join(data.projectRoot, created.projectId, "00000001.json");

    expect(await readFile(revisionPath, "utf8")).toBe(canonicalJson(created));
    expect(data.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
    expect(new ProjectStore(data.storage).get(created.projectId)).toEqual(created);
  });

  it("recovers a renamed project revision before scanning available projects", async () => {
    const crashed = await fixture("after_target");
    const store = new ProjectStore(crashed.storage);
    expect(() => store.create({
      title: "Crash Project",
      description: "Recover me",
      actorId: "studio-operator-01",
    }, "2026-08-15T12:00:00.000Z")).toThrow(/synthetic project-store crash after_target/);
    expect(crashed.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared"]);

    const recoveredCoordinator = new DataRecoveryCoordinator(
      crashed.dataRoot,
      crashed.journal,
      "data-writer-001",
    );
    const restored = new ProjectStore({
      root: crashed.projectRoot,
      recovery: { coordinator: recoveredCoordinator, targetPrefix: "projects" },
    });
    const projectIds = (await readdir(crashed.projectRoot)).filter((entry) => !entry.startsWith("."));
    expect(projectIds).toHaveLength(1);
    expect(restored.listAvailable().projects.map(({ projectId }) => projectId)).toEqual(projectIds);
    expect(crashed.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
  });
});
