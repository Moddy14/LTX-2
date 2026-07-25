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

import { PIPELINES, type GenerationRequest } from "../../shared/pipelines";
import type { LipDubReferenceDiagnostics, PreparedLipDubReference } from "../../shared/plan";
import {
  DURATION_PRESETS,
  formatDuration,
  framesForDuration,
  matchingDurationPreset,
  matchingResolutionPreset,
  RESOLUTION_PRESETS,
  videoDurationSeconds,
} from "../../shared/presets";
import {
  inspectLipDubReference as inspectLipDubReferenceAsset,
  prepareLipDubReference as prepareLipDubReferenceAsset,
} from "../api";
import { fieldHelp } from "../fieldHelp";
import type { ModelInventory, ModelInventoryItem, UploadedFile } from "../types";
import { ImageRows, LoraRows, SingleMediaInput, UploadButton } from "./AssetRows";
import { AssetLibrary } from "./AssetLibrary";
import { Field, NumberField, PathPicker, SectionHeader, Segmented, SelectField, TextField, Toggle, type PathOption } from "./Controls";

type EditorProps = {
  request: GenerationRequest;
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
  { key: "dialogue", label: "Dialog", hint: fieldHelp.promptDialogue, placeholder: "Wörtliche Rede mit Sprecher, möglichst in Anführungszeichen..." },
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

export function Editor({
  request,
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
  const isAudioToVideo = request.mode === "audio-to-video";
  const guided = ["two-stage", "two-stage-hq", "one-stage", "keyframes", "audio-to-video", "retake"].includes(
    request.mode,
  ) && !(request.mode === "retake" && request.retake.distilled);
  const supportsSteps = !["distilled", "ic-lora", "lipdub"].includes(request.mode)
    && !(request.mode === "retake" && request.retake.distilled);
  const sourceSelectable = ["two-stage", "two-stage-hq", "one-stage", "distilled"].includes(request.mode);
  const imageEnabled = request.mode !== "retake" && !isLipDub && (!sourceSelectable || request.sourceMode === "image");
  const visibleTextIntent = /\b(text|schrift|logo|label|etikett|titel|wort|zeichen)\b/i.test(request.prompt);
  const dialogueIntent = request.promptParts.dialogue.trim().length > 0
    || /(?:dialogue|dialog|sagt|spricht|says|speaks|["“][^"”]{2,}["”])/i.test(request.prompt);
  const resolutionPreset = matchingResolutionPreset(request.width, request.height);
  const durationPreset = matchingDurationPreset(request.numFrames, request.frameRate);
  const duration = videoDurationSeconds(request.numFrames, request.frameRate);
  const discoveredModels = modelInventory?.items ?? [];
  const checkpointOptions = modelOptions(discoveredModels, "checkpoint");
  const distilledCheckpointOptions = modelOptions(discoveredModels, "distilled-checkpoint");
  const gemmaOptions = modelOptions(discoveredModels, "gemma");
  const upscalerOptions = modelOptions(discoveredModels, "spatial-upscaler");
  const loraOptions = modelOptions(discoveredModels, "lora");
  const lipDubRecommendation = modelInventory?.recommendations.find((item) => item.id === "lipdub-lora");
  const lipDubDistilledRecommendation = modelInventory?.recommendations.find((item) => item.id === "lipdub-distilled-checkpoint");
  const lipDubUpscalerRecommendation = modelInventory?.recommendations.find((item) => item.id === "lipdub-spatial-upscaler");
  const ltx23DevRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-dev-checkpoint");
  const ltx23GemmaRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-gemma");
  const ltx23DistilledLoraRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-distilled-lora");
  const ltx23UpscalerRecommendation = modelInventory?.recommendations.find((item) => item.id === "ltx23-spatial-upscaler");
  const a2vRecommendations = [
    ltx23DevRecommendation,
    ltx23GemmaRecommendation,
    ltx23DistilledLoraRecommendation,
    ltx23UpscalerRecommendation,
  ];
  const a2vMissingAssets = isAudioToVideo && modelInventory
    ? a2vRecommendations
        .flatMap((item) => item && !item.present ? [item.label] : [])
    : [];
  const a2vStackMismatches = isAudioToVideo
    ? [
        ltx23DevRecommendation?.present
          && request.models.checkpointPath !== ltx23DevRecommendation.localPath
          ? ltx23DevRecommendation.label
          : null,
        ltx23GemmaRecommendation?.present && request.models.gemmaRoot !== ltx23GemmaRecommendation.localPath
          ? ltx23GemmaRecommendation.label
          : null,
        ltx23DistilledLoraRecommendation?.present
          && request.models.distilledLora.path !== ltx23DistilledLoraRecommendation.localPath
          ? ltx23DistilledLoraRecommendation.label
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
    && lipDubDistilledRecommendation
    && !lipDubDistilledRecommendation.present
    && (!request.models.distilledCheckpointPath || request.models.distilledCheckpointPath !== lipDubDistilledRecommendation.localPath);
  const recommendedLipDubDistilledMismatch = isLipDub
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
    target: "audio" | "audio-final" | "retake" | "mask" | "lipdub",
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
  const guidanceKeys: Array<"videoGuidance" | "audioGuidance"> =
    request.mode === "audio-to-video" ? ["videoGuidance"] : ["videoGuidance", "audioGuidance"];

  return (
    <main className="editor">
      <section className="editor__title-band">
        <div>
          <span className="eyebrow">{definition.family === "edit" ? "Bearbeiten" : "Produktion"}</span>
          <h1>{definition.label}</h1>
        </div>
        <span className="quality-mark">{definition.quality}</span>
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
              })}
            />
            <p className="source-mode-note">
              {request.sourceMode === "image"
                ? "Referenzbild stabilisiert Motiv, Komposition und sichtbare Schrift."
                : "Freie Komposition ausschließlich aus dem Prompt."}
            </p>
          </>
        ) : null}
        <details className="structured-prompt">
          <summary>
            Prompt-Bausteine <ChevronDown size={15} />
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
        <Field label="Positive Beschreibung" hint={fieldHelp.prompt} error={errors.prompt}>
          <textarea
            className="prompt-input"
            aria-label="Positive Beschreibung"
            value={request.prompt}
            maxLength={16_000}
            placeholder="Szene, Bewegung, Kamera und Ton..."
            onChange={(event) => onChange({ ...request, prompt: event.target.value })}
          />
          <span className="character-count">{request.prompt.length.toLocaleString("de-AT")} / 16.000</span>
        </Field>
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
        {dialogueIntent ? (
          <p className="advisory advisory--warning">
            Dialog erkannt: LTX erzeugt eine neue Stimme. Eine exakte Sprecheridentität oder Stimmklon-Treue ist nicht garantiert;
            verwende nur freigegebene Stimmen und prüfe den Wortlaut im Ergebnis. Für eine feste vorhandene Tonspur nutze Audio zu Video.
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
            title={request.mode === "keyframes" ? "Keyframes" : sourceSelectable ? "Referenzbild" : "Bildkonditionierung"}
            action={<ImageIcon size={18} />}
          />
          <ImageRows
            images={request.images}
            previews={previews}
            onPreview={onPreview}
            onChange={(images) => onChange({ ...request, images })}
          />
          {errors.images ? <p className="section-error">{errors.images}</p> : null}
        </section>
      ) : null}

      {request.mode === "audio-to-video" ? (
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
        </section>
      ) : null}

      {isLipDub ? (
        <section className="editor-section">
          <SectionHeader title="LipDub Referenz" action={<FileVideo size={18} />} />
          <p className="advisory">
            Der offizielle LipDub-Modus erzeugt Video und Ton gemeinsam aus dem Referenzclip und dem neuen
            Zieltext. Er übernimmt keine separate Ziel-Audiodatei.
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
            action={
              <div className="section-header__actions">
                <UploadButton
                  kind="video"
                  accept="video/*"
                  label="Kontrollvideo"
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
                        { path: "", name: `Kontrollvideo ${request.icLora.videoConditioning.length + 1}`, strength: 1 },
                      ],
                    },
                  })}
                >
                  <Plus size={16} /> DGX-Pfad
                </button>
              </div>
            }
          />
          <AssetLibrary kind="video" label="Kontrollmediathek" onSelect={addControlVideo} />
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
          {errors["icLora.videoConditioning"] ? <p className="section-error">{errors["icLora.videoConditioning"]}</p> : null}
          <div className="mask-row">
            <SingleMediaInput
              kind="mask"
              label="Kontrollmaske"
              value={{ path: request.icLora.attentionMaskPath, name: request.icLora.attentionMaskPath.split("/").at(-1) ?? "" }}
              previewUrl={previews[request.icLora.attentionMaskPath]}
              onChange={(file) => applyUpload(file, "mask")}
              onClear={() => onChange({ ...request, icLora: { ...request.icLora, attentionMaskPath: "" } })}
              onPathChange={(attentionMaskPath) => onChange({
                ...request,
                icLora: { ...request.icLora, attentionMaskPath },
              })}
            />
            <NumberField
              label="Maskenstärke"
              hint={fieldHelp.maskStrength}
              min={0}
              max={1}
              step={0.05}
              value={request.icLora.attentionStrength}
              onChange={(attentionStrength) => onChange({ ...request, icLora: { ...request.icLora, attentionStrength: attentionStrength ?? 1 } })}
            />
          </div>
          <Toggle
            label="Stufe 2 überspringen"
            hint={fieldHelp.skipStage2}
            checked={request.icLora.skipStage2}
            onChange={(skipStage2) => onChange({ ...request, icLora: { ...request.icLora, skipStage2 } })}
          />
        </section>
      ) : null}

      <section className="editor-section">
        <SectionHeader title="Modelle" action={<Cpu size={18} />} />
        <div className="field-grid field-grid--2">
          {["distilled", "ic-lora", "lipdub"].includes(request.mode) || (request.mode === "retake" && request.retake.distilled) ? (
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
          <PathPicker
            label="Gemma Root"
            hint={fieldHelp.gemmaRoot}
            value={request.models.gemmaRoot}
            options={gemmaOptions}
            error={errors["models.gemmaRoot"]}
            placeholder="/absoluter/pfad/gemma"
            onChange={(gemmaRoot) => onChange({ ...request, models: { ...request.models, gemmaRoot } })}
          />
          {definition.needsSpatialUpscaler ? (
            <PathPicker
              label="Spatial Upscaler"
              hint={fieldHelp.spatialUpscaler}
              value={request.models.spatialUpscalerPath}
              options={upscalerOptions}
              error={errors["models.spatialUpscalerPath"]}
              placeholder="/absoluter/pfad/upscaler.safetensors"
              onChange={(spatialUpscalerPath) => onChange({ ...request, models: { ...request.models, spatialUpscalerPath } })}
            />
          ) : null}
          {definition.needsDistilledLora ? (
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
                label="Stärke"
                hint={fieldHelp.distilledLoraStrength}
                min={-4}
                max={4}
                step={0.05}
                value={request.models.distilledLora.strength}
                onChange={(strength) => onChange({ ...request, models: { ...request.models, distilledLora: { ...request.models.distilledLora, strength: strength ?? 1 } } })}
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
              options={loraOptions}
              onChange={(loras) => onChange({ ...request, models: { ...request.models, loras } })}
            />
            {errors["models.loras"] ? <p className="section-error">{errors["models.loras"]}</p> : null}
          </details>
        ) : errors["models.loras"] ? <p className="section-error">{errors["models.loras"]}</p> : null}
      </section>

      {request.mode !== "retake" ? (
        <section className="editor-section">
          <SectionHeader title="Ausgabe" action={<SlidersHorizontal size={18} />} />
          <div className={`field-grid ${isLipDub ? "field-grid--1" : "field-grid--2"} output-presets`}>
            <SelectField
              label="Format-Preset"
              hint={fieldHelp.resolutionPreset}
              value={resolutionPreset?.id ?? "custom"}
              options={[
                ...RESOLUTION_PRESETS.map((preset) => ({ value: preset.id, label: `${preset.label} · ${preset.width} × ${preset.height}` })),
                { value: "custom", label: "Benutzerdefiniert" },
              ]}
              onChange={(id) => {
                const preset = RESOLUTION_PRESETS.find((item) => item.id === id);
                if (preset) onChange({ ...request, width: preset.width, height: preset.height });
              }}
            />
            {!isLipDub ? (
              <SelectField
                label="Dauer-Preset"
                hint={fieldHelp.durationPreset}
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
          <div className={isLipDub ? "field-grid field-grid--2" : "field-grid field-grid--4"}>
            <NumberField label="Breite" hint={fieldHelp.width} min={64} max={4096} step={32} value={request.width} error={errors.width} onChange={(width) => onChange({ ...request, width: width ?? 64 })} />
            <NumberField label="Höhe" hint={fieldHelp.height} min={64} max={4096} step={32} value={request.height} onChange={(height) => onChange({ ...request, height: height ?? 64 })} />
            {!isLipDub ? (
              <>
                <NumberField label="Frames" hint={fieldHelp.frames} min={1} max={2049} step={8} value={request.numFrames} error={errors.numFrames} onChange={(numFrames) => {
                  const nextFrames = numFrames ?? 1;
                  onChange({
                    ...request,
                    numFrames: nextFrames,
                    longClipAcknowledged: videoDurationSeconds(nextFrames, request.frameRate) > 10
                      ? request.longClipAcknowledged
                      : false,
                  });
                }} />
                <NumberField label="FPS" hint={fieldHelp.fps} min={1} max={120} step={1} value={request.frameRate} onChange={(frameRate) => {
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
          <div className={`output-summary ${duration > 20 ? "output-summary--warn" : ""}`}>
            <strong>{isLipDub ? "Referenzclip" : formatDuration(duration)}</strong>
            <span>
              {isLipDub
                ? `${request.width} × ${request.height} · Dauer und FPS aus dem Referenzvideo`
                : `${request.width} × ${request.height} · ${request.numFrames} Frames · ${request.frameRate} FPS`}
            </span>
          </div>
          {!isLipDub && duration > 10 ? (
            <Toggle
              label="Langclip bestätigt"
              hint={fieldHelp.longClip}
              checked={request.longClipAcknowledged}
              onChange={(longClipAcknowledged) => onChange({ ...request, longClipAcknowledged })}
            />
          ) : null}
          {errors.longClipAcknowledged ? <p className="section-error">{errors.longClipAcknowledged}</p> : null}
          {!isLipDub && duration > 20 ? <p className="advisory advisory--warning">Mehr als 20 Sekunden sind ein experimenteller Lauf. Zuerst einen 5-Sekunden-Ausschnitt prüfen.</p> : null}
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
        {request.mode !== "one-stage" && !isLipDub ? (
          <div className="toggle-grid">
            <Toggle label="VAE Tiling" hint={fieldHelp.tiling} checked={request.tiling} onChange={(tiling) => onChange({ ...request, tiling })} />
          </div>
        ) : null}
        <Segmented
          label="Quantisierung"
          hint={fieldHelp.quantization}
          value={request.quantization.mode}
          options={[
            { value: "none", label: "Aus" },
            { value: "fp8-cast", label: "FP8 Cast" },
            { value: "fp8-scaled-mm", label: "FP8 Scaled" },
          ]}
          onChange={(mode) => onChange({ ...request, quantization: { ...request.quantization, mode } })}
        />
        {request.quantization.mode === "fp8-scaled-mm" ? (
          <TextField label="AMAX-Datei" hint={fieldHelp.amaxPath} value={request.quantization.amaxPath} error={errors["quantization.amaxPath"]} onChange={(amaxPath) => onChange({ ...request, quantization: { ...request.quantization, amaxPath } })} />
        ) : null}
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
                <NumberField label="CFG" hint={fieldHelp.cfg} min={0} max={30} step={0.1} value={request[key].cfgScale} onChange={(value) => onChange(updateGuidance(request, key, "cfgScale", value ?? 0))} />
                <NumberField label="STG" hint={fieldHelp.stg} min={0} max={10} step={0.1} value={request[key].stgScale} onChange={(value) => onChange(updateGuidance(request, key, "stgScale", value ?? 0))} />
                <NumberField label="Rescale" hint={fieldHelp.rescale} min={0} max={2} step={0.05} value={request[key].rescaleScale} onChange={(value) => onChange(updateGuidance(request, key, "rescaleScale", value ?? 0))} />
                <NumberField label="Modalität" hint={fieldHelp.modality} min={0} max={20} step={0.1} value={request[key].modalityScale} onChange={(value) => onChange(updateGuidance(request, key, "modalityScale", value ?? 0))} />
                <NumberField label="Skip Step" hint={fieldHelp.skipStep} min={0} max={20} step={1} value={request[key].skipStep} onChange={(value) => onChange(updateGuidance(request, key, "skipStep", value ?? 0))} />
                <TextField
                  label="STG Blocks"
                  hint={fieldHelp.stgBlocks}
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
