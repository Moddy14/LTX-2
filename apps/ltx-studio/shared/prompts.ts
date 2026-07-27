import { z } from "zod";

import { pipelineModes, promptPartsSchema, sourceModes } from "./pipelines.js";

const safeText = (maximum: number) => z.string().max(maximum).refine(
  (value) => !value.includes("\0"),
  { message: "NUL-Zeichen sind nicht erlaubt." },
);

export const composePromptRequestSchema = z.object({
  mode: z.enum(pipelineModes),
  sourceMode: z.enum(sourceModes),
  currentPrompt: safeText(16_000),
  parts: promptPartsSchema,
  continuity: z.object({
    project: safeText(120),
    notes: safeText(2_000),
  }),
}).strict().superRefine((value, context) => {
  const hasPart = Object.values(value.parts).some((part) => part.trim().length > 0);
  if (!hasPart && value.currentPrompt.trim().length === 0) {
    context.addIssue({
      code: "custom",
      path: ["parts", "subject"],
      message: "Mindestens ein Prompt-Baustein oder eine vorhandene Beschreibung ist erforderlich.",
    });
  }
});

export const composePromptResultSchema = z.object({
  prompt: safeText(16_000).pipe(z.string().trim().min(1)),
  warnings: z.array(safeText(500)).max(8),
  model: safeText(255),
});

export type ComposePromptRequest = z.infer<typeof composePromptRequestSchema>;
export type ComposePromptResult = z.infer<typeof composePromptResultSchema>;

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function dialogueLine(input: ComposePromptRequest): string {
  const dialogue = input.parts.dialogue.trim();
  if (!dialogue) return "";

  const explicitSpeech = /^["“]/.test(dialogue) || /\b(?:says|speaks|spricht|sagt|saying)\b/i.test(dialogue);
  const spokenText = explicitSpeech ? dialogue : `"${dialogue}"`;
  return `The speaking subject speaks clearly with natural lip movement, saying exactly: ${sentence(spokenText)}`;
}

export function composePromptFromParts(input: ComposePromptRequest): ComposePromptResult {
  const visual = [
    input.parts.subject,
    input.parts.action,
    input.parts.environment,
    input.parts.camera,
    input.parts.lighting,
  ].map(sentence).filter(Boolean);
  const audio = [
    dialogueLine(input),
    input.parts.ambience.trim() ? `Ambient sound: ${sentence(input.parts.ambience)}` : "",
    input.parts.music.trim() ? `Music: ${sentence(input.parts.music)}` : "",
  ].filter(Boolean);
  const continuity = input.continuity.notes.trim()
    ? [`Continuity: ${sentence(input.continuity.notes)}`]
    : [];
  const structured = [...visual, ...audio, ...continuity];
  const prompt = structured.length > 0 ? structured.join(" ") : input.currentPrompt.trim();

  return composePromptResultSchema.parse({
    prompt,
    warnings: [],
    model: "local-structured-prompt",
  });
}
