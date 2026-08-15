import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  promotionObservationEnvelopeDigest,
  promotionObservationRecordDigest,
  promotionProbeIds,
  validatePromotionObservation,
  type PromotionObservationPlan,
  type PromotionObservationRecord,
  type SignedPromotionObservationRecord,
  type MonitoringTrustPolicy,
} from "../shared/promotionObservation.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const startedAt = new Date("2026-08-15T00:00:00Z");

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const plan: PromotionObservationPlan = {
    schemaVersion: "ltx-studio-promotion-observation-plan.v1",
    attemptId: "00000000-0000-4000-8000-000000000501",
    generation: 1,
    releaseDigest: sha("release"),
    surfaceDigest: sha("surface"),
    auditEnvelopeDigest: sha("audit"),
    releaseAuthorizationDigest: sha("authorization"),
    activationHeadAtT0Sha256: sha("activation-t0"),
    startedAt: "2026-08-15T00:00:00Z",
    cadenceSeconds: 3600,
    toleranceSeconds: 60,
    requiredProbeIds: [...promotionProbeIds],
    checkpoints: [
      { checkpointId: "o24", elapsedSeconds: 86_400 },
      { checkpointId: "o7", elapsedSeconds: 604_800 },
    ],
    missingPolicy: "fail",
  };
  const planDigest = createHash("sha256").update(canonicalJson(plan)).digest("hex");
  const trustPolicy: MonitoringTrustPolicy = {
    schemaVersion: "ltx-studio-monitoring-trust.v1",
    policyId: "monitoring-trust-001",
    keys: [{
      keyId: "monitoring-signer-001",
      algorithm: "ed25519",
      role: "monitoring-signer",
      publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
      notBefore: "2026-08-14T00:00:00Z",
      notAfter: "2026-08-23T00:00:00Z",
      revokedAt: null,
    }],
  };
  const records: SignedPromotionObservationRecord[] = [];
  for (let sequence = 0; sequence <= 24; sequence += 1) {
    const record: PromotionObservationRecord = {
      schemaVersion: "ltx-studio-promotion-observation-record.v1",
      recordId: `00000000-0000-4000-8000-${String(sequence + 1).padStart(12, "0")}`,
      attemptId: plan.attemptId,
      planDigest,
      sequence,
      previousRecordSha256: sequence === 0 ? null : promotionObservationEnvelopeDigest(records[sequence - 1]),
      generation: plan.generation,
      releaseDigest: plan.releaseDigest,
      surfaceDigest: plan.surfaceDigest,
      auditEnvelopeDigest: plan.auditEnvelopeDigest,
      releaseAuthorizationDigest: plan.releaseAuthorizationDigest,
      activationHeadSha256: sequence === 0 ? plan.activationHeadAtT0Sha256 : sha(`activation-${sequence}`),
      wallClockAt: new Date(startedAt.getTime() + sequence * 3_600_000).toISOString().replace(".000Z", "Z"),
      elapsedSeconds: sequence * 3600,
      bootOrdinal: 0,
      bootId: "boot-identifier-001",
      monotonicMs: sequence * 3_600_000,
      rightsSnapshotDigest: sha(`rights-${sequence}`),
      securityStateDigest: sha(`security-${sequence}`),
      rawLogDigest: sha(`raw-log-${sequence}`),
      probes: promotionProbeIds.map((probeId) => ({
        probeId,
        status: "pass" as const,
        policyDigest: sha(`policy-${probeId}`),
        evidenceDigest: sha(`evidence-${sequence}-${probeId}`),
      })),
      monitoringKeyId: "monitoring-signer-001",
    };
    records.push({
      record,
      signature: {
        schemaVersion: "ltx-studio-detached-signature.v1",
        algorithm: "ed25519",
        role: "monitoring-signer",
        keyId: record.monitoringKeyId,
        payloadSha256: promotionObservationRecordDigest(record),
        signatureBase64: sign(null, Buffer.from(canonicalJson(record)), privateKey).toString("base64"),
      },
    });
  }
  return { plan, records, trustPolicy, privateKey };
}

describe("post-promotion observation contract", () => {
  it("reconstructs O24 only from a complete signed cadence chain", () => {
    const data = fixture();
    expect(validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).toEqual({
      checkpoint: "o24",
      recordCount: 25,
      headSha256: promotionObservationEnvelopeDigest(data.records.at(-1)!),
      verdict: "pass",
    });
  });

  it("fails closed when a cadence slot is missing", () => {
    const data = fixture();
    data.records.splice(10, 1);
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).toThrow(/missing or extra cadence slot/);
  });

  it("rejects post-signature raw-log mutation", () => {
    const data = fixture();
    data.records[12].record.rawLogDigest = sha("mutated-log");
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).toThrow(/signature binding mismatch/);
  });

  it("records a red probe but never finalizes it as pass", () => {
    const data = fixture();
    const last = data.records.at(-1)!;
    last.record.probes[1].status = "fail";
    last.signature.payloadSha256 = promotionObservationRecordDigest(last.record);
    last.signature.signatureBase64 = sign(
      null,
      Buffer.from(canonicalJson(last.record)),
      data.privateKey,
    ).toString("base64");
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).toThrow(/failed probe/);
  });

  it("rejects a complete-looking O24 chain before its wall-clock checkpoint", () => {
    const data = fixture();
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-15T23:59:00Z"),
    })).toThrow(/wall clock/);
  });

  it("accepts a monotonic reset only with the next boot ordinal and a new boot id", () => {
    const data = fixture();
    for (let index = 12; index < data.records.length; index += 1) {
      const record = data.records[index].record;
      record.bootOrdinal = 1;
      record.bootId = "boot-identifier-002";
      record.monotonicMs = (index - 12) * 3_600_000;
      record.previousRecordSha256 = index === 0 ? null : promotionObservationEnvelopeDigest(data.records[index - 1]);
      data.records[index].signature.payloadSha256 = promotionObservationRecordDigest(record);
      data.records[index].signature.signatureBase64 = sign(
        null,
        Buffer.from(canonicalJson(record)),
        data.privateKey,
      ).toString("base64");
    }
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).not.toThrow();

    data.records[12].record.bootOrdinal = 2;
    data.records[12].signature.payloadSha256 = promotionObservationRecordDigest(data.records[12].record);
    data.records[12].signature.signatureBase64 = sign(
      null,
      Buffer.from(canonicalJson(data.records[12].record)),
      data.privateKey,
    ).toString("base64");
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).toThrow(/boot or monotonic sequence mismatch/);
  });

  it("rejects a monitoring key revoked by checkpoint time", () => {
    const data = fixture();
    data.trustPolicy.keys[0].revokedAt = "2026-08-15T12:00:00Z";
    expect(() => validatePromotionObservation({
      plan: data.plan,
      records: data.records,
      trustPolicy: data.trustPolicy,
      checkpoint: "o24",
      now: new Date("2026-08-16T00:00:00Z"),
    })).toThrow(/unavailable or revoked/);
  });
});
