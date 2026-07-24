import {
  AudioLines,
  Blend,
  Clapperboard,
  Film,
  Gauge,
  Images,
  ScanLine,
  WandSparkles,
} from "lucide-react";

import { PIPELINES, type PipelineMode } from "../../shared/pipelines";

const icons = {
  "two-stage": Clapperboard,
  "two-stage-hq": WandSparkles,
  "one-stage": Gauge,
  distilled: Film,
  "ic-lora": ScanLine,
  keyframes: Images,
  "audio-to-video": AudioLines,
  retake: Blend,
} as const;

export function ModeRail({ active, onChange }: { active: PipelineMode; onChange: (mode: PipelineMode) => void }) {
  const groups = [
    { family: "generate", label: "Generieren" },
    { family: "condition", label: "Steuern" },
    { family: "edit", label: "Bearbeiten" },
  ] as const;

  return (
    <nav className="mode-rail" aria-label="Pipeline-Modus">
      {groups.map((group) => (
        <div className="mode-rail__group" key={group.family}>
          <div className="mode-rail__group-label">{group.label}</div>
          {PIPELINES.filter((pipeline) => pipeline.family === group.family).map((pipeline) => {
            const Icon = icons[pipeline.id];
            return (
              <button
                type="button"
                key={pipeline.id}
                className={`mode-button ${active === pipeline.id ? "is-active" : ""}`}
                onClick={() => onChange(pipeline.id)}
                aria-current={active === pipeline.id ? "page" : undefined}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{pipeline.shortLabel}</span>
                <small>{pipeline.quality}</small>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
