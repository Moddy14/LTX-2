import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import { dataRecoveryJournalRecordDigest } from "../shared/dataRecoveryJournal.js";
import {
  DataRecoveryCoordinator,
  DataRecoveryHoldError,
  DataRecoveryJournalStore,
  type DataRecoveryHead,
  type DataRecoveryHeadAnchor,
} from "../server/dataRecoveryJournal.js";

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
  const root = await mkdtemp(join(tmpdir(), "ltx-data-recovery-"));
  roots.push(root);
  const anchor = new MemoryAnchor();
  const journalPath = join(root, "control", "data-recovery.json");
  const dataRoot = join(root, "data");
  const journal = new DataRecoveryJournalStore(journalPath, anchor, "data-writer-001");
  let counter = 1;
  const coordinator = new DataRecoveryCoordinator(dataRoot, journal, "data-writer-001", {
    id: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`,
    now: () => "2026-08-15T12:00:00Z",
    crash: (point) => {
      if (point === crashAt) throw new Error(`synthetic crash ${point}`);
    },
  });
  return { root, dataRoot, journalPath, anchor, journal, coordinator };
}

describe("RPO-0 data recovery journal", () => {
  it("acknowledges a JSON write only after a durable prepare, target and commit chain", async () => {
    const data = await fixture();
    const result = data.coordinator.commitJson({
      targetKind: "project",
      targetRelativePath: "projects/project-001/revision-0001.json",
      value: { revision: 1, title: "First" },
    });
    const records = data.journal.readVerified();
    expect(records.map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
    expect(result.journalHeadSha256).toBe(data.anchor.head?.headSha256);
    expect(result.afterSha256).toBe(createHash("sha256")
      .update(await readFile(join(data.dataRoot, "projects/project-001/revision-0001.json"), "utf8"))
      .digest("hex"));
  });

  it("replays a prepared write when a crash happened before the target rename", async () => {
    const data = await fixture("after_prepare");
    expect(() => data.coordinator.commitJson({
      targetKind: "job",
      targetRelativePath: "jobs/jobs.json",
      value: { jobs: [{ id: "job-001", status: "queued" }] },
    })).toThrow(/synthetic crash after_prepare/);

    expect(data.coordinator.recover().recoveredTransactions).toHaveLength(1);
    expect(JSON.parse(await readFile(join(data.dataRoot, "jobs/jobs.json"), "utf8")))
      .toEqual({ jobs: [{ id: "job-001", status: "queued" }] });
    expect(data.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);
  });

  it("commits without duplicating a target already renamed before a crash", async () => {
    const data = await fixture("after_target");
    expect(() => data.coordinator.commitJson({
      targetKind: "provenance",
      targetRelativePath: "provenance/output-001.json",
      value: { output: "output-001", verified: true },
    })).toThrow(/synthetic crash after_target/);

    const beforeRecovery = await readFile(join(data.dataRoot, "provenance/output-001.json"), "utf8");
    expect(data.coordinator.recover().recoveredTransactions).toHaveLength(1);
    expect(await readFile(join(data.dataRoot, "provenance/output-001.json"), "utf8"))
      .toBe(beforeRecovery);
  });

  it("holds when a valid older journal prefix is restored behind the external head", async () => {
    const data = await fixture();
    data.coordinator.commitJson({
      targetKind: "job",
      targetRelativePath: "jobs/jobs.json",
      value: { jobs: [] },
    });
    const records = data.journal.readVerified();
    await writeFile(data.journalPath, canonicalJson([records[0]]), "utf8");
    expect(() => data.journal.readVerified()).toThrow(/external highest-head anchor diverge/);
  });

  it("holds instead of overwriting a target that diverged after prepare", async () => {
    const data = await fixture("after_prepare");
    expect(() => data.coordinator.commitJson({
      targetKind: "project",
      targetRelativePath: "projects/project-001.json",
      value: { title: "Authorized" },
    })).toThrow();
    await writeFile(join(data.dataRoot, "projects/project-001.json"), canonicalJson({ title: "Foreign" }), "utf8");
    expect(() => data.coordinator.recover()).toThrow(DataRecoveryHoldError);
  });

  it("rejects path traversal before any journal transaction is prepared", async () => {
    const data = await fixture();
    expect(() => data.coordinator.commitJson({
      targetKind: "project",
      targetRelativePath: "../foreign.json",
      value: { forbidden: true },
    })).toThrow();
    expect(data.anchor.read()).toBeNull();
    expect(data.journal.readVerified()).toEqual([]);
  });

  it("requires pending recovery before another transaction and detects later target drift", async () => {
    const data = await fixture("after_prepare");
    expect(() => data.coordinator.commitJson({
      targetKind: "job",
      targetRelativePath: "jobs/jobs.json",
      value: { jobs: [] },
    })).toThrow(/synthetic crash/);
    expect(() => data.coordinator.commitJson({
      targetKind: "project",
      targetRelativePath: "projects/project-002.json",
      value: { title: "Second" },
    })).toThrow(/must be reconciled/);
    data.coordinator.recover();
    await writeFile(join(data.dataRoot, "jobs/jobs.json"), canonicalJson({ jobs: ["foreign"] }), "utf8");
    expect(() => data.coordinator.verifyCommittedTargets()).toThrow(/committed.*diverged/i);
    expect(() => data.coordinator.commitJson({
      targetKind: "job",
      targetRelativePath: "jobs/jobs.json",
      value: { jobs: ["next"] },
    })).toThrow(/latest committed digest/);
  });

  it("binds the external head to the exact committed record", async () => {
    const data = await fixture();
    data.coordinator.commitJson({
      targetKind: "job",
      targetRelativePath: "jobs/jobs.json",
      value: { jobs: [] },
    });
    const records = data.journal.readVerified();
    expect(data.anchor.head).toEqual({
      sequence: 1,
      headSha256: dataRecoveryJournalRecordDigest(records[1]),
    });
  });
});
