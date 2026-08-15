import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  q1bSecurityComponentRoles,
  q1bSecurityStateAnchorDigest,
  q1bSecurityStateContractDigest,
  q1bSecurityStateContractSchema,
  q1bSecurityStateMutableFields,
  q1bSecurityStateSnapshotDigest,
  verifyQ1bSecurityState,
  type Q1bSecurityStateContract,
  type SignedQ1bSecurityState,
  type SignedQ1bSecurityStateAnchor,
} from "../shared/q1bSecurityState.js";

const sha = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : canonicalJson(value))
  .digest("hex");

type SigningKey = {
  keyId: string;
  privateKey: KeyObject;
  publicKeyBase64: string;
};

function key(keyId: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  };
}

function signature(document: unknown, signingKey: SigningKey, role: string) {
  return {
    schemaVersion: "ltx-studio-detached-signature.v1" as const,
    algorithm: "ed25519" as const,
    role,
    keyId: signingKey.keyId,
    payloadSha256: sha(document),
    signatureBase64: sign(null, Buffer.from(canonicalJson(document)), signingKey.privateKey).toString("base64"),
  };
}

function baseFixture() {
  const trustAttestor = key("security-trust-attestor-001");
  const finalizer = key("security-state-finalizer-001");
  const stateAnchorWriter = key("security-state-anchor-001");
  const componentKeys = q1bSecurityComponentRoles.map((role, index) => ({
    role,
    sourceId: `security-source-${String(index + 1).padStart(2, "0")}`,
    sourcePolicyDigest: sha(`source-policy-${role}`),
    signer: key(`component-signer-${String(index + 1).padStart(2, "0")}`),
    anchorBackendId: `component-anchor-backend-${String(index + 1).padStart(2, "0")}`,
    anchorWriter: key(`component-anchor-writer-${String(index + 1).padStart(2, "0")}`),
  }));
  const contract: Q1bSecurityStateContract = q1bSecurityStateContractSchema.parse({
    schemaVersion: "q1b-security-state-contract.v1",
    contractId: "q1b-security-contract-001",
    generation: 7,
    trustPolicyDigest: sha("security-trust-policy"),
    trustAttestor: {
      keyId: trustAttestor.keyId,
      publicKeyBase64: trustAttestor.publicKeyBase64,
    },
    finalizer: {
      keyId: finalizer.keyId,
      publicKeyBase64: finalizer.publicKeyBase64,
    },
    stateAnchorBackendId: "security-state-worm-anchor-001",
    stateAnchorWriter: {
      keyId: stateAnchorWriter.keyId,
      publicKeyBase64: stateAnchorWriter.publicKeyBase64,
    },
    healthMaxAgeSeconds: 300,
    allowedMutableFields: [...q1bSecurityStateMutableFields],
    components: componentKeys.map(({ signer, anchorWriter, ...component }) => ({
      ...component,
      signer: { keyId: signer.keyId, publicKeyBase64: signer.publicKeyBase64 },
      anchorWriter: { keyId: anchorWriter.keyId, publicKeyBase64: anchorWriter.publicKeyBase64 },
    })),
  });
  return { trustAttestor, finalizer, stateAnchorWriter, componentKeys, contract };
}

type BaseFixture = ReturnType<typeof baseFixture>;
type StateFixture = {
  envelope: SignedQ1bSecurityState;
  highestAnchor: SignedQ1bSecurityStateAnchor;
};

function stateFixture(options: {
  base: BaseFixture;
  version?: number;
  previous?: StateFixture;
  revokedKeyId?: string;
  latchHold?: boolean;
}): StateFixture {
  const version = options.version ?? 0;
  const observedAt = `2026-08-15T12:${String(version).padStart(2, "0")}:00Z`;
  const nextUpdate = `2026-08-15T12:${String(version + 5).padStart(2, "0")}:00Z`;
  const components = options.base.componentKeys.map((component) => {
    const document = {
      schemaVersion: "q1b-security-component-record.v1" as const,
      role: component.role,
      sourceId: component.sourceId,
      sourcePolicyDigest: component.sourcePolicyDigest,
      generation: options.base.contract.generation,
      sequence: version,
      sourceCursor: 100 + version,
      bootId: "security-boot-001",
      headDigest: sha(`${component.role}-head-${version}`),
      observedAt,
      nextUpdate,
      health: "pass" as const,
      sealViolationCount: 0,
      coverageGapCount: 0,
      openIncidentCount: 0,
      latchVersion: version,
      latchHold: options.latchHold ?? false,
      factsDigest: sha(`${component.role}-facts-${version}`),
      signerKeyId: component.signer.keyId,
    };
    const anchorDocument = {
      schemaVersion: "q1b-security-component-anchor.v1" as const,
      role: component.role,
      sourceId: component.sourceId,
      anchorBackendId: component.anchorBackendId,
      componentRecordDigest: sha(document),
      sourceHeadDigest: document.headDigest,
      sourceSequence: document.sequence,
      anchoredAt: observedAt,
      anchorKeyId: component.anchorWriter.keyId,
    };
    return {
      document,
      signature: signature(document, component.signer, component.role),
      anchor: {
        document: anchorDocument,
        signature: signature(anchorDocument, component.anchorWriter, `${component.role}-anchor`),
      },
    };
  });
  const requiredKeys = [
    options.base.finalizer.keyId,
    options.base.stateAnchorWriter.keyId,
    ...options.base.componentKeys.flatMap(({ signer, anchorWriter }) => [signer.keyId, anchorWriter.keyId]),
  ].sort();
  const previousTrust = options.previous?.envelope.document.trustSnapshot.document;
  const trustDocument = {
    schemaVersion: "q1b-security-trust-snapshot.v1" as const,
    policyDigest: options.base.contract.trustPolicyDigest,
    sequence: version,
    previousSnapshotDigest: previousTrust ? sha(previousTrust) : null,
    checkedAt: observedAt,
    nextUpdate,
    keys: requiredKeys.map((keyId) => ({
      keyId,
      state: keyId === options.revokedKeyId ? "revoked" as const : "clear" as const,
    })),
    attestorKeyId: options.base.trustAttestor.keyId,
  };
  const snapshot = {
    schemaVersion: "q1b-security-state.v1" as const,
    contractDigest: q1bSecurityStateContractDigest(options.base.contract),
    seriesId: "q1b-security-series-001",
    version,
    previousSnapshotDigest: options.previous
      ? q1bSecurityStateSnapshotDigest(options.previous.envelope.document)
      : null,
    generation: options.base.contract.generation,
    createdAt: observedAt,
    components,
    trustSnapshot: {
      document: trustDocument,
      signature: signature(trustDocument, options.base.trustAttestor, "q1b-security-trust-attestor"),
    },
    finalizerKeyId: options.base.finalizer.keyId,
  };
  const envelope: SignedQ1bSecurityState = {
    document: snapshot,
    signature: signature(snapshot, options.base.finalizer, "q1b-security-state-finalizer"),
  };
  const anchorDocument = {
    schemaVersion: "q1b-security-state-anchor.v1" as const,
    contractDigest: snapshot.contractDigest,
    seriesId: snapshot.seriesId,
    version,
    snapshotDigest: q1bSecurityStateSnapshotDigest(snapshot),
    previousAnchorDigest: options.previous ? q1bSecurityStateAnchorDigest(options.previous.highestAnchor) : null,
    anchorBackendId: options.base.contract.stateAnchorBackendId,
    anchoredAt: observedAt,
    anchorKeyId: options.base.stateAnchorWriter.keyId,
  };
  return {
    envelope,
    highestAnchor: {
      document: anchorDocument,
      signature: signature(anchorDocument, options.base.stateAnchorWriter, "q1b-security-state-anchor-writer"),
    },
  };
}

describe("proof-carrying Q1b security state", () => {
  it("verifies all seven component signatures, anchors, trust and the external highest head", () => {
    const base = baseFixture();
    const state = stateFixture({ base });
    expect(verifyQ1bSecurityState({
      contract: base.contract,
      ...state,
      now: new Date("2026-08-15T12:02:00Z"),
    })).toEqual({
      contractDigest: q1bSecurityStateContractDigest(base.contract),
      snapshotDigest: q1bSecurityStateSnapshotDigest(state.envelope.document),
      seriesId: "q1b-security-series-001",
      version: 0,
      anchorDigest: q1bSecurityStateAnchorDigest(state.highestAnchor),
    });
  });

  it("rejects component facts fabricated by a compromised aggregate finalizer", () => {
    const base = baseFixture();
    const state = stateFixture({ base });
    state.envelope.document.components[0].document.factsDigest = sha("fabricated-green-facts");
    state.envelope.signature = signature(
      state.envelope.document,
      base.finalizer,
      "q1b-security-state-finalizer",
    );
    expect(() => verifyQ1bSecurityState({
      contract: base.contract,
      ...state,
      now: new Date("2026-08-15T12:02:00Z"),
    })).toThrow(/joint-seal-writer signature binding mismatch/i);
  });

  it("rejects a still-fresh old green snapshot when the external highest anchor advanced", () => {
    const base = baseFixture();
    const previous = stateFixture({ base });
    const current = stateFixture({ base, version: 1, previous });
    expect(() => verifyQ1bSecurityState({
      contract: base.contract,
      envelope: previous.envelope,
      highestAnchor: current.highestAnchor,
      now: new Date("2026-08-15T12:03:00Z"),
    })).toThrow(/highest anchor mismatch/);
  });

  it("rejects an aggregate whose component anchor proof was substituted", () => {
    const base = baseFixture();
    const state = stateFixture({ base });
    state.envelope.document.components[0].anchor.document.sourceHeadDigest = sha("foreign-source-head");
    state.envelope.signature = signature(
      state.envelope.document,
      base.finalizer,
      "q1b-security-state-finalizer",
    );
    expect(() => verifyQ1bSecurityState({
      contract: base.contract,
      ...state,
      now: new Date("2026-08-15T12:02:00Z"),
    })).toThrow(/anchor binding mismatch/);
  });

  it("accepts only a monotone same-contract successor", () => {
    const base = baseFixture();
    const previous = stateFixture({ base });
    const current = stateFixture({ base, version: 1, previous });
    expect(verifyQ1bSecurityState({
      contract: base.contract,
      ...current,
      previous,
      now: new Date("2026-08-15T12:03:00Z"),
    }).version).toBe(1);
  });

  it("fails closed for a revoked component key or a set security interlock", () => {
    const base = baseFixture();
    const revoked = stateFixture({ base, revokedKeyId: base.componentKeys[3].signer.keyId });
    expect(() => verifyQ1bSecurityState({
      contract: base.contract,
      ...revoked,
      now: new Date("2026-08-15T12:02:00Z"),
    })).toThrow(/stale, not yet valid, or revoked/);

    const held = stateFixture({ base, latchHold: true });
    expect(() => verifyQ1bSecurityState({
      contract: base.contract,
      ...held,
      now: new Date("2026-08-15T12:02:00Z"),
    })).toThrow(/not releaseable/);
  });
});
