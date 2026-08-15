import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });

export const promotionProbeIds = [
  "activation-head",
  "api-availability",
  "foreign-service-actions",
  "job-integrity",
  "output-provenance",
  "rights-current",
  "rollback-readiness",
  "security-state",
] as const;

export const promotionObservationPlanSchema = z.object({
  schemaVersion: z.literal("ltx-studio-promotion-observation-plan.v1"),
  attemptId: z.uuid(),
  generation: z.number().int().positive(),
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  auditEnvelopeDigest: sha256Schema,
  releaseAuthorizationDigest: sha256Schema,
  activationHeadAtT0Sha256: sha256Schema,
  startedAt: timestampSchema,
  cadenceSeconds: z.number().int().min(10).max(3600),
  toleranceSeconds: z.number().int().nonnegative(),
  requiredProbeIds: z.array(z.enum(promotionProbeIds)).length(promotionProbeIds.length),
  checkpoints: z.array(z.object({
    checkpointId: z.enum(["o24", "o7"]),
    elapsedSeconds: z.number().int().positive(),
  }).strict()).length(2),
  missingPolicy: z.literal("fail"),
}).strict().superRefine((plan, context) => {
  if (plan.toleranceSeconds * 2 >= plan.cadenceSeconds) {
    context.addIssue({ code: "custom", path: ["toleranceSeconds"], message: "tolerance must be less than half the cadence" });
  }
  if (canonicalJson(plan.requiredProbeIds) !== canonicalJson([...promotionProbeIds])) {
    context.addIssue({ code: "custom", path: ["requiredProbeIds"], message: "all probes must occur once in canonical order" });
  }
  if (canonicalJson(plan.checkpoints) !== canonicalJson([
    { checkpointId: "o24", elapsedSeconds: 86_400 },
    { checkpointId: "o7", elapsedSeconds: 604_800 },
  ])) {
    context.addIssue({ code: "custom", path: ["checkpoints"], message: "O24 and O7 checkpoints are fixed" });
  }
});

export type PromotionObservationPlan = z.infer<typeof promotionObservationPlanSchema>;

const promotionProbeSchema = z.object({
  probeId: z.enum(promotionProbeIds),
  status: z.enum(["pass", "fail"]),
  policyDigest: sha256Schema,
  evidenceDigest: sha256Schema,
}).strict();

export const promotionObservationRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-promotion-observation-record.v1"),
  recordId: z.uuid(),
  attemptId: z.uuid(),
  planDigest: sha256Schema,
  sequence: z.number().int().nonnegative(),
  previousRecordSha256: sha256Schema.nullable(),
  generation: z.number().int().positive(),
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  auditEnvelopeDigest: sha256Schema,
  releaseAuthorizationDigest: sha256Schema,
  activationHeadSha256: sha256Schema,
  wallClockAt: timestampSchema,
  elapsedSeconds: z.number().int().nonnegative(),
  bootOrdinal: z.number().int().nonnegative(),
  bootId: identifierSchema,
  monotonicMs: z.number().finite().nonnegative(),
  rightsSnapshotDigest: sha256Schema,
  securityStateDigest: sha256Schema,
  rawLogDigest: sha256Schema,
  probes: z.array(promotionProbeSchema).length(promotionProbeIds.length),
  monitoringKeyId: identifierSchema,
}).strict().superRefine((record, context) => {
  if ((record.sequence === 0) !== (record.previousRecordSha256 === null)) {
    context.addIssue({ code: "custom", path: ["previousRecordSha256"], message: "only sequence zero may omit the previous record hash" });
  }
  if (canonicalJson(record.probes.map(({ probeId }) => probeId)) !== canonicalJson([...promotionProbeIds])) {
    context.addIssue({ code: "custom", path: ["probes"], message: "all probes must occur once in canonical order" });
  }
});

export type PromotionObservationRecord = z.infer<typeof promotionObservationRecordSchema>;

const observationSignatureSchema = z.object({
  schemaVersion: z.literal("ltx-studio-detached-signature.v1"),
  algorithm: z.literal("ed25519"),
  role: z.literal("monitoring-signer"),
  keyId: identifierSchema,
  payloadSha256: sha256Schema,
  signatureBase64: z.string().min(1),
}).strict();

export const signedPromotionObservationRecordSchema = z.object({
  record: promotionObservationRecordSchema,
  signature: observationSignatureSchema,
}).strict();

export type SignedPromotionObservationRecord = z.infer<typeof signedPromotionObservationRecordSchema>;

export const monitoringTrustPolicySchema = z.object({
  schemaVersion: z.literal("ltx-studio-monitoring-trust.v1"),
  policyId: identifierSchema,
  keys: z.array(z.object({
    keyId: identifierSchema,
    algorithm: z.literal("ed25519"),
    role: z.literal("monitoring-signer"),
    publicKeyBase64: z.string().min(1),
    notBefore: timestampSchema,
    notAfter: timestampSchema,
    revokedAt: timestampSchema.nullable(),
  }).strict()).min(1),
}).strict().superRefine((policy, context) => {
  const ids = policy.keys.map(({ keyId }) => keyId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["keys"], message: "monitoring key ids must be unique" });
  }
});
export type MonitoringTrustPolicy = z.infer<typeof monitoringTrustPolicySchema>;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function promotionObservationRecordDigest(record: PromotionObservationRecord): string {
  return digest(record);
}

export function promotionObservationEnvelopeDigest(record: SignedPromotionObservationRecord): string {
  return digest(record);
}

function verifyRecord(
  raw: unknown,
  trustPolicy: unknown,
  now: Date,
): SignedPromotionObservationRecord {
  const envelope = signedPromotionObservationRecordSchema.parse(raw);
  const policy = monitoringTrustPolicySchema.parse(trustPolicy);
  const signature = envelope.signature;
  if (signature.payloadSha256 !== promotionObservationRecordDigest(envelope.record)
    || signature.keyId !== envelope.record.monitoringKeyId) {
    throw new Error("Observation signature binding mismatch");
  }
  const key = policy.keys.find(({ keyId }) => keyId === signature.keyId);
  if (!key) throw new Error("Observation monitoring key is not trusted");
  const nowMs = now.getTime();
  if (nowMs < Date.parse(key.notBefore) || nowMs > Date.parse(key.notAfter)
    || (key.revokedAt !== null && Date.parse(key.revokedAt) <= nowMs)) {
    throw new Error("Observation monitoring key is unavailable or revoked");
  }
  const rawKey = Buffer.from(key.publicKeyBase64, "base64");
  const rawSignature = Buffer.from(signature.signatureBase64, "base64");
  if (rawKey.length !== 32 || rawSignature.length !== 64) throw new Error("Observation signature encoding is invalid");
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(canonicalJson(envelope.record)), publicKey, rawSignature)) {
    throw new Error("Observation Ed25519 signature is invalid");
  }
  return envelope;
}

export function validatePromotionObservation(options: {
  plan: unknown;
  records: unknown;
  trustPolicy: unknown;
  checkpoint: "o24" | "o7";
  now: Date;
}): {
  checkpoint: "o24" | "o7";
  recordCount: number;
  headSha256: string;
  verdict: "pass";
} {
  const plan = promotionObservationPlanSchema.parse(options.plan);
  const planDigest = digest(plan);
  const rawRecords = z.array(z.unknown()).min(1).parse(options.records);
  const records = rawRecords.map((record) => verifyRecord(record, options.trustPolicy, options.now));
  const checkpointSeconds = plan.checkpoints.find(({ checkpointId }) => checkpointId === options.checkpoint)!.elapsedSeconds;
  const expectedCount = Math.floor(checkpointSeconds / plan.cadenceSeconds) + 1;
  if (records.length !== expectedCount) throw new Error("Observation record count has a missing or extra cadence slot");
  for (const [index, envelope] of records.entries()) {
    const record = envelope.record;
    const previous = records[index - 1];
    const expectedElapsed = index * plan.cadenceSeconds;
    const wallClockMs = Date.parse(record.wallClockAt);
    const expectedWallClockMs = Date.parse(plan.startedAt) + expectedElapsed * 1000;
    if (record.sequence !== index
      || record.previousRecordSha256 !== (previous ? promotionObservationEnvelopeDigest(previous) : null)
      || record.attemptId !== plan.attemptId
      || record.planDigest !== planDigest
      || record.generation !== plan.generation
      || record.releaseDigest !== plan.releaseDigest
      || record.surfaceDigest !== plan.surfaceDigest
      || record.auditEnvelopeDigest !== plan.auditEnvelopeDigest
      || record.releaseAuthorizationDigest !== plan.releaseAuthorizationDigest
      || Math.abs(record.elapsedSeconds - expectedElapsed) > plan.toleranceSeconds) {
      throw new Error(`Observation record ${index} chain, release, or cadence binding mismatch`);
    }
    if (record.probes.some(({ status }) => status !== "pass")) {
      throw new Error(`Observation record ${index} contains a failed probe`);
    }
    if (index === 0 && record.activationHeadSha256 !== plan.activationHeadAtT0Sha256) {
      throw new Error("Observation sequence zero activation head mismatch");
    }
    if (Math.abs(wallClockMs - expectedWallClockMs) > plan.toleranceSeconds * 1000
      || wallClockMs > options.now.getTime()
      || (previous && wallClockMs <= Date.parse(previous.record.wallClockAt))) {
      throw new Error(`Observation record ${index} wall clock is not strictly increasing`);
    }
    if (previous) {
      const sameBoot = record.bootOrdinal === previous.record.bootOrdinal
        && record.bootId === previous.record.bootId
        && record.monotonicMs > previous.record.monotonicMs;
      const nextBoot = record.bootOrdinal === previous.record.bootOrdinal + 1
        && record.bootId !== previous.record.bootId;
      if (!sameBoot && !nextBoot) throw new Error(`Observation record ${index} boot or monotonic sequence mismatch`);
    }
  }
  return {
    checkpoint: options.checkpoint,
    recordCount: records.length,
    headSha256: promotionObservationEnvelopeDigest(records.at(-1)!),
    verdict: "pass",
  };
}
