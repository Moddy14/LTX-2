import { z } from "zod";

import { activationEnvelopeDigest, type RuntimeActivationSnapshot } from "../shared/activation.js";
import {
  qualificationTicketClaimSchema,
  type QualificationTicketCheckpoint,
  type QualificationTicketClaim,
  type QualificationTicketInspection,
} from "../shared/qualificationRegistry.js";
import {
  qualificationBrokerRequestSchema,
  type QualificationBrokerCommittedReceipt,
  type QualificationBrokerRequest,
} from "./qualificationBroker.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const qualificationLaunchPlanSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-launch-plan.v1"),
  claim: qualificationTicketClaimSchema,
  runnerDigest: sha256Schema,
  blockedWrapperDigest: sha256Schema,
  transactionIds: z.object({
    arm: z.uuid(),
    start: z.uuid(),
    terminal: z.uuid(),
  }).strict(),
}).strict().superRefine((plan, context) => {
  const ids = Object.values(plan.transactionIds);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["transactionIds"], message: "transition ids must be unique" });
  }
});

export type QualificationLaunchPlan = z.infer<typeof qualificationLaunchPlanSchema>;

export type QualificationSupervisorCgroup = {
  cgroupId: string;
  monotonicDeadlineMs: number;
};

export type QualificationBlockedWrapper = {
  wrapperId: string;
  pid: number;
  cgroupId: string;
};

export type QualificationSupervisorOperations = {
  prepareCgroup(input: {
    claim: QualificationTicketClaim;
    runnerDigest: string;
    monotonicDeadlineMs: number;
    gpuSecondsBudget: number;
    outputBytesBudget: number;
  }): Promise<QualificationSupervisorCgroup>;
  armDeadline(cgroup: QualificationSupervisorCgroup): Promise<void>;
  spawnBlockedWrapper(input: {
    cgroup: QualificationSupervisorCgroup;
    claim: QualificationTicketClaim;
    blockedWrapperDigest: string;
    runnerDigest: string;
  }): Promise<QualificationBlockedWrapper>;
  verifyBlockedWrapper(input: {
    cgroup: QualificationSupervisorCgroup;
    wrapper: QualificationBlockedWrapper;
    blockedWrapperDigest: string;
  }): Promise<void>;
  releaseExecBarrier(input: {
    cgroup: QualificationSupervisorCgroup;
    wrapper: QualificationBlockedWrapper;
    runnerDigest: string;
    startedHeadSha256: string;
  }): Promise<void>;
  terminateCgroup(cgroup: QualificationSupervisorCgroup, reason: string): Promise<void>;
};

export type QualificationRegistryInspector = {
  inspect(
    claim: QualificationTicketClaim,
    checkpoint: QualificationTicketCheckpoint,
    now: Date,
  ): QualificationTicketInspection;
};

export type QualificationTransitionBroker = {
  transition(request: QualificationBrokerRequest): Promise<QualificationBrokerCommittedReceipt>;
};

export type QualificationSupervisorActivationReader = {
  read(): RuntimeActivationSnapshot;
};

export type QualificationLaunchReceipt = {
  schemaVersion: "ltx-studio-qualification-launch-receipt.v1";
  ticketId: string;
  cgroupId: string;
  wrapperId: string;
  pid: number;
  monotonicDeadlineMs: number;
  armedHeadSha256: string;
  startedHeadSha256: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class QualificationSupervisor {
  constructor(private readonly options: {
    registry: QualificationRegistryInspector;
    broker: QualificationTransitionBroker;
    activation: QualificationSupervisorActivationReader;
    operations: QualificationSupervisorOperations;
    expectedRunnerDigest: string;
    expectedBlockedWrapperDigest: string;
    now?: () => Date;
    monotonicNowMs?: () => number;
  }) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private request(
    plan: QualificationLaunchPlan,
    action: QualificationBrokerRequest["action"],
    requestId: string,
    terminal: QualificationBrokerRequest["terminal"] = null,
  ): QualificationBrokerRequest {
    const snapshot = this.options.activation.read();
    return qualificationBrokerRequestSchema.parse({
      schemaVersion: "ltx-studio-qualification-broker-request.v3",
      requestId,
      action,
      requestedAt: this.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
      expectedGeneration: snapshot.generation,
      expectedHeadSha256: snapshot.activationHeadSha256,
      expectedReleaseDigest: snapshot.releaseDigest,
      expectedSurfaceDigest: snapshot.surfaceDigest,
      expectedRuntimeInstallSealSha256: snapshot.runtimeInstallSealSha256,
      expectedRuntimeTreeSha256: snapshot.runtimeTreeSha256,
      expectedRuntimePolicySha256: snapshot.runtimePolicySha256,
      expectedNodeExecutableSha256: snapshot.nodeExecutableSha256,
      expectedRuntimeTrust: snapshot.runtimeTrust,
      claim: plan.claim,
      terminal,
    });
  }

  private async terminalize(
    plan: QualificationLaunchPlan,
    outcome: "expired" | "killed",
    reason: string,
  ): Promise<void> {
    await this.options.broker.transition(this.request(plan, "terminalize", plan.transactionIds.terminal, {
      outcome,
      outputDigest: null,
      reason,
    }));
  }

  async launch(rawPlan: unknown): Promise<QualificationLaunchReceipt> {
    const plan = qualificationLaunchPlanSchema.parse(rawPlan);
    if (plan.runnerDigest !== this.options.expectedRunnerDigest
      || plan.blockedWrapperDigest !== this.options.expectedBlockedWrapperDigest) {
      throw new Error("Qualification launch artifact digest does not match the sealed runtime policy");
    }
    const accepted = this.options.registry.inspect(plan.claim, "supervisor_arm", this.now());
    if (!accepted.allowed) {
      if (accepted.state === "accepted") {
        await this.terminalize(plan, "expired", accepted.reason);
      }
      throw new Error(`Qualification supervisor refused launch: ${accepted.reason}`);
    }
    const remainingMs = Date.parse(accepted.completeBy) - this.now().getTime();
    if (remainingMs <= 0) {
      await this.terminalize(plan, "expired", "complete_by elapsed before supervisor arm");
      throw new Error("Qualification supervisor refused launch: complete_by elapsed");
    }
    const monotonicDeadlineMs = (this.options.monotonicNowMs?.() ?? performance.now()) + remainingMs;
    let cgroup: QualificationSupervisorCgroup | null = null;
    let armReceipt: QualificationBrokerCommittedReceipt | null = null;
    try {
      cgroup = await this.options.operations.prepareCgroup({
        claim: plan.claim,
        runnerDigest: plan.runnerDigest,
        monotonicDeadlineMs,
        gpuSecondsBudget: accepted.budget.gpuSeconds,
        outputBytesBudget: accepted.budget.outputBytes,
      });
      if (cgroup.monotonicDeadlineMs !== monotonicDeadlineMs) {
        throw new Error("Qualification supervisor persisted a different monotonic deadline");
      }
      await this.options.operations.armDeadline(cgroup);
      armReceipt = await this.options.broker.transition(
        this.request(plan, "arm", plan.transactionIds.arm),
      );

      const wrapper = await this.options.operations.spawnBlockedWrapper({
        cgroup,
        claim: plan.claim,
        blockedWrapperDigest: plan.blockedWrapperDigest,
        runnerDigest: plan.runnerDigest,
      });
      if (wrapper.cgroupId !== cgroup.cgroupId) {
        throw new Error("Blocked qualification wrapper escaped its prepared cgroup");
      }
      await this.options.operations.verifyBlockedWrapper({
        cgroup,
        wrapper,
        blockedWrapperDigest: plan.blockedWrapperDigest,
      });

      const armed = this.options.registry.inspect(plan.claim, "writer_start", this.now());
      if (!armed.allowed) throw new Error(`Qualification start barrier refused launch: ${armed.reason}`);
      const startReceipt = await this.options.broker.transition(
        this.request(plan, "start", plan.transactionIds.start),
      );
      const started = this.options.registry.inspect(plan.claim, "runner_exec", this.now());
      if (!started.allowed) throw new Error(`Qualification exec barrier refused launch: ${started.reason}`);
      const startedHeadSha256 = activationEnvelopeDigest(startReceipt.envelope);
      await this.options.operations.releaseExecBarrier({
        cgroup,
        wrapper,
        runnerDigest: plan.runnerDigest,
        startedHeadSha256,
      });
      return {
        schemaVersion: "ltx-studio-qualification-launch-receipt.v1",
        ticketId: plan.claim.ticketId,
        cgroupId: cgroup.cgroupId,
        wrapperId: wrapper.wrapperId,
        pid: wrapper.pid,
        monotonicDeadlineMs,
        armedHeadSha256: activationEnvelopeDigest(armReceipt.envelope),
        startedHeadSha256,
      };
    } catch (error) {
      const failures: string[] = [errorMessage(error)];
      if (cgroup) {
        try {
          await this.options.operations.terminateCgroup(cgroup, "qualification launch failed before exec acknowledgement");
        } catch (cleanupError) {
          failures.push(`cgroup cleanup failed: ${errorMessage(cleanupError)}`);
        }
      }
      try {
        await this.terminalize(plan, "killed", failures[0]);
      } catch (terminalError) {
        failures.push(`ticket terminalization failed: ${errorMessage(terminalError)}`);
      }
      throw new Error(`Qualification launch failed: ${failures.join("; ")}`);
    }
  }
}
