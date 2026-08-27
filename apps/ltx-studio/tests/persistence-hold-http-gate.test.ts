import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
  PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
} from "../shared/healthPublic.js";

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

function concreteRoute(template: string): string {
  const values: Record<string, string> = {
    arm: "baseline",
    filename: "hold-output.mp4",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "image",
    shotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  return template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => values[name] ?? "hold");
}

it("blocks every declared HTTP mutation before any durable store can change during HOLD", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-persistence-hold-http-"));
  cleanupRoots.push(root);
  // A non-array snapshot is deliberately untrusted. The server must stay
  // observable in HOLD, but it may not accept any write in that process.
  await writeFile(join(root, "jobs.json"), "{}\n");

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
  child.stdout?.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8_192);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8_192);
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Testserver endete vorzeitig.\n${diagnostics}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.status === 503) break;
      } catch {
        // Startup is still restoring the deliberately invalid snapshot.
      }
      if (Date.now() >= deadline) throw new Error(`Testserver startete nicht im HOLD.\n${diagnostics}`);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    expect(healthResponse.status).toBe(503);
    expect(await healthResponse.json()).toMatchObject({
      state: "blocked",
      jobPersistence: {
        status: "hold",
        code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
        restartRequired: true,
      },
    });
    expect((await fetch(`${baseUrl}/api/config`)).status).toBe(200);

    const source = await readFile(join(process.cwd(), "server", "index.ts"), "utf8");
    const routes = [...source.matchAll(/^app\.(post|put|patch|delete)\("([^"]+)"/gmu)]
      .map((match) => ({ method: match[1].toUpperCase(), template: match[2] }));
    expect(routes.length).toBeGreaterThan(30);
    expect(new Set(routes.map(({ method, template }) => `${method} ${template}`)).size).toBe(routes.length);

    const digestBefore = await dataDigest(root);
    for (const route of routes) {
      const response = await fetch(`${baseUrl}${concreteRoute(route.template)}`, {
        method: route.method,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, `${route.method} ${route.template}`).toBe(503);
      expect(await response.json(), `${route.method} ${route.template}`).toEqual({
        error: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
        code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
        restartRequired: true,
      });
    }
    expect(await dataDigest(root)).toBe(digestBefore);
  } finally {
    await stopChild(child);
  }
}, 60_000);
