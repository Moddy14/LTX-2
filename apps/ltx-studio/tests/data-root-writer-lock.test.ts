import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appRoot } from "../server/config.js";

const serverEntry = join(appRoot, "server", "index.ts");
const tsxExecutable = join(appRoot, "node_modules", ".bin", "tsx");

type RunningStudio = {
  child: ChildProcess;
  output(): { stdout: string; stderr: string };
};

function studioEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.VITEST_WORKER_ID;
  delete environment.VITEST_POOL_ID;
  delete environment.LTX_STUDIO_SEALED_RELEASE;
  delete environment.LTX_STUDIO_T2A_DEVELOPMENT_MEASUREMENT;
  return {
    ...environment,
    VITEST: "false",
    LTX_STUDIO_DATA_DIR: root,
    LTX_STUDIO_PORT: "0",
    LTX_STUDIO_UI_PORT: "0",
    LTX_STUDIO_REQUIRE_ADMISSION: "0",
    LTX_STUDIO_ANALYSIS_PYTHON: `/definitely-not-installed/ltx-studio-lock-test-${process.pid}`,
  };
}

async function startStudio(root: string): Promise<RunningStudio> {
  const child = spawn(tsxExecutable, [serverEntry], {
    cwd: appRoot,
    env: studioEnvironment(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        rejectReady(new Error(`Studio startup timed out. stdout=${stdout}\nstderr=${stderr}`));
      }, 20_000);
      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.off("data", onStdout);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onStdout = () => {
        if (!stdout.includes("LTX Studio API:")) return;
        cleanup();
        resolveReady();
      };
      const onError = (error: Error) => {
        cleanup();
        rejectReady(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        rejectReady(new Error(
          `Studio exited before ready (code=${String(code)}, signal=${String(signal)}). `
            + `stdout=${stdout}\nstderr=${stderr}`,
        ));
      };
      child.stdout?.on("data", onStdout);
      child.once("error", onError);
      child.once("exit", onExit);
      onStdout();
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    child,
    output: () => ({ stdout, stderr }),
  };
}

async function stopStudio(studio: RunningStudio): Promise<void> {
  if (studio.child.exitCode !== null || studio.child.signalCode !== null) return;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        rejectExit(new Error(`Studio shutdown timed out: ${JSON.stringify(studio.output())}`));
      }, 20_000);
      studio.child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    },
  );
  studio.child.kill("SIGTERM");
  const result = await exit;
  expect(result, JSON.stringify(studio.output())).toEqual({ code: 0, signal: null });
}

describe("data-root single-writer lock", () => {
  it("is acquired before persistent stores and jobs are initialized", () => {
    const source = readFileSync(serverEntry, "utf8");
    const acquisition = source.indexOf("acquireDataRootWriterLock(dataRoot)");
    expect(acquisition).toBeGreaterThan(source.indexOf("ensureRuntimeDirectories();"));
    expect(acquisition).toBeLessThan(source.indexOf("const assets = new AssetStore();"));
    expect(acquisition).toBeLessThan(source.indexOf("const jobs = new JobManager("));
  });

  it("rejects the same root across processes, permits another root, and releases on shutdown", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "ltx-studio-writer-lock-"));
    const firstDataRoot = join(temporaryRoot, "first");
    const secondDataRoot = join(temporaryRoot, "second");
    const running = new Set<RunningStudio>();
    try {
      const first = await startStudio(firstDataRoot);
      running.add(first);

      const conflicting = spawnSync(tsxExecutable, [serverEntry], {
        cwd: appRoot,
        env: studioEnvironment(firstDataRoot),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      expect(conflicting.error).toBeUndefined();
      expect(conflicting.status).not.toBe(0);
      expect(conflicting.signal).toBeNull();
      expect(conflicting.stderr).toContain(
        `LTX Studio data root is already owned by another server process: ${firstDataRoot}`,
      );

      const independent = await startStudio(secondDataRoot);
      running.add(independent);
      await stopStudio(independent);
      running.delete(independent);

      await stopStudio(first);
      running.delete(first);

      const replacement = await startStudio(firstDataRoot);
      running.add(replacement);
      await stopStudio(replacement);
      running.delete(replacement);
    } finally {
      for (const studio of running) {
        try {
          await stopStudio(studio);
        } catch {
          studio.child.kill("SIGKILL");
        }
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
