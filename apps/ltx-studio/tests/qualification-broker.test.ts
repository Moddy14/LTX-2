import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  activationEnvelopeDigest,
  activationRecordDigest,
  type ActivationJournalEnvelope,
  type RuntimeActivationSnapshot,
} from "../shared/activation.js";
import {
  QualificationBrokerClient,
  QualificationBrokerDeniedError,
  type QualificationBrokerRequest,
  type QualificationBrokerTransport,
} from "../server/qualificationBroker.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const releaseDigest = sha("release");
const surfaceDigest = sha("surface");
const runtimeInstallSealSha256 = sha("runtime-seal");
const runtimeTreeSha256 = sha("runtime-tree");
const runtimePolicySha256 = sha("runtime-policy");
const nodeExecutableSha256 = sha("node-executable");
const previousHead = sha("previous-head");
const requestId = "00000000-0000-4000-8000-000000000100";
const claim = {
  authorizationDigest: sha("authorization"),
  authorizationId: "qualification-r0l-001",
  authorizationNonce: "a".repeat(32),
  ticketId: "r0l-ticket-001",
  ticketNonce: "b".repeat(32),
  purposeId: "r0l-live-canary",
  phaseId: "r0l",
  matrixDigest: sha("matrix"),
  surfaceEntryId: "native-generation.text-to-video",
  inputDigest: sha("input"),
  seed: 42,
};

function request(action: QualificationBrokerRequest["action"] = "accept"): QualificationBrokerRequest {
  return {
    schemaVersion: "ltx-studio-qualification-broker-request.v3",
    requestId,
    action,
    requestedAt: "2026-08-15T00:05:00Z",
    expectedGeneration: 1,
    expectedHeadSha256: previousHead,
    expectedReleaseDigest: releaseDigest,
    expectedSurfaceDigest: surfaceDigest,
    expectedRuntimeInstallSealSha256: runtimeInstallSealSha256,
    expectedRuntimeTreeSha256: runtimeTreeSha256,
    expectedRuntimePolicySha256: runtimePolicySha256,
    expectedNodeExecutableSha256: nodeExecutableSha256,
    expectedRuntimeTrust: runtimeTrustFixture,
    claim,
    terminal: action === "terminalize"
      ? { outcome: "cancelled", outputDigest: null, reason: "operator cancelled" }
      : null,
  };
}

function committedEnvelope(
  action: QualificationBrokerRequest["action"] = "accept",
): ActivationJournalEnvelope {
  const operation = {
    accept: "accept_run_ticket",
    arm: "arm_run_ticket",
    start: "start_run_ticket",
    terminalize: "terminalize_run_ticket",
  } as const;
  const ticketState = { accept: "accepted", arm: "armed", start: "started", terminalize: "terminal" } as const;
  const record = {
    schemaVersion: "ltx-studio-activation-journal-record.v3" as const,
    recordId: requestId,
    sequence: 4,
    generation: 1,
    previousRecordSha256: previousHead,
    previousState: "qualification_only" as const,
    state: "qualification_only" as const,
    operation: operation[action],
    release: {
      releaseDigest,
      surfaceDigest,
      runtimeInstallSealSha256,
      runtimeTreeSha256,
      runtimePolicySha256,
      nodeExecutableSha256,
      runtimeTrust: runtimeTrustFixture,
      rights: {
        policyEvidenceDigest: sha("rights"),
        attestationSeriesId: "rights-series-001",
        minimumSnapshotVersion: 3,
      },
    },
    releasedSurfaceEntryIds: [],
    authorizationDigest: claim.authorizationDigest,
    auditEnvelopeDigest: null,
    evidenceDigest: null,
    ticketId: claim.ticketId,
    ticketState: ticketState[action],
    ticketTerminal: action === "terminalize"
      ? { outcome: "cancelled" as const, outputDigest: null, reason: "operator cancelled" }
      : null,
    supersedePreflight: null,
    recordedAt: "2026-08-15T00:05:01Z",
    writerKeyId: "activation-writer-001",
  };
  return {
    record,
    signature: {
      schemaVersion: "ltx-studio-detached-signature.v1",
      algorithm: "ed25519",
      role: "activation-journal-writer",
      keyId: record.writerKeyId,
      payloadSha256: activationRecordDigest(record),
      signatureBase64: "broker-test-signature",
    },
  };
}

function snapshot(head = previousHead): RuntimeActivationSnapshot {
  return {
    state: "qualification_only",
    generation: 1,
    activationHeadSha256: head,
    releaseDigest,
    surfaceDigest,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust: runtimeTrustFixture,
    rightsCurrent: true,
    releasedSurfaceEntryIds: [],
  };
}

function fixture(action: QualificationBrokerRequest["action"] = "accept") {
  const envelope = committedEnvelope(action);
  const snapshots = [snapshot(), snapshot(activationEnvelopeDigest(envelope))];
  const activation = { read: vi.fn(() => snapshots.shift() ?? snapshot(activationEnvelopeDigest(envelope))) };
  const transport: QualificationBrokerTransport = {
    exchange: vi.fn(async (sent) => ({
      schemaVersion: "ltx-studio-qualification-broker-receipt.v1",
      requestId: sent.requestId,
      action: sent.action,
      committed: true,
      code: "committed",
      reason: "ticket transition committed",
      envelope,
    })),
  };
  const verifyEnvelope = vi.fn();
  return { client: new QualificationBrokerClient(transport, activation, verifyEnvelope), transport, activation, verifyEnvelope, envelope };
}

describe("qualification broker client", () => {
  it.each(["accept", "arm", "start", "terminalize"] as const)(
    "accepts only a signed and anchored %s transition",
    async (action) => {
      const data = fixture(action);
      await expect(data.client.transition(request(action))).resolves.toMatchObject({ committed: true, action });
      expect(data.verifyEnvelope).toHaveBeenCalledWith(data.envelope);
      expect(data.activation.read).toHaveBeenCalledTimes(2);
    },
  );

  it("does not contact the writer when the expected activation head is stale", async () => {
    const data = fixture();
    const stale = { ...request(), expectedHeadSha256: sha("stale") };
    await expect(data.client.transition(stale)).rejects.toThrow(/stale activation binding/);
    expect(data.transport.exchange).not.toHaveBeenCalled();
  });

  it("rejects a response for another ticket before trusting the new head", async () => {
    const data = fixture();
    data.envelope.record.ticketId = "r0l-ticket-foreign";
    data.envelope.signature.payloadSha256 = activationRecordDigest(data.envelope.record);
    await expect(data.client.transition(request())).rejects.toThrow(/ticket transition binding mismatch/);
  });

  it("rejects a signed response that is not the externally anchored runtime head", async () => {
    const data = fixture();
    data.activation.read
      .mockReset()
      .mockReturnValueOnce(snapshot())
      .mockReturnValueOnce(snapshot(sha("different-anchored-head")));
    await expect(data.client.transition(request())).rejects.toThrow(/not the verified anchored runtime head/);
  });

  it("preserves a fail-closed broker denial code", async () => {
    const data = fixture();
    vi.mocked(data.transport.exchange).mockResolvedValueOnce({
      schemaVersion: "ltx-studio-qualification-broker-receipt.v1",
      requestId,
      action: "accept",
      committed: false,
      code: "deadline",
      reason: "start_by elapsed",
      envelope: null,
    });
    await expect(data.client.transition(request())).rejects.toEqual(
      new QualificationBrokerDeniedError("deadline", "start_by elapsed"),
    );
  });

  it("rejects malformed terminalization requests before transport", async () => {
    const data = fixture("terminalize");
    await expect(data.client.transition({ ...request("terminalize"), terminal: null })).rejects.toThrow();
    expect(data.transport.exchange).not.toHaveBeenCalled();
  });
});
