import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCanonicalInstalledMetadata,
  createInstallStaging,
  discardInstallStaging,
  publishStagedRelease,
  recoverOrphanedInstallStaging,
} from "../scripts/runtime-install-publish-lib.mjs";

const roots: string[] = [];
const digest = "a".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ltx-install-publish-"));
  roots.push(root);
  const parent = join(root, "releases");
  await mkdir(parent, { mode: 0o755 });
  return { root, parent, destination: join(parent, digest) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic runtime install publish", () => {
  it("does not expose the final digest name before verified rename", async () => {
    const value = await fixture();
    const staging = createInstallStaging(value.parent, digest);
    await writeFile(join(staging, "complete.txt"), "complete\n", { mode: 0o644 });
    applyCanonicalInstalledMetadata(staging, {
      expectedUid: process.getuid!(),
      expectedGid: process.getgid!(),
    });

    expect(() => publishStagedRelease({
      staging,
      destination: value.destination,
      parent: value.parent,
      digest,
      verify: () => undefined,
      failpoint: (name) => {
        if (name === "after-verify-before-rename") throw new Error("synthetic crash before publish");
      },
    })).toThrow(/synthetic crash/);
    expect(existsSync(value.destination)).toBe(false);
    expect(existsSync(staging)).toBe(true);
    expect(discardInstallStaging(staging, value.parent, digest)).toBe(true);
  });

  it("publishes only a complete sibling and leaves it intact after the durable boundary", async () => {
    const value = await fixture();
    const staging = createInstallStaging(value.parent, digest);
    await writeFile(join(staging, "complete.txt"), "complete\n");
    let verified = false;
    expect(() => publishStagedRelease({
      staging,
      destination: value.destination,
      parent: value.parent,
      digest,
      verify: () => { verified = true; },
      failpoint: (name) => {
        if (name === "after-rename-and-parent-fsync") throw new Error("synthetic post-publish interruption");
      },
    })).toThrow(/post-publish/);
    expect(verified).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(join(value.destination, "complete.txt"))).toBe(true);
  });

  it("recovers only exact owned orphan staging siblings", async () => {
    const value = await fixture();
    const first = createInstallStaging(value.parent, digest);
    const second = createInstallStaging(value.parent, digest);
    await writeFile(join(first, "partial"), "one");
    await writeFile(join(second, "partial"), "two");
    await mkdir(join(value.parent, "unrelated"));

    expect(recoverOrphanedInstallStaging(value.parent, digest, {
      expectedUid: process.getuid!(),
      expectedGid: process.getgid!(),
    })).toEqual([first, second].sort());
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(join(value.parent, "unrelated"))).toBe(true);
  });
});
