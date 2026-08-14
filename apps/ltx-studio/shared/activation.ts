import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import { trustedKeyPolicySchema, verifyDetachedSignature } from "./releaseAudit.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });

export const activationStates = [
  "blocked",
  "qualification_only",
  "production_provisional",
  "production_stable",
  "hold",
  "rolled_back",
] as const;
export type ActivationState = (typeof activationStates)[number];

export const ticketStates = [
  "pending",
  "accepted",
  "armed",
  "started",
  "terminal",
] as const;
export type QualificationTicketState = (typeof ticketStates)[number];

export const rightsSeriesBindingSchema = z.object({
  policyEvidenceDigest: sha256Schema,
  attestationSeriesId: identifierSchema,
  minimumSnapshotVersion: z.number().int().nonnegative(),
}).strict();

export const activationReleaseBindingSchema = z.object({
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  rights: rightsSeriesBindingSchema,
}).strict();

const runBudgetSchema = z.object({
  jobCount: z.number().int().positive(),
  gpuSeconds: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
}).strict();

export const qualificationRunTicketSchema = z.object({
  ticketId: identifierSchema,
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  surfaceEntryId: identifierSchema,
  inputDigest: sha256Schema,
  seed: z.number().int().nonnegative(),
  budget: runBudgetSchema.extend({ jobCount: z.literal(1) }).strict(),
}).strict();

export const qualificationAuthorizationSchema = z.object({
  schemaVersion: z.literal("qualification-authorization.v1"),
  authorizationId: identifierSchema,
  generation: z.number().int().positive(),
  release: activationReleaseBindingSchema,
  signerKeyId: identifierSchema,
  signerRole: z.literal("qualification-authorizer"),
  issuedAt: timestampSchema,
  notBefore: timestampSchema,
  startBy: timestampSchema,
  completeBy: timestampSchema,
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  purposeId: identifierSchema,
  phaseId: identifierSchema,
  matrixDigest: sha256Schema,
  allowedRecoveryDigest: sha256Schema,
  revocationSourceDigest: sha256Schema,
  sameSeriesSuccessorAllowed: z.boolean(),
  totalBudget: runBudgetSchema,
  runTickets: z.array(qualificationRunTicketSchema).min(1),
}).strict().superRefine((authorization, context) => {
  const times = [
    authorization.issuedAt,
    authorization.notBefore,
    authorization.startBy,
    authorization.completeBy,
  ].map(Date.parse);
  if (!(times[0] <= times[1] && times[1] <= times[2] && times[2] <= times[3])) {
    context.addIssue({ code: "custom", path: ["completeBy"], message: "authorization time window is inconsistent" });
  }
  const ids = authorization.runTickets.map(({ ticketId }) => ticketId);
  const nonces = authorization.runTickets.map(({ nonce }) => nonce);
  if (new Set(ids).size !== ids.length || new Set(nonces).size !== nonces.length) {
    context.addIssue({ code: "custom", path: ["runTickets"], message: "ticket ids and nonces must be unique" });
  }
  if (ids.some((id, index) => index > 0 && ids[index - 1] >= id)) {
    context.addIssue({ code: "custom", path: ["runTickets"], message: "run tickets must be strictly sorted by id" });
  }
  const gpuSeconds = authorization.runTickets.reduce((sum, ticket) => sum + ticket.budget.gpuSeconds, 0);
  const outputBytes = authorization.runTickets.reduce((sum, ticket) => sum + ticket.budget.outputBytes, 0);
  if (authorization.totalBudget.jobCount !== authorization.runTickets.length
    || gpuSeconds > authorization.totalBudget.gpuSeconds
    || outputBytes > authorization.totalBudget.outputBytes) {
    context.addIssue({ code: "custom", path: ["totalBudget"], message: "ticket budgets exceed the authorization budget" });
  }
});

export const qualificationModeAuthorizationSchema = z.object({
  schemaVersion: z.literal("qualification-mode-authorization.v1"),
  authorizationId: identifierSchema,
  generation: z.number().int().positive(),
  release: activationReleaseBindingSchema,
  signerKeyId: identifierSchema,
  signerRole: z.literal("qualification-authorizer"),
  issuedAt: timestampSchema,
  notBefore: timestampSchema,
  expiresAt: timestampSchema,
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
}).strict().superRefine((authorization, context) => {
  if (!(Date.parse(authorization.issuedAt) <= Date.parse(authorization.notBefore)
    && Date.parse(authorization.notBefore) < Date.parse(authorization.expiresAt))) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "mode authorization time window is inconsistent" });
  }
});

export const activationOperations = [
  "bootstrap_generation",
  "activate_qualification_mode",
  "register_qualification_authorization",
  "accept_run_ticket",
  "arm_run_ticket",
  "start_run_ticket",
  "terminalize_run_ticket",
  "promote_production",
  "stabilize_production",
  "enter_hold",
  "mark_rolled_back",
  "supersede_release_generation",
] as const;
export type ActivationOperation = (typeof activationOperations)[number];

const supersedePreflightSchema = z.object({
  previousGeneration: z.number().int().positive(),
  previousHeadSha256: sha256Schema,
  supersededReleaseDigest: sha256Schema,
  armedTickets: z.literal(0),
  startedTickets: z.literal(0),
  blockedWrappers: z.literal(0),
  processCgroups: z.literal(0),
  closedTicketIds: z.array(identifierSchema),
}).strict().superRefine((preflight, context) => {
  if (new Set(preflight.closedTicketIds).size !== preflight.closedTicketIds.length
    || preflight.closedTicketIds.some((id, index) => index > 0 && preflight.closedTicketIds[index - 1] >= id)) {
    context.addIssue({ code: "custom", path: ["closedTicketIds"], message: "closed tickets must be unique and sorted" });
  }
});

export const activationJournalRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-activation-journal-record.v1"),
  recordId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  previousRecordSha256: sha256Schema.nullable(),
  previousState: z.enum(activationStates).nullable(),
  state: z.enum(activationStates),
  operation: z.enum(activationOperations),
  release: activationReleaseBindingSchema,
  releasedSurfaceEntryIds: z.array(identifierSchema),
  authorizationDigest: sha256Schema.nullable(),
  auditEnvelopeDigest: sha256Schema.nullable(),
  evidenceDigest: sha256Schema.nullable(),
  ticketId: identifierSchema.nullable(),
  ticketState: z.enum(ticketStates).nullable(),
  ticketTerminal: z.object({
    outcome: z.enum(["completed", "failed", "cancelled", "expired", "revoked", "killed", "closed_by_supersede"]),
    outputDigest: sha256Schema.nullable(),
    reason: z.string().min(1).max(1000),
  }).strict().nullable(),
  supersedePreflight: supersedePreflightSchema.nullable(),
  recordedAt: timestampSchema,
  writerKeyId: identifierSchema,
}).strict().superRefine((record, context) => {
  const fail = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (new Set(record.releasedSurfaceEntryIds).size !== record.releasedSurfaceEntryIds.length
    || record.releasedSurfaceEntryIds.some((id, index) => index > 0 && record.releasedSurfaceEntryIds[index - 1] >= id)) {
    fail("releasedSurfaceEntryIds", "released surface entries must be unique and sorted");
  }
  if (record.sequence === 0 ? record.previousRecordSha256 !== null : record.previousRecordSha256 === null) {
    fail("previousRecordSha256", "only the first record may omit the previous hash");
  }
  const sameStateOperation = [
    "register_qualification_authorization",
    "accept_run_ticket",
    "arm_run_ticket",
    "start_run_ticket",
    "terminalize_run_ticket",
  ].includes(record.operation);
  const validTransition = record.operation === "bootstrap_generation"
    ? record.sequence === 0 && record.previousState === null && record.state === "blocked"
    : record.operation === "activate_qualification_mode"
      ? record.previousState === "blocked" && record.state === "qualification_only"
      : sameStateOperation
        ? record.previousState === "qualification_only" && record.state === "qualification_only"
        : record.operation === "promote_production"
          ? record.previousState === "qualification_only" && record.state === "production_provisional"
          : record.operation === "stabilize_production"
            ? record.previousState === "production_provisional" && record.state === "production_stable"
            : record.operation === "enter_hold"
              ? record.previousState !== null && !["hold", "rolled_back"].includes(record.previousState)
                && record.state === "hold"
              : record.operation === "mark_rolled_back"
                ? record.previousState !== null && record.previousState !== "rolled_back" && record.state === "rolled_back"
                : record.operation === "supersede_release_generation"
                  ? record.previousState !== null && record.state === "blocked"
                  : false;
  if (!validTransition) fail("state", `invalid state transition for ${record.operation}`);
  const ticketOperation = ["accept_run_ticket", "arm_run_ticket", "start_run_ticket", "terminalize_run_ticket"]
    .includes(record.operation);
  const expectedTicketState: Partial<Record<ActivationOperation, QualificationTicketState>> = {
    accept_run_ticket: "accepted",
    arm_run_ticket: "armed",
    start_run_ticket: "started",
    terminalize_run_ticket: "terminal",
  };
  if (ticketOperation !== (record.ticketId !== null) || record.ticketState !== (expectedTicketState[record.operation] ?? null)) {
    fail("ticketState", "ticket operation fields are inconsistent");
  }
  if ((record.operation === "supersede_release_generation") !== (record.supersedePreflight !== null)) {
    fail("supersedePreflight", "supersede preflight is required only for release supersede");
  }
  const authorizationRequired = [
    "activate_qualification_mode",
    "register_qualification_authorization",
    "accept_run_ticket",
    "arm_run_ticket",
    "start_run_ticket",
    "terminalize_run_ticket",
    "promote_production",
  ].includes(record.operation);
  if (authorizationRequired !== (record.authorizationDigest !== null)) {
    fail("authorizationDigest", "operation and authorization binding are inconsistent");
  }
  if ((record.operation === "promote_production") !== (record.auditEnvelopeDigest !== null)) {
    fail("auditEnvelopeDigest", "only production promotion must bind the final audit envelope");
  }
  if ((record.operation === "promote_production" || record.operation === "stabilize_production")
    && record.releasedSurfaceEntryIds.length === 0) {
    fail("releasedSurfaceEntryIds", "production states require at least one released surface entry");
  }
  if ([
    "bootstrap_generation",
    "activate_qualification_mode",
    "register_qualification_authorization",
    "accept_run_ticket",
    "arm_run_ticket",
    "start_run_ticket",
    "terminalize_run_ticket",
    "supersede_release_generation",
  ].includes(record.operation) && record.releasedSurfaceEntryIds.length !== 0) {
    fail("releasedSurfaceEntryIds", "pre-production and supersede records cannot release surface entries");
  }
  if ((record.operation === "stabilize_production") !== (record.evidenceDigest !== null)) {
    fail("evidenceDigest", "only production stabilization must bind its observation evidence");
  }
  if ((record.operation === "terminalize_run_ticket") !== (record.ticketTerminal !== null)) {
    fail("ticketTerminal", "terminal ticket details are required only when terminalizing a ticket");
  }
  if (record.ticketTerminal
    && (record.ticketTerminal.outcome === "completed") !== (record.ticketTerminal.outputDigest !== null)) {
    fail("ticketTerminal", "only a completed ticket may bind a released output digest");
  }
});

export const activationJournalSignatureSchema = z.object({
  schemaVersion: z.literal("ltx-studio-detached-signature.v1"),
  algorithm: z.literal("ed25519"),
  role: z.literal("activation-journal-writer"),
  keyId: identifierSchema,
  payloadSha256: sha256Schema,
  signatureBase64: z.string().min(1),
}).strict();

export const activationJournalEnvelopeSchema = z.object({
  record: activationJournalRecordSchema,
  signature: activationJournalSignatureSchema,
}).strict();

export type ActivationJournalEnvelope = z.infer<typeof activationJournalEnvelopeSchema>;
export type ActivationJournalRecord = z.infer<typeof activationJournalRecordSchema>;

export const activationWriterTrustPolicySchema = z.object({
  schemaVersion: z.literal("ltx-studio-activation-writer-trust.v1"),
  policyId: identifierSchema,
  keys: z.array(z.object({
    keyId: identifierSchema,
    algorithm: z.literal("ed25519"),
    role: z.literal("activation-journal-writer"),
    publicKeyBase64: z.string().min(1),
    notBefore: timestampSchema,
    notAfter: timestampSchema,
    revokedAt: timestampSchema.nullable(),
  }).strict()).min(1),
}).strict().superRefine((policy, context) => {
  const ids = policy.keys.map(({ keyId }) => keyId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["keys"], message: "activation writer key ids must be unique" });
  }
  for (const [index, key] of policy.keys.entries()) {
    if (Date.parse(key.notBefore) >= Date.parse(key.notAfter)) {
      context.addIssue({ code: "custom", path: ["keys", index], message: "activation writer key window is invalid" });
    }
  }
});

export type ActivationWriterTrustPolicy = z.infer<typeof activationWriterTrustPolicySchema>;

export const runtimeRightsSnapshotSchema = z.object({
  schemaVersion: z.literal("ltx-studio-runtime-rights-snapshot.v1"),
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  policyEvidenceDigest: sha256Schema,
  attestationSeriesId: identifierSchema,
  version: z.number().int().nonnegative(),
  checkedAt: timestampSchema,
  nextUpdate: timestampSchema,
  sourceDigest: sha256Schema,
  revocationState: z.enum(["clear", "revoked"]),
}).strict().superRefine((snapshot, context) => {
  if (Date.parse(snapshot.checkedAt) >= Date.parse(snapshot.nextUpdate)) {
    context.addIssue({ code: "custom", path: ["nextUpdate"], message: "rights freshness window is inconsistent" });
  }
});

export type RuntimeRightsSnapshot = z.infer<typeof runtimeRightsSnapshotSchema>;

export type RuntimeActivationSnapshot = {
  state: ActivationState;
  generation: number;
  activationHeadSha256: string;
  releaseDigest: string;
  surfaceDigest: string;
  rightsCurrent: boolean;
  releasedSurfaceEntryIds: readonly string[];
};

export function activationRecordDigest(record: ActivationJournalRecord): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

export function activationEnvelopeDigest(envelope: ActivationJournalEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

export function verifyActivationEnvelopeSignature(
  rawEnvelope: unknown,
  rawPolicy: unknown,
  now: Date,
): ActivationJournalEnvelope {
  const envelope = activationJournalEnvelopeSchema.parse(rawEnvelope);
  const policy = activationWriterTrustPolicySchema.parse(rawPolicy);
  const signature = envelope.signature;
  if (signature.payloadSha256 !== activationRecordDigest(envelope.record)
    || signature.keyId !== envelope.record.writerKeyId) {
    throw new Error("Activation envelope signature binding mismatch");
  }
  const key = policy.keys.find(({ keyId }) => keyId === signature.keyId);
  if (!key) throw new Error("Activation envelope writer key is not trusted");
  const nowMs = now.getTime();
  if (nowMs < Date.parse(key.notBefore) || nowMs > Date.parse(key.notAfter)) {
    throw new Error("Activation envelope writer key is outside its validity window");
  }
  if (key.revokedAt && Date.parse(key.revokedAt) <= nowMs) {
    throw new Error("Activation envelope writer key is revoked");
  }
  const rawKey = Buffer.from(key.publicKeyBase64, "base64");
  const rawSignature = Buffer.from(signature.signatureBase64, "base64");
  if (rawKey.length !== 32 || rawSignature.length !== 64
    || rawKey.toString("base64") !== key.publicKeyBase64
    || rawSignature.toString("base64") !== signature.signatureBase64) {
    throw new Error("Activation envelope key or signature encoding is invalid");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(canonicalJson(envelope.record)), publicKey, rawSignature)) {
    throw new Error("Activation envelope Ed25519 signature is invalid");
  }
  return envelope;
}

export function verifyRuntimeRightsSnapshot(options: {
  signed: { document: unknown; signature: unknown };
  trustPolicy: unknown;
  release: z.infer<typeof activationReleaseBindingSchema>;
  now: Date;
}): { document: RuntimeRightsSnapshot; digest: string } {
  const trustPolicy = trustedKeyPolicySchema.parse(options.trustPolicy);
  const document = runtimeRightsSnapshotSchema.parse(options.signed.document);
  const digest = verifyDetachedSignature(
    document,
    options.signed.signature,
    trustPolicy,
    "rights-attestor",
    options.now,
  );
  if (document.releaseDigest !== options.release.releaseDigest
    || document.surfaceDigest !== options.release.surfaceDigest
    || document.policyEvidenceDigest !== options.release.rights.policyEvidenceDigest
    || document.attestationSeriesId !== options.release.rights.attestationSeriesId
    || document.version < options.release.rights.minimumSnapshotVersion) {
    throw new Error("Runtime rights snapshot binding mismatch");
  }
  const nowMs = options.now.getTime();
  if (Date.parse(document.checkedAt) > nowMs || Date.parse(document.nextUpdate) < nowMs) {
    throw new Error("Runtime rights snapshot is stale or not yet valid");
  }
  if (document.revocationState !== "clear") {
    throw new Error("Runtime rights snapshot is revoked");
  }
  return { document, digest };
}

export function validateActivationJournal(raw: unknown): ActivationJournalEnvelope[] {
  const envelopes = z.array(activationJournalEnvelopeSchema).min(1).parse(raw);
  const registeredAuthorizations = new Set<string>();
  const tickets = new Map<string, QualificationTicketState>();
  for (const [index, envelope] of envelopes.entries()) {
    const previous = envelopes[index - 1];
    const expectedPreviousHash = previous ? activationEnvelopeDigest(previous) : null;
    if (envelope.signature.payloadSha256 !== activationRecordDigest(envelope.record)) {
      throw new Error(`Activation record ${index} signature payload digest mismatch`);
    }
    if (envelope.signature.keyId !== envelope.record.writerKeyId) {
      throw new Error(`Activation record ${index} writer key mismatch`);
    }
    if (envelope.record.sequence !== index || envelope.record.previousRecordSha256 !== expectedPreviousHash) {
      throw new Error(`Activation record ${index} chain mismatch`);
    }
    if (previous) {
      if (Date.parse(envelope.record.recordedAt) < Date.parse(previous.record.recordedAt)) {
        throw new Error(`Activation record ${index} timestamp moved backwards`);
      }
      if (envelope.record.previousState !== previous.record.state) {
        throw new Error(`Activation record ${index} previous state mismatch`);
      }
      const superseding = envelope.record.operation === "supersede_release_generation";
      if (superseding) {
        if (envelope.record.generation !== previous.record.generation + 1
          || envelope.record.supersedePreflight?.previousGeneration !== previous.record.generation
          || envelope.record.supersedePreflight.previousHeadSha256 !== expectedPreviousHash
          || envelope.record.supersedePreflight.supersededReleaseDigest !== previous.record.release.releaseDigest) {
          throw new Error(`Activation record ${index} supersede binding mismatch`);
        }
      } else if (envelope.record.generation !== previous.record.generation
        || canonicalJson(envelope.record.release) !== canonicalJson(previous.record.release)) {
        throw new Error(`Activation record ${index} changed generation or release without supersede`);
      }
      const releasedEntriesMayChange = envelope.record.operation === "promote_production";
      const releasedEntriesMustReset = envelope.record.operation === "supersede_release_generation";
      if (!releasedEntriesMayChange && !releasedEntriesMustReset
        && canonicalJson(envelope.record.releasedSurfaceEntryIds)
          !== canonicalJson(previous.record.releasedSurfaceEntryIds)) {
        throw new Error(`Activation record ${index} changed released surface entries outside promotion`);
      }
    }
    if (envelope.record.operation === "register_qualification_authorization") {
      const digest = envelope.record.authorizationDigest!;
      if (registeredAuthorizations.has(digest)) {
        throw new Error(`Activation record ${index} re-registered an authorization`);
      }
      registeredAuthorizations.add(digest);
    }
    if (envelope.record.ticketId) {
      const authorizationDigest = envelope.record.authorizationDigest!;
      if (!registeredAuthorizations.has(authorizationDigest)) {
        throw new Error(`Activation record ${index} used an unregistered run authorization`);
      }
      const previousTicketState = tickets.get(envelope.record.ticketId);
      const nextTicketState = envelope.record.ticketState!;
      const validTicketTransition = nextTicketState === "accepted"
        ? previousTicketState === undefined
        : nextTicketState === "armed"
          ? previousTicketState === "accepted"
          : nextTicketState === "started"
            ? previousTicketState === "armed"
            : nextTicketState === "terminal"
              ? previousTicketState === "accepted" || previousTicketState === "armed" || previousTicketState === "started"
              : false;
      if (!validTicketTransition) {
        throw new Error(`Activation record ${index} ticket transition mismatch`);
      }
      tickets.set(envelope.record.ticketId, nextTicketState);
    }
  }
  return envelopes;
}

export function runtimeActivationSnapshot(
  rawJournal: unknown,
  rightsCurrent: boolean,
): RuntimeActivationSnapshot {
  const journal = validateActivationJournal(rawJournal);
  const last = journal.at(-1)!;
  return {
    state: last.record.state,
    generation: last.record.generation,
    activationHeadSha256: activationEnvelopeDigest(last),
    releaseDigest: last.record.release.releaseDigest,
    surfaceDigest: last.record.release.surfaceDigest,
    rightsCurrent,
    releasedSurfaceEntryIds: [...last.record.releasedSurfaceEntryIds],
  };
}
