import { z } from "zod";

import { outputNameSchema } from "./pipelines.js";
import { runtimeTrustBindingSchema } from "./runtimeTrust.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const scoreSchema = z.number().int().min(1).max(10);
const armSchema = z.enum(["baseline", "candidate"]);
const channelSchema = z.enum(["x", "y"]);
const fileIdSchema = z.string().regex(/^\d{1,64}$/);
const positiveSizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const BLIND_EVALUATOR_SCOPE_COOKIE = "ltx_blind_evaluator_scope_v5";
export const BLIND_EVALUATION_PADDING_BUCKET_BYTES = 8 * 1_024 * 1_024;
export const BLIND_EVALUATION_CANONICAL_WIDTH = 1_280;
export const BLIND_EVALUATION_CANONICAL_HEIGHT = 1_280;
export const BLIND_EVALUATION_CANONICAL_FPS = 25;
export const BLIND_EVALUATION_VIDEO_BIT_RATE = 12_000_000;
export const BLIND_EVALUATION_AUDIO_BIT_RATE = 192_000;
export const BLIND_EVALUATION_AUDIO_SAMPLE_RATE = 48_000;
export const BLIND_EVALUATION_NORMAL_COVERAGE_RATIO = 0.9;
export const BLIND_EVALUATION_HALF_COVERAGE_RATIO = 0.5;
export function blindEvaluationTimelineRequirements(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Blind-v5-Coverage benötigt eine positive kanonische Dauer.");
  }
  return {
    intervalUnit: "media-milliseconds" as const,
    normalMinimumRatio: BLIND_EVALUATION_NORMAL_COVERAGE_RATIO,
    halfMinimumRatio: BLIND_EVALUATION_HALF_COVERAGE_RATIO,
    audibleNormalMinimumRatio: BLIND_EVALUATION_NORMAL_COVERAGE_RATIO,
    audibleHalfMinimumRatio: BLIND_EVALUATION_HALF_COVERAGE_RATIO,
    endedRequired: true as const,
    minimumReviewWallTimeSeconds: Number((durationSeconds * 6).toFixed(3)),
  };
}
export const BLIND_EVALUATION_LIMITATION =
  "Eine einzelne lokale Blindbewertung ist Entwicklungs-Evidence und kein Product-GO- oder SOTA-Beweis. "
  + "Archivautorität und anonyme O_TMPFILE-Snapshots verhindern keine Manipulation durch dieselbe lokale UID; "
  + "Security-/Product-GO erfordert zusätzlich attestierte separate proc/fd-Isolation oder einen externen Signer-/Sealed-FD-Broker.";
export const BLIND_EVALUATION_THREAT_MODEL =
  "Schützt einen ehrlichen UI-Evaluator vor Dateinamen, Einstellungen, Scores sowie den ausdrücklich kanonisierten Transport-, Container- und Encodermerkmalen durch ein festes H.264/AAC-Zielprofil und einen persistenten Evaluator-Lock. Schützt nicht vor Host-, Dateisystem- oder Administratorzugriff, vor vorab bekannten oder dekodierten Quellbytes oder vor inhaltsabhängiger Analyse der MP4-Sampletabellen; Byte-Ununterscheidbarkeit wird nicht behauptet.";
export const BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE = [
  "-nostdin",
  "-hide_banner",
  "-loglevel", "error",
  "-n",
  "-i", "{source-fd}",
  "-map", "0:v:0",
  "-map", "0:a:0",
  "-map_metadata", "-1",
  "-map_chapters", "-1",
  "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1/1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,fps=25,trim=end_frame={frame-count},setpts=PTS-STARTPTS,format=yuv420p",
  "-af", "aresample=48000:async=0:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=end={duration},apad=whole_dur={duration},atrim=end={duration},asetpts=PTS-STARTPTS",
  "-c:v", "libx264",
  "-preset", "medium",
  "-profile:v", "high",
  "-level:v", "5.1",
  "-pix_fmt", "yuv420p",
  "-color_range", "tv",
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-aspect", "1:1",
  "-r", "25",
  "-frames:v", "{frame-count}",
  "-g", "50",
  "-keyint_min", "50",
  "-sc_threshold", "0",
  "-bf", "2",
  "-refs", "3",
  "-b:v", "12000000",
  "-minrate", "12000000",
  "-maxrate", "12000000",
  "-bufsize", "24000000",
  "-x264-params", "nal-hrd=cbr:force-cfr=1:filler=1:vbv-init=1:keyint=50:min-keyint=50:scenecut=0:open-gop=0:ref=3:bframes=2",
  "-bsf:v", "filter_units=remove_types=6",
  "-c:a", "aac",
  "-profile:a", "aac_low",
  "-sample_fmt", "fltp",
  "-b:a", "192000",
  "-ar", "48000",
  "-ac", "2",
  "-t", "{duration}",
  "-shortest",
  "-fflags", "+bitexact",
  "-flags:v", "+bitexact",
  "-flags:a", "+bitexact",
  "-movflags", "+faststart",
  "-brand", "isom",
  "-video_track_timescale", "90000",
  "-use_editlist", "1",
  "-metadata", "encoder=",
  "-metadata", "title=",
  "-metadata", "comment=",
  "-metadata:s:v:0", "handler_name=VideoHandler",
  "-metadata:s:v:0", "language=und",
  "-metadata:s:a:0", "handler_name=SoundHandler",
  "-metadata:s:a:0", "language=und",
  "-disposition:v:0", "default",
  "-disposition:a:0", "default",
  "-f", "mp4",
  "{target}",
] as const;

const armScoresSchema = z.object({
  timing: scoreSchema,
  mouthIntegration: scoreSchema,
  eyesIdentity: scoreSchema,
  resolutionDetail: scoreSchema,
}).strict();

export const blindEvaluationChannelSchema = channelSchema;
export type BlindEvaluationChannel = z.infer<typeof blindEvaluationChannelSchema>;

export const blindEvaluationCreateInputSchema = z.object({
  experimentId: z.string().uuid(),
  creationRequestId: sha256Schema,
}).strict();

export const blindEvaluationClaimInputSchema = z.object({
  creationToken: sha256Schema,
}).strict();

const playbackIntervalSchema = z.object({
  startMilliseconds: z.number().int().nonnegative().max(86_400_000),
  endMilliseconds: z.number().int().positive().max(86_400_000),
}).strict().refine((value) => value.endMilliseconds > value.startMilliseconds, {
  message: "Ein Wiedergabeintervall muss eine positive Medienzeitspanne besitzen.",
});

export type BlindEvaluationPlaybackInterval = z.infer<typeof playbackIntervalSchema>;

const playbackCoverageSchema = z.object({
  intervals: z.array(playbackIntervalSchema).max(10_000),
  uniqueCoverageMilliseconds: z.number().int().nonnegative().max(86_400_000),
  coverageRatio: z.number().finite().min(0).max(1),
  ended: z.boolean(),
}).strict();

export type BlindEvaluationTimelineCoverage = z.infer<typeof playbackCoverageSchema>;

export function summarizeBlindPlaybackCoverage(
  intervalsValue: readonly BlindEvaluationPlaybackInterval[],
  durationMilliseconds: number,
  ended: boolean,
): BlindEvaluationTimelineCoverage {
  if (!Number.isInteger(durationMilliseconds) || durationMilliseconds <= 0 || durationMilliseconds > 86_400_000) {
    throw new Error("Blind-v5-Coverage benötigt eine positive, endliche Mediendauer in Millisekunden.");
  }
  const sorted = intervalsValue
    .map((interval) => ({
      startMilliseconds: Math.max(0, Math.min(durationMilliseconds, Math.trunc(interval.startMilliseconds))),
      endMilliseconds: Math.max(0, Math.min(durationMilliseconds, Math.trunc(interval.endMilliseconds))),
    }))
    .filter((interval) => interval.endMilliseconds > interval.startMilliseconds)
    .sort((left, right) => left.startMilliseconds - right.startMilliseconds
      || left.endMilliseconds - right.endMilliseconds);
  const intervals: BlindEvaluationPlaybackInterval[] = [];
  for (const interval of sorted) {
    const previous = intervals.at(-1);
    if (!previous || interval.startMilliseconds > previous.endMilliseconds) {
      intervals.push({ ...interval });
    } else {
      previous.endMilliseconds = Math.max(previous.endMilliseconds, interval.endMilliseconds);
    }
  }
  const uniqueCoverageMilliseconds = intervals.reduce(
    (total, interval) => total + interval.endMilliseconds - interval.startMilliseconds,
    0,
  );
  return playbackCoverageSchema.parse({
    intervals,
    uniqueCoverageMilliseconds,
    coverageRatio: Number((uniqueCoverageMilliseconds / durationMilliseconds).toFixed(9)),
    ended,
  });
}

export function extendBlindPlaybackCoverage(
  coverage: BlindEvaluationTimelineCoverage,
  durationMilliseconds: number,
  startMilliseconds: number,
  endMilliseconds: number,
  ended = coverage.ended,
): BlindEvaluationTimelineCoverage {
  return summarizeBlindPlaybackCoverage([
    ...coverage.intervals,
    { startMilliseconds, endMilliseconds },
  ], durationMilliseconds, ended);
}

const channelPlaybackEvidenceSchema = z.object({
  durationMilliseconds: z.number().int().positive().max(86_400_000),
  normalSpeed: playbackCoverageSchema,
  halfSpeed: playbackCoverageSchema,
  audibleNormalSpeed: playbackCoverageSchema,
  audibleHalfSpeed: playbackCoverageSchema,
  mediaLoaded: z.literal(true),
  playSucceeded: z.literal(true),
  audioReviewed: z.literal(true),
}).strict().superRefine((value, context) => {
  for (const field of ["normalSpeed", "halfSpeed", "audibleNormalSpeed", "audibleHalfSpeed"] as const) {
    const coverage = value[field];
    const canonical = summarizeBlindPlaybackCoverage(
      coverage.intervals,
      value.durationMilliseconds,
      coverage.ended,
    );
    if (canonicalBlindEvaluationJson(canonical) !== canonicalBlindEvaluationJson(coverage)) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Wiedergabeintervalle müssen sortiert, nicht überlappend und exakt als eindeutige Coverage gebunden sein.",
      });
    }
  }
});

export const blindEvaluationPlaybackEvidenceSchema = z.object({
  x: channelPlaybackEvidenceSchema,
  y: channelPlaybackEvidenceSchema,
  normalSpeedReviewed: z.literal(true),
  halfSpeedReviewed: z.literal(true),
  humanObservationAttested: z.literal(true),
}).strict();

export const blindEvaluationSubmissionInputSchema = z.object({
  scores: z.object({ x: armScoresSchema, y: armScoresSchema }).strict(),
  preference: z.enum(["x", "y", "tie"]),
  confidence: z.number().int().min(1).max(5),
  note: z.string().trim().max(2_000).refine((value) => !value.includes("\0"), {
    message: "NUL-Zeichen sind nicht erlaubt.",
  }),
  playback: blindEvaluationPlaybackEvidenceSchema,
}).strict();

export type BlindEvaluationSubmissionInput = z.infer<typeof blindEvaluationSubmissionInputSchema>;

const fileRevisionSchema = z.object({
  sha256: sha256Schema,
  deviceId: fileIdSchema,
  modifiedAtMs: z.number().finite().nonnegative(),
  changedAtMs: z.number().finite().nonnegative(),
  fileId: fileIdSchema,
  mode: nonnegativeIntegerSchema,
}).strict();

export type BlindEvaluationFileRevision = z.infer<typeof fileRevisionSchema>;

export const blindEvaluationPrivateFileRevisionSchema = fileRevisionSchema.extend({
  sizeBytes: positiveSizeSchema,
}).strict();

export type BlindEvaluationPrivateFileRevision = z.infer<typeof blindEvaluationPrivateFileRevisionSchema>;

export const blindEvaluationToolBindingSchema = z.object({
  path: z.string().min(1).max(4_096).refine((value) => value.startsWith("/"), {
    message: "Das gebundene Tool benötigt einen absoluten Pfad.",
  }),
  sha256: sha256Schema,
  version: z.string().min(1).max(1_000),
  revision: z.object({
    deviceId: fileIdSchema,
    fileId: fileIdSchema,
    sizeBytes: positiveSizeSchema,
    modifiedAtMs: z.number().finite().nonnegative(),
    changedAtMs: z.number().finite().nonnegative(),
    mode: nonnegativeIntegerSchema,
    uid: nonnegativeIntegerSchema,
    gid: nonnegativeIntegerSchema,
    linkCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();

export type BlindEvaluationToolBinding = z.infer<typeof blindEvaluationToolBindingSchema>;

export const blindEvaluationReleaseBindingSchema = z.object({
  sealed: z.boolean(),
  verified: z.boolean(),
  releaseDigest: sha256Schema.nullable(),
  manifestSha256: sha256Schema.nullable(),
  surfaceDigest: sha256Schema.nullable(),
  runtimeInstallSealSha256: sha256Schema.nullable(),
  runtimeTreeSha256: sha256Schema.nullable(),
  runtimePolicySha256: sha256Schema.nullable(),
  nodeExecutableSha256: sha256Schema.nullable(),
  expectedHostTcbAttestationSha256: sha256Schema.nullable(),
  runtimeTrust: runtimeTrustBindingSchema.nullable(),
  sourceCommit: z.string().min(1).max(128).nullable(),
}).strict().superRefine((value, context) => {
  const hashes = [
    value.releaseDigest,
    value.manifestSha256,
    value.surfaceDigest,
    value.runtimeInstallSealSha256,
    value.runtimeTreeSha256,
    value.runtimePolicySha256,
    value.nodeExecutableSha256,
    value.expectedHostTcbAttestationSha256,
  ];
  if (value.sealed) {
    if (!value.verified || hashes.some((digest) => digest === null) || value.sourceCommit === null
      || value.runtimeTrust === null
      || value.runtimeTrust.hostTcbAttestationSha256 !== value.expectedHostTcbAttestationSha256) {
      context.addIssue({ code: "custom", message: "Eine sealed v5-Bindung benötigt Release, vier Runtime-Digests und Host-TCB-Pin." });
    }
  } else if (value.verified || hashes.some((digest) => digest !== null)
    || value.runtimeTrust !== null || value.sourceCommit !== null) {
    context.addIssue({ code: "custom", message: "Eine unsealed v5-Bindung muss ihre fehlende Release-/Host-TCB-Evidenz ehrlich null lassen." });
  }
});

export type BlindEvaluationReleaseBinding = z.infer<typeof blindEvaluationReleaseBindingSchema>;

const blindEvaluationPublicationBindingSchema = z.object({
  schemaVersion: z.literal("ltx-studio-output-publication.v2"),
  authoritySha256: sha256Schema,
  publishedAt: timestampSchema,
  executionDecisionSha256: sha256Schema,
  jobPersistenceRevision: z.string().uuid(),
  jobAuthoritySha256: sha256Schema,
  outputSha256: sha256Schema,
  outputRevision: z.object({
    sizeBytes: positiveSizeSchema,
    modifiedAtMs: z.number().finite().nonnegative(),
    changedAtMs: z.number().finite().nonnegative(),
    fileId: fileIdSchema,
    deviceId: fileIdSchema,
    mode: nonnegativeIntegerSchema,
    uid: nonnegativeIntegerSchema,
    gid: nonnegativeIntegerSchema,
    nlink: z.literal(1),
  }).strict(),
}).strict();

export const blindEvaluationMediaBindingSchema = z.object({
  arm: armSchema,
  outputName: outputNameSchema.refine((value) => value.toLowerCase().endsWith(".mp4"), {
    message: "Blind Evidence v5 akzeptiert ausschließlich MP4-Quellen.",
  }),
  jobId: z.string().uuid(),
  requestSha256: sha256Schema,
  settingsSha256: sha256Schema,
  provenanceFingerprint: sha256Schema,
  sourceSha256: sha256Schema,
  analysisSha256: sha256Schema,
  settingsSidecarSha256: sha256Schema,
  analysisSidecarSha256: sha256Schema,
  publication: blindEvaluationPublicationBindingSchema,
  sourceRevision: fileRevisionSchema,
  durationSeconds: z.number().finite().positive().max(86_400),
  hasAudio: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.sourceSha256 !== value.sourceRevision.sha256) {
    context.addIssue({ code: "custom", path: ["sourceRevision", "sha256"], message: "Quellrevision und Quelldigest widersprechen sich." });
  }
  if (value.sourceSha256 !== value.publication.outputSha256) {
    context.addIssue({ code: "custom", path: ["publication", "outputSha256"], message: "Snapshot- und Publikationsdigest widersprechen sich." });
  }
});

export type BlindEvaluationMediaBinding = z.infer<typeof blindEvaluationMediaBindingSchema>;

const exactNormalizationArgsSchema = z.array(z.string()).length(
  BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE.length,
).superRefine((value, context) => {
  if (value.some((entry, index) => entry !== BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE[index])) {
    context.addIssue({ code: "custom", message: "Das FFmpeg-Argumenttemplate ist nicht das gebundene v5-Profil." });
  }
});

export const blindEvaluationNormalizationProfileSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-normalization-profile.v5"),
  contractKind: z.literal("requested-encoder-settings"),
  program: z.literal("ffmpeg"),
  argsTemplate: exactNormalizationArgsSchema,
  containerProfile: z.literal("h264-high51-aac-lc-isom-cbr-measured.v5"),
  fillerProfile: z.literal("iso-bmff-explicit-mdat-private-reconstruction.v2"),
  target: z.object({
    width: z.literal(BLIND_EVALUATION_CANONICAL_WIDTH),
    height: z.literal(BLIND_EVALUATION_CANONICAL_HEIGHT),
    framesPerSecond: z.literal(BLIND_EVALUATION_CANONICAL_FPS),
    frameCount: z.number().int().positive().max(2_500),
    durationSeconds: z.number().finite().positive().max(100),
    videoCodec: z.literal("h264"),
    videoProfile: z.literal("High"),
    videoLevel: z.literal(51),
    pixelFormat: z.literal("yuv420p"),
    sampleAspectRatio: z.literal("1:1"),
    displayAspectRatio: z.literal("1:1"),
    colorRange: z.literal("tv"),
    colorSpace: z.literal("bt709"),
    colorTransfer: z.literal("bt709"),
    colorPrimaries: z.literal("bt709"),
    rotation: z.literal("none"),
    gopSize: z.literal(50),
    keyFrameMinimum: z.literal(50),
    sceneCutThreshold: z.literal(0),
    bFrames: z.literal(2),
    referenceFrames: z.literal(3),
    videoBitRate: z.literal(BLIND_EVALUATION_VIDEO_BIT_RATE),
    audioCodec: z.literal("aac"),
    audioProfile: z.literal("LC"),
    audioSampleFormat: z.literal("fltp"),
    audioSampleRate: z.literal(BLIND_EVALUATION_AUDIO_SAMPLE_RATE),
    audioChannels: z.literal(2),
    audioBitRate: z.literal(BLIND_EVALUATION_AUDIO_BIT_RATE),
    majorBrand: z.literal("isom"),
    compatibleBrands: z.literal("isomiso2avc1mp41"),
    streamLanguage: z.literal("und"),
    defaultDisposition: z.literal(true),
    startTimeSeconds: z.literal(0),
    videoTrackTimescale: z.literal(90_000),
    audioTrackTimescale: z.literal(48_000),
  }).strict(),
}).strict();

export type BlindEvaluationNormalizationProfile = z.infer<typeof blindEvaluationNormalizationProfileSchema>;

const canonicalDispositionSchema = z.object({
  default: z.literal(1),
  dub: z.literal(0),
  original: z.literal(0),
  comment: z.literal(0),
  lyrics: z.literal(0),
  karaoke: z.literal(0),
  forced: z.literal(0),
  hearing_impaired: z.literal(0),
  visual_impaired: z.literal(0),
  clean_effects: z.literal(0),
  attached_pic: z.literal(0),
  timed_thumbnails: z.literal(0),
  non_diegetic: z.literal(0),
  captions: z.literal(0),
  descriptions: z.literal(0),
  metadata: z.literal(0),
  dependent: z.literal(0),
  still_image: z.literal(0),
}).strict();

/** Facts measured from the finished bytes; deliberately separate from requested encoder flags. */
export const blindEvaluationMeasuredMediaSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-measured-media.v5"),
  contractKind: z.literal("measured-finished-media"),
  streamsTotal: z.literal(2),
  streamTypes: z.tuple([z.literal("video"), z.literal("audio")]),
  formatTags: z.object({
    major_brand: z.literal("isom"),
    minor_version: z.literal("512"),
    compatible_brands: z.literal("isomiso2avc1mp41"),
  }).strict(),
  videoTags: z.object({
    language: z.literal("und"),
    handler_name: z.literal("VideoHandler"),
    vendor_id: z.literal("[0][0][0][0]"),
    encoder: z.literal("Lavc libx264"),
  }).strict(),
  audioTags: z.object({
    language: z.literal("und"),
    handler_name: z.literal("SoundHandler"),
    vendor_id: z.literal("[0][0][0][0]"),
  }).strict(),
  dispositions: z.object({
    video: canonicalDispositionSchema,
    audio: canonicalDispositionSchema,
  }).strict(),
  sideDataEntries: z.literal(0),
  topLevelBoxTypes: z.tuple([
    z.literal("ftyp"), z.literal("moov"), z.literal("free"), z.literal("mdat"),
  ]),
  videoKeyFramePositions: z.array(nonnegativeIntegerSchema).min(1).max(50),
  sps: z.object({
    maxNumRefFrames: z.literal(4),
    fixedFrameRate: z.literal(true),
    nalHrd: z.literal(true),
    cpbCount: z.literal(1),
    cbr: z.literal(true),
  }).strict(),
  nalUnitCounts: z.object({
    nonIdrSlice: nonnegativeIntegerSchema,
    idrSlice: nonnegativeIntegerSchema,
    sps: z.literal(1),
    pps: z.literal(1),
    filler: nonnegativeIntegerSchema,
    sei: z.literal(0),
  }).strict(),
  decodedVideoFrames: positiveSizeSchema,
  decodedAudioStreams: z.literal(1),
  ffprobeFingerprintSha256: sha256Schema,
  sampleTableResidualExcluded: z.literal(true),
}).strict();

export type BlindEvaluationMeasuredMedia = z.infer<typeof blindEvaluationMeasuredMediaSchema>;

export const blindEvaluationSnapshotBindingSchema = z.object({
  channel: channelSchema,
  sourceArm: armSchema,
  sourceBefore: fileRevisionSchema,
  sourceAfter: fileRevisionSchema,
  normalizedSha256: sha256Schema,
  normalizedSizeBytes: positiveSizeSchema,
  originalMdat: z.object({
    offsetBytes: nonnegativeIntegerSchema,
    sizeBytes: positiveSizeSchema,
    headerBytes: z.literal(8),
    sizeHeaderHex: z.string().regex(/^[0-9a-f]{8}$/),
  }).strict(),
  fillerProfile: z.literal("iso-bmff-explicit-mdat-private-reconstruction.v2"),
  finalSnapshotSha256: sha256Schema,
  finalRevision: fileRevisionSchema,
  mimeType: z.literal("video/mp4"),
  measured: blindEvaluationMeasuredMediaSchema,
}).strict().superRefine((value, context) => {
  if (canonicalBlindEvaluationJson(value.sourceBefore) !== canonicalBlindEvaluationJson(value.sourceAfter)) {
    context.addIssue({ code: "custom", path: ["sourceAfter"], message: "Quellrevision oder SHA änderten sich während der Normalisierung." });
  }
  if (value.finalRevision.sha256 !== value.finalSnapshotSha256) {
    context.addIssue({ code: "custom", path: ["finalRevision"], message: "Finale Snapshot-Revision widerspricht dem Snapshot-Digest." });
  }
  if (value.originalMdat.offsetBytes + value.originalMdat.sizeBytes !== value.normalizedSizeBytes) {
    context.addIssue({ code: "custom", path: ["originalMdat"], message: "Die private mdat-Rekonstruktionsbindung endet nicht am normalisierten EOF." });
  }
});

export type BlindEvaluationSnapshotBinding = z.infer<typeof blindEvaluationSnapshotBindingSchema>;

export const blindEvaluationCommitmentPreimageSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-commitment.v5"),
  sessionId: z.string().uuid(),
  experimentId: z.string().uuid(),
  protocolSha256: sha256Schema,
  claimScope: z.literal("development"),
  createdAt: timestampSchema,
  nonce: sha256Schema,
  evaluatorScopeCredentialSha256: sha256Schema,
  creationTokenSha256: sha256Schema,
  requirements: z.object({
    speeds: z.tuple([z.literal(1), z.literal(0.5)]),
    bothMediaRequired: z.literal(true),
    bothAudioRequired: z.literal(true),
    evidenceNature: z.literal("human-attestation"),
    transportProfile: z.literal("canonical-private-mp4.v5"),
    threatModel: z.literal(BLIND_EVALUATION_THREAT_MODEL),
    timelineCoverage: z.object({
      intervalUnit: z.literal("media-milliseconds"),
      normalMinimumRatio: z.literal(BLIND_EVALUATION_NORMAL_COVERAGE_RATIO),
      halfMinimumRatio: z.literal(BLIND_EVALUATION_HALF_COVERAGE_RATIO),
      audibleNormalMinimumRatio: z.literal(BLIND_EVALUATION_NORMAL_COVERAGE_RATIO),
      audibleHalfMinimumRatio: z.literal(BLIND_EVALUATION_HALF_COVERAGE_RATIO),
      endedRequired: z.literal(true),
      minimumReviewWallTimeSeconds: z.number().finite().positive().max(518_400),
    }).strict(),
  }).strict(),
  tools: z.object({
    ffmpeg: blindEvaluationToolBindingSchema,
    ffprobe: blindEvaluationToolBindingSchema,
  }).strict(),
  release: blindEvaluationReleaseBindingSchema,
  normalization: blindEvaluationNormalizationProfileSchema,
  arms: z.object({
    baseline: blindEvaluationMediaBindingSchema.safeExtend({ arm: z.literal("baseline") }).strict(),
    candidate: blindEvaluationMediaBindingSchema.safeExtend({ arm: z.literal("candidate") }).strict(),
  }).strict(),
  mapping: z.object({ x: armSchema, y: armSchema }).strict(),
  snapshots: z.object({
    x: blindEvaluationSnapshotBindingSchema.safeExtend({ channel: z.literal("x") }).strict(),
    y: blindEvaluationSnapshotBindingSchema.safeExtend({ channel: z.literal("y") }).strict(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (canonicalBlindEvaluationJson(value.requirements.timelineCoverage)
    !== canonicalBlindEvaluationJson(blindEvaluationTimelineRequirements(
      value.normalization.target.durationSeconds,
    ))) {
    context.addIssue({
      code: "custom",
      path: ["requirements", "timelineCoverage"],
      message: "Timeline-Coverage-Schwellen und Mindestwandzeit sind nicht an das kanonische Medium gebunden.",
    });
  }
  if (value.mapping.x === value.mapping.y) {
    context.addIssue({ code: "custom", path: ["mapping"], message: "X und Y müssen verschiedene Arme abbilden." });
  }
  for (const channel of ["x", "y"] as const) {
    const snapshot = value.snapshots[channel];
    const arm = value.mapping[channel];
    const source = value.arms[arm];
    if (snapshot.sourceArm !== arm) {
      context.addIssue({ code: "custom", path: ["snapshots", channel, "sourceArm"], message: "Snapshot und Mapping widersprechen sich." });
    }
    if (canonicalBlindEvaluationJson(snapshot.sourceBefore)
      !== canonicalBlindEvaluationJson(source.sourceRevision)) {
      context.addIssue({ code: "custom", path: ["snapshots", channel, "sourceBefore"], message: "Snapshot und gebundene Quellrevision widersprechen sich." });
    }
    const expectedKeys = Array.from(
      { length: Math.ceil(value.normalization.target.frameCount / value.normalization.target.gopSize) },
      (_, index) => index * value.normalization.target.gopSize,
    ).filter((position) => position < value.normalization.target.frameCount);
    const measured = snapshot.measured;
    if (canonicalBlindEvaluationJson(measured.videoKeyFramePositions)
      !== canonicalBlindEvaluationJson(expectedKeys)) {
      context.addIssue({ code: "custom", path: ["snapshots", channel, "measured", "videoKeyFramePositions"], message: "Gemessene Keyframepositionen verletzen den angeforderten GOP-Vertrag." });
    }
    if (measured.decodedVideoFrames !== value.normalization.target.frameCount
      || measured.nalUnitCounts.idrSlice !== expectedKeys.length
      || measured.nalUnitCounts.nonIdrSlice + measured.nalUnitCounts.idrSlice
        !== value.normalization.target.frameCount
      || measured.nalUnitCounts.filler !== value.normalization.target.frameCount) {
      context.addIssue({ code: "custom", path: ["snapshots", channel, "measured"], message: "Gemessene NAL-/Decodefakten sind nicht vollständig an die Zielbildzahl gebunden." });
    }
  }
});

export type BlindEvaluationCommitmentPreimage = z.infer<typeof blindEvaluationCommitmentPreimageSchema>;

export const blindEvaluationRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation.v5"),
  id: z.string().uuid(),
  creationRequestId: sha256Schema,
  commitment: sha256Schema,
  commitmentPreimage: blindEvaluationCommitmentPreimageSchema,
  privateState: z.object({
    sourceRevisions: z.object({
      baseline: blindEvaluationPrivateFileRevisionSchema,
      candidate: blindEvaluationPrivateFileRevisionSchema,
    }).strict(),
    snapshotRevisions: z.object({
      x: blindEvaluationPrivateFileRevisionSchema,
      y: blindEvaluationPrivateFileRevisionSchema,
    }).strict(),
    finalSizeBytes: positiveSizeSchema,
    lockNonce: sha256Schema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.id !== value.commitmentPreimage.sessionId) {
    context.addIssue({ code: "custom", path: ["id"], message: "Session-ID und Commitment-Preimage widersprechen sich." });
  }
  const withoutSize = (revision: BlindEvaluationPrivateFileRevision): BlindEvaluationFileRevision => ({
    sha256: revision.sha256,
    deviceId: revision.deviceId,
    modifiedAtMs: revision.modifiedAtMs,
    changedAtMs: revision.changedAtMs,
    fileId: revision.fileId,
    mode: revision.mode,
  });
  for (const arm of ["baseline", "candidate"] as const) {
    if (canonicalBlindEvaluationJson(value.commitmentPreimage.arms[arm].sourceRevision)
      !== canonicalBlindEvaluationJson(withoutSize(value.privateState.sourceRevisions[arm]))) {
      context.addIssue({ code: "custom", path: ["privateState", "sourceRevisions", arm], message: "Private und öffentliche Quellrevision widersprechen sich." });
    }
  }
  for (const channel of ["x", "y"] as const) {
    if (canonicalBlindEvaluationJson(value.commitmentPreimage.snapshots[channel].finalRevision)
      !== canonicalBlindEvaluationJson(withoutSize(value.privateState.snapshotRevisions[channel]))) {
      context.addIssue({ code: "custom", path: ["privateState", "snapshotRevisions", channel], message: "Private und öffentliche Snapshot-Revision widersprechen sich." });
    }
    if (value.privateState.snapshotRevisions[channel].sizeBytes !== value.privateState.finalSizeBytes) {
      context.addIssue({ code: "custom", path: ["privateState", "snapshotRevisions", channel, "sizeBytes"], message: "Snapshotgröße widerspricht dem privaten gemeinsamen Transportziel." });
    }
  }
});

export type BlindEvaluationRecord = z.infer<typeof blindEvaluationRecordSchema>;

export const blindEvaluationMediaAccessRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-media-access.v5"),
  sessionId: z.string().uuid(),
  commitment: sha256Schema,
  channel: channelSchema,
  accessedAt: timestampSchema,
}).strict();

export type BlindEvaluationMediaAccessRecord = z.infer<typeof blindEvaluationMediaAccessRecordSchema>;

export const blindEvaluationSubmissionPinSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-browser-submission-pin.v5"),
  sessionId: z.string().uuid(),
  commitment: sha256Schema,
  idempotencyKey: sha256Schema,
  initialPinSha256: sha256Schema,
  submissionInputSha256: sha256Schema,
  pinnedAt: timestampSchema,
}).strict();

export type BlindEvaluationSubmissionPin = z.infer<typeof blindEvaluationSubmissionPinSchema>;

export const blindEvaluationSubmissionPreimageSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-submission.v5"),
  sessionId: z.string().uuid(),
  commitment: sha256Schema,
  idempotencyKey: sha256Schema,
  submissionInputSha256: sha256Schema,
  initialPublicStateSha256: sha256Schema,
  browserSubmissionPin: blindEvaluationSubmissionPinSchema,
  mediaAccessedAt: z.object({ x: timestampSchema, y: timestampSchema }).strict(),
  submittedAt: timestampSchema,
  submission: blindEvaluationSubmissionInputSchema,
}).strict();

export type BlindEvaluationSubmissionPreimage = z.infer<typeof blindEvaluationSubmissionPreimageSchema>;

export const blindEvaluationSubmissionRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-submission-record.v5"),
  outcome: z.literal("submitted"),
  sessionId: z.string().uuid(),
  submissionSha256: sha256Schema,
  submissionPreimage: blindEvaluationSubmissionPreimageSchema,
}).strict();

export type BlindEvaluationSubmissionRecord = z.infer<typeof blindEvaluationSubmissionRecordSchema>;

export const blindEvaluationRevocationRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-revocation-record.v5"),
  outcome: z.literal("revoked"),
  sessionId: z.string().uuid(),
  commitment: sha256Schema,
  revokedAt: timestampSchema,
  reason: z.enum(["evaluator-abort", "creation-interrupted", "creation-failed", "unclaimed-restart"]),
}).strict();

export const blindEvaluationTerminalRecordSchema = z.discriminatedUnion("outcome", [
  blindEvaluationSubmissionRecordSchema,
  blindEvaluationRevocationRecordSchema,
]);

export type BlindEvaluationTerminalRecord = z.infer<typeof blindEvaluationTerminalRecordSchema>;

const blindEvaluationPublicBaseSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-public.v5"),
  id: z.string().uuid(),
  claimScope: z.literal("development"),
  createdAt: timestampSchema,
  commitment: sha256Schema,
  evaluatorScope: z.object({
    role: z.literal("blind-evaluator"),
    transport: z.literal("httponly-samesite-strict-session-cookie"),
  }).strict(),
  media: z.object({
    x: z.string().regex(/^\/api\/blind-evaluations\/[0-9a-f-]{36}\/media\/x$/i),
    y: z.string().regex(/^\/api\/blind-evaluations\/[0-9a-f-]{36}\/media\/y$/i),
  }).strict(),
  requirements: z.object({
    speeds: z.tuple([z.literal(1), z.literal(0.5)]),
    bothMediaRequired: z.literal(true),
    bothAudioRequired: z.literal(true),
    evidenceNature: z.literal("human-attestation"),
    transportProfile: z.literal("canonical-private-mp4.v5"),
    timelineCoverage: z.object({
      intervalUnit: z.literal("media-milliseconds"),
      normalMinimumRatio: z.literal(BLIND_EVALUATION_NORMAL_COVERAGE_RATIO),
      halfMinimumRatio: z.literal(BLIND_EVALUATION_HALF_COVERAGE_RATIO),
      audibleNormalMinimumRatio: z.literal(BLIND_EVALUATION_NORMAL_COVERAGE_RATIO),
      audibleHalfMinimumRatio: z.literal(BLIND_EVALUATION_HALF_COVERAGE_RATIO),
      endedRequired: z.literal(true),
      minimumReviewWallTimeSeconds: z.number().finite().positive().max(518_400),
    }).strict(),
  }).strict(),
  threatModel: z.literal(BLIND_EVALUATION_THREAT_MODEL),
  limitation: z.literal(BLIND_EVALUATION_LIMITATION),
}).strict();

export const blindEvaluationActivePublicSchema = blindEvaluationPublicBaseSchema.extend({
  status: z.literal("active"),
  reveal: z.null(),
}).strict();

export const blindEvaluationSubmittedPublicSchema = blindEvaluationPublicBaseSchema.extend({
  status: z.literal("submitted"),
  reveal: z.object({
    commitmentPreimage: blindEvaluationCommitmentPreimageSchema,
    submissionPreimage: blindEvaluationSubmissionPreimageSchema,
    submissionSha256: sha256Schema,
  }).strict(),
}).strict();

export const blindEvaluationCreatingPublicSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-public.v5"),
  id: z.string().uuid(),
  claimScope: z.literal("development"),
  createdAt: timestampSchema,
  commitment: z.null(),
  evaluatorScope: z.object({
    role: z.literal("blind-evaluator"),
    transport: z.literal("httponly-samesite-strict-session-cookie"),
  }).strict(),
  creation: z.object({
    phase: z.enum(["reserved", "claimed"]),
    claimPath: z.string().regex(/^\/api\/blind-evaluations\/[0-9a-f-]{36}\/claim$/i),
  }).strict(),
  status: z.literal("creating"),
  reveal: z.null(),
  threatModel: z.literal(BLIND_EVALUATION_THREAT_MODEL),
  limitation: z.literal(BLIND_EVALUATION_LIMITATION),
}).strict();

export const blindEvaluationPublicSchema = z.discriminatedUnion("status", [
  blindEvaluationCreatingPublicSchema,
  blindEvaluationActivePublicSchema,
  blindEvaluationSubmittedPublicSchema,
]);

export type BlindEvaluationPublic = z.infer<typeof blindEvaluationPublicSchema>;
export type BlindEvaluationCreatingPublic = z.infer<typeof blindEvaluationCreatingPublicSchema>;
export type BlindEvaluationActivePublic = z.infer<typeof blindEvaluationActivePublicSchema>;
export type BlindEvaluationSubmittedPublic = z.infer<typeof blindEvaluationSubmittedPublicSchema>;

export const blindEvaluationInitialPinSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-initial-pin.v5"),
  id: z.string().uuid(),
  commitment: sha256Schema,
  publicStateSha256: sha256Schema,
}).strict();

export type BlindEvaluationInitialPin = z.infer<typeof blindEvaluationInitialPinSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalBlindEvaluationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function blindEvaluationInitialPinSha256(
  value: BlindEvaluationInitialPin,
): Promise<string> {
  return sha256Hex(canonicalBlindEvaluationJson(blindEvaluationInitialPinSchema.parse(value)));
}

export async function blindEvaluationSubmissionInputSha256(
  submissionValue: BlindEvaluationSubmissionInput,
  initialPinValue: BlindEvaluationInitialPin,
): Promise<string> {
  const submission = blindEvaluationSubmissionInputSchema.parse(submissionValue);
  const initialPin = blindEvaluationInitialPinSchema.parse(initialPinValue);
  return sha256Hex(canonicalBlindEvaluationJson({ submission, initialPin }));
}

export async function createBlindEvaluationSubmissionPin(
  submissionValue: BlindEvaluationSubmissionInput,
  initialPinValue: BlindEvaluationInitialPin,
  idempotencyKey: string,
  pinnedAt = new Date().toISOString(),
): Promise<BlindEvaluationSubmissionPin> {
  const initialPin = blindEvaluationInitialPinSchema.parse(initialPinValue);
  return blindEvaluationSubmissionPinSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-browser-submission-pin.v5",
    sessionId: initialPin.id,
    commitment: initialPin.commitment,
    idempotencyKey,
    initialPinSha256: await blindEvaluationInitialPinSha256(initialPin),
    submissionInputSha256: await blindEvaluationSubmissionInputSha256(submissionValue, initialPin),
    pinnedAt,
  });
}

export function blindEvaluationInitialPublicState(value: BlindEvaluationPublic): BlindEvaluationActivePublic {
  const parsed = blindEvaluationPublicSchema.parse(value);
  if (parsed.status === "creating") {
    throw new Error("Eine v5-Reservation darf erst nach dem durable Publish gepinnt werden.");
  }
  return blindEvaluationActivePublicSchema.parse({
    schemaVersion: parsed.schemaVersion,
    id: parsed.id,
    claimScope: parsed.claimScope,
    createdAt: parsed.createdAt,
    commitment: parsed.commitment,
    evaluatorScope: parsed.evaluatorScope,
    media: parsed.media,
    requirements: parsed.requirements,
    threatModel: parsed.threatModel,
    limitation: parsed.limitation,
    status: "active",
    reveal: null,
  });
}

export async function blindEvaluationPublicStateSha256(value: BlindEvaluationPublic): Promise<string> {
  return sha256Hex(canonicalBlindEvaluationJson(blindEvaluationInitialPublicState(value)));
}

export type BlindEvaluationVerification = {
  valid: boolean;
  commitmentRecomputed: string | null;
  submissionSha256Recomputed: string | null;
  publicStateSha256Recomputed: string | null;
  errors: string[];
};

/** Verifies both the reveal and the immutable public pin captured before navigation. */
export async function verifyBlindEvaluationReveal(
  value: unknown,
  initialPinValue: unknown,
  submissionPinValue?: unknown,
): Promise<BlindEvaluationVerification> {
  const parsed = blindEvaluationSubmittedPublicSchema.safeParse(value);
  const pinParsed = blindEvaluationInitialPinSchema.safeParse(initialPinValue);
  const submissionPinParsed = blindEvaluationSubmissionPinSchema.safeParse(submissionPinValue);
  if (!parsed.success || !pinParsed.success || !submissionPinParsed.success) {
    return {
      valid: false,
      commitmentRecomputed: null,
      submissionSha256Recomputed: null,
      publicStateSha256Recomputed: null,
      errors: ["Reveal, initialer Browser-Pin oder dauerhafter Submission-Pin ist unvollständig oder strukturell ungültig."],
    };
  }
  try {
    const evaluation = parsed.data;
    const pin = pinParsed.data;
    const submissionPin = submissionPinParsed.data;
    const commitmentRecomputed = await sha256Hex(canonicalBlindEvaluationJson(evaluation.reveal.commitmentPreimage));
    const submissionSha256Recomputed = await sha256Hex(canonicalBlindEvaluationJson(evaluation.reveal.submissionPreimage));
    const publicStateSha256Recomputed = await blindEvaluationPublicStateSha256(evaluation);
    const initialPinSha256Recomputed = await blindEvaluationInitialPinSha256(pin);
    const submissionInputSha256Recomputed = await blindEvaluationSubmissionInputSha256(
      evaluation.reveal.submissionPreimage.submission,
      pin,
    );
    const errors: string[] = [];
    if (evaluation.id !== pin.id || evaluation.commitment !== pin.commitment
      || publicStateSha256Recomputed !== pin.publicStateSha256) {
      errors.push("Die Reveal-Antwort stimmt nicht mit dem vor Navigation fixierten Browser-Pin überein.");
    }
    if (evaluation.id !== evaluation.reveal.commitmentPreimage.sessionId) {
      errors.push("Die öffentliche Session-ID stimmt nicht mit dem Commitment-Preimage überein.");
    }
    if (evaluation.createdAt !== evaluation.reveal.commitmentPreimage.createdAt
      || evaluation.threatModel !== evaluation.reveal.commitmentPreimage.requirements.threatModel
      || canonicalBlindEvaluationJson(evaluation.requirements)
        !== canonicalBlindEvaluationJson({
          speeds: evaluation.reveal.commitmentPreimage.requirements.speeds,
          bothMediaRequired: evaluation.reveal.commitmentPreimage.requirements.bothMediaRequired,
          bothAudioRequired: evaluation.reveal.commitmentPreimage.requirements.bothAudioRequired,
          evidenceNature: evaluation.reveal.commitmentPreimage.requirements.evidenceNature,
          transportProfile: evaluation.reveal.commitmentPreimage.requirements.transportProfile,
          timelineCoverage: evaluation.reveal.commitmentPreimage.requirements.timelineCoverage,
        })) {
      errors.push("Die öffentlichen stabilen Sessionfelder stimmen nicht mit dem Commitment-Preimage überein.");
    }
    if (evaluation.media.x !== `/api/blind-evaluations/${evaluation.id}/media/x`
      || evaluation.media.y !== `/api/blind-evaluations/${evaluation.id}/media/y`) {
      errors.push("Die Medienendpunkte sind nicht an die aufgedeckte Session-ID gebunden.");
    }
    if (evaluation.commitment !== commitmentRecomputed) {
      errors.push("Das Commitment stimmt nicht mit dem vollständigen Reveal-Preimage überein.");
    }
    if (evaluation.reveal.submissionPreimage.sessionId !== evaluation.id
      || evaluation.reveal.submissionPreimage.commitment !== evaluation.commitment
      || evaluation.reveal.submissionPreimage.initialPublicStateSha256 !== pin.publicStateSha256) {
      errors.push("Die Submission ist nicht an Session, Commitment und initialen Browser-Pin gebunden.");
    }
    if (submissionPin.sessionId !== evaluation.id
      || submissionPin.commitment !== evaluation.commitment
      || submissionPin.initialPinSha256 !== initialPinSha256Recomputed
      || submissionPin.submissionInputSha256 !== submissionInputSha256Recomputed
      || evaluation.reveal.submissionPreimage.submissionInputSha256 !== submissionInputSha256Recomputed
      || evaluation.reveal.submissionPreimage.idempotencyKey !== submissionPin.idempotencyKey
      || canonicalBlindEvaluationJson(evaluation.reveal.submissionPreimage.browserSubmissionPin)
        !== canonicalBlindEvaluationJson(submissionPin)) {
      errors.push("Submission-Eingabe, Idempotency-Key oder dauerhafter Browser-Submission-Pin wurden nach dem Pin verändert.");
    }
    const createdAtMs = Date.parse(evaluation.createdAt);
    const accessedXMs = Date.parse(evaluation.reveal.submissionPreimage.mediaAccessedAt.x);
    const accessedYMs = Date.parse(evaluation.reveal.submissionPreimage.mediaAccessedAt.y);
    const pinnedAtMs = Date.parse(submissionPin.pinnedAt);
    const submittedAtMs = Date.parse(evaluation.reveal.submissionPreimage.submittedAt);
    if (![createdAtMs, accessedXMs, accessedYMs, pinnedAtMs, submittedAtMs].every(Number.isFinite)
      || accessedXMs < createdAtMs || accessedYMs < createdAtMs
      || pinnedAtMs < Math.max(accessedXMs, accessedYMs)
      || submittedAtMs < pinnedAtMs) {
      errors.push("Creation, Medienzugriffe, dauerhafter Submission-Pin und serverseitiger Submit besitzen keine gültige Zeitrelation.");
    }
    const minimumReviewWallTimeMs = evaluation.reveal.commitmentPreimage.requirements
      .timelineCoverage.minimumReviewWallTimeSeconds * 1_000;
    if (Number.isFinite(submittedAtMs) && Number.isFinite(accessedXMs) && Number.isFinite(accessedYMs)
      && submittedAtMs - Math.max(accessedXMs, accessedYMs) + 1e-6 < minimumReviewWallTimeMs) {
      errors.push("Die aufgedeckte Abgabe unterschreitet die im Commitment gebundene Mindestprüfzeit.");
    }
    if (evaluation.reveal.submissionSha256 !== submissionSha256Recomputed) {
      errors.push("Der Submission-Digest stimmt nicht mit dem vollständigen Submission-Preimage überein.");
    }
    return {
      valid: errors.length === 0,
      commitmentRecomputed,
      submissionSha256Recomputed,
      publicStateSha256Recomputed,
      errors,
    };
  } catch {
    return {
      valid: false,
      commitmentRecomputed: null,
      submissionSha256Recomputed: null,
      publicStateSha256Recomputed: null,
      errors: ["Reveal und Browser-Pin konnten kryptografisch nicht nachgerechnet werden."],
    };
  }
}
