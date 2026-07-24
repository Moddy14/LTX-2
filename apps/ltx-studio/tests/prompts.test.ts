import { describe, expect, it } from "vitest";

import { composePromptFromParts, composePromptRequestSchema } from "../shared/prompts.js";

const input = composePromptRequestSchema.parse({
  mode: "two-stage",
  sourceMode: "image",
  currentPrompt: "",
  parts: {
    subject: "A red sports car",
    action: "drives through rain",
    environment: "Vienna at night",
    camera: "low tracking shot",
    lighting: "wet neon reflections",
    dialogue: "",
    ambience: "tires on wet asphalt",
    music: "no music",
  },
  continuity: { project: "Campaign A", notes: "Keep the exact car color." },
});

describe("local structured prompt composition", () => {
  it("requires source material", () => {
    expect(() => composePromptRequestSchema.parse({
      ...input,
      parts: Object.fromEntries(Object.keys(input.parts).map((key) => [key, ""])),
    })).toThrow();
  });

  it("combines visual, audio, and continuity notes in a stable order", () => {
    expect(composePromptFromParts(input)).toEqual({
      prompt: [
        "A red sports car.",
        "drives through rain.",
        "Vienna at night.",
        "low tracking shot.",
        "wet neon reflections.",
        "Ambient sound: tires on wet asphalt.",
        "Music: no music.",
        "Continuity: Keep the exact car color.",
      ].join(" "),
      warnings: [],
      model: "local-structured-prompt",
    });
  });

  it("keeps an existing prompt when no structured notes are present", () => {
    const fallback = composePromptRequestSchema.parse({
      ...input,
      currentPrompt: "A complete existing prompt.",
      parts: Object.fromEntries(Object.keys(input.parts).map((key) => [key, ""])),
      continuity: { project: "Internal project name", notes: "" },
    });
    expect(composePromptFromParts(fallback).prompt).toBe("A complete existing prompt.");
  });

  it("formats audio-to-video dialogue as exact spoken text with lip movement intent", () => {
    const audioInput = composePromptRequestSchema.parse({
      ...input,
      mode: "audio-to-video",
      parts: {
        ...input.parts,
        dialogue: "Das ist ein nativer LTX-Sprachtest",
        ambience: "",
        music: "",
      },
    });

    expect(composePromptFromParts(audioInput).prompt).toContain(
      'The speaking subject speaks clearly with natural lip movement, saying exactly: "Das ist ein nativer LTX-Sprachtest".',
    );
  });

  it("formats LipDub dialogue as exact spoken text with lip movement intent", () => {
    const lipdubInput = composePromptRequestSchema.parse({
      ...input,
      mode: "lipdub",
      parts: {
        ...input.parts,
        dialogue: "LipDub soll exakt diesem Satz folgen",
        ambience: "",
        music: "",
      },
    });

    expect(composePromptFromParts(lipdubInput).prompt).toContain(
      'The speaking subject speaks clearly with natural lip movement, saying exactly: "LipDub soll exakt diesem Satz folgen".',
    );
  });
});
