import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appRoot } from "../server/config.js";

type FixtureResult = {
  schemaVersion: string;
  successful: {
    unitPrefix: string;
    events: string[];
    commands: string[];
    units: string[];
    phases: string[];
    privateIsolation: {
      g2pRequestContainsTarget: boolean;
      g2pRequestContainsAudioPath: boolean;
      adjudicatorRequestContainsTarget: boolean;
      adjudicatorRequestContainsTranscriptPath: boolean;
      adjudicationResultContainsTarget: boolean;
      adjudicationResultContainsAnySnapshotPath: boolean;
    };
    spawnOptions: Array<{
      cwd: string;
      detached: boolean;
      shell: boolean;
      stdio: string[];
      env: Record<string, string>;
    }>;
    ipa: {
      bindingDestinations: string[];
      expectedBindingDestinations: string[];
      hasTranscriptFlag: boolean;
      hasWhisperFlag: boolean;
      hasTranscriptBinding: boolean;
      hasDialogueBinding: boolean;
      hasWhisperBinding: boolean;
    };
    g2p: {
      bindingDestinations: string[];
      expectedBindingDestinations: string[];
      hasAudioBinding: boolean;
      hasTranscriptBinding: boolean;
      hasWhisperBinding: boolean;
      requestSha256: string;
    };
    adjudicator: {
      bindingDestinations: string[];
      expectedBindingDestinations: string[];
      hasAudioBinding: boolean;
      hasTranscriptBinding: boolean;
      hasG2pRequestBinding: boolean;
      argvContainsTranscript: boolean;
      phaseSha256: string;
      referenceSha256: string;
      g2pResultSha256: string;
    };
    quality: {
      bindingDestinations: string[];
      expectedBindingDestinations: string[];
      hasIpaRunnerFlag: boolean;
      hasIpaModelFlag: boolean;
      hasIpaRunnerBinding: boolean;
      hasIpaModelBinding: boolean;
      adjudicationSha256: string;
    };
    canonicalHandoff: {
      emittedStdoutSha256: string;
      canonicalSha256: string;
      qualityExpectedSha256: string;
      observationSha256: string;
      observationIsCanonical: boolean;
      observationMode: string;
      adjudicationSha256: string;
      qualityAdjudicationSha256: string;
      adjudicationIsCanonical: boolean;
      adjudicationMode: string;
    };
    result: {
      analysisStatus: string;
      eligibilityStatus: string;
      eligibilityBlockers: string[];
      evaluatorFingerprint: string;
      expectedBindingFingerprint: string;
      independentlyCombinedFingerprint: string;
      qualityEvaluatorFingerprint: string;
      independentIpaEvaluatorFingerprint: string;
      germanG2pEvaluatorFingerprint: string;
      ipaAdjudicatorFingerprint: string;
      claimScope: string;
    };
  };
  aborted: {
    events: string[];
    spawnCount: number;
    phases: string[];
    errorName: string | null;
    errorCode: string | null;
    observationMaterialized: boolean;
  };
};

async function runFixture(): Promise<FixtureResult> {
  const root = await mkdtemp(join(tmpdir(), "ltx-t2a-two-phase-test-"));
  const privateDataRoot = join(root, "private-data");
  await mkdir(privateDataRoot, { mode: 0o700 });
  await chmod(privateDataRoot, 0o700);
  const environment = { ...process.env };
  delete environment.VITEST_WORKER_ID;
  delete environment.VITEST_POOL_ID;
  delete environment.LTX_STUDIO_SEALED_RELEASE;
  try {
    const execution = spawnSync(
      join(appRoot, "node_modules", ".bin", "tsx"),
      [join(appRoot, "tests", "t2a-audio-two-phase-orchestration.fixture.ts")],
      {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...environment,
          VITEST: "false",
          LTX_STUDIO_T2A_DEVELOPMENT_MEASUREMENT: "1",
          LTX_STUDIO_DATA_DIR: privateDataRoot,
        },
      },
    );
    expect(execution.error).toBeUndefined();
    expect(execution.status, execution.stderr).toBe(0);
    expect(execution.signal).toBeNull();
    expect(execution.stderr).toBe("");
    return JSON.parse(execution.stdout.trim()) as FixtureResult;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("T2A four-phase evaluator orchestration", () => {
  it("binds recovery, IPA, private G2P, cleartext-free adjudication and quality", async () => {
    const fixture = await runFixture();
    expect(fixture.schemaVersion)
      .toBe("ltx-studio-t2a-four-phase-orchestration-fixture.v1");

    expect(fixture.successful.events).toEqual([
      "recovery",
      "ipa",
      "ipa-close",
      "g2p",
      "g2p-close",
      "adjudicator",
      "adjudicator-close",
      "quality",
      "quality-close",
    ]);
    expect(fixture.successful.commands).toEqual(new Array(4).fill("/usr/bin/sudo"));
    expect(fixture.successful.phases).toEqual(["ipa", "g2p", "adjudicator", "quality"]);
    const unitPattern = new RegExp(
      `^${fixture.successful.unitPrefix}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "u",
    );
    expect(fixture.successful.units).toHaveLength(4);
    expect(fixture.successful.units.every((unit) => unitPattern.test(unit))).toBe(true);
    expect(new Set(fixture.successful.units).size).toBe(4);
    expect(fixture.successful.privateIsolation).toEqual({
      g2pRequestContainsTarget: true,
      g2pRequestContainsAudioPath: false,
      adjudicatorRequestContainsTarget: false,
      adjudicatorRequestContainsTranscriptPath: false,
      adjudicationResultContainsTarget: false,
      adjudicationResultContainsAnySnapshotPath: false,
    });
    for (const options of fixture.successful.spawnOptions) {
      expect(options).toEqual({
        cwd: appRoot,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
      });
    }

    expect(fixture.successful.ipa.bindingDestinations)
      .toEqual(fixture.successful.ipa.expectedBindingDestinations);
    expect(fixture.successful.ipa).toMatchObject({
      hasTranscriptFlag: false,
      hasWhisperFlag: false,
      hasTranscriptBinding: false,
      hasDialogueBinding: false,
      hasWhisperBinding: false,
    });
    expect(fixture.successful.quality.bindingDestinations)
      .toEqual(fixture.successful.quality.expectedBindingDestinations);
    expect(fixture.successful.quality).toMatchObject({
      hasIpaRunnerFlag: false,
      hasIpaModelFlag: false,
      hasIpaRunnerBinding: false,
      hasIpaModelBinding: false,
    });
    expect(fixture.successful.g2p.bindingDestinations)
      .toEqual(fixture.successful.g2p.expectedBindingDestinations);
    expect(fixture.successful.g2p).toMatchObject({
      hasAudioBinding: false,
      hasTranscriptBinding: false,
      hasWhisperBinding: false,
    });
    expect(fixture.successful.g2p.requestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.successful.adjudicator.bindingDestinations)
      .toEqual(fixture.successful.adjudicator.expectedBindingDestinations);
    expect(fixture.successful.adjudicator).toMatchObject({
      hasAudioBinding: false,
      hasTranscriptBinding: false,
      hasG2pRequestBinding: false,
      argvContainsTranscript: false,
    });
    expect(fixture.successful.adjudicator.phaseSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.successful.adjudicator.referenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.successful.adjudicator.g2pResultSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.successful.quality.adjudicationSha256).toMatch(/^[0-9a-f]{64}$/u);

    const handoff = fixture.successful.canonicalHandoff;
    expect(handoff.emittedStdoutSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(handoff.emittedStdoutSha256).not.toBe(handoff.canonicalSha256);
    expect(handoff.qualityExpectedSha256).toBe(handoff.canonicalSha256);
    expect(handoff.observationSha256).toBe(handoff.canonicalSha256);
    expect(handoff.observationIsCanonical).toBe(true);
    expect(handoff.observationMode).toBe("0444");
    expect(handoff.qualityAdjudicationSha256).toBe(handoff.adjudicationSha256);
    expect(handoff.adjudicationIsCanonical).toBe(true);
    expect(handoff.adjudicationMode).toBe("0444");

    expect(fixture.successful.result).toMatchObject({
      analysisStatus: "failed",
      eligibilityStatus: "blocked",
      eligibilityBlockers: ["analysis-failed"],
      claimScope: "development",
    });
    expect(fixture.successful.result.evaluatorFingerprint)
      .toBe(fixture.successful.result.expectedBindingFingerprint);
    expect(fixture.successful.result.evaluatorFingerprint)
      .toBe(fixture.successful.result.independentlyCombinedFingerprint);
    expect(fixture.successful.result.evaluatorFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.successful.result.evaluatorFingerprint)
      .not.toBe(fixture.successful.result.qualityEvaluatorFingerprint);
    expect(fixture.successful.result.evaluatorFingerprint)
      .not.toBe(fixture.successful.result.independentIpaEvaluatorFingerprint);
    expect(fixture.successful.result.evaluatorFingerprint)
      .not.toBe(fixture.successful.result.germanG2pEvaluatorFingerprint);
    expect(fixture.successful.result.evaluatorFingerprint)
      .not.toBe(fixture.successful.result.ipaAdjudicatorFingerprint);

    expect(fixture.aborted.events).toEqual(["recovery", "ipa", "ipa-close", "abort"]);
    expect(fixture.aborted.spawnCount).toBe(1);
    expect(fixture.aborted.phases).toEqual(["ipa"]);
    expect(fixture.aborted.errorName).toBe("T2aAudioEvaluatorCancelledError");
    expect(fixture.aborted.errorCode).toBe("T2A_AUDIO_EVALUATOR_CANCELLED");
    expect(fixture.aborted.observationMaterialized).toBe(false);
  }, 70_000);
});
