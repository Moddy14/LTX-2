import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, expect, it } from "vitest";

import { validRequest } from "./fixtures.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function availablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Testport konnte nicht reserviert werden.");
  await new Promise<void>((resolvePromise, reject) => reservation.close((error) => {
    if (error) reject(error);
    else resolvePromise();
  }));
  return address.port;
}

async function dataDigest(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== ".ltx-studio-writer.lock") files.push(path);
    }
  };
  await visit(root);
  const digest = createHash("sha256");
  for (const path of files.sort()) {
    digest.update(relative(root, path));
    digest.update("\0");
    digest.update(await readFile(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

it("rejects every legacy HTTP mutation before changing any persisted byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-legacy-api-lock-"));
  cleanupRoots.push(root);
  const outputRoot = join(root, "outputs");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const request = validRequest("image-audio-to-video");
  request.outputName = `legacy-api-${id}.mp4`;
  const outputPath = join(outputRoot, request.outputName);
  const settingsPath = `${outputPath}.ltx-settings.json`;
  const outputBytes = Buffer.from(`legacy API playback ${id}\n`);
  await writeFile(outputPath, outputBytes);
  const outputStats = await stat(outputPath);
  const finishedAt = "2026-08-10T14:18:44.065Z";
  await writeFile(settingsPath, `${JSON.stringify({
    schemaVersion: "ltx-studio-output.v6",
    outputName: request.outputName,
    jobId: id,
    completedAt: finishedAt,
    sizeBytes: outputStats.size,
    modifiedAtMs: outputStats.mtimeMs,
    changedAtMs: outputStats.ctimeMs,
    fileId: String(outputStats.ino),
    request,
    qualityReview: null,
    identityEvidence: null,
    runProvenance: null,
    experiment: null,
  }, null, 2)}\n`);
  await writeFile(join(root, "jobs.json"), `${JSON.stringify([{
    id,
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName: request.outputName,
    outputUrl: `/api/jobs/${id}/output`,
    createdAt: "2026-08-10T13:55:04.027Z",
    startedAt: "2026-08-10T14:09:35.260Z",
    finishedAt,
    progress: 100,
    error: null,
    logs: ["Historischer Lauf"],
    command: "historical command",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 548_805,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: `dgx-job-20260827-120000-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`,
    identityEvidence: null,
    runProvenance: null,
  }], null, 2)}\n`);

  const port = await availablePort();
  const environment = { ...process.env };
  delete environment.VITEST;
  delete environment.VITEST_WORKER_ID;
  delete environment.VITEST_POOL_ID;
  delete environment.LTX_STUDIO_SEALED_RELEASE;
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...environment,
        LTX_STUDIO_DATA_DIR: root,
        LTX_STUDIO_PORT: String(port),
        LTX_STUDIO_UI_PORT: String(port + 1),
        LTX_STUDIO_REQUIRE_ADMISSION: "0",
        LTX_STUDIO_MODEL_ROOTS: join(process.cwd(), "tests", "fixtures", "model-inventory"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  child.stdout?.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8_192); });
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8_192); });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Testserver endete vorzeitig.\n${diagnostics}`);
      try {
        const response = await fetch(`${baseUrl}/api/jobs`);
        if (response.ok) break;
      } catch {
        // The child is still importing the legacy fixture.
      }
      if (Date.now() >= deadline) throw new Error(`Testserver startete nicht.\n${diagnostics}`);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }

    const jobsResponse = await fetch(`${baseUrl}/api/jobs`).then((response) => response.json()) as {
      jobs: Array<{ id: string; historyStatus?: string; outputUrl: string | null }>;
    };
    expect(jobsResponse.jobs).toContainEqual(expect.objectContaining({
      id,
      historyStatus: "legacy-unattested",
      outputUrl: `/api/jobs/${id}/output`,
    }));
    const digestBefore = await dataDigest(root);
    const mutationRequests: Array<{
      label: string;
      path: string;
      method: string;
      body?: unknown;
    }> = [
      { label: "favorite", path: `/api/jobs/${id}`, method: "PATCH", body: { favorite: true } },
      { label: "cancel", path: `/api/jobs/${id}/cancel`, method: "POST", body: {} },
      { label: "rerun", path: `/api/jobs/${id}/rerun`, method: "POST", body: { mode: "exact" } },
      { label: "job delete", path: `/api/jobs/${id}`, method: "DELETE" },
      { label: "output delete", path: `/api/outputs/${request.outputName}`, method: "DELETE" },
      {
        label: "quality",
        path: `/api/outputs/${request.outputName}/quality-review`,
        method: "PUT",
        body: {
          scores: { lipSync: 10, identity: 10, mouthNaturalness: 10, skinStability: 10, motion: 10, audio: 10 },
          note: "must reject",
        },
      },
      { label: "analysis", path: `/api/outputs/${request.outputName}/analysis`, method: "POST", body: { force: true } },
      {
        label: "analysis cancel",
        path: `/api/outputs/${request.outputName}/analysis/cancel`,
        method: "POST",
        body: { analysisId: "99999999-9999-4999-8999-999999999999" },
      },
      {
        label: "derived frame",
        path: "/api/images/from-output",
        method: "POST",
        body: { output: request.outputName, atSeconds: 0 },
      },
      {
        label: "derived sequence",
        path: "/api/sequences/assemble",
        method: "POST",
        body: { outputs: [request.outputName, request.outputName], name: "must-reject" },
      },
      {
        label: "project capture",
        path: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/shots/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/outputs",
        method: "POST",
        body: {
          expectedRevision: 1,
          requestRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          outputName: request.outputName,
        },
      },
    ];
    for (const mutation of mutationRequests) {
      const response = await fetch(`${baseUrl}${mutation.path}`, {
        method: mutation.method,
        headers: mutation.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: mutation.body === undefined ? undefined : JSON.stringify(mutation.body),
      });
      expect(response.status, mutation.label).toBe(409);
      expect(await response.json(), mutation.label).toMatchObject({ error: expect.stringContaining("Historischer Altbestand") });
    }
    expect(await dataDigest(root)).toBe(digestBefore);

    const playback = await fetch(`${baseUrl}/api/outputs/${request.outputName}`, {
      headers: { Range: "bytes=0-0" },
    });
    expect(playback.status).toBe(206);
    expect(Buffer.from(await playback.arrayBuffer())).toEqual(outputBytes.subarray(0, 1));
    expect(await dataDigest(root)).toBe(digestBefore);
  } finally {
    await stopChild(child);
  }
}, 60_000);
