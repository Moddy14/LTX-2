import { Check, Crop, FileAudio, FileVideo, ImagePlus, LoaderCircle, Plus, Trash2, Upload, X } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import type { GenerationRequest } from "../../shared/pipelines";
import { prepareImageCrop, uploadFile } from "../api";
import { fieldHelp } from "../fieldHelp";
import type { UploadedFile } from "../types";
import { AssetLibrary } from "./AssetLibrary";
import { InfoTooltip, NumberField, PathPicker, TextField, type PathOption } from "./Controls";

type UploadButtonProps = {
  kind: UploadedFile["kind"];
  accept: string;
  label: string;
  hint: string;
  icon?: ReactNode;
  onUploaded: (file: UploadedFile) => void;
};

export function UploadButton({ kind, accept, label, hint, icon, onUploaded }: UploadButtonProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded(await uploadFile(kind, file));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="upload-control">
      <input ref={input} id={id} type="file" accept={accept} onChange={handleFile} hidden />
      <button type="button" className="button button--secondary" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={16} /> : (icon ?? <Upload size={16} />)}
        {label}
      </button>
      <InfoTooltip text={hint} />
      {error ? <span className="upload-control__error">{error}</span> : null}
    </span>
  );
}

type ImageRowsProps = {
  images: GenerationRequest["images"];
  onChange: (images: GenerationRequest["images"]) => void;
  onPreview: (path: string, url: string) => void;
  previews: Record<string, string>;
};

export function ImageRows({ images, onChange, onPreview, previews }: ImageRowsProps) {
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  const [cropIndex, setCropIndex] = useState<number | null>(null);
  const [cropValues, setCropValues] = useState({
    x: 0,
    y: 0,
    width: 576,
    height: 576,
    outputWidth: 576,
    outputHeight: 576,
  });
  const [cropBusy, setCropBusy] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropResult, setCropResult] = useState<string | null>(null);
  const add = (file: UploadedFile) => {
    onPreview(file.path, file.url);
    onChange([
      ...images,
      { path: file.path, name: file.name, frameIndex: images.length === 0 ? 0 : images.length * 40, strength: 1, crf: 33 },
    ]);
  };
  const openCrop = (index: number) => {
    setCropIndex(index);
    setCropValues({
      x: 0,
      y: 0,
      width: 576,
      height: 576,
      outputWidth: 576,
      outputHeight: 576,
    });
    setCropError(null);
    setCropResult(null);
  };
  const createCrop = async (index: number) => {
    const sourceImage = imagesRef.current[index];
    const sourcePath = sourceImage?.path;
    if (!sourcePath) {
      setCropError("Für den Zuschnitt fehlt ein Bildpfad.");
      return;
    }
    setCropBusy(true);
    setCropError(null);
    setCropResult(null);
    try {
      const prepared = await prepareImageCrop({ path: sourcePath, ...cropValues });
      if (!mountedRef.current) return;
      const current = imagesRef.current;
      if (cropIndex !== index || current[index] !== sourceImage) {
        setCropError("Ausschnitt erstellt, aber nicht übernommen: Die Quellreferenz wurde inzwischen geändert.");
        return;
      }
      onPreview(prepared.asset.path, prepared.asset.url);
      onChange(current.map((item, itemIndex) => itemIndex === index
        ? { ...item, path: prepared.asset.path, name: prepared.asset.name }
        : item));
      setCropResult(
        `Neues ${prepared.target.width} x ${prepared.target.height}-Asset aus `
        + `${prepared.crop.width} x ${prepared.crop.height} Pixeln erstellt.`,
      );
      setCropIndex(null);
    } catch (error) {
      if (mountedRef.current) {
        setCropError(error instanceof Error ? error.message : "Bildzuschnitt fehlgeschlagen.");
      }
    } finally {
      if (mountedRef.current) setCropBusy(false);
    }
  };

  return (
    <div className="asset-list">
      <div className="asset-list__toolbar">
        <UploadButton kind="image" accept="image/png,image/jpeg,image/webp" label="Bild hinzufügen" hint={fieldHelp.imageUpload} icon={<ImagePlus size={16} />} onUploaded={add} />
        <button
          type="button"
          className="button button--secondary"
          onClick={() => onChange([
            ...images,
            { path: "", name: `Bild ${images.length + 1}`, frameIndex: images.length * 40, strength: 1, crf: 33 },
          ])}
        >
          <Plus size={16} /> DGX-Pfad
        </button>
      </div>
      <AssetLibrary kind="image" label="Referenzmediathek" onSelect={add} />
      {images.length === 0 ? <div className="compact-empty">Keine Bildkonditionierung</div> : null}
      {images.map((image, index) => (
        <div className="asset-row" key={`${image.path}-${index}`}>
          <div className="asset-row__preview asset-row__preview--image">
            {previews[image.path] ? <img src={previews[image.path]} alt="" /> : <ImagePlus size={20} />}
          </div>
          <TextField
            label={image.name || `Bild ${index + 1}`}
            hint={fieldHelp.imagePath}
            value={image.path}
            disabled={cropBusy}
            placeholder="/absoluter/pfad/bild.png"
            onChange={(path) => onChange(images.map((item, itemIndex) =>
              itemIndex === index ? { ...item, path } : item,
            ))}
          />
          <NumberField
            label="Frame"
            hint={fieldHelp.imageFrame}
            min={0}
            step={1}
            value={image.frameIndex}
            disabled={cropBusy}
            onChange={(value) => onChange(images.map((item, itemIndex) => (itemIndex === index ? { ...item, frameIndex: value ?? 0 } : item)))}
          />
          <NumberField
            label="Stärke"
            hint={fieldHelp.imageStrength}
            min={0}
            max={1}
            step={0.05}
            value={image.strength}
            disabled={cropBusy}
            onChange={(value) => onChange(images.map((item, itemIndex) => (itemIndex === index ? { ...item, strength: value ?? 1 } : item)))}
          />
          <NumberField
            label="CRF"
            hint={fieldHelp.imageCrf}
            min={0}
            max={51}
            step={1}
            value={image.crf}
            disabled={cropBusy}
            onChange={(value) => onChange(images.map((item, itemIndex) => (itemIndex === index ? { ...item, crf: value ?? 33 } : item)))}
          />
          <button
            type="button"
            className="icon-button asset-row__crop"
            title="Reproduzierbaren Bildausschnitt erstellen"
            disabled={!image.path || cropBusy}
            onClick={() => cropIndex === index ? setCropIndex(null) : openCrop(index)}
          >
            <Crop size={17} />
          </button>
          <button
            type="button"
            className="icon-button icon-button--danger asset-row__delete"
            title="Bild entfernen"
            disabled={cropBusy}
            onClick={() => onChange(images.filter((_, itemIndex) => itemIndex !== index))}
          >
            <Trash2 size={17} />
          </button>
          {cropIndex === index ? (
            <div className="image-crop-tool">
              <div className="field-grid field-grid--3">
                <NumberField
                  label="Ausschnitt X"
                  hint={fieldHelp.imageCropX}
                  min={0}
                  step={1}
                  value={cropValues.x}
                  onChange={(x) => setCropValues((value) => ({ ...value, x: x ?? 0 }))}
                />
                <NumberField
                  label="Ausschnitt Y"
                  hint={fieldHelp.imageCropY}
                  min={0}
                  step={1}
                  value={cropValues.y}
                  onChange={(y) => setCropValues((value) => ({ ...value, y: y ?? 0 }))}
                />
                <NumberField
                  label="Ausschnitt Breite"
                  hint={fieldHelp.imageCropWidth}
                  min={64}
                  step={1}
                  value={cropValues.width}
                  onChange={(width) => setCropValues((value) => ({ ...value, width: width ?? 64 }))}
                />
                <NumberField
                  label="Ausschnitt Höhe"
                  hint={fieldHelp.imageCropHeight}
                  min={64}
                  step={1}
                  value={cropValues.height}
                  onChange={(height) => setCropValues((value) => ({ ...value, height: height ?? 64 }))}
                />
                <NumberField
                  label="Zielbreite"
                  hint={fieldHelp.imageCropOutputWidth}
                  min={64}
                  max={4096}
                  step={64}
                  value={cropValues.outputWidth}
                  onChange={(outputWidth) => setCropValues((value) => ({ ...value, outputWidth: outputWidth ?? 576 }))}
                />
                <NumberField
                  label="Zielhöhe"
                  hint={fieldHelp.imageCropOutputHeight}
                  min={64}
                  max={4096}
                  step={64}
                  value={cropValues.outputHeight}
                  onChange={(outputHeight) => setCropValues((value) => ({ ...value, outputHeight: outputHeight ?? 576 }))}
                />
              </div>
              <div className="image-crop-tool__actions">
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={cropBusy}
                  onClick={() => void createCrop(index)}
                >
                  {cropBusy ? <LoaderCircle className="spin" size={16} /> : <Crop size={16} />}
                  Ausschnitt erstellen
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Ausschnittwerkzeug schließen"
                  disabled={cropBusy}
                  onClick={() => setCropIndex(null)}
                >
                  <X size={17} />
                </button>
              </div>
              {cropError ? <p className="section-error" role="alert">{cropError}</p> : null}
            </div>
          ) : null}
        </div>
      ))}
      {cropResult ? <p className="advisory advisory--success">{cropResult}</p> : null}
    </div>
  );
}

type SingleMediaProps = {
  kind: "video" | "audio" | "mask";
  value: { path: string; name: string };
  label: string;
  hint?: string;
  onChange: (file: UploadedFile) => void;
  onClear: () => void;
  onPathChange: (path: string) => void;
  previewUrl?: string;
};

export function SingleMediaInput({
  kind,
  value,
  label,
  hint,
  onChange,
  onClear,
  onPathChange,
  previewUrl,
}: SingleMediaProps) {
  const accept = kind === "audio" ? "audio/*" : "video/*";
  const Icon = kind === "audio" ? FileAudio : FileVideo;
  const fieldHint = hint ?? (kind === "audio"
    ? fieldHelp.audioUpload
    : kind === "mask" ? fieldHelp.maskUpload : fieldHelp.videoUpload);
  const [pathDraft, setPathDraft] = useState("");
  return (
    <div className="single-media">
      {value.path ? (
        <>
          <div className="single-media__preview">
            {previewUrl ? (
              kind === "audio" ? <audio src={previewUrl} controls /> : <video src={previewUrl} controls muted />
            ) : (
              <Icon size={24} />
            )}
          </div>
          <div className="single-media__identity">
            <strong>{value.name} <InfoTooltip text={fieldHint} /></strong>
            <span>{value.path}</span>
          </div>
          <button type="button" className="icon-button icon-button--danger" title="Datei entfernen" onClick={onClear}>
            <Trash2 size={17} />
          </button>
        </>
      ) : (
        <div className="single-media__empty">
          <UploadButton
            kind={kind}
            accept={accept}
            label={label}
            hint={fieldHint}
            icon={<Plus size={16} />}
            onUploaded={onChange}
          />
          <div className="media-path-entry">
            <TextField
              label="Vorhandener DGX-Pfad"
              hint={kind === "mask" ? fieldHelp.maskPath : fieldHelp.mediaPath}
              value={pathDraft}
              placeholder="/absoluter/pfad/datei"
              onChange={setPathDraft}
            />
            <button
              type="button"
              className="icon-button"
              title="DGX-Pfad übernehmen"
              disabled={!pathDraft.trim()}
              onClick={() => onPathChange(pathDraft.trim())}
            >
              <Check size={17} />
            </button>
          </div>
          <AssetLibrary kind={kind} label="Aus Mediathek wählen" onSelect={onChange} />
        </div>
      )}
    </div>
  );
}

type LoraRowsProps = {
  loras: GenerationRequest["models"]["loras"];
  options: readonly PathOption[];
  onChange: (loras: GenerationRequest["models"]["loras"]) => void;
};

export function LoraRows({ loras, options, onChange }: LoraRowsProps) {
  return (
    <div className="asset-list">
      <div className="asset-list__toolbar">
        <button type="button" className="button button--secondary" onClick={() => onChange([...loras, { path: "", strength: 1 }])}>
          <Plus size={16} /> LoRA
        </button>
      </div>
      {loras.length === 0 ? <div className="compact-empty">Keine zusätzlichen LoRAs</div> : null}
      {loras.map((lora, index) => (
        <div className="lora-row" key={index}>
          <PathPicker
            label={`LoRA ${index + 1}`}
            hint={fieldHelp.loraPath}
            value={lora.path}
            options={options}
            placeholder="/absoluter/pfad/modell.safetensors"
            onChange={(path) => onChange(loras.map((item, itemIndex) => (itemIndex === index ? { ...item, path } : item)))}
          />
          <NumberField
            label="Stärke"
            hint={fieldHelp.loraStrength}
            min={-4}
            max={4}
            step={0.05}
            value={lora.strength}
            onChange={(strength) => onChange(loras.map((item, itemIndex) => (itemIndex === index ? { ...item, strength: strength ?? 1 } : item)))}
          />
          <button type="button" className="icon-button icon-button--danger" title="LoRA entfernen" onClick={() => onChange(loras.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={17} />
          </button>
        </div>
      ))}
    </div>
  );
}
