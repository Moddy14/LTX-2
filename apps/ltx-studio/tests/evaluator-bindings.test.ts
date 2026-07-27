import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  capturePinnedPathRevision,
  openPinnedPaths,
} from "../server/evaluatorBindings.js";

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
