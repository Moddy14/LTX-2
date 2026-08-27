import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DataRecoveryCoordinator,
  DataRecoveryJournalStore,
  type DataRecoveryHead,
  type DataRecoveryHeadAnchor,
} from "../server/dataRecoveryJournal.js";
import { JobManager } from "../server/jobs.js";
import { buildAdmissionRequests } from "../server/admission.js";
import { canonicalJson } from "../shared/canonicalJson.js";
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

  it.each(["after_prepare", "after_target"] as const)(
    "recovers a coordinator %s fault inside the acknowledged JobManager commit",
    async (crashAt) => {
      const crashed = await fixture(crashAt);
      const manager = new JobManager(crashed.storage, false);
      const created = manager.create(validRequest());
      expect(manager.get(created.id)?.status).toBe("queued");
      expect(crashed.journal.readVerified().map(({ phase }) => phase)).toEqual(["prepared", "committed"]);

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
    },
  );

  it.each(["after_prepare", "after_target"] as const)(
    "keeps a terminal receipt RPO-0 across a coordinator %s fault and restart",
    async (crashAt) => {
      const crashed = await fixture(crashAt);
      let remoteState: "running" | "cancelled" = "running";
      let studioJobId = "";
      const request = validRequest();
      const manager = new JobManager(crashed.storage, false, null, undefined, {
        read: async (jobId) => ({
          schema_version: "dgx-job-read.v0",
          job: {
            job_id: jobId,
            state: remoteState,
            requested_by: `ltx-studio:${studioJobId}`,
            source_app: "LTX Studio",
            idempotency_key: `ltx-studio:${studioJobId}`,
          },
        }),
        transition: async (jobId, state) => {
          expect(state).toBe("cancelled");
          remoteState = "cancelled";
          return {
            schema_version: "dgx-job-transition.v0",
            transition_applied: true,
            job: {
              job_id: jobId,
              state: "cancelled",
              requested_by: `ltx-studio:${studioJobId}`,
              source_app: "LTX Studio",
              idempotency_key: `ltx-studio:${studioJobId}`,
            },
          };
        },
      }, null);
      const created = manager.create(request);
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.status = "cancelled";
      active.cancelledBy = "studio";
      active.finishedAt = new Date().toISOString();
      active.dgxJobId = crashAt === "after_prepare"
        ? "dgx-job-20260827-174900-000000000001"
        : "dgx-job-20260827-174900-000000000002";
      const [preparedAdmission] = buildAdmissionRequests(request, 58, created.id);
      const submitStartedAt = new Date(Date.now() - 2_000).toISOString();
      active.dgxLeaseReceipt = {
        schemaVersion: "ltx-studio-dgx-lease-receipt.v1",
        studioJobId: created.id,
        dgxJobId: active.dgxJobId,
        requestedBy: `ltx-studio:${created.id}`,
        sourceApp: "LTX Studio",
        idempotencyKey: `ltx-studio:${created.id}`,
        preparedAdmission,
        preparedAdmissionSha256: createHash("sha256")
          .update(canonicalJson(preparedAdmission))
          .digest("hex"),
        submitStartedAt,
        observedState: "accepted",
        observedCreatedAt: new Date(Date.now() - 1_000).toISOString(),
        evidence: {
          kind: "submit-response",
          schemaVersion: "dgx-queue-submit.v0",
        },
        confirmedAt: new Date().toISOString(),
      };
      (Reflect.get(manager, "queue") as string[]).splice(
        (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
        1,
      );
      (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: "cancelled",
        metadata: Record<string, string>,
      ) => void).call(manager, active, "cancelled", { current_step: "RPO-0 receipt" });
      (Reflect.get(manager, "changed") as () => void).call(manager);
      const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
        job: unknown,
      ) => Promise<boolean>;

      await expect(flush.call(manager, active)).resolves.toBe(true);
      const persisted = JSON.parse(await readFile(crashed.storagePath, "utf8"));
      expect(persisted[0]).not.toHaveProperty("dgxTerminalDelivery");
      expect(persisted[0]).toMatchObject({
        dgxTerminalReceipt: {
          studioJobId: created.id,
          localIntentState: "cancelled",
          remoteTerminalState: "cancelled",
          evidence: {
            kind: "job-transition",
            schemaVersion: "dgx-job-transition.v0",
            requestedBy: `ltx-studio:${created.id}`,
            sourceApp: "LTX Studio",
            idempotencyKey: `ltx-studio:${created.id}`,
          },
        },
      });

      const recoveredCoordinator = new DataRecoveryCoordinator(
        crashed.dataRoot,
        crashed.journal,
        "data-writer-001",
      );
      const read = vi.fn(async () => {
        throw new Error("RPO-0 receipt must suppress GET after restart");
      });
      const transition = vi.fn(async () => {
        throw new Error("RPO-0 receipt must suppress PATCH after restart");
      });
      const restored = new JobManager({
        path: crashed.storagePath,
        recovery: { coordinator: recoveredCoordinator, targetRelativePath: "jobs.json" },
      }, false, null, undefined, { read, transition }, null);

      expect(restored.get(created.id)?.cancellationState).toBe("settled");
      expect(read).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      const phases = crashed.journal.readVerified().map(({ phase }) => phase);
      expect(phases.length).toBeGreaterThanOrEqual(2);
      expect(phases.length % 2).toBe(0);
      for (let index = 0; index < phases.length; index += 2) {
        expect(phases.slice(index, index + 2)).toEqual(["prepared", "committed"]);
      }
    },
  );
});
