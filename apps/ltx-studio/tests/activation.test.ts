import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  activationEnvelopeDigest,
  activationRecordDigest,
  qualificationAuthorizationSchema,
  runtimeActivationSnapshot,
  validateActivationJournal,
  verifyActivationEnvelopeSignature,
  type ActivationJournalEnvelope,
  type ActivationJournalRecord,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const release = (releaseDigest = sha("release")) => ({
  releaseDigest,
  surfaceDigest: sha("surface"),
  rights: {
    policyEvidenceDigest: sha("rights"),
    attestationSeriesId: "rights-series-001",
    minimumSnapshotVersion: 3,
  },
});

function envelope(record: ActivationJournalRecord): ActivationJournalEnvelope {
  return {
    record,
    signature: {
      schemaVersion: "ltx-studio-detached-signature.v1",
      algorithm: "ed25519",
      role: "activation-journal-writer",
      keyId: record.writerKeyId,
      payloadSha256: activationRecordDigest(record),
      signatureBase64: "structural-test-signature",
    },
  };
}

function bootstrap(): ActivationJournalEnvelope {
  return envelope({
    schemaVersion: "ltx-studio-activation-journal-record.v1",
    recordId: "00000000-0000-4000-8000-000000000001",
    sequence: 0,
    generation: 1,
    previousRecordSha256: null,
    previousState: null,
    state: "blocked",
    operation: "bootstrap_generation",
    release: release(),
    releasedSurfaceEntryIds: [],
    authorizationDigest: null,
    auditEnvelopeDigest: null,
    evidenceDigest: null,
    ticketId: null,
    ticketState: null,
    ticketTerminal: null,
    supersedePreflight: null,
    recordedAt: "2026-08-15T00:00:00Z",
    writerKeyId: "activation-writer-001",
  });
}

describe("activation contracts", () => {
  it("accepts a bounded, sorted qualification authorization", () => {
    expect(qualificationAuthorizationSchema.parse({
      schemaVersion: "qualification-authorization.v1",
      authorizationId: "qualification-r0l-001",
      generation: 1,
      release: release(),
      signerKeyId: "qualification-authorizer-001",
      signerRole: "qualification-authorizer",
      issuedAt: "2026-08-15T00:00:00Z",
      notBefore: "2026-08-15T00:01:00Z",
      startBy: "2026-08-15T00:10:00Z",
      completeBy: "2026-08-15T00:30:00Z",
      nonce: "a".repeat(32),
      purposeId: "r0l-live-canary",
      phaseId: "r0l",
      matrixDigest: sha("matrix"),
      allowedRecoveryDigest: sha("recovery"),
      revocationSourceDigest: sha("revocations"),
      sameSeriesSuccessorAllowed: true,
      totalBudget: { jobCount: 1, gpuSeconds: 120, outputBytes: 1024 },
      runTickets: [{
        ticketId: "r0l-ticket-001",
        nonce: "b".repeat(32),
        surfaceEntryId: "native-generation.text-to-video",
        inputDigest: sha("input"),
        seed: 42,
        budget: { jobCount: 1, gpuSeconds: 100, outputBytes: 1000 },
      }],
    }).runTickets).toHaveLength(1);
  });

  it("rejects inconsistent time windows and aggregate ticket budgets", () => {
    const invalid = {
      schemaVersion: "qualification-authorization.v1",
      authorizationId: "qualification-r0l-001",
      generation: 1,
      release: release(),
      signerKeyId: "qualification-authorizer-001",
      signerRole: "qualification-authorizer",
      issuedAt: "2026-08-15T00:00:00Z",
      notBefore: "2026-08-15T00:20:00Z",
      startBy: "2026-08-15T00:10:00Z",
      completeBy: "2026-08-15T00:30:00Z",
      nonce: "a".repeat(32),
      purposeId: "r0l-live-canary",
      phaseId: "r0l",
      matrixDigest: sha("matrix"),
      allowedRecoveryDigest: sha("recovery"),
      revocationSourceDigest: sha("revocations"),
      sameSeriesSuccessorAllowed: false,
      totalBudget: { jobCount: 2, gpuSeconds: 1, outputBytes: 1 },
      runTickets: [{
        ticketId: "r0l-ticket-001",
        nonce: "b".repeat(32),
        surfaceEntryId: "native-generation.text-to-video",
        inputDigest: sha("input"),
        seed: 42,
        budget: { jobCount: 1, gpuSeconds: 100, outputBytes: 1000 },
      }],
    };
    expect(() => qualificationAuthorizationSchema.parse(invalid)).toThrow();
  });

  it("validates a bound state transition and rejects a changed release without supersede", () => {
    const first = bootstrap();
    const second = envelope({
      ...first.record,
      recordId: "00000000-0000-4000-8000-000000000002",
      sequence: 1,
      previousRecordSha256: activationEnvelopeDigest(first),
      previousState: "blocked",
      state: "qualification_only",
      operation: "activate_qualification_mode",
      authorizationDigest: sha("mode-authorization"),
      recordedAt: "2026-08-15T00:01:00Z",
    });
    expect(validateActivationJournal([first, second]).at(-1)?.record.state).toBe("qualification_only");

    const changed = structuredClone(second);
    changed.record.release.releaseDigest = sha("other-release");
    changed.signature.payloadSha256 = activationRecordDigest(changed.record);
    expect(() => validateActivationJournal([first, changed])).toThrow(/changed generation or release/);
  });

  it("requires a higher generation and exact old head for release supersede", () => {
    const first = bootstrap();
    const nextRelease = release(sha("next-release"));
    const second = envelope({
      ...first.record,
      recordId: "00000000-0000-4000-8000-000000000003",
      sequence: 1,
      generation: 2,
      previousRecordSha256: activationEnvelopeDigest(first),
      previousState: "blocked",
      state: "blocked",
      operation: "supersede_release_generation",
      release: nextRelease,
      supersedePreflight: {
        previousGeneration: 1,
        previousHeadSha256: activationEnvelopeDigest(first),
        supersededReleaseDigest: first.record.release.releaseDigest,
        armedTickets: 0,
        startedTickets: 0,
        blockedWrappers: 0,
        processCgroups: 0,
        closedTicketIds: [],
      },
      recordedAt: "2026-08-15T01:00:00Z",
    });
    expect(validateActivationJournal([first, second]).at(-1)?.record.generation).toBe(2);
    expect(canonicalJson(second.record.release)).not.toBe(canonicalJson(first.record.release));
  });

  it("rejects a ticket start that skips registration, acceptance, and arming", () => {
    const first = bootstrap();
    const mode = envelope({
      ...first.record,
      recordId: "00000000-0000-4000-8000-000000000004",
      sequence: 1,
      previousRecordSha256: activationEnvelopeDigest(first),
      previousState: "blocked",
      state: "qualification_only",
      operation: "activate_qualification_mode",
      authorizationDigest: sha("mode-authorization"),
      recordedAt: "2026-08-15T00:01:00Z",
    });
    const invalid = envelope({
      ...mode.record,
      recordId: "00000000-0000-4000-8000-000000000005",
      sequence: 2,
      previousRecordSha256: activationEnvelopeDigest(mode),
      previousState: "qualification_only",
      state: "qualification_only",
      operation: "start_run_ticket",
      authorizationDigest: sha("unregistered-authorization"),
      ticketId: "r0l-ticket-001",
      ticketState: "started",
      recordedAt: "2026-08-15T00:02:00Z",
    });
    expect(() => validateActivationJournal([first, mode, invalid])).toThrow(/unregistered/);
  });

  it("cryptographically verifies the dedicated activation-writer role and rejects payload drift", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const signed = bootstrap();
    signed.signature.signatureBase64 = sign(
      null,
      Buffer.from(canonicalJson(signed.record)),
      privateKey,
    ).toString("base64");
    const policy = {
      schemaVersion: "ltx-studio-activation-writer-trust.v1",
      policyId: "activation-trust-001",
      keys: [{
        keyId: signed.record.writerKeyId,
        algorithm: "ed25519",
        role: "activation-journal-writer",
        publicKeyBase64: rawPublicKey.toString("base64"),
        notBefore: "2026-08-14T00:00:00Z",
        notAfter: "2026-08-16T00:00:00Z",
        revokedAt: null,
      }],
    };

    expect(verifyActivationEnvelopeSignature(signed, policy, new Date("2026-08-15T00:00:00Z"))).toEqual(signed);
    signed.record.recordedAt = "2026-08-15T00:00:01Z";
    expect(() => verifyActivationEnvelopeSignature(signed, policy, new Date("2026-08-15T00:00:00Z")))
      .toThrow(/binding mismatch/);
  });

  it("derives the runtime state and released surface set from the signed journal head", () => {
    const first = bootstrap();
    const mode = envelope({
      ...first.record,
      recordId: "00000000-0000-4000-8000-000000000006",
      sequence: 1,
      previousRecordSha256: activationEnvelopeDigest(first),
      previousState: "blocked",
      state: "qualification_only",
      operation: "activate_qualification_mode",
      authorizationDigest: sha("mode-authorization"),
      recordedAt: "2026-08-15T00:01:00Z",
    });
    const promotion = envelope({
      ...mode.record,
      recordId: "00000000-0000-4000-8000-000000000007",
      sequence: 2,
      previousRecordSha256: activationEnvelopeDigest(mode),
      previousState: "qualification_only",
      state: "production_provisional",
      operation: "promote_production",
      releasedSurfaceEntryIds: ["native-generation.text-to-video"],
      authorizationDigest: sha("release-authorization"),
      auditEnvelopeDigest: sha("audit-envelope"),
      recordedAt: "2026-08-15T00:02:00Z",
    });

    expect(runtimeActivationSnapshot([first, mode, promotion], true)).toEqual({
      state: "production_provisional",
      generation: 1,
      activationHeadSha256: activationEnvelopeDigest(promotion),
      releaseDigest: release().releaseDigest,
      surfaceDigest: release().surfaceDigest,
      rightsCurrent: true,
      releasedSurfaceEntryIds: ["native-generation.text-to-video"],
    });
  });
});
