import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const publicKeySchema = z.string().refine((value) => {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}, "public key must be canonical base64 Ed25519 raw bytes");

export const q1bSecurityComponentRoles = [
  "q1b-joint-seal-writer",
  "q1b-quiescence-finalizer",
  "q1b-build-equality-verifier",
  "q1b-security-event-writer",
  "q1b-ledger-anchor-writer",
  "q1b-incident-closure-signer",
  "q1b-security-interlock-writer",
] as const;
export type Q1bSecurityComponentRole = (typeof q1bSecurityComponentRoles)[number];

export const q1bSecurityStateMutableFields = [
  "components.*.document.sequence",
  "components.*.document.sourceCursor",
  "components.*.document.bootId",
  "components.*.document.headDigest",
  "components.*.document.observedAt",
  "components.*.document.nextUpdate",
  "components.*.document.sealViolationCount",
  "components.*.document.coverageGapCount",
  "components.*.document.openIncidentCount",
  "components.*.document.latchVersion",
  "components.*.document.latchHold",
  "components.*.document.factsDigest",
  "trustSnapshot.document.sequence",
  "trustSnapshot.document.previousSnapshotDigest",
  "trustSnapshot.document.checkedAt",
  "trustSnapshot.document.nextUpdate",
  "trustSnapshot.document.keys.*.state",
  "version",
  "previousSnapshotDigest",
  "createdAt",
] as const;

const pinnedKeySchema = z.object({
  keyId: identifierSchema,
  publicKeyBase64: publicKeySchema,
}).strict();

const componentPolicySchema = z.object({
  role: z.enum(q1bSecurityComponentRoles),
  sourceId: identifierSchema,
  sourcePolicyDigest: sha256Schema,
  signer: pinnedKeySchema,
  anchorBackendId: identifierSchema,
  anchorWriter: pinnedKeySchema,
}).strict();

export const q1bSecurityStateContractSchema = z.object({
  schemaVersion: z.literal("q1b-security-state-contract.v1"),
  contractId: identifierSchema,
  generation: z.number().int().positive(),
  trustPolicyDigest: sha256Schema,
  trustAttestor: pinnedKeySchema,
  finalizer: pinnedKeySchema,
  stateAnchorBackendId: identifierSchema,
  stateAnchorWriter: pinnedKeySchema,
  healthMaxAgeSeconds: z.number().int().positive().max(86_400),
  allowedMutableFields: z.array(z.enum(q1bSecurityStateMutableFields))
    .length(q1bSecurityStateMutableFields.length),
  components: z.array(componentPolicySchema).length(q1bSecurityComponentRoles.length),
}).strict().superRefine((contract, context) => {
  if (canonicalJson(contract.allowedMutableFields) !== canonicalJson([...q1bSecurityStateMutableFields])) {
    context.addIssue({ code: "custom", path: ["allowedMutableFields"], message: "mutable fields must match the canonical contract" });
  }
  if (canonicalJson(contract.components.map(({ role }) => role)) !== canonicalJson([...q1bSecurityComponentRoles])) {
    context.addIssue({ code: "custom", path: ["components"], message: "all seven component roles must occur in canonical order" });
  }
  const sourceIds = contract.components.map(({ sourceId }) => sourceId);
  const anchorBackendIds = contract.components.map(({ anchorBackendId }) => anchorBackendId);
  if (new Set(sourceIds).size !== sourceIds.length || new Set(anchorBackendIds).size !== anchorBackendIds.length) {
    context.addIssue({ code: "custom", path: ["components"], message: "component sources and anchor backends must be unique" });
  }
  const keyIds = [
    contract.trustAttestor.keyId,
    contract.finalizer.keyId,
    contract.stateAnchorWriter.keyId,
    ...contract.components.flatMap(({ signer, anchorWriter }) => [signer.keyId, anchorWriter.keyId]),
  ];
  if (new Set(keyIds).size !== keyIds.length) {
    context.addIssue({ code: "custom", path: ["components"], message: "all security-state signer and anchor keys must be role-separated" });
  }
});

export type Q1bSecurityStateContract = z.infer<typeof q1bSecurityStateContractSchema>;

const detachedSignatureSchema = z.object({
  schemaVersion: z.literal("ltx-studio-detached-signature.v1"),
  algorithm: z.literal("ed25519"),
  role: identifierSchema,
  keyId: identifierSchema,
  payloadSha256: sha256Schema,
  signatureBase64: z.string().min(1),
}).strict();

const componentDocumentSchema = z.object({
  schemaVersion: z.literal("q1b-security-component-record.v1"),
  role: z.enum(q1bSecurityComponentRoles),
  sourceId: identifierSchema,
  sourcePolicyDigest: sha256Schema,
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  sourceCursor: z.number().int().nonnegative(),
  bootId: identifierSchema,
  headDigest: sha256Schema,
  observedAt: timestampSchema,
  nextUpdate: timestampSchema,
  health: z.literal("pass"),
  sealViolationCount: z.number().int().nonnegative(),
  coverageGapCount: z.number().int().nonnegative(),
  openIncidentCount: z.number().int().nonnegative(),
  latchVersion: z.number().int().nonnegative(),
  latchHold: z.boolean(),
  factsDigest: sha256Schema,
  signerKeyId: identifierSchema,
}).strict().superRefine((record, context) => {
  if (Date.parse(record.observedAt) >= Date.parse(record.nextUpdate)) {
    context.addIssue({ code: "custom", path: ["nextUpdate"], message: "component health window is inconsistent" });
  }
});

const componentAnchorDocumentSchema = z.object({
  schemaVersion: z.literal("q1b-security-component-anchor.v1"),
  role: z.enum(q1bSecurityComponentRoles),
  sourceId: identifierSchema,
  anchorBackendId: identifierSchema,
  componentRecordDigest: sha256Schema,
  sourceHeadDigest: sha256Schema,
  sourceSequence: z.number().int().nonnegative(),
  anchoredAt: timestampSchema,
  anchorKeyId: identifierSchema,
}).strict();

const signedComponentSchema = z.object({
  document: componentDocumentSchema,
  signature: detachedSignatureSchema,
  anchor: z.object({
    document: componentAnchorDocumentSchema,
    signature: detachedSignatureSchema,
  }).strict(),
}).strict();

const trustSnapshotDocumentSchema = z.object({
  schemaVersion: z.literal("q1b-security-trust-snapshot.v1"),
  policyDigest: sha256Schema,
  sequence: z.number().int().nonnegative(),
  previousSnapshotDigest: sha256Schema.nullable(),
  checkedAt: timestampSchema,
  nextUpdate: timestampSchema,
  keys: z.array(z.object({
    keyId: identifierSchema,
    state: z.enum(["clear", "revoked"]),
  }).strict()).min(1),
  attestorKeyId: identifierSchema,
}).strict().superRefine((snapshot, context) => {
  const keyIds = snapshot.keys.map(({ keyId }) => keyId);
  if (new Set(keyIds).size !== keyIds.length
    || keyIds.some((id, index) => index > 0 && keyIds[index - 1] >= id)) {
    context.addIssue({ code: "custom", path: ["keys"], message: "trust keys must be unique and sorted" });
  }
  if (Date.parse(snapshot.checkedAt) >= Date.parse(snapshot.nextUpdate)) {
    context.addIssue({ code: "custom", path: ["nextUpdate"], message: "trust snapshot window is inconsistent" });
  }
});

const signedTrustSnapshotSchema = z.object({
  document: trustSnapshotDocumentSchema,
  signature: detachedSignatureSchema,
}).strict();

export const q1bSecurityStateSnapshotSchema = z.object({
  schemaVersion: z.literal("q1b-security-state.v1"),
  contractDigest: sha256Schema,
  seriesId: identifierSchema,
  version: z.number().int().nonnegative(),
  previousSnapshotDigest: sha256Schema.nullable(),
  generation: z.number().int().positive(),
  createdAt: timestampSchema,
  components: z.array(signedComponentSchema).length(q1bSecurityComponentRoles.length),
  trustSnapshot: signedTrustSnapshotSchema,
  finalizerKeyId: identifierSchema,
}).strict().superRefine((snapshot, context) => {
  if ((snapshot.version === 0) !== (snapshot.previousSnapshotDigest === null)) {
    context.addIssue({ code: "custom", path: ["previousSnapshotDigest"], message: "only the first security snapshot may omit its predecessor" });
  }
  if (canonicalJson(snapshot.components.map(({ document }) => document.role))
    !== canonicalJson([...q1bSecurityComponentRoles])) {
    context.addIssue({ code: "custom", path: ["components"], message: "security components must occur in canonical role order" });
  }
});

export type Q1bSecurityStateSnapshot = z.infer<typeof q1bSecurityStateSnapshotSchema>;

export const signedQ1bSecurityStateSchema = z.object({
  document: q1bSecurityStateSnapshotSchema,
  signature: detachedSignatureSchema,
}).strict();
export type SignedQ1bSecurityState = z.infer<typeof signedQ1bSecurityStateSchema>;

const stateAnchorDocumentSchema = z.object({
  schemaVersion: z.literal("q1b-security-state-anchor.v1"),
  contractDigest: sha256Schema,
  seriesId: identifierSchema,
  version: z.number().int().nonnegative(),
  snapshotDigest: sha256Schema,
  previousAnchorDigest: sha256Schema.nullable(),
  anchorBackendId: identifierSchema,
  anchoredAt: timestampSchema,
  anchorKeyId: identifierSchema,
}).strict().superRefine((anchor, context) => {
  if ((anchor.version === 0) !== (anchor.previousAnchorDigest === null)) {
    context.addIssue({ code: "custom", path: ["previousAnchorDigest"], message: "only the first state anchor may omit its predecessor" });
  }
});

export const signedQ1bSecurityStateAnchorSchema = z.object({
  document: stateAnchorDocumentSchema,
  signature: detachedSignatureSchema,
}).strict();
export type SignedQ1bSecurityStateAnchor = z.infer<typeof signedQ1bSecurityStateAnchorSchema>;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function q1bSecurityStateContractDigest(contract: Q1bSecurityStateContract): string {
  return digest(contract);
}

export function q1bSecurityStateSnapshotDigest(snapshot: Q1bSecurityStateSnapshot): string {
  return digest(snapshot);
}

export function q1bSecurityStateAnchorDigest(anchor: SignedQ1bSecurityStateAnchor): string {
  return digest(anchor);
}

function verifySignature(options: {
  document: unknown;
  signature: z.infer<typeof detachedSignatureSchema>;
  key: z.infer<typeof pinnedKeySchema>;
  role: string;
}): void {
  const documentDigest = digest(options.document);
  if (options.signature.role !== options.role
    || options.signature.keyId !== options.key.keyId
    || options.signature.payloadSha256 !== documentDigest) {
    throw new Error(`Security-state ${options.role} signature binding mismatch`);
  }
  const rawSignature = Buffer.from(options.signature.signatureBase64, "base64");
  if (rawSignature.length !== 64 || rawSignature.toString("base64") !== options.signature.signatureBase64) {
    throw new Error(`Security-state ${options.role} signature encoding is invalid`);
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(options.key.publicKeyBase64, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(canonicalJson(options.document)), publicKey, rawSignature)) {
    throw new Error(`Security-state ${options.role} signature is invalid`);
  }
}

function requiredKeyIds(contract: Q1bSecurityStateContract): string[] {
  return [
    contract.finalizer.keyId,
    contract.stateAnchorWriter.keyId,
    ...contract.components.flatMap(({ signer, anchorWriter }) => [signer.keyId, anchorWriter.keyId]),
  ].sort();
}

function verifyTrustSnapshot(options: {
  contract: Q1bSecurityStateContract;
  trustSnapshot: z.infer<typeof signedTrustSnapshotSchema>;
  now: Date;
}): void {
  const { contract, trustSnapshot, now } = options;
  verifySignature({
    document: trustSnapshot.document,
    signature: trustSnapshot.signature,
    key: contract.trustAttestor,
    role: "q1b-security-trust-attestor",
  });
  if (trustSnapshot.document.policyDigest !== contract.trustPolicyDigest
    || trustSnapshot.document.attestorKeyId !== contract.trustAttestor.keyId
    || canonicalJson(trustSnapshot.document.keys.map(({ keyId }) => keyId))
      !== canonicalJson(requiredKeyIds(contract))) {
    throw new Error("Security-state trust snapshot contract or key-set mismatch");
  }
  const nowMs = now.getTime();
  if (Date.parse(trustSnapshot.document.checkedAt) > nowMs
    || Date.parse(trustSnapshot.document.nextUpdate) < nowMs
    || trustSnapshot.document.keys.some(({ state }) => state !== "clear")) {
    throw new Error("Security-state trust snapshot is stale, not yet valid, or revoked");
  }
}

function verifyComponent(options: {
  contract: Q1bSecurityStateContract;
  component: z.infer<typeof signedComponentSchema>;
  index: number;
  now: Date;
}): void {
  const policy = options.contract.components[options.index];
  const { document, signature, anchor } = options.component;
  if (document.role !== policy.role
    || document.sourceId !== policy.sourceId
    || document.sourcePolicyDigest !== policy.sourcePolicyDigest
    || document.generation !== options.contract.generation
    || document.signerKeyId !== policy.signer.keyId) {
    throw new Error(`Security component ${policy.role} contract binding mismatch`);
  }
  verifySignature({ document, signature, key: policy.signer, role: policy.role });
  if (anchor.document.role !== policy.role
    || anchor.document.sourceId !== policy.sourceId
    || anchor.document.anchorBackendId !== policy.anchorBackendId
    || anchor.document.componentRecordDigest !== digest(document)
    || anchor.document.sourceHeadDigest !== document.headDigest
    || anchor.document.sourceSequence !== document.sequence
    || anchor.document.anchorKeyId !== policy.anchorWriter.keyId) {
    throw new Error(`Security component ${policy.role} anchor binding mismatch`);
  }
  verifySignature({
    document: anchor.document,
    signature: anchor.signature,
    key: policy.anchorWriter,
    role: `${policy.role}-anchor`,
  });
  const nowMs = options.now.getTime();
  if (Date.parse(document.observedAt) > nowMs
    || Date.parse(document.nextUpdate) < nowMs
    || nowMs - Date.parse(document.observedAt) > options.contract.healthMaxAgeSeconds * 1000
    || Date.parse(anchor.document.anchoredAt) < Date.parse(document.observedAt)
    || Date.parse(anchor.document.anchoredAt) > nowMs) {
    throw new Error(`Security component ${policy.role} health is stale or not yet valid`);
  }
  if (document.sealViolationCount !== 0
    || document.coverageGapCount !== 0
    || document.openIncidentCount !== 0
    || document.latchHold) {
    throw new Error(`Security component ${policy.role} is not releaseable`);
  }
}

export function verifyQ1bSecurityState(options: {
  contract: unknown;
  envelope: unknown;
  highestAnchor: unknown;
  now: Date;
  previous?: { envelope: unknown; highestAnchor: unknown };
}): {
  contractDigest: string;
  snapshotDigest: string;
  seriesId: string;
  version: number;
  anchorDigest: string;
} {
  const contract = q1bSecurityStateContractSchema.parse(options.contract);
  const envelope = signedQ1bSecurityStateSchema.parse(options.envelope);
  const highestAnchor = signedQ1bSecurityStateAnchorSchema.parse(options.highestAnchor);
  const contractDigest = q1bSecurityStateContractDigest(contract);
  const snapshotDigest = q1bSecurityStateSnapshotDigest(envelope.document);
  if (envelope.document.contractDigest !== contractDigest
    || envelope.document.generation !== contract.generation
    || envelope.document.finalizerKeyId !== contract.finalizer.keyId) {
    throw new Error("Security-state snapshot contract binding mismatch");
  }
  verifyTrustSnapshot({ contract, trustSnapshot: envelope.document.trustSnapshot, now: options.now });
  envelope.document.components.forEach((component, index) => {
    verifyComponent({ contract, component, index, now: options.now });
  });
  verifySignature({
    document: envelope.document,
    signature: envelope.signature,
    key: contract.finalizer,
    role: "q1b-security-state-finalizer",
  });
  const nowMs = options.now.getTime();
  if (Date.parse(envelope.document.createdAt) > nowMs
    || envelope.document.components.some(({ document }) =>
      Date.parse(document.observedAt) > Date.parse(envelope.document.createdAt))) {
    throw new Error("Security-state snapshot creation time precedes its evidence or is in the future");
  }
  if (highestAnchor.document.contractDigest !== contractDigest
    || highestAnchor.document.seriesId !== envelope.document.seriesId
    || highestAnchor.document.version !== envelope.document.version
    || highestAnchor.document.snapshotDigest !== snapshotDigest
    || highestAnchor.document.anchorBackendId !== contract.stateAnchorBackendId
    || highestAnchor.document.anchorKeyId !== contract.stateAnchorWriter.keyId
    || Date.parse(highestAnchor.document.anchoredAt) < Date.parse(envelope.document.createdAt)
    || Date.parse(highestAnchor.document.anchoredAt) > nowMs) {
    throw new Error("Security-state external highest anchor mismatch");
  }
  verifySignature({
    document: highestAnchor.document,
    signature: highestAnchor.signature,
    key: contract.stateAnchorWriter,
    role: "q1b-security-state-anchor-writer",
  });

  if (options.previous) {
    const previousEnvelope = signedQ1bSecurityStateSchema.parse(options.previous.envelope);
    const previousAnchor = signedQ1bSecurityStateAnchorSchema.parse(options.previous.highestAnchor);
    const previousDigest = q1bSecurityStateSnapshotDigest(previousEnvelope.document);
    if (previousEnvelope.document.contractDigest !== contractDigest
      || previousEnvelope.document.generation !== contract.generation
      || previousEnvelope.document.finalizerKeyId !== contract.finalizer.keyId
      || previousAnchor.document.contractDigest !== contractDigest
      || previousAnchor.document.seriesId !== previousEnvelope.document.seriesId
      || previousAnchor.document.version !== previousEnvelope.document.version
      || previousAnchor.document.snapshotDigest !== previousDigest
      || previousAnchor.document.anchorBackendId !== contract.stateAnchorBackendId
      || previousAnchor.document.anchorKeyId !== contract.stateAnchorWriter.keyId
      || envelope.document.seriesId !== previousEnvelope.document.seriesId
      || envelope.document.version !== previousEnvelope.document.version + 1
      || envelope.document.previousSnapshotDigest !== previousDigest
      || highestAnchor.document.previousAnchorDigest !== q1bSecurityStateAnchorDigest(previousAnchor)
      || envelope.document.trustSnapshot.document.sequence
        !== previousEnvelope.document.trustSnapshot.document.sequence + 1
      || envelope.document.trustSnapshot.document.previousSnapshotDigest
        !== digest(previousEnvelope.document.trustSnapshot.document)
      || Date.parse(envelope.document.createdAt) <= Date.parse(previousEnvelope.document.createdAt)) {
      throw new Error("Security-state successor chain mismatch");
    }
    verifySignature({
      document: previousEnvelope.document,
      signature: previousEnvelope.signature,
      key: contract.finalizer,
      role: "q1b-security-state-finalizer",
    });
    verifySignature({
      document: previousAnchor.document,
      signature: previousAnchor.signature,
      key: contract.stateAnchorWriter,
      role: "q1b-security-state-anchor-writer",
    });
    for (const [index, component] of envelope.document.components.entries()) {
      const previousComponent = previousEnvelope.document.components[index].document;
      if (component.document.sequence < previousComponent.sequence
        || component.document.sourceCursor < previousComponent.sourceCursor
        || component.document.latchVersion < previousComponent.latchVersion) {
        throw new Error(`Security component ${component.document.role} regressed`);
      }
    }
  }
  return {
    contractDigest,
    snapshotDigest,
    seriesId: envelope.document.seriesId,
    version: envelope.document.version,
    anchorDigest: q1bSecurityStateAnchorDigest(highestAnchor),
  };
}
