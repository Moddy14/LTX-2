import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  capturePinnedPathRevision,
  openPinnedPaths,
} from "../server/evaluatorBindings.js";
import { evaluatorRuntimeDirectory, evaluatorSandboxProperties } from "../server/evaluatorSandbox.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("binds the already verified inode even when its parent path is replaced", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ltx-evaluator-fd-bind-"));
  roots.push(parent);
  const liveRoot = join(parent, "live");
  const originalRoot = join(parent, "original");
  const destination = join(liveRoot, "runner.py");
  await mkdir(liveRoot);
  await writeFile(destination, "original-inode\n");
  await chmod(destination, 0o444);
  const revision = capturePinnedPathRevision(destination, "file");
  const pinned = openPinnedPaths([revision]);

  try {
    await rename(liveRoot, originalRoot);
    await mkdir(liveRoot);
    await writeFile(destination, "replacement-inode\n");
    await chmod(destination, 0o444);
    const unit = `ltx-evaluator-fd-test-${process.pid}`;
    const result = spawnSync("/usr/bin/sudo", [
      "-n",
      "/usr/bin/systemd-run",
      "--system",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      "--property=DynamicUser=yes",
      pinned.bindReadOnlyProperty(revision.path),
      "/usr/bin/cat",
      destination,
    ], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("original-inode\n");
    expect(() => pinned.verifyUnchanged()).not.toThrow();
  } finally {
    pinned.close();
  }
});

it("maps a held snapshot FD into its DynamicUser RuntimeDirectory destination", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ltx-evaluator-runtime-bind-"));
  roots.push(parent);
  const source = join(parent, "authority-snapshot.mp4");
  await writeFile(source, "verified snapshot bytes\n");
  await chmod(source, 0o444);
  const revision = capturePinnedPathRevision(source, "file");
  const pinned = openPinnedPaths([revision]);
  const unit = `ltx-pv-bind-test-${process.pid}`;
  const destination = join(evaluatorRuntimeDirectory(unit), "authority-video");

  try {
    const property = pinned.bindReadOnlyProperty(source, destination);
    expect(property).toMatch(new RegExp(
      `^--property=BindReadOnlyPaths=/proc/${process.pid}/fd/[0-9]+:${destination}$`,
    ));
    const result = spawnSync("/usr/bin/sudo", [
      "-n",
      "/usr/bin/systemd-run",
      "--system",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      ...evaluatorSandboxProperties(unit),
      property,
      "/usr/bin/cat",
      destination,
    ], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("verified snapshot bytes\n");
    expect(() => pinned.verifyUnchanged()).not.toThrow();
  } finally {
    pinned.close();
  }
});
