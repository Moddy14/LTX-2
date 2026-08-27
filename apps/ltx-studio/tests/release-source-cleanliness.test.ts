import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCleanReleaseSource } from "../scripts/release-source-cleanliness-lib.mjs";

const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release source cleanliness", () => {
  it("rejects an untracked productive TypeScript import", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-release-source-"));
    roots.push(root);
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Release Test"]);
    git(root, ["config", "user.email", "release-test@example.invalid"]);
    const serverRoot = join(root, "apps", "ltx-studio", "server");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored-runtime.ts\n");
    await writeFile(join(serverRoot, "index.ts"), 'import "./untracked.js";\nimport "./ignored-runtime.js";\n');
    git(root, ["add", ".gitignore", "apps/ltx-studio/server/index.ts"]);
    git(root, ["commit", "--quiet", "-m", "fixture"]);
    assertCleanReleaseSource(root);

    await writeFile(join(serverRoot, "untracked.ts"), "export const injected = true;\n");
    expect(() => assertCleanReleaseSource(root)).toThrow(/including all untracked files/);
    await unlink(join(serverRoot, "untracked.ts"));
    assertCleanReleaseSource(root);

    await writeFile(join(serverRoot, "ignored-runtime.ts"), "export const ignoredInjection = true;\n");
    expect(() => assertCleanReleaseSource(root)).toThrow(/including all untracked files/);
  });
});
