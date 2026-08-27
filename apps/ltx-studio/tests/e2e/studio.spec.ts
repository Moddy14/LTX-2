import { createHash, randomFillSync } from "node:crypto";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { firefox as codecFirefox } from "playwright-core";
import {
  BLIND_EVALUATION_LIMITATION,
  BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE,
  BLIND_EVALUATION_PADDING_BUCKET_BYTES,
  BLIND_EVALUATION_THREAT_MODEL,
  BLIND_EVALUATOR_SCOPE_COOKIE,
  blindEvaluationCommitmentPreimageSchema,
  blindEvaluationInitialPinSchema,
  blindEvaluationPublicSchema,
  blindEvaluationPublicStateSha256,
  blindEvaluationSubmissionPinSchema,
  createBlindEvaluationSubmissionPin,
  blindEvaluationTimelineRequirements,
  canonicalBlindEvaluationJson,
  verifyBlindEvaluationReveal,
  type BlindEvaluationPublic,
} from "../../shared/blindEvaluation.js";
import { createDefaultRequest, pipelineModes } from "../../shared/pipelines.js";
import { applyExperimentCandidate } from "../../shared/experiments.js";
import { validRequest } from "../fixtures.js";

const execFileAsync = promisify(execFile);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video", {
    timeout: 15_000,
  });
});

test("loads the experiment workspace only on explicit demand", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Experimente öffnen" })).toBeVisible();
  await expect(page.getByText("Experiment vorregistrieren", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Experimente öffnen" }).click();

  await expect(page.getByText("Experiment vorregistrieren", { exact: true })).toBeVisible();
});

test("upgrades only the untouched v1 auto-draft and keeps its legacy recovery path", async ({ page }) => {
  const legacyAutoDraft = createDefaultRequest("two-stage");
  await page.evaluate((draft) => {
    localStorage.removeItem("ltx-studio.request.v2");
    localStorage.setItem("ltx-studio.request.v1", JSON.stringify(draft));
  }, legacyAutoDraft);
  await page.reload();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offiziell LTX-2.5 Text / Bild zu Video");
  await expect(page.locator(".draft-migration-notice")).toContainText(
    "automatisch gespeicherte LTX-2.3-Startentwurf wurde unverändert archiviert",
  );

  await page.getByRole("button", { name: "Altentwurf exakt laden" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Legacy LTX-2.3 Text / Bild zu Video");
  await expect(page.locator(".draft-migration-notice")).toHaveCount(0);
});

test("archives a custom v1 draft and loads it only after explicit opt-in", async ({ page }) => {
  const customLegacyDraft = createDefaultRequest("two-stage");
  customLegacyDraft.prompt = "Mein gespeicherter und ausdrücklich beizubehaltender Legacy-Entwurf";
  customLegacyDraft.outputName = "custom-legacy-draft.mp4";
  await page.evaluate((draft) => {
    localStorage.removeItem("ltx-studio.request.v2");
    localStorage.setItem("ltx-studio.request.v1", JSON.stringify(draft));
  }, customLegacyDraft);
  await page.reload();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offiziell LTX-2.5 Text / Bild zu Video");
  await expect(page.getByLabel("Positive Beschreibung")).toHaveValue("");
  await expect(page.locator(".draft-migration-notice")).toContainText(
    "individuelle v1-Altentwurf wurde unverändert archiviert",
  );

  await page.getByRole("button", { name: "Altentwurf exakt laden" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Legacy LTX-2.3 Text / Bild zu Video");
  await expect(page.getByLabel("Positive Beschreibung")).toHaveValue(customLegacyDraft.prompt);
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue(customLegacyDraft.outputName);
});

test("creates and verifies a revision-bound production project from the lazy workspace", async ({ page }, testInfo) => {
  const projectRequest = validRequest("distilled");
  projectRequest.outputName = `project-ui-${testInfo.project.name}.mp4`;
  const draft = Buffer.from(JSON.stringify(projectRequest), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await expect(page.getByRole("button", { name: "Projekte öffnen" })).toBeVisible();
  await expect(page.getByText("Neues Projekt anlegen", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Projekte öffnen" }).click();
  await expect(page.getByText("Neues Projekt anlegen", { exact: true })).toBeVisible();
  await page.getByText("Neues Projekt anlegen", { exact: true }).click();

  const suffix = `${testInfo.project.name}-${Date.now()}`;
  await page.getByLabel("Projekttitel").fill(`Continuity ${suffix}`);
  await page.getByLabel("Projektbeschreibung").fill("Revisionsgebundener Cross-Shot-Test.");
  await page.getByRole("button", { name: "Projekt anlegen" }).click();
  await expect(page.getByText(`Continuity ${suffix}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/Revision 1 · aktiv/)).toBeVisible();

  await page.getByText("Aktuellen Editorstand als Shot hinzufügen", { exact: true }).click();
  await page.getByLabel("Shot-Titel").fill("Eröffnung");
  await page.getByRole("button", { name: "Shot revisionsgebunden anlegen" }).click();

  await expect(page.getByText("1. Eröffnung", { exact: true })).toBeVisible();
  await expect(page.getByText("Request R1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gebunden starten" })).toBeVisible();
  await page.getByRole("button", { name: "Kette prüfen" }).click();
  await expect(page.getByText("2 Revisionen vollständig und serverseitig geprüft.")).toBeVisible();
  await expect(page.getByText(/keine SOTA-Freigabe ohne P4-Evidence/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("fails visibly when a lazy deploy chunk is no longer available", async ({ page }) => {
  await page.route("**/src/components/ExperimentPanel.tsx*", (route) => route.abort("failed"));

  await Promise.all([
    page.waitForEvent("framenavigated"),
    page.getByRole("button", { name: "Experimente öffnen" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Experimente öffnen" })).toBeVisible();
  await page.getByRole("button", { name: "Experimente öffnen" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Experimentansicht konnte nach dem Deploywechsel nicht geladen werden.",
  );
  await expect(page.getByRole("button", { name: "Studio aktualisieren" })).toBeVisible();
});

test("desktop exposes every production mode and contextual controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop-only density assertions");
  const modes = page.locator(".mode-button");
  await expect(modes).toHaveCount(pipelineModes.length);
  await expect(page.locator(".run-button")).toBeVisible();
  await expect(page.getByText("Steuern", { exact: true })).toBeVisible();
  await expect(page.getByText("Bearbeiten", { exact: true })).toBeVisible();
  await expect(modes.nth(0)).toContainText("LTX 2.5");
  await expect(modes.nth(1)).toContainText("DFR");
  await expect(modes.nth(2)).toContainText("LTX 2.5 T2A");
  await expect(modes.nth(3)).toContainText("LTX 2.3");

  await page.getByRole("button", { name: "2.3 HQ Legacy · HQ" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Legacy LTX-2.3 HQ Zwei-Stufen");
  await expect(page.getByLabel("LoRA Stufe 1")).toBeVisible();

  await page.getByRole("button", { name: /Audio Experimentell/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio zu Video");
  await expect(page.getByRole("button", { name: "Sprachspur hochladen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finale Tonspur hochladen" })).toBeVisible();
  const guidanceSection = page.locator(".editor-section").filter({ has: page.getByRole("heading", { name: "Guidance" }) });
  await expect(guidanceSection.locator(".advanced-block")).toHaveCount(1);

  await page.locator(".mode-button").filter({ hasText: "LipDub" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Text-Redubbing");
  await expect(page.getByRole("heading", { name: "LipDub Referenz" })).toBeVisible();
  await expect(page.getByLabel("Zielsprache")).toBeVisible();
  await expect(page.getByLabel("Genau ein Sprecher bestätigt")).toBeVisible();
  await expect(page.getByRole("button", { name: "Offiziell Comfy HQ" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Checkpoint Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-dev.safetensors",
  );
  await expect(
    page.locator(".paired-field").filter({ has: page.getByLabel("Distilled LoRA Pfad") }).getByLabel("Stärke"),
  ).toHaveValue("0.5");
  await expect(page.getByLabel("LipDub IC-LoRA Pfad")).toBeVisible();
  await expect(page.getByLabel("Spatial Upscaler Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
  );
  const museTalk = page.getByLabel("MuseTalk 1.5 Lippen-Inpainting");
  const latentSync = page.getByLabel("LatentSync 1.6 Qualitätsrefiner");
  const lipForcing = page.getByLabel("LipForcing 14B Lippenrefiner");
  await expect(museTalk).not.toBeChecked();
  await expect(lipForcing).not.toBeChecked();
  await lipForcing.check();
  await expect(page.getByRole("button", { name: "Maximale Qualität", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await museTalk.check();
  await expect(lipForcing).not.toBeChecked();
  await expect(page.getByRole("spinbutton", { name: "Kinn-Zugabe" })).toHaveValue("10");
  await expect(page.getByRole("spinbutton", { name: "Wangen-Schutzbreite" })).toHaveValue("90");
  await latentSync.check();
  await expect(museTalk).not.toBeChecked();
  await expect(latentSync).toBeChecked();

  await page.getByRole("button", { name: /Retake Nicht-destruktiv/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Retake / Bereich ersetzen");
  await expect(page.getByText("Video regenerieren", { exact: true })).toBeVisible();
  await expect(page.getByText("Audio regenerieren", { exact: true })).toBeVisible();
  const manualPath = page.getByRole("textbox", { name: "Vorhandener DGX-Pfad", exact: true });
  await manualPath.fill("/tmp/example-source.mp4");
  await expect(manualPath).toHaveValue("/tmp/example-source.mp4");
  await page.getByTitle("DGX-Pfad übernehmen").click();
  await expect(page.getByText("/tmp/example-source.mp4", { exact: true })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("studio-desktop.png"), fullPage: true });
});

test("DFR opens as an honest max-detail baseline without inherited lip refiners", async ({ page }) => {
  const previous = validRequest("image-audio-to-video");
  previous.postprocess.longcatLipsync.enabled = true;
  previous.postprocess.latentSync.enabled = true;
  previous.postprocess.museTalk.enabled = true;
  previous.postprocess.lipForcing.enabled = true;
  const draft = Buffer.from(JSON.stringify(previous), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);

  await page.getByRole("button", { name: "DFR Offiziell · Max-Detail" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LTX-2.5 DFR Max-Detail · v1.3.0");
  await expect(page.getByRole("heading", { name: "DFR Max-Detail", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "LTX-2.5 DFR Direct Distilled Transformer" })).toBeVisible();
  await expect(page.getByRole("textbox", {
    name: "DFR Detailing IC-LoRA · verpflichtend · Stärke 0,5",
  })).toBeVisible();
  await expect(page.getByLabel("Zeitliche Upscalings")).toHaveValue("0");
  await expect(page.getByLabel("Räumliche Upscalings")).toHaveValue("1");
  await expect(page.getByText(/DFR bleibt HOLD: Die verpflichtende Detailing IC-LoRA/)).toBeVisible();
  await expect(page.getByText(/DFR Distilled LoRA 450/)).toHaveCount(0);
  await expect(page.getByText(/Es nimmt keine vorhandene Audiodatei an/)).toBeVisible();
  await expect(page.getByLabel("LipForcing 14B Lippenrefiner")).toHaveCount(0);
  await expect(page.getByLabel("LatentSync 1.6 Qualitätsrefiner")).toHaveCount(0);
  await expect(page.getByLabel("MuseTalk 1.5 Lippen-Inpainting")).toHaveCount(0);
});

test("audio mode separates clean speech conditioning from the optional final mix", async ({ page }, testInfo) => {
  const audioMode = page.getByRole("button", { name: /Audio Experimentell/ });
  await audioMode.scrollIntoViewIfNeeded();
  await audioMode.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio zu Video");
  await expect(page.getByRole("button", { name: "Sprachspur hochladen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finale Tonspur hochladen" })).toBeVisible();

  const conditioningHelp = page.getByLabel(/Feldhilfe: Wofür: Diese Spur steuert die Mundbewegung/);
  await conditioningHelp.focus();
  await expect(conditioningHelp.getByRole("tooltip")).toContainText("klare Sprache ohne Musik");
  const finalMixHelp = page.getByLabel(/Feldhilfe: Wofür: Optionale fertige Tonspur/);
  await finalMixHelp.focus();
  await expect(finalMixHelp.getByRole("tooltip")).toContainText("gewünschter Musik und Atmosphäre");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("audio-conditioning-and-final-mix.png"), fullPage: true });
});

test("IC-LoRA defaults to an executable LTX-2.5 profile and keeps held/legacy profiles explicit", async ({ page }, testInfo) => {
  await page.locator(".mode-button").filter({ hasText: "IC-LoRA" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LTX-2.5 IC-LoRA Kontrolle");
  await expect(page.getByLabel("Aktive Modellgeneration")).toHaveText("LTX-2.5 · Split BF16");
  await expect(page.getByRole("button", { name: "Ingredients" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Zutaten-Referenzbild" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kontrollvideo" })).toHaveCount(0);
  await expect(page.getByLabel("Ingredients IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Ingredients/"
    + "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
  );
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Textencoder Pfad", exact: true })).toHaveValue("");
  await expect(page.getByLabel("Distilled LoRA Pfad")).toHaveCount(0);
  await expect(page.getByLabel("Optionale Gemma Abliterated LoRA")).toHaveCount(0);
  await expect(page.getByLabel("Gemma Abliterated LoRA Pfad")).toHaveCount(0);
  await expect(page.getByText(/Der gepinnte LTX-2\.5-BF16-Stack ist lokal unvollständig/)).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Breite" })).toHaveValue("960");
  await expect(page.getByRole("spinbutton", { name: "Höhe" })).toHaveValue("544");
  await expect(page.getByRole("spinbutton", { name: "FPS" })).toHaveValue("24");
  await page.screenshot({ path: testInfo.outputPath("ic-lora-ingredients-default.png"), fullPage: true });

  await page.getByRole("button", { name: "Union Control · HOLD" }).click();
  await expect(page.getByRole("button", { name: "Union Control · HOLD" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Kontrollvideo" })).toBeVisible();
  await expect(page.getByLabel("Union-Control IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Union-Control/"
    + "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
  );
  await expect(page.getByRole("spinbutton", { name: "Breite" })).toHaveValue("1280");
  await expect(page.getByRole("spinbutton", { name: "Höhe" })).toHaveValue("704");
  await expect(page.getByRole("spinbutton", { name: "FPS" })).toHaveValue("25");

  await page.getByRole("button", { name: "Ingredients" }).click();

  await expect(page.getByRole("button", { name: "Ingredients" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Zutaten-Referenzbild" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kontrollvideo" })).toHaveCount(0);
  await expect(page.getByLabel("Ingredients IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Ingredients/"
    + "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
  );
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("spinbutton", { name: "Breite" })).toHaveValue("960");
  await expect(page.getByRole("spinbutton", { name: "Höhe" })).toHaveValue("544");
  await expect(page.getByRole("spinbutton", { name: "FPS" })).toHaveValue("24");

  await page.getByRole("button", { name: "Motion Track" }).click();
  await expect(page.getByRole("heading", { name: "Bewegungs-Referenzbild" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Track-Video" })).toBeVisible();
  await expect(page.getByLabel("Motion-Track IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Motion-Track-Control/"
    + "ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors",
  );

  await page.getByRole("button", { name: "V2V Deblur · 2.5" }).click();
  await expect(page.getByLabel("Deblur V2V IC-LoRA (LTX-2.5) Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Deblur/"
    + "ltx-2.3-22b-ic-lora-deblur-0.9.safetensors",
  );
  await expect(page.getByLabel("Deblur-Stärke")).toHaveValue("1");

  await page.getByRole("button", { name: "LTX-2.3 Monolith" }).click();
  await expect(page.getByLabel("Aktive Modellgeneration")).toHaveText("LTX-2.3 · Monolith Legacy");
  await expect(page.getByRole("button", { name: "V2V Rasur · 2.3 Legacy" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Instant-Shave V2V IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Instant-Shave/"
    + "ltx-2.3-22b-ic-lora-instant-shave-0.9.safetensors",
  );

  await page.getByRole("button", { name: "Pixel x4" }).click();
  await expect(page.getByRole("heading", { name: "Bewegungs-Referenzbild" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quellvideo" })).toBeVisible();
  await expect(page.getByLabel("Pixel Spatial Upscaler x4 IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler/"
    + "ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x4-0.9.safetensors",
  );

  await page.getByRole("button", { name: "Inpainting" }).click();
  await expect(page.getByRole("button", { name: "Video zum Ausbessern" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inpainting-Maskenvideo" })).toBeVisible();
  await expect(page.getByLabel("In-/Outpainting IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-In-Outpainting/"
    + "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
  );
  await expect(page.getByRole("spinbutton", { name: "Breite" })).toHaveValue("1920");
  await expect(page.getByRole("spinbutton", { name: "Höhe" })).toHaveValue("1088");

  await page.getByRole("button", { name: "Outpainting" }).click();
  await expect(page.getByRole("button", { name: "Video zum Erweitern" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inpainting-Maskenvideo" })).toHaveCount(0);

  await page.getByRole("button", { name: "HDR", exact: true }).click();
  await expect(page.getByLabel("HDR IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-HDR/"
    + "ltx-2.3-22b-ic-lora-hdr-0.9.safetensors",
  );
  await expect(page.getByLabel("HDR-Szenen-Embeddings Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-HDR/"
    + "ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors",
  );
  await expect(page.getByLabel("Gemma Root Pfad")).toHaveCount(0);
  await expect(page.getByLabel("Distilled Checkpoint Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled-1.1.safetensors",
  );
  await expect(page.getByLabel("Spatial Upscaler Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
  );
  await expect(page.getByLabel("HDR hohe Zeitqualität")).not.toBeChecked();
});

test("official text-to-audio exposes a WAV workflow without video-only controls", async ({ page }, testInfo) => {
  await page.locator(".mode-button").filter({ hasText: "T2A" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offiziell LTX-2.5 Text zu Audio");
  await expect(page.getByLabel("Aktive Modellgeneration")).toHaveText("LTX-2.5 · Split BF16");
  await expect(page.getByLabel("Audio-Beschreibung")).toBeVisible();
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue("ltx-text-to-audio.wav");
  await expect(page.getByLabel("Audio-Sample-Peak-Grenze (dBFS)")).toHaveValue("-3");
  await expect(page.getByText("WAV · PCM 16 Bit · Sample-Peak ≤ -3 dBFS", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Textencoder Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Audio-VAE Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Aus", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Der gepinnte LTX-2\.5-BF16-Stack ist lokal unvollständig/)).toBeVisible();
  await expect(page.getByLabel("Format-Preset")).toHaveCount(0);
  await expect(page.getByLabel("Breite", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Lippen-Synchronität" })).toHaveCount(0);
  const guidanceSection = page.locator(".editor-section").filter({ has: page.getByRole("heading", { name: "Guidance" }) });
  await expect(guidanceSection.locator(".advanced-block")).toHaveCount(1);
  await expect(guidanceSection.getByText("Audio", { exact: true })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("official-text-to-audio.png"), fullPage: true });
});

test("official model binding stays on authority HOLD and prompt validation remains in context", async ({ page }) => {
  const prompt = page.getByLabel("Positive Beschreibung");
  const transformer = page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad", exact: true });
  const textEncoder = page.getByRole("textbox", { name: "LTX-2.5 Textencoder Pfad", exact: true });
  const outputName = page.getByLabel("Ausgabedatei");
  await expect(page.getByText(/Der gepinnte LTX-2\.5-BF16-Stack ist lokal unvollständig/)).toBeVisible();
  await prompt.fill("A deliberate camera move through a detailed workshop.");
  await expect(transformer).toHaveValue("");
  await expect(textEncoder).toHaveValue("");
  await expect(page.getByText("Authority HOLD", { exact: true })).toBeVisible();
  await expect(page.getByText("53 / 16.000", { exact: true })).toBeVisible();
  await outputName.fill("");
  await page.locator(".run-button").click();
  await expect(page.getByRole("alert")).toContainText(
    "Ausgabedatei muss mit einer Zahl oder einem Buchstaben beginnen",
  );
});

test("an unavailable experiment archive does not hide live DGX status or model inventory", async ({ page }) => {
  await page.route("**/api/experiments", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Historisches Experiment verwendet ein veraltetes Schema." }),
    });
  });
  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("Historisches Experiment verwendet ein veraltetes Schema.");
  await expect(page.getByTitle("Python Engine")).toHaveClass(/health-item--ok/);
  await expect(page.getByTitle("Verfügbarer Arbeitsspeicher; Startfreigabe erfolgt über die DGX-Queue"))
    .not.toContainText("Unbekannt");
  await expect(page.getByText("Authority HOLD", { exact: true })).toBeVisible();
  await expect(page.getByText(/Der gepinnte LTX-2\.5-BF16-Stack ist lokal unvollständig/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad", exact: true })).toBeVisible();
});

test("structured prompt, continuity, dialogue warning and presets are usable", async ({ page }) => {
  await page.getByText("Weitere Prompt-Bausteine", { exact: true }).click();
  await page.getByRole("textbox", { name: "Motiv", exact: true }).fill("Eine Restauratorin in einer Werkstatt");
  await page.getByRole("textbox", { name: "Gesprochener Text", exact: true }).fill(
    'Sie sagt: "Das Original bleibt erhalten."',
  );
  await expect(page.getByText("Dialog erkannt:")).toBeVisible();

  await page.getByText("Projekt und Kontinuität", { exact: true }).click();
  await page.getByLabel("Projektname").fill("Werkstatt-Serie");
  await page.getByLabel("Kontinuitätsnotizen").fill("Rote Schürze, Messinglampe links im Bild.");

  await page.getByLabel("Format-Preset").selectOption("production-portrait");
  await expect(page.getByLabel("Breite", { exact: true })).toHaveValue("1024");
  await expect(page.getByLabel("Höhe", { exact: true })).toHaveValue("1536");
  await page.getByLabel("Dauer-Preset").selectOption("10");
  await expect(page.getByRole("spinbutton", { name: "Frames", exact: true })).toHaveValue("241");
});

test("native dialogue keeps the latest split-pack and refuses a legacy fallback under authority HOLD", async ({ page }) => {
  await expect(page.getByText(/Der gepinnte LTX-2\.5-BF16-Stack ist lokal unvollständig/)).toBeVisible();
  await page.getByLabel("Gesprochener Text", { exact: true }).fill(
    "Dieser Satz aktiviert den offiziellen Sprachpfad.",
  );

  await expect(page.getByLabel("Aktive Modellgeneration")).toHaveText("LTX-2.5 · Split BF16");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Textencoder Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Video-VAE Pfad", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Audio-VAE Pfad", exact: true })).toHaveValue("");
  await expect(page.getByLabel("Distilled LoRA Pfad")).toHaveCount(0);
  await expect(page.getByLabel("Gemma Root Pfad")).toHaveCount(0);
  await expect(page.getByText("Authority HOLD", { exact: true })).toBeVisible();
});

test("prepared draft link fills the editor without starting a job", async ({ page }) => {
  const jobsBefore = await page.request.get("/api/jobs").then((response) => response.json());
  const draft = Buffer.from(JSON.stringify({
    prompt: "A prepared cinematic workshop scene.",
    negativePrompt: "flicker, unstable motion, malformed hands",
    seed: 23072026,
    outputName: "ltx-ready-test-20260723.mp4",
  }), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await expect(page.getByLabel("Positive Beschreibung")).toHaveValue("A prepared cinematic workshop scene.");
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue("ltx-ready-test-20260723.mp4");
  await expect(page).not.toHaveURL(/draft=/);
  const jobsAfter = await page.request.get("/api/jobs").then((response) => response.json());
  expect(jobsAfter.jobs).toHaveLength(jobsBefore.jobs.length);
});

test("explicit LongCat settings survive draft and local editor restoration", async ({ page }) => {
  const request = createDefaultRequest("audio-to-video");
  request.outputName = "longcat-restoration.mp4";
  request.images = [{
    path: "/inputs/face.png",
    name: "face.png",
    frameIndex: 0,
    strength: 1,
    crf: 33,
  }];
  request.audio.path = "/inputs/speech.wav";
  request.audio.name = "speech.wav";
  request.postprocess.longcatLipsync = {
    enabled: true,
    resolution: "720p",
    blend: 0.65,
  };
  const draft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");

  await page.goto(`/?draft=${draft}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio zu Video");
  await expect(page.getByLabel("LongCat-Lippenpass")).toBeChecked();
  await expect(page.getByLabel("LongCat-Auflösung")).toHaveValue("720p");
  await expect(page.getByLabel("Mund-Übergangsbreite")).toHaveValue("0.65");
  await page.reload();
  await expect(page.getByLabel("LongCat-Lippenpass")).toBeChecked();
  await expect(page.getByLabel("LongCat-Auflösung")).toHaveValue("720p");
});

test("controlled experiments freeze one variable before either arm can run", async ({ page }, testInfo) => {
  const request = createDefaultRequest("audio-to-video");
  request.prompt = "A controlled native A2V experiment.";
  request.outputName = "controlled-guidance.mp4";
  request.models.checkpointPath = "/models/checkpoint.safetensors";
  request.models.gemmaRoot = "/models/gemma";
  request.models.gemmaLora = { enabled: true, path: "/models/gemma-lora.safetensors", strength: 1 };
  request.models.spatialUpscalerPath = "/models/upscaler.safetensors";
  request.models.distilledLora = { path: "/models/distilled-lora.safetensors", strength: 1 };
  request.audio.path = "/inputs/speech.wav";
  request.audio.name = "speech.wav";
  request.videoGuidance.modalityScale = 5;

  const experimentId = "33333333-3333-4333-8333-333333333333";
  let experiment: ReturnType<typeof buildExperiment> | null = null;
  function buildExperiment(status: "draft" | "frozen") {
    const baseline = structuredClone(request);
    baseline.outputName = "controlled-guidance-exp-33333333-a.mp4";
    const candidate = applyExperimentCandidate(request, { variable: "a2v-guidance", value: 3 });
    candidate.outputName = "controlled-guidance-exp-33333333-b.mp4";
    return {
      schemaVersion: "ltx-studio-public-experiment.v1" as const,
      id: experimentId,
      title: "A2V Guidance 5 gegen 3",
      claimScope: "development" as const,
      status,
      kind: "ablation" as const,
      candidate: { variable: "a2v-guidance" as const, value: 3 },
      changedRequestPaths: ["videoGuidance.modalityScale"],
      createdAt: "2026-07-25T04:00:00.000Z",
      frozenAt: status === "frozen" ? "2026-07-25T04:01:00.000Z" : null,
      supersededAt: null,
      supersededReason: null,
      replacementExperimentId: null,
      baselineEvidence: null,
      protocolEqualityToken: status === "frozen" ? `eq1_${"a".repeat(32)}` : null,
      arms: [
        {
          arm: "baseline" as const,
          request: baseline,
          requestEqualityToken: `eq1_${"b".repeat(32)}`,
          settingsEqualityToken: `eq1_${"c".repeat(32)}`,
          jobId: null,
          attemptJobIds: [],
        },
        {
          arm: "candidate" as const,
          request: candidate,
          requestEqualityToken: `eq1_${"d".repeat(32)}`,
          settingsEqualityToken: `eq1_${"e".repeat(32)}`,
          jobId: null,
          attemptJobIds: [],
        },
      ] as const,
    };
  }

  await page.route(/\/api\/experiments$/, async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as {
        title: string;
        candidate: { variable: string; value: number };
      };
      expect(payload.title).toBe("A2V Guidance 5 gegen 3");
      expect(payload.candidate).toEqual({ variable: "a2v-guidance", value: 3 });
      experiment = buildExperiment("draft");
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ experiment }) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ experiments: experiment ? [experiment] : [] }),
    });
  });
  await page.route(`**/api/experiments/${experimentId}/freeze`, async (route) => {
    experiment = buildExperiment("frozen");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ experiment }) });
  });
  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        state: "ready",
        release: {
          sealed: false,
          verified: false,
          authorityIsolation: {
            status: "hold",
            mechanism: "unattested-development",
            reasonCode: "runtime-trust-unavailable",
          },
        },
        resources: {
          availableMemoryGiB: 96,
          totalMemoryGiB: 128,
          swapFreeGiB: 8,
          swapTotalGiB: 8,
          outputFreeGiB: 512,
        },
        engine: "available",
        analysisEngine: "available",
        orchestrator: "available",
        qwen: "ready",
        runtimeOverall: "ready",
        workloads: [],
        evaluators: {
          phonemeViseme: {
            status: "not-available",
            blockerCode: "manifest-missing",
            message: "Kein rechtlich freigegebener Phonem-/Visem-Evaluator konfiguriert.",
            productGo: "blocked",
            measurementReady: false,
            method: null,
          },
          t2aAudio: {
            status: "blocked",
            claimScope: null,
            blockerCode: "development-opt-in-required",
            message: "T2A-Audio-QA benoetigt in der Entwicklungs-Laufzeit ein ausdrueckliches Mess-Opt-in.",
            productGo: "blocked",
            measurementReady: false,
          },
        },
        queueDepth: 0,
        jobPersistence: { status: "ok", restartRequired: false },
      }),
    });
  });

  const draft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await page.getByRole("button", { name: "Experimente öffnen" }).click();
  await page.getByText("Experiment vorregistrieren", { exact: true }).click();
  await page.getByLabel("Kontrollierte Variable", { exact: true }).selectOption("lipforcing-enabled");
  await expect(page.getByText("Kandidat: LipForcing mit qualitativem Wan-VAE-Decoder")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Kandidatenwert", exact: true })).toHaveCount(0);
  await page.getByLabel("Kontrollierte Variable", { exact: true }).selectOption("a2v-guidance");
  await page.getByLabel("Experimentname").fill("A2V Guidance 5 gegen 3");
  await expect(page.getByLabel("Kontrollierte Variable", { exact: true })).toHaveValue("a2v-guidance");
  await expect(page.getByRole("spinbutton", { name: "Kandidatenwert", exact: true })).toHaveValue("3");
  await page.getByRole("button", { name: "Draft anlegen" }).click();
  await expect(page.getByText("A2V Guidance 5 gegen 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Einfrieren" }).click();
  await expect(page.getByText("Eingefroren", { exact: true })).toBeVisible();
  await expect(page.locator(".experiment-arms")).toContainText("A · 5");
  await expect(page.locator(".experiment-arms")).toContainText("B · 3");
  await expect(page.locator(".experiment-item__facts")).toContainText(`Seed ${request.seed}`);
  await expect(page.locator(".experiment-item__facts")).toContainText("LongCat aus");
  await expect(page.locator(".experiment-gates")).toContainText("Laut-/Lippenprüfung: nicht eingerichtet");
  await expect(page.locator(".experiment-gates")).toContainText("DGX-Queue entscheidet den Start automatisch");
  await expect(page.getByRole("button", { name: "Baseline starten" })).toBeVisible();
  await expect(page.getByText(/SOTA-Evidence bleibt bis zu allen Product-Gates blockiert/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".experiment-panel").screenshot({
    path: testInfo.outputPath("controlled-experiment-panel.png"),
  });
});

test("offers independent LipForcing decoder and delay variables only for an active refiner", async ({ page }) => {
  const request = createDefaultRequest("audio-to-video");
  request.prompt = "A controlled LipForcing timing experiment.";
  request.outputName = "controlled-lipforcing-timing.mp4";
  request.models.checkpointPath = "/models/checkpoint.safetensors";
  request.models.gemmaRoot = "/models/gemma";
  request.models.gemmaLora = { enabled: true, path: "/models/gemma-lora.safetensors", strength: 1 };
  request.models.spatialUpscalerPath = "/models/upscaler.safetensors";
  request.models.distilledLora = { path: "/models/distilled-lora.safetensors", strength: 1 };
  request.audio.path = "/inputs/speech.wav";
  request.audio.name = "speech.wav";

  const openExperimentVariables = async () => {
    await page.getByRole("button", { name: "Experimente öffnen" }).click();
    await page.getByText("Experiment vorregistrieren", { exact: true }).click();
    return page.getByLabel("Kontrollierte Variable", { exact: true });
  };
  const draftWithoutLipForcing = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${draftWithoutLipForcing}`);
  let variableSelect = await openExperimentVariables();
  await expect(variableSelect.locator('option[value="lipforcing-decoder"]')).toHaveCount(0);
  await expect(variableSelect.locator('option[value="lipforcing-mouth-delay-ms"]')).toHaveCount(0);
  await expect(variableSelect.locator('option[value="lipforcing-program-audio-delay-ms"]')).toHaveCount(0);

  request.postprocess.lipForcing.enabled = true;
  request.postprocess.lipForcing.decoder = "wan-vae";
  request.postprocess.lipForcing.mouthDelayMs = 125;
  request.postprocess.lipForcing.programAudioDelayMs = 175;
  const activeDraft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${activeDraft}`);
  variableSelect = await openExperimentVariables();
  await expect(variableSelect.locator('option[value="lipforcing-decoder"]'))
    .toHaveText("LipForcing: Decoder");
  await expect(variableSelect.locator('option[value="lipforcing-mouth-delay-ms"]'))
    .toHaveText("LipForcing: Modell-Steuerung (ms)");
  await expect(variableSelect.locator('option[value="lipforcing-program-audio-delay-ms"]'))
    .toHaveText("LipForcing: hörbarer Tonversatz (ms)");

  await variableSelect.selectOption("lipforcing-decoder");
  await expect(page.getByText(
    "Kandidat: Streaming-TAEHV (schneller, anderer Decoder). Wan-VAE ist die Qualitätsreferenz; Streaming-TAEHV ist der schnellere, andere Decoder. Welcher am konkreten Clip besser abschneidet, bleibt offen.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Kandidatenwert", exact: true })).toHaveCount(0);

  await variableSelect.selectOption("lipforcing-mouth-delay-ms");
  const mouthValue = page.getByRole("spinbutton", { name: "Modell-Steuerung des Kandidaten (ms)" });
  await expect(mouthValue).toHaveAttribute("min", "-500");
  await expect(mouthValue).toHaveAttribute("max", "500");
  await expect(mouthValue).toHaveAttribute("step", "1");
  await expect(mouthValue).toHaveValue("150");

  await variableSelect.selectOption("lipforcing-program-audio-delay-ms");
  const audioValue = page.getByRole("spinbutton", { name: "Hörbarer Tonversatz des Kandidaten (ms)" });
  await expect(audioValue).toHaveAttribute("min", "-500");
  await expect(audioValue).toHaveAttribute("max", "500");
  await expect(audioValue).toHaveAttribute("step", "1");
  await expect(audioValue).toHaveValue("200");

  request.postprocess.lipForcing.mouthDelayMs = 500;
  const upperEdgeDraft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${upperEdgeDraft}`);
  variableSelect = await openExperimentVariables();
  await variableSelect.selectOption("lipforcing-mouth-delay-ms");
  await expect(page.getByRole("spinbutton", { name: "Modell-Steuerung des Kandidaten (ms)" }))
    .toHaveValue("475");

  request.postprocess.lipForcing.decoder = "streaming-taehv";
  const streamingDraft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${streamingDraft}`);
  variableSelect = await openExperimentVariables();
  await variableSelect.selectOption("lipforcing-decoder");
  await expect(page.getByText(/Kandidat: Wan-VAE \(Qualitätsreferenz\).*bleibt offen\./)).toBeVisible();
});

test("experiment start check shows proven CPU-only audio reuse instead of DGX budgets", async ({ page }) => {
  const baseline = createDefaultRequest("audio-to-video");
  baseline.prompt = "A frozen LipForcing audio-only timing experiment.";
  baseline.outputName = "verified-lipforcing-baseline.mp4";
  baseline.models.checkpointPath = "/models/checkpoint.safetensors";
  baseline.models.gemmaRoot = "/models/gemma";
  baseline.models.gemmaLora = { enabled: true, path: "/models/gemma-lora.safetensors", strength: 1 };
  baseline.models.spatialUpscalerPath = "/models/upscaler.safetensors";
  baseline.models.distilledLora = { path: "/models/distilled-lora.safetensors", strength: 1 };
  baseline.audio.path = "/inputs/speech.wav";
  baseline.audio.name = "speech.wav";
  baseline.postprocess.lipForcing.enabled = true;
  baseline.postprocess.lipForcing.mouthDelayMs = 125;
  baseline.postprocess.lipForcing.programAudioDelayMs = 125;
  const candidate = structuredClone(baseline);
  candidate.outputName = "verified-lipforcing-candidate.mp4";
  candidate.postprocess.lipForcing.programAudioDelayMs = 150;
  const experimentId = "44444444-4444-4444-8444-444444444444";
  const baselineJobId = "55555555-5555-4555-8555-555555555555";
  const experiment = {
    schemaVersion: "ltx-studio-public-experiment.v1" as const,
    id: experimentId,
    title: "Hörbarer Tonversatz 125 gegen 150 ms",
    claimScope: "development" as const,
    status: "frozen" as const,
    kind: "ablation" as const,
    candidate: { variable: "lipforcing-program-audio-delay-ms" as const, value: 150 },
    changedRequestPaths: ["postprocess.lipForcing.programAudioDelayMs"],
    createdAt: "2026-08-25T10:00:00.000Z",
    frozenAt: "2026-08-25T10:01:00.000Z",
    supersededAt: null,
    supersededReason: null,
    replacementExperimentId: null,
    baselineEvidence: {
      outputName: baseline.outputName,
      jobId: baselineJobId,
      sizeBytes: 4_096,
      changedAt: "2026-08-25T09:00:00.000Z",
    },
    protocolEqualityToken: `eq1_${"b".repeat(32)}`,
    arms: [{
      arm: "baseline" as const,
      request: baseline,
      requestEqualityToken: `eq1_${"c".repeat(32)}`,
      settingsEqualityToken: `eq1_${"d".repeat(32)}`,
      jobId: baselineJobId,
      attemptJobIds: [baselineJobId],
    }, {
      arm: "candidate" as const,
      request: candidate,
      requestEqualityToken: `eq1_${"e".repeat(32)}`,
      settingsEqualityToken: `eq1_${"f".repeat(32)}`,
      jobId: null,
      attemptJobIds: [],
    }],
  };
  let experimentPreflightCalled = false;
  let genericPreflightCalled = false;
  await page.route(/\/api\/experiments(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ experiments: [experiment], warnings: [] }),
  }));
  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      outputs: [{
        name: baseline.outputName,
        url: `/api/outputs/${baseline.outputName}`,
        sizeBytes: 4_096,
        modifiedAt: "2026-08-25T09:00:00.000Z",
        changedAt: "2026-08-25T09:00:00.000Z",
        revisionToken: `eq1_${"1".repeat(32)}`,
        jobId: baselineJobId,
        jobStatus: "completed",
        request: baseline,
        settingsAvailable: true,
        qualityReview: null,
        analysis: null,
        provenanceSummary: {
          schemaVersion: "ltx-studio-public-output-provenance-summary.v1",
          status: "verified",
          capturedAt: "2026-08-25T09:00:30.000Z",
          verifiedAt: "2026-08-25T09:01:00.000Z",
          release: { sealed: true, verified: true },
          equality: {
            run: `eq1_${"2".repeat(32)}`,
            inputs: `eq1_${"3".repeat(32)}`,
            models: `eq1_${"4".repeat(32)}`,
            code: `eq1_${"5".repeat(32)}`,
            runtime: `eq1_${"6".repeat(32)}`,
          },
        },
        experiment: null,
        project: null,
        experimentRequestVerified: false,
      }],
    }),
  }));
  await page.route(`**/api/experiments/${experimentId}/runs/candidate/preflight`, async (route) => {
    experimentPreflightCalled = true;
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        checkedAt: "2026-08-25T10:02:00.000Z",
        verdict: "start-frei",
        executionClass: "cpu-only",
        notes: ["Baseline, Sidecar und Request sind serverseitig gebunden."],
        steps: [{
          label: "CPU-only Audio-Retime",
          estimatedMemoryGiB: 0,
          decision: "cpu-only-provenance-reuse",
          accepted: true,
          message: "Bildstrom kopiert; hörbarer Ton relativ um +25 ms verschoben.",
        }],
      }),
    });
  });
  await page.route("**/api/admission/preflight", async (route) => {
    genericPreflightCalled = true;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "wrong route" }) });
  });

  const draft = Buffer.from(JSON.stringify(baseline), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await page.getByRole("button", { name: "Experimente öffnen" }).click();
  await expect(page.getByText(experiment.title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Startprüfung" }).click();

  await expect(page.getByText(
    "Startprüfung: Der gebundene Bildstrom wird CPU-only übernommen; kein DGX-Lauf ist erforderlich.",
  )).toBeVisible();
  await expect(page.getByText(/CPU-only Audio-Retime · kein DGX-RAM/)).toBeVisible();
  await expect(page.getByText(/Gebundener CPU-only-Lauf/)).toBeVisible();
  await expect(page.locator(".experiment-item")).not.toContainText("66 GiB");
  await expect(page.locator(".experiment-item")).not.toContainText("52 GiB");
  expect(experimentPreflightCalled).toBe(true);
  expect(genericPreflightCalled).toBe(false);
});

test("LipDub live preflight surfaces plan findings before starting a job", async ({ page }, testInfo) => {
  const draftRequest = createDefaultRequest("lipdub");
  draftRequest.promptParts.dialogue = "Das ist ein kurzer LipDub Preflight Test";
  draftRequest.prompt = 'A single speaker says exactly: "Das ist ein kurzer LipDub Preflight Test".';
  draftRequest.outputName = "lipdub-preflight-test.mp4";
  draftRequest.models.distilledCheckpointPath = "/models/ltx-2.3-22b-distilled-1.1.safetensors";
  draftRequest.models.gemmaRoot = "/models/gemma";
  draftRequest.models.spatialUpscalerPath = "/models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors";
  draftRequest.lipDub.referenceVideo = { path: "/inputs/reference.mp4", name: "reference.mp4", strength: 1 };
  draftRequest.lipDub.lora = { path: "/models/lipdub.safetensors", strength: 1 };
  draftRequest.lipDub.targetLanguage = "Deutsch";
  draftRequest.lipDub.singleSpeakerAcknowledged = true;

  await page.route("**/api/jobs/plan", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      command: "python -m ltx_pipelines.dubit",
      outputPath: "/outputs/lipdub-preflight-test.mp4",
      pathErrors: ["LipDub IC-LoRA: nicht gefunden (/models/lipdub.safetensors)"],
      pathWarnings: ["Die native LipDub-Pipeline snappt 122 Referenzframes auf 121 Frames nach 8k+1; das Clipende kann dadurch wegfallen."],
      suggestions: [{
        id: "lipdub-reference-format",
        level: "info",
        label: "Format 768 x 1344 übernehmen",
        message: "Referenzvideo 720 x 1280; empfohlenes 64er-LipDub-Format 768 x 1344 mit möglichst geringer Seitenverhältnisdrift.",
        patch: { width: 768, height: 1344 },
      }],
    }),
  }));
  await page.route("**/api/lipdub/reference/inspect", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      status: "blocked",
      metadata: {
        width: 720,
        height: 1280,
        frames: 122,
        snappedFrames: 121,
        droppedFrames: 1,
        fps: 23.976,
        durationSeconds: 5.09,
        modelDurationSeconds: 5.01,
        hasAudio: true,
        dialogueWords: 7,
        dialogueWordsPerMinute: 83,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        constantFrameRate: true,
        audioCodec: "aac",
        audioSampleRate: 48000,
        audioChannels: 2,
        audioVideoDurationDeltaSeconds: 0,
        audioVideoStartDeltaSeconds: 0,
        videoStreamCount: 1,
        audioStreamCount: 1,
      },
      recommendedTarget: { width: 768, height: 1344, fps: 24 },
      findings: [
        {
          code: "dialogue-too-short",
          level: "error",
          message: "Der Dialog ist für die Referenzdauer zu kurz.",
        },
        {
          code: "frame-snap",
          level: "warning",
          message: "Die native LipDub-Pipeline würde einen Frame verwerfen.",
        },
      ],
    }),
  }));
  await page.route("**/api/lipdub/reference/prepare", (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      asset: {
        id: "11111111-2222-4333-8444-555555555555",
        path: "/uploads/video/reference-lipdub-prep.mp4",
        name: "reference-lipdub-prep.mp4",
        size: 123456,
        kind: "video",
        url: "/api/uploads/video/11111111-2222-4333-8444-555555555555.mp4",
        createdAt: "2026-07-24T16:30:00.000Z",
        derivation: null,
      },
      target: { width: 768, height: 1344, fps: 24, frames: 97, durationSeconds: 4.0416667 },
      trim: { startSeconds: 0, requestedDurationSeconds: 4.2 },
    }),
  }));

  const draft = Buffer.from(JSON.stringify(draftRequest), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "LipDub / Text-Redubbing",
    { timeout: 15_000 },
  );
  await expect(page.getByLabel("Zielsprache")).toHaveValue("Deutsch");
  await expect(page.getByLabel("Genau ein Sprecher bestätigt")).toBeChecked();
  await expect(page.getByText(/übernimmt keine separate Ziel-Audiodatei/)).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "LipDub IC-LoRA: nicht gefunden",
    { timeout: 15_000 },
  );
  await expect(page.locator(".run-warnings")).toContainText("snappt 122 Referenzframes");
  await expect(page.locator(".run-suggestions")).toContainText("empfohlenes 64er-LipDub-Format 768 x 1344");
  await page.getByRole("button", { name: "Format 768 x 1344 übernehmen" }).click();
  await expect(page.getByLabel("Breite", { exact: true })).toHaveValue("768");
  await expect(page.getByLabel("Höhe", { exact: true })).toHaveValue("1344");
  await expect(page.locator(".lipdub-diagnostics")).toContainText("122 → 121");
  await expect(page.locator(".lipdub-diagnostics")).toContainText("83 WPM");
  await page.locator("section.editor-section").filter({
    has: page.getByRole("heading", { name: "LipDub Referenz" }),
  }).screenshot({ path: testInfo.outputPath("lipdub-reference-diagnostics.png") });
  await page.getByRole("button", { name: "Kalibrierclip erstellen" }).click();
  const lipDubReference = page.locator("section.editor-section").filter({
    has: page.getByRole("heading", { name: "LipDub Referenz" }),
  });
  await expect(lipDubReference.locator(".single-media__identity strong")).toContainText(
    "reference-lipdub-prep.mp4",
    { timeout: 10_000 },
  );
  await expect(page.getByText(/Vorbereitete Referenz: 768 x 1344, 97 Frames @ 24 fps/)).toBeVisible();
});

test("stale LipDub reference preparation does not overwrite a changed editor mode", async ({ page }) => {
  const draftRequest = createDefaultRequest("lipdub");
  draftRequest.promptParts.dialogue = "Das ist ein kurzer LipDub Race Test";
  draftRequest.prompt = 'A single speaker says exactly: "Das ist ein kurzer LipDub Race Test".';
  draftRequest.lipDub.referenceVideo = { path: "/inputs/reference.mp4", name: "reference.mp4", strength: 1 };
  draftRequest.lipDub.targetLanguage = "Deutsch";
  draftRequest.lipDub.singleSpeakerAcknowledged = true;

  let releasePreparation: (() => void) | undefined;
  let capturedTrimDuration: number | undefined;
  await page.route("**/api/lipdub/reference/inspect", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      status: "ready",
      metadata: {
        width: 768,
        height: 1344,
        frames: 73,
        snappedFrames: 73,
        droppedFrames: 0,
        fps: 24,
        durationSeconds: 3.0416667,
        modelDurationSeconds: 3,
        hasAudio: true,
        dialogueWords: 7,
        dialogueWordsPerMinute: 104,
      },
      recommendedTarget: { width: 768, height: 1344, fps: 24 },
      findings: [],
    }),
  }));
  await page.route("**/api/lipdub/reference/prepare", async (route) => {
    capturedTrimDuration = (route.request().postDataJSON() as {
      trim?: { durationSeconds?: number };
    }).trim?.durationSeconds;
    await new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        asset: {
          id: "22222222-3333-4444-8555-666666666666",
          path: "/uploads/video/stale-lipdub-prep.mp4",
          name: "stale-lipdub-prep.mp4",
          size: 123456,
          kind: "video",
          url: "/api/uploads/video/22222222-3333-4444-8555-666666666666.mp4",
          createdAt: "2026-07-24T16:40:00.000Z",
          derivation: null,
        },
        target: { width: 768, height: 1344, fps: 24, frames: 73, durationSeconds: 3.0416667 },
        trim: { startSeconds: 0, requestedDurationSeconds: 3.0416667 },
      }),
    });
  });

  const draft = Buffer.from(JSON.stringify(draftRequest), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Text-Redubbing");
  await expect(page.getByLabel("Clip-Länge")).toHaveValue("3.0416667");
  await page.getByRole("button", { name: "Kalibrierclip erstellen" }).click();
  await expect.poll(() => typeof releasePreparation === "function").toBe(true);
  expect(capturedTrimDuration).toBeCloseTo(3.0416667, 6);
  await page.getByRole("button", { name: "LTX 2.5 Offiziell · 8 + 3" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Offiziell LTX-2.5 Text / Bild zu Video",
  );
  const release = releasePreparation;
  if (!release) throw new Error("LipDub reference preparation request was not captured.");
  release();
  await expect(page.getByLabel("Breite", { exact: true })).toHaveValue("1536");
  await expect(page.getByLabel("Höhe", { exact: true })).toHaveValue("1024");
  await expect(page.getByText(/Vorbereitete Referenz: 768 x 1344/)).toHaveCount(0);
});

test("speech quality scorecard persists six ratings and remains usable on narrow screens", async ({ page }, testInfo) => {
  const request = createDefaultRequest("audio-to-video");
  request.outputName = "speech-quality-scorecard.mp4";
  request.promptParts.dialogue = "Dieser Satz prüft die Synchronität.";
  const output = {
    name: request.outputName,
    url: `/api/outputs/${request.outputName}`,
    sizeBytes: 1_048_576,
    modifiedAt: "2026-07-24T18:00:00.000Z",
    changedAt: "2026-07-24T18:00:01.000Z",
    revisionToken: `eq1_${"1".repeat(32)}`,
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    jobStatus: "completed",
    request,
    settingsAvailable: true,
    qualityReview: null as null | {
      scores: Record<string, number>;
      note: string;
      updatedAt: string;
    },
    analysis: null,
    provenanceSummary: null,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
  };
  let savedReview = output.qualityReview;
  let receivedBody: unknown;

  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outputs: [{ ...output, qualityReview: savedReview }] }),
  }));
  await page.route("**/api/outputs/*/quality-review", async (route) => {
    receivedBody = route.request().postDataJSON();
    savedReview = {
      ...(receivedBody as { scores: Record<string, number>; note: string }),
      updatedAt: "2026-07-24T18:05:00.000Z",
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ output: { ...output, qualityReview: savedReview } }),
    });
  });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Manuelle Qualitätsbewertung" })).toBeVisible();
  await page.getByLabel("LipSync Bewertung").fill("9");
  await page.getByLabel("Identität Bewertung").fill("8");
  await page.getByLabel("Mundnatürlichkeit Bewertung").fill("7");
  await page.getByLabel("Hautstabilität Bewertung").fill("6");
  await page.getByLabel("Bewegung Bewertung").fill("9");
  await page.getByLabel("Ton Bewertung").fill("10");
  await page.getByLabel("Qualitätsnotiz").fill("1,8 s: Lippen noch einen Frame zu spät.");
  await page.getByRole("button", { name: "Bewertung speichern" }).click();

  await expect(page.locator(".quality-scorecard__footer [role='status']")).toContainText("Bewertung gespeichert");
  expect(receivedBody).toEqual({
    scores: {
      lipSync: 9,
      identity: 8,
      mouthNaturalness: 7,
      skinStability: 6,
      motion: 9,
      audio: 10,
    },
    note: "1,8 s: Lippen noch einen Frame zu spät.",
  });
  await expect(page.locator(".quality-scorecard__summary")).toContainText("8.2 / 10");

  await page.reload();
  await expect(page.getByLabel("LipSync Bewertung")).toHaveValue("9");
  await expect(page.getByLabel("Qualitätsnotiz")).toHaveValue("1,8 s: Lippen noch einen Frame zu spät.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("speech-quality-scorecard.png"), fullPage: true });
});

test("objective speech analysis explains defects and prepares a targeted LipDub retry", async ({ page }, testInfo) => {
  const request = createDefaultRequest("lipdub");
  request.outputName = "speech-objective-analysis.mp4";
  request.promptParts.dialogue = "Bitte prüfe meine Lippen. Der Ton passt jetzt.";
  request.lipDub.referenceVideo = {
    path: "/inputs/reference.mp4",
    name: "reference.mp4",
    strength: 1,
  };
  const modifiedAt = "2026-07-24T18:00:00.000Z";
  const output = {
    name: request.outputName,
    url: `/api/outputs/${request.outputName}`,
    sizeBytes: 1_048_576,
    modifiedAt,
    changedAt: "2026-07-24T18:00:01.000Z",
    revisionToken: `eq1_${"2".repeat(32)}`,
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    jobStatus: "completed",
    request,
    settingsAvailable: true,
    qualityReview: null,
    analysis: null as null | Record<string, unknown>,
    provenanceSummary: null,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
  };
  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outputs: [output] }),
  }));
  await page.route("**/api/outputs/*/analysis", async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ force: false });
    output.analysis = {
      schemaVersion: "ltx-studio-public-output-analysis.v1",
      sourceSchemaVersion: "ltx-studio-output-analysis.v7",
      outputName: output.name,
      outputRevisionToken: output.revisionToken,
      jobId: output.jobId,
      analysisId: "3c8a5dc6-8864-49f7-a639-85caef919999",
      attempt: 1,
      status: "completed",
      progress: 100,
      createdAt: "2026-07-24T18:05:00.000Z",
      startedAt: "2026-07-24T18:05:01.000Z",
      finishedAt: "2026-07-24T18:05:02.000Z",
      updatedAt: "2026-07-24T18:05:02.000Z",
      error: null,
      equality: {
        evaluator: `eq1_${"3".repeat(32)}`,
        expectedDialogue: `eq1_${"4".repeat(32)}`,
        identityModel: `eq1_${"5".repeat(32)}`,
      },
      result: {
        schemaVersion: "ltx-studio-objective-quality.v7",
        analyzerVersion: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7",
        createdAt: "2026-07-24T18:05:02.000Z",
        status: "insufficient",
        technical: {
          durationSeconds: 10.041667,
          fps: 24,
          frames: 97,
          hasAudio: true,
          constantFrameRate: true,
          audioVideoDurationDeltaSeconds: 0.000667,
          audioVideoStartDeltaSeconds: 0,
        },
        face: {
          sampledFrames: 97,
          detectedFrames: 97,
          validGeometryFrames: 97,
          detectionCoverage: 1,
          geometryCoverage: 1,
          medianConfidence: 0.939,
          medianEyeSpanPixels: 74.26,
          medianFaceAreaRatio: 0.129,
          noseVelocityP95PerSecond: 2.324,
          noseAccelerationP95PerSecond2: 70.132,
          mouthAngleMedianDegrees: 1.243,
          mouthAngleVelocityP95DegreesPerSecond: 33.019,
          mouthSpanCoefficientOfVariation: 0.024,
          mouthSkinPairCount: 96,
          mouthSkinPairCoverage: 1,
          mouthSkinWarpResidualMedian: 0.018,
          mouthSkinWarpResidualP95: 0.041,
          mouthSkinLuminanceDeltaP95: 0.012,
          mouthSkinFlowDeformationP95: 0.067,
          mouthSkinValidPixelCoverageP10: 0.91,
        },
        identity: {
          status: "measured",
          error: null,
          modelName: "OpenCV SFace 2021dec",
          preprocessingVersion: "yunet5-aligncrop-112-track.v2",
          embeddingDimensions: 128,
          referenceCount: 1,
          sampledReferenceFrames: 1,
          embeddedReferenceFrames: 1,
          sampledOutputFrames: 97,
          matchedOutputFrames: 97,
          outputCoverage: 1,
          ambiguousOutputFrames: 0,
          referenceSelfConsistencyMedian: 1,
          referenceSelfConsistencyP10: 1,
          cosineMedian: 0.87,
          cosineP10: 0.849,
          cosineMinimum: 0.803,
          outputTemporalConsistencyMedian: 0.99,
        },
        avSync: {
          status: "measured",
          error: null,
          method: "classical-audio-mouth-motion.v1",
          sampledVideoFrames: 97,
          validMotionPairs: 96,
          motionCoverage: 1,
          audioWindowCount: 403,
          audioActivityRatio: 0.697,
          usableAudioActivitySeconds: 2.8,
          mouthCoverageDuringAudioActivity: 1,
          usableWindowCount: 5,
          estimatedAudioLeadMilliseconds: 20,
          lagSearchLimitMilliseconds: 500,
          lagResolutionMilliseconds: 42,
          effectiveVideoSampleMilliseconds: 41.667,
          correlationPeak: 0.351,
          zeroLagCorrelation: 0.279,
          peakProminence: 0.107,
          peakWidthMilliseconds: 42,
          featureLagAgreementMilliseconds: 42,
          windowLagIqrMilliseconds: 42,
          nullP95Correlation: 0.21,
        },
        conditioningAvSync: null,
        dialogue: {
          status: "measured",
          blockerCode: "none",
          error: null,
          method: "whisper-small-guided-word-motion.v1",
          modelName: "OpenAI Whisper small",
          packageVersion: "20250625",
          detectedLanguage: "de",
          expectedWordCount: 8,
          recognizedWordCount: 8,
          recognizedTranscript: "Bitte prüfe meine Lippen. Der Turm passt jetzt.",
          wordErrorRate: 0.125,
          substitutions: 1,
          deletions: 0,
          insertions: 0,
          guidedAlignedWordCount: 8,
          guidedWordCoverage: 1,
          usableAlignedWordCount: 7,
          usableGuidedWordCoverage: 0.875,
          medianGuidedWordProbability: 0.941,
          p10GuidedWordProbability: 0.356,
          lowConfidenceAlignedWords: 1,
          alignmentStatus: "measured",
          alignmentError: null,
          timePrecisionMilliseconds: 20,
          audioStartRelativeVideoSeconds: 0,
          guidedWords: ["bitte", "prüfe", "meine", "lippen", "der", "ton", "passt", "jetzt"]
            .map((normalizedWord, index) => ({
              index,
              word: normalizedWord,
              normalizedWord,
              tokenIds: [index + 1],
              startSeconds: index * 0.3,
              endSeconds: index * 0.3 + 0.2,
              probability: normalizedWord === "ton" ? 0.026 : 0.95,
              usable: normalizedWord !== "ton",
            })),
          trackedWordCount: 7,
          mouthTrackedWordCoverage: 1,
          wordsWithMouthMotionRatio: 1,
          pauseMotionRatio: 0.486,
          estimatedWordActivityLeadMilliseconds: null,
          lagResolutionMilliseconds: 42,
          correlationPeak: 0.16,
          nullP95Correlation: 0.308,
          wordMotionProxyStatus: "measured",
        },
        phonemeViseme: {
          status: "measurement-only",
          blockerCode: "product-go-pending",
          error: "MFA/MediaPipe-Rohmessung erfasst; Product-GO bleibt blockiert.",
          preprocessingVersion: "mfa-mediapipe-de-pts.v1",
          visemeMapVersion: "viseme15-en-de.v1",
          gateVersion: null,
          productGo: {
            status: "blocked",
            reason: "Unabhängige Visemklassifikation und Holdout fehlen.",
          },
          offset: {
            status: "measured",
            gatePassed: false,
            estimatedOffsetMilliseconds: 42,
            confidence: 0.8,
          },
          content: {
            status: "insufficient",
            gatePassed: false,
            frameMacroF1: null,
            transitionF1: null,
          },
          measurement: {
            method: "mfa-mediapipe-de.v1",
            globalAvLagMilliseconds: 42,
            lagConfidence: 0.8,
            bilabialClosureF1: 0.75,
            openingCorrelation: 0.7,
            roundingCorrelation: 0.6,
            speechMotionRecall: 0.9,
            pauseLeakRatio: 0.1,
            phoneCoverage: 1,
            unknownPhones: [],
            faceTrackCoverage: 1,
            mouthTrackCoverage: 1,
            multiFaceFrameRatio: 0,
            medianBlurVariance: 100,
            yawP95Degrees: 5,
            pitchP95Degrees: 4,
            usableDurationSeconds: 4,
            sampledFrames: 96,
          },
        },
        capabilities: {
          avSync: "classical-av-raw-measured",
          conditioningAvSync: "provenance-unavailable",
          phonemeViseme: "measurement-only",
          identity: "sface-raw-measured",
          dialogue: "whisper-word-measured",
        },
        findings: [{
          code: "calibration-required",
          level: "info",
          message: "Dynamikwerte sind Rohmessungen und benötigen lokale Kontrollen.",
        }],
        limitations: ["YuNet misst Stabilität, aber keine Phonem-Mund-Synchronität."],
      },
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ analysis: output.analysis }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Objektiv analysieren" }).click();
  await expect(page.getByRole("heading", { name: "Objektive Ausgabeanalyse" })).toBeVisible();
  await expect(page.locator(".objective-analysis__status")).toHaveText(
    "Lip-Sync gemessen (Teilfenster) · keine Product-GO-Freigabe",
  );
  await expect(page.locator(".objective-analysis__measurement-window")).toContainText(
    "Messfenster 4,0 von 10,0 Sekunden (40 %)",
  );
  await expect(page.locator(".output-library__details")).toContainText(
    "Lip-Sync gemessen (Teilfenster) · keine Product-GO-Freigabe",
  );
  await expect(page.locator(".objective-analysis__verdict")).toContainText(
    "Lip-Sync gemessen · keine Product-GO-Freigabe",
  );
  await expect(page.locator(".objective-analysis__technical")).not.toHaveAttribute("open", "");
  await page.getByText("Technische Messwerte anzeigen", { exact: true }).click();
  const metricValue = (label: string) => page.locator(
    `.objective-analysis__metric[data-metric-label="${label}"] > strong`,
  );
  await expect(metricValue("Gesicht erkannt")).toHaveText("100 %");
  await expect(metricValue("AV-Dauerdifferenz")).toHaveText("1 ms");
  await expect(metricValue("Endmix-AV-Rohversatz")).toHaveText("20 ms");
  await expect(metricValue("Endmix-AV-Korrelation")).toHaveText("0.351");
  await expect(metricValue("Identität p10")).toHaveText("0.849");
  await expect(metricValue("Mundhaut-Texturrest p95×p95")).toHaveText("0.041");
  await expect(metricValue("Mundhaut-Flussdeformation p95×p95")).toHaveText("0.067");
  await expect(metricValue("Mundhaut-Pixelabdeckung p10")).toHaveText("91 %");
  await expect(metricValue("Dialog-Wortfehlerrate")).toHaveText("13 %");
  await expect(metricValue("Wörter mit Mundbewegung")).toHaveText("100 %");
  await expect(metricValue("Gemessener Zeitversatz")).toHaveText("42 ms");
  await expect(metricValue("P/B/M-Lippenschluss")).toHaveText("75 %");
  await expect(metricValue("Nicht erkannte Sprachlaute")).toHaveText("Keine");
  await expect(page.locator(".objective-analysis__metric .tooltip")).toHaveCount(54);
  const analysisPanelBox = await page.locator(".objective-analysis").boundingBox();
  expect(analysisPanelBox).not.toBeNull();
  for (const index of [0, 1]) {
    const metricTooltip = page.locator(".objective-analysis__metric").nth(index).locator(".tooltip");
    await metricTooltip.hover();
    const tooltipContent = metricTooltip.locator(".tooltip__content");
    await expect(tooltipContent).toContainText("Wofür:");
    const tooltipBox = await tooltipContent.boundingBox();
    expect(tooltipBox).not.toBeNull();
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(analysisPanelBox!.x);
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(
      analysisPanelBox!.x + analysisPanelBox!.width + 1,
    );
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  }
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("Rohproxy, Phonem offen");
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("Laut-/Lippenprüfung");
  await expect(page.locator(".objective-analysis__capabilities")).toContainText(
    "Gemessen · keine Product-GO-Freigabe",
  );
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("SFace Rohwerte");
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("Whisper-Wortmessung");
  await expect(page.locator(".objective-analysis__recommendation")).toContainText(
    "Referenzbindung von 1,00 auf 0,80 senken",
  );
  await page.getByRole("button", { name: "Verbesserten Versuch vorbereiten" }).click();
  await expect(page.getByRole("spinbutton", { name: "Referenzstärke", exact: true })).toHaveValue("0.8");
  await expect(page.getByLabel("Gesprochener Text", { exact: true })).toHaveValue(request.promptParts.dialogue);
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue("speech-objective-analysis-edit01.mp4");
  await expect(page.locator(".objective-analysis__prepared")).toContainText(
    "Vorbereitet mit Referenzbindung 0,80",
  );
  await expect(page.locator(".objective-analysis__actions")).toContainText("keine DGX-Modellbelegung");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("speech-objective-analysis.png"), fullPage: true });

  const measuredAnalysis = output.analysis;
  if (!measuredAnalysis) throw new Error("Objective analysis response was not captured.");
  output.analysis = { ...measuredAnalysis, status: "running", progress: 10, result: null };
  await page.reload();
  await expect(page.locator(".objective-analysis__progress")).toHaveText("CPU-Analyse läuft");
  await expect(page.locator(".objective-analysis__progress")).not.toContainText("%");

  output.analysis = {
    ...measuredAnalysis,
    status: "completed",
    progress: 100,
    result: {
      schemaVersion: "ltx-studio-objective-quality.v3",
      analyzerVersion: "ffprobe-yunet5-sface-avmotion.v3",
      createdAt: "2026-07-24T18:06:00.000Z",
      status: "insufficient",
      technical: {
        durationSeconds: 1,
        fps: 24,
        frames: 24,
        hasAudio: true,
        constantFrameRate: true,
        audioVideoDurationDeltaSeconds: null,
        audioVideoStartDeltaSeconds: 0,
      },
      face: {
        sampledFrames: 24,
        detectedFrames: 0,
        validGeometryFrames: 0,
        detectionCoverage: 0,
        geometryCoverage: 0,
        medianConfidence: null,
        medianEyeSpanPixels: null,
        medianFaceAreaRatio: null,
        noseVelocityP95PerSecond: null,
        noseAccelerationP95PerSecond2: null,
        mouthAngleMedianDegrees: null,
        mouthAngleVelocityP95DegreesPerSecond: null,
        mouthSpanCoefficientOfVariation: null,
      },
      identity: {
        status: "reference-provenance-missing",
        error: null,
        modelName: null,
        preprocessingVersion: null,
        embeddingDimensions: null,
        referenceCount: 0,
        sampledReferenceFrames: 0,
        embeddedReferenceFrames: 0,
        sampledOutputFrames: 0,
        matchedOutputFrames: 0,
        outputCoverage: 0,
        ambiguousOutputFrames: 0,
        referenceSelfConsistencyMedian: null,
        referenceSelfConsistencyP10: null,
        cosineMedian: null,
        cosineP10: null,
        cosineMinimum: null,
        outputTemporalConsistencyMedian: null,
      },
      avSync: {
        status: "insufficient",
        error: "Zu wenige kontinuierlich verfolgte Mundbewegungspaare.",
        method: "classical-audio-mouth-motion.v1",
        sampledVideoFrames: 24,
        validMotionPairs: 0,
        motionCoverage: 0,
        audioWindowCount: 98,
        audioActivityRatio: 0.65,
        usableAudioActivitySeconds: 0,
        mouthCoverageDuringAudioActivity: 0,
        usableWindowCount: 0,
        estimatedAudioLeadMilliseconds: null,
        lagSearchLimitMilliseconds: 500,
        lagResolutionMilliseconds: null,
        effectiveVideoSampleMilliseconds: null,
        correlationPeak: null,
        zeroLagCorrelation: null,
        peakProminence: null,
        peakWidthMilliseconds: null,
        featureLagAgreementMilliseconds: null,
        windowLagIqrMilliseconds: null,
        nullP95Correlation: null,
      },
      capabilities: {
        avSync: "classical-av-insufficient",
        identity: "reference-provenance-required",
        dialogue: "whisper-not-run",
      },
      findings: [{ code: "face-detection-incomplete", level: "error", message: "Kein Gesicht erkannt." }],
      limitations: ["YuNet konnte keine verwertbare Gesichtsgeometrie messen."],
    },
  };
  await page.reload();
  await expect(page.locator(".objective-analysis__status")).toHaveText("Prüfung unvollständig");
  await expect(page.locator(".output-library__details")).toContainText("Video gemessen, Lip-Sync nicht freigegeben");
  await expect(page.locator(".objective-analysis__metric").filter({ hasText: "AV-Dauerdifferenz" }).locator("strong")).toHaveText("Nicht messbar");
});

test("durable outputs provide a gated objective comparison after job history is pruned", async ({ page }, testInfo) => {
  const leftRequest = createDefaultRequest("audio-to-video");
  leftRequest.outputName = "comparison-a.mp4";
  leftRequest.images = [{
    path: "/inputs/reference.png",
    name: "reference.png",
    frameIndex: 0,
    strength: 1,
    crf: 33,
  }];
  leftRequest.audio.path = "/inputs/clean-vocals.wav";
  leftRequest.audio.name = "clean-vocals.wav";
  leftRequest.audio.finalMix.path = "/inputs/final-mix.wav";
  leftRequest.audio.finalMix.name = "final-mix.wav";
  leftRequest.videoGuidance.modalityScale = 5;
  const rightRequest = structuredClone(leftRequest);
  rightRequest.outputName = "comparison-b.mp4";
  rightRequest.videoGuidance.modalityScale = 3;

  const job = (id: string, request: typeof leftRequest) => ({
    experiment: {
      schemaVersion: "ltx-studio-public-experiment-run.v1",
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolEqualityToken: `eq1_${"3".repeat(32)}`,
      arm: request.outputName === leftRequest.outputName ? "baseline" : "candidate",
      kind: "ablation",
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestEqualityToken: `eq1_${"4".repeat(32)}`,
      requestEqualityToken: request.outputName === leftRequest.outputName
        ? `eq1_${"4".repeat(32)}`
        : `eq1_${"5".repeat(32)}`,
      baselineJobId: request.outputName === leftRequest.outputName
        ? null
        : "11111111-1111-4111-8111-111111111111",
      baselineOutputName: leftRequest.outputName,
    },
    id,
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: `/api/jobs/${id}/output`,
    createdAt: "2026-07-25T00:00:00.000Z",
    startedAt: "2026-07-25T00:00:01.000Z",
    finishedAt: "2026-07-25T00:10:00.000Z",
    progress: 100,
    error: null,
    logs: ["Pipeline beendet mit Code 0."],
    command: "python -m ltx_pipelines.a2vid",
    request,
    favorite: false,
    variantOf: null,
    runtimeMs: 599_000,
    cancelledBy: null,
    dgxJobId: `dgx-${id}`,
    thermalProfile: null,
  });
  const analysis = (
    outputName: string,
    jobId: string,
    outputRevisionToken: string,
    identityMedian: number,
    lagMs: number,
  ) => ({
    schemaVersion: "ltx-studio-public-output-analysis.v1",
    sourceSchemaVersion: "ltx-studio-output-analysis.v4",
    outputName,
    outputRevisionToken,
    jobId,
    analysisId: crypto.randomUUID(),
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: "2026-07-25T00:11:00.000Z",
    startedAt: "2026-07-25T00:11:01.000Z",
    finishedAt: "2026-07-25T00:11:02.000Z",
    updatedAt: "2026-07-25T00:11:02.000Z",
    error: null,
    equality: {
      evaluator: `eq1_${"6".repeat(32)}`,
      expectedDialogue: null,
      identityModel: `eq1_${"7".repeat(32)}`,
    },
    result: {
      schemaVersion: "ltx-studio-objective-quality.v4",
      analyzerVersion: "ffprobe-yunet5-sface-avmotion-pv.v4",
      status: "measured",
      technical: {
        audioVideoStartDeltaSeconds: 0,
        audioVideoDurationDeltaSeconds: 0,
      },
      face: {
        detectionCoverage: 1,
        geometryCoverage: 1,
        medianFaceAreaRatio: 0.14,
        noseVelocityP95PerSecond: 1.5,
        noseAccelerationP95PerSecond2: 42,
        mouthAngleMedianDegrees: 1.2,
        mouthAngleVelocityP95DegreesPerSecond: 18,
        mouthSpanCoefficientOfVariation: 0.04,
      },
      identity: {
        status: "measured",
        preprocessingVersion: "yunet5-aligncrop-112-track.v2",
        outputCoverage: 1,
        cosineMedian: identityMedian,
        cosineP10: identityMedian - 0.03,
        cosineMinimum: identityMedian - 0.08,
        outputTemporalConsistencyMedian: 0.989,
      },
      avSync: {
        status: "measured",
        estimatedAudioLeadMilliseconds: lagMs,
        lagResolutionMilliseconds: 42,
        correlationPeak: 0.38,
        nullP95Correlation: 0.25,
        peakProminence: 0.13,
        peakWidthMilliseconds: 42,
        featureLagAgreementMilliseconds: 42,
        windowLagIqrMilliseconds: 83,
        motionCoverage: 1,
        mouthCoverageDuringAudioActivity: 1,
        usableAudioActivitySeconds: 3.2,
        audioActivityRatio: 0.7,
      },
      findings: [],
      limitations: ["Rohproxy ohne Phonem-/Visem-Garantie."],
    },
  });
  const jobs = [
    job("11111111-1111-4111-8111-111111111111", leftRequest),
    job("22222222-2222-4222-8222-222222222222", rightRequest),
  ];
  const outputs = jobs.map((currentJob, index) => {
    const outputRevisionToken = `eq1_${String(index + 1).repeat(32)}`;
    return {
      name: currentJob.outputName,
      url: currentJob.outputUrl,
      sizeBytes: 1_048_576,
      modifiedAt: "2026-07-25T00:10:00.000Z",
      changedAt: "2026-07-25T00:10:01.000Z",
      revisionToken: outputRevisionToken,
      jobId: currentJob.id,
      jobStatus: "completed",
      request: currentJob.request,
      settingsAvailable: true,
      qualityReview: null,
      analysis: analysis(
        currentJob.outputName,
        currentJob.id,
        outputRevisionToken,
        index === 0 ? 0.842 : 0.855,
        index === 0 ? -333 : -42,
      ),
      provenanceSummary: {
        schemaVersion: "ltx-studio-public-output-provenance-summary.v1",
        status: "verified",
        capturedAt: "2026-07-25T00:00:00.000Z",
        verifiedAt: "2026-07-25T00:10:00.000Z",
        release: { sealed: true, verified: true },
        equality: {
          run: `eq1_${String(index + 3).repeat(32)}`,
          inputs: `eq1_${"a".repeat(32)}`,
          models: `eq1_${"b".repeat(32)}`,
          code: `eq1_${"c".repeat(32)}`,
          runtime: `eq1_${"d".repeat(32)}`,
        },
      },
      experiment: currentJob.experiment,
      project: null,
      experimentRequestVerified: true,
    };
  });

  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jobs: [] }),
  }));
  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outputs }),
  }));
  await page.route(/\/api\/experiments(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ experiments: [] }),
  }));
  await page.route("**/api/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: ":\n\n",
  }));
  await page.reload();

  await page.getByLabel("Erzeugte Ausgabe").selectOption("comparison-b.mp4");
  await page.getByTitle("Ausgabe zum Vergleich hinzufügen").click();
  await page.getByLabel("Erzeugte Ausgabe").selectOption("comparison-a.mp4");
  await page.getByTitle("Ausgabe zum Vergleich hinzufügen").click();

  await expect(page.getByRole("heading", { name: "Objektiver A/B-Vergleich" })).toBeVisible();
  await expect(page.locator(".objective-comparison__heading")).toContainText("Vergleichbar");
  await expect(page.locator(".objective-comparison__names span").nth(0)).toContainText("comparison-a.mp4");
  await expect(page.locator(".objective-comparison__names span").nth(1)).toContainText("comparison-b.mp4");
  await expect(page.getByRole("table", { name: "Abweichende Einstellungen" })).toContainText("A2V Guidance");
  await expect(page.getByRole("table", { name: "Abweichende Einstellungen" })).toContainText("5");
  await expect(page.getByRole("table", { name: "Abweichende Einstellungen" })).toContainText("3");
  await expect(page.getByRole("table", { name: "Objektive Messwertdifferenzen" })).toContainText("Identität Median");
  await expect(page.getByLabel("Synchroner Videovergleich")).toBeVisible();
  await expect(page.getByTitle("Beide Videos synchron starten")).toBeVisible();
  await expect(page.getByLabel("Gemeinsame Wiedergabeposition")).toBeVisible();
  await expect(page.getByLabel("Vergleichston")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("objective-ab-comparison.png"), fullPage: true });
});

test("explicit image-to-video mode requires and exposes a reference image", async ({ page }) => {
  await page.getByRole("button", { name: "Bild zu Video · empfohlen" }).click();
  await expect(page.getByRole("heading", { name: "Referenzbild" })).toBeVisible();
  await page.getByLabel("Positive Beschreibung").fill("A product label remains sharp while the camera moves.");
  await page.locator(".run-button").click();
  await expect(page.getByRole("alert")).toContainText("Für Bild-zu-Video ist ein Referenzbild erforderlich.");
});

test("image references expose a responsive provenance-bound crop tool", async ({ page }) => {
  const request = createDefaultRequest("two-stage");
  request.sourceMode = "image";
  request.images = [{
    path: "/inputs/portrait.png",
    name: "portrait.png",
    frameIndex: 0,
    strength: 1,
    crf: 33,
  }];
  const draft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);

  await page.getByTitle("Reproduzierbaren Bildausschnitt erstellen").click();
  for (const label of [
    "Ausschnitt X",
    "Ausschnitt Y",
    "Ausschnitt Breite",
    "Ausschnitt Höhe",
    "Zielbreite",
    "Zielhöhe",
  ]) {
    await expect(page.getByRole("spinbutton", { name: label, exact: true })).toBeVisible();
    await expect(page.locator(".field").filter({ has: page.getByRole("spinbutton", { name: label, exact: true }) })
      .locator(".tooltip")).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Ausschnitt erstellen", exact: true })).toBeVisible();
  await expect(page.getByTitle("Ausschnittwerkzeug schließen")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an in-flight image crop cannot overwrite an editor that has moved on", async ({ page }) => {
  let releaseCrop!: () => void;
  const cropPending = new Promise<void>((resolve) => {
    releaseCrop = resolve;
  });
  await page.route("**/api/images/crop", async (route) => {
    await cropPending;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        asset: {
          id: "a1b2c3d4-1111-4222-8333-123456789012",
          path: "/uploads/derived.png",
          name: "portrait-crop.png",
          size: 1024,
          kind: "image",
          url: "/api/uploads/image/a1b2c3d4-1111-4222-8333-123456789012.png",
          createdAt: "2026-07-25T00:00:00.000Z",
          derivation: null,
        },
        source: { width: 704, height: 1248 },
        crop: { x: 0, y: 0, width: 576, height: 576 },
        target: { width: 576, height: 576 },
        fit: "stretch",
        coverage: null,
        feather: null,
        scaleFilter: "lanczos",
      }),
    });
  });
  const request = createDefaultRequest("two-stage");
  request.sourceMode = "image";
  request.images = [{
    path: "/inputs/portrait.png",
    name: "portrait.png",
    frameIndex: 0,
    strength: 1,
    crf: 33,
  }];
  const draft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await page.getByTitle("Reproduzierbaren Bildausschnitt erstellen").click();
  await page.getByRole("button", { name: "Ausschnitt erstellen", exact: true }).click();

  await expect(page.getByLabel("portrait.png")).toBeDisabled();
  await expect(page.getByTitle("Bild entfernen")).toBeDisabled();
  const audioMode = page.getByRole("button", { name: /Audio Experimentell/ });
  await audioMode.scrollIntoViewIfNeeded();
  await audioMode.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio zu Video");
  releaseCrop();
  await page.waitForTimeout(100);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio zu Video");
});

test("field help explains purpose and recommended input", async ({ page }) => {
  const promptField = page.locator(".field").filter({ has: page.getByLabel("Positive Beschreibung") });
  const help = promptField.locator(".tooltip");

  await expect(help).toBeVisible();
  await help.hover();
  await expect(help.locator(".tooltip__content")).toBeVisible();
  await expect(help.locator(".tooltip__content")).toContainText("Wofür:");
  await expect(help.locator(".tooltip__content")).toContainText("Motiv, Handlung, Umgebung, Kamera");
  await expect(page.getByLabel("Höhe", { exact: true })).toBeVisible();

  expect(await page.locator(".field:visible:not(:has(.tooltip))").count()).toBe(0);
  expect(await page.locator(".toggle:visible:not(:has(.tooltip))").count()).toBe(0);
  expect(await page.locator(".segmented-field:visible:not(:has(.tooltip))").count()).toBe(0);
});

test("generated video picker exposes dialogue, restores settings, and deletes the output", async ({ page }) => {
  const stored = createDefaultRequest("audio-to-video");
  stored.outputName = "picker-source.mp4";
  stored.promptParts.dialogue = "Dieser Satz muss in der Ausgabebibliothek sichtbar sein.";
  stored.seed = 987654;
  stored.width = 320;
  stored.height = 576;
  stored.numFrames = 25;
  stored.numInferenceSteps = 8;
  stored.quantization.mode = "fp8-cast";
  stored.postprocess.longcatLipsync.enabled = true;
  let deleted = false;
  await page.route("**/api/outputs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      outputs: deleted ? [] : [{
        name: stored.outputName,
        url: "/api/outputs/picker-source.mp4",
        sizeBytes: 123456,
        modifiedAt: "2026-07-24T07:00:00.000Z",
        jobId: null,
        jobStatus: "completed",
        request: stored,
        settingsAvailable: true,
      }],
    }),
  }));
  await page.route("**/api/outputs/picker-source.mp4", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
    }
    expect(route.request().method()).toBe("DELETE");
    deleted = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        deleted: {
          name: stored.outputName,
          sizeBytes: 123456,
          deletedArtifacts: [stored.outputName, `${stored.outputName}.ltx-settings.json`],
        },
      }),
    });
  });
  await page.reload();

  await expect(page.getByLabel("Erzeugte Ausgabe")).toHaveValue("picker-source.mp4");
  await expect(page.getByLabel("Gesprochener Text", { exact: true })).toBeVisible();
  await expect(page.locator(".output-settings-summary")).toContainText("Seed");
  await expect(page.locator(".output-settings-summary")).toContainText("987654");
  const outputDialogue = page.getByRole("note", { name: "Gesprochener Text der Ausgabe" });
  await expect(outputDialogue.locator("strong")).toHaveText("Gesprochener Text");
  await expect(outputDialogue).toContainText("Dieser Satz muss in der Ausgabebibliothek sichtbar sein.");
  await page.getByRole("button", { name: "Alle Einstellungen übernehmen" }).click();
  await expect(page.getByLabel("Gesprochener Text", { exact: true })).toHaveValue(
    "Dieser Satz muss in der Ausgabebibliothek sichtbar sein.",
  );
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue("picker-source-edit01.mp4");
  await expect(page.getByRole("spinbutton", { name: "Frames", exact: true })).toHaveValue("25");
  await expect(page.getByLabel("Breite", { exact: true })).toHaveValue("320");
  await expect(page.getByLabel("Höhe", { exact: true })).toHaveValue("576");
  await expect(page.getByRole("button", { name: "FP8 Cast" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("LongCat-Lippenpass")).toBeChecked();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("picker-source.mp4");
    await dialog.accept();
  });
  await page.getByTitle("Ausgabe und zugehörige Daten löschen").click();
  await expect(page.getByText("Noch keine MP4- oder WAV-Ausgabe im Studio-Ordner")).toBeVisible();
});

test("legacy-unattested output stays playable while every mutation control is locked", async ({ page }) => {
  const stored = createDefaultRequest("two-stage");
  stored.outputName = "legacy-unattested.mp4";
  stored.promptParts.dialogue = "Historischer, nicht attestierter Dialog";
  const legacyJobId = "74747474-7474-4474-8474-747474747474";
  const legacyJob = {
    id: legacyJobId,
    status: "completed" as const,
    mode: stored.mode,
    prompt: stored.prompt,
    outputName: stored.outputName,
    outputUrl: `/api/jobs/${legacyJobId}/output`,
    createdAt: "2026-07-24T07:00:00.000Z",
    startedAt: "2026-07-24T07:00:01.000Z",
    finishedAt: "2026-07-24T07:00:02.000Z",
    progress: 100,
    error: null,
    logs: ["Historischer Lauf ohne moderne Ausführungsautorität."],
    command: "historical command",
    request: stored,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 1_000,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: null,
    identityEvidence: null,
    runProvenance: null,
    historyStatus: "legacy-unattested" as const,
    historicalDgxJobId: "dgx-historical-playback-only",
  };
  await page.route("**/api/events", (route) => route.abort());
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jobs: [legacyJob] }),
  }));
  await page.route("**/api/outputs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      outputs: [{
        name: stored.outputName,
        url: "/api/outputs/legacy-unattested.mp4",
        sizeBytes: 123456,
        modifiedAt: "2026-07-24T07:00:00.000Z",
        jobId: legacyJobId,
        jobStatus: "completed",
        request: stored,
        settingsAvailable: true,
        trustStatus: "legacy-unattested",
      }],
    }),
  }));
  await page.route("**/api/outputs/legacy-unattested.mp4", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp4",
    body: "",
  }));
  await page.reload();

  await expect(page.getByText("Historischer Altbestand · ungeprüft · nur lesbar", { exact: true })).toBeVisible();
  await expect(page.locator(".preview-stage video")).toBeVisible();
  await expect(page.getByRole("button", { name: "Alle Einstellungen übernehmen" })).toBeDisabled();
  await expect(page.getByTitle("Ausgabe zum Vergleich hinzufügen")).toBeDisabled();
  await expect(page.getByTitle("Historischer Altbestand ist nur lesbar und kann hier nicht gelöscht werden.")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Besten Referenzframe automatisch auswählen" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Frame als Referenz" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Objektive Ausgabeanalyse" })).toHaveCount(0);
  const lockedJobControls = page.getByTitle("Historischer Altbestand ist nur lesbar.");
  await expect(lockedJobControls).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) await expect(lockedJobControls.nth(index)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Einstellungen übernehmen", exact: true })).toBeDisabled();
});

test("generated A2V output shows effective audio-derived timing instead of its dormant frame field", async ({ page }) => {
  const stored = createDefaultRequest("image-audio-to-video");
  stored.outputName = "audio-derived-timing.mp4";
  stored.numFrames = 217;
  stored.frameRate = 24;
  stored.audio.path = "/inputs/dialogue.wav";
  stored.audio.name = "dialogue.wav";
  stored.audio.startTime = 2.72;
  stored.audio.maxDuration = 4.72;

  await page.route("**/api/outputs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      outputs: [{
        name: stored.outputName,
        url: "/api/outputs/audio-derived-timing.mp4",
        sizeBytes: 123456,
        modifiedAt: "2026-08-26T16:40:00.000Z",
        jobId: null,
        jobStatus: "completed",
        request: stored,
        settingsAvailable: true,
      }],
    }),
  }));
  await page.reload();

  const summary = page.locator(".output-settings-summary");
  await expect(summary).toContainText("113 @ 24 fps (Obergrenze aus Audio-Maximaldauer)");
  await expect(summary).toContainText("217 ungenutzt · Audio-Maximaldauer steuert");
  await expect(page.locator(".preview-stage__meta")).toContainText("Bis zu 4.7 s");
});

test("manual and quality-guided output frames become bound scene references", async ({ page }) => {
  const stored = createDefaultRequest("two-stage");
  stored.outputName = "casting-shot.mp4";
  const extractionRequests: Array<{ output: string; atSeconds?: number; strategy?: string }> = [];
  let recommendedSharpness = 91.2;

  await page.route("**/api/outputs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      outputs: [{
        name: stored.outputName,
        url: "/api/outputs/casting-shot.mp4",
        sizeBytes: 123456,
        modifiedAt: "2026-08-10T07:00:00.000Z",
        jobId: null,
        jobStatus: "completed",
        request: stored,
        settingsAvailable: true,
      }],
    }),
  }));
  await page.route("**/api/outputs/casting-shot.mp4", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp4",
    body: "",
  }));
  await page.route("**/api/images/from-output", async (route) => {
    const payload = route.request().postDataJSON() as { output: string; atSeconds?: number; strategy?: string };
    extractionRequests.push(payload);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        asset: {
          id: "a1b2c3d4-5555-4666-8777-123456789012",
          path: "/uploads/scene-frame.png",
          name: "casting-shot-frame-1.30s.png",
          size: 43210,
          kind: "image",
          url: "/api/uploads/image/a1b2c3d4-5555-4666-8777-123456789012.png",
          createdAt: "2026-08-10T07:01:00.000Z",
          derivation: null,
        },
        recommendation: payload.strategy === "best-face" ? {
          atSeconds: 1.88,
          score: 0.81,
          sampledFrames: 40,
          eligibleFrames: 32,
          metrics: {
            faceSharpness: recommendedSharpness,
            faceAreaRatio: 0.08,
            faceConfidence: 0.95,
            stability: 0.94,
            exposure: 0.72,
            frontalness: 0.88,
            prominentFaceCount: 1,
          },
        } : null,
      }),
    });
  });
  await page.reload();

  const referenceButton = page.getByRole("button", { name: "Frame als Referenz" });
  await expect(referenceButton).toBeEnabled();
  await page.getByLabel("Referenzzeitpunkt in Sekunden").fill("1.3");
  await referenceButton.click();

  expect(extractionRequests[0]).toEqual({ output: "casting-shot.mp4", atSeconds: 1.3 });
  await expect(page.getByRole("button", { name: "Bild zu Video · empfohlen" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("casting-shot-frame-1.30s.png")).toHaveValue("/uploads/scene-frame.png");
  await expect(page.getByText(/als Szenenreferenz mit Stärke 1,0 im Editor eingesetzt/)).toBeVisible();

  await page.getByRole("button", { name: "Besten Referenzframe automatisch auswählen" }).click();
  expect(extractionRequests[1]).toEqual({ output: "casting-shot.mp4", strategy: "best-face" });
  await expect(page.getByLabel("Referenzzeitpunkt in Sekunden")).toHaveValue("1.88");
  await expect(page.getByText(/Gesichtsschärfe 91,2, Stabilität 94 %, 32 geeignete Frames/)).toBeVisible();

  recommendedSharpness = 22.4;
  await page.getByRole("button", { name: "Besten Referenzframe automatisch auswählen" }).click();
  expect(extractionRequests[2]).toEqual({ output: "casting-shot.mp4", strategy: "best-face" });
  await expect(page.getByText(/Gesicht ist im gesamten Video zu weich/)).toBeVisible();
  await expect(page.getByLabel("Referenzzeitpunkt in Sekunden")).toHaveValue("1.88");
  await expect(page.getByLabel("casting-shot-frame-1.30s.png")).toHaveValue("/uploads/scene-frame.png");
});

test("terminal jobs can be removed from persistent history", async ({ page }) => {
  const request = createDefaultRequest("two-stage");
  request.outputName = "obsolete-job.mp4";
  const job = {
    id: "44444444-4444-4444-8444-444444444444",
    status: "failed" as const,
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: null,
    createdAt: "2026-07-24T07:00:00.000Z",
    startedAt: "2026-07-24T07:00:01.000Z",
    finishedAt: "2026-07-24T07:00:02.000Z",
    progress: 5,
    error: "Veralteter Testlauf.",
    logs: [],
    command: "python -m ltx_pipelines",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 1_000,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: null,
    identityEvidence: null,
    runProvenance: null,
  };
  let deleted = false;
  await page.route("**/api/events", (route) => route.abort());
  await page.route("**/api/jobs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jobs: deleted ? [] : [job] }),
  }));
  await page.route(`**/api/jobs/${job.id}`, (route) => {
    expect(route.request().method()).toBe("DELETE");
    deleted = true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ deleted: job }),
    });
  });
  await page.reload();

  await expect(page.locator(".job-row")).toContainText("obsolete-job.mp4");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Die erzeugte Ausgabe bleibt");
    await dialog.accept();
  });
  await page.getByTitle("Job aus Verlauf löschen").click();
  await expect(page.getByText("Noch keine Jobs")).toBeVisible();
  expect(deleted).toBe(true);
});

test("active jobs cancel immediately without a confirmation dialog", async ({ page }) => {
  const request = createDefaultRequest("image-audio-to-video");
  request.outputName = "cancel-without-dialog.mp4";
  const runningJob = {
    id: "55555555-5555-4555-8555-555555555555",
    status: "paused" as const,
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: null,
    createdAt: "2026-08-26T17:00:00.000Z",
    startedAt: "2026-08-26T17:00:01.000Z",
    finishedAt: null,
    progress: 60,
    error: null,
    logs: ["Thermalpause"],
    command: "python -m ltx_pipelines.a2vid_two_stage",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 120_000,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: "dgx-cancel-without-dialog",
    executionClass: "dgx" as const,
    executionDecisionSummary: null,
  };
  const cancelledJob = {
    ...runningJob,
    status: "cancelled" as const,
    finishedAt: "2026-08-26T17:02:01.000Z",
    cancelledBy: "studio" as const,
  };
  let visibleJobs: Array<typeof runningJob | typeof cancelledJob> = [runningJob];
  let cancellationRequests = 0;
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await page.route("**/api/events", (route) => route.abort());
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jobs: visibleJobs }),
  }));
  await page.route(`**/api/jobs/${runningJob.id}/cancel`, async (route) => {
    cancellationRequests += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    visibleJobs = [cancelledJob];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ job: cancelledJob }),
    });
  });
  await page.reload();

  await page.getByTitle("Job abbrechen").dblclick();

  await expect(page.getByText("Dieser Lauf wurde manuell über die Studio-Abbruchfunktion beendet.")).toBeVisible();
  expect(cancellationRequests).toBe(1);
  expect(dialogs).toBe(0);
});

test("overlapping dialog-free cancellations keep independent progress", async ({ page }) => {
  const makeRunningJob = (id: string, outputName: string) => {
    const request = createDefaultRequest("image-audio-to-video");
    request.outputName = outputName;
    return {
      id,
      status: "running",
      mode: request.mode,
      prompt: request.prompt,
      outputName,
      outputUrl: null,
      createdAt: "2026-08-26T17:00:00.000Z",
      startedAt: "2026-08-26T17:00:01.000Z",
      finishedAt: null,
      progress: 60,
      error: null,
      logs: ["Läuft"],
      command: "python -m ltx_pipelines.a2vid_two_stage",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: 120_000,
      cancelledBy: null,
      cancellationState: null,
      thermalProfile: null,
      dgxJobId: `dgx-${id}`,
      executionClass: "dgx",
      executionDecisionSummary: null,
    };
  };
  const first = makeRunningJob("66666666-6666-4666-8666-666666666661", "cancel-a.mp4");
  const second = makeRunningJob("66666666-6666-4666-8666-666666666662", "cancel-b.mp4");
  let visibleJobs: Array<Record<string, unknown>> = [first, second];
  const requestCounts = new Map<string, number>();
  const releases = new Map<string, () => void>();
  const gates = new Map([first.id, second.id].map((id) => [
    id,
    new Promise<void>((resolvePromise) => releases.set(id, resolvePromise)),
  ]));
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await page.route("**/api/events", (route) => route.abort());
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jobs: visibleJobs }),
  }));
  await page.route(/\/api\/jobs\/([^/]+)\/cancel$/, async (route) => {
    const id = route.request().url().match(/\/api\/jobs\/([^/]+)\/cancel$/)?.[1] ?? "";
    requestCounts.set(id, (requestCounts.get(id) ?? 0) + 1);
    await gates.get(id);
    const source = id === first.id ? first : second;
    const cancelled = {
      ...source,
      status: "cancelled",
      finishedAt: "2026-08-26T17:02:01.000Z",
      cancelledBy: "studio",
      cancellationState: "settled",
    };
    visibleJobs = visibleJobs.map((job) => job.id === id ? cancelled : job);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ job: cancelled }),
    });
  });
  await page.reload();

  const firstRow = page.locator(".job-row").filter({ hasText: first.outputName });
  const secondRow = page.locator(".job-row").filter({ hasText: second.outputName });
  await firstRow.getByTitle("Job abbrechen").dblclick();
  await secondRow.getByTitle("Job abbrechen").dblclick();
  await expect(firstRow.getByTitle("Job wird abgebrochen")).toBeDisabled();
  await expect(secondRow.getByTitle("Job wird abgebrochen")).toBeDisabled();
  expect(requestCounts.get(first.id)).toBe(1);
  expect(requestCounts.get(second.id)).toBe(1);

  releases.get(first.id)?.();
  await expect(firstRow.getByTitle("Job aus Verlauf löschen")).toBeVisible();
  await expect(secondRow.getByTitle("Job wird abgebrochen")).toBeDisabled();
  releases.get(second.id)?.();
  await expect(secondRow.getByTitle("Job aus Verlauf löschen")).toBeVisible();

  expect(requestCounts.get(first.id)).toBe(1);
  expect(requestCounts.get(second.id)).toBe(1);
  expect(dialogs).toBe(0);
});

test("run monitor distinguishes CPU-only retiming from unclassified legacy history", async ({ page }) => {
  const request = createDefaultRequest("audio-to-video");
  request.outputName = "cpu-only-retime.mp4";
  const job = (id: string, executionClass?: "cpu-only") => ({
    id,
    status: "completed" as const,
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: null,
    createdAt: "2026-08-25T09:40:59.000Z",
    startedAt: "2026-08-25T09:41:00.867Z",
    finishedAt: "2026-08-25T09:41:01.327Z",
    progress: 100,
    error: null,
    logs: ["LipForcing-Bildstrom unverändert wiederverwendet."],
    command: "python -I -m ltx_pipelines.image_to_video",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 460,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: null,
    identityEvidence: null,
    runProvenance: null,
    ...(executionClass ? { executionClass } : {}),
  });
  let jobs = [job("acf4694b-c618-4c6e-b666-06dd641aa466", "cpu-only")];
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jobs }),
  }));
  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outputs: [] }),
  }));
  await page.route("**/api/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: ":\n\n",
  }));

  await page.reload();
  const summary = page.locator(".run-summary");
  await expect(page.locator(".run-monitor")).toContainText("CPU-only Audio-Retime");
  await expect(page.locator(".run-monitor__title")).toContainText("460 ms");
  await expect(summary).toContainText("CPU-only Audio-Retime");
  await expect(summary).toContainText("Laufzeit460 ms");
  await expect(summary).not.toContainText("RAM-Prognose");
  await expect(summary).not.toContainText("Queue");
  await expect(summary).not.toContainText("ETA");
  await expect(page.locator(".job-row")).toContainText("CPU-only Audio-Retime");
  await expect(page.locator(".job-facts")).toContainText("DGX-JobNicht erforderlich");
  await expect(page.locator(".job-command summary")).toContainText("bei Audio-Retime nicht ausgeführt");

  jobs = [job("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")];
  await page.reload();
  await expect(page.locator(".run-monitor")).toContainText("Nicht klassifiziert (Legacy)");
  await expect(summary).toContainText("Nicht klassifiziert (Legacy)");
  await expect(summary).not.toContainText("RAM-Prognose");
  await expect(summary).not.toContainText("Queue");
  await expect(summary).not.toContainText("ETA");
  await expect(page.locator(".job-facts")).toContainText("DGX-JobNicht klassifiziert (Legacy)");
});

test("mobile keeps all modes reachable without page overflow", async ({ page }, testInfo) => {
  const modes = page.locator(".mode-button");
  await expect(modes).toHaveCount(pipelineModes.length);
  await modes.last().scrollIntoViewIfNeeded();
  await modes.last().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Retake / Bereich ersetzen");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("studio-mobile.png"), fullPage: true });
});

test("API rejects foreign browser origins and unknown routes", async ({ request }) => {
  const blocked = await request.get("/api/health", { headers: { Origin: "https://attacker.example" } });
  expect(blocked.status()).toBe(403);
  expect(await blocked.json()).toMatchObject({ error: "Nur die lokale Studio-Oberfläche darf Browser-Anfragen senden." });

  const wrongLocalPort = await request.get("/api/health", { headers: { Origin: "http://localhost:9999" } });
  expect(wrongLocalPort.status()).toBe(403);

  const missing = await request.get("/api/not-a-route");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toMatchObject({ error: "API-Endpunkt nicht gefunden." });
  expect(missing.headers()["content-security-policy"]).toContain("default-src 'self'");

  const foreignPrep = await request.post("/api/lipdub/reference/prepare", {
    data: {
      mode: "lipdub",
      width: 576,
      height: 1024,
      lipDub: { referenceVideo: { path: "/tmp/not-a-studio-asset.mp4" } },
    },
  });
  expect(foreignPrep.status()).toBe(400);
  expect(await foreignPrep.json()).toMatchObject({
    error: "LipDub-Referenzvorbereitung ist nur für Videos aus der Studio-Mediathek verfügbar.",
  });

  const foreignInspection = await request.post("/api/lipdub/reference/inspect", {
    data: {
      path: "/tmp/not-a-studio-asset.mp4",
      width: 576,
      height: 1024,
      dialogue: "",
      prompt: "",
    },
  });
  expect(foreignInspection.status()).toBe(400);
  expect(await foreignInspection.json()).toMatchObject({
    error: "LipDub-Referenzdiagnose ist nur für Videos aus der Studio-Mediathek verfügbar.",
  });
});

test("API persists and freezes a controlled experiment before any render can start", async ({ request }) => {
  const baselineRequest = createDefaultRequest("audio-to-video");
  baselineRequest.prompt = "A single-speaker native A2V experiment.";
  baselineRequest.outputName = "api-controlled-guidance.mp4";
  baselineRequest.models.checkpointPath = "/models/checkpoint.safetensors";
  baselineRequest.models.gemmaRoot = "/models/gemma";
  baselineRequest.models.gemmaLora = { enabled: true, path: "/models/gemma-lora.safetensors", strength: 1 };
  baselineRequest.models.spatialUpscalerPath = "/models/upscaler.safetensors";
  baselineRequest.models.distilledLora = { path: "/models/distilled-lora.safetensors", strength: 1 };
  baselineRequest.audio.path = "/inputs/speech.wav";
  baselineRequest.audio.name = "speech.wav";
  baselineRequest.videoGuidance.modalityScale = 5;

  const createdResponse = await request.post("/api/experiments", {
    data: {
      title: "API A2V Guidance 5 gegen 3",
      baselineRequest,
      candidate: { variable: "a2v-guidance", value: 3 },
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()).experiment;
  expect(created).toMatchObject({
    status: "draft",
    kind: "ablation",
    changedRequestPaths: ["videoGuidance.modalityScale"],
  });

  const frozenResponse = await request.post(`/api/experiments/${created.id}/freeze`);
  expect(frozenResponse.ok()).toBe(true);
  const frozen = (await frozenResponse.json()).experiment;
  expect(frozen.status).toBe("frozen");
  expect(frozen.protocolEqualityToken).toMatch(/^eq1_[A-Za-z0-9_-]{32}$/);

  const duplicateFreeze = await request.post(`/api/experiments/${created.id}/freeze`);
  expect(duplicateFreeze.status()).toBe(409);

  const prematureCandidate = await request.post(`/api/experiments/${created.id}/runs/candidate`);
  expect(prematureCandidate.status()).toBe(409);
  expect(await prematureCandidate.json()).toMatchObject({
    error: "Der gebundene Baseline-Lauf muss vollständig abgeschlossen und mit verifizierter Laufprovenienz belegt sein.",
  });

  const prematureBlindEvaluation = await request.post("/api/blind-evaluations", {
    data: { experimentId: created.id, creationRequestId: "1".repeat(64) },
  });
  expect(prematureBlindEvaluation.status()).toBe(409);
  expect(await prematureBlindEvaluation.json()).toMatchObject({
    error: "Nur ein eingefrorenes Experiment mit zwei gebundenen Armen kann verblindet bewertet werden.",
  });
  const oversizedBlindInput = await request.post("/api/blind-evaluations", {
    data: {
      experimentId: created.id,
      creationRequestId: "2".repeat(64),
      outputName: "do-not-trust-browser.mp4",
    },
  });
  expect(oversizedBlindInput.status()).toBe(400);
  const unknownBlindSession = await request.get(
    "/api/blind-evaluations/12121212-1212-4212-8212-121212121212",
  );
  expect(unknownBlindSession.status()).toBe(404);
  expect(await unknownBlindSession.json()).toMatchObject({ error: expect.any(String) });

  const missingPreflight = await request.post(
    "/api/experiments/66666666-6666-4666-8666-666666666666/runs/candidate/preflight",
  );
  expect(missingPreflight.status()).toBe(409);
  expect(await missingPreflight.json()).toMatchObject({ error: "Experiment nicht gefunden." });

  const listResponse = await request.get("/api/experiments");
  expect(listResponse.ok()).toBe(true);
  expect((await listResponse.json()).experiments).toEqual(
    expect.arrayContaining([expect.objectContaining({
      id: created.id,
      protocolEqualityToken: frozen.protocolEqualityToken,
    })]),
  );
});

test("Blind v5.1 atomically pins one cross-tab submission and the loser never reaches POST", async ({ page, context }) => {
  const sessionId = "61616161-6161-4616-8616-616161616161";
  const initialPin = {
    schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5" as const,
    id: sessionId,
    commitment: "a".repeat(64),
    publicStateSha256: "b".repeat(64),
  };
  const coverage = {
    intervals: [{ startMilliseconds: 0, endMilliseconds: 960 }],
    uniqueCoverageMilliseconds: 960,
    coverageRatio: 1,
    ended: true,
  };
  const playback = {
    durationMilliseconds: 960,
    normalSpeed: coverage,
    halfSpeed: coverage,
    audibleNormalSpeed: coverage,
    audibleHalfSpeed: coverage,
    mediaLoaded: true as const,
    playSucceeded: true as const,
    audioReviewed: true as const,
  };
  const input = (note: string) => ({
    scores: {
      x: { timing: 8, mouthIntegration: 8, eyesIdentity: 8, resolutionDetail: 8 },
      y: { timing: 9, mouthIntegration: 9, eyesIdentity: 9, resolutionDetail: 9 },
    },
    preference: "y" as const,
    confidence: 4,
    note,
    playback: {
      x: playback,
      y: playback,
      normalSpeedReviewed: true as const,
      halfSpeedReviewed: true as const,
      humanObservationAttested: true as const,
    },
  });
  let postAttempts = 0;
  await context.route(`/api/blind-evaluations/${sessionId}/submission`, (route) => {
    postAttempts += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "winner reached POST" }),
    });
  });
  // This is a storage/CAS test, not an App bootstrap test. Use an inert
  // same-origin document so focus changes among three tabs cannot trigger the
  // intentionally aggressive evaluator-scope watchdog and race JS evaluation.
  await page.goto("/src/styles.css");
  const peer = await context.newPage();
  await peer.goto("/src/styles.css");
  const lockCoordinator = await context.newPage();
  await lockCoordinator.goto("/src/styles.css");
  const webLockName = `ltx-studio.blind-submission-pin.v5.${sessionId}`;
  await lockCoordinator.evaluate((name) => {
    const state = window as typeof window & {
      __blindV5LockHeld?: boolean;
      __releaseBlindV5Lock?: () => void;
    };
    void navigator.locks.request(name, { mode: "exclusive" }, async () => {
      state.__blindV5LockHeld = true;
      await new Promise<void>((resolvePromise) => { state.__releaseBlindV5Lock = resolvePromise; });
    });
  }, webLockName);
  await expect.poll(() => lockCoordinator.evaluate(() => (
    window as typeof window & { __blindV5LockHeld?: boolean }
  ).__blindV5LockHeld === true)).toBe(true);
  const attempt = async (target: typeof page, note: string, idempotencyKey: string) => target.evaluate(
    async ({ id, submission, pin, key }) => {
      const modulePath = "/src/api.ts";
      const api = await import(/* @vite-ignore */ modulePath) as {
        submitBlindEvaluation: (
          id: string,
          value: typeof submission,
          initial: typeof pin,
          idempotencyKey: string,
        ) => Promise<unknown>;
      };
      try {
        await api.submitBlindEvaluation(id, submission, pin, key);
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { id: sessionId, submission: input(note), pin: initialPin, key: idempotencyKey },
  );
  const attempts = [
    attempt(page, "Tab A", "c".repeat(64)),
    attempt(peer, "Tab B", "d".repeat(64)),
  ];
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  expect(postAttempts).toBe(0);
  await lockCoordinator.evaluate(() => (
    window as typeof window & { __releaseBlindV5Lock?: () => void }
  ).__releaseBlindV5Lock?.());
  const results = await Promise.all(attempts);
  expect(postAttempts).toBe(1);
  expect(results).toContain("winner reached POST");
  expect(results.some((message) => message.includes("Konflikt mit diesem Retry"))).toBe(true);
  const durableBeforeReload = await page.evaluate((id) => localStorage.getItem(
    `ltx-studio.blind-submission-pin.v5.${id}`,
  ), sessionId);
  expect(durableBeforeReload).not.toBeNull();
  const durablePin = JSON.parse(durableBeforeReload!) as { idempotencyKey: string };
  await page.evaluate((id) => localStorage.removeItem(
    `ltx-studio.blind-submission-pin.v5.${id}`,
  ), sessionId);
  const recoveredRetry = await attempt(
    page,
    durablePin.idempotencyKey === "c".repeat(64) ? "Tab A" : "Tab B",
    durablePin.idempotencyKey,
  );
  expect(recoveredRetry).toBe("winner reached POST");
  expect(postAttempts).toBe(2);
  expect(await page.evaluate((id) => localStorage.getItem(
    `ltx-studio.blind-submission-pin.v5.${id}`,
  ), sessionId)).toBe(durableBeforeReload);
  await peer.reload();
  expect(await peer.evaluate((id) => localStorage.getItem(
    `ltx-studio.blind-submission-pin.v5.${id}`,
  ), sessionId)).toBe(durableBeforeReload);
  await page.evaluate((id) => localStorage.removeItem(`ltx-studio.blind-submission-pin.v5.${id}`), sessionId);
  await lockCoordinator.close();
  await peer.close();
});

test("Blind v5.2 watchdog hard-aborts a never-settling scope request and synchronously hides the peer", async ({ context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
  });
  let scopeRequestHangs = false;
  const hangingRequests: Array<() => void> = [];
  await peer.route("/api/blind-evaluator-scope", async (route) => {
    if (!scopeRequestHangs) {
      await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locked: false, evaluation: null }),
      });
      return;
    }
    await new Promise<void>((resolvePromise) => hangingRequests.push(resolvePromise));
    try { await route.abort("failed"); } catch { /* AbortController may already have cancelled it. */ }
  });
  await peer.route("**/api/events", (route) => route.abort("failed"));
  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
  scopeRequestHangs = true;
  await expect.poll(
    () => peer.evaluate(() => document.querySelector(".app-shell, .experiment-panel, .run-panel") === null),
    { timeout: 3_000 },
  ).toBe(true);
  await expect(peer).toHaveURL(/\/blind-evaluation-lock$/);
  await expect(peer.getByRole("button", { name: "Experimente öffnen" })).toHaveCount(0);
  for (const release of hangingRequests.splice(0)) release();
  scopeRequestHangs = false;
  await expect(peer).toHaveURL(/\/$/, { timeout: 3_000 });
  await expect(peer.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
  await expect(peer.locator("html")).not.toHaveAttribute("data-blind-scope-revalidating", "true");
  await peer.close();
});

test("Blind v5.2 bootstrap HTTP scope failure stays fail-closed and auto-recovers when scope is healthy", async ({ context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
  });
  let scopeHealthy = false;
  await peer.route("/api/blind-evaluator-scope", (route) => route.fulfill({
    status: scopeHealthy ? 200 : 503,
    contentType: "application/json",
    body: JSON.stringify(scopeHealthy
      ? { locked: false, evaluation: null }
      : { error: "deterministic bootstrap outage" }),
  }));
  await peer.route("**/api/events", (route) => route.abort("failed"));

  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1 })).toHaveText("Blind-Evaluator-Lock");
  await expect(peer.locator(".app-shell, .experiment-panel, .run-panel")).toHaveCount(0);
  await expect(peer).toHaveURL(/\/$/);

  scopeHealthy = true;
  await expect(peer.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video", {
    timeout: 5_000,
  });
  await expect(peer).toHaveURL(/\/$/);
  await expect(peer.locator("html")).not.toHaveAttribute("data-blind-scope-revalidating", "true");
  await peer.close();
});

test("Blind v5.2 bootstrap request abort stays fail-closed, avoids unmounted-root render and auto-recovers", async ({ context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
  });
  const pageErrors: string[] = [];
  peer.on("pageerror", (error) => pageErrors.push(error.message));
  let abortScopeRequest = true;
  await peer.route("/api/blind-evaluator-scope", async (route) => {
    if (abortScopeRequest) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locked: false, evaluation: null }),
    });
  });
  await peer.route("**/api/events", (route) => route.abort("failed"));

  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1 })).toHaveText("Blind-Evaluator-Lock");
  await expect(peer.locator(".app-shell, .experiment-panel, .run-panel")).toHaveCount(0);
  expect(pageErrors.some((message) => message.includes("unmounted root"))).toBe(false);

  abortScopeRequest = false;
  await expect(peer.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video", {
    timeout: 5_000,
  });
  await expect(peer).toHaveURL(/\/$/);
  await expect(peer.locator("html")).not.toHaveAttribute("data-blind-scope-revalidating", "true");
  expect(pageErrors.some((message) => message.includes("unmounted root"))).toBe(false);
  await peer.close();
});

test("Blind v5.2 real server preserves Set-Cookie scope across hard navigation and two tabs until durable lock release", async ({
  browser,
  context,
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One real shared-server lock lifecycle is sufficient.");
  const baselineRequest = createDefaultRequest("audio-to-video");
  baselineRequest.prompt = "Real server Blind-v5.2 browser scope lifecycle.";
  baselineRequest.outputName = `blind-real-scope-${Date.now()}.mp4`;
  baselineRequest.models.checkpointPath = "/models/checkpoint.safetensors";
  baselineRequest.models.gemmaRoot = "/models/gemma";
  baselineRequest.models.gemmaLora = { enabled: true, path: "/models/gemma-lora.safetensors", strength: 1 };
  baselineRequest.models.spatialUpscalerPath = "/models/upscaler.safetensors";
  baselineRequest.models.distilledLora = { path: "/models/distilled-lora.safetensors", strength: 1 };
  baselineRequest.audio.path = "/inputs/speech.wav";
  baselineRequest.audio.name = "speech.wav";
  baselineRequest.videoGuidance.modalityScale = 5;
  const createdResponse = await request.post("/api/experiments", {
    data: {
      title: "Blind v5.2 real server scope",
      baselineRequest,
      candidate: { variable: "a2v-guidance", value: 3 },
    },
  });
  expect(createdResponse.status()).toBe(201);
  const experimentId = (await createdResponse.json()).experiment.id as string;
  const frozenResponse = await request.post(`/api/experiments/${experimentId}/freeze`);
  expect(frozenResponse.ok()).toBe(true);

  const dataRoot = "/tmp/ltx-studio-playwright";
  const experimentPath = join(dataRoot, "experiments", `${experimentId}.json`);
  const v5Root = join(dataRoot, "blind-evaluations", "v5");
  const globalLockPath = join(v5Root, "global-lock.v5.json");
  const internalExperiment = JSON.parse(readFileSync(experimentPath, "utf8")) as {
    arms: Array<{ jobId: string | null; attemptJobIds: string[] }>;
  };
  internalExperiment.arms[0]!.jobId = "31313131-3131-4313-8313-313131313131";
  internalExperiment.arms[0]!.attemptJobIds = [internalExperiment.arms[0]!.jobId];
  internalExperiment.arms[1]!.jobId = "41414141-4141-4414-8414-414141414141";
  internalExperiment.arms[1]!.attemptJobIds = [internalExperiment.arms[1]!.jobId];
  writeFileSync(experimentPath, `${JSON.stringify(internalExperiment, null, 2)}\n`, { mode: 0o600 });

  const creationRequestId = createHash("sha256")
    .update(`blind-v5.2-real-server:${experimentId}`, "utf8")
    .digest("hex");
  let sessionId: string | null = null;
  let scopedPeer: Awaited<ReturnType<typeof context.newPage>> | null = null;
  let unscopedContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  try {
    await page.evaluate(() => {
      (window as typeof window & { __blindV52OriginalDocument?: string }).__blindV52OriginalDocument = "visible";
    });
    const reserved = await page.evaluate(async ({ id, requestId }) => {
      const response = await fetch("/api/blind-evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ experimentId: id, creationRequestId: requestId }),
      });
      return { status: response.status, body: await response.json() };
    }, { id: experimentId, requestId: creationRequestId });
    expect(reserved.status).toBe(201);
    sessionId = reserved.body.evaluation.id as string;
    expect(reserved.body.evaluation).toMatchObject({ status: "creating" });
    expect(reserved.body.creationToken).toMatch(/^[0-9a-f]{64}$/);

    const origin = new URL(page.url()).origin;
    const scopeCookies = (await context.cookies(`${origin}/api`))
      .filter((cookie) => cookie.name === BLIND_EVALUATOR_SCOPE_COOKIE);
    expect(scopeCookies).toHaveLength(1);
    expect(scopeCookies[0]).toMatchObject({ httpOnly: true, path: "/api", sameSite: "Strict" });
    const credential = scopeCookies[0]!.value;
    expect(credential).toMatch(/^[0-9a-f]{64}$/);

    const reservationPath = join(
      v5Root,
      "reservations",
      sessionId,
      "reservation.v5.json",
    );
    const reservation = JSON.parse(readFileSync(reservationPath, "utf8")) as {
      evaluatorScopeCredentialSha256: string; lockNonce: string; createdAt: string;
    };
    expect(createHash("sha256").update(credential, "utf8").digest("hex"))
      .toBe(reservation.evaluatorScopeCredentialSha256);
    const expectedLockNonce = createHash("sha256")
      .update(canonicalBlindEvaluationJson({
        kind: "blind-v5-global-lock",
        id: sessionId,
        credential,
        creationRequestId,
      }))
      .digest("hex");
    expect(reservation.lockNonce).toBe(expectedLockNonce);
    writeFileSync(globalLockPath, `${JSON.stringify({
      schemaVersion: "ltx-studio-blind-evaluation-global-lock.v5",
      sessionId,
      evaluatorScopeCredentialSha256: reservation.evaluatorScopeCredentialSha256,
      lockNonce: reservation.lockNonce,
      createdAt: reservation.createdAt,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o400 });
    for (const path of [globalLockPath, v5Root]) {
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    expect(statSync(globalLockPath).mode & 0o777).toBe(0o400);
    expect(statSync(globalLockPath).nlink).toBe(1);

    await expect(page).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#.*creating=v5`), {
      timeout: 5_000,
    });
    expect(await page.evaluate(() => (
      window as typeof window & { __blindV52OriginalDocument?: string }
    ).__blindV52OriginalDocument)).toBeUndefined();
    scopedPeer = await context.newPage();
    await scopedPeer.goto(origin);
    await expect(scopedPeer).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#.*creating=v5`));
    await expect(scopedPeer.locator(".app-shell, .experiment-panel, .run-panel")).toHaveCount(0);

    unscopedContext = await browser.newContext({ baseURL: origin });
    const unscopedPeer = await unscopedContext.newPage();
    await unscopedPeer.goto(origin);
    await expect(unscopedPeer).toHaveURL(/\/blind-evaluation-lock$/);
    const lockedJobs = await unscopedContext.request.get(`${origin}/api/jobs`);
    expect(lockedJobs.status()).toBe(423);
    expect(await lockedJobs.json()).toMatchObject({
      error: "Der persistente globale v5-Blind-Evaluator-Lock sperrt die Studio-API.",
    });

    const releaseStatus = await page.evaluate(async (id) => (
      await fetch(`/api/blind-evaluations/${id}/scope/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status, sessionId);
    expect(releaseStatus).toBe(204);
    expect((await context.cookies(`${origin}/api`))
      .filter((cookie) => cookie.name === BLIND_EVALUATOR_SCOPE_COOKIE)).toHaveLength(0);
    expect(existsSync(globalLockPath)).toBe(false);
    // This test invokes the release endpoint directly rather than the panel's
    // explicit hard-navigation helper, so an already unmounted evaluator
    // document may remain on the fail-closed lock URL. A fresh root navigation
    // must now boot normal Studio in both formerly scoped tabs.
    await expect(page).toHaveURL(/\/(?:blind-evaluation-lock)?$/, { timeout: 5_000 });
    await expect(scopedPeer).toHaveURL(/\/(?:blind-evaluation-lock)?$/, { timeout: 5_000 });
    await page.goto(origin);
    await scopedPeer.goto(origin);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
    await expect(scopedPeer.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
    expect((await unscopedContext.request.get(`${origin}/api/jobs`)).status()).toBe(200);
  } finally {
    if (sessionId) {
      try {
        await page.evaluate(async (id) => {
          await fetch(`/api/blind-evaluations/${id}/scope/release`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
        }, sessionId);
      } catch { /* The asserted release may already have hard-navigated and cleared the capability. */ }
    }
    if (existsSync(globalLockPath)) unlinkSync(globalLockPath);
    if (existsSync(experimentPath)) unlinkSync(experimentPath);
    await scopedPeer?.close();
    await unscopedContext?.close();
  }
});

test("Blind Evidence v5 reserves, claims, hard-navigates, measures unique coverage, decodes and rejects a swapped reveal", async ({ page }, testInfo) => {
  const experimentId = "71717171-7171-4717-8717-717171717171";
  const sessionId = "81818181-8181-4818-8818-818181818181";
  const baselineJobId = "91919191-9191-4919-8919-919191919191";
  const candidateJobId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  const credential = "7".repeat(64);
  const creationToken = "6".repeat(64);
  const digest = (value: unknown) => createHash("sha256")
    .update(canonicalBlindEvaluationJson(value))
    .digest("hex");
  const baseline = createDefaultRequest("text-to-audio");
  baseline.outputName = "private-baseline-name.mp4";
  const candidate = structuredClone(baseline);
  candidate.outputName = "private-candidate-name.mp4";
  candidate.seed += 1;
  const protocolSha256 = "b".repeat(64);
  const experiment = {
    schemaVersion: "ltx-studio-experiment.v1" as const,
    id: experimentId,
    title: "Nicht im Evaluator-DOM sichtbarer Experimentname",
    claimScope: "development" as const,
    status: "frozen" as const,
    kind: "replicate" as const,
    candidate: { variable: "replicate-seed" as const, value: candidate.seed },
    changedRequestPaths: ["seed"],
    createdAt: "2026-08-25T12:00:00.000Z",
    frozenAt: "2026-08-25T12:01:00.000Z",
    supersededAt: null,
    supersededReason: null,
    replacementExperimentId: null,
    baselineEvidence: null,
    protocolSha256,
    arms: [{
      arm: "baseline" as const,
      request: baseline,
      requestSha256: "c".repeat(64),
      settingsSha256: "d".repeat(64),
      jobId: baselineJobId,
      attemptJobIds: [baselineJobId],
    }, {
      arm: "candidate" as const,
      request: candidate,
      requestSha256: "e".repeat(64),
      settingsSha256: "f".repeat(64),
      jobId: candidateJobId,
      attemptJobIds: [candidateJobId],
    }],
  };
  const outputSha = { baseline: "4".repeat(64), candidate: "5".repeat(64) };
  const binding = (arm: "baseline" | "candidate") => {
    const outputName = arm === "baseline" ? baseline.outputName : candidate.outputName;
    const jobId = arm === "baseline" ? baselineJobId : candidateJobId;
    const fileId = arm === "baseline" ? "71" : "72";
    return {
      arm,
      outputName,
      jobId,
      requestSha256: arm === "baseline" ? "c".repeat(64) : "e".repeat(64),
      settingsSha256: arm === "baseline" ? "d".repeat(64) : "f".repeat(64),
      provenanceFingerprint: arm === "baseline" ? "1".repeat(64) : "2".repeat(64),
      sourceSha256: outputSha[arm],
      analysisSha256: arm === "baseline" ? "6".repeat(64) : "7".repeat(64),
      settingsSidecarSha256: arm === "baseline" ? "8".repeat(64) : "9".repeat(64),
      analysisSidecarSha256: arm === "baseline" ? "a".repeat(64) : "b".repeat(64),
      publication: {
        schemaVersion: "ltx-studio-output-publication.v2" as const,
        authoritySha256: arm === "baseline" ? "1".repeat(64) : "2".repeat(64),
        publishedAt: "2026-08-25T12:02:00.000Z",
        executionDecisionSha256: arm === "baseline" ? "3".repeat(64) : "4".repeat(64),
        jobPersistenceRevision: arm === "baseline"
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222",
        jobAuthoritySha256: arm === "baseline" ? "5".repeat(64) : "6".repeat(64),
        outputSha256: outputSha[arm],
        outputRevision: {
          sizeBytes: 4_096,
          modifiedAtMs: 1_777_000_000_000,
          changedAtMs: 1_777_000_000_001,
          fileId,
          deviceId: "7",
          mode: 33_188,
          uid: 1_000,
          gid: 1_000,
          nlink: 1 as const,
        },
      },
      sourceRevision: {
        sha256: outputSha[arm],
        deviceId: "8",
        modifiedAtMs: 1_777_000_000_010,
        changedAtMs: 1_777_000_000_011,
        fileId: arm === "baseline" ? "81" : "82",
        mode: 33_024,
      },
      durationSeconds: 0.96,
      hasAudio: true as const,
    };
  };
  const disposition = {
    default: 1 as const,
    dub: 0 as const,
    original: 0 as const,
    comment: 0 as const,
    lyrics: 0 as const,
    karaoke: 0 as const,
    forced: 0 as const,
    hearing_impaired: 0 as const,
    visual_impaired: 0 as const,
    clean_effects: 0 as const,
    attached_pic: 0 as const,
    timed_thumbnails: 0 as const,
    non_diegetic: 0 as const,
    captions: 0 as const,
    descriptions: 0 as const,
    metadata: 0 as const,
    dependent: 0 as const,
    still_image: 0 as const,
  };
  const measured = {
    schemaVersion: "ltx-studio-blind-evaluation-measured-media.v5" as const,
    contractKind: "measured-finished-media" as const,
    streamsTotal: 2 as const,
    streamTypes: ["video", "audio"] as ["video", "audio"],
    formatTags: { major_brand: "isom" as const, minor_version: "512" as const, compatible_brands: "isomiso2avc1mp41" as const },
    videoTags: {
      language: "und" as const,
      handler_name: "VideoHandler" as const,
      vendor_id: "[0][0][0][0]" as const,
      encoder: "Lavc libx264" as const,
    },
    audioTags: {
      language: "und" as const,
      handler_name: "SoundHandler" as const,
      vendor_id: "[0][0][0][0]" as const,
    },
    dispositions: { video: disposition, audio: disposition },
    sideDataEntries: 0 as const,
    topLevelBoxTypes: ["ftyp", "moov", "free", "mdat"] as ["ftyp", "moov", "free", "mdat"],
    videoKeyFramePositions: [0],
    sps: { maxNumRefFrames: 4 as const, fixedFrameRate: true as const, nalHrd: true as const, cpbCount: 1 as const, cbr: true as const },
    nalUnitCounts: { nonIdrSlice: 23, idrSlice: 1, sps: 1 as const, pps: 1 as const, filler: 24, sei: 0 as const },
    decodedVideoFrames: 24,
    decodedAudioStreams: 1 as const,
    ffprobeFingerprintSha256: "9".repeat(64),
    sampleTableResidualExcluded: true as const,
  };
  const snapshot = (channel: "x" | "y", sourceArm: "baseline" | "candidate", fileId: string) => {
    const sourceBefore = binding(sourceArm).sourceRevision;
    const finalSnapshotSha256 = channel === "x" ? "d".repeat(64) : "e".repeat(64);
    return {
      channel,
      sourceArm,
      sourceBefore,
      sourceAfter: sourceBefore,
      normalizedSha256: channel === "x" ? "a".repeat(64) : "c".repeat(64),
      normalizedSizeBytes: 1_000,
      originalMdat: {
        offsetBytes: 100,
        sizeBytes: 900,
        headerBytes: 8 as const,
        sizeHeaderHex: "00000384",
      },
      fillerProfile: "iso-bmff-explicit-mdat-private-reconstruction.v2" as const,
      finalSnapshotSha256,
      finalRevision: {
        sha256: finalSnapshotSha256,
        deviceId: "9",
        modifiedAtMs: 1_777_000_000_010,
        changedAtMs: 1_777_000_000_011,
        fileId,
        mode: 33_024,
      },
      mimeType: "video/mp4" as const,
      measured,
    };
  };
  const toolBinding = (program: "ffmpeg" | "ffprobe") => ({
    path: `/usr/bin/${program}`,
    sha256: program === "ffmpeg" ? "1".repeat(64) : "2".repeat(64),
    version: `${program} version synthetic-v5`,
    revision: {
      deviceId: "10",
      fileId: program === "ffmpeg" ? "11" : "12",
      sizeBytes: 1_000_000,
      modifiedAtMs: 1_777_000_000_000,
      changedAtMs: 1_777_000_000_001,
      mode: 33_277,
      uid: 0,
      gid: 0,
      linkCount: 1,
    },
  });
  const commitmentPreimage = blindEvaluationCommitmentPreimageSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-commitment.v5" as const,
    sessionId,
    experimentId,
    protocolSha256,
    claimScope: "development" as const,
    createdAt: "2026-08-25T12:03:00.000Z",
    nonce: "3".repeat(64),
    evaluatorScopeCredentialSha256: digest(credential),
    creationTokenSha256: digest(creationToken),
    requirements: {
      speeds: [1, 0.5] as [1, 0.5],
      bothMediaRequired: true as const,
      bothAudioRequired: true as const,
      evidenceNature: "human-attestation" as const,
      transportProfile: "canonical-private-mp4.v5" as const,
      threatModel: BLIND_EVALUATION_THREAT_MODEL as typeof BLIND_EVALUATION_THREAT_MODEL,
      timelineCoverage: blindEvaluationTimelineRequirements(0.96),
    },
    tools: { ffmpeg: toolBinding("ffmpeg"), ffprobe: toolBinding("ffprobe") },
    release: {
      sealed: false,
      verified: false,
      releaseDigest: null,
      manifestSha256: null,
      surfaceDigest: null,
      runtimeInstallSealSha256: null,
      runtimeTreeSha256: null,
      runtimePolicySha256: null,
      nodeExecutableSha256: null,
      expectedHostTcbAttestationSha256: null,
      runtimeTrust: null,
      sourceCommit: null,
    },
    normalization: {
      schemaVersion: "ltx-studio-blind-evaluation-normalization-profile.v5" as const,
      contractKind: "requested-encoder-settings" as const,
      program: "ffmpeg" as const,
      argsTemplate: [...BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE],
      containerProfile: "h264-high51-aac-lc-isom-cbr-measured.v5" as const,
      fillerProfile: "iso-bmff-explicit-mdat-private-reconstruction.v2" as const,
      target: {
        width: 1_280 as const,
        height: 1_280 as const,
        framesPerSecond: 25 as const,
        frameCount: 24,
        durationSeconds: 0.96,
        videoCodec: "h264" as const,
        videoProfile: "High" as const,
        videoLevel: 51 as const,
        pixelFormat: "yuv420p" as const,
        sampleAspectRatio: "1:1" as const,
        displayAspectRatio: "1:1" as const,
        colorRange: "tv" as const,
        colorSpace: "bt709" as const,
        colorTransfer: "bt709" as const,
        colorPrimaries: "bt709" as const,
        rotation: "none" as const,
        gopSize: 50 as const,
        keyFrameMinimum: 50 as const,
        sceneCutThreshold: 0 as const,
        bFrames: 2 as const,
        referenceFrames: 3 as const,
        videoBitRate: 12_000_000 as const,
        audioCodec: "aac" as const,
        audioProfile: "LC" as const,
        audioSampleFormat: "fltp" as const,
        audioSampleRate: 48_000 as const,
        audioChannels: 2 as const,
        audioBitRate: 192_000 as const,
        majorBrand: "isom" as const,
        compatibleBrands: "isomiso2avc1mp41" as const,
        streamLanguage: "und" as const,
        defaultDisposition: true as const,
        startTimeSeconds: 0 as const,
        videoTrackTimescale: 90_000 as const,
        audioTrackTimescale: 48_000 as const,
      },
    },
    arms: {
      baseline: { ...binding("baseline"), arm: "baseline" as const },
      candidate: { ...binding("candidate"), arm: "candidate" as const },
    },
    mapping: { x: "candidate" as const, y: "baseline" as const },
    snapshots: {
      x: { ...snapshot("x", "candidate", "81"), channel: "x" as const, sourceArm: "candidate" as const },
      y: { ...snapshot("y", "baseline", "82"), channel: "y" as const, sourceArm: "baseline" as const },
    },
  });
  const commitment = digest(commitmentPreimage);
  const publicBase = {
    schemaVersion: "ltx-studio-blind-evaluation-public.v5" as const,
    id: sessionId,
    claimScope: "development" as const,
    createdAt: commitmentPreimage.createdAt,
    commitment,
    evaluatorScope: {
      role: "blind-evaluator" as const,
      transport: "httponly-samesite-strict-session-cookie" as const,
    },
    media: {
      x: `/api/blind-evaluations/${sessionId}/media/x`,
      y: `/api/blind-evaluations/${sessionId}/media/y`,
    },
    requirements: {
      speeds: commitmentPreimage.requirements.speeds,
      bothMediaRequired: commitmentPreimage.requirements.bothMediaRequired,
      bothAudioRequired: commitmentPreimage.requirements.bothAudioRequired,
      evidenceNature: commitmentPreimage.requirements.evidenceNature,
      transportProfile: commitmentPreimage.requirements.transportProfile,
      timelineCoverage: commitmentPreimage.requirements.timelineCoverage,
    },
    threatModel: BLIND_EVALUATION_THREAT_MODEL as typeof BLIND_EVALUATION_THREAT_MODEL,
    limitation: BLIND_EVALUATION_LIMITATION as typeof BLIND_EVALUATION_LIMITATION,
  };
  const activeEvaluation = blindEvaluationPublicSchema.parse({
    ...publicBase,
    status: "active" as const,
    reveal: null,
  });
  const creatingEvaluation = blindEvaluationPublicSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-public.v5",
    id: sessionId,
    claimScope: "development",
    createdAt: commitmentPreimage.createdAt,
    commitment: null,
    evaluatorScope: publicBase.evaluatorScope,
    creation: {
      phase: "reserved",
      claimPath: `/api/blind-evaluations/${sessionId}/claim`,
    },
    status: "creating",
    reveal: null,
    threatModel: BLIND_EVALUATION_THREAT_MODEL,
    limitation: BLIND_EVALUATION_LIMITATION,
  });
  const initialPin = blindEvaluationInitialPinSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
    id: sessionId,
    commitment,
    publicStateSha256: await blindEvaluationPublicStateSha256(activeEvaluation),
  });
  let scopedEvaluation: BlindEvaluationPublic | null = null;
  const publicProtocolEqualityToken = `eq1_protocol-${experimentId}`;
  const publicBaselineRequestEqualityToken = `eq1_request-${baselineJobId}`;
  const publicCandidateRequestEqualityToken = `eq1_request-${candidateJobId}`;
  const publicExperiment = {
    schemaVersion: "ltx-studio-public-experiment.v1" as const,
    id: experiment.id,
    title: experiment.title,
    claimScope: experiment.claimScope,
    status: experiment.status,
    kind: experiment.kind,
    candidate: experiment.candidate,
    changedRequestPaths: experiment.changedRequestPaths,
    createdAt: experiment.createdAt,
    frozenAt: experiment.frozenAt,
    supersededAt: experiment.supersededAt,
    supersededReason: experiment.supersededReason,
    replacementExperimentId: experiment.replacementExperimentId,
    baselineEvidence: null,
    protocolEqualityToken: publicProtocolEqualityToken,
    arms: [{
      arm: "baseline" as const,
      request: baseline,
      jobId: baselineJobId,
      attemptJobIds: [baselineJobId],
      requestEqualityToken: publicBaselineRequestEqualityToken,
      settingsEqualityToken: `eq1_settings-${baselineJobId}`,
    }, {
      arm: "candidate" as const,
      request: candidate,
      jobId: candidateJobId,
      attemptJobIds: [candidateJobId],
      requestEqualityToken: publicCandidateRequestEqualityToken,
      settingsEqualityToken: `eq1_settings-${candidateJobId}`,
    }],
  };
  const output = (arm: "baseline" | "candidate") => {
    const selected = arm === "baseline" ? experiment.arms[0] : experiment.arms[1];
    const revisionToken = `eq1_revision-${selected.jobId}`;
    const requestEqualityToken = arm === "baseline"
      ? publicBaselineRequestEqualityToken
      : publicCandidateRequestEqualityToken;
    return {
      name: selected.request.outputName,
      url: `/api/outputs/${selected.request.outputName}`,
      sizeBytes: 4_096,
      modifiedAt: "2026-08-25T12:02:00.000Z",
      changedAt: "2026-08-25T12:02:00.000Z",
      revisionToken,
      jobId: selected.jobId,
      jobStatus: "completed" as const,
      request: selected.request,
      settingsAvailable: true,
      qualityReview: null,
      analysis: {
        schemaVersion: "ltx-studio-public-output-analysis.v1" as const,
        sourceSchemaVersion: "ltx-studio-output-analysis.v7" as const,
        outputName: selected.request.outputName,
        outputRevisionToken: revisionToken,
        jobId: selected.jobId,
        analysisId: arm === "baseline"
          ? "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1"
          : "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2",
        attempt: 1,
        status: "completed" as const,
        progress: 100,
        createdAt: "2026-08-25T12:02:00.000Z",
        startedAt: "2026-08-25T12:02:00.000Z",
        finishedAt: "2026-08-25T12:02:01.000Z",
        updatedAt: "2026-08-25T12:02:01.000Z",
        error: null,
        equality: {
          evaluator: `eq1_evaluator-${arm}`,
          expectedDialogue: null,
          identityModel: null,
        },
        result: {
          schemaVersion: "ltx-studio-objective-quality.v7" as const,
          technical: { durationSeconds: 0.96, hasAudio: true },
        },
      },
      provenanceSummary: {
        schemaVersion: "ltx-studio-public-output-provenance-summary.v1" as const,
        status: "verified" as const,
        capturedAt: "2026-08-25T12:02:00.000Z",
        verifiedAt: "2026-08-25T12:02:01.000Z",
        release: null,
        equality: {
          run: `eq1_run-${arm}`,
          inputs: `eq1_inputs-${arm}`,
          models: `eq1_models-${arm}`,
          code: `eq1_code-${arm}`,
          runtime: `eq1_runtime-${arm}`,
        },
      },
      experiment: {
        schemaVersion: "ltx-studio-public-experiment-run.v1" as const,
        experimentId,
        protocolEqualityToken: publicProtocolEqualityToken,
        arm,
        kind: "replicate" as const,
        variableId: "replicate-seed",
        changedRequestPaths: ["seed"],
        baselineRequestEqualityToken: publicBaselineRequestEqualityToken,
        requestEqualityToken,
        baselineJobId: arm === "baseline" ? null : baselineJobId,
        baselineOutputName: baseline.outputName,
      },
      project: null,
      experimentRequestVerified: true,
    };
  };
  await page.route(/\/api\/experiments(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ experiments: [publicExperiment], warnings: [] }),
  }));
  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outputs: [output("baseline"), output("candidate")] }),
  }));
  await page.route(/\/api\/blind-evaluations$/, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({ experimentId });
    expect(body.creationRequestId).toMatch(/^[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty("creationToken");
    scopedEvaluation = creatingEvaluation;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      headers: {
        "Set-Cookie": `${BLIND_EVALUATOR_SCOPE_COOKIE}=${credential}; Path=/api; HttpOnly; SameSite=Strict`,
      },
      body: JSON.stringify({ evaluation: creatingEvaluation, creationToken }),
    });
  });
  let claimAttempts = 0;
  await page.route(`/api/blind-evaluations/${sessionId}/claim`, async (route) => {
    claimAttempts += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ creationToken });
    expect(route.request().headers().cookie).toContain(`${BLIND_EVALUATOR_SCOPE_COOKIE}=${credential}`);
    scopedEvaluation = activeEvaluation;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (claimAttempts === 1) return route.abort("failed");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evaluation: activeEvaluation }),
    });
  });
  await page.route(`/api/blind-evaluations/${sessionId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ evaluation: scopedEvaluation ?? creatingEvaluation }),
  }));
  const tinyMp4 = Buffer.from(
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAXMbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAnF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHpbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABlG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVRzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwAraEJsBEAAAAwAQAAADAKDxImoBAAVozgOcgAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABTIAAAUyAAAABhzdHRzAAAAAAAAAAEAAAAFAAAIAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAAChzdHN6AAAAAAAAAAAAAAAFAAACcQAAAAoAAAAKAAAACgAAAAoAAAAkc3RjbwAAAAAAAAAFAAAGEQAACIoAAAicAAAIqgAACLwAAAKFdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAgAAAAAAAAOAAAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAADgAAABAAAAQAAAAAB/W1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAACAAVcQAAAAAAC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAahtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWxzdGJsAAAAfnN0c2QAAAAAAAAAAQAAAG5tcDRhAAAAAAAAAAEAAAAAAAAAAAABABAAAAAAH0AAAAAAADZlc2RzAAAAAAOAgIAlAAIABICAgBdAFQAAAAAAPoAAAAF+BYCAgAUViFblAAaAgIABAgAAABRidHJ0AAAAAAAAPoAAAAF+AAAAGHN0dHMAAAAAAAAAAQAAAAgAAAQAAAAAQHN0c2MAAAAAAAAABAAAAAEAAAABAAAAAQAAAAIAAAACAAAAAQAAAAQAAAABAAAAAQAAAAUAAAACAAAAAQAAADRzdHN6AAAAAAAAAAAAAAAIAAAAFQAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAkc3RjbwAAAAAAAAAFAAAF/AAACIIAAAiUAAAIpgAACLQAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAACAAAAAEAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAAC0m1kYXTeAgBMYXZjNjAuMzEuMTAyAAIwQA4AAAJTBgX//0/cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVLVC00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj01IHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9NDAuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAAWZYiEOiYoAAgYycnJyl3d3d3d3eABGCAXARggBwAAAAYBmiAUoIwBGCAHARggBwAAAAYBmkAUoIwBGCAHAAAAAYBmgFWAjAEYIAcBGCAHAAAAAYBmoAVoIw==",
    "base64",
  );
  const extendLastMdat = (source: Buffer) => {
    const target = Math.ceil((source.length + 8) / BLIND_EVALUATION_PADDING_BUCKET_BYTES)
      * BLIND_EVALUATION_PADDING_BUCKET_BYTES;
    let offset = 0;
    let lastMdatOffset = -1;
    while (offset < source.length) {
      const size = source.readUInt32BE(offset);
      const type = source.toString("ascii", offset + 4, offset + 8);
      if (size < 8 || offset + size > source.length) throw new Error("invalid synthetic MP4");
      if (type === "mdat") lastMdatOffset = offset;
      offset += size;
    }
    if (offset !== source.length || lastMdatOffset < 0
      || lastMdatOffset + source.readUInt32BE(lastMdatOffset) !== source.length) {
      throw new Error("missing final synthetic mdat");
    }
    const result = Buffer.alloc(target);
    source.copy(result);
    randomFillSync(result, source.length, target - source.length);
    result.writeUInt32BE(target - lastMdatOffset, lastMdatOffset);
    return result;
  };
  mkdirSync(testInfo.outputDir, { recursive: true });
  const normalizedBrowserSource = async (
    name: "x" | "y",
    color: "red" | "blue",
    duration: number,
  ) => {
    const sourcePath = testInfo.outputPath(`browser-source-${name}.mp4`);
    const normalizedPath = testInfo.outputPath(`browser-normalized-${name}.mp4`);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=12:d=${duration}`,
      "-f", "lavfi", "-i", `sine=frequency=${name === "x" ? 440 : 660}:duration=${duration}`,
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "100k",
      "-pix_fmt", "yuv420p", "-c:a", "libopus", "-shortest",
      "-metadata", `title=private-${name}`, sourcePath,
    ], { timeout: 30_000 });
    const args = BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE.map((value) => {
      return value
        .replaceAll("{source-fd}", sourcePath)
        .replaceAll("{target}", normalizedPath)
        .replaceAll("{frame-count}", "24")
        .replaceAll("{duration}", "0.960000");
    });
    await execFileAsync("ffmpeg", args, { timeout: 30_000 });
    return readFileSync(normalizedPath);
  };
  const [normalizedBrowserX, normalizedBrowserY] = await Promise.all([
    normalizedBrowserSource("x", "red", 1),
    normalizedBrowserSource("y", "blue", 1.35),
  ]);
  expect(normalizedBrowserX.length).not.toBe(normalizedBrowserY.length);
  expect(normalizedBrowserX).not.toEqual(tinyMp4);
  const browserProbeMedia = {
    x: extendLastMdat(normalizedBrowserX),
    y: extendLastMdat(normalizedBrowserY),
  };
  expect(browserProbeMedia.x).toHaveLength(BLIND_EVALUATION_PADDING_BUCKET_BYTES);
  expect(browserProbeMedia.y).toHaveLength(BLIND_EVALUATION_PADDING_BUCKET_BYTES);
  await page.route(/\/blind-browser-probe-[xy]\.mp4$/, (route) => {
    const channel = route.request().url().endsWith("-x.mp4") ? "x" : "y";
    const media = browserProbeMedia[channel];
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
    const body = media.subarray(start, end + 1);
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/mp4",
      headers: {
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}),
      },
      body,
    });
  });
  const chromiumH264Support = await page.evaluate(() => document.createElement("video")
    .canPlayType('video/mp4; codecs="avc1.640033, mp4a.40.2"'));
  expect(["", "maybe", "probably"]).toContain(chromiumH264Support);

  const playwrightCache = join(homedir(), ".cache", "ms-playwright");
  const firefoxExecutable = [codecFirefox.executablePath(), ...(
    existsSync(playwrightCache)
      ? readdirSync(playwrightCache)
        .filter((name) => /^firefox-\d+$/.test(name))
        .sort().reverse()
        .map((name) => join(playwrightCache, name, "firefox", "firefox"))
      : []
  )].find((candidatePath) => existsSync(candidatePath));
  expect(firefoxExecutable, "Ein Playwright-Firefox mit H.264/AAC-Systemdecodern ist für den Realdecode erforderlich.")
    .toBeTruthy();
  const codecXPath = testInfo.outputPath("browser-final-x.mp4");
  const codecYPath = testInfo.outputPath("browser-final-y.mp4");
  writeFileSync(codecXPath, browserProbeMedia.x);
  writeFileSync(codecYPath, browserProbeMedia.y);
  const playbackScript = String.raw`
    const http = require("node:http");
    const { readFileSync } = require("node:fs");
    const { firefox } = require("playwright-core");
    (async () => {
      const media = { x: readFileSync(process.argv[1]), y: readFileSync(process.argv[2]) };
      const server = http.createServer((request, response) => {
        const body = request.url === "/y.mp4" ? media.y : media.x;
        response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
        response.end(body);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const browser = await firefox.launch({ headless: true, executablePath: process.argv[3] });
      try {
        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();
        const port = server.address().port;
        const result = await page.evaluate(async (urls) => {
          const play = async (source) => {
            const video = document.createElement("video");
            video.muted = true;
            video.preload = "auto";
            video.src = source;
            document.body.appendChild(video);
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("browser playback timeout")), 8000);
              video.addEventListener("canplay", () => { clearTimeout(timer); resolve(); }, { once: true });
              video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("browser rejected final MP4")); }, { once: true });
            });
            await video.play();
            const observed = { readyState: video.readyState, paused: video.paused, duration: video.duration };
            video.pause();
            return observed;
          };
          return Promise.all(urls.map(play));
        }, ["http://127.0.0.1:" + port + "/x.mp4", "http://127.0.0.1:" + port + "/y.mp4"]);
        process.stdout.write(JSON.stringify(result));
      } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
      }
    })().catch((error) => { process.stderr.write(String(error.stack || error)); process.exit(1); });
  `;
  const browserPlaybackResult = await execFileAsync(process.execPath, [
    "-e", playbackScript, codecXPath, codecYPath, firefoxExecutable!,
  ], { encoding: "utf8", timeout: 30_000 });
  const browserPlayback = JSON.parse(browserPlaybackResult.stdout) as Array<{
    readyState: number;
    paused: boolean;
    duration: number;
  }>;
  expect(browserPlayback.every((result) => result.readyState >= 3 && !result.paused && result.duration > 0)).toBe(true);
  await page.unroute(/\/blind-browser-probe-[xy]\.mp4$/);
  // Install the scope interceptor only after all asynchronous ffmpeg/codec
  // fixture work has settled. Keeping an intercepted watchdog request pending
  // across fixture preparation would test the harness rather than a real outage.
  await page.route("/api/blind-evaluator-scope", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ locked: scopedEvaluation !== null, evaluation: scopedEvaluation }),
  }));
  let failYMedia = true;
  await page.route(/\/api\/blind-evaluations\/.+\/media\/[xy]$/, (route) => {
    const isY = route.request().url().endsWith("/y");
    if (isY && failYMedia) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Y missing" }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "video/mp4",
      headers: { "Cache-Control": "no-store", "Accept-Ranges": "bytes" },
      body: browserProbeMedia[isY ? "y" : "x"],
    });
  });
  let submitAttempts = 0;
  let durableSubmissionPinHeader: string | null = null;
  await page.route(`/api/blind-evaluations/${sessionId}/submission`, async (route) => {
    submitAttempts += 1;
    const headers = route.request().headers();
    expect(headers["if-match"]).toBe(`"${initialPin.publicStateSha256}"`);
    expect(headers["x-blind-evaluation-id"]).toBe(initialPin.id);
    expect(headers["x-blind-evaluation-commitment"]).toBe(initialPin.commitment);
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f]{64}$/);
    if (durableSubmissionPinHeader === null) {
      durableSubmissionPinHeader = headers["x-blind-submission-pin"] ?? null;
    } else {
      expect(headers["x-blind-submission-pin"]).toBe(durableSubmissionPinHeader);
    }
    const browserSubmissionPin = blindEvaluationSubmissionPinSchema.parse(JSON.parse(
      Buffer.from(headers["x-blind-submission-pin"] ?? "", "base64url").toString("utf8"),
    ));
    expect(browserSubmissionPin).toMatchObject({
      sessionId,
      commitment,
      idempotencyKey: headers["idempotency-key"],
    });
    const submission = route.request().postDataJSON();
    expect(submission.playback.y.normalSpeed.coverageRatio).toBeGreaterThanOrEqual(0.9);
    expect(submission.playback.y.audibleNormalSpeed.coverageRatio).toBeGreaterThanOrEqual(0.9);
    expect(submission.playback.y.halfSpeed.coverageRatio).toBeGreaterThanOrEqual(0.5);
    expect(submission.playback.y.normalSpeed.ended).toBe(true);
    expect(submission.playback.y.halfSpeed.ended).toBe(true);
    expect(submission.playback.y.audioReviewed).toBe(true);
    const submissionPreimage = {
      schemaVersion: "ltx-studio-blind-evaluation-submission.v5" as const,
      sessionId,
      commitment,
      idempotencyKey: headers["idempotency-key"]!,
      submissionInputSha256: digest({ submission, initialPin }),
      initialPublicStateSha256: initialPin.publicStateSha256,
      browserSubmissionPin,
      mediaAccessedAt: { x: "2026-08-25T12:03:01.000Z", y: "2026-08-25T12:03:02.000Z" },
      submittedAt: new Date(Date.parse(browserSubmissionPin.pinnedAt) + 1_000).toISOString(),
      submission,
    };
    const validEvaluation = blindEvaluationPublicSchema.parse({
      ...publicBase,
      status: "submitted" as const,
      reveal: {
        commitmentPreimage,
        submissionPreimage,
        submissionSha256: digest(submissionPreimage),
      },
    });
    let returnedEvaluation: BlindEvaluationPublic = validEvaluation;
    if (submitAttempts === 1) {
      const swappedId = "82828282-8282-4828-8828-828282828282";
      const swappedCommitmentPreimage = structuredClone(commitmentPreimage);
      swappedCommitmentPreimage.sessionId = swappedId;
      const swappedCommitment = digest(swappedCommitmentPreimage);
      const swappedBase = {
        ...publicBase,
        id: swappedId,
        commitment: swappedCommitment,
        media: {
          x: `/api/blind-evaluations/${swappedId}/media/x`,
          y: `/api/blind-evaluations/${swappedId}/media/y`,
        },
      };
      const swappedActive = blindEvaluationPublicSchema.parse({
        ...swappedBase,
        status: "active" as const,
        reveal: null,
      });
      const swappedPin = blindEvaluationInitialPinSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
        id: swappedId,
        commitment: swappedCommitment,
        publicStateSha256: await blindEvaluationPublicStateSha256(swappedActive),
      });
      const swappedSubmissionPreimage = {
        ...submissionPreimage,
        sessionId: swappedId,
        commitment: swappedCommitment,
        initialPublicStateSha256: swappedPin.publicStateSha256,
      };
      const swappedSubmissionPin = await createBlindEvaluationSubmissionPin(
        submission,
        swappedPin,
        headers["idempotency-key"]!,
        browserSubmissionPin.pinnedAt,
      );
      swappedSubmissionPreimage.browserSubmissionPin = swappedSubmissionPin;
      swappedSubmissionPreimage.submissionInputSha256 = swappedSubmissionPin.submissionInputSha256;
      returnedEvaluation = blindEvaluationPublicSchema.parse({
        ...swappedBase,
        status: "submitted" as const,
        reveal: {
          commitmentPreimage: swappedCommitmentPreimage,
          submissionPreimage: swappedSubmissionPreimage,
          submissionSha256: digest(swappedSubmissionPreimage),
        },
      });
      expect(await verifyBlindEvaluationReveal(returnedEvaluation, swappedPin, swappedSubmissionPin)).toMatchObject({ valid: true });
    }
    if (returnedEvaluation.id === sessionId) scopedEvaluation = returnedEvaluation;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ evaluation: returnedEvaluation }),
    });
  });
  await page.route(`/api/blind-evaluations/${sessionId}/abort`, (route) => {
    scopedEvaluation = null;
    return route.fulfill({
      status: 204,
      headers: {
        "Set-Cookie": `${BLIND_EVALUATOR_SCOPE_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
      },
    });
  });
  await page.route(`/api/blind-evaluations/${sessionId}/scope/release`, (route) => {
    scopedEvaluation = null;
    return route.fulfill({
      status: 204,
      headers: {
        "Set-Cookie": `${BLIND_EVALUATOR_SCOPE_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
      },
    });
  });
  await page.addInitScript(() => {
    const originalEventSourceClose = EventSource.prototype.close;
    EventSource.prototype.close = function trackedClose() {
      const count = Number(sessionStorage.getItem("blind-v5-sse-close-count") ?? "0");
      sessionStorage.setItem("blind-v5-sse-close-count", String(count + 1));
      return originalEventSourceClose.call(this);
    };
    const times = new WeakMap<HTMLMediaElement, number>();
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() { return times.get(this) ?? 0; },
      set(value: number) { times.set(this, value); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return 0.96; } });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get() { return 4; } });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() { return paused.get(this) ?? true; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "ended", { configurable: true, get() { return false; } });
    HTMLMediaElement.prototype.play = async function play() {
      const caption = this.parentElement?.querySelector("figcaption")?.textContent ?? "";
      if (caption.includes("Y") && (window as typeof window & { __failYPlay?: boolean }).__failYPlay) {
        throw new DOMException("Y play rejected", "NotAllowedError");
      }
      paused.set(this, false);
      this.dispatchEvent(new Event("playing"));
    };
    HTMLMediaElement.prototype.pause = function pause() {
      paused.set(this, true);
      this.dispatchEvent(new Event("pause"));
    };
  });

  const installScopeRoutes = async (target: typeof page) => {
    await target.route("/api/blind-evaluator-scope", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locked: scopedEvaluation !== null, evaluation: scopedEvaluation }),
    }));
    await target.route(`/api/blind-evaluations/${sessionId}`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evaluation: scopedEvaluation ?? activeEvaluation }),
    }));
  };
  const peer = await page.context().newPage();
  await peer.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });
  await peer.route("**/api/events", (route) => route.abort());
  await installScopeRoutes(peer);
  await peer.goto("/");
  await expect(peer.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
  await expect(peer.getByRole("button", { name: "Experimente öffnen" })).toBeVisible();

  await page.bringToFront();
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-blind-scope-revalidating", "true");
  await page.getByRole("button", { name: "Experimente öffnen" }).click();
  await page.evaluate(() => sessionStorage.setItem("blind-v5-sse-close-count", "0"));
  await page.getByRole("button", { name: "Verblindet bewerten" }).click();
  // React's development StrictMode retries the creating effect while the first
  // response is deliberately lost; both claims carry the identical authority.
  await expect.poll(() => claimAttempts).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#.*commitment=${commitment}`));
  expect(page.url()).not.toContain("creating=v5");
  expect(page.url()).not.toContain(creationToken);
  // toHaveURL observes the document navigation before main.tsx necessarily
  // finishes its bootstrap. The pending creation token is removed by that
  // bootstrap, so wait for the terminal storage state instead of racing it.
  await expect.poll(
    async () => {
      try {
        return await page.evaluate(() => sessionStorage.getItem("ltx-studio-blind-creation.v5"));
      } catch (error) {
        if (error instanceof Error && error.message.includes("Execution context was destroyed")) {
          return "navigation-in-progress";
        }
        throw error;
      }
    },
  ).toBeNull();
  await expect(peer).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#`), { timeout: 3_000 });
  await expect(peer.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(peer.getByRole("button", { name: "Experimente öffnen" })).toHaveCount(0);
  await expect(peer.locator(".experiment-panel, .run-panel")).toHaveCount(0);
  const peerRootCommit = peer.waitForEvent("framenavigated", {
    predicate: (frame) => frame === peer.mainFrame() && new URL(frame.url()).pathname === "/",
  });
  const peerRootNavigation = peer.goto("/").then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await peerRootCommit;
  await expect(peer).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#`));
  // The bootstrap's expected hard redirect may supersede `goto()` before its
  // lifecycle wait finishes. A committed root document plus the final scoped
  // URL is the engine-neutral proof; the browser-specific abort text is not.
  await peerRootNavigation;
  await peer.goBack();
  await expect(peer).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#`));
  const newRootTab = await page.context().newPage();
  await installScopeRoutes(newRootTab);
  await newRootTab.goto("/");
  await expect(newRootTab).toHaveURL(new RegExp(`/blind-evaluation/${sessionId}#`));
  await expect(newRootTab.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(newRootTab.getByRole("button", { name: "Experimente öffnen" })).toHaveCount(0);
  await expect(newRootTab.locator(".experiment-panel, .run-panel")).toHaveCount(0);
  await peer.close();
  await newRootTab.close();
  const dialog = page.getByRole("dialog", { name: "Verblindeter X/Y-Vergleich" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Video Y konnte nicht geladen werden.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Einmalig abgeben und aufdecken" })).toBeDisabled();
  expect(await page.evaluate(() => document.querySelector("#root")?.childElementCount)).toBe(1);
  await expect(page.locator(".app-shell, .experiment-panel, .run-panel")).toHaveCount(0);
  expect(await page.evaluate(() => Number(sessionStorage.getItem("blind-v5-sse-close-count") ?? "0"))).toBeGreaterThan(0);
  const evaluatorText = await page.evaluate(() => document.body.innerText);
  expect(evaluatorText).not.toContain(baseline.outputName);
  expect(evaluatorText).not.toContain(candidate.outputName);
  expect(evaluatorText).not.toContain(experiment.title);
  // Chromium drops a Set-Cookie synthesized by route.fulfill() after the
  // cross-tab hard-navigation sequence, while Firefox retains it. Re-pin the
  // same HttpOnly API-scoped capability in the harness so this assertion tests
  // the real server gate consistently instead of a browser interception quirk.
  await page.context().addCookies([{
    name: BLIND_EVALUATOR_SCOPE_COOKIE,
    value: credential,
    domain: new URL(page.url()).hostname,
    path: "/api",
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
  }]);
  expect(await page.evaluate(async () => (await fetch("/api/jobs")).status)).toBe(403);
  const focusables = dialog.locator(
    "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  );
  await focusables.last().focus();
  await page.keyboard.press("Tab");
  await expect(focusables.first()).toBeFocused();

  failYMedia = false;
  await dialog.locator("video").evaluateAll((videos) => {
    for (const video of videos) {
      const media = video as HTMLVideoElement;
      media.removeAttribute("src");
      media.dispatchEvent(new Event("loadedmetadata"));
      media.dispatchEvent(new Event("canplay"));
    }
  });
  await expect(dialog.getByTitle("Video abspielen Y")).toBeEnabled();
  await page.evaluate(() => { (window as typeof window & { __failYPlay?: boolean }).__failYPlay = true; });
  await dialog.getByTitle("Video abspielen Y").click();
  await expect(dialog.getByText("Wiedergabe von Video Y ist fehlgeschlagen.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Einmalig abgeben und aufdecken" })).toBeDisabled();
  await page.evaluate(() => { (window as typeof window & { __failYPlay?: boolean }).__failYPlay = false; });
  await dialog.locator("video").nth(1).evaluate((video) => {
    const media = video as HTMLVideoElement;
    media.dispatchEvent(new Event("loadedmetadata"));
    media.dispatchEvent(new Event("canplay"));
  });
  await expect(dialog.getByTitle("Video abspielen Y")).toBeEnabled();

  const review = async (channel: "X" | "Y", rate: "1×" | "0,5×") => {
    await dialog.getByRole("button", { name: rate, exact: true }).click();
    await dialog.getByTitle(`Ton von Video ${channel}`).click();
    const video = dialog.locator("video").nth(channel === "X" ? 0 : 1);
    await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.currentTime = 0;
      media.dispatchEvent(new Event("seeking"));
    });
    await dialog.getByTitle(`Video abspielen ${channel}`).click();
    await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      for (const time of [0.12, 0.24, 0.36, 0.48, 0.60, 0.72, 0.84, 0.96]) {
        media.currentTime = time;
        media.dispatchEvent(new Event("timeupdate"));
      }
      media.dispatchEvent(new Event("ended"));
    });
    await expect(dialog.getByTitle(`Video abspielen ${channel}`)).toBeVisible();
  };

  // Replaying the same short slice cannot satisfy unique timeline coverage.
  await dialog.getByRole("button", { name: "1×", exact: true }).click();
  await dialog.getByTitle("Ton von Video X").click();
  for (let pass = 0; pass < 2; pass += 1) {
    const video = dialog.locator("video").nth(0);
    await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.currentTime = 0;
      media.dispatchEvent(new Event("seeking"));
    });
    await dialog.getByTitle("Video abspielen X").click();
    await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      for (const time of [0.1, 0.2]) {
        media.currentTime = time;
        media.dispatchEvent(new Event("timeupdate"));
      }
    });
    await dialog.getByTitle("Video pausieren X").click();
  }
  await expect(dialog.getByText(/1× eindeutige Timeline: X 21%, Y 0%/)).toBeVisible();
  await expect(dialog.getByLabel("X und Y bei 1× bewusst verglichen")).toBeDisabled();

  await review("X", "1×");
  await review("Y", "1×");
  await review("X", "0,5×");
  await review("Y", "0,5×");
  await dialog.getByLabel("Ton und Lippen von Video X bewusst verglichen").check();
  await dialog.getByLabel("Ton und Lippen von Video Y bewusst verglichen").check();
  await dialog.getByLabel("X und Y bei 1× bewusst verglichen").check();
  await dialog.getByLabel("Mund, Augen und Übergänge bei 0,5× geprüft").check();
  await dialog.getByLabel(/Ich bestätige diese menschliche Beobachtung/).check();
  for (const channel of ["X", "Y"]) {
    for (const metric of ["Laut-/Lippen-Timing", "Mundintegration", "Augen / Identität", "Auflösung / Details"]) {
      await dialog.getByLabel(`${channel} ${metric}`).selectOption("8");
    }
  }
  await dialog.getByLabel("Gesamtpräferenz").selectOption("x");
  await dialog.getByLabel("Sicherheit der Bewertung").selectOption("4");
  await dialog.getByLabel("Beobachtungsnotiz").fill("X wirkt im getrennten Vergleich stabiler.");
  await dialog.getByRole("button", { name: "Einmalig abgeben und aufdecken" }).click();

  await expect(dialog.getByRole("alert")).toContainText("initial fixierten Browser-Pin");
  await expect(page.getByRole("dialog", { name: "Aufgedeckte Blindbewertung" })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain(candidate.outputName);
  expect(submitAttempts).toBe(1);
  expect(await page.evaluate((id) => localStorage.getItem(
    `ltx-studio.blind-submission-pin.v5.${id}`,
  ), sessionId)).not.toBeNull();
  await dialog.getByLabel("Beobachtungsnotiz").fill("Mutation nach dem dauerhaften Browser-Pin.");
  await dialog.getByRole("button", { name: "Einmalig abgeben und aufdecken" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Konflikt mit diesem Retry");
  expect(submitAttempts).toBe(1);
  await dialog.getByLabel("Beobachtungsnotiz").fill("X wirkt im getrennten Vergleich stabiler.");
  await dialog.getByRole("button", { name: "Einmalig abgeben und aufdecken" }).click();

  const reveal = page.getByRole("dialog", { name: "Aufgedeckte Blindbewertung" });
  await expect(reveal).toContainText("Commitment, Browser-Pin und Submission clientseitig erfolgreich nachgerechnet");
  await expect(reveal).toContainText(`X war Kandidat: ${candidate.outputName}`);
  await expect(reveal).toContainText(`Y war Baseline: ${baseline.outputName}`);
  await reveal.getByRole("button", { name: "Zurück zum Studio" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#root > *").first()).toBeVisible();
  expect(await page.evaluate(async () => (await fetch("/api/jobs")).status)).toBe(200);
  expect(await page.evaluate((id) => localStorage.getItem(
    `ltx-studio.blind-submission-pin.v5.${id}`,
  ), sessionId)).toBeNull();
});

test("Blind Evidence v5 release clears a session cookie even for a missing or corrupt session", async ({ page, context }) => {
  // Keep this server-cookie edge case independent of the page watchdog: the
  // scope endpoint is itself entitled to clear a corrupt cookie, which would
  // race the release endpoint if a mounted document kept polling it.
  const hostname = new URL(page.url()).hostname;
  await page.close();
  await context.addCookies([{
    name: BLIND_EVALUATOR_SCOPE_COOKIE,
    value: "6".repeat(64),
    domain: hostname,
    path: "/api",
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
  }]);
  expect((await context.request.get("/api/jobs")).status()).toBe(403);
  expect((await context.request.post(
    "/api/blind-evaluations/12121212-1212-4212-8212-121212121212/scope/release",
    { data: {} },
  )).status()).toBe(204);
  expect((await context.request.get("/api/jobs")).status()).toBe(200);
});

test("API exposes bounded model inventory and request estimates", async ({ request }) => {
  const forbiddenKeys = new Set([
    "source",
    "additionalSources",
    "fileId",
    "deviceId",
    "inode",
    "sha256",
    "command",
    "commands",
    "frame",
    "activation",
    "releaseDigest",
    "manifestSha256",
    "surfaceDigest",
    "sourceCommit",
    "runtimeInstallSealSha256",
    "runtimeTreeSha256",
    "runtimePolicySha256",
    "nodeExecutableSha256",
    "actualSha256",
    "expectedSha256",
    "expectedContents",
  ]);
  const leakedKeys = (value: unknown, path = "$"): string[] => {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => leakedKeys(item, `${path}[${index}]`));
    }
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, item]) => [
      ...(forbiddenKeys.has(key) ? [`${path}.${key}`] : []),
      ...leakedKeys(item, `${path}.${key}`),
    ]);
  };

  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  const publicHealth = await health.json();
  expect(publicHealth.evaluators.phonemeViseme).toMatchObject({
    status: "not-available",
    blockerCode: "manifest-missing",
    productGo: "blocked",
    measurementReady: false,
    method: null,
  });
  expect(publicHealth.evaluators.t2aAudio).toEqual({
    status: "blocked",
    claimScope: null,
    blockerCode: "development-opt-in-required",
    message: "T2A-Audio-QA benoetigt in der Entwicklungs-Laufzeit ein ausdrueckliches Mess-Opt-in.",
    productGo: "blocked",
    measurementReady: false,
  });
  expect(leakedKeys(publicHealth)).toEqual([]);

  const blockedT2aStart = await request.post("/api/outputs/public-health.wav/analysis", {
    data: { force: false },
  });
  expect(blockedT2aStart.status()).toBe(503);
  const blockedT2aStartBody = await blockedT2aStart.json();
  expect(blockedT2aStartBody).toMatchObject({
    error: "T2A-Audio-QA benoetigt in der Entwicklungs-Laufzeit ein ausdrueckliches Mess-Opt-in.",
    blockerCode: "development-opt-in-required",
  });
  expect(blockedT2aStartBody.correlationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(leakedKeys(blockedT2aStartBody)).toEqual([]);

  const models = await request.get("/api/models");
  expect(models.ok()).toBe(true);
  const inventory = await models.json();
  expect(inventory.errors).toEqual([]);
  expect(Array.isArray(inventory.items)).toBe(true);
  expect(inventory.recommendations.some((item: { kind: string }) => item.kind === "gemma")).toBe(true);
  expect(inventory.recommendations.some((item: { kind: string }) => item.kind === "checkpoint")).toBe(true);
  expect(leakedKeys(inventory)).toEqual([]);

  const assets = await request.get("/api/assets?kind=image");
  expect(assets.ok()).toBe(true);
  const publicAssets = await assets.json();
  expect(Array.isArray(publicAssets.assets)).toBe(true);
  expect(leakedKeys(publicAssets)).toEqual([]);

  const validUpload = await request.post("/api/uploads/image", {
    multipart: {
      file: {
        name: "public-control.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      },
    },
  });
  expect(validUpload.status()).toBe(201);
  const publicUpload = await validUpload.json();
  expect(publicUpload).toMatchObject({
    name: "public-control.png",
    kind: "image",
    derivation: null,
  });
  expect(leakedKeys(publicUpload)).toEqual([]);

  const disguisedUpload = await request.post("/api/uploads/image", {
    multipart: {
      file: {
        name: "disguised.png",
        mimeType: "image/png",
        buffer: Buffer.from("<script>alert(1)</script>"),
      },
    },
  });
  expect(disguisedUpload.status()).toBe(400);
  expect(await disguisedUpload.json()).toMatchObject({
    error: "Dateiinhalt passt nicht zum erlaubten Medienformat.",
  });
});
