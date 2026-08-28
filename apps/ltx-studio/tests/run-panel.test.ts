import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { isVideoPreviewUrl } from "../shared/media.js";
import type { PublicStudioOutput } from "../shared/outputPublic.js";
import { isT2aAudioQualityCandidate } from "../src/qualityCandidates.js";
import { RunPanel } from "../src/components/RunPanel.js";
import { executionClassLabel } from "../src/jobExecutionPresentation.js";
import type { StudioJob } from "../src/types.js";
import { validRequest } from "./fixtures.js";

function audioOutput(overrides: Partial<PublicStudioOutput> = {}): PublicStudioOutput {
  return {
    name: "fresh-t2a.wav",
    url: "/api/outputs/fresh-t2a.wav",
    sizeBytes: 1024,
    modifiedAt: "2026-08-26T08:00:00.000Z",
    changedAt: "2026-08-26T08:00:00.000Z",
    revisionToken: `eq1_${"r".repeat(32)}`,
    jobId: "8b174b6e-a9ff-4b6f-95f7-512f18c3f53a",
    jobStatus: "completed",
    request: validRequest("text-to-audio"),
    settingsAvailable: true,
    qualityReview: null,
    analysis: null,
    audioAnalysis: null,
    provenanceSummary: null,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
    ...overrides,
  };
}

function minimalRunPanelProps(
  request: ReturnType<typeof validRequest>,
): ComponentProps<typeof RunPanel> {
  const noop = vi.fn();
  return {
    request,
    requestValid: false,
    health: null,
    jobs: [],
    outputs: [],
    selectedJob: null,
    selectedOutput: null,
    onSelectJob: noop,
    onSelectOutput: noop,
    onRun: noop,
    onCancel: noop,
    cancellingJobIds: new Set<string>(),
    onDeleteJob: async () => undefined,
    deletingJobId: null,
    submitting: false,
    errors: [],
    warnings: [],
    suggestions: [],
    onApplySuggestion: noop,
    command: null,
    previews: {},
    comparisonOutputs: [],
    comparisonNames: [],
    onToggleCompare: noop,
    onCompareExperiment: noop,
    onRerun: noop,
    onFavorite: noop,
    onSaveQualityReview: async () => undefined,
    onStartAnalysis: async () => undefined,
    onCancelAnalysis: async () => undefined,
    onStartT2aAnalysis: async () => undefined,
    onCancelT2aAnalysis: async () => undefined,
    onPrepareLipSyncRetry: noop,
    onDeleteOutput: async () => undefined,
    deletingOutputName: null,
    onLoadSettings: noop,
    onLoadOutputSettings: noop,
    onUseFrameAsReference: async () => undefined,
    onUseBestFrameAsReference: async () => null,
    qualityGuidedSceneReferenceAvailable: false,
    extractingReferenceFrom: null,
    experiments: [],
    onCreateExperiment: async () => undefined as never,
    onFreezeExperiment: async () => undefined,
    onLaunchExperiment: async () => undefined,
    onProjectJobLaunched: noop,
    onLoadProjectRequest: noop,
    estimate: { memoryGiB: 86, outputGiB: 0.1, etaSeconds: null, etaSamples: 0 },
    requiredStartMemoryGiB: 110,
  };
}

describe("source preview media selection", () => {
  it("marks a provisional RAM proxy visibly instead of presenting it as measured", () => {
    const props = minimalRunPanelProps(validRequest("image-audio-to-video"));
    props.estimate = {
      memoryGiB: 82,
      outputGiB: 0.01,
      etaSeconds: null,
      etaSamples: 0,
      memoryBasis:
        "provisional-proxy:ltx-2.5-split-bf16-ia2v-1024x1536-289f-observed-conservative-floor-82gib.v2",
    };

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("<span>RAM-Basis</span>");
    expect(markup).toContain("Provisorisch · Peakmessung ausstehend");
  });

  it("keeps an invalid editor request actionable so the run handler can reveal field errors", () => {
    const markup = renderToStaticMarkup(createElement(
      RunPanel,
      minimalRunPanelProps(validRequest("two-stage")),
    ));

    expect(markup).toMatch(/class="run-button"(?![^>]*disabled)/u);
  });

  it("shows the inclusive thermal resume threshold in the run monitor", () => {
    const request = validRequest("image-audio-to-video");
    const job = {
      id: "8b174b6e-a9ff-4b6f-95f7-512f18c3f53b",
      status: "paused",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: "2026-08-26T08:00:00.000Z",
      startedAt: "2026-08-26T08:00:01.000Z",
      finishedAt: null,
      progress: 60,
      error: null,
      logs: ["Thermalpause"],
      command: "private command",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: 60_000,
      cancelledBy: null,
      dgxJobId: "dgx-thermal-boundary",
      thermalProfile: {
        baselineC: 58.6,
        currentC: 66,
        peakC: 92,
        riseC: 33.4,
        pauseAtC: 90,
        resumeBelowC: 66,
        updatedAt: "2026-08-26T08:01:00.000Z",
      },
      runProvenanceSummary: null,
      executionClass: "dgx",
      executionDecisionSummary: null,
    } satisfies StudioJob;
    const props = minimalRunPanelProps(request);
    props.jobs = [job];
    props.selectedJob = job;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("Fortsetzen bei/unter 66 °C");
  });

  it("shows cancellation as settling until backend cleanup is proven", () => {
    const request = validRequest("two-stage");
    const job = {
      id: "8b174b6e-a9ff-4b6f-95f7-512f18c3f53c",
      status: "cancelled",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: "2026-08-26T08:00:00.000Z",
      startedAt: "2026-08-26T08:00:01.000Z",
      finishedAt: "2026-08-26T08:01:00.000Z",
      progress: 60,
      error: null,
      logs: ["Abbruch angefordert"],
      command: "private command",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: 59_000,
      cancelledBy: "studio",
      cancellationState: "settling",
      dgxJobId: "dgx-cancel-settling",
      thermalProfile: null,
      runProvenanceSummary: null,
      executionClass: "dgx",
      executionDecisionSummary: null,
    } satisfies StudioJob;
    const props = minimalRunPanelProps(request);
    props.jobs = [job];
    props.selectedJob = job;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("Abbruch läuft: Prozess, Container und DGX-Zustand werden noch bestätigt.");
    expect(markup).toContain("Abbruch läuft ·");
    expect(markup).toMatch(/title="Job wird abgebrochen"[^>]*disabled=""/u);
    expect(markup).not.toContain("Manuell über die Studio-Abbruchfunktion beendet.");
  });

  it("renders the DFR qualification reason and disables the direct start", () => {
    const markup = renderToStaticMarkup(createElement(
      RunPanel,
      minimalRunPanelProps(validRequest("dfr")),
    ));

    expect(markup).toContain("DFR Qualification-HOLD");
    expect(markup).toContain("darf weder lokal noch über die DGX-Queue gestartet werden");
    expect(markup).toMatch(/class="run-button"[^>]*disabled=""/u);
  });

  it("labels paired CPU promotion separately from audio retime", () => {
    expect(executionClassLabel({
      executionClass: "cpu-only",
      executionDecisionSummary: {
        cpuReuse: { operationKind: "paired-artifact-promotion" },
      },
    } as StudioJob)).toBe("CPU-only Paar-Promotion");
    expect(executionClassLabel({
      executionClass: "cpu-only",
      executionDecisionSummary: {
        cpuReuse: { operationKind: "ffmpeg-audio-retime" },
      },
    } as StudioJob)).toBe("CPU-only Audio-Retime");
  });

  it("keeps IC-LoRA image assets as images and video assets as video", () => {
    expect(isVideoPreviewUrl("/api/uploads/image/id.png")).toBe(false);
    expect(isVideoPreviewUrl("/api/uploads/video/id.mp4")).toBe(true);
    expect(isVideoPreviewUrl("/api/uploads/video/id.webm?version=1")).toBe(true);
  });

  it("keeps LipDub preview timing reference-bound until the medium was measured", () => {
    const request = validRequest("lipdub");
    const output = audioOutput({
      name: "lipdub-reference.mp4",
      url: "/api/outputs/lipdub-reference.mp4",
      request,
      analysis: null,
    });
    const props = minimalRunPanelProps(request);
    props.outputs = [output];
    props.selectedOutput = output;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("<span>Referenzdauer</span>");
  });

  it("uses measured A2V timing while keeping the explicit frame field visibly inactive", () => {
    const request = validRequest("image-audio-to-video");
    request.numFrames = 217;
    request.audio.maxDuration = 4.72;
    const output = audioOutput({
      name: "measured-a2v.mp4",
      url: "/api/outputs/measured-a2v.mp4",
      request,
      analysis: {
        status: "completed",
        result: {
          technical: { frames: 113, fps: 24, durationSeconds: 113 / 24 },
        },
      } as never,
    });
    const props = minimalRunPanelProps(request);
    props.outputs = [output];
    props.selectedOutput = output;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("113 @ 24 fps (Medium gemessen)");
    expect(markup).toContain("217 ungenutzt · Audio-Maximaldauer steuert");
    expect(markup).toContain("<span>4.7 s</span>");
  });

  it("does not call nullable analysis timing measured and marks an A2V cap as an upper bound", () => {
    const request = validRequest("image-audio-to-video");
    request.numFrames = 113;
    request.audio.maxDuration = 4.72;
    const output = audioOutput({
      name: "nullable-a2v.mp4",
      url: "/api/outputs/nullable-a2v.mp4",
      request,
      analysis: {
        status: "completed",
        result: {
          technical: { frames: null, fps: null, durationSeconds: null },
        },
      } as never,
    });
    const props = minimalRunPanelProps(request);
    props.outputs = [output];
    props.selectedOutput = output;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("113 @ 24 fps (Obergrenze aus Audio-Maximaldauer)");
    expect(markup).not.toContain("Medium gemessen");
    expect(markup).toContain("113 ungenutzt · Audio-Maximaldauer steuert");
    expect(markup).toContain("<span>Bis zu 4.7 s</span>");
  });

  it("offers Audio-QA only for completed T2A WAV outputs", () => {
    expect(isT2aAudioQualityCandidate(audioOutput())).toBe(true);
    expect(isT2aAudioQualityCandidate(audioOutput({ jobStatus: "external", request: null }))).toBe(false);
    expect(isT2aAudioQualityCandidate(audioOutput({ request: validRequest("two-stage") }))).toBe(false);
    expect(isT2aAudioQualityCandidate(audioOutput({ name: "fresh-t2a.mp3" }))).toBe(false);
  });

  it("never shows video Lip-Sync or legacy /10 claims for a WAV", () => {
    const request = validRequest("text-to-audio");
    const editedRequest = validRequest("two-stage");
    editedRequest.width = 768;
    editedRequest.height = 512;
    const output = audioOutput({
      analysis: { status: "completed", result: null } as never,
      qualityReview: {
        scores: { lipSync: 9, identity: 9, mouthNaturalness: 9, skinStability: 9, motion: 9, audio: 9 },
        note: "legacy video score",
        updatedAt: "2026-08-26T08:00:00.000Z",
      },
    });
    const job: StudioJob = {
      id: output.jobId!,
      status: "completed",
      mode: "text-to-audio",
      prompt: request.prompt,
      outputName: output.name,
      outputUrl: output.url,
      createdAt: "2026-08-26T07:55:00.000Z",
      startedAt: "2026-08-26T07:56:00.000Z",
      finishedAt: "2026-08-26T08:00:00.000Z",
      progress: 100,
      error: null,
      logs: [],
      command: "private command",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: 240_000,
      cancelledBy: null,
      dgxJobId: "dgx-job-public",
      thermalProfile: null,
      runProvenanceSummary: null,
      executionClass: "dgx",
      executionDecisionSummary: null,
    };
    const noop = vi.fn();
    const markup = renderToStaticMarkup(createElement(RunPanel, {
      request: editedRequest,
      requestValid: true,
      health: null,
      jobs: [job],
      outputs: [output],
      selectedJob: job,
      selectedOutput: output,
      onSelectJob: noop,
      onSelectOutput: noop,
      onRun: noop,
      onCancel: noop,
      cancellingJobIds: new Set<string>(),
      onDeleteJob: async () => undefined,
      deletingJobId: null,
      submitting: false,
      errors: [],
      warnings: [],
      suggestions: [],
      onApplySuggestion: noop,
      command: null,
      previews: {},
      comparisonOutputs: [],
      comparisonNames: [],
      onToggleCompare: noop,
      onCompareExperiment: noop,
      onRerun: noop,
      onFavorite: noop,
      onSaveQualityReview: async () => undefined,
      onStartAnalysis: async () => undefined,
      onCancelAnalysis: async () => undefined,
      onStartT2aAnalysis: async () => undefined,
      onCancelT2aAnalysis: async () => undefined,
      onPrepareLipSyncRetry: noop,
      onDeleteOutput: async () => undefined,
      deletingOutputName: null,
      onLoadSettings: noop,
      onLoadOutputSettings: noop,
      onUseFrameAsReference: async () => undefined,
      onUseBestFrameAsReference: async () => null,
      qualityGuidedSceneReferenceAvailable: false,
      extractingReferenceFrom: null,
      experiments: [],
      onCreateExperiment: async () => undefined as never,
      onFreezeExperiment: async () => undefined,
      onLaunchExperiment: async () => undefined,
      onProjectJobLaunched: noop,
      onLoadProjectRequest: noop,
      estimate: { memoryGiB: 36, outputGiB: 0.1, etaSeconds: null, etaSamples: 0 },
      requiredStartMemoryGiB: 42,
    }));

    expect(markup).toContain("Audio-Qualitätsanalyse");
    expect(markup).not.toContain("Lip-Sync geprüft");
    expect(markup).not.toContain("Video geprüft");
    expect(markup).not.toContain("9.0/10");
    expect(markup).not.toContain("9.0 / 10");
    expect(markup).toMatch(
      /<div class="preview-stage__meta"><span>WAV · PCM 16 Bit<\/span><span>[^<]+ s<\/span><\/div>/u,
    );
    expect(markup).not.toMatch(
      /<div class="preview-stage__meta"><span>768 x 512<\/span>/u,
    );
  });

  it("labels development audio measurements as unattested without a passed claim", () => {
    const output = audioOutput({
      audioAnalysis: {
        claimScope: "development",
        status: "completed",
        result: {
          analysisStatus: "measured",
          ia2vEligibility: { status: "blocked" },
        },
      } as never,
    });
    const noop = vi.fn();
    const markup = renderToStaticMarkup(createElement(RunPanel, {
      request: validRequest("text-to-audio"),
      requestValid: true,
      health: null,
      jobs: [],
      outputs: [output],
      selectedJob: null,
      selectedOutput: output,
      onSelectJob: noop,
      onSelectOutput: noop,
      onRun: noop,
      onCancel: noop,
      cancellingJobIds: new Set<string>(),
      onDeleteJob: async () => undefined,
      deletingJobId: null,
      submitting: false,
      errors: [],
      warnings: [],
      suggestions: [],
      onApplySuggestion: noop,
      command: null,
      previews: {},
      comparisonOutputs: [],
      comparisonNames: [],
      onToggleCompare: noop,
      onCompareExperiment: noop,
      onRerun: noop,
      onFavorite: noop,
      onSaveQualityReview: async () => undefined,
      onStartAnalysis: async () => undefined,
      onCancelAnalysis: async () => undefined,
      onStartT2aAnalysis: async () => undefined,
      onCancelT2aAnalysis: async () => undefined,
      onPrepareLipSyncRetry: noop,
      onDeleteOutput: async () => undefined,
      deletingOutputName: null,
      onLoadSettings: noop,
      onLoadOutputSettings: noop,
      onUseFrameAsReference: async () => undefined,
      onUseBestFrameAsReference: async () => null,
      qualityGuidedSceneReferenceAvailable: false,
      extractingReferenceFrom: null,
      experiments: [],
      onCreateExperiment: async () => undefined as never,
      onFreezeExperiment: async () => undefined,
      onLaunchExperiment: async () => undefined,
      onProjectJobLaunched: noop,
      onLoadProjectRequest: noop,
      estimate: { memoryGiB: 36, outputGiB: 0.1, etaSeconds: null, etaSamples: 0 },
      requiredStartMemoryGiB: 42,
    }));

    expect(markup).toContain("Entwicklungsmessung · nicht attestiert · keine Freigabe");
    expect(markup).not.toContain("Audio-Vorfilter bestanden");
  });

  it("shows the output-bound dialogue before offering to load its settings", () => {
    const request = validRequest("lipdub");
    request.promptParts.dialogue = "Dieser exakte Wortlaut gehört sichtbar zu dieser Ausgabe.";
    const output = audioOutput({
      name: "dialogue-visible.mp4",
      url: "/api/outputs/dialogue-visible.mp4",
      request,
    });
    const props = minimalRunPanelProps(request);
    props.outputs = [output];
    props.selectedOutput = output;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));
    const dialogueIndex = markup.indexOf(request.promptParts.dialogue);
    const loadActionIndex = markup.indexOf("Alle Einstellungen übernehmen");

    expect(markup).toContain('aria-label="Gesprochener Text der Ausgabe"');
    expect(dialogueIndex).toBeGreaterThan(0);
    expect(loadActionIndex).toBeGreaterThan(dialogueIndex);
  });

  it("calls measurement-only what it is and never presents it as a Lip-Sync check", () => {
    const request = validRequest("lipdub");
    const output = audioOutput({
      name: "measurement-only.mp4",
      url: "/api/outputs/measurement-only.mp4",
      request,
      analysis: {
        status: "completed",
        result: {
          schemaVersion: "ltx-studio-objective-quality.v7",
          technical: { durationSeconds: 10, fps: 24 },
          phonemeViseme: {
            status: "measurement-only",
            productGo: { status: "blocked" },
            measurement: { usableDurationSeconds: 4 },
          },
        },
      } as never,
    });
    const props = minimalRunPanelProps(request);
    props.outputs = [output];
    props.selectedOutput = output;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("Lip-Sync gemessen (Teilfenster) · keine Product-GO-Freigabe");
    expect(markup).not.toContain("Lip-Sync geprüft");
    expect(markup).not.toContain("Lip-Sync teilweise geprüft");
  });

  it("keeps legacy-unattested media playable but disables every mutation action", () => {
    const request = validRequest("lipdub");
    request.promptParts.dialogue = "Historischer Dialog";
    const output = audioOutput({
      name: "legacy-history.mp4",
      url: "/api/outputs/legacy-history.mp4",
      request,
      trustStatus: "legacy-unattested",
    });
    const props = minimalRunPanelProps(request);
    props.outputs = [output];
    props.selectedOutput = output;
    props.qualityGuidedSceneReferenceAvailable = true;

    const markup = renderToStaticMarkup(createElement(RunPanel, props));

    expect(markup).toContain("Historischer Altbestand · ungeprüft · nur lesbar");
    expect(markup).toMatch(/<video[^>]*src="\/api\/outputs\/legacy-history\.mp4"[^>]*controls=""/u);
    expect(markup).toMatch(/class="button output-library__load"[^>]*disabled=""/u);
    expect(markup).toMatch(/title="Ausgabe zum Vergleich hinzufügen"[^>]*disabled=""/u);
    expect(markup).toMatch(/title="Historischer Altbestand ist nur lesbar und kann hier nicht gelöscht werden\."[^>]*disabled=""/u);
    expect(markup).toMatch(/aria-label="Besten Referenzframe automatisch auswählen"[^>]*disabled=""/u);
    expect(markup).toMatch(/class="button output-library__reference"[^>]*disabled=""/u);
    expect(markup).not.toContain("Qualitätsanalyse");
  });
});
