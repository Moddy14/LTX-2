import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  collectReleaseEvidence,
  finalizeReleaseAudit,
  qualificationGateOwnership,
  qualificationKinds,
  type QualificationKind,
  type ReleaseEvidenceInput,
  trustedKeyPolicySchema,
} from "../shared/releaseAudit.js";
import { releaseGateIds } from "../shared/releaseSurface.js";

const NOW = new Date("2026-08-11T12:00:00Z");
const DIGEST = {
  release: "1".repeat(64),
  catalog: "2".repeat(64),
  producer: "3".repeat(64),
};

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function timestamp(offsetHours: number): string {
  return new Date(NOW.getTime() + offsetHours * 3_600_000)
    .toISOString()
    .replace(".000", "");
}

type Fixture = ReleaseEvidenceInput & {
  signDocument: (document: unknown) => Record<string, unknown>;
  signHoldoutDocument: (document: unknown) => Record<string, unknown>;
  finalizerPrivateKeyPem: string;
};

function fixture(): Fixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const holdout = generateKeyPairSync("ed25519");
  const finalizer = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const trustPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1",
    policyId: "independent-policy-01",
    keys: [
      {
        keyId: "independent-key-01",
        algorithm: "ed25519",
        publicKeyBase64: rawPublicKey.toString("base64"),
        roles: [
          "preregistration-freezer",
          "rights-attestor",
          "qualification-attestor",
          "release-authorizer",
        ],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
      {
        keyId: "holdout-scorer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: holdout.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        roles: ["holdout-scorer"],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
      {
        keyId: "audit-finalizer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: finalizer.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        roles: ["audit-finalizer"],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
    ],
  };
  const signature = (document: unknown) => ({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "independent-key-01",
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      privateKey,
    ).toString("base64"),
  });
  const holdoutSignature = (document: unknown) => ({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "holdout-scorer-key-01",
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      holdout.privateKey,
    ).toString("base64"),
  });
  const surface = {
    schemaVersion: "candidate-release-surface.v1",
    policyVersion: "ltx-studio-release-rights.v1",
    inputs: {
      requestSchema: { path: "shared/pipelines.ts", sha256: "4".repeat(64) },
      capabilityMatrix: {
        path: "shared/releaseSurface.ts",
        sha256: "5".repeat(64),
      },
    },
    activationContract: {
      candidate:
        "requires-current-signed-rights-attest-and-all-applicable-gates",
      blocked: "must-not-run-in-production-or-support-release-claims",
    },
    entries: [
      {
        id: "lipdub.native",
        claimId: "reference-video-redubbing.native",
        request: {
          mode: "lipdub",
          sourceMode: "not-applicable",
          icLoraProfile: null,
          lipDubPipelineProfile: "official-comfy-hq",
          retakeCheckpoint: null,
          dialogueIntent: "required",
          postprocessor: "none",
        },
        inputContract: ["reference-video", "exact-target-dialogue"],
        outputMedia: "video/mp4",
        cooperativeCheckpoint: true,
        applicableGates: [...releaseGateIds],
        notApplicable: [],
        rights: {
          status: "conditional",
          evidenceIds: ["rights.ltx"],
          reason: "signed attestation required",
        },
        targetStatus: "candidate",
      },
    ],
  };
  const preregistration = {
    schema_version: "ltx-av-eval-preregistration.v2",
    status: "frozen",
    target_sota_claim_ids: ["reference-video-redubbing.native"],
  };
  const preregistrationDigest = hash(preregistration);
  const surfaceDigest = hash(surface);
  const rights = {
    schemaVersion: "ltx-studio-rights-attestation.v1",
    releaseDigest: DIGEST.release,
    surfaceDigest,
    evidenceCatalogDigest: DIGEST.catalog,
    policyVersion: "ltx-studio-release-rights.v1",
    validAt: timestamp(-1),
    expiresAt: timestamp(12),
    revocationState: "clear",
    evidenceIds: ["rights.ltx"],
    warnings: [],
  };
  const reports = qualificationKinds.map((kind) => {
    const report = {
      schemaVersion: "ltx-studio-qualification-report.v1",
      kind,
      releaseDigest: DIGEST.release,
      preregistrationDigest,
      surfaceDigest,
      producerId: `producer.${kind}`,
      producerDigest: DIGEST.producer,
      verdict: "pass",
      warnings: [],
      coverage:
        qualificationGateOwnership[kind].length > 0
          ? [
              {
                surfaceEntryId: "lipdub.native",
                gates: [...qualificationGateOwnership[kind]],
              },
            ]
          : [],
      claimResults:
        kind === "q2-holdout"
          ? [
              {
                claimId: "reference-video-redubbing.native",
                status: "sota-qualified",
                sotaAnchorDigest: "6".repeat(64),
              },
            ]
          : [],
    };
    return {
      kind,
      sha256: hash(report),
      document: report,
      signature:
        kind === "q2-holdout" ? holdoutSignature(report) : signature(report),
    };
  });
  const reportReferences = reports.map(({ kind, sha256: reportSha }) => ({
    kind,
    path: `reports/${kind}.json`,
    sha256: reportSha,
    signaturePath: `reports/${kind}.sig.json`,
    signatureSha256: "7".repeat(64),
  }));
  const trustPolicyDigest = hash(trustPolicy);
  const rightsDigest = hash(rights);
  return {
    now: NOW,
    releaseDigest: DIGEST.release,
    manifestSurfaceDigest: surfaceDigest,
    manifestRightsCatalogDigest: DIGEST.catalog,
    surface,
    index: {
      schemaVersion: "ltx-studio-release-evidence-index.v1",
      releaseDigest: DIGEST.release,
      preregistrationDigest,
      targetSotaClaimIds: ["reference-video-redubbing.native"],
      trustPolicy: { path: "trusted-keys.json", sha256: trustPolicyDigest },
      preregistration: {
        path: "preregistration.json",
        sha256: preregistrationDigest,
        signaturePath: "preregistration.sig.json",
        signatureSha256: "7".repeat(64),
      },
      rightsAttestation: {
        path: "rights.json",
        sha256: rightsDigest,
        signaturePath: "rights.sig.json",
        signatureSha256: "7".repeat(64),
      },
      reports: reportReferences,
    },
    trustPolicy,
    preregistration: {
      document: preregistration,
      signature: signature(preregistration),
    },
    rightsAttestation: { document: rights, signature: signature(rights) },
    reports,
    trustPolicyDigest,
    signDocument: signature,
    signHoldoutDocument: holdoutSignature,
    finalizerPrivateKeyPem: finalizer.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

function report(input: ReleaseEvidenceInput, kind: QualificationKind) {
  const found = input.reports.find((item) => item.kind === kind);
  if (!found) throw new Error(`missing fixture report ${kind}`);
  return found;
}

describe("release evidence collector", () => {
  it("accepts a dedicated evaluation-authorizer but rejects role collapse", () => {
    const input = fixture();
    const policy = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    policy.keys[0].roles = ["evaluation-authorizer"];
    expect(trustedKeyPolicySchema.safeParse(policy).success).toBe(true);
    policy.keys[0].roles = [
      "evaluation-authorizer",
      "release-authorizer",
    ];
    expect(trustedKeyPolicySchema.safeParse(policy).success).toBe(false);

    const collapsedHoldout = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    collapsedHoldout.keys[1].roles.push("release-authorizer");
    expect(trustedKeyPolicySchema.safeParse(collapsedHoldout).success).toBe(
      false,
    );
  });

  it("becomes ready only after every signed and bound gate passes", () => {
    const evidence = collectReleaseEvidence(fixture());
    expect(evidence.ready_for_release_authorization).toBe(true);
    expect(evidence.blockers).toEqual([]);
    expect(evidence.targetSotaClaimIds).toEqual([
      "reference-video-redubbing.native",
    ]);
    expect(evidence.claimResults[0]).toMatchObject({
      status: "sota-qualified",
    });
  });

  it("rejects a missing applicable gate", () => {
    const input = fixture();
    const canary = report(input, "r3-canaries");
    const document = canary.document as {
      coverage: Array<{ gates: string[] }>;
    };
    document.coverage[0].gates = document.coverage[0].gates.filter(
      (gate) => gate !== "provenance",
    );
    canary.sha256 = hash(document);
    const reference = (
      input.index as { reports: Array<{ kind: string; sha256: string }> }
    ).reports.find(({ kind }) => kind === "r3-canaries");
    if (reference) reference.sha256 = canary.sha256;
    expect(() => collectReleaseEvidence(input)).toThrow(
      /signature payload digest mismatch/i,
    );
  });

  it("rejects expired rights even when their original signature is valid", () => {
    const input = fixture();
    input.now = new Date("2026-08-12T01:00:00Z");
    expect(() => collectReleaseEvidence(input)).toThrow(
      /rights attestation is stale/i,
    );
  });

  it("rejects local-only results for a frozen target SOTA claim", () => {
    const input = fixture();
    const q2 = report(input, "q2-holdout");
    const document = q2.document as {
      claimResults: Array<{ status: string; sotaAnchorDigest: string | null }>;
    };
    document.claimResults[0] = { status: "local-only", sotaAnchorDigest: null };
    q2.sha256 = hash(document);
    expect(() => collectReleaseEvidence(input)).toThrow(
      /report index mismatch|signature payload digest mismatch/i,
    );
  });

  it("rejects signed Q2 results for claims outside the candidate surface", () => {
    const input = fixture();
    const q2 = report(input, "q2-holdout");
    const document = q2.document as {
      claimResults: Array<{
        claimId: string;
        status: string;
        sotaAnchorDigest: string | null;
      }>;
    };
    document.claimResults.push({
      claimId: "invented.claim",
      status: "sota-qualified",
      sotaAnchorDigest: "9".repeat(64),
    });
    q2.sha256 = hash(document);
    q2.signature = input.signHoldoutDocument(document);
    const reference = (
      input.index as { reports: Array<{ kind: string; sha256: string }> }
    ).reports.find(({ kind }) => kind === "q2-holdout");
    if (!reference) throw new Error("missing Q2 report reference");
    reference.sha256 = q2.sha256;

    expect(() => collectReleaseEvidence(input)).toThrow(
      /result for a non-candidate claim/i,
    );
  });

  it("rejects an incomplete report set and a vacuous target set", () => {
    const incomplete = fixture();
    incomplete.reports.pop();
    expect(() => collectReleaseEvidence(incomplete)).toThrow(/incomplete/i);

    const emptyTargets = fixture();
    (
      emptyTargets.index as { targetSotaClaimIds: string[] }
    ).targetSotaClaimIds = [];
    expect(() => collectReleaseEvidence(emptyTargets)).toThrow();
  });
});

describe("release audit finalizer", () => {
  it("is the first stage allowed to emit production and SOTA go", () => {
    const input = fixture();
    const evidence = collectReleaseEvidence(input);
    const evidenceDigest = hash(evidence);
    const q2ReportDigest = evidence.reports.find(
      ({ kind }) => kind === "q2-holdout",
    )?.sha256;
    if (!q2ReportDigest) throw new Error("missing Q2 fixture digest");
    const authorization = {
      schemaVersion: "ltx-studio-release-authorization.v1",
      releaseDigest: evidence.releaseDigest,
      preregistrationDigest: evidence.preregistrationDigest,
      q2ReportDigest,
      releaseEvidenceDigest: evidenceDigest,
      rightsAttestationDigest: evidence.rightsAttestationDigest,
      notBefore: timestamp(-1),
      expiresAt: timestamp(1),
    };

    const envelope = finalizeReleaseAudit({
      now: NOW,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      rightsAttestation: input.rightsAttestation,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    });

    expect(envelope.audit).toMatchObject({
      production_overall: "go",
      sota_overall: "go",
      releaseEvidenceDigest: evidenceDigest,
      releaseAuthorizationDigest: hash(authorization),
    });
    expect(envelope.signature.payloadSha256).toBe(hash(envelope.audit));
  });

  it("rechecks authorization bindings and rights freshness at finalization", () => {
    const input = fixture();
    const evidence = collectReleaseEvidence(input);
    const evidenceDigest = hash(evidence);
    const q2ReportDigest = evidence.reports.find(
      ({ kind }) => kind === "q2-holdout",
    )?.sha256;
    if (!q2ReportDigest) throw new Error("missing Q2 fixture digest");
    const authorization = {
      schemaVersion: "ltx-studio-release-authorization.v1",
      releaseDigest: evidence.releaseDigest,
      preregistrationDigest: evidence.preregistrationDigest,
      q2ReportDigest,
      releaseEvidenceDigest: "f".repeat(64),
      rightsAttestationDigest: evidence.rightsAttestationDigest,
      notBefore: timestamp(-1),
      expiresAt: timestamp(1),
    };
    expect(() =>
      finalizeReleaseAudit({
        now: NOW,
        evidence,
        evidenceDigest,
        authorization: {
          document: authorization,
          signature: input.signDocument(authorization),
        },
        rightsAttestation: input.rightsAttestation,
        trustPolicy: input.trustPolicy,
        trustPolicyDigest: input.trustPolicyDigest,
        finalizerKeyId: "audit-finalizer-key-01",
        finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
      }),
    ).toThrow(/authorization binding mismatch/i);
  });
});
