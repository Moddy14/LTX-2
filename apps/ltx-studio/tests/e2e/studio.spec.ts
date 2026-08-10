import { expect, test } from "@playwright/test";
import { createDefaultRequest, pipelineModes } from "../../shared/pipelines.js";
import { applyExperimentCandidate } from "../../shared/experiments.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
});

test("desktop exposes every production mode and contextual controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop-only density assertions");
  const modes = page.locator(".mode-button");
  await expect(modes).toHaveCount(pipelineModes.length);
  await expect(page.locator(".run-button")).toBeVisible();
  await expect(page.getByText("Steuern", { exact: true })).toBeVisible();
  await expect(page.getByText("Bearbeiten", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /HQ Maximale Qualität/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("HQ Zwei-Stufen");
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

test("IC-LoRA switches between every published LTX-2.3 profile", async ({ page }, testInfo) => {
  await page.locator(".mode-button").filter({ hasText: "IC-LoRA" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offiziell IC-LoRA Kontrolle");
  await expect(page.getByRole("button", { name: "Union Control" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Kontrollvideo" })).toBeVisible();
  await expect(page.getByLabel("Union-Control IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Union-Control/"
    + "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
  );
  await expect(page.getByLabel("Distilled Checkpoint Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-fp8/ltx-2.3-22b-distilled-fp8.safetensors",
  );
  await expect(page.getByLabel("Distilled LoRA Pfad")).toHaveCount(0);
  await expect(page.getByLabel("Gemma Abliterated LoRA Pfad")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "FPS" })).toHaveValue("25");
  await page.screenshot({ path: testInfo.outputPath("ic-lora-union-control.png"), fullPage: true });

  await page.getByRole("button", { name: "Ingredients" }).click();

  await expect(page.getByRole("button", { name: "Ingredients" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Zutaten-Referenzbild" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kontrollvideo" })).toHaveCount(0);
  await expect(page.getByLabel("Ingredients IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Ingredients/"
    + "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
  );
  await expect(page.getByLabel("Checkpoint Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-dev.safetensors",
  );
  await expect(
    page.locator(".paired-field").filter({ has: page.getByLabel("Distilled LoRA Pfad") }).getByLabel("Stärke"),
  ).toHaveValue("0.5");
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

  await page.getByRole("button", { name: "Pixel x4" }).click();
  await expect(page.getByRole("heading", { name: "Bewegungs-Referenzbild" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quellvideo" })).toBeVisible();
  await expect(page.getByLabel("Pixel Spatial Upscaler x4 IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler/"
    + "ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x4-0.9.safetensors",
  );

  await page.getByRole("button", { name: "V2V Rasur" }).click();
  await expect(page.getByLabel("Instant-Shave V2V IC-LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Instant-Shave/"
    + "ltx-2.3-22b-ic-lora-instant-shave-0.9.safetensors",
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

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offiziell Text zu Audio");
  await expect(page.getByLabel("Audio-Beschreibung")).toBeVisible();
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue("ltx-text-to-audio.wav");
  await expect(page.getByLabel("Checkpoint Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-dev.safetensors",
  );
  await expect(page.getByLabel("Distilled LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
  );
  await expect(
    page.locator(".paired-field").filter({ has: page.getByLabel("Distilled LoRA Pfad") }).getByLabel("Stärke"),
  ).toHaveValue("0.5");
  await expect(page.getByRole("button", { name: "FP8 Cast" })).toHaveAttribute("aria-pressed", "true");
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

test("official model binding and prompt validation stay in context", async ({ page }) => {
  const prompt = page.getByLabel("Positive Beschreibung");
  const checkpoint = page.getByLabel("Checkpoint Pfad");
  const gemmaRoot = page.getByLabel("Gemma Root Pfad");
  const outputName = page.getByLabel("Ausgabedatei");
  await prompt.fill("A deliberate camera move through a detailed workshop.");
  await expect(checkpoint).toHaveValue(/ltx-2\.3-22b-dev-fp8\.safetensors$/);
  await expect(gemmaRoot).toHaveValue(/google__gemma-3-12b-it-qat-q4_0-unquantized$/);
  await checkpoint.fill("");
  await gemmaRoot.fill("");
  await expect(checkpoint).toHaveValue(/ltx-2\.3-22b-dev-fp8\.safetensors$/);
  await expect(gemmaRoot).toHaveValue(/google__gemma-3-12b-it-qat-q4_0-unquantized$/);
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
  await expect(page.getByRole("textbox", { name: "Checkpoint Pfad", exact: true })).toBeVisible();
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
  await expect(page.getByRole("spinbutton", { name: "Frames", exact: true })).toHaveValue("249");
});

test("adding native dialogue immediately selects the complete official speech stack", async ({ page }) => {
  await page.getByLabel("Gesprochener Text", { exact: true }).fill(
    "Dieser Satz aktiviert den offiziellen Sprachpfad.",
  );

  await expect(page.getByLabel("Distilled LoRA Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Comfy-Org__ltx-2.3/split_files/loras/"
    + "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
  );
  await expect(page.getByLabel("Spatial Upscaler Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
  );
  await expect(page.getByLabel("Gemma Root Pfad")).toHaveValue(
    "/home/moddy/LTX-2.3-max/google__gemma-3-12b-it-qat-q4_0-unquantized",
  );
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
  request.models.gemmaLora = { path: "/models/gemma-lora.safetensors", strength: 1 };
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
      schemaVersion: "ltx-studio-experiment.v1" as const,
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
      protocolSha256: status === "frozen" ? "a".repeat(64) : null,
      arms: [
        {
          arm: "baseline" as const,
          request: baseline,
          requestSha256: "b".repeat(64),
          settingsSha256: "c".repeat(64),
          jobId: null,
          attemptJobIds: [],
        },
        {
          arm: "candidate" as const,
          request: candidate,
          requestSha256: "d".repeat(64),
          settingsSha256: "e".repeat(64),
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
        resources: {
          availableMemoryGiB: 96,
          totalMemoryGiB: 128,
          swapFreeGiB: 8,
          swapTotalGiB: 8,
          outputFreeGiB: 512,
        },
        engine: "available",
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
        },
        queueDepth: 0,
      }),
    });
  });

  const draft = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);
  await page.getByText("Experiment vorregistrieren", { exact: true }).click();
  await page.getByLabel("Kontrollierte Variable").selectOption("lipforcing-enabled");
  await expect(page.getByText("Kandidat: LipForcing mit qualitativem Wan-VAE-Decoder")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Kandidatenwert", exact: true })).toHaveCount(0);
  await page.getByLabel("Kontrollierte Variable").selectOption("a2v-guidance");
  await page.getByLabel("Experimentname").fill("A2V Guidance 5 gegen 3");
  await expect(page.getByLabel("Kontrollierte Variable")).toHaveValue("a2v-guidance");
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
      command: "python -m ltx_pipelines.lipdub",
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
      },
      target: { width: 768, height: 1344, fps: 24, frames: 97, durationSeconds: 4.0416667 },
      trim: { startSeconds: 0, requestedDurationSeconds: 4.2 },
      command: "ffmpeg -i reference.mp4",
    }),
  }));

  const draft = Buffer.from(JSON.stringify(draftRequest), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Text-Redubbing");
  await expect(page.getByLabel("Zielsprache")).toHaveValue("Deutsch");
  await expect(page.getByLabel("Genau ein Sprecher bestätigt")).toBeChecked();
  await expect(page.getByText(/übernimmt keine separate Ziel-Audiodatei/)).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("LipDub IC-LoRA: nicht gefunden");
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
        },
        target: { width: 768, height: 1344, fps: 24, frames: 73, durationSeconds: 3.0416667 },
        trim: { startSeconds: 0, requestedDurationSeconds: 3.0416667 },
        command: "ffmpeg -i reference.mp4",
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
  await page.locator(".mode-button").filter({
    has: page.getByText("Distilled", { exact: true }),
  }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Distilled");
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
    fileId: "12345",
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
    fileId: "12345",
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    jobStatus: "completed",
    request,
    settingsAvailable: true,
    qualityReview: null,
    analysis: null as null | Record<string, unknown>,
  };
  await page.route(/\/api\/outputs(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outputs: [output] }),
  }));
  await page.route("**/api/outputs/*/analysis", async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ force: false });
    output.analysis = {
      schemaVersion: "ltx-studio-output-analysis.v7",
      evaluatorFingerprint: "test-evaluator.v1",
      conditioningAudioSha256: null,
      expectedDialogueSha256: "2c8e99ff8edb6deec76583cf59599a09c471a38681ecec354522c045593d2852",
      outputName: output.name,
      sizeBytes: output.sizeBytes,
      modifiedAtMs: Date.parse(modifiedAt),
      changedAtMs: Date.parse(output.changedAt),
      fileId: output.fileId,
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
      result: {
        schemaVersion: "ltx-studio-objective-quality.v7",
        analyzerVersion: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7",
        createdAt: "2026-07-24T18:05:02.000Z",
        status: "insufficient",
        technical: {
          durationSeconds: 4.041667,
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
          modelSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
          modelRevision: "3d7082438a6e4551e840c9b2bb60b71e8da4b524",
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
          modelSha256: "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794",
          packageVersion: "20250625",
          detectedLanguage: "de",
          expectedTranscriptSha256: "2c8e99ff8edb6deec76583cf59599a09c471a38681ecec354522c045593d2852",
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
          manifestReleaseId: "pv-measurement-e2e",
          manifestSha256: "a".repeat(64),
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
            runnerFingerprint: "b".repeat(64),
            expectedDialogueSha256: "c".repeat(64),
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
  await expect(page.locator(".objective-analysis__status")).toHaveText("Lip-Sync geprüft");
  await expect(page.locator(".objective-analysis__verdict")).toContainText(
    "Lip-Sync hat erkennbare Schwächen",
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
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("Prüfung aktiv");
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
        modelSha256: null,
        modelRevision: null,
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
  await expect(page.locator(".output-library__details")).toContainText("Video geprüft, Lip-Sync nicht eindeutig");
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
      schemaVersion: "ltx-studio-experiment-run.v1",
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolSha256: "3".repeat(64),
      arm: request.outputName === leftRequest.outputName ? "baseline" : "candidate",
      kind: "ablation",
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: "4".repeat(64),
      requestSha256: request.outputName === leftRequest.outputName ? "4".repeat(64) : "5".repeat(64),
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
  const analysis = (identityMedian: number, lagMs: number) => ({
    schemaVersion: "ltx-studio-output-analysis.v4",
    evaluatorFingerprint: "comparison-evaluator.v1",
    outputName: "",
    sizeBytes: 1_048_576,
    modifiedAtMs: Date.parse("2026-07-25T00:10:00.000Z"),
    changedAtMs: Date.parse("2026-07-25T00:10:01.000Z"),
    fileId: "fixture",
    jobId: null,
    analysisId: crypto.randomUUID(),
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: "2026-07-25T00:11:00.000Z",
    startedAt: "2026-07-25T00:11:01.000Z",
    finishedAt: "2026-07-25T00:11:02.000Z",
    updatedAt: "2026-07-25T00:11:02.000Z",
    error: null,
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
        modelSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
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
  const provenance = {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-07-25T00:00:00.000Z",
    verifiedAt: "2026-07-25T00:10:00.000Z",
    files: [
      {
        role: "input:conditioning-audio",
        path: "/inputs/clean-vocals.wav",
        kind: "file",
        sizeBytes: 1,
        modifiedAtMs: 1,
        changedAtMs: 1,
        fileId: "1",
        sha256: "a".repeat(64),
        entries: [],
      },
      {
        role: "input:final-audio-mix",
        path: "/inputs/final-mix.wav",
        kind: "file",
        sizeBytes: 1,
        modifiedAtMs: 1,
        changedAtMs: 1,
        fileId: "2",
        sha256: "b".repeat(64),
        entries: [],
      },
      {
        role: "input:reference-image:3",
        path: "/inputs/reference.png",
        kind: "file",
        sizeBytes: 1,
        modifiedAtMs: 1,
        changedAtMs: 1,
        fileId: "3",
        sha256: "c".repeat(64),
        entries: [],
      },
      {
        role: "model:checkpoint",
        path: "/models/ltx.safetensors",
        kind: "file",
        sizeBytes: 1,
        modifiedAtMs: 1,
        changedAtMs: 1,
        fileId: "4",
        sha256: "9".repeat(64),
        entries: [],
      },
    ],
    code: [{
      repositoryRoot: "/repo",
      commit: "d".repeat(40),
      dirty: false,
      trackedDiffSha256: "e".repeat(64),
      untracked: [],
      fingerprint: "f".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "3.12",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: "1".repeat(64),
    },
    fingerprint: "2".repeat(64),
  };
  const outputs = jobs.map((currentJob, index) => ({
    name: currentJob.outputName,
    url: currentJob.outputUrl,
    sizeBytes: 1_048_576,
    modifiedAt: "2026-07-25T00:10:00.000Z",
    changedAt: "2026-07-25T00:10:01.000Z",
    fileId: `fixture-${index}`,
    jobId: currentJob.id,
    jobStatus: "completed",
    request: currentJob.request,
    settingsAvailable: true,
    qualityReview: null,
    analysis: analysis(index === 0 ? 0.842 : 0.855, index === 0 ? -333 : -42),
    provenance,
    experiment: currentJob.experiment,
    experimentRequestVerified: true,
  }));

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
        scaleFilter: "lanczos",
        command: "ffmpeg fixture",
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
  baselineRequest.models.gemmaLora = { path: "/models/gemma-lora.safetensors", strength: 1 };
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
  expect(frozen.protocolSha256).toMatch(/^[0-9a-f]{64}$/);

  const duplicateFreeze = await request.post(`/api/experiments/${created.id}/freeze`);
  expect(duplicateFreeze.status()).toBe(409);

  const prematureCandidate = await request.post(`/api/experiments/${created.id}/runs/candidate`);
  expect(prematureCandidate.status()).toBe(409);
  expect(await prematureCandidate.json()).toMatchObject({
    error: "Der gebundene Baseline-Lauf muss vollständig abgeschlossen und mit verifizierter Laufprovenienz belegt sein.",
  });

  const listResponse = await request.get("/api/experiments");
  expect(listResponse.ok()).toBe(true);
  expect((await listResponse.json()).experiments).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: created.id, protocolSha256: frozen.protocolSha256 })]),
  );
});

test("API exposes bounded model inventory and request estimates", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect((await health.json()).evaluators.phonemeViseme).toMatchObject({
    status: "not-available",
    blockerCode: "manifest-missing",
    productGo: "blocked",
    measurementReady: false,
    method: null,
  });

  const models = await request.get("/api/models");
  expect(models.ok()).toBe(true);
  const inventory = await models.json();
  expect(inventory.errors).toEqual([]);
  expect(inventory.items.some((item: { kind: string }) => item.kind === "gemma")).toBe(true);
  expect(inventory.items.some((item: { kind: string }) => item.kind === "checkpoint")).toBe(true);

  const assets = await request.get("/api/assets?kind=image");
  expect(assets.ok()).toBe(true);
  expect(Array.isArray((await assets.json()).assets)).toBe(true);

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
