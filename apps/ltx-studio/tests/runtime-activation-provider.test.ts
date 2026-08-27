import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { FileRuntimeActivationProvider } from "../server/runtimeActivationProvider.js";
import {
  activationEnvelopeDigest,
  activationRecordDigest,
  type ActivationJournalEnvelope,
  type ActivationJournalRecord,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digestBytes = (value: string) => createHash("sha256").update(value).digest("hex");
const publicRaw = (key: KeyObject) => key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function signedActivation(record: ActivationJournalRecord, privateKey: KeyObject): ActivationJournalEnvelope {
  return {
    record,
    signature: {
      schemaVersion: "ltx-studio-detached-signature.v1",
      algorithm: "ed25519",
      role: "activation-journal-writer",
      keyId: record.writerKeyId,
      payloadSha256: activationRecordDigest(record),
      signatureBase64: sign(null, Buffer.from(canonicalJson(record)), privateKey).toString("base64"),
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ltx-runtime-activation-"));
  roots.push(root);
  const activationKeys = generateKeyPairSync("ed25519");
  const rightsKeys = generateKeyPairSync("ed25519");
  const holdoutKeys = generateKeyPairSync("ed25519");
  const release = {
    releaseDigest: sha("release"),
    surfaceDigest: sha("surface"),
    runtimeInstallSealSha256: sha("runtime-seal"),
    runtimeTreeSha256: sha("runtime-tree"),
    runtimePolicySha256: sha("runtime-policy"),
    nodeExecutableSha256: sha("node-executable"),
    runtimeTrust: runtimeTrustFixture,
    rights: {
      policyEvidenceDigest: sha("rights-evidence"),
      attestationSeriesId: "rights-series-001",
      minimumSnapshotVersion: 4,
    },
  };
  const first = signedActivation({
    schemaVersion: "ltx-studio-activation-journal-record.v3",
    recordId: "00000000-0000-4000-8000-000000000021",
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
  }, activationKeys.privateKey);
  const mode = signedActivation({
    ...first.record,
    recordId: "00000000-0000-4000-8000-000000000022",
    sequence: 1,
    previousRecordSha256: activationEnvelopeDigest(first),
    previousState: "blocked",
    state: "qualification_only",
    operation: "activate_qualification_mode",
    authorizationDigest: sha("mode-authorization"),
    recordedAt: "2026-08-15T00:01:00Z",
  }, activationKeys.privateKey);
  const promotion = signedActivation({
    ...mode.record,
    recordId: "00000000-0000-4000-8000-000000000023",
    sequence: 2,
    previousRecordSha256: activationEnvelopeDigest(mode),
    previousState: "qualification_only",
    state: "production_provisional",
    operation: "promote_production",
    releasedSurfaceEntryIds: ["two-stage.text.prompt.base-gemma.post.none"],
    authorizationDigest: sha("release-authorization"),
    auditEnvelopeDigest: sha("audit-envelope"),
    recordedAt: "2026-08-15T00:02:00Z",
  }, activationKeys.privateKey);
  const activationPolicy = {
    schemaVersion: "ltx-studio-activation-writer-trust.v1",
    policyId: "activation-policy-001",
    keys: [{
      keyId: "activation-writer-001",
      algorithm: "ed25519",
      role: "activation-journal-writer",
      publicKeyBase64: publicRaw(activationKeys.publicKey),
      notBefore: "2026-08-14T00:00:00Z",
      notAfter: "2026-08-16T00:00:00Z",
      revokedAt: null,
    }],
  };
  const rightsPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1",
    policyId: "release-trust-policy-001",
    keys: [{
      keyId: "rights-attestor-001",
      algorithm: "ed25519",
      publicKeyBase64: publicRaw(rightsKeys.publicKey),
      roles: ["rights-attestor"],
      notBefore: "2026-08-14T00:00:00Z",
      notAfter: "2026-08-16T00:00:00Z",
      revokedAt: null,
    }, {
      keyId: "holdout-scorer-001",
      algorithm: "ed25519",
      publicKeyBase64: publicRaw(holdoutKeys.publicKey),
      roles: ["holdout-scorer"],
      notBefore: "2026-08-14T00:00:00Z",
      notAfter: "2026-08-16T00:00:00Z",
      revokedAt: null,
    }],
  };
  const rightsDocument = {
    schemaVersion: "ltx-studio-runtime-rights-snapshot.v3",
    releaseDigest: release.releaseDigest,
    surfaceDigest: release.surfaceDigest,
    runtimeInstallSealSha256: release.runtimeInstallSealSha256,
    runtimeTreeSha256: release.runtimeTreeSha256,
    runtimePolicySha256: release.runtimePolicySha256,
    nodeExecutableSha256: release.nodeExecutableSha256,
    runtimeTrust: release.runtimeTrust,
    policyEvidenceDigest: release.rights.policyEvidenceDigest,
    attestationSeriesId: release.rights.attestationSeriesId,
    version: 4,
    checkedAt: "2026-08-15T00:00:00Z",
    nextUpdate: "2026-08-15T02:00:00Z",
    sourceDigest: sha("revocation-source"),
    revocationState: "clear",
  };
  const rightsEnvelope = {
    document: rightsDocument,
    signature: {
      schemaVersion: "ltx-studio-detached-signature.v1",
      algorithm: "ed25519",
      keyId: "rights-attestor-001",
      payloadSha256: sha(canonicalJson(rightsDocument)),
      signatureBase64: sign(null, Buffer.from(canonicalJson(rightsDocument)), rightsKeys.privateKey).toString("base64"),
    },
  };
  const paths = {
    journalPath: join(root, "journal.json"),
    anchorPath: join(root, "anchor.json"),
    activationTrustPolicyPath: join(root, "activation-trust.json"),
    rightsSnapshotPath: join(root, "rights-snapshot.json"),
    rightsTrustPolicyPath: join(root, "rights-trust.json"),
  };
  const activationPolicyBytes = canonicalJson(activationPolicy);
  const rightsPolicyBytes = canonicalJson(rightsPolicy);
  await Promise.all([
    writeFile(paths.journalPath, canonicalJson([first, mode, promotion])),
    writeFile(paths.anchorPath, canonicalJson({
      generation: 1,
      sequence: 2,
      headSha256: activationEnvelopeDigest(promotion),
    })),
    writeFile(paths.activationTrustPolicyPath, activationPolicyBytes),
    writeFile(paths.rightsSnapshotPath, canonicalJson(rightsEnvelope)),
    writeFile(paths.rightsTrustPolicyPath, rightsPolicyBytes),
  ]);
  const options = {
    ...paths,
    activationTrustPolicyDigest: digestBytes(activationPolicyBytes),
    rightsTrustPolicyDigest: digestBytes(rightsPolicyBytes),
    now: () => new Date("2026-08-15T01:00:00Z"),
  };
  return { root, options, first, mode, promotion, rightsEnvelope };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file-backed runtime activation provider", () => {
  it("derives an allowed production snapshot only from signed, anchored, current inputs", async () => {
    const { options, promotion } = await fixture();
    expect(new FileRuntimeActivationProvider(options).read()).toEqual({
      state: "production_provisional",
      generation: 1,
      activationHeadSha256: activationEnvelopeDigest(promotion),
      releaseDigest: promotion.record.release.releaseDigest,
      surfaceDigest: promotion.record.release.surfaceDigest,
      runtimeInstallSealSha256: promotion.record.release.runtimeInstallSealSha256,
      runtimeTreeSha256: promotion.record.release.runtimeTreeSha256,
      runtimePolicySha256: promotion.record.release.runtimePolicySha256,
      nodeExecutableSha256: promotion.record.release.nodeExecutableSha256,
      runtimeTrust: runtimeTrustFixture,
      rightsCurrent: true,
      releasedSurfaceEntryIds: ["two-stage.text.prompt.base-gemma.post.none"],
    });
  });

  it("rejects a restored journal prefix behind the external anchor", async () => {
    const { options, first, mode } = await fixture();
    await writeFile(options.journalPath, canonicalJson([first, mode]));
    expect(() => new FileRuntimeActivationProvider(options).read()).toThrow(/anchor diverge/);
  });

  it("rejects stale rights and substituted static trust policies", async () => {
    const { options } = await fixture();
    expect(() => new FileRuntimeActivationProvider({
      ...options,
      now: () => new Date("2026-08-15T03:00:00Z"),
    }).read()).toThrow(/rights snapshot is stale/);
    await writeFile(options.activationTrustPolicyPath, canonicalJson({ substituted: true }));
    expect(() => new FileRuntimeActivationProvider(options).read()).toThrow(/trust policy digest mismatch/);
  });

  it("refuses symlink substitution for every runtime control input", async () => {
    const { root, options } = await fixture();
    const replacement = join(root, "replacement.json");
    await writeFile(replacement, await (await import("node:fs/promises")).readFile(options.anchorPath));
    await rm(options.anchorPath);
    await symlink(replacement, options.anchorPath);
    expect(() => new FileRuntimeActivationProvider(options).read()).toThrow();
  });
});
