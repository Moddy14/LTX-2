import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import { trustedKeyPolicySchema, verifyDetachedSignature } from "./releaseAudit.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });

export const evaluationAuthorizationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-evaluation-authorization.v1"),
  authorizationId: identifierSchema,
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  preregistrationDigest: sha256Schema,
  q2RunnerDigest: sha256Schema,
  q2RunnerContractDigest: sha256Schema,
  q2RuntimeSandboxDigest: sha256Schema,
  orchestratorContractDigest: sha256Schema,
  evaluationMatrixDigest: sha256Schema,
  holdoutCiphertextDigest: sha256Schema,
  holdoutKeyEnvelopeDigest: sha256Schema,
  holdoutInputManifestDigest: sha256Schema,
  outputRootPolicyDigest: sha256Schema,
  rights: z.object({
    policyEvidenceDigest: sha256Schema,
    attestationSeriesId: identifierSchema,
    minimumSnapshotVersion: z.number().int().nonnegative(),
    sameSeriesSuccessorAllowed: z.literal(true),
  }).strict(),
  q1bSeal: z.object({
    quiescenceDigest: sha256Schema,
    jointSealDigest: sha256Schema,
    studioRegistryHeadDigest: sha256Schema,
    studioRegistryAnchorHeadDigest: sha256Schema,
    externalRegistryHeadDigest: sha256Schema,
    externalRegistryAnchorHeadDigest: sha256Schema,
    finalReleaseEqualityDigest: sha256Schema,
  }).strict(),
  securityState: z.object({
    snapshotDigest: sha256Schema,
    contractDigest: sha256Schema,
    seriesId: identifierSchema,
    minimumVersion: z.number().int().nonnegative(),
    externalAnchorHeadDigest: sha256Schema,
    sameSeriesSuccessorAllowed: z.literal(true),
  }).strict(),
  issuedAt: timestampSchema,
  notBefore: timestampSchema,
  startBy: timestampSchema,
  completeBy: timestampSchema,
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  maximumJobs: z.number().int().positive(),
  maximumGpuSeconds: z.number().int().nonnegative(),
  maximumOutputBytes: z.number().int().nonnegative(),
  recoveryPolicyDigest: sha256Schema,
}).strict().superRefine((authorization, context) => {
  const times = [authorization.issuedAt, authorization.notBefore, authorization.startBy, authorization.completeBy]
    .map(Date.parse);
  if (!(times[0] <= times[1] && times[1] <= times[2] && times[2] <= times[3])) {
    context.addIssue({ code: "custom", path: ["completeBy"], message: "evaluation authorization time window is inconsistent" });
  }
});

export type EvaluationAuthorization = z.infer<typeof evaluationAuthorizationSchema>;

export const evaluationConsumptionRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-evaluation-consumption-record.v1"),
  recordId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  previousRecordSha256: sha256Schema.nullable(),
  authorizationDigest: sha256Schema,
  transactionId: z.uuid(),
  authorizationNonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  state: z.enum(["started", "consumed", "terminal"]),
  holdoutBytesRead: z.number().int().nonnegative(),
  outcome: z.enum(["passed", "failed", "infrastructure_aborted", "deadline"]).nullable(),
  outputDigest: sha256Schema.nullable(),
  recordedAt: timestampSchema,
  writerId: identifierSchema,
}).strict().superRefine((record, context) => {
  if ((record.sequence === 0) !== (record.previousRecordSha256 === null)) {
    context.addIssue({ code: "custom", path: ["previousRecordSha256"], message: "only the first record may omit the previous hash" });
  }
  if (record.state === "started" && record.holdoutBytesRead !== 0) {
    context.addIssue({ code: "custom", path: ["holdoutBytesRead"], message: "started must be committed before the first decrypted byte" });
  }
  if (record.state === "consumed" && record.holdoutBytesRead < 1) {
    context.addIssue({ code: "custom", path: ["holdoutBytesRead"], message: "consumed begins with the first decrypted byte" });
  }
  if ((record.state === "terminal") !== (record.outcome !== null)) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "only terminal records bind an outcome" });
  }
  if (record.state !== "terminal" && record.outputDigest !== null) {
    context.addIssue({ code: "custom", path: ["outputDigest"], message: "only terminal records may bind an output" });
  }
  if ((record.outcome === "passed") !== (record.outputDigest !== null)) {
    context.addIssue({ code: "custom", path: ["outputDigest"], message: "only a passed terminal result must bind its output digest" });
  }
});

export type EvaluationConsumptionRecord = z.infer<typeof evaluationConsumptionRecordSchema>;

export function evaluationAuthorizationDigest(authorization: EvaluationAuthorization): string {
  return createHash("sha256").update(canonicalJson(authorization)).digest("hex");
}

export function evaluationConsumptionRecordDigest(record: EvaluationConsumptionRecord): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

export function verifyEvaluationAuthorization(options: {
  signed: { document: unknown; signature: unknown };
  trustPolicy: unknown;
  now: Date;
  phase: "start" | "continue";
}): EvaluationAuthorization {
  const policy = trustedKeyPolicySchema.parse(options.trustPolicy);
  const authorization = evaluationAuthorizationSchema.parse(options.signed.document);
  verifyDetachedSignature(authorization, options.signed.signature, policy, "evaluation-authorizer", options.now);
  const nowMs = options.now.getTime();
  const latest = options.phase === "start" ? Date.parse(authorization.startBy) : Date.parse(authorization.completeBy);
  if (nowMs < Date.parse(authorization.notBefore) || nowMs > latest) {
    throw new Error(`Evaluation authorization is outside its ${options.phase} window`);
  }
  return authorization;
}

export function validateEvaluationConsumption(options: {
  authorization: EvaluationAuthorization;
  records: unknown;
}): EvaluationConsumptionRecord[] {
  const records = z.array(evaluationConsumptionRecordSchema).parse(options.records);
  const authorizationDigest = evaluationAuthorizationDigest(options.authorization);
  for (const [index, record] of records.entries()) {
    const previous = records[index - 1];
    if (record.sequence !== index
      || record.previousRecordSha256 !== (previous ? evaluationConsumptionRecordDigest(previous) : null)
      || record.authorizationDigest !== authorizationDigest
      || record.authorizationNonce !== options.authorization.nonce
      || (previous && record.transactionId !== previous.transactionId)
      || (previous && record.holdoutBytesRead < previous.holdoutBytesRead)
      || (previous && Date.parse(record.recordedAt) < Date.parse(previous.recordedAt))) {
      throw new Error(`Evaluation consumption record ${index} chain or authorization binding mismatch`);
    }
    const validState = index === 0
      ? record.state === "started"
      : record.state === "consumed"
        ? previous.state === "started"
        : record.state === "terminal"
          ? previous.state === "started" || previous.state === "consumed"
          : false;
    if (!validState) throw new Error(`Evaluation consumption record ${index} state transition mismatch`);
    if (record.state !== "terminal" && Date.parse(record.recordedAt) > Date.parse(options.authorization.completeBy)) {
      throw new Error(`Evaluation consumption record ${index} crossed completeBy`);
    }
    if (record.outcome === "passed" && Date.parse(record.recordedAt) > Date.parse(options.authorization.completeBy)) {
      throw new Error(`Evaluation consumption record ${index} passed after completeBy`);
    }
  }
  return records;
}

export function assertEvaluationMayStart(options: {
  signed: { document: unknown; signature: unknown };
  trustPolicy: unknown;
  existingRecords: unknown;
  now: Date;
}): EvaluationAuthorization {
  const authorization = verifyEvaluationAuthorization({ ...options, phase: "start" });
  if (validateEvaluationConsumption({ authorization, records: options.existingRecords }).length !== 0) {
    throw new Error("Evaluation authorization has already started and cannot be retried");
  }
  return authorization;
}

export function assertEvaluationMayContinue(options: {
  signed: { document: unknown; signature: unknown };
  trustPolicy: unknown;
  records: unknown;
  transactionId: string;
  now: Date;
}): { authorization: EvaluationAuthorization; state: "started" | "consumed" } {
  const authorization = verifyEvaluationAuthorization({ ...options, phase: "continue" });
  const records = validateEvaluationConsumption({ authorization, records: options.records });
  const head = records.at(-1);
  if (!head || head.transactionId !== options.transactionId || head.state === "terminal") {
    throw new Error("Evaluation continuation transaction is absent, different, or terminal");
  }
  return { authorization, state: head.state };
}
