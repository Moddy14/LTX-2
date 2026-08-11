import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The immutable operator CLI helper is plain ESM JavaScript.
// prettier-ignore
import { loadVerifiedReleaseRoot, openEvidenceRoot, readOwnerPrivateKey } from "../scripts/release-audit-io-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";
import { createHash } from "node:crypto";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("release audit file boundaries", () => {
  it("reads canonical evidence and writes immutable outputs only inside a protected root", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-audit-evidence-"));
    chmodSync(root, 0o700);
    const input = join(root, "input.json");
    writeFileSync(input, canonicalJson({ value: 1 }), { mode: 0o600 });
    const io = openEvidenceRoot(root);

    expect(io.readJson("input.json").document).toEqual({ value: 1 });
    const output = io.writeCanonicalOnce(join(root, "output.json"), {
      ready: true,
    });
    expect(io.readJson(output).document).toEqual({ ready: true });
    expect(() => io.writeCanonicalOnce(output, { ready: true })).toThrow();
    expect(() => io.outputPath(join(root, "nested", "escape.json"))).toThrow(
      /direct child/i,
    );
  });

  it("rejects writable evidence, symlinks, and non-owner private keys", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-audit-permissions-"));
    chmodSync(root, 0o700);
    const unsafe = join(root, "unsafe.json");
    writeFileSync(unsafe, canonicalJson({ value: 1 }), { mode: 0o666 });
    const link = join(root, "link.json");
    symlinkSync(unsafe, link);
    const io = openEvidenceRoot(root);

    expect(() => io.readJson("unsafe.json")).toThrow(/unsafe/i);
    expect(() => io.readJson("link.json")).toThrow(/unsafe/i);
    expect(() => readOwnerPrivateKey(unsafe)).toThrow(/unsafe/i);
    chmodSync(unsafe, 0o600);
    expect(readOwnerPrivateKey(unsafe)).toBe(canonicalJson({ value: 1 }));
  });

  it("verifies the canonical manifest and complete artifact tree before loading audit code", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-audit-release-"));
    const manifest = {
      schemaVersion: "ltx-studio-release-manifest.v1",
      artifacts: [],
    };
    const bytes = canonicalJson(manifest);
    const manifestPath = join(root, "release-manifest.json");
    writeFileSync(manifestPath, bytes, { mode: 0o644 });

    expect(loadVerifiedReleaseRoot(root, digest(bytes)).releaseDigest).toBe(
      digest(bytes),
    );
    writeFileSync(join(root, "rogue.txt"), "drift", { mode: 0o644 });
    expect(() => loadVerifiedReleaseRoot(root, digest(bytes))).toThrow(
      /artifact drift/i,
    );
  });
});
