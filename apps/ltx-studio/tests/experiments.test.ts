import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  allowedExperimentPaths,
  applyExperimentCandidate,
  experimentCandidateSchema,
  experimentCreateInputSchema,
  generationRequestDiffPaths,
  validateControlledExperimentDifference,
} from "../shared/experiments.js";
import {
  ExperimentConflictError,
  ExperimentStore,
  outputVerifiesExperimentBaseline,
  requestSettingsSha256,
  sha256Json,
} from "../server/experimentStore.js";
import { JobManager } from "../server/jobs.js";
import type { StudioOutput } from "../shared/outputs.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function experimentRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-experiments-"));
  roots.push(root);
  return root;
}

function baselineRequest() {
  const request = validRequest("audio-to-video");
  request.outputName = "native-a2v-guidance.mp4";
  request.images = [{
    path: "/inputs/face.png",
    name: "face.png",
    frameIndex: 0,
    strength: 1,
    crf: 33,
  }];
  request.videoGuidance.modalityScale = 5;
  return request;
}

describe("controlled experiment contract", () => {
  it("changes only the positive description while preserving dialogue and all other controls", () => {
    const baseline = validLtx25SplitRequest("image-audio-to-video");
    baseline.prompt = "Baseline portrait prompt";
    baseline.promptParts.dialogue = "Der exakt gebundene Dialog bleibt unverändert.";
    const definition = {
      variable: "positive-prompt" as const,
      value: "Locked camera, stable face, restrained speech-sized mouth movement.",
    };

    const candidate = applyExperimentCandidate(baseline, definition);

    expect(candidate.prompt).toBe(definition.value);
    expect(candidate.promptParts.dialogue).toBe(baseline.promptParts.dialogue);
    expect(validateControlledExperimentDifference(baseline, candidate, definition))
      .toEqual(["prompt"]);
    expect(allowedExperimentPaths(definition)).toEqual(["prompt"]);
    expect({ ...candidate, prompt: baseline.prompt }).toEqual(baseline);
  });

  it("validates positive-description candidates with the same length and NUL safety contract", () => {
    expect(experimentCandidateSchema.parse({
      variable: "positive-prompt",
      value: "  Alternative Beschreibung  ",
    })).toEqual({
      variable: "positive-prompt",
      value: "Alternative Beschreibung",
    });
    expect(experimentCandidateSchema.safeParse({
      variable: "positive-prompt",
      value: "Ungültig\0versteckt",
    }).success).toBe(false);
    expect(experimentCandidateSchema.safeParse({
      variable: "positive-prompt",
      value: "x".repeat(16_001),
    }).success).toBe(false);
  });

  it("freezes and reopens a prompt-only protocol with immutable request hashes", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const baseline = validLtx25SplitRequest("image-audio-to-video");
    baseline.prompt = "Baseline portrait prompt";
    baseline.outputName = "prompt-baseline.mp4";
    const draft = store.create({
      title: "Positive Beschreibung A gegen B",
      baselineRequest: baseline,
      candidate: {
        variable: "positive-prompt",
        value: "Locked portrait framing with restrained audio-driven articulation.",
      },
    }, "2026-08-28T02:00:00.000Z");

    expect(draft.changedRequestPaths).toEqual(["prompt"]);
    expect(generationRequestDiffPaths(draft.arms[0].request, draft.arms[1].request))
      .toEqual(["outputName", "prompt"]);

    const frozen = store.freeze(draft.id, "2026-08-28T02:01:00.000Z");
    expect(frozen.protocolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new ExperimentStore(root).verifyFrozenIntegrity(draft.id).protocolSha256)
      .toBe(frozen.protocolSha256);
  });

  it("rejects prompt treatments outside split LTX-2.5 IA2V and any adopted baseline", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const legacyIa2v = validRequest("image-audio-to-video");
    const candidate = {
      variable: "positive-prompt" as const,
      value: "A different visible direction.",
    };

    expect(() => store.create({
      title: "Nicht belegter Prompt-Pfad",
      baselineRequest: legacyIa2v,
      candidate,
    })).toThrow("nur für den offiziellen LTX-2.5-Split-IA2V-Pfad");

    const official = validLtx25SplitRequest("image-audio-to-video");
    expect(experimentCreateInputSchema.safeParse({
      title: "Keine Alt-Baseline",
      baselineRequest: official,
      baselineOutputName: official.outputName,
      candidate,
    }).success).toBe(false);

    expect(() => store.create({
      title: "Keine Alt-Baseline mit Evidenz",
      baselineRequest: official,
      baselineOutputName: official.outputName,
      candidate,
    }, "2026-08-28T02:10:00.000Z", {
      outputName: official.outputName,
      jobId: "11111111-1111-4111-8111-111111111111",
      sizeBytes: 1_024,
      changedAt: "2026-08-28T02:09:00.000Z",
      fileId: "1",
      provenanceFingerprint: "a".repeat(64),
    })).toThrow("frischer Baseline-Arm");
  });

  it("applies exactly the registered A2V variable and rejects hidden changes", () => {
    const baseline = baselineRequest();
    const candidate = applyExperimentCandidate(baseline, {
      variable: "a2v-guidance",
      value: 3,
    });

    expect(validateControlledExperimentDifference(
      baseline,
      candidate,
      { variable: "a2v-guidance", value: 3 },
    )).toEqual(["videoGuidance.modalityScale"]);

    candidate.seed += 1;
    expect(() => validateControlledExperimentDifference(
      baseline,
      candidate,
      { variable: "a2v-guidance", value: 3 },
    )).toThrow("Nicht freigegebene Request-Änderung: seed");
  });

  it("rejects a new fake A2V-guidance treatment on the official IA2V SimpleDenoiser path", async () => {
    const officialIa2v = validRequest("image-audio-to-video");
    const store = new ExperimentStore(await experimentRoot());

    expect(() => store.create({
      title: "Wirkungsloser historischer IA2V-Regler",
      baselineRequest: officialIa2v,
      candidate: { variable: "a2v-guidance", value: 5 },
    })).toThrow("guidance-freien SimpleDenoiser-Vertrag");

    // Pure reconstruction remains backward-compatible so an already frozen,
    // hash-bound historical record stays readable during startup reconciliation.
    expect(applyExperimentCandidate(officialIa2v, {
      variable: "a2v-guidance",
      value: 5,
    }).videoGuidance.modalityScale).toBe(5);
  });

  it("keeps a hash-valid historical IA2V-guidance record readable but blocks both direct launch bindings", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Historischer wirkungsloser IA2V-Regler",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id, "2026-08-28T00:00:01.000Z");
    const path = join(root, `${frozen.id}.json`);
    const historical = JSON.parse(await readFile(path, "utf8")) as typeof frozen;
    for (const selected of historical.arms) {
      selected.request.mode = "image-audio-to-video";
      selected.requestSha256 = sha256Json(selected.request);
      selected.settingsSha256 = requestSettingsSha256(selected.request);
    }
    historical.arms[0].jobId = "11111111-1111-4111-8111-111111111111";
    historical.arms[0].attemptJobIds = [historical.arms[0].jobId];
    historical.protocolSha256 = sha256Json({
      schemaVersion: historical.schemaVersion,
      id: historical.id,
      title: historical.title,
      claimScope: historical.claimScope,
      kind: historical.kind,
      candidate: historical.candidate,
      changedRequestPaths: historical.changedRequestPaths,
      createdAt: historical.createdAt,
      arms: historical.arms.map((selected) => ({
        arm: selected.arm,
        request: selected.request,
        requestSha256: selected.requestSha256,
        settingsSha256: selected.settingsSha256,
      })),
    });
    await writeFile(path, JSON.stringify(historical));

    const reopened = new ExperimentStore(root);
    expect(reopened.verifyFrozenIntegrity(frozen.id).protocolSha256)
      .toBe(historical.protocolSha256);
    expect(() => reopened.bindingFor(frozen.id, "baseline"))
      .toThrow("darf aber nicht gestartet werden");
    expect(() => reopened.bindingFor(frozen.id, "candidate"))
      .toThrow("darf aber nicht gestartet werden");
  });

  it("registers LipForcing as the only changed treatment on an identical speech baseline", () => {
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing.decoder = "wan-vae";
    const candidate = applyExperimentCandidate(baseline, {
      variable: "lipforcing-enabled",
    });

    expect(candidate.postprocess.lipForcing).toEqual({
      enabled: true,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 0,
      programAudioDelayMs: 0,
    });
    expect(validateControlledExperimentDifference(
      baseline,
      candidate,
      { variable: "lipforcing-enabled" },
    )).toEqual(["postprocess.lipForcing.enabled"]);

    baseline.postprocess.latentSync.enabled = true;
    expect(() => applyExperimentCandidate(baseline, {
      variable: "lipforcing-enabled",
    })).toThrow("Baseline ohne aktiven Lippenrefiner");
  });

  it("freezes only the explicitly alternate LipForcing decoder enum", async () => {
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing = {
      enabled: true,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 125,
      programAudioDelayMs: 175,
    };
    const candidateDefinition = experimentCandidateSchema.parse({
      variable: "lipforcing-decoder",
      value: "streaming-taehv",
    });
    const candidate = applyExperimentCandidate(baseline, candidateDefinition);

    expect(allowedExperimentPaths(candidateDefinition)).toEqual([
      "postprocess.lipForcing.decoder",
    ]);
    expect(candidate.postprocess.lipForcing).toEqual({
      ...baseline.postprocess.lipForcing,
      decoder: "streaming-taehv",
    });
    expect(validateControlledExperimentDifference(
      baseline,
      candidate,
      candidateDefinition,
    )).toEqual(["postprocess.lipForcing.decoder"]);
    expect(experimentCandidateSchema.safeParse({
      variable: "lipforcing-decoder",
      value: "numeric-decoder-hack",
    }).success).toBe(false);
    expect(() => applyExperimentCandidate(baseline, {
      variable: "lipforcing-decoder",
      value: "wan-vae",
    })).toThrow("exakt der alternative Decoder");

    const inactive = structuredClone(baseline);
    inactive.postprocess.lipForcing.enabled = false;
    expect(() => applyExperimentCandidate(inactive, candidateDefinition))
      .toThrow("aktivem LipForcing");

    const reverseBaseline = structuredClone(baseline);
    reverseBaseline.postprocess.lipForcing.decoder = "streaming-taehv";
    expect(applyExperimentCandidate(reverseBaseline, {
      variable: "lipforcing-decoder",
      value: "wan-vae",
    }).postprocess.lipForcing.decoder).toBe("wan-vae");

    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "LipForcing-Decodervergleich mit offenem Ergebnis",
      baselineRequest: baseline,
      candidate: candidateDefinition,
    }).id);
    expect(frozen.changedRequestPaths).toEqual(["postprocess.lipForcing.decoder"]);
    expect(generationRequestDiffPaths(
      frozen.arms[0].request,
      frozen.arms[1].request,
    )).toEqual(["outputName", "postprocess.lipForcing.decoder"]);
    const baselineBinding = store.bindingFor(frozen.id, "baseline");
    expect(baselineBinding).toMatchObject({
      variableId: "lipforcing-decoder",
      changedRequestPaths: ["postprocess.lipForcing.decoder"],
      requestSha256: frozen.arms[0].requestSha256,
    });
    const baselineJobId = "11111111-1111-4111-8111-111111111111";
    store.attachJob(frozen.id, "baseline", baselineJobId);
    expect(store.bindingFor(frozen.id, "candidate")).toMatchObject({
      variableId: "lipforcing-decoder",
      changedRequestPaths: ["postprocess.lipForcing.decoder"],
      baselineJobId,
      baselineRequestSha256: frozen.arms[0].requestSha256,
      requestSha256: frozen.arms[1].requestSha256,
    });
  });

  it("isolates mux-copy as the only LipForcing raw-output experiment variable", async () => {
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing.enabled = true;
    baseline.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-crf18-v1";
    const candidateDefinition = experimentCandidateSchema.parse({
      variable: "lipforcing-raw-output-profile",
    });
    const candidate = applyExperimentCandidate(baseline, candidateDefinition);

    expect(allowedExperimentPaths(candidateDefinition)).toEqual([
      "postprocess.lipForcing.rawOutputProfile",
    ]);
    expect(candidate.postprocess.lipForcing.rawOutputProfile)
      .toBe("h264-crf13-mux-copy-v1");
    expect(validateControlledExperimentDifference(
      baseline,
      candidate,
      candidateDefinition,
    )).toEqual(["postprocess.lipForcing.rawOutputProfile"]);
    expect(experimentCandidateSchema.safeParse({
      variable: "lipforcing-raw-output-profile",
      value: "h264-crf13-mux-copy-v1",
    }).success).toBe(false);

    const inactive = structuredClone(baseline);
    inactive.postprocess.lipForcing.enabled = false;
    expect(() => applyExperimentCandidate(inactive, candidateDefinition))
      .toThrow("aktives LipForcing");
    const alreadyExperimental = structuredClone(baseline);
    alreadyExperimental.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    expect(() => applyExperimentCandidate(alreadyExperimental, candidateDefinition))
      .toThrow("registrierte CRF18-Baseline-Profil");

    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "LipForcing CRF-18-Mux gegen Stream-Copy",
      baselineRequest: baseline,
      candidate: candidateDefinition,
    }).id);
    expect(frozen.claimScope).toBe("development");
    expect(frozen.changedRequestPaths).toEqual(["postprocess.lipForcing.rawOutputProfile"]);
    expect(generationRequestDiffPaths(
      frozen.arms[0].request,
      frozen.arms[1].request,
    )).toEqual(["outputName", "postprocess.lipForcing.rawOutputProfile"]);
  });

  it("rejects raw-output baseline adoption without touching a legacy v1 sidecar", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const baseline = baselineRequest();
    baseline.outputName = "legacy-v1-baseline.mp4";
    baseline.postprocess.lipForcing.enabled = true;
    const legacySidecar = join(root, "legacy-v1-baseline.mp4.settings.v1.json");
    const legacyBytes = Buffer.from('{"schemaVersion":"ltx-studio-output-settings.v1","frozen":true}\n');
    await writeFile(legacySidecar, legacyBytes);
    const beforeMtimeMs = (await stat(legacySidecar)).mtimeMs;
    const input = {
      title: "Keine historische Rohvideo-Baseline",
      baselineRequest: baseline,
      baselineOutputName: baseline.outputName,
      candidate: { variable: "lipforcing-raw-output-profile" as const },
    };
    const evidence = {
      outputName: baseline.outputName,
      jobId: "11111111-1111-4111-8111-111111111111",
      sizeBytes: 1234,
      changedAt: "2026-08-25T09:59:00.000Z",
      fileId: "42",
      provenanceFingerprint: "a".repeat(64),
    };

    expect(experimentCreateInputSchema.safeParse(input).success).toBe(false);
    expect(() => store.create(input, "2026-08-25T10:00:00.000Z", evidence))
      .toThrow("frischer Baseline-Arm");
    expect(await readFile(legacySidecar)).toEqual(legacyBytes);
    expect((await stat(legacySidecar)).mtimeMs).toBe(beforeMtimeMs);
    expect(store.list()).toEqual([]);
  });

  it("rejects a current-schema raw draft whose persisted baseline was retroactively adopted", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing.enabled = true;
    const draft = store.create({
      title: "Manipulierter Raw-Draft",
      baselineRequest: baseline,
      candidate: { variable: "lipforcing-raw-output-profile" },
    });
    const path = join(root, `${draft.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    const adoptedJobId = "11111111-1111-4111-8111-111111111111";
    persisted.baselineEvidence = {
      outputName: persisted.arms[0].request.outputName,
      jobId: adoptedJobId,
      sizeBytes: 1234,
      changedAt: "2026-08-25T09:59:00.000Z",
      fileId: "42",
      provenanceFingerprint: "a".repeat(64),
    };
    persisted.arms[0].jobId = adoptedJobId;
    persisted.arms[0].attemptJobIds = [adoptedJobId];
    await writeFile(path, JSON.stringify(persisted));
    const before = await readFile(path);

    expect(() => store.freeze(draft.id)).toThrow("ungültig");
    expect(await readFile(path)).toEqual(before);
  });

  it("rejects current-schema frozen raw adoption during terminal reconciliation", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing.enabled = true;
    const frozen = store.freeze(store.create({
      title: "Manipulierter eingefrorener Raw-Vertrag",
      baselineRequest: baseline,
      candidate: { variable: "lipforcing-raw-output-profile" },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const path = join(root, `${frozen.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    const adoptedJobId = "11111111-1111-4111-8111-111111111111";
    persisted.baselineEvidence = {
      outputName: persisted.arms[0].request.outputName,
      jobId: adoptedJobId,
      sizeBytes: 1234,
      changedAt: "2026-08-25T09:59:00.000Z",
      fileId: "42",
      provenanceFingerprint: "a".repeat(64),
    };
    persisted.arms[0].jobId = adoptedJobId;
    persisted.arms[0].attemptJobIds = [adoptedJobId];
    await writeFile(path, JSON.stringify(persisted));
    const before = await readFile(path);

    expect(() => store.reconcileJobs([{
      id: adoptedJobId,
      status: "completed",
      startedAt: "2026-08-25T10:00:00.000Z",
      dgxJobId: "dgx-job-current-schema-adoption",
      experiment: binding,
    }])).toThrow("ungültig");
    expect(await readFile(path)).toEqual(before);
  });

  it("validates all timing variables against the integer pipeline limits", () => {
    for (const variable of [
      "lipforcing-mouth-delay-ms",
      "lipforcing-program-audio-delay-ms",
    ] as const) {
      expect(experimentCandidateSchema.parse({ variable, value: -500 })).toEqual({
        variable,
        value: -500,
      });
      expect(experimentCandidateSchema.parse({ variable, value: 500 })).toEqual({
        variable,
        value: 500,
      });
      expect(experimentCandidateSchema.safeParse({ variable, value: -501 }).success).toBe(false);
      expect(experimentCandidateSchema.safeParse({ variable, value: 501 }).success).toBe(false);
      expect(experimentCandidateSchema.safeParse({ variable, value: 0.5 }).success).toBe(false);
    }
    expect(experimentCandidateSchema.parse({
      variable: "program-audio-delay-ms",
      value: 1,
    })).toEqual({ variable: "program-audio-delay-ms", value: 1 });
    expect(experimentCandidateSchema.parse({
      variable: "program-audio-delay-ms",
      value: 500,
    })).toEqual({ variable: "program-audio-delay-ms", value: 500 });
    expect(experimentCandidateSchema.safeParse({
      variable: "program-audio-delay-ms",
      value: 0,
    }).success).toBe(false);
    expect(experimentCandidateSchema.safeParse({
      variable: "program-audio-delay-ms",
      value: -1,
    }).success).toBe(false);
    expect(experimentCandidateSchema.safeParse({
      variable: "program-audio-delay-ms",
      value: 501,
    }).success).toBe(false);
    expect(experimentCandidateSchema.safeParse({
      variable: "program-audio-delay-ms",
      value: 83.5,
    }).success).toBe(false);
  });

  it("isolates native split-2.5 IA2V output timing from conditioning and visuals", () => {
    const baseline = validLtx25SplitRequest("image-audio-to-video");
    baseline.audio.outputDelayMs = 0;
    const candidate = {
      variable: "program-audio-delay-ms" as const,
      value: 83,
    };
    const adjusted = applyExperimentCandidate(baseline, candidate);

    expect(allowedExperimentPaths(candidate)).toEqual(["audio.outputDelayMs"]);
    expect(adjusted.audio.outputDelayMs).toBe(83);
    expect(adjusted.audio.startTime).toBe(baseline.audio.startTime);
    expect(adjusted.audio.path).toBe(baseline.audio.path);
    expect(adjusted.postprocess).toEqual(baseline.postprocess);
    expect(validateControlledExperimentDifference(baseline, adjusted, candidate))
      .toEqual(["audio.outputDelayMs"]);

    const monolith = validRequest("image-audio-to-video");
    expect(() => applyExperimentCandidate(monolith, candidate))
      .toThrow("sprachführenden Videoarm");
  });

  it("isolates LipForcing model control from the audible program-audio offset", () => {
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing = {
      enabled: true,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 125,
      programAudioDelayMs: 175,
    };
    const mouthCandidate = {
      variable: "lipforcing-mouth-delay-ms" as const,
      value: 150,
    };
    const adjustedMouth = applyExperimentCandidate(baseline, mouthCandidate);

    expect(allowedExperimentPaths(mouthCandidate)).toEqual([
      "postprocess.lipForcing.mouthDelayMs",
    ]);
    expect(adjustedMouth.postprocess.lipForcing).toEqual({
      enabled: true,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 150,
      programAudioDelayMs: 175,
    });
    expect(baseline.postprocess.lipForcing.mouthDelayMs).toBe(125);
    expect(validateControlledExperimentDifference(
      baseline,
      adjustedMouth,
      mouthCandidate,
    )).toEqual(["postprocess.lipForcing.mouthDelayMs"]);

    adjustedMouth.postprocess.lipForcing.programAudioDelayMs = 125;
    expect(() => validateControlledExperimentDifference(
      baseline,
      adjustedMouth,
      mouthCandidate,
    )).toThrow("postprocess.lipForcing.programAudioDelayMs");
  });

  it("isolates the audible LipForcing offset and requires an active LipForcing baseline", () => {
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing = {
      enabled: true,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 125,
      programAudioDelayMs: 175,
    };
    const audioCandidate = {
      variable: "lipforcing-program-audio-delay-ms" as const,
      value: 125,
    };
    const adjustedAudio = applyExperimentCandidate(baseline, audioCandidate);

    expect(allowedExperimentPaths(audioCandidate)).toEqual([
      "postprocess.lipForcing.programAudioDelayMs",
    ]);
    expect(adjustedAudio.postprocess.lipForcing).toEqual({
      enabled: true,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 125,
      programAudioDelayMs: 125,
    });
    expect(validateControlledExperimentDifference(
      baseline,
      adjustedAudio,
      audioCandidate,
    )).toEqual(["postprocess.lipForcing.programAudioDelayMs"]);

    baseline.postprocess.lipForcing.enabled = false;
    expect(() => applyExperimentCandidate(baseline, audioCandidate))
      .toThrow("nur bei aktivem LipForcing");
    expect(() => applyExperimentCandidate(baseline, {
      variable: "lipforcing-mouth-delay-ms",
      value: 150,
    })).toThrow("nur bei aktivem LipForcing");
  });

  it("keeps a reused LipForcing baseline and the delay protocol hash-bound after freezing", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const request = baselineRequest();
    request.outputName = "verified-lipforcing-baseline.mp4";
    request.postprocess.lipForcing.enabled = true;
    request.postprocess.lipForcing.mouthDelayMs = 125;
    request.postprocess.lipForcing.programAudioDelayMs = 175;
    const jobId = "11111111-1111-4111-8111-111111111111";
    const frozen = store.freeze(store.create({
      title: "Modell-Steuerung 150 gegen 125 ms",
      baselineRequest: request,
      baselineOutputName: request.outputName,
      candidate: { variable: "lipforcing-mouth-delay-ms", value: 150 },
    }, "2026-08-25T10:00:00.000Z", {
      outputName: request.outputName,
      jobId,
      sizeBytes: 12_345,
      changedAt: "2026-08-25T09:59:00.000Z",
      fileId: "5678",
      provenanceFingerprint: "a".repeat(64),
    }).id, "2026-08-25T10:01:00.000Z");

    expect(frozen.changedRequestPaths).toEqual(["postprocess.lipForcing.mouthDelayMs"]);
    expect(frozen.arms[0]).toMatchObject({ jobId, attemptJobIds: [jobId] });
    expect(frozen.arms[0].requestSha256).toBe(sha256Json(frozen.arms[0].request));
    expect(frozen.arms[1].requestSha256).toBe(sha256Json(frozen.arms[1].request));
    expect(frozen.protocolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.bindingFor(frozen.id, "candidate")).toMatchObject({
      baselineJobId: jobId,
      adoptedBaseline: true,
      variableId: "lipforcing-mouth-delay-ms",
      changedRequestPaths: ["postprocess.lipForcing.mouthDelayMs"],
    });
  });

  it("treats a seed change as a replicate rather than an ablation", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const experiment = store.create({
      title: "Drei feste Seeds",
      baselineRequest: baselineRequest(),
      candidate: { variable: "replicate-seed", value: 23072026 },
    });

    expect(experiment.kind).toBe("replicate");
    expect(experiment.changedRequestPaths).toEqual(["seed"]);
  });

  it("creates two content-addressed arms and freezes an immutable protocol", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const draft = store.create({
      title: "A2V Guidance 5 gegen 3",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }, "2026-07-25T04:00:00.000Z");

    expect(draft.status).toBe("draft");
    expect(draft.protocolSha256).toBeNull();
    expect(draft.changedRequestPaths).toEqual(["videoGuidance.modalityScale"]);
    expect(draft.arms[0].request.outputName).not.toBe(draft.arms[1].request.outputName);
    expect(draft.arms[0].requestSha256).toBe(sha256Json(draft.arms[0].request));
    expect(draft.arms[0].settingsSha256).toBe(requestSettingsSha256(draft.arms[0].request));

    const frozen = store.freeze(draft.id, "2026-07-25T04:01:00.000Z");
    expect(frozen.status).toBe("frozen");
    expect(frozen.protocolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => store.freeze(draft.id)).toThrow("bereits eingefroren");
    expect(store.get(draft.id)).toEqual(frozen);
  });

  it("binds baseline before candidate and preserves the frozen request hashes", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "CRF 33 gegen 0",
      baselineRequest: baselineRequest(),
      candidate: { variable: "reference-image-crf", value: 0 },
    }).id);
    const baselineJobId = "11111111-1111-4111-8111-111111111111";
    const candidateJobId = "22222222-2222-4222-8222-222222222222";

    expect(() => store.bindingFor(frozen.id, "candidate")).toThrow("Baseline-Arm");
    const baselineBinding = store.bindingFor(frozen.id, "baseline");
    expect(baselineBinding.arm).toBe("baseline");
    expect(baselineBinding.requestSha256).toBe(frozen.arms[0].requestSha256);
    store.attachJob(frozen.id, "baseline", baselineJobId);

    const candidateBinding = store.bindingFor(frozen.id, "candidate");
    expect(candidateBinding.baselineJobId).toBe(baselineJobId);
    expect(candidateBinding.changedRequestPaths).toEqual(["images[0].crf"]);
    const completed = store.attachJob(frozen.id, "candidate", candidateJobId);
    expect(completed.arms.map((arm) => arm.jobId)).toEqual([baselineJobId, candidateJobId]);
  });

  it("passes real frozen raw-output bindings from the store into both JobManager arms", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(join(root, "experiments"));
    const manager = new JobManager(join(root, "jobs.json"), false);
    const baseline = baselineRequest();
    baseline.postprocess.lipForcing.enabled = true;
    const frozen = store.freeze(store.create({
      title: "Realer Store-zu-Job-Digestvertrag",
      baselineRequest: baseline,
      candidate: { variable: "lipforcing-raw-output-profile" },
    }).id);

    const baselineBinding = store.bindingFor(frozen.id, "baseline");
    const baselineJob = manager.create(frozen.arms[0].request, {
      experiment: baselineBinding,
      deferStart: true,
    });
    store.attachJob(frozen.id, "baseline", baselineJob.id);
    const candidateBinding = store.bindingFor(frozen.id, "candidate");
    const candidateJob = manager.create(frozen.arms[1].request, {
      experiment: candidateBinding,
      deferStart: true,
    });

    expect(baselineJob.experiment).toEqual(baselineBinding);
    expect(candidateJob.experiment).toEqual(candidateBinding);
    expect(candidateBinding).toMatchObject({
      arm: "candidate",
      variableId: "lipforcing-raw-output-profile",
      changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
      baselineJobId: baselineJob.id,
    });
    expect(candidateBinding.adoptedBaseline).toBeUndefined();
    expect(candidateBinding.requestSha256).toBe(sha256Json(frozen.arms[1].request));
  });

  it("keeps an unused frozen protocol immutable while marking its replacement", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const obsolete = store.freeze(store.create({
      title: "Irreführende Metadaten",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const replacementRequest = baselineRequest();
    replacementRequest.outputName = "neutral-guidance-test.mp4";
    replacementRequest.continuity.notes = "Nur A2V Guidance unterscheidet die Arme.";
    const replacement = store.freeze(store.create({
      title: "Neutral beschrifteter Ersatz",
      baselineRequest: replacementRequest,
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);

    const superseded = store.supersede(
      obsolete.id,
      "Dateiname und Notiz nannten in beiden Armen Guidance 5.",
      replacement.id,
      "2026-07-25T05:00:00.000Z",
    );
    expect(superseded).toMatchObject({
      status: "superseded",
      supersededAt: "2026-07-25T05:00:00.000Z",
      replacementExperimentId: replacement.id,
    });
    expect(superseded.protocolSha256).toBe(obsolete.protocolSha256);
    expect(() => store.bindingFor(obsolete.id, "baseline")).toThrow("muss vor dem Start eingefroren");
  });

  it("does not supersede an experiment after an arm was bound", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Bereits gestarteter Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    store.attachJob(frozen.id, "baseline", "11111111-1111-4111-8111-111111111111");

    expect(() => store.supersede(frozen.id, "Nicht mehr verwenden.", null))
      .toThrow("gestarteten oder früher gebundenen Armen");
  });

  it("does not link a replacement whose frozen protocol was modified", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const obsolete = store.freeze(store.create({
      title: "Alter Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const replacement = store.freeze(store.create({
      title: "Manipulierter Ersatz",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const path = join(root, `${replacement.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.arms[0].request.prompt = "Nach dem Freeze verändert";
    await writeFile(path, JSON.stringify(persisted));

    expect(() => store.supersede(obsolete.id, "Ersatz geplant.", replacement.id))
      .toThrow("nicht mehr hashkonsistent");
    expect(store.get(obsolete.id)?.status).toBe("frozen");
  });

  it("revalidates every frozen hash immediately before binding a run", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Tamper-resistenter Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const path = join(root, `${frozen.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.arms[0].request.prompt = "Nach dem Einfrieren verändert";
    await writeFile(path, JSON.stringify(persisted));

    expect(() => store.bindingFor(frozen.id, "baseline")).toThrow("nicht mehr hashkonsistent");
  });

  it("builds a retry preflight view without releasing the stored arm or audit history", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Read-only Retry-Startprüfung",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const failedJobId = "11111111-1111-4111-8111-111111111111";
    const attached = store.attachJob(frozen.id, "baseline", failedJobId);

    const preview = store.retryPreflightView(attached.id, "baseline", failedJobId);

    expect(preview.experiment.arms[0]).toMatchObject({
      jobId: null,
      attemptJobIds: [failedJobId],
    });
    expect(preview.binding).toMatchObject({
      experimentId: attached.id,
      arm: "baseline",
      requestSha256: attached.arms[0].requestSha256,
    });
    expect(store.get(attached.id)?.arms[0]).toMatchObject({
      jobId: failedJobId,
      attemptJobIds: [failedJobId],
    });
  });

  it("atomically swaps a retry arm while retaining every attempt", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Atomarer Wiederanlauf",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const failedJobId = "11111111-1111-4111-8111-111111111111";
    const nextJobId = "22222222-2222-4222-8222-222222222222";
    store.attachJob(frozen.id, "baseline", failedJobId);

    const replaced = store.replaceArmJobForRetry(
      frozen.id,
      "baseline",
      failedJobId,
      nextJobId,
    );

    expect(replaced.arms[0]).toMatchObject({
      jobId: nextJobId,
      attemptJobIds: [failedJobId, nextJobId],
    });
    expect(store.get(frozen.id)?.arms[0]).toEqual(replaced.arms[0]);
    expect(() => store.replaceArmJobForRetry(
      frozen.id,
      "baseline",
      failedJobId,
      "33333333-3333-4333-8333-333333333333",
    )).toThrow("zwischenzeitlich geändert");
    expect(store.get(frozen.id)?.arms[0]).toEqual(replaced.arms[0]);
  });

  it("reconciles a persisted experiment-bound job after a crash before arm attachment", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Crash-Recovery",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const jobId = "11111111-1111-4111-8111-111111111111";

    const recoverable = {
      id: jobId,
      status: "interrupted",
      startedAt: "2026-07-25T04:00:00.000Z",
      dgxJobId: "dgx-job-recoverable",
      experiment: binding,
    };
    store.reconcileJobs([recoverable]);
    store.reconcileJobs([recoverable]);

    expect(store.get(frozen.id)?.arms[0].jobId).toBe(jobId);
    expect(() => store.bindingFor(frozen.id, "baseline")).toThrow("bereits gestartet");
  });

  it("revalidates an already attached job binding before the reconciliation fast path", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Fast-Path darf Protokolldrift nicht übergehen",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const jobId = "11111111-1111-4111-8111-111111111111";
    store.attachJob(frozen.id, "baseline", jobId);

    expect(() => store.reconcileJobs([{
      id: jobId,
      status: "running",
      startedAt: "2026-08-25T10:00:00.000Z",
      dgxJobId: "dgx-job-tampered-attached-binding",
      experiment: { ...binding, requestSha256: "0".repeat(64) },
    }])).toThrow("passt nicht zum eingefrorenen Experimentprotokoll");
  });

  it("leaves a clearly never-started crash orphan unbound and preserves retry history", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Nie gestarteter Crash",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const firstBinding = store.bindingFor(frozen.id, "baseline");
    const firstJobId = "11111111-1111-4111-8111-111111111111";
    store.reconcileJobs([{
      id: firstJobId,
      status: "interrupted",
      startedAt: null,
      dgxJobId: null,
      experiment: firstBinding,
    }]);
    expect(store.get(frozen.id)?.arms[0].jobId).toBeNull();

    store.attachJob(frozen.id, "baseline", firstJobId);
    store.releaseArmForRetry(frozen.id, "baseline", firstJobId);
    const secondJobId = "22222222-2222-4222-8222-222222222222";
    store.attachJob(frozen.id, "baseline", secondJobId);

    expect(store.get(frozen.id)?.arms[0]).toMatchObject({
      jobId: secondJobId,
      attemptJobIds: [firstJobId, secondJobId],
    });
  });

  it("durably fences prepared retry jobs across crashes before CAS and before start arming", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(join(root, "experiments"));
    const jobsPath = join(root, "jobs.json");
    const frozen = store.freeze(store.create({
      title: "Crash-sicherer atomarer Wiederanlauf",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const failedJobId = "11111111-1111-4111-8111-111111111111";
    store.attachJob(frozen.id, "baseline", failedJobId);

    // Crash point 1: JobManager has durably prepared a job, but the
    // ExperimentStore CAS still points at the previous terminal attempt.
    const firstPreview = store.retryPreflightView(frozen.id, "baseline", failedJobId);
    const firstManager = new JobManager(jobsPath, false);
    const preCasOrphan = firstManager.create(firstPreview.experiment.arms[0].request, {
      experiment: firstPreview.binding,
      deferStart: true,
    });
    const firstPersisted = JSON.parse(await readFile(jobsPath, "utf8"));
    expect(firstPersisted.find((entry: { id: string }) => entry.id === preCasOrphan.id))
      .toMatchObject({ status: "queued", startDeferred: true });
    expect(Object.hasOwn(preCasOrphan, "startDeferred")).toBe(false);

    const afterPreCasCrash = new JobManager(jobsPath, false);
    expect(afterPreCasCrash.get(preCasOrphan.id)).toMatchObject({
      status: "interrupted",
      startedAt: null,
      dgxJobId: null,
      error: expect.stringContaining("vor der dauerhaften Startfreigabe"),
    });
    expect(Reflect.get(afterPreCasCrash, "queue")).toEqual([]);
    store.reconcileJobs(afterPreCasCrash.list());
    expect(store.get(frozen.id)?.arms[0]).toMatchObject({
      jobId: failedJobId,
      attemptJobIds: [failedJobId],
    });

    // Crash point 2: the external CAS has committed, but startQueued() has not
    // yet durably armed the prepared job. It remains bound but never executes.
    const secondPreview = store.retryPreflightView(frozen.id, "baseline", failedJobId);
    const postCasPrepared = afterPreCasCrash.create(secondPreview.experiment.arms[0].request, {
      experiment: secondPreview.binding,
      deferStart: true,
    });
    store.replaceArmJobForRetry(frozen.id, "baseline", failedJobId, postCasPrepared.id);

    const afterPostCasCrash = new JobManager(jobsPath, false);
    expect(afterPostCasCrash.get(postCasPrepared.id)).toMatchObject({
      status: "interrupted",
      startedAt: null,
      dgxJobId: null,
      error: expect.stringContaining("vor der dauerhaften Startfreigabe"),
    });
    expect(Reflect.get(afterPostCasCrash, "queue")).toEqual([]);
    expect(afterPostCasCrash.list().map((job) => ({
      id: job.id,
      status: job.status,
      startedAt: job.startedAt,
      dgxJobId: job.dgxJobId,
    }))).toEqual(expect.arrayContaining([
      { id: preCasOrphan.id, status: "interrupted", startedAt: null, dgxJobId: null },
      { id: postCasPrepared.id, status: "interrupted", startedAt: null, dgxJobId: null },
    ]));
    store.reconcileJobs(afterPostCasCrash.list());
    expect(store.get(frozen.id)?.arms[0]).toMatchObject({
      jobId: postCasPrepared.id,
      attemptJobIds: [failedJobId, postCasPrepared.id],
    });

    // Once the next retry CAS succeeds, startQueued() removes the durable
    // fence before queueing. A crash after that write may safely auto-resume.
    const thirdPreview = store.retryPreflightView(frozen.id, "baseline", postCasPrepared.id);
    const armed = afterPostCasCrash.create(thirdPreview.experiment.arms[0].request, {
      experiment: thirdPreview.binding,
      deferStart: true,
    });
    store.replaceArmJobForRetry(frozen.id, "baseline", postCasPrepared.id, armed.id);
    expect(afterPostCasCrash.startQueued(armed.id)?.status).toBe("queued");
    const armedPersisted = JSON.parse(await readFile(jobsPath, "utf8"));
    expect(Object.hasOwn(
      armedPersisted.find((entry: { id: string }) => entry.id === armed.id),
      "startDeferred",
    )).toBe(false);

    const afterArmedCrash = new JobManager(jobsPath, false);
    expect(afterArmedCrash.get(armed.id)?.status).toBe("queued");
    expect(Reflect.get(afterArmedCrash, "queue")).toEqual([armed.id]);
    store.reconcileJobs(afterArmedCrash.list());
    expect(store.get(frozen.id)?.arms[0]).toMatchObject({
      jobId: armed.id,
      attemptJobIds: [failedJobId, postCasPrepared.id, armed.id],
    });
  });

  it("does not let another job's shared pump cross a deferred experiment start fence", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(join(root, "experiments"));
    const manager = new JobManager(join(root, "jobs.json"), false);
    const frozen = store.freeze(store.create({
      title: "Nebenläufiger Queue-Pump",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const prepared = manager.create(frozen.arms[0].request, {
      experiment: store.bindingFor(frozen.id, "baseline"),
      deferStart: true,
    });
    const directRequest = baselineRequest();
    directRequest.outputName = "independent-runnable-job.mp4";
    const runnable = manager.create(directRequest);
    const started: string[] = [];
    Reflect.set(manager, "run", async (job: { id: string; status: string; finishedAt: string | null }) => {
      started.push(job.id);
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    });

    const pump = Reflect.get(manager, "pump") as () => Promise<void>;
    await pump.call(manager);

    expect(started).toEqual([runnable.id]);
    expect(manager.get(prepared.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(Reflect.get(manager, "queue")).toEqual([prepared.id]);
  });

  it("keeps an interrupted deferred arm stable across repeated restarts", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(join(root, "experiments"));
    const jobsPath = join(root, "jobs.json");
    const manager = new JobManager(jobsPath, false);
    const frozen = store.freeze(store.create({
      title: "Dauerhaft unterbrochene Startfreigabe",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const prepared = manager.create(frozen.arms[0].request, {
      experiment: store.bindingFor(frozen.id, "baseline"),
      deferStart: true,
    });
    store.attachJob(frozen.id, "baseline", prepared.id);

    const interrupted = manager.interruptDeferredStart(
      prepared.id,
      "Synthetischer Commit-Fehler vor der Startfreigabe.",
    );
    expect(interrupted).toMatchObject({
      status: "interrupted",
      startedAt: null,
      dgxJobId: null,
      error: "Synthetischer Commit-Fehler vor der Startfreigabe.",
    });
    expect(interrupted?.finishedAt).toBeTruthy();
    const persisted = JSON.parse(await readFile(jobsPath, "utf8"));
    expect(persisted.find((entry: { id: string }) => entry.id === prepared.id))
      .toMatchObject({ status: "interrupted", startDeferred: true });

    const firstRestart = new JobManager(jobsPath, false);
    const secondRestart = new JobManager(jobsPath, false);
    for (const restarted of [firstRestart, secondRestart]) {
      expect(restarted.get(prepared.id)).toMatchObject({
        status: "interrupted",
        startedAt: null,
        dgxJobId: null,
      });
      expect(Reflect.get(restarted, "queue")).toEqual([]);
      expect(() => store.reconcileJobs(restarted.list())).not.toThrow();
    }
    expect(firstRestart.get(prepared.id)?.finishedAt).toBe(interrupted?.finishedAt);
    expect(secondRestart.get(prepared.id)?.finishedAt).toBe(interrupted?.finishedAt);
    expect(store.get(frozen.id)?.arms[0].jobId).toBe(prepared.id);
  });

  it("accepts a hash-verified baseline output after its job history was pruned", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Dauerhafte Baseline",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const jobId = "11111111-1111-4111-8111-111111111111";
    const current = store.attachJob(frozen.id, "baseline", jobId);
    const output: StudioOutput = {
      name: current.arms[0].request.outputName,
      url: "/api/outputs/baseline.mp4",
      sizeBytes: 1,
      modifiedAt: "2026-07-25T04:00:00.000Z",
      changedAt: "2026-07-25T04:00:01.000Z",
      fileId: "1",
      jobId,
      jobStatus: "completed",
      request: current.arms[0].request,
      settingsAvailable: true,
      qualityReview: null,
      analysis: null,
      experiment: binding,
      experimentRequestVerified: true,
      provenance: {
        schemaVersion: "ltx-studio-run-provenance.v1",
        capturedAt: "2026-07-25T04:00:00.000Z",
        verifiedAt: "2026-07-25T04:01:00.000Z",
        files: [],
        code: [],
        runtime: {
          platform: "linux",
          architecture: "arm64",
          kernelRelease: "test",
          nodeVersion: "test",
          pythonExecutable: "/python",
          pythonVersion: "3.12",
          packages: {},
          ffmpegVersion: "test",
          fingerprint: "a".repeat(64),
        },
        fingerprint: "b".repeat(64),
      },
    };

    expect(outputVerifiesExperimentBaseline(output, current)).toBe(true);
    const tamperedRequest = structuredClone(output.request!);
    tamperedRequest.seed += 1;
    output.request = tamperedRequest;
    expect(outputVerifiesExperimentBaseline(output, current)).toBe(false);
  });

  it("adopts an unchanged verified output as a durable baseline without rerendering it", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const request = baselineRequest();
    request.outputName = "verified-existing-baseline.mp4";
    const jobId = "11111111-1111-4111-8111-111111111111";
    const evidence = {
      outputName: request.outputName,
      jobId,
      sizeBytes: 12_345,
      changedAt: "2026-07-30T10:00:00.000Z",
      fileId: "4567",
      provenanceFingerprint: "a".repeat(64),
    };
    const frozen = store.freeze(store.create({
      title: "Bestehende Basis gegen LipForcing",
      baselineRequest: request,
      baselineOutputName: request.outputName,
      candidate: { variable: "lipforcing-enabled" },
    }, "2026-07-30T10:01:00.000Z", evidence).id);

    expect(frozen.arms[0]).toMatchObject({
      jobId,
      attemptJobIds: [jobId],
      request: { outputName: request.outputName },
    });
    expect(frozen.arms[1].request.postprocess.lipForcing.enabled).toBe(true);
    const binding = store.bindingFor(frozen.id, "candidate");
    expect(binding.baselineJobId).toBe(jobId);
    expect(binding.adoptedBaseline).toBe(true);

    const output: StudioOutput = {
      name: request.outputName,
      url: "/api/outputs/verified-existing-baseline.mp4",
      sizeBytes: evidence.sizeBytes,
      modifiedAt: "2026-07-30T09:59:00.000Z",
      changedAt: evidence.changedAt,
      fileId: evidence.fileId,
      jobId,
      jobStatus: "completed",
      request: frozen.arms[0].request,
      settingsAvailable: true,
      qualityReview: null,
      analysis: null,
      provenance: {
        schemaVersion: "ltx-studio-run-provenance.v1",
        capturedAt: "2026-07-30T09:00:00.000Z",
        verifiedAt: "2026-07-30T10:00:00.000Z",
        files: [],
        code: [],
        runtime: {
          platform: "linux",
          architecture: "arm64",
          kernelRelease: "test",
          nodeVersion: "test",
          pythonExecutable: "/python",
          pythonVersion: "3.12",
          packages: {},
          ffmpegVersion: "test",
          fingerprint: "b".repeat(64),
        },
        fingerprint: evidence.provenanceFingerprint,
      },
    };

    expect(outputVerifiesExperimentBaseline(output, frozen)).toBe(true);
    output.fileId = "9999";
    expect(outputVerifiesExperimentBaseline(output, frozen)).toBe(false);
  });

  it("fails closed on a corrupted experiment file", async () => {
    const root = await experimentRoot();
    const id = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(root, `${id}.json`), "{ broken");
    const store = new ExperimentStore(root);

    expect(() => store.get(id)).toThrow(ExperimentConflictError);
    expect(() => store.list()).toThrow("beschädigt");
    expect(store.listAvailable()).toEqual({
      experiments: [],
      warnings: [expect.stringContaining("beschädigt")],
    });
  });

  it("keeps a legacy experiment archived without hiding current experiments", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const current = store.create({
      title: "Aktueller Vergleich",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    });
    const legacyId = "22222222-2222-4222-8222-222222222222";
    const legacy = JSON.parse(
      await readFile(join(root, `${current.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    legacy.id = legacyId;
    const arms = legacy.arms as Array<{ request: {
      icLora: Record<string, unknown>;
      models: Record<string, unknown>;
      postprocess: Record<string, unknown>;
    } }>;
    for (const arm of arms) {
      delete arm.request.models.gemmaLora;
      delete arm.request.icLora.hdrTextEmbeddingsPath;
      delete arm.request.icLora.hdrHighQuality;
      delete arm.request.postprocess.lipForcing;
    }
    await writeFile(join(root, `${legacyId}.json`), JSON.stringify(legacy));

    const available = store.listAvailable();
    expect(available.experiments.map((experiment) => experiment.id)).toEqual([current.id]);
    expect(available.warnings).toEqual([
      expect.stringContaining("älteren Studio-Version"),
    ]);
  });

  it.each([
    {
      cohort: "pre-split stable",
      missingPaths: [
        "models.layout",
        "models.generation",
        "models.transformerPath",
        "models.textEncoderPath",
        "models.videoVaePath",
        "models.audioVaePath",
        "models.durationHeadPath",
        "models.promptEnhancerGemmaRoot",
        "models.gemmaLora.enabled",
        "textToAudio",
        "distilled",
        "postprocess.lipForcing.rawOutputProfile",
        "postprocess.lipForcing.mouthDelayMs",
        "postprocess.lipForcing.programAudioDelayMs",
      ],
    },
    {
      cohort: "late pre-raw-output canary",
      missingPaths: [
        "textToAudio",
        "postprocess.lipForcing.rawOutputProfile",
      ],
    },
  ])("upgrades retained terminal retries from a $cohort clone as an immutable archive", async ({ missingPaths }) => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Historischer stabiler Experimentvertrag",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const baselineJobId = "11111111-1111-4111-8111-111111111111";
    const completedCandidateJobId = "22222222-2222-4222-8222-222222222222";
    const failedCandidateJobId = "33333333-3333-4333-8333-333333333333";
    store.attachJob(frozen.id, "baseline", baselineJobId);
    const candidateBinding = store.bindingFor(frozen.id, "candidate");
    store.attachJob(frozen.id, "candidate", completedCandidateJobId);
    const path = join(root, `${frozen.id}.json`);
    const archived = JSON.parse(await readFile(path, "utf8")) as {
      arms: Array<{ request: Record<string, unknown> }>;
    };
    const removeRequestPath = (request: Record<string, unknown>, dottedPath: string) => {
      const parts = dottedPath.split(".");
      const finalPart = parts.pop();
      let parent = request;
      for (const part of parts) parent = parent[part] as Record<string, unknown>;
      if (finalPart) delete parent[finalPart];
    };
    for (const arm of archived.arms) {
      for (const missingPath of missingPaths) removeRequestPath(arm.request, missingPath);
    }
    await writeFile(path, JSON.stringify(archived));
    const before = await readFile(path);
    const beforeMtimeMs = (await stat(path)).mtimeMs;

    expect(() => store.reconcileJobs([
      {
        id: completedCandidateJobId,
        status: "completed",
        startedAt: "2026-08-04T21:09:38.365Z",
        dgxJobId: null,
        experiment: candidateBinding,
      },
      {
        id: failedCandidateJobId,
        status: "failed",
        startedAt: "2026-08-04T20:43:59.041Z",
        dgxJobId: null,
        experiment: candidateBinding,
      },
    ])).not.toThrow();

    expect(await readFile(path)).toEqual(before);
    expect((await stat(path)).mtimeMs).toBe(beforeMtimeMs);
    expect(store.listAvailable()).toEqual({
      experiments: [],
      warnings: [expect.stringContaining("schreibgeschützt archiviert")],
    });
    expect(() => store.bindingFor(frozen.id, "candidate"))
      .toThrow("schreibgeschützt archiviert");
  });

  it("does not let a schema default silently make a pre-profile experiment executable", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Historischer IC-LoRA-Profilvertrag",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const path = join(root, `${frozen.id}.json`);
    const archived = JSON.parse(await readFile(path, "utf8")) as {
      arms: Array<{ request: { icLora: Record<string, unknown> } }>;
    };
    for (const arm of archived.arms) delete arm.request.icLora.profile;
    await writeFile(path, JSON.stringify(archived));
    const before = await readFile(path);

    expect(() => store.reconcileJobs([{
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      startedAt: "2026-08-04T21:09:38.365Z",
      dgxJobId: null,
      experiment: binding,
    }])).not.toThrow();
    expect(await readFile(path)).toEqual(before);
    expect(() => store.bindingFor(frozen.id, "baseline"))
      .toThrow("schreibgeschützt archiviert");
  });

  it.each(["completed", "failed", "cancelled", "interrupted"])(
    "skips an immutable pre-textToAudio archive during %s job reconciliation",
    async (status) => {
      const root = await experimentRoot();
      const store = new ExperimentStore(root);
      const frozen = store.freeze(store.create({
        title: "Historisches Audio-Experiment",
        baselineRequest: baselineRequest(),
        candidate: { variable: "a2v-guidance", value: 3 },
      }).id);
      const binding = store.bindingFor(frozen.id, "baseline");
      const path = join(root, `${frozen.id}.json`);
      const archived = JSON.parse(await readFile(path, "utf8")) as {
        arms: Array<{ request: Record<string, unknown> }>;
      };
      for (const arm of archived.arms) delete arm.request.textToAudio;
      await writeFile(path, JSON.stringify(archived));
      const before = await readFile(path);

      expect(() => store.reconcileJobs([{
        id: "11111111-1111-4111-8111-111111111111",
        status,
        startedAt: "2026-08-14T12:00:00.000Z",
        dgxJobId: "dgx-job-historical-terminal",
        experiment: binding,
      }])).not.toThrow();

      expect(await readFile(path)).toEqual(before);
      expect(store.listAvailable()).toEqual({
        experiments: [],
        warnings: [expect.stringContaining("schreibgeschützt archiviert")],
      });
    },
  );

  it("archives a terminal pre-raw-output-profile experiment without rewriting frozen evidence", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Historischer LipForcing-Muxvertrag",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const path = join(root, `${frozen.id}.json`);
    const archived = JSON.parse(await readFile(path, "utf8")) as {
      arms: Array<{ request: { postprocess: { lipForcing: Record<string, unknown> } } }>;
    };
    for (const arm of archived.arms) delete arm.request.postprocess.lipForcing.rawOutputProfile;
    await writeFile(path, JSON.stringify(archived));
    const before = await readFile(path);
    const beforeMtimeMs = (await stat(path)).mtimeMs;

    expect(() => store.reconcileJobs([{
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      startedAt: "2026-08-25T12:00:00.000Z",
      dgxJobId: "dgx-job-terminal-before-raw-output-profile",
      experiment: binding,
    }])).not.toThrow();

    expect(await readFile(path)).toEqual(before);
    expect((await stat(path)).mtimeMs).toBe(beforeMtimeMs);
    expect(store.listAvailable()).toEqual({
      experiments: [],
      warnings: [expect.stringContaining("schreibgeschützt archiviert")],
    });
  });

  it.each([
    "attacker-controlled-invalid-profile",
    13,
  ])("does not classify an explicit invalid raw-output value %s as legacy", async (invalidProfile) => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Beschädigter Raw-Profilwert",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const path = join(root, `${frozen.id}.json`);
    const corrupted = JSON.parse(await readFile(path, "utf8"));
    corrupted.arms[0].request.postprocess.lipForcing.rawOutputProfile = invalidProfile;
    await writeFile(path, JSON.stringify(corrupted));
    const before = await readFile(path);

    expect(() => store.reconcileJobs([{
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      startedAt: "2026-08-25T12:00:00.000Z",
      dgxJobId: "dgx-job-corrupt-raw-profile",
      experiment: binding,
    }])).toThrow("ungültig");
    expect(await readFile(path)).toEqual(before);
  });

  it("keeps an active pre-raw-output-profile experiment binding fail-closed", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Aktiver historischer LipForcing-Muxvertrag",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const path = join(root, `${frozen.id}.json`);
    const archived = JSON.parse(await readFile(path, "utf8")) as {
      arms: Array<{ request: { postprocess: { lipForcing: Record<string, unknown> } } }>;
    };
    for (const arm of archived.arms) delete arm.request.postprocess.lipForcing.rawOutputProfile;
    await writeFile(path, JSON.stringify(archived));
    const before = await readFile(path);

    expect(() => store.reconcileJobs([{
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      startedAt: "2026-08-25T12:00:00.000Z",
      dgxJobId: "dgx-job-active-before-raw-output-profile",
      experiment: binding,
    }])).toThrow("schreibgeschützt archiviert");
    expect(await readFile(path)).toEqual(before);
  });

  it("keeps active pre-textToAudio experiment bindings fail-closed", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Aktiver historischer Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const path = join(root, `${frozen.id}.json`);
    const archived = JSON.parse(await readFile(path, "utf8")) as {
      arms: Array<{ request: Record<string, unknown> }>;
    };
    for (const arm of archived.arms) delete arm.request.textToAudio;
    await writeFile(path, JSON.stringify(archived));

    expect(() => store.reconcileJobs([{
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      startedAt: "2026-08-14T12:00:00.000Z",
      dgxJobId: "dgx-job-still-active",
      experiment: binding,
    }])).toThrow("schreibgeschützt archiviert");
  });

  it("does not hide corrupt terminal experiment history during reconciliation", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Beschädigtes Archiv",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    await writeFile(join(root, `${frozen.id}.json`), "{ broken");

    expect(() => store.reconcileJobs([{
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      startedAt: "2026-08-14T12:00:00.000Z",
      dgxJobId: "dgx-job-corrupt-terminal",
      experiment: binding,
    }])).toThrow("beschädigt");
  });

  it("keeps output names out of substantive request diffs", () => {
    const baseline = baselineRequest();
    const candidate = structuredClone(baseline);
    candidate.outputName = "different.mp4";

    expect(generationRequestDiffPaths(baseline, candidate)).toEqual(["outputName"]);
    expect(requestSettingsSha256(baseline)).toBe(requestSettingsSha256(candidate));
  });
});
