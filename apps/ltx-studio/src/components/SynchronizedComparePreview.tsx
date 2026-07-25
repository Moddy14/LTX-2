import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useRef, useState } from "react";

import type { StudioOutput } from "../types";

type AudioSource = "left" | "right" | "muted";

function clock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

export function SynchronizedComparePreview({
  outputs,
  scores,
}: {
  outputs: [StudioOutput, StudioOutput];
  scores: [number | null, number | null];
}) {
  const leftRef = useRef<HTMLVideoElement>(null);
  const rightRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSource>("left");

  const videos = () => [leftRef.current, rightRef.current].filter(
    (video): video is HTMLVideoElement => Boolean(video),
  );

  const syncTo = (time: number) => {
    const bounded = Math.min(Math.max(0, time), duration || Number.POSITIVE_INFINITY);
    videos().forEach((video) => {
      video.currentTime = bounded;
    });
    setCurrentTime(bounded);
  };

  const togglePlayback = async () => {
    const elements = videos();
    if (playing) {
      elements.forEach((video) => video.pause());
      setPlaying(false);
      return;
    }
    const anchor = leftRef.current?.currentTime ?? currentTime;
    syncTo(anchor);
    await Promise.allSettled(elements.map((video) => video.play()));
    setPlaying(elements.some((video) => !video.paused));
  };

  const step = (direction: -1 | 1) => {
    videos().forEach((video) => video.pause());
    setPlaying(false);
    const fps = Math.max(1, outputs[0].request?.frameRate ?? 24);
    syncTo((leftRef.current?.currentTime ?? currentTime) + direction / fps);
  };

  const updateDuration = () => {
    const known = videos()
      .map((video) => video.duration)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (known.length > 0) setDuration(Math.min(...known));
  };

  const followMaster = () => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left) return;
    setCurrentTime(left.currentTime);
    if (right && Math.abs(right.currentTime - left.currentTime) > 0.05) {
      right.currentTime = left.currentTime;
    }
    if (left.ended) setPlaying(false);
  };

  const selectAudio = (source: AudioSource) => {
    setAudioSource(source);
    if (leftRef.current) leftRef.current.muted = source !== "left";
    if (rightRef.current) rightRef.current.muted = source !== "right";
  };

  return (
    <div className="synchronized-compare">
      <div className="compare-preview">
        {outputs.map((output, index) => (
          <div className="compare-preview__item" key={output.name}>
            <video
              ref={index === 0 ? leftRef : rightRef}
              src={output.url}
              muted={audioSource !== (index === 0 ? "left" : "right")}
              playsInline
              preload="metadata"
              onLoadedMetadata={updateDuration}
              onTimeUpdate={index === 0 ? followMaster : undefined}
              onEnded={() => setPlaying(false)}
            />
            <span>
              {index === 0 ? "A" : "B"} · {output.name}
              {scores[index] !== null ? ` · ${scores[index]!.toFixed(1)}/10` : ""}
            </span>
          </div>
        ))}
      </div>
      <div className="synchronized-compare__controls" aria-label="Synchroner Videovergleich">
        <button type="button" className="icon-button" title="Ein Bild zurück" onClick={() => step(-1)}>
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className="icon-button synchronized-compare__play"
          title={playing ? "Beide Videos pausieren" : "Beide Videos synchron starten"}
          onClick={() => void togglePlayback()}
        >
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        <button type="button" className="icon-button" title="Ein Bild vor" onClick={() => step(1)}>
          <ChevronRight size={15} />
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={1 / Math.max(1, outputs[0].request?.frameRate ?? 24)}
          value={Math.min(currentTime, duration || 0)}
          aria-label="Gemeinsame Wiedergabeposition"
          onChange={(event) => syncTo(Number(event.target.value))}
        />
        <span className="synchronized-compare__clock">{clock(currentTime)} / {clock(duration)}</span>
        <div className="synchronized-compare__audio" aria-label="Vergleichston">
          <button
            type="button"
            className={audioSource === "left" ? "is-active" : ""}
            title="Ton von Video A"
            aria-pressed={audioSource === "left"}
            onClick={() => selectAudio("left")}
          >
            <Volume2 size={13} /> A
          </button>
          <button
            type="button"
            className={audioSource === "right" ? "is-active" : ""}
            title="Ton von Video B"
            aria-pressed={audioSource === "right"}
            onClick={() => selectAudio("right")}
          >
            <Volume2 size={13} /> B
          </button>
          <button
            type="button"
            className={audioSource === "muted" ? "is-active" : ""}
            title="Vergleich stummschalten"
            aria-pressed={audioSource === "muted"}
            onClick={() => selectAudio("muted")}
          >
            <VolumeX size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
