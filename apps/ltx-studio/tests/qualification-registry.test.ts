import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  activationEnvelopeDigest,
  activationRecordDigest,
  qualificationAuthorizationDigest,
  qualificationAuthorizationSchema,
  validateActivationJournal,
  type ActivationJournalEnvelope,
  type ActivationJournalRecord,
  type ActivationOperation,
  type QualificationTicketState,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  inspectQualificationTicket,
  type QualificationTicketCheckpoint,
  type QualificationTicketClaim,
} from "../shared/qualificationRegistry.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const release = {
  releaseDigest: sha("release"),
  surfaceDigest: sha("surface"),
  rights: {
    policyEvidenceDigest: sha("rights"),
    attestationSeriesId: "rights-series-001",
    minimumSnapshotVersion: 3,
  },
};

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

function append(
  journal: ActivationJournalEnvelope[],
  operation: ActivationOperation,
  overrides: Partial<ActivationJournalRecord> = {},
): ActivationJournalEnvelope[] {
  const previous = journal.at(-1)!.record;
  const ticketStateByOperation: Partial<Record<ActivationOperation, QualificationTicketState>> = {
    accept_run_ticket: "accepted",
    arm_run_ticket: "armed",
    start_run_ticket: "started",
    terminalize_run_ticket: "terminal",
  };
  const next = envelope({
    ...previous,
    recordId: `00000000-0000-4000-8000-${String(journal.length + 1).padStart(12, "0")}`,
    sequence: journal.length,
    previousRecordSha256: activationEnvelopeDigest(journal.at(-1)!),
    previousState: previous.state,
    operation,
    ticketState: ticketStateByOperation[operation] ?? null,
    recordedAt: `2026-08-15T00:${String(journal.length + 1).padStart(2, "0")}:00Z`,
    ...overrides,
  });
  return [...journal, next];
}

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const authorization = qualificationAuthorizationSchema.parse({
    schemaVersion: "qualification-authorization.v1",
    authorizationId: "qualification-r0l-001",
    generation: 1,
    release,
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
  });
  const authorizationDigest = qualificationAuthorizationDigest(authorization);
  const signedAuthorization = {
    document: authorization,
    signature: {
      schemaVersion: "ltx-studio-detached-signature.v1" as const,
      algorithm: "ed25519" as const,
      role: "qualification-authorizer" as const,
      keyId: authorization.signerKeyId,
      payloadSha256: authorizationDigest,
      signatureBase64: sign(null, Buffer.from(canonicalJson(authorization)), privateKey).toString("base64"),
    },
  };
  const trustPolicy = {
    schemaVersion: "ltx-studio-qualification-authorizer-trust.v1",
    policyId: "qualification-trust-001",
    keys: [{
      keyId: authorization.signerKeyId,
      algorithm: "ed25519",
      role: "qualification-authorizer",
      publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
      notBefore: "2026-08-14T00:00:00Z",
      notAfter: "2026-08-16T00:00:00Z",
      revokedAt: null,
    }],
  };
  const first = envelope({
    schemaVersion: "ltx-studio-activation-journal-record.v1",
    recordId: "00000000-0000-4000-8000-000000000001",
    sequence: 0,
    generation: 1,
    previousRecordSha256: null,
    previousState: null,
    state: "blocked",
    operation: "bootstrap_generation",
    release,
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
  let journal = append([first], "activate_qualification_mode", {
    state: "qualification_only",
    authorizationDigest: sha("mode-authorization"),
  });
  journal = append(journal, "register_qualification_authorization", { authorizationDigest });
  const ticket = authorization.runTickets[0];
  const claim: QualificationTicketClaim = {
    authorizationDigest,
    authorizationId: authorization.authorizationId,
    authorizationNonce: authorization.nonce,
    ticketId: ticket.ticketId,
    ticketNonce: ticket.nonce,
    purposeId: authorization.purposeId,
    phaseId: authorization.phaseId,
    matrixDigest: authorization.matrixDigest,
    surfaceEntryId: ticket.surfaceEntryId,
    inputDigest: ticket.inputDigest,
    seed: ticket.seed,
  };
  return { authorization, authorizationDigest, signedAuthorization, trustPolicy, journal, claim };
}

function inspect(
  data: ReturnType<typeof fixture>,
  journal: ActivationJournalEnvelope[],
  checkpoint: QualificationTicketCheckpoint,
  now = "2026-08-15T00:05:00Z",
  claim: QualificationTicketClaim = data.claim,
) {
  return inspectQualificationTicket({
    journal,
    signedAuthorizations: [data.signedAuthorization],
    trustPolicy: data.trustPolicy,
    claim,
    checkpoint,
    now: new Date(now),
  });
}

describe("qualification ticket registry", () => {
  it("requires each durable ticket state at its corresponding execution barrier", () => {
    const data = fixture();
    expect(inspect(data, data.journal, "queue_accept").allowed).toBe(true);

    const accepted = append(data.journal, "accept_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    expect(inspect(data, accepted, "supervisor_arm").allowed).toBe(true);
    expect(inspect(data, accepted, "queue_accept")).toMatchObject({ allowed: false, state: "accepted" });

    const armed = append(accepted, "arm_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    expect(inspect(data, armed, "writer_start").allowed).toBe(true);

    const started = append(armed, "start_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    for (const checkpoint of ["runner_exec", "heartbeat", "segment_boundary", "output_release"] as const) {
      expect(inspect(data, started, checkpoint).allowed).toBe(true);
    }
  });

  it.each([
    ["surfaceEntryId", "native-generation.image-to-video"],
    ["inputDigest", sha("different-input")],
    ["seed", 43],
    ["ticketNonce", "c".repeat(32)],
    ["phaseId", "q0-quality"],
    ["matrixDigest", sha("different-matrix")],
  ] as const)("rejects a cross-binding claim for %s", (field, value) => {
    const data = fixture();
    const claim = { ...data.claim, [field]: value };
    expect(inspect(data, data.journal, "queue_accept", undefined, claim)).toMatchObject({
      allowed: false,
      reason: "Qualification ticket claim does not match its signed authorization",
    });
  });

  it("enforces notBefore, startBy, and completeBy at their execution barriers", () => {
    const data = fixture();
    expect(inspect(data, data.journal, "queue_accept", "2026-08-15T00:00:30Z").reason).toMatch(/not active/);
    expect(inspect(data, data.journal, "queue_accept", "2026-08-15T00:10:01Z").reason).toMatch(/startBy/);

    const accepted = append(data.journal, "accept_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    const armed = append(accepted, "arm_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    const started = append(armed, "start_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    expect(inspect(data, started, "heartbeat", "2026-08-15T00:30:01Z").reason).toMatch(/completeBy/);
  });

  it("fails closed when a registered authorization document is missing", () => {
    const data = fixture();
    expect(() => inspectQualificationTicket({
      journal: data.journal,
      signedAuthorizations: [],
      trustPolicy: data.trustPolicy,
      claim: data.claim,
      checkpoint: "queue_accept",
      now: new Date("2026-08-15T00:05:00Z"),
    })).toThrow(/missing from the verified catalog/);
  });

  it("fails closed when a journal ticket is absent from its signed authorization", () => {
    const data = fixture();
    const journal = append(data.journal, "accept_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: "r0l-ticket-foreign",
    });
    expect(() => inspect(data, journal, "queue_accept")).toThrow(/not present in its signed authorization/);
  });

  it("rejects moving one ticket across authorizations in the same generation", () => {
    const data = fixture();
    const secondDigest = sha("second-run-authorization");
    const registeredTwice = append(data.journal, "register_qualification_authorization", {
      authorizationDigest: secondDigest,
    });
    const accepted = append(registeredTwice, "accept_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    const crossAuthorizationArm = append(accepted, "arm_run_ticket", {
      authorizationDigest: secondDigest,
      ticketId: data.claim.ticketId,
    });
    expect(() => validateActivationJournal(crossAuthorizationArm)).toThrow(/across run authorizations/);
  });

  it("opens a fresh authorization and ticket namespace after release supersede", () => {
    const data = fixture();
    const accepted = append(data.journal, "accept_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
    });
    const terminal = append(accepted, "terminalize_run_ticket", {
      authorizationDigest: data.authorizationDigest,
      ticketId: data.claim.ticketId,
      ticketTerminal: { outcome: "cancelled", outputDigest: null, reason: "generation closed" },
    });
    const previousHead = activationEnvelopeDigest(terminal.at(-1)!);
    const nextRelease = { ...release, releaseDigest: sha("next-release") };
    let nextGeneration = append(terminal, "supersede_release_generation", {
      generation: 2,
      state: "blocked",
      release: nextRelease,
      authorizationDigest: null,
      ticketId: null,
      ticketState: null,
      ticketTerminal: null,
      supersedePreflight: {
        previousGeneration: 1,
        previousHeadSha256: previousHead,
        supersededReleaseDigest: release.releaseDigest,
        armedTickets: 0,
        startedTickets: 0,
        blockedWrappers: 0,
        processCgroups: 0,
        closedTicketIds: [],
      },
    });
    nextGeneration = append(nextGeneration, "activate_qualification_mode", {
      state: "qualification_only",
      authorizationDigest: sha("next-mode-authorization"),
      supersedePreflight: null,
    });
    const nextAuthorizationDigest = sha("next-run-authorization");
    nextGeneration = append(nextGeneration, "register_qualification_authorization", {
      authorizationDigest: nextAuthorizationDigest,
    });
    nextGeneration = append(nextGeneration, "accept_run_ticket", {
      authorizationDigest: nextAuthorizationDigest,
      ticketId: data.claim.ticketId,
    });

    expect(validateActivationJournal(nextGeneration).at(-1)?.record.generation).toBe(2);
  });
});
