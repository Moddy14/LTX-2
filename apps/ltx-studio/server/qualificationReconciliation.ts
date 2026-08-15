import { z } from "zod";

import type { QualificationTicketState } from "../shared/activation.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);

export const qualificationSupervisorStateSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-supervisor-state.v1"),
  ticketId: identifierSchema,
  authorizationDigest: sha256Schema,
  generation: z.number().int().positive(),
  releaseDigest: sha256Schema,
  cgroupId: identifierSchema,
  bootId: identifierSchema,
  monotonicDeadlineMs: z.number().finite().positive(),
  phase: z.enum(["prepared", "deadline_armed", "blocked_wrapper", "exec_released", "terminal_cleanup"]),
  wrapperId: identifierSchema.nullable(),
  wrapperPid: z.number().int().positive().nullable(),
  startedHeadSha256: sha256Schema.nullable(),
}).strict().superRefine((state, context) => {
  const hasWrapper = state.wrapperId !== null && state.wrapperPid !== null;
  if ((state.wrapperId === null) !== (state.wrapperPid === null)) {
    context.addIssue({ code: "custom", path: ["wrapperId"], message: "wrapper id and pid must appear together" });
  }
  if (["prepared", "deadline_armed"].includes(state.phase) && hasWrapper) {
    context.addIssue({ code: "custom", path: ["wrapperId"], message: "pre-wrapper state cannot bind a wrapper" });
  }
  if (["blocked_wrapper", "exec_released", "terminal_cleanup"].includes(state.phase) && !hasWrapper) {
    context.addIssue({ code: "custom", path: ["wrapperId"], message: "wrapper state must bind a wrapper" });
  }
  if ((state.phase === "exec_released") !== (state.startedHeadSha256 !== null)) {
    context.addIssue({ code: "custom", path: ["startedHeadSha256"], message: "only exec_released binds the started head" });
  }
});

export type QualificationSupervisorState = z.infer<typeof qualificationSupervisorStateSchema>;

export const qualificationRuntimeObservationSchema = z.object({
  currentBootId: identifierSchema,
  nowMonotonicMs: z.number().finite().nonnegative(),
  cgroupExists: z.boolean(),
  wrapperProcessExists: z.boolean(),
  runnerExecObserved: z.boolean(),
  descendantCount: z.number().int().nonnegative(),
  openGpuDeviceFds: z.number().int().nonnegative(),
  timerArmed: z.boolean(),
}).strict();

export type QualificationRuntimeObservation = z.infer<typeof qualificationRuntimeObservationSchema>;

export const qualificationReconciliationActions = [
  "wait_for_supervisor",
  "continue_running",
  "terminal_clean",
  "terminalize_ticket",
  "kill_cgroup_and_terminalize",
  "kill_cgroup_and_hold",
  "cleanup_terminal_cgroup",
  "security_hold",
] as const;

export type QualificationReconciliationAction = (typeof qualificationReconciliationActions)[number];

export type QualificationReconciliationDecision = {
  action: QualificationReconciliationAction;
  reason: string;
  outputReleaseAllowed: boolean;
};

function artifactsPresent(observation: QualificationRuntimeObservation): boolean {
  return observation.cgroupExists
    || observation.wrapperProcessExists
    || observation.runnerExecObserved
    || observation.descendantCount > 0
    || observation.openGpuDeviceFds > 0
    || observation.timerArmed;
}

function stop(
  observation: QualificationRuntimeObservation,
  reason: string,
  securityHold = false,
): QualificationReconciliationDecision {
  return {
    action: securityHold
      ? artifactsPresent(observation) ? "kill_cgroup_and_hold" : "security_hold"
      : artifactsPresent(observation)
        ? "kill_cgroup_and_terminalize"
        : "terminalize_ticket",
    reason,
    outputReleaseAllowed: false,
  };
}

export function decideQualificationReconciliation(raw: {
  ticketState: QualificationTicketState;
  expected: {
    ticketId: string;
    authorizationDigest: string;
    generation: number;
    releaseDigest: string;
  };
  supervisorState: unknown | null;
  observation: unknown;
}): QualificationReconciliationDecision {
  const observation = qualificationRuntimeObservationSchema.parse(raw.observation);
  const state = raw.supervisorState === null ? null : qualificationSupervisorStateSchema.parse(raw.supervisorState);

  if (raw.ticketState === "pending") {
    return artifactsPresent(observation) || state !== null
      ? stop(observation, "Pending ticket has unauthorized supervisor or process artifacts", true)
      : { action: "wait_for_supervisor", reason: "Ticket has not been accepted", outputReleaseAllowed: false };
  }
  if (raw.ticketState === "terminal") {
    return artifactsPresent(observation)
      ? { action: "cleanup_terminal_cgroup", reason: "Terminal ticket still owns runtime artifacts", outputReleaseAllowed: false }
      : { action: "terminal_clean", reason: "Terminal ticket has no remaining runtime artifacts", outputReleaseAllowed: false };
  }
  if (!state) {
    return raw.ticketState === "accepted" && !artifactsPresent(observation)
      ? { action: "wait_for_supervisor", reason: "Accepted ticket is waiting for its supervisor", outputReleaseAllowed: false }
      : stop(observation, `${raw.ticketState} ticket is missing durable supervisor state`, raw.ticketState === "started");
  }
  if (state.ticketId !== raw.expected.ticketId
    || state.authorizationDigest !== raw.expected.authorizationDigest
    || state.generation !== raw.expected.generation
    || state.releaseDigest !== raw.expected.releaseDigest) {
    return stop(observation, "Supervisor state binding differs from the active ticket and release", true);
  }
  if (state.bootId !== observation.currentBootId) {
    return stop(observation, "Supervisor monotonic deadline belongs to another boot", true);
  }
  if (observation.nowMonotonicMs >= state.monotonicDeadlineMs) {
    return stop(observation, "Qualification monotonic deadline elapsed");
  }
  if (state.cgroupId.length === 0 || !observation.timerArmed) {
    return stop(observation, "Qualification cgroup or independent deadline timer is unavailable", true);
  }
  if (raw.ticketState === "accepted") {
    return stop(observation, "Accepted ticket left partial supervisor state during launch");
  }
  if (raw.ticketState === "armed") {
    return stop(observation, "Armed ticket did not reach a durable started transition before reconciliation");
  }

  const validExec = state.phase === "exec_released"
    && state.startedHeadSha256 !== null
    && observation.cgroupExists
    && observation.wrapperProcessExists
    && observation.runnerExecObserved
    && observation.descendantCount > 0;
  if (!validExec) {
    return stop(observation, "Started ticket lacks a complete and observed exec-release chain", observation.runnerExecObserved);
  }
  return {
    action: "continue_running",
    reason: "Started ticket, exec barrier, cgroup, and independent deadline agree",
    outputReleaseAllowed: false,
  };
}
