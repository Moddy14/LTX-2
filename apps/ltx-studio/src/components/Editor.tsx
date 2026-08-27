import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Cpu,
  Dices,
  FileVideo,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import { a2vTimelineMatchesInput, effectiveA2vTimeline } from "../../shared/a2vDuration";
import type { ResourceEstimate } from "../../shared/estimates";
import {
  dfrOutputGeometry,
  dfrSettings,
  hasDuplicateDfrDetailingLora,
  hasDialogueIntent,
  isAudioConditionedMode,
  isLegacyDfrRequest,
  needsGemmaAbliteratedLoraForRequest,
  PIPELINES,
  supportsGemmaAbliteratedLoraForRequest,
  usesOfficialComfyLipDub,
  type GenerationRequest,
} from "../../shared/pipelines";
import {
  documentedLtx23DistilledLoraAssetId,
  requiredOfficialSpeechAssetIds,
  withDiscoveredModelDefaults,
  withOfficialSpeechModelPaths,
} from "../../shared/models";
import type { LipDubReferenceDiagnostics, PreparedLipDubReference } from "../../shared/plan";
import {
  DFR_RESOLUTION_PRESETS,
  DURATION_PRESETS,
  formatDuration,
  framesForDuration,
  matchingDurationPreset,
  matchingDfrResolutionPreset,
  matchingResolutionPreset,
  RESOLUTION_PRESETS,
  videoDurationSeconds,
} from "../../shared/presets";
import {
  inspectLipDubReference as inspectLipDubReferenceAsset,
  prepareLipDubReference as prepareLipDubReferenceAsset,
} from "../api";
import { showsLipSyncControls } from "../editorSections";
import { fieldHelp } from "../fieldHelp";
import type { ModelInventory, ModelInventoryItem, UploadedFile } from "../types";
import { ImageRows, LoraRows, SingleMediaInput, UploadButton } from "./AssetRows";
import { AssetLibrary } from "./AssetLibrary";
import { Field, NumberField, PathPicker, SectionHeader, Segmented, SelectField, TextField, Toggle, type PathOption } from "./Controls";

type EditorProps = {
  request: GenerationRequest;
  resourceEstimate: ResourceEstimate;
  onChange: (request: GenerationRequest) => void;
  errors: Record<string, string>;
  previews: Record<string, string>;
  onPreview: (path: string, url: string) => void;
  onPreparedLipDubReference: (prepared: PreparedLipDubReference, sourcePath: string) => boolean;
  onComposePrompt: () => void;
  promptComposeError: string | null;
  modelInventory: ModelInventory | null;
  canUndoPrompt: boolean;
  onUndoPrompt: () => void;
};

function formatModelSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function modelOptions(items: readonly ModelInventoryItem[], kind: ModelInventoryItem["kind"]): PathOption[] {
  return items
    .filter((item) => item.kind === kind)
    .map((item) => ({
      path: item.path,
      label: `${item.name} · ${formatModelSize(item.sizeBytes)}${item.precision === "unknown" ? "" : ` · ${item.precision.toUpperCase()}`}`,
    }));
}

const PROMPT_PART_FIELDS: ReadonlyArray<{
  key: keyof GenerationRequest["promptParts"];
  label: string;
  hint: string;
  placeholder: string;
}> = [
  { key: "subject", label: "Motiv", hint: fieldHelp.promptSubject, placeholder: "Person, Produkt, Tier oder Objekt..." },
  { key: "action", label: "Handlung", hint: fieldHelp.promptAction, placeholder: "Was geschieht und wie bewegt es sich?" },
  { key: "environment", label: "Umgebung", hint: fieldHelp.promptEnvironment, placeholder: "Ort, Zeit, Wetter und Hintergrund..." },
  { key: "camera", label: "Kamera", hint: fieldHelp.promptCamera, placeholder: "Einstellung, Objektiv und Kamerabewegung..." },
  { key: "lighting", label: "Licht und Look", hint: fieldHelp.promptLighting, placeholder: "Lichtquelle, Kontrast, Farben und Material..." },
  { key: "ambience", label: "Geräusche", hint: fieldHelp.promptAmbience, placeholder: "Raumklang und konkrete Umgebungsgeräusche..." },
  { key: "music", label: "Musik", hint: fieldHelp.promptMusic, placeholder: "Stil, Tempo, Instrumente oder ausdrücklich keine Musik..." },
];

function updateGuidance(
  request: GenerationRequest,
  key: "videoGuidance" | "audioGuidance",
  field: keyof GenerationRequest["videoGuidance"],
  value: number | number[],
): GenerationRequest {
  return { ...request, [key]: { ...request[key], [field]: value } };
}

function LatentSyncControls({
  request,
  onChange,
  errors,
}: Pick<EditorProps, "request" | "onChange" | "errors">) {
  return (
    <>
      <Toggle
        label="LatentSync 1.6 Qualitätsrefiner"
        hint={fieldHelp.latentSync}
        checked={request.postprocess.latentSync.enabled}
        onChange={(enabled) => onChange({
          ...request,
          postprocess: {
            ...request.postprocess,
            latentSync: { ...request.postprocess.latentSync, enabled },
            longcatLipsync: {
              ...request.postprocess.longcatLipsync,
              enabled: enabled ? false : request.postprocess.longcatLipsync.enabled,
            },
            museTalk: {
              ...request.postprocess.museTalk,
              enabled: enabled ? false : request.postprocess.museTalk.enabled,
            },
            lipForcing: {
              ...request.postprocess.lipForcing,
              enabled: enabled ? false : request.postprocess.lipForcing.enabled,
            },
          },
        })}
      />
      {request.postprocess.latentSync.enabled ? (
        <div className="field-grid field-grid--2">
          <NumberField
            label="LatentSync-Schritte"
            hint={fieldHelp.latentSyncSteps}
            min={20}
            max={50}
            step={1}
            value={request.postprocess.latentSync.steps}
            error={errors["postprocess.latentSync.steps"]}
            onChange={(steps) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                latentSync: { ...request.postprocess.latentSync, steps: steps ?? 30 },
              },
            })}
          />
          <NumberField
            label="LatentSync-Audioführung"
            hint={fieldHelp.latentSyncGuidance}
            min={1}
            max={3}
            step={0.1}
            value={request.postprocess.latentSync.guidance}
            error={errors["postprocess.latentSync.guidance"]}
            onChange={(guidance) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                latentSync: { ...request.postprocess.latentSync, guidance: guidance ?? 2 },
              },
            })}
          />
        </div>
      ) : null}
    </>
  );
}

function MuseTalkControls({
  request,
  onChange,
  errors,
}: Pick<EditorProps, "request" | "onChange" | "errors">) {
  return (
    <>
      <Toggle
        label="MuseTalk 1.5 Lippen-Inpainting"
        hint={fieldHelp.museTalk}
        checked={request.postprocess.museTalk.enabled}
        onChange={(enabled) => onChange({
          ...request,
          postprocess: {
            ...request.postprocess,
            museTalk: { ...request.postprocess.museTalk, enabled },
            longcatLipsync: {
              ...request.postprocess.longcatLipsync,
              enabled: enabled ? false : request.postprocess.longcatLipsync.enabled,
            },
            latentSync: {
              ...request.postprocess.latentSync,
              enabled: enabled ? false : request.postprocess.latentSync.enabled,
            },
            lipForcing: {
              ...request.postprocess.lipForcing,
              enabled: enabled ? false : request.postprocess.lipForcing.enabled,
            },
          },
        })}
      />
      {request.postprocess.museTalk.enabled ? (
        <div className="field-grid field-grid--2">
          <NumberField
            label="Kinn-Zugabe"
            hint={fieldHelp.museTalkExtraMargin}
            min={0}
            max={80}
            step={1}
            value={request.postprocess.museTalk.extraMargin}
            error={errors["postprocess.museTalk.extraMargin"]}
            onChange={(extraMargin) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                museTalk: { ...request.postprocess.museTalk, extraMargin: extraMargin ?? 10 },
              },
            })}
          />
          <NumberField
            label="Wangen-Schutzbreite"
            hint={fieldHelp.museTalkCheekWidth}
            min={20}
            max={200}
            step={1}
            value={request.postprocess.museTalk.cheekWidth}
            error={errors["postprocess.museTalk.cheekWidth"]}
            onChange={(cheekWidth) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                museTalk: { ...request.postprocess.museTalk, cheekWidth: cheekWidth ?? 90 },
              },
            })}
          />
          <NumberField
            label="Audio-Kontext davor"
            hint={fieldHelp.museTalkAudioPaddingLeft}
            min={0}
            max={12}
            step={1}
            value={request.postprocess.museTalk.audioPaddingLeft}
            error={errors["postprocess.museTalk.audioPaddingLeft"]}
            onChange={(audioPaddingLeft) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                museTalk: { ...request.postprocess.museTalk, audioPaddingLeft: audioPaddingLeft ?? 2 },
              },
            })}
          />
          <NumberField
            label="Audio-Kontext danach"
            hint={fieldHelp.museTalkAudioPaddingRight}
            min={0}
            max={12}
            step={1}
            value={request.postprocess.museTalk.audioPaddingRight}
            error={errors["postprocess.museTalk.audioPaddingRight"]}
            onChange={(audioPaddingRight) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                museTalk: { ...request.postprocess.museTalk, audioPaddingRight: audioPaddingRight ?? 2 },
              },
            })}
          />
        </div>
      ) : null}
    </>
  );
}

function LipForcingControls({
  request,
  onChange,
  errors,
}: Pick<EditorProps, "request" | "onChange" | "errors">) {
  return (
    <>
      <Toggle
        label="LipForcing 14B Lippenrefiner"
        hint={fieldHelp.lipForcing}
        checked={request.postprocess.lipForcing.enabled}
        onChange={(enabled) => onChange({
          ...request,
          postprocess: {
            ...request.postprocess,
            lipForcing: { ...request.postprocess.lipForcing, enabled },
            longcatLipsync: {
              ...request.postprocess.longcatLipsync,
              enabled: enabled ? false : request.postprocess.longcatLipsync.enabled,
            },
            latentSync: {
              ...request.postprocess.latentSync,
              enabled: enabled ? false : request.postprocess.latentSync.enabled,
            },
            museTalk: {
              ...request.postprocess.museTalk,
              enabled: enabled ? false : request.postprocess.museTalk.enabled,
            },
          },
        })}
      />
      {request.postprocess.lipForcing.enabled ? (
        <div className="field-grid field-grid--2">
          <Segmented
            label="LipForcing-Decoder"
            hint={fieldHelp.lipForcingDecoder}
            value={request.postprocess.lipForcing.decoder}
            options={[
              { value: "wan-vae", label: "Maximale Qualität" },
              { value: "streaming-taehv", label: "Schneller Test" },
            ]}
            onChange={(decoder) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                lipForcing: { ...request.postprocess.lipForcing, decoder },
              },
            })}
          />
          <NumberField
            label="Modell-Steuerung (ms)"
            hint={fieldHelp.lipForcingMouthDelay}
            min={-500}
            max={500}
            step={1}
            value={request.postprocess.lipForcing.mouthDelayMs}
            error={errors["postprocess.lipForcing.mouthDelayMs"]}
            onChange={(mouthDelayMs) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                lipForcing: { ...request.postprocess.lipForcing, mouthDelayMs: mouthDelayMs ?? 0 },
              },
            })}
          />
          <NumberField
            label="Hörbarer Tonversatz (ms)"
            hint={fieldHelp.lipForcingProgramAudioDelay}
            min={-500}
            max={500}
            step={1}
            value={request.postprocess.lipForcing.programAudioDelayMs}
            error={errors["postprocess.lipForcing.programAudioDelayMs"]}
            onChange={(programAudioDelayMs) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                lipForcing: {
                  ...request.postprocess.lipForcing,
                  programAudioDelayMs: programAudioDelayMs ?? 0,
                },
              },
            })}
          />
        </div>
      ) : null}
    </>
  );
}

export function Editor({
  request,
  resourceEstimate,
  onChange,
  errors,
  previews,
  onPreview,
  onPreparedLipDubReference,
  onComposePrompt,
  promptComposeError,
  modelInventory,
  canUndoPrompt,
  onUndoPrompt,
}: EditorProps) {
  const [lipDubPrepBusy, setLipDubPrepBusy] = useState(false);
  const [lipDubPrepError, setLipDubPrepError] = useState<string | null>(null);
  const [lipDubPrepResult, setLipDubPrepResult] = useState<string | null>(null);
  const [lipDubDiagnostics, setLipDubDiagnostics] = useState<LipDubReferenceDiagnostics | null>(null);
  const [lipDubDiagnosticsBusy, setLipDubDiagnosticsBusy] = useState(false);
  const [lipDubDiagnosticsError, setLipDubDiagnosticsError] = useState<string | null>(null);
  const [lipDubTrimEnabled, setLipDubTrimEnabled] = useState(true);
  const [lipDubTrimStart, setLipDubTrimStart] = useState(0);
  const [lipDubTrimDuration, setLipDubTrimDuration] = useState(4.2);
  const definition = PIPELINES.find((pipeline) => pipeline.id === request.mode) ?? PIPELINES[0];
  const isLipDub = request.mode === "lipdub";
  const isDfr = request.mode === "dfr";
  const isLegacyDfr = isLegacyDfrRequest(request);
  const dfr = dfrSettings(request);
  const dfrOutput = isDfr ? dfrOutputGeometry(request) : null;
  const officialComfyLipDub = usesOfficialComfyLipDub(request);
  const isIdLora = request.mode === "id-lora";
  const isAudioToVideo = isAudioConditionedMode(request.mode);
  const isTextToAudio = request.mode === "text-to-audio";
  const guided = [
    "two-stage-hq",
    "one-stage",
    "audio-to-video",
    "text-to-audio",
    "retake",
  ].includes(
    request.mode,
  ) && !(request.mode === "retake" && request.retake.distilled);
  const supportsSteps = ![
    "two-stage",
    "distilled",
    "dfr",
    "ic-lora",
    "id-lora",
    "keyframes",
    "image-audio-to-video",
    "lipdub",
    "text-to-audio",
  ].includes(request.mode)
    && !(request.mode === "retake" && request.retake.distilled);
  const sourceSelectable = ["two-stage", "two-stage-hq", "one-stage", "distilled", "dfr"].includes(request.mode);
  const imageEnabled = request.mode !== "retake"
    && !isLipDub
    && !isTextToAudio
    && !(request.mode === "ic-lora"
      && ["pixel-upscaler", "v2v-deblur", "v2v-instant-shave", "inpainting", "outpainting", "hdr"].includes(
        request.icLora.profile,
      ))
    && (!sourceSelectable || request.sourceMode === "image");
  const visibleTextIntent = /\b(text|schrift|logo|label|etikett|titel|wort|zeichen)\b/i.test(request.prompt);
  const dialogueIntent = hasDialogueIntent(request);
  const resolutionPreset = isDfr
    ? matchingDfrResolutionPreset(request.width, request.height)
    : matchingResolutionPreset(request.width, request.height);
  const resolutionPresets = isDfr
    ? [...RESOLUTION_PRESETS, ...DFR_RESOLUTION_PRESETS]
    : RESOLUTION_PRESETS;
  const localA2vTimeline = effectiveA2vTimeline(request);
  const a2vTimeline = resourceEstimate.a2vTimeline
    && a2vTimelineMatchesInput(resourceEstimate.a2vTimeline, request)
    ? resourceEstimate.a2vTimeline
    : localA2vTimeline;
  const audioDerivesFrames = a2vTimeline?.derivesFramesFromAudio ?? false;
  const durationPreset = audioDerivesFrames
    ? null
    : matchingDurationPreset(request.numFrames, request.frameRate);
  const duration = a2vTimeline?.durationSeconds
    ?? videoDurationSeconds(request.numFrames, request.frameRate);
  const conservativeDuration = localA2vTimeline?.upperBoundDurationSeconds
    ?? videoDurationSeconds(request.numFrames, request.frameRate);
  const displayedFrames = a2vTimeline?.frameCount ?? request.numFrames;
  const a2vSummaryBasis = a2vTimeline?.basis === "audio-eof"
    ? "durch EOF nach dem Audio-Start gekürzt"
    : a2vTimeline?.basis === "audio-cap"
      ? "aus der gesetzten Maximaldauer"
      : a2vTimeline?.basis === "audio-cap-upper-bound"
        ? "Obergrenze aus Maximaldauer; EOF nach Audio-Start wird serverseitig geprüft"
        : "aus der expliziten Framezahl";
  const discoveredModels = modelInventory?.items ?? [];
  const checkpointOptions = modelOptions(discoveredModels, "checkpoint");
  const distilledCheckpointOptions = modelOptions(discoveredModels, "distilled-checkpoint");
  const gemmaOptions = modelOptions(discoveredModels, "gemma");
  const upscalerOptions = modelOptions(discoveredModels, "spatial-upscaler");
  const temporalUpscalerOptions = modelOptions(discoveredModels, "temporal-upscaler");
  const transformerOptions = modelOptions(discoveredModels, "transformer");
  const textEncoderOptions = modelOptions(discoveredModels, "text-encoder");
  const videoVaeOptions = modelOptions(discoveredModels, "video-vae");
  const audioVaeOptions = modelOptions(discoveredModels, "audio-vae");
  const durationHeadOptions = modelOptions(discoveredModels, "duration-head");
  const dfrTransformerRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx25-transformer-bf16",
  );
  const dfrTemporalUpscalerRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx25-temporal-upscaler-bf16",
  );
  const dfrDetailingLoraRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx25-dfr-detailing-lora",
  );
  const ltx25UpscalerOptions = upscalerOptions.filter((option) =>
    option.path.endsWith("ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"));
  const loraOptions = modelOptions(discoveredModels, "lora");
  const userLoraOptions = isDfr
    ? loraOptions.filter((option) => {
        const filename = option.path.replaceAll("\\", "/").split("/").at(-1);
        return filename !== "ltx-2.5-22b-distilled-lora-450-bf16.safetensors"
          && filename !== "ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors";
      })
    : loraOptions;
  const geometryOptions = modelOptions(discoveredModels, "geometry");
  const lipDubRecommendation = modelInventory?.recommendations.find((item) => item.id === "lipdub-lora");
  const lipDubDistilledRecommendation = modelInventory?.recommendations.find((item) => item.id === "lipdub-distilled-checkpoint");
  const lipDubUpscalerRecommendation = modelInventory?.recommendations.find((item) => item.id === "lipdub-spatial-upscaler");
  const ltx23DevRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-dev-checkpoint");
  const ltx23GemmaRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-gemma");
  const ltx23DistilledLoraRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-distilled-lora");
  const documentedDistilledLoraRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === documentedLtx23DistilledLoraAssetId(request),
  );
  const isLtx25Split = request.models.layout === "split"
    && request.models.generation === "2.5";
  const qualityLabel = request.mode === "distilled" && request.distilled.singleStage
    ? isLtx25Split ? "Offiziell · 8 · Preview" : "Legacy · Single-Stage"
    : definition.quality;
  const ltx23UpscalerRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-spatial-upscaler");
  const unionControlRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-union-control-lora",
  );
  const ingredientsRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-ingredients-lora",
  );
  const motionTrackRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-motion-track-lora",
  );
  const pixelUpscalerRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-pixel-upscaler-x4-lora",
  );
  const instantShaveRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-instant-shave-lora",
  );
  const deblurRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-deblur-lora",
  );
  const inOutpaintRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-inoutpaint-lora",
  );
  const hdrRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-hdr-lora",
  );
  const hdrEmbeddingsRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-hdr-scene-embeddings",
  );
  const icLoraUi = request.icLora.profile === "ingredients"
    ? {
        label: "Ingredients IC-LoRA",
        strengthLabel: "Ingredients-Stärke",
        hint: fieldHelp.ingredientsLora,
        strengthHint: fieldHelp.ingredientsStrength,
        recommendation: ingredientsRecommendation,
        placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
      }
    : request.icLora.profile === "hdr"
      ? {
          label: "HDR IC-LoRA",
          strengthLabel: "HDR-Stärke",
          hint: fieldHelp.hdrLora,
          strengthHint: fieldHelp.hdrStrength,
          recommendation: hdrRecommendation,
          placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-hdr-0.9.safetensors",
        }
      : request.icLora.profile === "motion-track"
      ? {
          label: "Motion-Track IC-LoRA",
          strengthLabel: "Motion-Track-Stärke",
          hint: fieldHelp.motionTrackLora,
          strengthHint: fieldHelp.motionTrackStrength,
          recommendation: motionTrackRecommendation,
          placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors",
        }
      : request.icLora.profile === "pixel-upscaler"
        ? {
            label: "Pixel Spatial Upscaler x4 IC-LoRA",
            strengthLabel: "Upscaler-Stärke",
            hint: fieldHelp.pixelUpscalerLora,
            strengthHint: fieldHelp.pixelUpscalerStrength,
            recommendation: pixelUpscalerRecommendation,
            placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x4-0.9.safetensors",
          }
        : request.icLora.profile === "v2v-deblur"
          ? {
              label: "Deblur V2V IC-LoRA (LTX-2.5)",
              strengthLabel: "Deblur-Stärke",
              hint: fieldHelp.deblurLora,
              strengthHint: fieldHelp.deblurStrength,
              recommendation: deblurRecommendation,
              placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-deblur-0.9.safetensors",
            }
        : request.icLora.profile === "v2v-instant-shave"
          ? {
              label: "Instant-Shave V2V IC-LoRA",
              strengthLabel: "V2V-Stärke",
              hint: fieldHelp.instantShaveLora,
              strengthHint: fieldHelp.instantShaveStrength,
              recommendation: instantShaveRecommendation,
              placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-instant-shave-0.9.safetensors",
            }
          : ["inpainting", "outpainting"].includes(request.icLora.profile)
            ? {
                label: "In-/Outpainting IC-LoRA",
                strengthLabel: "In-/Outpainting-Stärke",
                hint: fieldHelp.inOutpaintLora,
                strengthHint: fieldHelp.inOutpaintStrength,
                recommendation: inOutpaintRecommendation,
                placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
              }
          : {
              label: "Union-Control IC-LoRA",
              strengthLabel: "Union-Control-Stärke",
              hint: fieldHelp.unionControlLora,
              strengthHint: fieldHelp.unionControlStrength,
              recommendation: unionControlRecommendation,
              placeholder: "/absoluter/pfad/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
            };
  const idLoraRecommendation = modelInventory?.recommendations.find(
    (item) => item.id === "ltx23-id-lora-talkvid",
  );
  const mogeRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-moge");
  const requiredLtx25Assets = request.models.layout === "split" && modelInventory
    ? requiredOfficialSpeechAssetIds(request)
        .filter((id) => id.startsWith("ltx25-"))
        .flatMap((id) => {
          const asset = modelInventory.recommendations.find((item) => item.id === id);
          return asset ? [asset] : [];
        })
    : [];
  const missingLtx25Assets = requiredLtx25Assets.filter((asset) => !asset.present);
  const a2vRecommendations = [
    ltx23DevRecommendation,
    ltx23GemmaRecommendation,
    documentedDistilledLoraRecommendation,
    ltx23UpscalerRecommendation,
  ];
  const legacyA2v = isAudioToVideo && request.models.layout === "monolith";
  const a2vMissingAssets = legacyA2v && modelInventory
    ? a2vRecommendations
        .flatMap((item) => item && !item.present ? [item.label] : [])
    : [];
  const a2vStackMismatches = legacyA2v
    ? [
        ltx23DevRecommendation?.present
          && request.models.checkpointPath !== ltx23DevRecommendation.localPath
          ? ltx23DevRecommendation.label
          : null,
        ltx23GemmaRecommendation?.present && request.models.gemmaRoot !== ltx23GemmaRecommendation.localPath
          ? ltx23GemmaRecommendation.label
          : null,
        documentedDistilledLoraRecommendation?.present
          && request.models.distilledLora.path !== documentedDistilledLoraRecommendation.localPath
          ? documentedDistilledLoraRecommendation.label
          : null,
        ltx23UpscalerRecommendation?.present
          && request.models.spatialUpscalerPath !== ltx23UpscalerRecommendation.localPath
          ? ltx23UpscalerRecommendation.label
          : null,
      ].filter((value): value is string => value !== null)
    : [];
  const recommendedLipDubMissing = isLipDub
    && lipDubRecommendation
    && !lipDubRecommendation.present
    && (!request.lipDub.lora.path || request.lipDub.lora.path === lipDubRecommendation.localPath);
  const recommendedLipDubMismatch = isLipDub
    && lipDubRecommendation?.present
    && request.lipDub.lora.path
    && request.lipDub.lora.path !== lipDubRecommendation.localPath;
  const recommendedLipDubUpscalerMissing = isLipDub
    && lipDubUpscalerRecommendation
    && !lipDubUpscalerRecommendation.present
    && (!request.models.spatialUpscalerPath || request.models.spatialUpscalerPath !== lipDubUpscalerRecommendation.localPath);
  const recommendedLipDubUpscalerMismatch = isLipDub
    && lipDubUpscalerRecommendation?.present
    && request.models.spatialUpscalerPath
    && request.models.spatialUpscalerPath !== lipDubUpscalerRecommendation.localPath;
  const recommendedLipDubDistilledMissing = isLipDub
    && !officialComfyLipDub
    && lipDubDistilledRecommendation
    && !lipDubDistilledRecommendation.present
    && (!request.models.distilledCheckpointPath || request.models.distilledCheckpointPath !== lipDubDistilledRecommendation.localPath);
  const recommendedLipDubDistilledMismatch = isLipDub
    && !officialComfyLipDub
    && lipDubDistilledRecommendation?.present
    && request.models.distilledCheckpointPath
    && request.models.distilledCheckpointPath !== lipDubDistilledRecommendation.localPath;
  const lipDubPreparationBlocked = lipDubDiagnostics?.findings.some((item) => [
    "reference-unreadable",
    "audio-missing",
    "audio-unverified",
    "duration-unreadable",
    "duration-too-short",
    "insufficient-snapped-frames",
  ].includes(item.code)) ?? false;

  useEffect(() => {
    let cancelled = false;
    setLipDubDiagnostics(null);
    setLipDubDiagnosticsError(null);
    if (!isLipDub || !request.lipDub.referenceVideo.path) {
      setLipDubDiagnosticsBusy(false);
      return;
    }
    setLipDubDiagnosticsBusy(true);
    const timer = window.setTimeout(() => {
      void inspectLipDubReferenceAsset({
        path: request.lipDub.referenceVideo.path,
        width: request.width,
        height: request.height,
        dialogue: request.promptParts.dialogue,
        prompt: request.prompt,
        pipelineProfile: request.lipDub.pipelineProfile,
      }).then((diagnostics) => {
        if (cancelled) return;
        setLipDubDiagnostics(diagnostics);
        const referenceDuration = diagnostics.metadata?.durationSeconds;
        if (referenceDuration !== null && referenceDuration !== undefined) {
          if (referenceDuration < 2) setLipDubTrimEnabled(false);
          setLipDubTrimStart((current) => Math.min(current, Math.max(0, referenceDuration - 2)));
          setLipDubTrimDuration((current) => Math.min(current, Math.min(5, referenceDuration)));
        }
        setLipDubDiagnosticsBusy(false);
      }).catch((error) => {
        if (cancelled) return;
        setLipDubDiagnosticsError(
          error instanceof Error ? error.message : "LipDub-Referenz konnte nicht geprüft werden.",
        );
        setLipDubDiagnosticsBusy(false);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    isLipDub,
    request.height,
    request.lipDub.referenceVideo.path,
    request.lipDub.pipelineProfile,
    request.prompt,
    request.promptParts.dialogue,
    request.width,
  ]);

  useEffect(() => {
    setLipDubTrimEnabled(true);
    setLipDubTrimStart(0);
    setLipDubTrimDuration(4.2);
  }, [request.lipDub.referenceVideo.path]);

  const resetLipDubPreparationState = () => {
    setLipDubPrepError(null);
    setLipDubPrepResult(null);
  };

  const applyUpload = (
    file: UploadedFile,
    target: "audio" | "audio-final" | "retake" | "mask" | "lipdub" | "id-audio",
  ) => {
    onPreview(file.path, file.url);
    if (target === "audio") {
      onChange({ ...request, audio: { ...request.audio, path: file.path, name: file.name } });
    } else if (target === "audio-final") {
      onChange({
        ...request,
        audio: { ...request.audio, finalMix: { path: file.path, name: file.name } },
      });
    } else if (target === "retake") {
      onChange({ ...request, retake: { ...request.retake, videoPath: file.path, videoName: file.name } });
    } else if (target === "lipdub") {
      resetLipDubPreparationState();
      onChange({
        ...request,
        lipDub: {
          ...request.lipDub,
          referenceVideo: { ...request.lipDub.referenceVideo, path: file.path, name: file.name },
        },
      });
    } else if (target === "id-audio") {
      onChange({
        ...request,
        idLora: {
          ...request.idLora,
          referenceAudio: { path: file.path, name: file.name },
        },
      });
    } else {
      onChange({ ...request, icLora: { ...request.icLora, attentionMaskPath: file.path } });
    }
  };
  const addControlVideo = (file: UploadedFile) => {
    onPreview(file.path, file.url);
    onChange({
      ...request,
      icLora: {
        ...request.icLora,
        videoConditioning: [
          ...request.icLora.videoConditioning,
          { path: file.path, name: file.name, strength: 1 },
        ],
      },
    });
  };
  const prepareLipDubReference = async () => {
    const sourcePath = request.lipDub.referenceVideo.path;
    setLipDubPrepBusy(true);
    setLipDubPrepError(null);
    setLipDubPrepResult(null);
    try {
      const prepared = await prepareLipDubReferenceAsset(
        request,
        lipDubTrimEnabled
          ? { startSeconds: lipDubTrimStart, durationSeconds: lipDubTrimDuration }
          : undefined,
      );
      const applied = onPreparedLipDubReference(prepared, sourcePath);
      if (!applied) {
        setLipDubPrepError("Vorbereitung abgeschlossen, aber nicht übernommen: Modus oder Referenz wurde inzwischen geändert.");
        return;
      }
      setLipDubPrepResult(
        `Vorbereitete Referenz: ${prepared.target.width} x ${prepared.target.height}, `
        + `${prepared.target.frames} Frames @ ${prepared.target.fps} fps `
        + `(${prepared.target.durationSeconds.toFixed(2)} s).`,
      );
    } catch (error) {
      setLipDubPrepError(error instanceof Error ? error.message : "LipDub-Referenz konnte nicht vorbereitet werden.");
    } finally {
      setLipDubPrepBusy(false);
    }
  };
  const guidanceKeys: Array<"videoGuidance" | "audioGuidance"> = isTextToAudio
    ? ["audioGuidance"]
    : isAudioConditionedMode(request.mode)
      ? ["videoGuidance"]
      : ["videoGuidance", "audioGuidance"];

  return (
    <main className="editor">
      <section className="editor__title-band">
        <div>
          <span className="eyebrow">{definition.family === "edit" ? "Bearbeiten" : "Produktion"}</span>
          <h1>{definition.label}</h1>
        </div>
        <div className="editor__title-marks">
          <span className="quality-mark">{qualityLabel}</span>
          <span
            className={`model-generation-mark ${request.models.generation === "2.5" ? "is-current" : "is-legacy"}`}
            aria-label="Aktive Modellgeneration"
          >
            LTX-{request.models.generation} · {request.models.layout === "split" ? "Split BF16" : "Monolith Legacy"}
          </span>
        </div>
      </section>

      <section className="editor-section prompt-section">
        <SectionHeader title="Prompt" action={<WandSparkles size={18} />} />
        {sourceSelectable ? (
          <>
            <Segmented
              label="Startpunkt"
              hint={fieldHelp.sourceMode}
              value={request.sourceMode}
              options={[
                { value: "text", label: "Text zu Video" },
                { value: "image", label: "Bild zu Video · empfohlen" },
              ]}
              onChange={(sourceMode) => onChange({
                ...request,
                sourceMode,
                images: sourceMode === "text" ? [] : request.images,
                enhancePrompt: sourceMode === "text"
                  && request.models.layout === "monolith"
                  && !hasDialogueIntent(request),
              })}
            />
            <p className="source-mode-note">
              {request.sourceMode === "image"
                ? "Referenzbild stabilisiert Motiv, Komposition und sichtbare Schrift."
                : "Freie Komposition ausschließlich aus dem Prompt."}
            </p>
          </>
        ) : null}
        <Field
          label={isTextToAudio ? "Audio-Beschreibung" : "Positive Beschreibung"}
          hint={fieldHelp.prompt}
          error={errors.prompt}
        >
          <textarea
            className="prompt-input"
            aria-label={isTextToAudio ? "Audio-Beschreibung" : "Positive Beschreibung"}
            value={request.prompt}
            maxLength={16_000}
            placeholder={isTextToAudio
              ? "Stimme, Sprechweise, Geräusche, Musik und Atmosphäre..."
              : "Szene, Bewegung, Kamera und Ton..."}
            onChange={(event) => onChange({ ...request, prompt: event.target.value })}
          />
          <span className="character-count">{request.prompt.length.toLocaleString("de-AT")} / 16.000</span>
        </Field>
        <Field
          label="Gesprochener Text"
          hint={fieldHelp.promptDialogue}
          error={errors["promptParts.dialogue"]}
        >
          <textarea
            className="dialogue-input"
            aria-label="Gesprochener Text"
            value={request.promptParts.dialogue}
            maxLength={2_000}
            placeholder="Exakter Wortlaut, den die Person sprechen soll..."
            onChange={(event) => onChange({
              ...request,
              promptParts: { ...request.promptParts, dialogue: event.target.value },
            })}
          />
          <span className="character-count">
            {request.promptParts.dialogue.length.toLocaleString("de-AT")} / 2.000
          </span>
        </Field>
        <details className="structured-prompt">
          <summary>
            Weitere Prompt-Bausteine <ChevronDown size={15} />
          </summary>
          <div className="structured-prompt__grid">
            {PROMPT_PART_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <textarea
                  aria-label={field.label}
                  value={request.promptParts[field.key]}
                  maxLength={2_000}
                  placeholder={field.placeholder}
                  onChange={(event) => onChange({
                    ...request,
                    promptParts: { ...request.promptParts, [field.key]: event.target.value },
                  })}
                />
              </Field>
            ))}
          </div>
          <div className="structured-prompt__actions">
            <button
              type="button"
              className="button button--secondary"
              disabled={!Object.values(request.promptParts).some((value) => value.trim())}
              title="Prompt-Bausteine lokal in die positive Beschreibung übernehmen"
              onClick={onComposePrompt}
            >
              <Sparkles size={16} />
              Bausteine übernehmen
            </button>
            <button
              type="button"
              className="icon-button"
              title="Letzte Übernahme zurücknehmen"
              disabled={!canUndoPrompt}
              onClick={onUndoPrompt}
            >
              <Undo2 size={17} />
            </button>
          </div>
          {promptComposeError ? <p className="section-error" role="alert">{promptComposeError}</p> : null}
        </details>
        {sourceSelectable && request.sourceMode === "text" && visibleTextIntent ? (
          <p className="advisory advisory--warning">
            Der Prompt verlangt sichtbare Schrift. Bild-zu-Video mit einer sauberen Textvorlage ist dafür stabiler.
          </p>
        ) : null}
        <Toggle
          label="Beim Start mit Gemma verbessern"
          hint={fieldHelp.enhancePrompt}
          checked={request.enhancePrompt}
          onChange={(enhancePrompt) => onChange({ ...request, enhancePrompt })}
        />
        {dialogueIntent && !isAudioToVideo ? (
          <p className="advisory advisory--warning">
            Dialog erkannt: LTX erzeugt eine neue Stimme. Eine exakte Sprecheridentität oder Stimmklon-Treue ist nicht garantiert;
            verwende nur freigegebene Stimmen und prüfe den Wortlaut im Ergebnis. Für eine feste vorhandene Tonspur nutze Audio zu Video.
          </p>
        ) : null}
        {isDfr ? (
          <p className="advisory advisory--warning">
            DFR erzeugt seine Audiospur ausschließlich in Stufe 1. Es nimmt keine vorhandene Audiodatei an;
            Text im Dialogfeld wird nur als Prompt-Absicht übergeben. Exakter Wortlaut, Sprecheridentität und
            Lippen-Synchronität sind damit nicht garantiert und müssen am Ergebnis separat geprüft werden.
          </p>
        ) : null}
        <details className="inline-details continuity-block">
          <summary>
            Projekt und Kontinuität <ChevronDown size={15} />
          </summary>
          <div className="continuity-fields">
            <TextField
              label="Projektname"
              hint={fieldHelp.continuityProject}
              value={request.continuity.project}
              maxLength={120}
              placeholder="Zum Beispiel Kampagne Sommer"
              onChange={(project) => onChange({ ...request, continuity: { ...request.continuity, project } })}
            />
            <Field label="Kontinuitätsnotizen" hint={fieldHelp.continuityNotes}>
              <textarea
                aria-label="Kontinuitätsnotizen"
                value={request.continuity.notes}
                maxLength={2_000}
                placeholder="Unveränderliche Merkmale, Farben, Kleidung, Positionen oder Anschlüsse..."
                onChange={(event) => onChange({
                  ...request,
                  continuity: { ...request.continuity, notes: event.target.value },
                })}
              />
            </Field>
          </div>
        </details>
        {(definition.needsNegativePrompt || request.mode === "retake")
          && !(request.mode === "retake" && request.retake.distilled) ? (
          <details className="inline-details">
            <summary>
              Negativer Prompt <ChevronDown size={15} />
            </summary>
            <Field label="Ausschlüsse" hint={fieldHelp.negativePrompt}>
              <textarea
                value={request.negativePrompt}
                aria-label="Ausschlüsse"
                placeholder="Unerwünschte Merkmale..."
                onChange={(event) => onChange({ ...request, negativePrompt: event.target.value })}
              />
            </Field>
          </details>
        ) : null}
      </section>

      {imageEnabled ? (
        <section className="editor-section">
          <SectionHeader
            title={
              request.mode === "keyframes"
                ? "Start- und Endbild"
                : request.mode === "ic-lora" && request.icLora.profile === "ingredients"
                  ? "Zutaten-Referenzbild"
                : request.mode === "ic-lora" && request.icLora.profile === "motion-track"
                  ? "Bewegungs-Referenzbild"
                : sourceSelectable || ["image-audio-to-video", "id-lora"].includes(request.mode)
                  ? "Referenzbild"
                  : "Bildkonditionierung"
            }
            action={<ImageIcon size={18} />}
          />
          <ImageRows
            images={request.images}
            mode={request.mode}
            numFrames={request.numFrames}
            previews={previews}
            onPreview={onPreview}
            onChange={(images) => onChange({ ...request, images })}
          />
          {errors.images ? <p className="section-error">{errors.images}</p> : null}
        </section>
      ) : null}

      {isAudioToVideo ? (
        <section className="editor-section">
          <SectionHeader title="Audiospur" />
          <SingleMediaInput
            kind="audio"
            label="Sprachspur hochladen"
            hint={fieldHelp.audioConditioning}
            value={request.audio}
            previewUrl={previews[request.audio.path]}
            onChange={(file) => applyUpload(file, "audio")}
            onClear={() => onChange({ ...request, audio: { ...request.audio, path: "", name: "" } })}
            onPathChange={(path) => onChange({
              ...request,
              audio: { ...request.audio, path, name: path.split("/").at(-1) ?? path },
            })}
          />
          {errors["audio.path"] ? <p className="section-error">{errors["audio.path"]}</p> : null}
          <SingleMediaInput
            kind="audio"
            label="Finale Tonspur hochladen"
            hint={fieldHelp.audioFinalMix}
            value={request.audio.finalMix}
            previewUrl={previews[request.audio.finalMix.path]}
            onChange={(file) => applyUpload(file, "audio-final")}
            onClear={() => onChange({
              ...request,
              audio: { ...request.audio, finalMix: { path: "", name: "" } },
            })}
            onPathChange={(path) => onChange({
              ...request,
              audio: {
                ...request.audio,
                finalMix: { path, name: path.split("/").at(-1) ?? path },
              },
            })}
          />
          <div className="field-grid field-grid--2">
            <NumberField
              label="Start (Sekunden)"
              hint={fieldHelp.audioStart}
              min={0}
              step={0.1}
              value={request.audio.startTime}
              onChange={(startTime) => onChange({ ...request, audio: { ...request.audio, startTime: startTime ?? 0 } })}
            />
            <NumberField
              label="Maximale Dauer"
              hint={fieldHelp.audioDuration}
              min={0.1}
              step={0.1}
              placeholder="Automatisch"
              value={request.audio.maxDuration}
              onChange={(maxDuration) => onChange({ ...request, audio: { ...request.audio, maxDuration } })}
            />
          </div>
          <Toggle
            label="LongCat-Lippenpass"
            hint={fieldHelp.longcatLipsync}
            checked={request.postprocess.longcatLipsync.enabled}
            onChange={(enabled) => onChange({
              ...request,
              postprocess: {
                ...request.postprocess,
                longcatLipsync: { ...request.postprocess.longcatLipsync, enabled },
                latentSync: {
                  ...request.postprocess.latentSync,
                  enabled: enabled ? false : request.postprocess.latentSync.enabled,
                },
                museTalk: {
                  ...request.postprocess.museTalk,
                  enabled: enabled ? false : request.postprocess.museTalk.enabled,
                },
                lipForcing: {
                  ...request.postprocess.lipForcing,
                  enabled: enabled ? false : request.postprocess.lipForcing.enabled,
                },
              },
            })}
          />
          {request.postprocess.longcatLipsync.enabled ? (
            <div className="field-grid field-grid--2">
              <SelectField
                label="LongCat-Auflösung"
                hint={fieldHelp.longcatResolution}
                value={request.postprocess.longcatLipsync.resolution}
                options={[
                  { value: "480p", label: "480p · empfohlen" },
                  { value: "720p", label: "720p · langsam" },
                ]}
                onChange={(resolution) => onChange({
                  ...request,
                  postprocess: {
                    ...request.postprocess,
                    longcatLipsync: { ...request.postprocess.longcatLipsync, resolution },
                  },
                })}
              />
              <NumberField
                label="Mund-Übergangsbreite"
                hint={fieldHelp.longcatBlend}
                min={0}
                max={1}
                step={0.05}
                value={request.postprocess.longcatLipsync.blend}
                error={errors["postprocess.longcatLipsync.blend"]}
                onChange={(blend) => onChange({
                  ...request,
                  postprocess: {
                    ...request.postprocess,
                    longcatLipsync: { ...request.postprocess.longcatLipsync, blend: blend ?? 0.9 },
                  },
                })}
              />
            </div>
          ) : null}
          <LatentSyncControls request={request} onChange={onChange} errors={errors} />
          <MuseTalkControls request={request} onChange={onChange} errors={errors} />
          <LipForcingControls request={request} onChange={onChange} errors={errors} />
        </section>
      ) : null}

      {showsLipSyncControls(request) ? (
        <section className="editor-section">
          <SectionHeader title="Lippen-Synchronität" />
          <LatentSyncControls request={request} onChange={onChange} errors={errors} />
          <MuseTalkControls request={request} onChange={onChange} errors={errors} />
          <LipForcingControls request={request} onChange={onChange} errors={errors} />
        </section>
      ) : null}

      {isIdLora ? (
        <section className="editor-section">
          <SectionHeader title="ID-LoRA Identität" />
          <p className="advisory">
            Das Bild steuert die sichtbare Person. Ein kurzer Referenzton überträgt die Stimme; der Text im Feld
            „Gesprochener Text“ bestimmt den neu erzeugten Wortlaut.
          </p>
          <SingleMediaInput
            kind="audio"
            label="Stimmreferenz hochladen"
            hint={fieldHelp.idLoraReferenceAudio}
            value={request.idLora.referenceAudio}
            previewUrl={previews[request.idLora.referenceAudio.path]}
            onChange={(file) => applyUpload(file, "id-audio")}
            onClear={() => onChange({
              ...request,
              idLora: { ...request.idLora, referenceAudio: { path: "", name: "" } },
            })}
            onPathChange={(path) => onChange({
              ...request,
              idLora: {
                ...request.idLora,
                referenceAudio: { path, name: path.split("/").at(-1) ?? path },
              },
            })}
          />
          {errors["idLora.referenceAudio.path"] ? (
            <p className="section-error">{errors["idLora.referenceAudio.path"]}</p>
          ) : null}
          <div className="field-grid field-grid--2">
            <PathPicker
              label="ID-LoRA TalkVid"
              hint={fieldHelp.idLoraModel}
              value={request.idLora.lora.path}
              options={loraOptions.filter((option) => option.path === idLoraRecommendation?.localPath)}
              error={errors["idLora.lora.path"]}
              placeholder="/absoluter/pfad/ltx-2.3-id-lora-talkvid-3k.safetensors"
              onChange={(path) => onChange({
                ...request,
                idLora: { ...request.idLora, lora: { ...request.idLora.lora, path } },
              })}
            />
            <NumberField
              label="ID-LoRA-Stärke"
              hint={fieldHelp.idLoraStrength}
              min={0}
              max={2}
              step={0.05}
              value={request.idLora.lora.strength}
              onChange={(strength) => onChange({
                ...request,
                idLora: {
                  ...request.idLora,
                  lora: { ...request.idLora.lora, strength: strength ?? 1 },
                },
              })}
            />
          </div>
          <div className="field-grid field-grid--2">
            <NumberField
              label="Identitätsführung"
              hint={fieldHelp.idLoraGuidance}
              min={0}
              max={20}
              step={0.1}
              value={request.idLora.identityGuidanceScale}
              onChange={(identityGuidanceScale) => onChange({
                ...request,
                idLora: { ...request.idLora, identityGuidanceScale: identityGuidanceScale ?? 3 },
              })}
            />
            <NumberField
              label="Bildstärke Stufe 1"
              hint={fieldHelp.idLoraStage1ImageStrength}
              min={0}
              max={1}
              step={0.05}
              value={request.idLora.stage1ImageStrength}
              onChange={(stage1ImageStrength) => onChange({
                ...request,
                idLora: { ...request.idLora, stage1ImageStrength: stage1ImageStrength ?? 0.7 },
              })}
            />
          </div>
          <details className="inline-details">
            <summary>
              Erweiterte Identitätsführung <ChevronDown size={15} />
            </summary>
            <div className="field-grid field-grid--2">
              <NumberField
                label="Start"
                hint={fieldHelp.idLoraGuidanceWindow}
                min={0}
                max={1}
                step={0.01}
                value={request.idLora.identityGuidanceStart}
                onChange={(identityGuidanceStart) => onChange({
                  ...request,
                  idLora: { ...request.idLora, identityGuidanceStart: identityGuidanceStart ?? 0 },
                })}
              />
              <NumberField
                label="Ende"
                hint={fieldHelp.idLoraGuidanceWindow}
                min={0}
                max={1}
                step={0.01}
                value={request.idLora.identityGuidanceEnd}
                error={errors["idLora.identityGuidanceEnd"]}
                onChange={(identityGuidanceEnd) => onChange({
                  ...request,
                  idLora: { ...request.idLora, identityGuidanceEnd: identityGuidanceEnd ?? 1 },
                })}
              />
            </div>
          </details>
        </section>
      ) : null}

      {isLipDub ? (
        <section className="editor-section">
          <SectionHeader title="LipDub Referenz" action={<FileVideo size={18} />} />
          <p className="advisory">
            Der offizielle LipDub-Modus erzeugt Video und Ton gemeinsam aus dem Referenzclip und dem neuen
            Zieltext. Er übernimmt keine separate Ziel-Audiodatei.
          </p>
          <Segmented
            label="LipDub Qualitätsweg"
            hint={fieldHelp.lipDubPipelineProfile}
            value={request.lipDub.pipelineProfile}
            options={[
              { value: "official-comfy-hq", label: "Offiziell Comfy HQ" },
              { value: "native-distilled", label: "Native Distilled (Legacy)" },
            ]}
            onChange={(pipelineProfile) => {
              const useOfficial = pipelineProfile === "official-comfy-hq";
              onChange({
                ...request,
                height: useOfficial ? 1920 : request.height,
                width: useOfficial ? 1088 : request.width,
                models: {
                  ...request.models,
                  checkpointPath: useOfficial
                    ? ltx23DevRecommendation?.localPath ?? request.models.checkpointPath
                    : request.models.checkpointPath,
                  distilledCheckpointPath: useOfficial
                    ? request.models.distilledCheckpointPath
                    : lipDubDistilledRecommendation?.localPath ?? request.models.distilledCheckpointPath,
                  distilledLora: useOfficial
                    ? {
                        path: ltx23DistilledLoraRecommendation?.localPath ?? request.models.distilledLora.path,
                        strength: 0.5,
                      }
                    : request.models.distilledLora,
                  spatialUpscalerPath: lipDubUpscalerRecommendation?.localPath
                    ?? request.models.spatialUpscalerPath,
                },
                lipDub: { ...request.lipDub, pipelineProfile },
              });
            }}
          />
          <p className="advisory">
            {officialComfyLipDub
              ? "Verwendet den veröffentlichten Dev-Checkpoint mit Distilled-LoRA 1.1 bei Stärke 0,5, LipDub-IC-LoRA und getrennten Seeds für beide Stufen."
              : "Legacy-Profil für die unveränderte Wiedergabe älterer Studio-Jobs mit dem Distilled-Checkpoint."}
          </p>
          <TextField
            label="Zielsprache"
            hint={fieldHelp.lipDubTargetLanguage}
            value={request.lipDub.targetLanguage}
            placeholder="z. B. Deutsch"
            maxLength={80}
            onChange={(targetLanguage) => onChange({
              ...request,
              lipDub: { ...request.lipDub, targetLanguage },
            })}
          />
          <Toggle
            label="Genau ein Sprecher bestätigt"
            hint={fieldHelp.lipDubSingleSpeaker}
            checked={request.lipDub.singleSpeakerAcknowledged}
            onChange={(singleSpeakerAcknowledged) => onChange({
              ...request,
              lipDub: { ...request.lipDub, singleSpeakerAcknowledged },
            })}
          />
          <SingleMediaInput
            kind="video"
            label="Referenzvideo hochladen"
            value={{ path: request.lipDub.referenceVideo.path, name: request.lipDub.referenceVideo.name }}
            previewUrl={previews[request.lipDub.referenceVideo.path]}
            onChange={(file) => applyUpload(file, "lipdub")}
            onClear={() => {
              resetLipDubPreparationState();
              onChange({
                ...request,
                lipDub: { ...request.lipDub, referenceVideo: { ...request.lipDub.referenceVideo, path: "", name: "" } },
              });
            }}
            onPathChange={(path) => {
              resetLipDubPreparationState();
              onChange({
                ...request,
                lipDub: {
                  ...request.lipDub,
                  referenceVideo: {
                    ...request.lipDub.referenceVideo,
                    path,
                    name: path.split("/").at(-1) ?? path,
                  },
                },
              });
            }}
          />
          {request.lipDub.referenceVideo.path ? (
            <div
              className={`lipdub-diagnostics lipdub-diagnostics--${lipDubDiagnostics?.status ?? "checking"}`}
              aria-live="polite"
            >
              <div className="lipdub-diagnostics__header">
                <span>
                  {lipDubDiagnosticsBusy ? <LoaderCircle className="spin" size={16} /> : null}
                  {lipDubDiagnostics?.status === "ready" ? <CircleCheck size={16} /> : null}
                  {lipDubDiagnostics?.status === "needs-preparation" ? <TriangleAlert size={16} /> : null}
                  {lipDubDiagnostics?.status === "blocked" ? <CircleX size={16} /> : null}
                  <strong>Referenzdiagnose</strong>
                </span>
                <span className="lipdub-diagnostics__status">
                  {lipDubDiagnosticsBusy
                    ? "wird geprüft"
                    : lipDubDiagnostics?.status === "ready"
                      ? "bereit"
                      : lipDubDiagnostics?.status === "needs-preparation"
                        ? "vorbereiten"
                        : lipDubDiagnostics?.status === "blocked"
                          ? "blockiert"
                          : "unbekannt"}
                </span>
              </div>
              {lipDubDiagnostics?.metadata ? (
                <div className="lipdub-diagnostics__metrics">
                  <span>
                    <small>Format</small>
                    <strong>
                      {lipDubDiagnostics.metadata.width ?? "?"} x {lipDubDiagnostics.metadata.height ?? "?"}
                    </strong>
                  </span>
                  <span>
                    <small>Bildrate</small>
                    <strong>
                      {lipDubDiagnostics.metadata.fps?.toFixed(3) ?? "?"} fps
                      {lipDubDiagnostics.metadata.constantFrameRate === false ? " · VFR" : ""}
                    </strong>
                  </span>
                  <span>
                    <small>LTX-Frames</small>
                    <strong>
                      {lipDubDiagnostics.metadata.frames ?? "?"}
                      {lipDubDiagnostics.metadata.snappedFrames !== null
                        ? ` → ${lipDubDiagnostics.metadata.snappedFrames}`
                        : ""}
                    </strong>
                  </span>
                  <span>
                    <small>Dauer</small>
                    <strong>{lipDubDiagnostics.metadata.durationSeconds?.toFixed(2) ?? "?"} s</strong>
                  </span>
                  <span>
                    <small>Audio</small>
                    <strong>
                      {lipDubDiagnostics.metadata.hasAudio
                        ? `${lipDubDiagnostics.metadata.audioSampleRate
                          ? `${Math.round(lipDubDiagnostics.metadata.audioSampleRate / 1000)} kHz`
                          : "vorhanden"}`
                        : "fehlt"}
                    </strong>
                  </span>
                  <span>
                    <small>Zieldialog-Tempo</small>
                    <strong>
                      {lipDubDiagnostics.metadata.dialogueWordsPerMinute === null
                        ? "noch offen"
                        : `${Math.round(lipDubDiagnostics.metadata.dialogueWordsPerMinute)} WPM`}
                    </strong>
                  </span>
                </div>
              ) : null}
              {lipDubDiagnostics?.recommendedTarget ? (
                <p className="lipdub-diagnostics__target">
                  Ziel: {lipDubDiagnostics.recommendedTarget.width} x {lipDubDiagnostics.recommendedTarget.height}
                  {" "}· {lipDubDiagnostics.recommendedTarget.fps} fps CFR · exakt 8k+1 Frames
                </p>
              ) : null}
              {lipDubDiagnostics?.findings.length ? (
                <ul className="lipdub-diagnostics__findings">
                  {lipDubDiagnostics.findings.map((item) => (
                    <li key={item.code} className={`is-${item.level}`}>{item.message}</li>
                  ))}
                </ul>
              ) : null}
              {lipDubDiagnosticsError ? <p className="section-error" role="alert">{lipDubDiagnosticsError}</p> : null}
            </div>
          ) : null}
          {request.lipDub.referenceVideo.path ? (
            <div className="lipdub-preparation">
              <Toggle
                label="Kalibrierclip schneiden"
                hint={fieldHelp.lipDubCalibrationClip}
                checked={lipDubTrimEnabled}
                disabled={lipDubPrepBusy}
                onChange={setLipDubTrimEnabled}
              />
              {lipDubTrimEnabled ? (
                <div className="field-grid field-grid--2">
                  <NumberField
                    label="Clip-Start"
                    hint={fieldHelp.lipDubCalibrationStart}
                    min={0}
                    max={Math.max(0, (lipDubDiagnostics?.metadata?.durationSeconds ?? 2) - 2)}
                    step={0.1}
                    value={lipDubTrimStart}
                    disabled={lipDubPrepBusy}
                    onChange={(value) => setLipDubTrimStart(value ?? 0)}
                  />
                  <NumberField
                    label="Clip-Länge"
                    hint={fieldHelp.lipDubCalibrationDuration}
                    min={2}
                    max={Math.min(
                      5,
                      Math.max(2, (lipDubDiagnostics?.metadata?.durationSeconds ?? 5) - lipDubTrimStart),
                    )}
                    step={0.1}
                    value={lipDubTrimDuration}
                    disabled={lipDubPrepBusy}
                    onChange={(value) => setLipDubTrimDuration(value ?? 4.2)}
                  />
                </div>
              ) : null}
              <div className="lipdub-reference-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  title={lipDubTrimEnabled
                    ? "Framegenauen 2-5-s-Kalibrierclip mit CFR, synchronem Audio und 8k+1 Frames erstellen"
                    : "Gesamte Referenz mit CFR, synchronem Audio und 8k+1 Frames vorbereiten"}
                  disabled={lipDubPrepBusy || lipDubDiagnosticsBusy || !lipDubDiagnostics || lipDubPreparationBlocked}
                  onClick={() => void prepareLipDubReference()}
                >
                  {lipDubPrepBusy
                    ? <LoaderCircle className="spin" size={16} />
                    : lipDubTrimEnabled
                      ? <Scissors size={16} />
                      : <WandSparkles size={16} />}
                  {lipDubTrimEnabled ? "Kalibrierclip erstellen" : "Referenz normalisieren"}
                </button>
              </div>
            </div>
          ) : null}
          {lipDubPrepError ? <p className="section-error" role="alert">{lipDubPrepError}</p> : null}
          {lipDubPrepResult ? <p className="advisory">{lipDubPrepResult}</p> : null}
          {errors["lipDub.referenceVideo.path"] ? <p className="section-error">{errors["lipDub.referenceVideo.path"]}</p> : null}
          <NumberField
            label="Referenzstärke"
            hint={fieldHelp.lipDubReferenceStrength}
            min={0}
            max={2}
            step={0.05}
            value={request.lipDub.referenceVideo.strength}
            onChange={(strength) => onChange({
              ...request,
              lipDub: {
                ...request.lipDub,
                referenceVideo: { ...request.lipDub.referenceVideo, strength: strength ?? 1 },
              },
            })}
          />
          {errors["promptParts.dialogue"] ? <p className="section-error">{errors["promptParts.dialogue"]}</p> : null}
        </section>
      ) : null}

      {request.mode === "retake" ? (
        <section className="editor-section">
          <SectionHeader title="Quellvideo" />
          <SingleMediaInput
            kind="video"
            label="Video hochladen"
            value={{ path: request.retake.videoPath, name: request.retake.videoName }}
            previewUrl={previews[request.retake.videoPath]}
            onChange={(file) => applyUpload(file, "retake")}
            onClear={() => onChange({ ...request, retake: { ...request.retake, videoPath: "", videoName: "" } })}
            onPathChange={(videoPath) => onChange({
              ...request,
              retake: { ...request.retake, videoPath, videoName: videoPath.split("/").at(-1) ?? videoPath },
            })}
          />
          {errors["retake.videoPath"] ? <p className="section-error">{errors["retake.videoPath"]}</p> : null}
          <div className="field-grid field-grid--2">
            <NumberField
              label="Start"
              hint={fieldHelp.retakeStart}
              min={0}
              step={0.1}
              value={request.retake.startTime}
              onChange={(startTime) => onChange({ ...request, retake: { ...request.retake, startTime: startTime ?? 0 } })}
            />
            <NumberField
              label="Ende"
              hint={fieldHelp.retakeEnd}
              min={0.1}
              step={0.1}
              value={request.retake.endTime}
              error={errors["retake.endTime"]}
              onChange={(endTime) => onChange({ ...request, retake: { ...request.retake, endTime: endTime ?? 0.1 } })}
            />
          </div>
          <div className="toggle-grid">
            <Toggle
              label="Video regenerieren"
              hint={fieldHelp.regenerateVideo}
              checked={request.retake.regenerateVideo}
              onChange={(regenerateVideo) => onChange({ ...request, retake: { ...request.retake, regenerateVideo } })}
            />
            <Toggle
              label="Audio regenerieren"
              hint={fieldHelp.regenerateAudio}
              checked={request.retake.regenerateAudio}
              onChange={(regenerateAudio) => onChange({ ...request, retake: { ...request.retake, regenerateAudio } })}
            />
            <Toggle
              label="Distilled Schedule"
              hint={fieldHelp.distilledSchedule}
              checked={request.retake.distilled}
              onChange={(distilled) => onChange({ ...request, retake: { ...request.retake, distilled } })}
            />
          </div>
        </section>
      ) : null}

      {request.mode === "ic-lora" ? (
        <section className="editor-section">
          <SectionHeader
            title="IC-LoRA Kontrolle"
            action={request.icLora.profile !== "ingredients" ? (
              <div className="section-header__actions">
                <UploadButton
                  kind="video"
                  accept="video/*"
                  label={request.icLora.profile === "union-control"
                    ? "Kontrollvideo"
                    : request.icLora.profile === "motion-track"
                      ? "Track-Video"
                      : request.icLora.profile === "inpainting"
                        ? "Video zum Ausbessern"
                        : request.icLora.profile === "outpainting"
                          ? "Video zum Erweitern"
                          : "Quellvideo"}
                  hint={fieldHelp.videoUpload}
                  onUploaded={addControlVideo}
                />
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => onChange({
                    ...request,
                    icLora: {
                      ...request.icLora,
                      videoConditioning: [
                        ...request.icLora.videoConditioning,
                        {
                          path: "",
                          name: `${request.icLora.profile === "motion-track" ? "Track" : "Quellvideo"} `
                            + `${request.icLora.videoConditioning.length + 1}`,
                          strength: 1,
                        },
                      ],
                    },
                  })}
                >
                  <Plus size={16} /> DGX-Pfad
                </button>
              </div>
            ) : undefined}
          />
          <Segmented
            label="IC-LoRA Aufgabe"
            hint={fieldHelp.icLoraProfile}
            value={request.icLora.profile}
            options={[
              { value: "union-control", label: "Union Control · HOLD" },
              { value: "ingredients", label: "Ingredients" },
              { value: "motion-track", label: "Motion Track" },
              { value: "pixel-upscaler", label: "Pixel x4" },
              ...(request.models.layout === "split"
                ? [{ value: "v2v-deblur" as const, label: "V2V Deblur · 2.5" }]
                : [{ value: "v2v-instant-shave" as const, label: "V2V Rasur · 2.3 Legacy" }]),
              { value: "inpainting", label: "Inpainting" },
              { value: "outpainting", label: "Outpainting" },
              { value: "hdr", label: "HDR" },
            ]}
            onChange={(profile) => {
              const frameRate = profile === "union-control" ? 25 : profile === "hdr" ? 30 : 24;
              onChange(withOfficialSpeechModelPaths({
                ...request,
                width: profile === "pixel-upscaler"
                  ? request.width
                  : ["inpainting", "outpainting"].includes(profile)
                    ? 1920
                    : profile === "union-control"
                      ? 1280
                      : 960,
                height: profile === "pixel-upscaler"
                  ? request.height
                  : ["inpainting", "outpainting"].includes(profile)
                    ? 1088
                    : profile === "union-control"
                      ? 704
                      : 544,
                numFrames: framesForDuration(
                  videoDurationSeconds(request.numFrames, request.frameRate),
                  frameRate,
                ),
                frameRate,
                images: ["pixel-upscaler", "v2v-deblur", "v2v-instant-shave", "inpainting", "outpainting", "hdr"].includes(profile)
                  ? []
                  : request.images,
                quantization: { ...request.quantization, mode: "none" },
                models: {
                  ...request.models,
                  distilledLora: { ...request.models.distilledLora, strength: 0.5 },
                },
                icLora: {
                  ...request.icLora,
                  profile,
                  controlType: profile === "union-control" ? request.icLora.controlType : "prepared",
                  lora: { ...request.icLora.lora, strength: 1 },
                },
              }));
            }}
          />
          {request.icLora.profile === "union-control" ? (
            <>
              <SelectField
                label="Kontrollaufbereitung"
                hint={fieldHelp.controlType}
                value={request.icLora.controlType}
                options={[
                  { value: "depth", label: "MoGe-Tiefe · offizielle Vorlage" },
                  { value: "canny", label: "Canny-Kanten · automatisch" },
                  { value: "prepared", label: "Fertige Kontrollmap" },
                  { value: "pose", label: "Fertiges Pose-Skelett" },
                ]}
                onChange={(controlType) => onChange({
                  ...request,
                  icLora: { ...request.icLora, controlType },
                })}
              />
              {request.icLora.controlType === "depth" ? (
                <PathPicker
                  label="MoGe-Geometriemodell"
                  hint={fieldHelp.mogeModel}
                  value={request.icLora.mogeModelPath}
                  options={geometryOptions.filter((option) => option.path === mogeRecommendation?.localPath)}
                  error={errors["icLora.mogeModelPath"]}
                  placeholder="/absoluter/pfad/moge_2_vitl_normal_fp16.safetensors"
                  onChange={(mogeModelPath) => onChange({
                    ...request,
                    icLora: { ...request.icLora, mogeModelPath },
                  })}
                />
              ) : null}
            </>
          ) : null}
          <div className="field-grid field-grid--2">
            <PathPicker
              label={icLoraUi.label}
              hint={icLoraUi.hint}
              value={request.icLora.lora.path}
              options={loraOptions.filter((option) => option.path === icLoraUi.recommendation?.localPath)}
              error={errors["icLora.lora.path"]}
              placeholder={icLoraUi.placeholder}
              onChange={(path) => onChange({
                ...request,
                icLora: { ...request.icLora, lora: { ...request.icLora.lora, path } },
              })}
            />
            <NumberField
              label={icLoraUi.strengthLabel}
              hint={icLoraUi.strengthHint}
              min={0}
              max={2}
              step={0.05}
              value={request.icLora.lora.strength}
              onChange={(strength) => onChange({
                ...request,
                icLora: {
                  ...request.icLora,
                  lora: { ...request.icLora.lora, strength: strength ?? 1 },
                },
              })}
            />
          </div>
          {request.icLora.profile === "hdr" ? (
            <div className="field-grid field-grid--2">
              <PathPicker
                label="HDR-Szenen-Embeddings"
                hint={fieldHelp.hdrEmbeddings}
                value={request.icLora.hdrTextEmbeddingsPath}
                options={loraOptions.filter((option) =>
                  option.path === hdrEmbeddingsRecommendation?.localPath
                )}
                error={errors["icLora.hdrTextEmbeddingsPath"]}
                placeholder="/absoluter/pfad/ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors"
                onChange={(hdrTextEmbeddingsPath) => onChange({
                  ...request,
                  icLora: { ...request.icLora, hdrTextEmbeddingsPath },
                })}
              />
              <Toggle
                label="HDR hohe Zeitqualität"
                hint={fieldHelp.hdrHighQuality}
                checked={request.icLora.hdrHighQuality}
                onChange={(hdrHighQuality) => onChange({
                  ...request,
                  icLora: { ...request.icLora, hdrHighQuality },
                })}
              />
            </div>
          ) : null}
          {request.icLora.profile !== "ingredients" ? (
            <>
              <AssetLibrary
                kind="video"
                label={request.icLora.profile === "motion-track" ? "Track-Mediathek" : "Quellmediathek"}
                onSelect={addControlVideo}
              />
              {request.icLora.videoConditioning.map((video, index) => (
            <div className="conditioning-row" key={`${video.path}-${index}`}>
              <video src={previews[video.path]} muted />
              <TextField
                label={video.name}
                hint={fieldHelp.controlVideoPath}
                value={video.path}
                placeholder="/absoluter/pfad/video.mp4"
                onChange={(path) => onChange({
                  ...request,
                  icLora: {
                    ...request.icLora,
                    videoConditioning: request.icLora.videoConditioning.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, path } : item,
                    ),
                  },
                })}
              />
              {!["inpainting", "outpainting"].includes(request.icLora.profile) ? (
                <NumberField
                  label="Stärke"
                  hint={fieldHelp.controlStrength}
                  min={0}
                  max={2}
                  step={0.05}
                  value={video.strength}
                  onChange={(strength) => onChange({
                    ...request,
                    icLora: {
                      ...request.icLora,
                      videoConditioning: request.icLora.videoConditioning.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, strength: strength ?? 1 } : item,
                      ),
                    },
                  })}
                />
              ) : null}
              <button
                type="button"
                className="icon-button icon-button--danger"
                title="Kontrollvideo entfernen"
                onClick={() => onChange({
                  ...request,
                  icLora: {
                    ...request.icLora,
                    videoConditioning: request.icLora.videoConditioning.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  },
                })}
              >
                <Trash2 size={17} />
              </button>
            </div>
              ))}
              {errors["icLora.videoConditioning"] ? (
                <p className="section-error">{errors["icLora.videoConditioning"]}</p>
              ) : null}
              {["union-control", "inpainting"].includes(request.icLora.profile) ? (
                <div className="mask-row">
                <SingleMediaInput
                  kind="mask"
                  label={request.icLora.profile === "inpainting"
                    ? "Inpainting-Maskenvideo"
                    : "Kontrollmaske"}
                  hint={request.icLora.profile === "inpainting"
                    ? fieldHelp.inpaintMask
                    : fieldHelp.controlMask}
                  value={{ path: request.icLora.attentionMaskPath, name: request.icLora.attentionMaskPath.split("/").at(-1) ?? "" }}
                  previewUrl={previews[request.icLora.attentionMaskPath]}
                  onChange={(file) => applyUpload(file, "mask")}
                  onClear={() => onChange({ ...request, icLora: { ...request.icLora, attentionMaskPath: "" } })}
                  onPathChange={(attentionMaskPath) => onChange({
                    ...request,
                    icLora: { ...request.icLora, attentionMaskPath },
                  })}
                />
                {request.icLora.profile === "union-control" ? (
                  <NumberField
                    label="Maskenstärke"
                    hint={fieldHelp.maskStrength}
                    min={0}
                    max={1}
                    step={0.05}
                    value={request.icLora.attentionStrength}
                    onChange={(attentionStrength) => onChange({
                      ...request,
                      icLora: { ...request.icLora, attentionStrength: attentionStrength ?? 1 },
                    })}
                  />
                ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {isDfr ? (
        <section className="editor-section" aria-label="DFR Max-Detail Einstellungen">
          <SectionHeader title="DFR Max-Detail" action={<Sparkles size={18} />} />
          {isLegacyDfr ? (
            <p className="advisory advisory--warning" role="alert">
              Historischer DFR-Altbestand vor v1.3.0: Einstellungen bleiben zur Nachvollziehbarkeit sichtbar,
              sind aber unveränderlich nicht ausführbar. Für einen neuen Lauf DFR in der linken Modusleiste
              ausdrücklich neu auswählen; ein alter Dev-/Distilled-LoRA-Vertrag wird niemals umgedeutet.
            </p>
          ) : (
            <p className="advisory">
              Offizieller LTX-2 v1.3.0-DFR-Pfad: Der direkte Distilled-Transformer erzeugt Keyframe-Slots;
              die verpflichtende Detailing IC-LoRA wird upstream fest mit Stärke 0,5 angewendet. Es gibt weder
              einen Dev-Transformer- noch einen Distilled-LoRA-Fallback. Der nicht fortsetzbare Single-Call
              bleibt bis zur lokalen Peak-Messung mit 86 GiB konservativ auf HOLD.
            </p>
          )}
          <div className="field-grid field-grid--2">
            <SelectField
              label="Zeitliche Upscalings"
              hint={fieldHelp.dfrTemporalUpscalings}
              value={String(dfr.temporalUpscalings) as "0" | "1" | "2"}
              options={[
                { value: "0", label: "0 · Basis-FPS (Standard)" },
                { value: "1", label: "1 · zeitlich x2" },
                { value: "2", label: "2 · zeitlich x4 · sehr teuer" },
              ]}
              onChange={(value) => onChange({
                ...request,
                dfr: { ...dfr, temporalUpscalings: Number(value) as 0 | 1 | 2 },
              })}
            />
            <SelectField
              label="Räumliche Upscalings"
              hint={fieldHelp.dfrSpatialUpscalings}
              value={String(dfr.spatialUpscalings) as "1" | "2"}
              options={[
                { value: "1", label: "1 · Basis → volle Auflösung" },
                { value: "2", label: "2 · zusätzlicher Detailing-Epilog" },
              ]}
              onChange={(value) => onChange({
                ...request,
                dfr: { ...dfr, spatialUpscalings: Number(value) as 1 | 2 },
              })}
            />
            {dfr.temporalUpscalings > 0 ? (
              <PathPicker
                label="DFR Temporal Upscaler x2"
                hint={fieldHelp.dfrTemporalUpscaler}
                value={dfr.temporalUpscalerPath}
                options={temporalUpscalerOptions.filter((option) =>
                  option.path === dfrTemporalUpscalerRecommendation?.localPath)}
                error={errors["dfr.temporalUpscalerPath"]}
                placeholder="/absoluter/pfad/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors"
                onChange={(temporalUpscalerPath) => onChange({
                  ...request,
                  dfr: { ...dfr, temporalUpscalerPath },
                })}
              />
            ) : null}
          </div>
          {dfrOutput ? (
            <p className="advisory" data-dfr-output-geometry="verified-v1.3">
              Endausgabe: {dfrOutput.width} × {dfrOutput.height} · {dfrOutput.numFrames} Frames ·{" "}
              {dfrOutput.frameRate.toLocaleString("de-AT", { maximumFractionDigits: 6 })} FPS. Jede zeitliche
              Runde verwendet exakt N → 2(N−1)+1 und verdoppelt die Wiedergabe-FPS; die Dauer bleibt{" "}
              {formatDuration(dfrOutput.durationSeconds)}.
            </p>
          ) : null}
          <p className="advisory">
            VAE-Tiling wird von DFR v1.3 pipeline-intern fest verwaltet. Studio sendet dafür keinen
            wirkungslosen <code>--disable-tiling</code>-Schalter.
          </p>
          {dfr.spatialUpscalings === 2 && (request.width % 128 !== 0 || request.height % 128 !== 0) ? (
            <p className="advisory advisory--warning">
              Räumliches Upscaling 2 ist HOLD: Breite und Höhe müssen auf dem offiziellen 128er-Raster liegen.
            </p>
          ) : null}
          {dfr.temporalUpscalings > 0
            && dfrTemporalUpscalerRecommendation?.integrity !== "verified" ? (
            <p className="advisory advisory--warning">
              Zeitliche Verfeinerung ist HOLD: Der gepinnte Temporal Upscaler ist lokal nicht vollständig
              SHA-256-verifiziert. Runde 0 bleibt der ehrliche ausführbare Standard.
            </p>
          ) : null}
          <PathPicker
            label="DFR Detailing IC-LoRA · verpflichtend · Stärke 0,5"
            hint={fieldHelp.dfrDetailingLora}
            value={dfr.detailingLoraPath}
            options={loraOptions.filter((option) =>
              option.path === dfrDetailingLoraRecommendation?.localPath)}
            error={errors["dfr.detailingLoraPath"]}
            placeholder="/absoluter/pfad/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors"
            onChange={(detailingLoraPath) => onChange({
              ...request,
              dfr: { ...dfr, detailingLoraPath },
            })}
          />
          {dfrDetailingLoraRecommendation?.integrity !== "verified" ? (
            <p className="advisory advisory--warning">
              DFR bleibt HOLD: Die verpflichtende Detailing IC-LoRA aus dem separaten gated
              Lightricks-Repository fehlt lokal oder ist nicht vollständig SHA-256-verifiziert.
              Ohne diese Datei ist v1.3.0 nicht startfähig; es gibt keinen Ersatz-Fallback.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="editor-section">
        <SectionHeader title="Modelle" action={<Cpu size={18} />} />
        <div className="field-grid field-grid--2">
          <Segmented
            label="Modellpaket"
            hint="Monolith erhält bestehende LTX-2.3-Projekte. Split-Pack bindet die offiziellen LTX-2.5-Komponenten einzeln und reproduzierbar."
            value={request.models.layout}
            options={isDfr
              ? [{ value: "split", label: "LTX-2.5 DFR Split-Pack · verpflichtend" }]
              : [
                  { value: "monolith", label: "LTX-2.3 Monolith" },
                  { value: "split", label: "LTX-2.5 Split-Pack" },
                ]}
            onChange={(layout) => {
              const nextProfile = request.mode === "ic-lora"
                && request.icLora.profile === "v2v-instant-shave"
                && layout === "split"
                ? "v2v-deblur"
                : request.mode === "ic-lora"
                  && request.icLora.profile === "v2v-deblur"
                  && layout === "monolith"
                  ? "v2v-instant-shave"
                  : request.icLora.profile;
              const changed = withOfficialSpeechModelPaths({
                ...request,
                enhancePrompt: layout === "split" ? false : request.enhancePrompt,
                icLora: { ...request.icLora, profile: nextProfile },
                models: {
                  ...request.models,
                  layout,
                  generation: layout === "split" ? "2.5" : "2.3",
                  gemmaLora: layout === "split"
                    ? { ...request.models.gemmaLora, enabled: false }
                    : request.models.gemmaLora,
                },
              });
              onChange(modelInventory
                ? withDiscoveredModelDefaults(changed, modelInventory)
                : changed);
            }}
          />
          {request.mode === "distilled" ? (
            <Toggle
              label={isLtx25Split ? "Single-Stage Preview" : "Legacy Single-Stage"}
              hint={isLtx25Split
                ? "Offizieller schneller LTX-2.5-Previewpfad: acht Schritte direkt in Ausgabeauflösung, ohne Spatial Upscaler und ohne 3-Schritt-Refine."
                : "Bestehender LTX-2.3-Monolithpfad ohne zweite Upscale-/Refine-Stufe; für neue Läufe wird das LTX-2.5-Split-Pack empfohlen."}
              checked={request.distilled.singleStage}
              onChange={(singleStage) => onChange({
                ...request,
                distilled: { ...request.distilled, singleStage },
              })}
            />
          ) : null}
          {request.models.layout === "split" ? (
            <>
              <PathPicker
                label={isDfr ? "LTX-2.5 DFR Direct Distilled Transformer" : "LTX-2.5 Transformer"}
                hint={isDfr
                  ? fieldHelp.dfrTransformer
                  : "Native BF16-Transformerdatei des offiziellen LTX-2.5-Split-Packs. Comfy-INT8 und NVFP4 sind erst nach einem getrennten Runtime-Nachweis zulässig."}
                value={request.models.transformerPath}
                options={isDfr
                  ? transformerOptions.filter((option) =>
                      option.path === dfrTransformerRecommendation?.localPath)
                  : transformerOptions}
                error={errors["models.transformerPath"]}
                placeholder={isDfr
                  ? "/absoluter/pfad/ltx-2.5-22b-distilled-transformer-bf16.safetensors"
                  : "/absoluter/pfad/ltx-2.5-22b-distilled-transformer-bf16.safetensors"}
                onChange={(transformerPath) => onChange({
                  ...request,
                  models: { ...request.models, transformerPath },
                })}
              />
              <PathPicker
                label="LTX-2.5 Textencoder"
                hint="Kombinierter Gemma-4-Textencoder mit LTX-2.5-Projektion als einzelne Safetensors-Datei."
                value={request.models.textEncoderPath}
                options={textEncoderOptions}
                error={errors["models.textEncoderPath"]}
                placeholder="/absoluter/pfad/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"
                onChange={(textEncoderPath) => onChange({
                  ...request,
                  models: { ...request.models, textEncoderPath },
                })}
              />
              {request.mode !== "text-to-audio" ? (
                <PathPicker
                  label="LTX-2.5 Video-VAE"
                  hint="Offizielle Video-VAE. Die Diffusions-VAE ist die Qualitätsreferenz; die Conv-VAE wird separat als Geschwindigkeitsarm bewertet."
                  value={request.models.videoVaePath}
                  options={videoVaeOptions}
                  error={errors["models.videoVaePath"]}
                  placeholder="/absoluter/pfad/ltx-2.5-video-vae-bf16.safetensors"
                  onChange={(videoVaePath) => onChange({
                    ...request,
                    models: { ...request.models, videoVaePath },
                  })}
                />
              ) : null}
              <PathPicker
                label="LTX-2.5 Audio-VAE"
                hint="Offizielle Audio-VAE samt Vocoder für den Split-Pack-Lauf."
                value={request.models.audioVaePath}
                options={audioVaeOptions}
                error={errors["models.audioVaePath"]}
                placeholder="/absoluter/pfad/ltx-2.5-audio-vae-bf16.safetensors"
                onChange={(audioVaePath) => onChange({
                  ...request,
                  models: { ...request.models, audioVaePath },
                })}
              />
              <PathPicker
                label="Duration-Head (optional)"
                hint="Optionaler offizieller Duration-Head. Ohne ihn bleibt die im Studio explizit gesetzte Framezahl maßgeblich."
                value={request.models.durationHeadPath}
                options={durationHeadOptions}
                error={errors["models.durationHeadPath"]}
                placeholder="/absoluter/pfad/ltx-2.5-duration-head-bf16.safetensors"
                onChange={(durationHeadPath) => onChange({
                  ...request,
                  models: { ...request.models, durationHeadPath },
                })}
              />
              {request.enhancePrompt ? (
                <PathPicker
                  label="Prompt-Enhancer Gemma Root"
                  hint="Separater Hugging-Face-Modellordner für die optionale Promptverbesserung; er ist nicht der LTX-Textencoder."
                  value={request.models.promptEnhancerGemmaRoot}
                  options={gemmaOptions}
                  error={errors["models.promptEnhancerGemmaRoot"]}
                  placeholder="/absoluter/pfad/gemma-4-enhancer"
                  onChange={(promptEnhancerGemmaRoot) => onChange({
                    ...request,
                    models: { ...request.models, promptEnhancerGemmaRoot },
                  })}
                />
              ) : null}
            </>
          ) : ["distilled", "keyframes"].includes(request.mode)
            || (request.mode === "ic-lora" && ["hdr", "union-control"].includes(request.icLora.profile))
            || (isLipDub && !officialComfyLipDub)
            || (request.mode === "retake" && request.retake.distilled) ? (
            <PathPicker
              label="Distilled Checkpoint"
              hint={fieldHelp.distilledCheckpoint}
              value={request.models.distilledCheckpointPath}
              options={distilledCheckpointOptions}
              error={errors["models.distilledCheckpointPath"]}
              placeholder="/absoluter/pfad/checkpoint.safetensors"
              onChange={(distilledCheckpointPath) => onChange({ ...request, models: { ...request.models, distilledCheckpointPath } })}
            />
          ) : (
            <PathPicker
              label="Checkpoint"
              hint={fieldHelp.checkpoint}
              value={request.models.checkpointPath}
              options={checkpointOptions}
              error={errors["models.checkpointPath"]}
              placeholder="/absoluter/pfad/checkpoint.safetensors"
              onChange={(checkpointPath) => onChange({ ...request, models: { ...request.models, checkpointPath } })}
            />
          )}
          {request.models.layout === "monolith"
          && (request.mode !== "ic-lora" || request.icLora.profile !== "hdr") ? (
            <PathPicker
              label="Gemma Root"
              hint={fieldHelp.gemmaRoot}
              value={request.models.gemmaRoot}
              options={gemmaOptions}
              error={errors["models.gemmaRoot"]}
              placeholder="/absoluter/pfad/gemma"
              onChange={(gemmaRoot) => onChange({ ...request, models: { ...request.models, gemmaRoot } })}
            />
          ) : null}
          {request.models.layout === "monolith" && supportsGemmaAbliteratedLoraForRequest(request) ? (
            <>
              <Toggle
                label="Optionale Gemma Abliterated LoRA"
                hint={fieldHelp.gemmaLora}
                checked={request.models.gemmaLora.enabled}
                onChange={(enabled) => onChange({
                  ...request,
                  models: {
                    ...request.models,
                    gemmaLora: { ...request.models.gemmaLora, enabled },
                  },
                })}
              />
              {needsGemmaAbliteratedLoraForRequest(request) ? (
                <div className="paired-field">
                  <PathPicker
                    label="Gemma Abliterated LoRA"
                    hint={fieldHelp.gemmaLora}
                    value={request.models.gemmaLora.path}
                    options={loraOptions.filter((option) => option.label.toLowerCase().includes("gemma"))}
                    error={errors["models.gemmaLora.path"]}
                    placeholder="/absoluter/pfad/gemma-lora.safetensors"
                    onChange={(path) => onChange({
                      ...request,
                      models: { ...request.models, gemmaLora: { ...request.models.gemmaLora, path } },
                    })}
                  />
                  <NumberField
                    label="Stärke"
                    hint={fieldHelp.gemmaLoraStrength}
                    min={0}
                    max={2}
                    step={0.05}
                    value={request.models.gemmaLora.strength}
                    onChange={(strength) => onChange({
                      ...request,
                      models: {
                        ...request.models,
                        gemmaLora: { ...request.models.gemmaLora, strength: strength ?? 1 },
                      },
                    })}
                  />
                </div>
              ) : null}
            </>
          ) : null}
          {(definition.needsSpatialUpscaler
            && !(request.mode === "distilled" && request.distilled.singleStage))
            || (request.mode === "ic-lora" && request.icLora.profile === "hdr") ? (
            <PathPicker
              label="Spatial Upscaler"
              hint={fieldHelp.spatialUpscaler}
              value={request.models.spatialUpscalerPath}
              options={request.models.layout === "split" ? ltx25UpscalerOptions : upscalerOptions}
              error={errors["models.spatialUpscalerPath"]}
              placeholder="/absoluter/pfad/upscaler.safetensors"
              onChange={(spatialUpscalerPath) => onChange({ ...request, models: { ...request.models, spatialUpscalerPath } })}
            />
          ) : null}
          {request.models.layout === "monolith" && ((definition.needsDistilledLora
            && !(request.mode === "ic-lora" && ["hdr", "union-control"].includes(request.icLora.profile)))
            || officialComfyLipDub) ? (
            <div className="paired-field">
              <PathPicker
                label="Distilled LoRA"
                hint={fieldHelp.distilledLora}
                value={request.models.distilledLora.path}
                options={loraOptions.filter((option) => option.label.toLowerCase().includes("distilled"))}
                error={errors["models.distilledLora.path"]}
                placeholder="/absoluter/pfad/lora.safetensors"
                onChange={(path) => onChange({ ...request, models: { ...request.models, distilledLora: { ...request.models.distilledLora, path } } })}
              />
              <NumberField
                label={isIdLora ? "Stärke in beiden ID-Stufen" : "Stärke"}
                hint={isIdLora
                  ? fieldHelp.idLoraDistilledStrength
                  : officialComfyLipDub
                    ? fieldHelp.lipDubDistilledLoraStrength
                    : fieldHelp.distilledLoraStrength}
                min={-4}
                max={4}
                step={0.05}
                value={isIdLora ? request.idLora.distilledLoraStrength : request.models.distilledLora.strength}
                onChange={(strength) => onChange(isIdLora
                  ? { ...request, idLora: { ...request.idLora, distilledLoraStrength: strength ?? 0.5 } }
                  : { ...request, models: { ...request.models, distilledLora: { ...request.models.distilledLora, strength: strength ?? 1 } } })}
              />
            </div>
          ) : null}
          {isLipDub ? (
            <div className="paired-field">
              <PathPicker
                label="LipDub IC-LoRA"
                hint={fieldHelp.lipDubLora}
                value={request.lipDub.lora.path}
                options={loraOptions.filter((option) => {
                  const label = option.label.toLowerCase();
                  return label.includes("lipdub") || label.includes("lip-dub");
                })}
                error={errors["lipDub.lora.path"]}
                placeholder="/absoluter/pfad/ltx-lipdub-lora.safetensors"
                onChange={(path) => onChange({
                  ...request,
                  lipDub: { ...request.lipDub, lora: { ...request.lipDub.lora, path } },
                })}
              />
              <NumberField
                label="Stärke"
                hint={fieldHelp.lipDubLoraStrength}
                min={-4}
                max={4}
                step={0.05}
                value={request.lipDub.lora.strength}
                onChange={(strength) => onChange({
                  ...request,
                  lipDub: { ...request.lipDub, lora: { ...request.lipDub.lora, strength: strength ?? 1 } },
                })}
              />
            </div>
          ) : null}
        </div>
        {recommendedLipDubMissing ? (
          <p className="advisory advisory--warning">
            Fehlt: {lipDubRecommendation.label} · {lipDubRecommendation.filename}. Quelle: {lipDubRecommendation.repoId};
            Zugriff ist gated und muss im Hugging-Face-Account freigegeben sein.
          </p>
        ) : null}
        {recommendedLipDubMismatch ? (
          <p className="advisory advisory--warning">
            Ausgewählt ist nicht das offizielle LipDub-LoRA für diese Pipeline: {lipDubRecommendation.label} · {lipDubRecommendation.filename}.
          </p>
        ) : null}
        {recommendedLipDubDistilledMissing ? (
          <p className="advisory advisory--warning">
            Empfohlen für LipDub: {lipDubDistilledRecommendation.label} · {lipDubDistilledRecommendation.filename}. Quelle: {lipDubDistilledRecommendation.repoId}.
          </p>
        ) : null}
        {recommendedLipDubDistilledMismatch ? (
          <p className="advisory advisory--warning">
            Ausgewählt ist nicht der zur offiziellen LipDub-Pipeline passende Distilled-Checkpoint: {lipDubDistilledRecommendation.label} · {lipDubDistilledRecommendation.filename}.
          </p>
        ) : null}
        {recommendedLipDubUpscalerMissing ? (
          <p className="advisory advisory--warning">
            Empfohlen für LipDub: {lipDubUpscalerRecommendation.label} · {lipDubUpscalerRecommendation.filename}. Quelle: {lipDubUpscalerRecommendation.repoId}.
          </p>
        ) : null}
        {recommendedLipDubUpscalerMismatch ? (
          <p className="advisory advisory--warning">
            Ausgewählt ist nicht der zur offiziellen LipDub-Pipeline passende Spatial-Upscaler: {lipDubUpscalerRecommendation.label} · {lipDubUpscalerRecommendation.filename}.
          </p>
        ) : null}
        {a2vStackMismatches.length > 0 ? (
          <p className="advisory advisory--warning">
            Der A2V-Entwurf weicht vom lokalen offiziellen LTX-2.3-Referenzstack ab: {a2vStackMismatches.join(", ")}.
          </p>
        ) : null}
        {a2vMissingAssets.length > 0 ? (
          <p className="advisory advisory--warning">
            Der offizielle LTX-2.3-A2V-Referenzstack ist lokal unvollständig: {a2vMissingAssets.join(", ")}.
            Ein automatisch gewähltes Ersatzmodell ist kein offizieller Referenzlauf.
          </p>
        ) : null}
        {missingLtx25Assets.length > 0 ? (
          <p className="advisory advisory--warning">
            Der gepinnte LTX-2.5-BF16-Stack ist lokal unvollständig: {missingLtx25Assets.map((asset, index) => (
              <span key={asset.id}>
                {index > 0 ? ", " : ""}
                {asset.revision && asset.sourcePath ? (
                  <a
                    href={`https://huggingface.co/${asset.repoId}/resolve/${asset.revision}/${asset.sourcePath}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {asset.label}
                  </a>
                ) : asset.label}
              </span>
            ))}. Quelle: Lightricks/LTX-2.5@{missingLtx25Assets[0]?.revision};
            Zugriff und Lizenz müssen vor dem Download im Hugging-Face-Account bestätigt sein.
          </p>
        ) : null}
        {modelInventory?.truncated ? (
          <p className="advisory advisory--warning">Der Modellscan erreichte seine Sicherheitsgrenze. Zusätzliche Modelle können weiterhin per Pfad gewählt werden.</p>
        ) : null}
        {modelInventory && modelInventory.errors.length > 0 ? (
          <p className="advisory advisory--warning">Mindestens ein konfiguriertes Modellverzeichnis war nicht lesbar.</p>
        ) : null}
        {!isLipDub ? (
          <details className="advanced-block">
            <summary>Weitere LoRAs <ChevronDown size={15} /></summary>
            <LoraRows
              loras={request.models.loras}
              options={userLoraOptions}
              onChange={(loras) => onChange({ ...request, models: { ...request.models, loras } })}
            />
            {hasDuplicateDfrDetailingLora(request) ? (
              <p className="section-error">
                Die verpflichtende DFR Detailing IC-LoRA ist bereits fest mit Stärke 0,5 gebunden und darf
                nicht nochmals unter den normalen LoRAs stehen.
              </p>
            ) : errors["models.loras"] ? <p className="section-error">{errors["models.loras"]}</p> : null}
          </details>
        ) : errors["models.loras"] ? <p className="section-error">{errors["models.loras"]}</p> : null}
      </section>

      {request.mode !== "retake" ? (
        <section className="editor-section">
          <SectionHeader title="Ausgabe" action={<SlidersHorizontal size={18} />} />
          <div className={`field-grid ${isLipDub || isTextToAudio ? "field-grid--1" : "field-grid--2"} output-presets`}>
            {!isTextToAudio ? (
              <SelectField
                label="Format-Preset"
                hint={fieldHelp.resolutionPreset}
                value={resolutionPreset?.id ?? "custom"}
                options={[
                  ...resolutionPresets.map((preset) => ({ value: preset.id, label: `${preset.label} · ${preset.width} × ${preset.height}` })),
                  { value: "custom", label: "Benutzerdefiniert" },
                ]}
                onChange={(id) => {
                  const preset = resolutionPresets.find((item) => item.id === id);
                  if (preset) onChange({ ...request, width: preset.width, height: preset.height });
                }}
              />
            ) : null}
            {!isLipDub ? (
              <SelectField
                label="Dauer-Preset"
                hint={fieldHelp.durationPreset}
                disabled={audioDerivesFrames}
                value={durationPreset === null ? "custom" : String(durationPreset)}
                options={[
                  ...DURATION_PRESETS.map((seconds) => ({ value: String(seconds), label: `${seconds} Sekunden · ${framesForDuration(seconds, request.frameRate)} Frames` })),
                  { value: "custom", label: "Benutzerdefiniert" },
                ]}
                onChange={(value) => {
                  if (value === "custom") return;
                  const seconds = Number(value);
                  onChange({
                    ...request,
                    numFrames: framesForDuration(seconds, request.frameRate),
                    longClipAcknowledged: seconds > 10 ? request.longClipAcknowledged : false,
                  });
                }}
              />
            ) : null}
          </div>
          <div className={isLipDub || isTextToAudio ? "field-grid field-grid--2" : "field-grid field-grid--4"}>
            {!isTextToAudio ? (
              <>
                <NumberField label="Breite" hint={fieldHelp.width} min={64} max={4096} step={32} value={request.width} error={errors.width} onChange={(width) => onChange({ ...request, width: width ?? 64 })} />
                <NumberField label="Höhe" hint={fieldHelp.height} min={64} max={4096} step={32} value={request.height} onChange={(height) => onChange({ ...request, height: height ?? 64 })} />
              </>
            ) : null}
            {!isLipDub ? (
              <>
                <NumberField
                  label={audioDerivesFrames ? "Effektive Frames" : isDfr ? "Basis-Frames" : "Frames"}
                  hint={audioDerivesFrames
                    ? "LTX v1.3 leitet diese Framezahl aus Maximaldauer, Audio-Start und EOF ab; sie ist nicht separat editierbar."
                    : fieldHelp.frames}
                  disabled={audioDerivesFrames}
                  min={1}
                  max={2049}
                  step={8}
                  value={audioDerivesFrames ? displayedFrames : request.numFrames}
                  error={errors.numFrames}
                  onChange={(numFrames) => {
                  const nextFrames = numFrames ?? 1;
                  onChange({
                    ...request,
                    numFrames: nextFrames,
                    longClipAcknowledged: videoDurationSeconds(nextFrames, request.frameRate) > 10
                      ? request.longClipAcknowledged
                      : false,
                  });
                  }}
                />
                <NumberField label={isDfr ? "Basis-FPS" : "FPS"} hint={fieldHelp.fps} min={1} max={120} step={isDfr ? 0.001 : 1} value={request.frameRate} error={errors.frameRate} onChange={(frameRate) => {
                  const nextFrameRate = frameRate ?? 24;
                  onChange({
                    ...request,
                    frameRate: nextFrameRate,
                    numFrames: durationPreset === null
                      ? request.numFrames
                      : framesForDuration(durationPreset, nextFrameRate),
                  });
                }} />
              </>
            ) : null}
          </div>
          <div className={`output-summary ${conservativeDuration > 20 ? "output-summary--warn" : ""}`}>
            <strong>
              {isLipDub
                ? "Referenzclip"
                : isTextToAudio
                  ? `Audio · ${formatDuration(duration)}`
                  : isAudioToVideo && audioDerivesFrames && !a2vTimeline?.exact
                    ? `Bis zu ${formatDuration(duration)}`
                    : formatDuration(duration)}
            </strong>
            <span>
              {isLipDub
                ? `${request.width} × ${request.height} · Dauer und FPS aus dem Referenzvideo`
                : isTextToAudio
                  ? `WAV · PCM 16 Bit · Sample-Peak ≤ ${request.textToAudio.peakCeilingDbfs} dBFS`
                  : isAudioToVideo
                    ? `${request.width} × ${request.height} · ${displayedFrames} Frames · ${request.frameRate} FPS · ${a2vSummaryBasis}`
                    : dfrOutput
                      ? `${dfrOutput.width} × ${dfrOutput.height} · ${dfrOutput.numFrames} Frames · ${dfrOutput.frameRate.toLocaleString("de-AT", { maximumFractionDigits: 6 })} FPS`
                      : `${request.width} × ${request.height} · ${request.numFrames} Frames · ${request.frameRate} FPS`}
            </span>
          </div>
          {isTextToAudio ? (
            <div className="field-grid field-grid--2">
              <NumberField
                label="Audio-Sample-Peak-Grenze (dBFS)"
                hint={fieldHelp.audioPeakCeiling}
                min={-20}
                max={-1}
                step={0.5}
                value={request.textToAudio.peakCeilingDbfs}
                error={errors["textToAudio.peakCeilingDbfs"]}
                onChange={(peakCeilingDbfs) => onChange({
                  ...request,
                  textToAudio: {
                    peakCeilingDbfs: peakCeilingDbfs ?? -3,
                  },
                })}
              />
            </div>
          ) : null}
          {!isLipDub && conservativeDuration > 10 ? (
            <Toggle
              label="Langclip bestätigt"
              hint={fieldHelp.longClip}
              checked={request.longClipAcknowledged}
              onChange={(longClipAcknowledged) => onChange({ ...request, longClipAcknowledged })}
            />
          ) : null}
          {errors.longClipAcknowledged ? <p className="section-error">{errors.longClipAcknowledged}</p> : null}
          {!isLipDub && conservativeDuration > 20 ? <p className="advisory advisory--warning">Mehr als 20 Sekunden sind ein experimenteller Lauf. Zuerst einen 5-Sekunden-Ausschnitt prüfen.</p> : null}
        </section>
      ) : null}

      <section className="editor-section">
        <SectionHeader title="Laufzeit" action={<Sparkles size={18} />} />
        <div className="field-grid field-grid--3">
          <div className="seed-field">
            <NumberField label="Seed" hint={fieldHelp.seed} min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={request.seed} onChange={(seed) => onChange({ ...request, seed: seed ?? 10 })} />
            <button
              type="button"
              className="icon-button"
              title="Neuen konkreten Zufalls-Seed erzeugen"
              onClick={() => {
                const value = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
                onChange({ ...request, seed: value });
              }}
            >
              <Dices size={17} />
            </button>
          </div>
          {supportsSteps ? (
            <NumberField label="Schritte" hint={fieldHelp.steps} min={1} max={200} step={1} value={request.numInferenceSteps} onChange={(numInferenceSteps) => onChange({ ...request, numInferenceSteps: numInferenceSteps ?? 1 })} />
          ) : null}
          <TextField label="Ausgabedatei" hint={fieldHelp.outputName} value={request.outputName} error={errors.outputName} onChange={(outputName) => onChange({ ...request, outputName })} />
        </div>
        {request.mode !== "one-stage" && !isDfr && !isLipDub && !isTextToAudio ? (
          <div className="toggle-grid">
            <Toggle label="VAE Tiling" hint={fieldHelp.tiling} checked={request.tiling} onChange={(tiling) => onChange({ ...request, tiling })} />
          </div>
        ) : null}
        <Segmented
          label="Quantisierung"
          hint={isDfr
            ? "Der gepinnte DFR-Qualifikationsarm verwendet ausschließlich BF16 ohne zusätzliche Runtime-Quantisierung."
            : fieldHelp.quantization}
          value={request.quantization.mode}
          options={isDfr
            ? [{ value: "none", label: "Aus · DFR BF16-Vertrag" }]
            : [
                { value: "none", label: "Aus" },
                { value: "fp8-cast", label: "FP8 Cast" },
                { value: "fp8-scaled-mm", label: "FP8 Scaled" },
              ]}
          onChange={(mode) => onChange({ ...request, quantization: { ...request.quantization, mode } })}
        />
        {request.mode === "two-stage-hq" ? (
          <div className="field-grid field-grid--2">
            <NumberField label="LoRA Stufe 1" hint={fieldHelp.hqLoraStage1} min={0} max={2} step={0.05} value={request.hq.distilledLoraStrengthStage1} onChange={(distilledLoraStrengthStage1) => onChange({ ...request, hq: { ...request.hq, distilledLoraStrengthStage1: distilledLoraStrengthStage1 ?? 0.25 } })} />
            <NumberField label="LoRA Stufe 2" hint={fieldHelp.hqLoraStage2} min={0} max={2} step={0.05} value={request.hq.distilledLoraStrengthStage2} onChange={(distilledLoraStrengthStage2) => onChange({ ...request, hq: { ...request.hq, distilledLoraStrengthStage2: distilledLoraStrengthStage2 ?? 0.5 } })} />
          </div>
        ) : null}
      </section>

      {guided ? (
        <section className="editor-section">
          <SectionHeader title="Guidance" />
          {guidanceKeys.map((key) => (
            <details className="advanced-block" key={key} open={key === "videoGuidance"}>
              <summary>{key === "videoGuidance" ? "Video" : "Audio"}<ChevronDown size={15} /></summary>
              <div className="field-grid field-grid--3">
                <NumberField label="CFG" hint={isTextToAudio ? fieldHelp.t2aCfg : fieldHelp.cfg} min={0} max={30} step={0.1} value={request[key].cfgScale} onChange={(value) => onChange(updateGuidance(request, key, "cfgScale", value ?? 0))} />
                <NumberField label="STG" hint={isTextToAudio ? fieldHelp.t2aStg : fieldHelp.stg} min={0} max={10} step={0.1} value={request[key].stgScale} onChange={(value) => onChange(updateGuidance(request, key, "stgScale", value ?? 0))} />
                <NumberField label="Rescale" hint={isTextToAudio ? fieldHelp.t2aRescale : fieldHelp.rescale} min={0} max={2} step={0.05} value={request[key].rescaleScale} onChange={(value) => onChange(updateGuidance(request, key, "rescaleScale", value ?? 0))} />
                {isTextToAudio ? null : (
                  <NumberField label="Modalität" hint={fieldHelp.modality} min={0} max={20} step={0.1} value={request[key].modalityScale} onChange={(value) => onChange(updateGuidance(request, key, "modalityScale", value ?? 0))} />
                )}
                <NumberField label="Skip Step" hint={fieldHelp.skipStep} min={0} max={20} step={1} value={request[key].skipStep} onChange={(value) => onChange(updateGuidance(request, key, "skipStep", value ?? 0))} />
                <TextField
                  label="STG Blocks"
                  hint={isTextToAudio ? fieldHelp.t2aStgBlocks : fieldHelp.stgBlocks}
                  value={request[key].stgBlocks.join(", ")}
                  onChange={(value) => onChange(updateGuidance(request, key, "stgBlocks", value.split(",").map((item) => Number.parseInt(item.trim(), 10)).filter(Number.isFinite)))}
                />
              </div>
            </details>
          ))}
        </section>
      ) : null}
    </main>
  );
}
