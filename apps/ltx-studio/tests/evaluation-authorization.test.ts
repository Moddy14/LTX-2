import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  assertEvaluationMayContinue,
  assertEvaluationMayStart,
  evaluationAuthorizationDigest,
  evaluationAuthorizationSchema,
  evaluationConsumptionRecordDigest,
  evaluationConsumptionRecordSchema,
  validateEvaluationConsumption,
  type EvaluationConsumptionRecord,
} from "../shared/evaluationAuthorization.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const evaluationKey = generateKeyPairSync("ed25519");
  const holdoutKey = generateKeyPairSync("ed25519");
  const authorization = evaluationAuthorizationSchema.parse({
    schemaVersion: "ltx-studio-evaluation-authorization.v1",
    authorizationId: "q2-evaluation-001",
    releaseDigest: sha("release"),
    surfaceDigest: sha("surface"),
    preregistrationDigest: sha("preregistration"),
    q2RunnerDigest: sha("q2-runner"),
    q2RunnerContractDigest: sha("q2-runner-contract"),
    q2RuntimeSandboxDigest: sha("q2-runtime-sandbox"),
    orchestratorContractDigest: sha("orchestrator-contract"),
    evaluationMatrixDigest: sha("q2-matrix"),
    holdoutCiphertextDigest: sha("holdout-ciphertext"),
    holdoutKeyEnvelopeDigest: sha("holdout-key-envelope"),
    holdoutInputManifestDigest: sha("holdout-input-manifest"),
    outputRootPolicyDigest: sha("output-root-policy"),
    rights: {
      policyEvidenceDigest: sha("rights-policy-evidence"),
      attestationSeriesId: "rights-series-001",
      minimumSnapshotVersion: 3,
      sameSeriesSuccessorAllowed: true,
    },
    q1bSeal: {
      quiescenceDigest: sha("quiescence"),
      jointSealDigest: sha("joint-seal"),
      studioRegistryHeadDigest: sha("studio-registry-head"),
      studioRegistryAnchorHeadDigest: sha("studio-registry-anchor"),
      externalRegistryHeadDigest: sha("external-registry-head"),
      externalRegistryAnchorHeadDigest: sha("external-registry-anchor"),
      finalReleaseEqualityDigest: sha("final-release-equality"),
    },
    securityState: {
      snapshotDigest: sha("security-state"),
      contractDigest: sha("security-contract"),
      seriesId: "security-series-001",
      minimumVersion: 7,
      externalAnchorHeadDigest: sha("security-anchor-head"),
      sameSeriesSuccessorAllowed: true,
    },
    issuedAt: "2026-08-15T00:00:00Z",
    notBefore: "2026-08-15T00:01:00Z",
    startBy: "2026-08-15T01:00:00Z",
    completeBy: "2026-08-15T12:00:00Z",
    nonce: "a".repeat(32),
    maximumJobs: 100,
    maximumGpuSeconds: 100_000,
    maximumOutputBytes: 10_000_000,
    recoveryPolicyDigest: sha("recovery"),
  });
  const signature = {
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "evaluation-authorizer-001",
    payloadSha256: evaluationAuthorizationDigest(authorization),
    signatureBase64: sign(null, Buffer.from(canonicalJson(authorization)), evaluationKey.privateKey).toString("base64"),
  };
  const trustPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1",
    policyId: "q2-trust-policy-001",
    keys: [
      {
        keyId: signature.keyId,
        algorithm: "ed25519",
        publicKeyBase64: evaluationKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
        roles: ["evaluation-authorizer"],
        notBefore: "2026-08-14T00:00:00Z",
        notAfter: "2026-08-16T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "holdout-scorer-001",
        algorithm: "ed25519",
        publicKeyBase64: holdoutKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
        roles: ["holdout-scorer"],
        notBefore: "2026-08-14T00:00:00Z",
        notAfter: "2026-08-16T00:00:00Z",
        revokedAt: null,
      },
    ],
  };
  const transactionId = "00000000-0000-4000-8000-000000000601";
  const started: EvaluationConsumptionRecord = {
    schemaVersion: "ltx-studio-evaluation-consumption-record.v1",
    recordId: "00000000-0000-4000-8000-000000000602",
    sequence: 0,
    previousRecordSha256: null,
    authorizationDigest: evaluationAuthorizationDigest(authorization),
    transactionId,
    authorizationNonce: authorization.nonce,
    state: "started",
    holdoutBytesRead: 0,
    outcome: null,
    outputDigest: null,
    recordedAt: "2026-08-15T00:30:00Z",
    writerId: "q2-consumption-writer-001",
  };
  const consumed: EvaluationConsumptionRecord = {
    ...started,
    recordId: "00000000-0000-4000-8000-000000000603",
    sequence: 1,
    previousRecordSha256: evaluationConsumptionRecordDigest(started),
    state: "consumed",
    holdoutBytesRead: 1,
    recordedAt: "2026-08-15T00:30:01Z",
  };
  return { authorization, signed: { document: authorization, signature }, trustPolicy, transactionId, started, consumed };
}

describe("Q2 evaluation authorization and consumption", () => {
  it("allows one start transaction before any holdout byte is decrypted", () => {
    const data = fixture();
    expect(assertEvaluationMayStart({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      existingRecords: [],
      now: new Date("2026-08-15T00:30:00Z"),
    })).toEqual(data.authorization);
    expect(data.started.holdoutBytesRead).toBe(0);
  });

  it("marks the holdout consumed at the first decrypted byte and permits only the same transaction", () => {
    const data = fixture();
    expect(validateEvaluationConsumption({
      authorization: data.authorization,
      records: [data.started, data.consumed],
    })).toHaveLength(2);
    expect(assertEvaluationMayContinue({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      records: [data.started, data.consumed],
      transactionId: data.transactionId,
      now: new Date("2026-08-15T01:30:00Z"),
    })).toMatchObject({ state: "consumed" });
    expect(() => assertEvaluationMayContinue({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      records: [data.started, data.consumed],
      transactionId: "00000000-0000-4000-8000-000000000699",
      now: new Date("2026-08-15T01:30:00Z"),
    })).toThrow(/different/);
  });

  it("refuses any second start, including before consumption", () => {
    const data = fixture();
    expect(() => assertEvaluationMayStart({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      existingRecords: [data.started],
      now: new Date("2026-08-15T00:40:00Z"),
    })).toThrow(/already started/);
  });

  it("fails closed after start_by or complete_by", () => {
    const data = fixture();
    expect(() => assertEvaluationMayStart({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      existingRecords: [],
      now: new Date("2026-08-15T01:00:01Z"),
    })).toThrow(/start window/);
    expect(() => assertEvaluationMayContinue({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      records: [data.started, data.consumed],
      transactionId: data.transactionId,
      now: new Date("2026-08-15T12:00:01Z"),
    })).toThrow(/continue window/);
  });

  it("rejects started records that claim holdout bytes were already read", () => {
    const data = fixture();
    expect(() => evaluationConsumptionRecordSchema.parse({ ...data.started, holdoutBytesRead: 1 }))
      .toThrow(/first decrypted byte/);
  });

  it("never permits continuation after a terminal result", () => {
    const data = fixture();
    const terminal: EvaluationConsumptionRecord = {
      ...data.consumed,
      recordId: "00000000-0000-4000-8000-000000000604",
      sequence: 2,
      previousRecordSha256: evaluationConsumptionRecordDigest(data.consumed),
      state: "terminal",
      outcome: "failed",
      outputDigest: null,
      recordedAt: "2026-08-15T02:00:00Z",
    };
    expect(() => assertEvaluationMayContinue({
      signed: data.signed,
      trustPolicy: data.trustPolicy,
      records: [data.started, data.consumed, terminal],
      transactionId: data.transactionId,
      now: new Date("2026-08-15T02:30:00Z"),
    })).toThrow(/terminal/);
  });

  it("requires a passed result digest and monotone holdout consumption", () => {
    const data = fixture();
    expect(() => evaluationConsumptionRecordSchema.parse({
      ...data.consumed,
      state: "terminal",
      outcome: "passed",
      outputDigest: null,
    })).toThrow(/output digest/);
    const regressed = {
      ...data.consumed,
      recordId: "00000000-0000-4000-8000-000000000605",
      sequence: 2,
      previousRecordSha256: evaluationConsumptionRecordDigest(data.consumed),
      state: "terminal",
      holdoutBytesRead: 0,
      outcome: "failed",
      recordedAt: "2026-08-15T02:00:00Z",
    };
    expect(() => validateEvaluationConsumption({
      authorization: data.authorization,
      records: [data.started, data.consumed, regressed],
    })).toThrow(/chain or authorization binding mismatch/);
  });
});
