import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  activationEnvelopeDigest,
  activationRecordDigest,
  type ActivationJournalEnvelope,
  type RuntimeActivationSnapshot,
} from "../shared/activation.js";
import type {
  QualificationTicketCheckpoint,
  QualificationTicketInspection,
} from "../shared/qualificationRegistry.js";
import type {
  QualificationBrokerCommittedReceipt,
  QualificationBrokerRequest,
} from "../server/qualificationBroker.js";
import {
  QualificationSupervisor,
  type QualificationLaunchPlan,
  type QualificationSupervisorOperations,
} from "../server/qualificationSupervisor.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const release = {
  releaseDigest: hash("release"),
  surfaceDigest: hash("surface"),
  runtimeInstallSealSha256: hash("runtime-seal"),
  runtimeTreeSha256: hash("runtime-tree"),
  runtimePolicySha256: hash("runtime-policy"),
  nodeExecutableSha256: hash("node-executable"),
  runtimeTrust: runtimeTrustFixture,
  rights: {
    policyEvidenceDigest: hash("rights"),
    attestationSeriesId: "rights-series-001",
    minimumSnapshotVersion: 3,
  },
};
const plan: QualificationLaunchPlan = {
  schemaVersion: "ltx-studio-qualification-launch-plan.v1",
  claim: {
    authorizationDigest: hash("authorization"),
    authorizationId: "qualification-r0l-001",
    authorizationNonce: "a".repeat(32),
    ticketId: "r0l-ticket-001",
    ticketNonce: "b".repeat(32),
    purposeId: "r0l-live-canary",
    phaseId: "r0l",
    matrixDigest: hash("matrix"),
    surfaceEntryId: "native-generation.text-to-video",
    inputDigest: hash("input"),
    seed: 42,
  },
  runnerDigest: hash("runner"),
  blockedWrapperDigest: hash("blocked-wrapper"),
  transactionIds: {
    arm: "00000000-0000-4000-8000-000000000301",
    start: "00000000-0000-4000-8000-000000000302",
    terminal: "00000000-0000-4000-8000-000000000303",
  },
};

function fixture(options: { failAction?: QualificationBrokerRequest["action"]; initialAllowed?: boolean; wrongCgroup?: boolean } = {}) {
  const events: string[] = [];
  let ticketState: QualificationTicketInspection["state"] = "accepted";
  let head = hash("accepted-head");
  let sequence = 4;
  const activation = {
    read: (): RuntimeActivationSnapshot => ({
      state: "qualification_only",
      generation: 1,
      activationHeadSha256: head,
      releaseDigest: release.releaseDigest,
      surfaceDigest: release.surfaceDigest,
      runtimeInstallSealSha256: release.runtimeInstallSealSha256,
      runtimeTreeSha256: release.runtimeTreeSha256,
      runtimePolicySha256: release.runtimePolicySha256,
      nodeExecutableSha256: release.nodeExecutableSha256,
      runtimeTrust: runtimeTrustFixture,
      rightsCurrent: true,
      releasedSurfaceEntryIds: [],
    }),
  };
  const registry = {
    inspect: (
      _claim: QualificationLaunchPlan["claim"],
      checkpoint: QualificationTicketCheckpoint,
    ): QualificationTicketInspection => {
      events.push(`inspect:${checkpoint}`);
      const expected = checkpoint === "supervisor_arm" ? "accepted"
        : checkpoint === "writer_start" ? "armed" : "started";
      const allowed = options.initialAllowed !== false && ticketState === expected;
      return {
        allowed,
        reason: allowed ? "authorized" : "deadline elapsed",
        state: ticketState,
        checkpoint,
        authorizationDigest: plan.claim.authorizationDigest,
        authorizationId: plan.claim.authorizationId,
        ticketId: plan.claim.ticketId,
        budget: { jobCount: 1, gpuSeconds: 100, outputBytes: 1000 },
        completeBy: "2026-08-15T00:30:00Z",
      };
    },
  };
  const broker = {
    transition: async (request: QualificationBrokerRequest): Promise<QualificationBrokerCommittedReceipt> => {
      events.push(`broker:${request.action}`);
      if (request.action === options.failAction) throw new Error(`synthetic ${request.action} failure`);
      const operation = {
        accept: "accept_run_ticket",
        arm: "arm_run_ticket",
        start: "start_run_ticket",
        terminalize: "terminalize_run_ticket",
      } as const;
      const nextState = { accept: "accepted", arm: "armed", start: "started", terminalize: "terminal" } as const;
      const record = {
        schemaVersion: "ltx-studio-activation-journal-record.v3" as const,
        recordId: request.requestId,
        sequence: sequence++,
        generation: 1,
        previousRecordSha256: head,
        previousState: "qualification_only" as const,
        state: "qualification_only" as const,
        operation: operation[request.action],
        release,
        releasedSurfaceEntryIds: [],
        authorizationDigest: plan.claim.authorizationDigest,
        auditEnvelopeDigest: null,
        evidenceDigest: null,
        ticketId: plan.claim.ticketId,
        ticketState: nextState[request.action],
        ticketTerminal: request.terminal,
        supersedePreflight: null,
        recordedAt: request.requestedAt,
        writerKeyId: "activation-writer-001",
      };
      const envelope: ActivationJournalEnvelope = {
        record,
        signature: {
          schemaVersion: "ltx-studio-detached-signature.v1",
          algorithm: "ed25519",
          role: "activation-journal-writer",
          keyId: record.writerKeyId,
          payloadSha256: activationRecordDigest(record),
          signatureBase64: "supervisor-test-signature",
        },
      };
      ticketState = nextState[request.action];
      head = activationEnvelopeDigest(envelope);
      return {
        schemaVersion: "ltx-studio-qualification-broker-receipt.v1",
        requestId: request.requestId,
        action: request.action,
        committed: true,
        code: "committed",
        reason: "committed",
        envelope,
      };
    },
  };
  const operations: QualificationSupervisorOperations = {
    prepareCgroup: async ({ monotonicDeadlineMs }) => {
      events.push("cgroup:prepare");
      return { cgroupId: "qgroup-r0l-001", monotonicDeadlineMs };
    },
    armDeadline: async () => { events.push("deadline:arm"); },
    spawnBlockedWrapper: async () => {
      events.push("wrapper:spawn-blocked");
      return { wrapperId: "wrapper-r0l-001", pid: 4242, cgroupId: options.wrongCgroup ? "escaped" : "qgroup-r0l-001" };
    },
    verifyBlockedWrapper: async () => { events.push("wrapper:verify-blocked"); },
    releaseExecBarrier: async () => { events.push("wrapper:release-exec"); },
    terminateCgroup: async () => { events.push("cgroup:terminate"); },
  };
  const supervisor = new QualificationSupervisor({
    registry,
    broker,
    activation,
    operations,
    expectedRunnerDigest: plan.runnerDigest,
    expectedBlockedWrapperDigest: plan.blockedWrapperDigest,
    now: () => new Date("2026-08-15T00:05:00Z"),
    monotonicNowMs: () => 1_000,
  });
  return { supervisor, events };
}

describe("qualification supervisor start barrier", () => {
  it("arms the deadline and durable state before releasing one blocked wrapper", async () => {
    const { supervisor, events } = fixture();
    await expect(supervisor.launch(plan)).resolves.toMatchObject({
      schemaVersion: "ltx-studio-qualification-launch-receipt.v1",
      ticketId: plan.claim.ticketId,
      cgroupId: "qgroup-r0l-001",
      wrapperId: "wrapper-r0l-001",
      pid: 4242,
      monotonicDeadlineMs: 1_501_000,
    });
    expect(events).toEqual([
      "inspect:supervisor_arm",
      "cgroup:prepare",
      "deadline:arm",
      "broker:arm",
      "wrapper:spawn-blocked",
      "wrapper:verify-blocked",
      "inspect:writer_start",
      "broker:start",
      "inspect:runner_exec",
      "wrapper:release-exec",
    ]);
  });

  it("never releases exec when the durable started transition fails", async () => {
    const { supervisor, events } = fixture({ failAction: "start" });
    await expect(supervisor.launch(plan)).rejects.toThrow(/synthetic start failure/);
    expect(events).toContain("cgroup:terminate");
    expect(events).toContain("broker:terminalize");
    expect(events).not.toContain("wrapper:release-exec");
  });

  it("terminalizes an accepted ticket that already missed its window without creating a cgroup", async () => {
    const { supervisor, events } = fixture({ initialAllowed: false });
    await expect(supervisor.launch(plan)).rejects.toThrow(/deadline elapsed/);
    expect(events).toEqual(["inspect:supervisor_arm", "broker:terminalize"]);
  });

  it("kills and terminalizes a wrapper whose cgroup identity does not match", async () => {
    const { supervisor, events } = fixture({ wrongCgroup: true });
    await expect(supervisor.launch(plan)).rejects.toThrow(/escaped its prepared cgroup/);
    expect(events).toContain("cgroup:terminate");
    expect(events).toContain("broker:terminalize");
    expect(events).not.toContain("wrapper:release-exec");
  });

  it("rejects an unpinned runner before touching ticket or supervisor state", async () => {
    const { supervisor, events } = fixture();
    await expect(supervisor.launch({ ...plan, runnerDigest: hash("foreign-runner") }))
      .rejects.toThrow(/sealed runtime policy/);
    expect(events).toEqual([]);
  });
});
