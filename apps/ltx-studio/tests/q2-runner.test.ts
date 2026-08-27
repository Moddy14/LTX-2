import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { evaluationAuthorizationSchema } from "../shared/evaluationAuthorization.js";
import {
  q2RunnerContractDigest,
  q2RunnerContractSchema,
  validateQ2RunnerLaunch,
} from "../server/q2Runner.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const runnerDigest = sha("q2-runner");
  const releaseDigest = sha("release");
  const surfaceDigest = sha("surface");
  const runtimeInstallSealSha256 = sha("runtime-seal");
  const runtimeTreeSha256 = sha("runtime-tree");
  const runtimePolicySha256 = sha("runtime-policy");
  const nodeExecutableSha256 = sha("node-executable");
  const runtimeSandboxDigest = sha("runtime-sandbox");
  const orchestratorContractDigest = sha("orchestrator-contract");
  const holdoutInputManifestDigest = sha("input-root-manifest");
  const outputRootPolicyDigest = sha("output-policy");
  const contract = q2RunnerContractSchema.parse({
    schemaVersion: "q2-runner.v3",
    runnerDigest,
    releaseDigest,
    surfaceDigest,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust: runtimeTrustFixture,
    runtimeSandboxDigest,
    orchestratorContractDigest,
    uid: 42042,
    consumerId: "ltx-q2-runner",
    inputRoot: "/sealed/q2/input",
    inputRootManifestDigest: holdoutInputManifestDigest,
    outputRoot: "/sealed/q2/output",
    outputRootPolicyDigest,
    productApiCapability: "none",
    jobsCreateCapability: "none",
    activationJournalCapability: "none",
    qualificationRegistryCapability: "none",
    directGpuCapability: "orchestrator-grant-only",
  });
  const authorization = evaluationAuthorizationSchema.parse({
    schemaVersion: "ltx-studio-evaluation-authorization.v3",
    authorizationId: "q2-evaluation-001",
    releaseDigest,
    surfaceDigest,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust: runtimeTrustFixture,
    preregistrationDigest: sha("preregistration"),
    q2RunnerDigest: runnerDigest,
    q2RunnerContractDigest: q2RunnerContractDigest(contract),
    q2RuntimeSandboxDigest: runtimeSandboxDigest,
    orchestratorContractDigest,
    evaluationMatrixDigest: sha("matrix"),
    holdoutCiphertextDigest: sha("input-root-manifest"),
    holdoutKeyEnvelopeDigest: sha("key-envelope"),
    holdoutInputManifestDigest,
    outputRootPolicyDigest,
    rights: {
      policyEvidenceDigest: sha("rights"),
      attestationSeriesId: "rights-series-001",
      minimumSnapshotVersion: 3,
      sameSeriesSuccessorAllowed: true,
    },
    q1bSeal: {
      quiescenceDigest: sha("quiescence"),
      jointSealDigest: sha("joint-seal"),
      studioRegistryHeadDigest: sha("studio-head"),
      studioRegistryAnchorHeadDigest: sha("studio-anchor"),
      externalRegistryHeadDigest: sha("external-head"),
      externalRegistryAnchorHeadDigest: sha("external-anchor"),
      finalReleaseEqualityDigest: sha("equality"),
    },
    securityState: {
      snapshotDigest: sha("security-state"),
      contractDigest: sha("security-contract"),
      seriesId: "security-series-001",
      minimumVersion: 7,
      externalAnchorHeadDigest: sha("security-anchor"),
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
  const observation = {
    uid: contract.uid,
    consumerId: contract.consumerId,
    runnerDigest: contract.runnerDigest,
    inputRoot: contract.inputRoot,
    outputRoot: contract.outputRoot,
    inputRootReadOnly: true,
    outputRootWriteOnly: true,
    productApiReachable: false,
    jobsCreateReachable: false,
    activationJournalReachable: false,
    qualificationRegistryReachable: false,
    foreignRootsReachable: false,
    gpuDeviceReachableWithoutGrant: false,
    gpuDeviceReachableWithGrant: true,
    grant: {
      schemaVersion: "q2-orchestrator-admission-grant.v3",
      grantId: "00000000-0000-4000-8000-000000000701",
      jobId: "q2-holdout-job-001",
      consumerId: contract.consumerId,
      runtimeSandboxDigest: contract.runtimeSandboxDigest,
      orchestratorContractDigest: contract.orchestratorContractDigest,
      runnerDigest: contract.runnerDigest,
      releaseDigest: contract.releaseDigest,
      runtimeInstallSealSha256: contract.runtimeInstallSealSha256,
      runtimeTreeSha256: contract.runtimeTreeSha256,
      runtimePolicySha256: contract.runtimePolicySha256,
      nodeExecutableSha256: contract.nodeExecutableSha256,
      runtimeTrust: runtimeTrustFixture,
      issuedAt: "2026-08-15T00:20:00Z",
      notBefore: "2026-08-15T00:21:00Z",
      expiresAt: "2026-08-15T11:30:00Z",
      cgroupId: "q2-cgroup-001",
      devicePolicy: "closed",
      killMode: "control-group",
      gpuDeviceIds: ["nvidia0"],
    },
    processCgroupId: "q2-cgroup-001",
    allDescendantsInGrantCgroup: true,
    openGpuDeviceFdsOutsideGrantCgroup: 0,
  };
  return { authorization, contract, observation };
}

describe("independent Q2 runner launch", () => {
  it("accepts only an exact evaluation-authorized orchestrator grant", () => {
    const data = fixture();
    expect(validateQ2RunnerLaunch({
      ...data,
      now: new Date("2026-08-15T00:30:00Z"),
    })).toEqual({
      jobId: "q2-holdout-job-001",
      grantId: "00000000-0000-4000-8000-000000000701",
      cgroupId: "q2-cgroup-001",
      deadline: "2026-08-15T11:30:00Z",
    });
  });

  it.each([
    ["productApiReachable", true],
    ["jobsCreateReachable", true],
    ["activationJournalReachable", true],
    ["qualificationRegistryReachable", true],
    ["foreignRootsReachable", true],
    ["gpuDeviceReachableWithoutGrant", true],
  ] as const)("fails schema validation when %s", (field, value) => {
    const data = fixture();
    expect(() => validateQ2RunnerLaunch({
      authorization: data.authorization,
      contract: data.contract,
      observation: { ...data.observation, [field]: value },
      now: new Date("2026-08-15T00:30:00Z"),
    })).toThrow();
  });

  it("rejects a cross-consumer or cross-cgroup admission grant", () => {
    const data = fixture();
    expect(() => validateQ2RunnerLaunch({
      authorization: data.authorization,
      contract: data.contract,
      observation: {
        ...data.observation,
        grant: { ...data.observation.grant, consumerId: "foreign-consumer" },
      },
      now: new Date("2026-08-15T00:30:00Z"),
    })).toThrow(/grant binding mismatch/);
  });

  it("rejects a contract whose sealed-output policy differs from the authorization", () => {
    const data = fixture();
    expect(() => validateQ2RunnerLaunch({
      authorization: data.authorization,
      contract: { ...data.contract, outputRootPolicyDigest: sha("substituted-output-policy") },
      observation: data.observation,
      now: new Date("2026-08-15T00:30:00Z"),
    })).toThrow(/contract does not match/);
  });

  it("rejects an admission grant for a different runtime sandbox", () => {
    const data = fixture();
    expect(() => validateQ2RunnerLaunch({
      authorization: data.authorization,
      contract: data.contract,
      observation: {
        ...data.observation,
        grant: { ...data.observation.grant, runtimeSandboxDigest: sha("foreign-runtime-sandbox") },
      },
      now: new Date("2026-08-15T00:30:00Z"),
    })).toThrow(/grant binding mismatch/);
  });

  it("rejects grants extending beyond the evaluation deadline", () => {
    const data = fixture();
    expect(() => validateQ2RunnerLaunch({
      authorization: data.authorization,
      contract: data.contract,
      observation: {
        ...data.observation,
        grant: { ...data.observation.grant, expiresAt: "2026-08-15T12:30:00Z" },
      },
      now: new Date("2026-08-15T00:30:00Z"),
    })).toThrow(/evaluation deadline/);
  });

  it("rejects nested or identical sealed roots", () => {
    const data = fixture();
    expect(() => q2RunnerContractSchema.parse({ ...data.contract, outputRoot: "/sealed/q2/input/output" }))
      .toThrow(/disjoint/);
  });
});
