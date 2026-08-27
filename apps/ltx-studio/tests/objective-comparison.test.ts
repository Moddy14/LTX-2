import { describe, expect, it } from "vitest";

import type { AvSyncRawMetrics, IdentityMetrics } from "../shared/objectiveQuality.js";
import type { PublicStudioOutput as StudioOutput } from "../shared/outputPublic.js";
import { notApplicableDialogueEvaluation } from "../shared/dialogueEvaluator.js";
import {
  comparisonCompatibility,
  metricDelta,
  metricTrend,
  objectiveComparisonMetrics,
  protocolOrderedComparisonOutputs,
  settingsDifferences,
} from "../src/objectiveComparison.js";
import { validRequest } from "./fixtures.js";

function output(
  name: string,
  identityOverrides: Partial<IdentityMetrics> = {},
  avOverrides: Partial<AvSyncRawMetrics> = {},
): StudioOutput {
  const jobId = name.startsWith("a")
    ? "11111111-1111-4111-8111-111111111111"
    : "22222222-2222-4222-8222-222222222222";
  const request = validRequest("audio-to-video");
  request.outputName = name;
  const identity = {
    status: "measured",
    modelSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    preprocessingVersion: "yunet5-aligncrop-112-track.v2",
    cosineMedian: 0.82,
    cosineP10: 0.79,
    cosineMinimum: 0.72,
    outputTemporalConsistencyMedian: 0.98,
    ...identityOverrides,
  };
  const avSync = {
    status: "measured",
    estimatedAudioLeadMilliseconds: 125,
    correlationPeak: 0.5,
    nullP95Correlation: 0.3,
    windowLagIqrMilliseconds: 83,
    ...avOverrides,
  };
  return {
    name,
    url: `/api/outputs/${name}`,
    sizeBytes: 1_000,
    modifiedAt: "2026-07-25T00:00:00.000Z",
    changedAt: "2026-07-25T00:00:01.000Z",
    revisionToken: `eq1_revision-${name}`,
    jobId,
    jobStatus: "completed",
    request,
    settingsAvailable: true,
    qualityReview: null,
    analysis: {
      schemaVersion: "ltx-studio-public-output-analysis.v1",
      sourceSchemaVersion: "ltx-studio-output-analysis.v4",
      outputName: name,
      outputRevisionToken: `eq1_revision-${name}`,
      jobId,
      analysisId: name.startsWith("a")
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attempt: 1,
      status: "completed",
      progress: 100,
      createdAt: "2026-07-25T00:00:00.000Z",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:00:01.000Z",
      updatedAt: "2026-07-25T00:00:01.000Z",
      error: null,
      equality: {
        evaluator: "eq1_evaluator",
        expectedDialogue: null,
        identityModel: "eq1_identity-model",
      },
      result: {
        schemaVersion: "ltx-studio-objective-quality.v4",
        analyzerVersion: "ffprobe-yunet5-sface-avmotion-pv.v4",
        status: "measured",
        technical: {
          audioVideoDurationDeltaSeconds: 0.01,
        },
        face: {
          medianFaceAreaRatio: 0.14,
          noseVelocityP95PerSecond: 1.5,
          mouthSpanCoefficientOfVariation: 0.04,
        },
        identity,
        avSync,
      },
    },
    provenanceSummary: {
      schemaVersion: "ltx-studio-public-output-provenance-summary.v1",
      status: "verified",
      capturedAt: "2026-07-25T00:00:00.000Z",
      verifiedAt: "2026-07-25T00:00:01.000Z",
      release: null,
      equality: {
        run: "eq1_run",
        inputs: "eq1_inputs",
        models: "eq1_models",
        code: "eq1_code",
        runtime: "eq1_runtime",
      },
    },
    experiment: null,
    project: null,
    experimentRequestVerified: false,
  } as unknown as StudioOutput;
}

function bindGuidanceExperiment(left: StudioOutput, right: StudioOutput): void {
  right.request!.videoGuidance.modalityScale = 5;
  const common = {
    schemaVersion: "ltx-studio-public-experiment-run.v1" as const,
    experimentId: "33333333-3333-4333-8333-333333333333",
    protocolEqualityToken: "eq1_protocol",
    kind: "ablation" as const,
    variableId: "a2v-guidance",
    changedRequestPaths: ["videoGuidance.modalityScale"],
    baselineRequestEqualityToken: "eq1_baseline-request",
    baselineOutputName: left.name,
  };
  left.experiment = {
    ...common,
    arm: "baseline",
    requestEqualityToken: "eq1_baseline-request",
    baselineJobId: null,
  };
  right.experiment = {
    ...common,
    arm: "candidate",
    requestEqualityToken: "eq1_candidate-request",
    baselineJobId: left.jobId,
  };
  left.experimentRequestVerified = true;
  right.experimentRequestVerified = true;
}

describe("objective A/B comparison", () => {
  it("lists only settings that changed between the two stored requests", () => {
    const left = validRequest("audio-to-video");
    left.images = [{ path: "/inputs/wide.png", name: "wide.png", frameIndex: 0, strength: 1, crf: 33 }];
    const right = structuredClone(left);
    right.images = [{ path: "/inputs/tight.png", name: "tight.png", frameIndex: 0, strength: 1, crf: 0 }];
    right.videoGuidance.modalityScale = 5;

    expect(settingsDifferences(left, right)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "images[0].path", left: "/inputs/wide.png", right: "/inputs/tight.png" }),
      expect.objectContaining({ id: "images[0].crf", left: "33", right: "0" }),
      expect.objectContaining({ id: "videoGuidance.modalityScale", left: "3", right: "5" }),
    ]));
    expect(settingsDifferences(left, right).map((difference) => difference.id)).not.toContain("seed");
  });

  it("marks a dormant A2V frame request as audio-controlled", () => {
    const left = validRequest("audio-to-video");
    const right = structuredClone(left);
    left.numFrames = 9;
    right.numFrames = 217;

    expect(settingsDifferences(left, right)).toContainEqual({
      id: "numFrames",
      label: "Expliziter Framewert (inaktiv · Audio-Maximaldauer steuert)",
      left: "9",
      right: "217",
    });
  });

  it("computes B-minus-A metrics and direction only for calibrated metric intent", () => {
    const left = output("a.mp4");
    const right = output(
      "b.mp4",
      { cosineMedian: 0.86, cosineP10: 0.81 },
      { estimatedAudioLeadMilliseconds: 42, correlationPeak: 0.6 },
    );
    const metrics = objectiveComparisonMetrics(left, right);
    const identity = metrics.find((metric) => metric.id === "identity-median")!;
    const lag = metrics.find((metric) => metric.id === "av-absolute-lag")!;
    const margin = metrics.find((metric) => metric.id === "av-correlation-margin")!;

    expect(metricDelta(identity)).toBeCloseTo(0.04);
    expect(metricTrend(identity)).toBe("improved");
    expect(metricDelta(lag)).toBe(-83);
    expect(metricTrend(lag)).toBe("improved");
    expect(metricDelta(margin)).toBeCloseTo(0.1);
    expect(metricTrend(margin)).toBe("improved");
  });

  it("does not label raw lag changes as improvements when either AV result is insufficient", () => {
    const left = output("a.mp4", {}, { status: "insufficient" });
    const right = output("b.mp4", {}, {
      status: "insufficient",
      estimatedAudioLeadMilliseconds: 42,
    });
    const lag = objectiveComparisonMetrics(left, right)
      .find((metric) => metric.id === "av-absolute-lag")!;

    expect(metricDelta(lag)).toBe(-83);
    expect(metricTrend(lag)).toBe("neutral");
  });

  it("compares uncalibrated mouth-skin stability only as neutral raw values", () => {
    const left = output("a.mp4");
    const right = output("b.mp4");
    for (const candidate of [left, right]) {
      const analysis = candidate.analysis as NonNullable<StudioOutput["analysis"]> & {
        result: Record<string, unknown> & { face: Record<string, unknown> };
      };
      analysis.sourceSchemaVersion = "ltx-studio-output-analysis.v7";
      analysis.result = {
        ...analysis.result,
        schemaVersion: "ltx-studio-objective-quality.v7",
        analyzerVersion: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7",
        face: {
          ...analysis.result.face,
          mouthSkinPairCount: 23,
          mouthSkinPairCoverage: 1,
          mouthSkinWarpResidualMedian: 0.02,
          mouthSkinWarpResidualP95: candidate.name.startsWith("a") ? 0.08 : 0.03,
          mouthSkinLuminanceDeltaP95: candidate.name.startsWith("a") ? 0.04 : 0.02,
          mouthSkinFlowDeformationP95: candidate.name.startsWith("a") ? 0.09 : 0.04,
          mouthSkinValidPixelCoverageP10: 0.9,
        },
      } as unknown as typeof analysis.result;
    }
    const warp = objectiveComparisonMetrics(left, right)
      .find((metric) => metric.id === "mouth-skin-warp-residual")!;
    const luminance = objectiveComparisonMetrics(left, right)
      .find((metric) => metric.id === "mouth-skin-luminance-delta")!;
    const deformation = objectiveComparisonMetrics(left, right)
      .find((metric) => metric.id === "mouth-skin-flow-deformation")!;

    expect(metricDelta(warp)).toBeCloseTo(-0.05);
    expect(metricTrend(warp)).toBe("neutral");
    expect(metricDelta(luminance)).toBeCloseTo(-0.02);
    expect(metricTrend(luminance)).toBe("neutral");
    expect(metricDelta(deformation)).toBeCloseTo(-0.05);
    expect(metricTrend(deformation)).toBe("neutral");

    const leftFace = (left.analysis!.result! as {
      face: { mouthSkinPairCount: number; mouthSkinPairCoverage: number };
    }).face;
    leftFace.mouthSkinPairCount = 7;
    leftFace.mouthSkinPairCoverage = 7 / 23;
    const insufficientMetrics = objectiveComparisonMetrics(left, right);
    expect(insufficientMetrics.find((metric) => metric.id === "mouth-skin-warp-residual")?.left).toBeNull();
    expect(insufficientMetrics.find((metric) => metric.id === "mouth-skin-pair-coverage")?.left)
      .toBeCloseTo((7 / 23) * 100);
    expect(insufficientMetrics.find((metric) => metric.id === "mouth-skin-valid-pixels")?.left).toBe(90);
  });

  it("does not color uncalibrated dialogue-motion proxies as improvements", () => {
    const left = output("a.mp4");
    const right = output("b.mp4");
    for (const [candidate, motion, pause] of [
      [left, 0.5, 0.5],
      [right, 0.9, 0.1],
    ] as const) {
      const analysis = candidate.analysis as NonNullable<StudioOutput["analysis"]> & {
        result: Record<string, unknown>;
      };
      analysis.sourceSchemaVersion = "ltx-studio-output-analysis.v6";
      analysis.result = {
        ...analysis.result,
        schemaVersion: "ltx-studio-objective-quality.v6",
        dialogue: {
          ...notApplicableDialogueEvaluation(),
          status: "measured",
          blockerCode: "none",
          error: null,
          wordsWithMouthMotionRatio: motion,
          pauseMotionRatio: pause,
          estimatedWordActivityLeadMilliseconds: 20,
          wordMotionProxyStatus: "insufficient",
        },
      } as unknown as typeof analysis.result;
    }

    for (const id of [
      "dialogue-word-motion",
      "dialogue-pause-motion",
      "dialogue-word-activity-lag",
    ]) {
      const metric = objectiveComparisonMetrics(left, right)
        .find((candidate) => candidate.id === id)!;
      expect(metricTrend(metric)).toBe("neutral");
    }
  });

  it("shows full-window phoneme/viseme diagnostics as neutral raw values while Product-GO is blocked", () => {
    const left = output("a.mp4");
    const right = output("b.mp4");
    for (const [candidate, lag, bilabial, opening, rounding, speech, pause] of [
      [left, 42, 0.15625, 0.2787, 0.1674, 0.3564, 0.2368],
      [right, 0, 0.2388, 0.3189, 0.1122, 0.3582, 0.2308],
    ] as const) {
      const analysis = candidate.analysis as NonNullable<StudioOutput["analysis"]> & {
        result: Record<string, unknown>;
      };
      analysis.sourceSchemaVersion = "ltx-studio-output-analysis.v7";
      analysis.result = {
        ...analysis.result,
        schemaVersion: "ltx-studio-objective-quality.v7",
        phonemeViseme: {
          status: "insufficient",
          blockerCode: "measurement-insufficient",
          error: "Product-GO blocked",
          manifestReleaseId: "measurement-test",
          manifestSha256: "1".repeat(64),
          preprocessingVersion: "ctc-espeak-mediapipe-de-pts.v1",
          visemeMapVersion: "viseme15-en-de.v1",
          gateVersion: null,
          productGo: { status: "blocked", reason: "Uncalibrated holdout" },
          offset: {
            status: "measured",
            gatePassed: false,
            estimatedOffsetMilliseconds: lag,
            confidence: 0.04,
          },
          content: {
            status: "insufficient",
            gatePassed: false,
            frameMacroF1: null,
            transitionF1: null,
          },
          measurement: {
            method: "ctc-espeak-mediapipe-de.v1",
            runnerFingerprint: "2".repeat(64),
            expectedDialogueSha256: "3".repeat(64),
            globalAvLagMilliseconds: lag,
            lagConfidence: 0.04,
            bilabialClosureF1: bilabial,
            openingCorrelation: opening,
            roundingCorrelation: rounding,
            speechMotionRecall: speech,
            pauseLeakRatio: pause,
            phoneCoverage: 1,
            unknownPhones: [],
            faceTrackCoverage: 1,
            mouthTrackCoverage: 1,
            multiFaceFrameRatio: 0,
            medianBlurVariance: 20,
            yawP95Degrees: 5,
            pitchP95Degrees: 5,
            usableDurationSeconds: 10.04,
            sampledFrames: 241,
          },
        },
      } as unknown as typeof analysis.result;
    }

    const metrics = objectiveComparisonMetrics(left, right);
    const values = new Map(metrics.map((metric) => [metric.id, metric]));
    expect(values.get("phoneme-viseme-absolute-lag")).toMatchObject({ left: 42, right: 0 });
    expect(values.get("phoneme-viseme-bilabial-closure")).toMatchObject({
      left: 0.15625,
      right: 0.2388,
    });
    expect(values.get("phoneme-viseme-opening-correlation")).toMatchObject({
      left: 0.2787,
      right: 0.3189,
    });
    expect(values.get("phoneme-viseme-rounding-correlation")).toMatchObject({
      left: 0.1674,
      right: 0.1122,
    });
    expect(values.get("phoneme-viseme-speech-motion-recall")).toMatchObject({
      left: 0.3564,
      right: 0.3582,
    });
    expect(values.get("phoneme-viseme-pause-leak")).toMatchObject({
      left: 0.2368,
      right: 0.2308,
    });
    for (const id of [
      "phoneme-viseme-absolute-lag",
      "phoneme-viseme-bilabial-closure",
      "phoneme-viseme-opening-correlation",
      "phoneme-viseme-rounding-correlation",
      "phoneme-viseme-speech-motion-recall",
      "phoneme-viseme-pause-leak",
    ]) {
      expect(metricTrend(values.get(id)!)).toBe("neutral");
    }
  });

  it("detects prompt differences beyond the displayed preview and gates incompatible analyses", () => {
    const leftRequest = validRequest("audio-to-video");
    leftRequest.prompt = `${"same ".repeat(30)}left`;
    const rightRequest = structuredClone(leftRequest);
    rightRequest.prompt = `${"same ".repeat(30)}right`;
    expect(settingsDifferences(leftRequest, rightRequest)).toContainEqual(expect.objectContaining({ id: "prompt" }));

    const left = output("a.mp4");
    const right = output("b.mp4");
    bindGuidanceExperiment(left, right);
    expect(comparisonCompatibility(left, right)).toEqual({ comparable: true, reasons: [] });

    right.request!.images = [{ path: "/inputs/other.png", name: "other.png", frameIndex: 0, strength: 1, crf: 33 }];
    const compatibility = comparisonCompatibility(left, right);
    expect(compatibility.comparable).toBe(false);
    expect(compatibility.reasons).toContain("Identitätsreferenzen unterscheiden sich.");
    expect(compatibility.reasons).toContain(
      "Der tatsächliche Request-Diff entspricht nicht der eingefrorenen Einzelfaktoränderung.",
    );
  });

  it("does not mistake dormant A2V frame fields for an effective duration difference", () => {
    const left = output("a.mp4");
    const right = output("b.mp4");
    bindGuidanceExperiment(left, right);
    left.request!.numFrames = 9;
    right.request!.numFrames = 217;

    const compatibility = comparisonCompatibility(left, right);
    expect(compatibility.reasons).not.toContain("Dauer oder Bildrate unterscheiden sich.");
    expect(compatibility.reasons).toContain(
      "Der tatsächliche Request-Diff entspricht nicht der eingefrorenen Einzelfaktoränderung.",
    );
  });

  it("prefers measured output timing over the requested A2V timeline", () => {
    const left = output("a.mp4");
    const right = output("b.mp4");
    bindGuidanceExperiment(left, right);
    Object.assign(left.analysis!.result!.technical, { frames: 113, fps: 24 });
    Object.assign(right.analysis!.result!.technical, { frames: 121, fps: 24 });

    expect(comparisonCompatibility(left, right).reasons).toContain(
      "Dauer oder Bildrate unterscheiden sich.",
    );

    Object.assign(right.analysis!.result!.technical, { frames: 113, fps: 24 });
    expect(comparisonCompatibility(left, right)).toEqual({ comparable: true, reasons: [] });
  });

  it("orders a bound experiment as baseline then candidate regardless of click order", () => {
    const baseline = output("a.mp4");
    const candidate = output("b.mp4");
    bindGuidanceExperiment(baseline, candidate);

    expect(protocolOrderedComparisonOutputs([candidate, baseline]).map((item) => item.name))
      .toEqual(["a.mp4", "b.mp4"]);
  });

  it("keeps insufficient completed analyses in neutral raw-value mode", () => {
    const baseline = output("a.mp4");
    const candidate = output("b.mp4");
    bindGuidanceExperiment(baseline, candidate);
    candidate.analysis!.result!.status = "insufficient";

    const compatibility = comparisonCompatibility(baseline, candidate);
    expect(compatibility.comparable).toBe(false);
    expect(compatibility.reasons).toContain(
      "Beide Gesamtanalysen müssen alle Product-Gates erfüllen; unzureichende Analysen bleiben neutrale Rohwerte.",
    );
    const identity = objectiveComparisonMetrics(baseline, candidate)
      .find((metric) => metric.id === "identity-median")!;
    expect(metricTrend(identity, compatibility.comparable)).toBe("neutral");
  });

  it("keeps technically similar but unregistered outputs in raw-value mode", () => {
    const compatibility = comparisonCompatibility(output("a.mp4"), output("b.mp4"));

    expect(compatibility.comparable).toBe(false);
    expect(compatibility.reasons).toContain(
      "Beide Ausgaben müssen an denselben eingefrorenen Experimentplan gebunden sein.",
    );
  });

  it("rejects an output whose stored request no longer matches its frozen hash", () => {
    const left = output("a.mp4");
    const right = output("b.mp4");
    bindGuidanceExperiment(left, right);
    right.experimentRequestVerified = false;

    const compatibility = comparisonCompatibility(left, right);
    expect(compatibility.comparable).toBe(false);
    expect(compatibility.reasons).toContain(
      "Die gespeicherten Requests stimmen nicht mit ihren eingefrorenen Request-Hashes überein.",
    );
  });

  it("requires completed analysis records on both outputs", () => {
    const left = output("a.mp4");
    const right = { ...output("b.mp4"), analysis: null };

    expect(objectiveComparisonMetrics(left, right)).toEqual([]);
  });
});
