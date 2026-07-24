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

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Lipsync");
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
  await expect(page.getByText("reference-lipdub-prep.mp4", { exact: true })).toBeVisible();
  await expect(page.getByText(/Vorbereitete Referenz: 768 x 1344, 97 Frames @ 24 fps/)).toBeVisible();
});

test("stale LipDub reference preparation does not overwrite a changed editor mode", async ({ page }) => {
  const draftRequest = createDefaultRequest("lipdub");
  draftRequest.promptParts.dialogue = "Das ist ein kurzer LipDub Race Test";
  draftRequest.prompt = 'A single speaker says exactly: "Das ist ein kurzer LipDub Race Test".';
  draftRequest.lipDub.referenceVideo = { path: "/inputs/reference.mp4", name: "reference.mp4", strength: 1 };

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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LipDub / Lipsync");
  await expect(page.getByLabel("Clip-Länge")).toHaveValue("3.0416667");
  await page.getByRole("button", { name: "Kalibrierclip erstellen" }).click();
  await expect.poll(() => typeof releasePreparation === "function").toBe(true);
  expect(capturedTrimDuration).toBeCloseTo(3.0416667, 6);
  await page.locator(".mode-button").filter({ hasText: "Distilled" }).click();
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

test("objective speech analysis exposes raw measurements and honest capability gaps", async ({ page }, testInfo) => {
  const request = createDefaultRequest("audio-to-video");
  request.outputName = "speech-objective-analysis.mp4";
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
      schemaVersion: "ltx-studio-output-analysis.v1",
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
        schemaVersion: "ltx-studio-objective-quality.v1",
        analyzerVersion: "ffprobe-yunet5.v1",
        createdAt: "2026-07-24T18:05:02.000Z",
        status: "measured",
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
        },
        capabilities: {
          avSync: "syncnet-required",
          identity: "face-recognition-model-required",
          dialogue: "whisper-not-run",
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
  await expect(page.locator(".objective-analysis__status")).toHaveText("Rohwerte erfasst");
  await expect(page.locator(".objective-analysis__metric").filter({ hasText: "Gesicht erkannt" }).locator("strong")).toHaveText("100 %");
  await expect(page.locator(".objective-analysis__metric").filter({ hasText: "AV-Dauerdifferenz" }).locator("strong")).toHaveText("1 ms");
  await expect(page.locator(".objective-analysis__metric .tooltip")).toHaveCount(8);
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
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("SyncNet fehlt");
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("Erkennungsmodell fehlt");
  await expect(page.locator(".objective-analysis__capabilities")).toContainText("Whisper nicht ausgeführt");
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
      schemaVersion: "ltx-studio-objective-quality.v1",
      analyzerVersion: "ffprobe-yunet5.v1",
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
      capabilities: {
        avSync: "syncnet-required",
        identity: "face-recognition-model-required",
        dialogue: "whisper-not-run",
      },
      findings: [{ code: "face-detection-incomplete", level: "error", message: "Kein Gesicht erkannt." }],
      limitations: ["YuNet konnte keine verwertbare Gesichtsgeometrie messen."],
    },
  };
  await page.reload();
  await expect(page.locator(".objective-analysis__status")).toHaveText("Messung unzureichend");
  await expect(page.locator(".output-library__details")).toContainText("Objektive Messung unzureichend");
  await expect(page.locator(".objective-analysis__metric").filter({ hasText: "AV-Dauerdifferenz" }).locator("strong")).toHaveText("Nicht messbar");
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
