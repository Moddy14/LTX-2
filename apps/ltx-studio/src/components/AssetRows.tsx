import { Check, FileAudio, FileVideo, ImagePlus, LoaderCircle, Plus, Trash2, Upload } from "lucide-react";
import { type ChangeEvent, type ReactNode, useId, useRef, useState } from "react";

import type { GenerationRequest } from "../../shared/pipelines";
import { uploadFile } from "../api";
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
  const add = (file: UploadedFile) => {
    onPreview(file.path, file.url);
    onChange([
      ...images,
      { path: file.path, name: file.name, frameIndex: images.length === 0 ? 0 : images.length * 40, strength: 1, crf: 33 },
    ]);
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
            onChange={(value) => onChange(images.map((item, itemIndex) => (itemIndex === index ? { ...item, frameIndex: value ?? 0 } : item)))}
          />
          <NumberField
            label="Stärke"
            hint={fieldHelp.imageStrength}
            min={0}
            max={1}
            step={0.05}
            value={image.strength}
            onChange={(value) => onChange(images.map((item, itemIndex) => (itemIndex === index ? { ...item, strength: value ?? 1 } : item)))}
          />
          <NumberField
            label="CRF"
            hint={fieldHelp.imageCrf}
            min={0}
            max={51}
            step={1}
            value={image.crf}
            onChange={(value) => onChange(images.map((item, itemIndex) => (itemIndex === index ? { ...item, crf: value ?? 33 } : item)))}
          />
          <button
            type="button"
            className="icon-button icon-button--danger"
            title="Bild entfernen"
            onClick={() => onChange(images.filter((_, itemIndex) => itemIndex !== index))}
          >
            <Trash2 size={17} />
          </button>
        </div>
      ))}
    </div>
  );
}

type SingleMediaProps = {
  kind: "video" | "audio" | "mask";
  value: { path: string; name: string };
  label: string;
  onChange: (file: UploadedFile) => void;
  onClear: () => void;
  onPathChange: (path: string) => void;
  previewUrl?: string;
};

export function SingleMediaInput({ kind, value, label, onChange, onClear, onPathChange, previewUrl }: SingleMediaProps) {
  const accept = kind === "audio" ? "audio/*" : "video/*";
  const Icon = kind === "audio" ? FileAudio : FileVideo;
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
            <strong>{value.name}</strong>
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
            hint={kind === "audio" ? fieldHelp.audioUpload : kind === "mask" ? fieldHelp.maskUpload : fieldHelp.videoUpload}
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
