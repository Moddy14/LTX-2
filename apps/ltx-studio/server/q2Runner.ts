import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../shared/canonicalJson.js";
import type { EvaluationAuthorization } from "../shared/evaluationAuthorization.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const sealedRootSchema = z.string().min(2).max(512).refine((value) =>
  value.startsWith("/")
  && value !== "/"
  && !value.includes("\\")
  && posix.normalize(value) === value,
"sealed roots must be normalized absolute POSIX paths");

export const q2RunnerContractSchema = z.object({
  schemaVersion: z.literal("q2-runner.v1"),
  runnerDigest: sha256Schema,
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  runtimeSandboxDigest: sha256Schema,
  orchestratorContractDigest: sha256Schema,
  uid: z.number().int().positive(),
  consumerId: identifierSchema,
  inputRoot: sealedRootSchema,
  inputRootManifestDigest: sha256Schema,
  outputRoot: sealedRootSchema,
  outputRootPolicyDigest: sha256Schema,
  productApiCapability: z.literal("none"),
  jobsCreateCapability: z.literal("none"),
  activationJournalCapability: z.literal("none"),
  qualificationRegistryCapability: z.literal("none"),
  directGpuCapability: z.literal("orchestrator-grant-only"),
}).strict().superRefine((contract, context) => {
  if (contract.inputRoot === contract.outputRoot
    || contract.inputRoot.startsWith(`${contract.outputRoot}/`)
    || contract.outputRoot.startsWith(`${contract.inputRoot}/`)) {
    context.addIssue({ code: "custom", path: ["outputRoot"], message: "sealed input and output roots must be disjoint" });
  }
});

export type Q2RunnerContract = z.infer<typeof q2RunnerContractSchema>;

export function q2RunnerContractDigest(contract: Q2RunnerContract): string {
  return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}

export const q2AdmissionGrantSchema = z.object({
  schemaVersion: z.literal("q2-orchestrator-admission-grant.v1"),
  grantId: z.uuid(),
  jobId: identifierSchema,
  consumerId: identifierSchema,
  runtimeSandboxDigest: sha256Schema,
  orchestratorContractDigest: sha256Schema,
  runnerDigest: sha256Schema,
  releaseDigest: sha256Schema,
  issuedAt: timestampSchema,
  notBefore: timestampSchema,
  expiresAt: timestampSchema,
  cgroupId: identifierSchema,
  devicePolicy: z.literal("closed"),
  killMode: z.literal("control-group"),
  gpuDeviceIds: z.array(identifierSchema).min(1),
}).strict().superRefine((grant, context) => {
  if (!(Date.parse(grant.issuedAt) <= Date.parse(grant.notBefore)
    && Date.parse(grant.notBefore) < Date.parse(grant.expiresAt))) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Q2 admission grant time window is inconsistent" });
  }
  if (new Set(grant.gpuDeviceIds).size !== grant.gpuDeviceIds.length
    || grant.gpuDeviceIds.some((id, index) => index > 0 && grant.gpuDeviceIds[index - 1] >= id)) {
    context.addIssue({ code: "custom", path: ["gpuDeviceIds"], message: "GPU device ids must be unique and sorted" });
  }
});

export const q2RuntimeObservationSchema = z.object({
  uid: z.number().int().positive(),
  consumerId: identifierSchema,
  runnerDigest: sha256Schema,
  inputRoot: sealedRootSchema,
  outputRoot: sealedRootSchema,
  inputRootReadOnly: z.literal(true),
  outputRootWriteOnly: z.literal(true),
  productApiReachable: z.literal(false),
  jobsCreateReachable: z.literal(false),
  activationJournalReachable: z.literal(false),
  qualificationRegistryReachable: z.literal(false),
  foreignRootsReachable: z.literal(false),
  gpuDeviceReachableWithoutGrant: z.literal(false),
  gpuDeviceReachableWithGrant: z.literal(true),
  grant: q2AdmissionGrantSchema,
  processCgroupId: identifierSchema,
  allDescendantsInGrantCgroup: z.literal(true),
  openGpuDeviceFdsOutsideGrantCgroup: z.literal(0),
}).strict();

export type Q2RuntimeObservation = z.infer<typeof q2RuntimeObservationSchema>;

export function validateQ2RunnerLaunch(options: {
  authorization: EvaluationAuthorization;
  contract: unknown;
  observation: unknown;
  now: Date;
}): {
  jobId: string;
  grantId: string;
  cgroupId: string;
  deadline: string;
} {
  const contract = q2RunnerContractSchema.parse(options.contract);
  const observation = q2RuntimeObservationSchema.parse(options.observation);
  const grant = observation.grant;
  const nowMs = options.now.getTime();
  if (contract.runnerDigest !== options.authorization.q2RunnerDigest
    || q2RunnerContractDigest(contract) !== options.authorization.q2RunnerContractDigest
    || contract.releaseDigest !== options.authorization.releaseDigest
    || contract.surfaceDigest !== options.authorization.surfaceDigest
    || contract.runtimeSandboxDigest !== options.authorization.q2RuntimeSandboxDigest
    || contract.orchestratorContractDigest !== options.authorization.orchestratorContractDigest
    || contract.inputRootManifestDigest !== options.authorization.holdoutInputManifestDigest
    || contract.outputRootPolicyDigest !== options.authorization.outputRootPolicyDigest) {
    throw new Error("Q2 runner contract does not match the evaluation authorization");
  }
  if (observation.uid !== contract.uid
    || observation.consumerId !== contract.consumerId
    || observation.runnerDigest !== contract.runnerDigest
    || observation.inputRoot !== contract.inputRoot
    || observation.outputRoot !== contract.outputRoot) {
    throw new Error("Q2 runtime identity or sealed-root binding mismatch");
  }
  if (grant.consumerId !== contract.consumerId
    || grant.runtimeSandboxDigest !== contract.runtimeSandboxDigest
    || grant.orchestratorContractDigest !== contract.orchestratorContractDigest
    || grant.runnerDigest !== contract.runnerDigest
    || grant.releaseDigest !== contract.releaseDigest
    || grant.cgroupId !== observation.processCgroupId) {
    throw new Error("Q2 orchestrator grant binding mismatch");
  }
  if (nowMs < Date.parse(grant.notBefore)
    || nowMs > Date.parse(grant.expiresAt)
    || Date.parse(grant.expiresAt) > Date.parse(options.authorization.completeBy)) {
    throw new Error("Q2 orchestrator grant is outside the evaluation deadline");
  }
  return {
    jobId: grant.jobId,
    grantId: grant.grantId,
    cgroupId: grant.cgroupId,
    deadline: grant.expiresAt,
  };
}
