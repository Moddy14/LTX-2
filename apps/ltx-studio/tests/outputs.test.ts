import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { StudioJob } from "../server/jobs.js";
import { OutputLibrary } from "../server/outputs.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-outputs-"));
  roots.push(root);
  return root;
}

function completedJob(outputName: string, finishedAt: string): StudioJob {
  const request = validRequest();
  request.outputName = outputName;
  return {
    id: "2c8a5dc6-8864-49f7-a639-85caef918888",
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/2c8a5dc6-8864-49f7-a639-85caef918888/output`,
    createdAt: finishedAt,
    startedAt: finishedAt,
    finishedAt,
    progress: 100,
    error: null,
    logs: [],
    command: "python -m ltx_pipelines.ti2vid_two_stages",
    request,
    favorite: false,
    variantOf: null,
    runtimeMs: 1000,
    cancelledBy: null,
    dgxJobId: null,
    thermalProfile: null,
  };
}

describe("generated output library", () => {
  it("lists every MP4 and exposes settings only with matching provenance", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const studioName = "studio-output.mp4";
    const externalName = "external-output.mp4";
    await writeFile(join(root, studioName), "video");
    await writeFile(join(root, externalName), "external");
    await utimes(join(root, studioName), completedAt, completedAt);
    const library = new OutputLibrary(root);
    const job = completedJob(studioName, completedAt.toISOString());

    library.recordCompleted([job]);
    const outputs = library.list([job]);
    const studioOutput = outputs.find((output) => output.name === studioName)!;
    const externalOutput = outputs.find((output) => output.name === externalName)!;

    expect(studioOutput.settingsAvailable).toBe(true);
    expect(studioOutput.request).toEqual(job.request);
    expect(externalOutput.settingsAvailable).toBe(false);
    expect(externalOutput.request).toBeNull();

    await appendFile(join(root, studioName), "changed");
    const modified = library.list([job]).find((output) => output.name === studioName)!;
    expect(modified.settingsAvailable).toBe(false);
    expect(modified.request).toBeNull();
  });
});
