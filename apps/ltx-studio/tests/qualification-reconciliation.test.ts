import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decideQualificationReconciliation,
  type QualificationRuntimeObservation,
  type QualificationSupervisorState,
} from "../server/qualificationReconciliation.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const expected = {
  ticketId: "r0l-ticket-001",
  authorizationDigest: sha("authorization"),
  generation: 1,
  releaseDigest: sha("release"),
};
const state: QualificationSupervisorState = {
  schemaVersion: "ltx-studio-qualification-supervisor-state.v1",
  ...expected,
  cgroupId: "qgroup-r0l-001",
  bootId: "boot-identifier-001",
  monotonicDeadlineMs: 20_000,
  phase: "exec_released",
  wrapperId: "wrapper-r0l-001",
  wrapperPid: 4242,
  startedHeadSha256: sha("started-head"),
};
const observation: QualificationRuntimeObservation = {
  currentBootId: state.bootId,
  nowMonotonicMs: 10_000,
  cgroupExists: true,
  wrapperProcessExists: true,
  runnerExecObserved: true,
  descendantCount: 1,
  openGpuDeviceFds: 1,
  timerArmed: true,
};

function decide(overrides: {
  ticketState?: "pending" | "accepted" | "armed" | "started" | "terminal";
  state?: QualificationSupervisorState | null;
  observation?: QualificationRuntimeObservation;
  expected?: typeof expected;
} = {}) {
  return decideQualificationReconciliation({
    ticketState: overrides.ticketState ?? "started",
    expected: overrides.expected ?? expected,
    supervisorState: overrides.state === undefined ? state : overrides.state,
    observation: overrides.observation ?? observation,
  });
}

describe("qualification supervisor restart reconciliation", () => {
  it("continues only a fully observed exec-release chain", () => {
    expect(decide()).toEqual({
      action: "continue_running",
      reason: "Started ticket, exec barrier, cgroup, and independent deadline agree",
      outputReleaseAllowed: false,
    });
  });

  it.each([
    ["accepted", "prepared"],
    ["accepted", "deadline_armed"],
    ["armed", "deadline_armed"],
    ["armed", "blocked_wrapper"],
  ] as const)("kills a crash residue at ticket=%s supervisor=%s", (ticketState, phase) => {
    const partial: QualificationSupervisorState = {
      ...state,
      phase,
      wrapperId: phase === "blocked_wrapper" ? state.wrapperId : null,
      wrapperPid: phase === "blocked_wrapper" ? state.wrapperPid : null,
      startedHeadSha256: null,
    };
    expect(decide({ ticketState, state: partial }).action).toBe("kill_cgroup_and_terminalize");
  });

  it("holds and kills an observed exec without a valid exec-release state", () => {
    const blocked: QualificationSupervisorState = { ...state, phase: "blocked_wrapper", startedHeadSha256: null };
    expect(decide({ state: blocked })).toMatchObject({ action: "kill_cgroup_and_hold", outputReleaseAllowed: false });
  });

  it("kills when the persistent monotonic deadline expires without heartbeats", () => {
    expect(decide({
      observation: { ...observation, nowMonotonicMs: state.monotonicDeadlineMs },
    })).toMatchObject({ action: "kill_cgroup_and_terminalize", outputReleaseAllowed: false });
  });

  it("holds a monotonic deadline restored from another boot", () => {
    expect(decide({
      observation: { ...observation, currentBootId: "boot-identifier-002" },
    })).toMatchObject({ action: "kill_cgroup_and_hold", outputReleaseAllowed: false });
  });

  it("holds cross-release or cross-authorization supervisor state", () => {
    expect(decide({ expected: { ...expected, releaseDigest: sha("other-release") } }))
      .toMatchObject({ action: "kill_cgroup_and_hold", outputReleaseAllowed: false });
  });

  it("allows an accepted ticket with no artifacts to wait for its supervisor", () => {
    expect(decide({
      ticketState: "accepted",
      state: null,
      observation: {
        ...observation,
        cgroupExists: false,
        wrapperProcessExists: false,
        runnerExecObserved: false,
        descendantCount: 0,
        openGpuDeviceFds: 0,
        timerArmed: false,
      },
    }).action).toBe("wait_for_supervisor");
  });

  it("cleans descendants and GPU descriptors after a terminal ticket", () => {
    expect(decide({ ticketState: "terminal" })).toMatchObject({
      action: "cleanup_terminal_cgroup",
      outputReleaseAllowed: false,
    });
  });
});
