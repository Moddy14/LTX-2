import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureElfDependencyClosure,
  captureLoaderResolutionPolicy,
  parseElfDynamic,
} from "../scripts/elf-dependency-lib.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ELF Host-TCB closure", () => {
  it("captures the pinned loader/cache/preload policy and a complete entry closure", () => {
    const loaderPolicy = captureLoaderResolutionPolicy();
    const closure = captureElfDependencyClosure("/usr/bin/env", { loaderPolicy }) as {
      schemaVersion: string;
      interpreter: string;
      loaderPolicy: { preload: { entries: string[] } };
      objects: Array<{ path: string; sha256: string; needed: string[] }>;
    };

    expect(closure.schemaVersion).toBe("ltx-studio-elf-dependency-closure.v2");
    expect(closure.interpreter).toMatch(/^\//);
    expect(closure.loaderPolicy.preload.entries).toEqual(
      [...closure.loaderPolicy.preload.entries].sort(),
    );
    expect(closure.objects.length).toBeGreaterThanOrEqual(2);
    expect(closure.objects.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256))).toBe(true);
  });

  it("rejects ELF64 offsets outside JavaScript's safe integer range", () => {
    const source = readFileSync("/usr/bin/env");
    if (source[4] !== 2) return;
    const root = mkdtempSync(join(tmpdir(), "ltx-elf-unsafe-offset-"));
    roots.push(root);
    const path = join(root, "unsafe-elf");
    const bytes = Buffer.from(source);
    bytes.writeBigUInt64LE(2n ** 63n, 32);
    writeFileSync(path, bytes, { mode: 0o555 });

    expect(() => parseElfDynamic(path)).toThrow(/safe integer range/i);
  });
});
