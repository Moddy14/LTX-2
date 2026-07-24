import { expect, test } from "@playwright/test";
import { createDefaultRequest } from "../../shared/pipelines.js";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Text / Bild zu Video");
});

test("desktop exposes every production mode and contextual controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop-only density assertions");
  const modes = page.locator(".mode-button");
  await expect(modes).toHaveCount(9);
  await expect(page.locator(".run-button")).toBeVisible();
  await expect(page.getByText("Steuern", { exact: true })).toBeVisible();
  await expect(page.getByText("Bearbeiten", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /HQ Maximale Qualität/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("HQ Zwei-Stufen");
  await expect(page.getByLabel("LoRA Stufe 1")).toBeVisible();

  await page.getByRole("button", { name: /Audio Audio-synchron/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audio zu Video");
  await expect(page.getByRole("button", { name: "Audio hochladen" })).toBeVisible();
  const guidanceSection = page.locator(".editor-section").filter({ has: page.getByRole("heading", { name: "Guidance" }) });
  await expect(guidanceSection.locator(".advanced-block")).toHaveCount(1);

  await page.getByRole("button", { name: /LipDub Lipsync/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Lipsync");
  await expect(page.getByRole("heading", { name: "LipDub Referenz" })).toBeVisible();
  await expect(page.getByLabel("LipDub IC-LoRA Pfad")).toBeVisible();

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

test("prompt validation stays in context", async ({ page }) => {
  const prompt = page.getByLabel("Positive Beschreibung");
  await prompt.fill("A deliberate camera move through a detailed workshop.");
  await page.getByLabel("Checkpoint Pfad").fill("");
  await page.getByLabel("Gemma Root Pfad").fill("");
  await expect(page.getByText("53 / 16.000", { exact: true })).toBeVisible();
  await page.locator(".run-button").click();
  await expect(page.getByRole("alert")).toContainText("Checkpoint fehlt.");
  await expect(page.getByRole("alert")).toContainText("Gemma Root fehlt.");
});

test("structured prompt, continuity, dialogue warning and presets are usable", async ({ page }) => {
  await page.getByText("Prompt-Bausteine", { exact: true }).click();
  await page.getByRole("textbox", { name: "Motiv", exact: true }).fill("Eine Restauratorin in einer Werkstatt");
  await page.getByRole("textbox", { name: "Dialog", exact: true }).fill('Sie sagt: "Das Original bleibt erhalten."');
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

test("LipDub live preflight surfaces plan findings before starting a job", async ({ page }) => {
  const draftRequest = createDefaultRequest("lipdub");
  draftRequest.promptParts.dialogue = "Das ist ein kurzer LipDub Preflight Test";
  draftRequest.prompt = 'A single speaker says exactly: "Das ist ein kurzer LipDub Preflight Test".';
  draftRequest.outputName = "lipdub-preflight-test.mp4";
  draftRequest.models.distilledCheckpointPath = "/models/ltx-2.3-22b-distilled-1.1.safetensors";
  draftRequest.models.gemmaRoot = "/models/gemma";
  draftRequest.models.spatialUpscalerPath = "/models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors";
  draftRequest.lipDub.referenceVideo = { path: "/inputs/reference.mp4", name: "reference.mp4", strength: 1 };
  draftRequest.lipDub.lora = { path: "/models/lipdub.safetensors", strength: 1 };

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

  const draft = Buffer.from(JSON.stringify(draftRequest), "utf8").toString("base64url");
  await page.goto(`/?draft=${draft}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Lipsync");
  await expect(page.getByRole("alert")).toContainText("LipDub IC-LoRA: nicht gefunden");
  await expect(page.locator(".run-warnings")).toContainText("snappt 122 Referenzframes");
  await expect(page.locator(".run-suggestions")).toContainText("empfohlenes 64er-LipDub-Format 768 x 1344");
  await page.getByRole("button", { name: "Format 768 x 1344 übernehmen" }).click();
  await expect(page.getByLabel("Breite", { exact: true })).toHaveValue("768");
  await expect(page.getByLabel("Höhe", { exact: true })).toHaveValue("1344");
});

test("explicit image-to-video mode requires and exposes a reference image", async ({ page }) => {
  await page.getByRole("button", { name: "Bild zu Video · empfohlen" }).click();
  await expect(page.getByRole("heading", { name: "Referenzbild" })).toBeVisible();
  await page.getByLabel("Positive Beschreibung").fill("A product label remains sharp while the camera moves.");
  await page.locator(".run-button").click();
  await expect(page.getByRole("alert")).toContainText("Für Bild-zu-Video ist ein Referenzbild erforderlich.");
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

test("generated video picker restores every stored setting", async ({ page }) => {
  const stored = createDefaultRequest("distilled");
  stored.outputName = "picker-source.mp4";
  stored.seed = 987654;
  stored.width = 320;
  stored.height = 576;
  stored.numFrames = 25;
  stored.numInferenceSteps = 8;
  stored.quantization.mode = "fp8-cast";
  await page.route("**/api/outputs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      outputs: [{
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
  await page.reload();

  await expect(page.getByLabel("Erzeugtes Video")).toHaveValue("picker-source.mp4");
  await expect(page.locator(".output-settings-summary")).toContainText("Seed");
  await expect(page.locator(".output-settings-summary")).toContainText("987654");
  await page.getByRole("button", { name: "Alle Einstellungen übernehmen" }).click();
  await expect(page.getByLabel("Ausgabedatei")).toHaveValue("picker-source-edit01.mp4");
  await expect(page.getByRole("spinbutton", { name: "Frames", exact: true })).toHaveValue("25");
  await expect(page.getByLabel("Breite", { exact: true })).toHaveValue("320");
  await expect(page.getByLabel("Höhe", { exact: true })).toHaveValue("576");
  await expect(page.getByRole("button", { name: "FP8 Cast" })).toHaveAttribute("aria-pressed", "true");
});

test("mobile keeps all modes reachable without page overflow", async ({ page }, testInfo) => {
  const modes = page.locator(".mode-button");
  await expect(modes).toHaveCount(9);
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
});

test("API exposes bounded model inventory and request estimates", async ({ request }) => {
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
