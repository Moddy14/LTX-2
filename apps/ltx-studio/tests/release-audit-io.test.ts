import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The immutable operator CLI helper is plain ESM JavaScript.
// prettier-ignore
import { loadVerifiedReleaseRoot, openEvidenceRoot, readOwnerPrivateKey } from "../scripts/release-audit-io-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";
import { createHash } from "node:crypto";
// @ts-expect-error The immutable operator CLI helper is plain ESM JavaScript.
import { releaseArtifacts } from "../scripts/release-manifest-lib.mjs";

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

  it("keeps production location mandatory while the artifact inventory remains independently testable", () => {
    const manifest = {
      schemaVersion: "ltx-studio-release-manifest.v4",
      artifacts: [],
    };
    const bytes = canonicalJson(manifest);
    const expectedDigest = digest(bytes);
    const anchor = mkdtempSync(join(tmpdir(), "ltx-audit-release-"));
    const parent = join(anchor, "opt", "ltx-studio", "releases");
    const root = join(parent, expectedDigest);
    mkdirSync(root, { recursive: true, mode: 0o755 });
    for (const path of [join(anchor, "opt"), join(anchor, "opt", "ltx-studio"), parent]) {
      chmodSync(path, 0o755);
    }
    const manifestPath = join(root, "release-manifest.json");
    writeFileSync(manifestPath, bytes, { mode: 0o644 });

    expect(() => loadVerifiedReleaseRoot(root, expectedDigest, { staticOnly: true }))
      .toThrow(/exactly \/opt\/ltx-studio\/releases/i);
    expect(releaseArtifacts(root)).toEqual([]);
    writeFileSync(join(root, "rogue.txt"), "drift", { mode: 0o644 });
    expect(releaseArtifacts(root)).toMatchObject([{ path: "rogue.txt", type: "file" }]);
  });

  it("does not unlock the trusted-parent fixture override from production environment strings", () => {
    const moduleUrl = new URL("../scripts/release-audit-io-lib.mjs", import.meta.url).href;
    const releaseDigest = "a".repeat(64);
    const anchor = mkdtempSync(join(tmpdir(), "ltx-audit-forged-vitest-"));
    const releaseRoot = join(anchor, releaseDigest);
    mkdirSync(releaseRoot, { mode: 0o755 });
    const script = `
      import { loadVerifiedReleaseRoot } from ${JSON.stringify(moduleUrl)};
      globalThis.__vitest_worker__ = { ctx: { workerId: 1 }, filepath: "/forged/tests/fake.test.ts" };
      loadVerifiedReleaseRoot(${JSON.stringify(releaseRoot)}, ${JSON.stringify(releaseDigest)}, {
        staticOnly: true,
        testOnlyTrustedParent: {
          expectedParent: ${JSON.stringify(anchor)},
          trustAnchor: ${JSON.stringify(anchor)},
          expectedUid: ${process.getuid!()},
          expectedGid: ${process.getgid!()},
        },
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        VITEST: "true",
        VITEST_WORKER_ID: "1",
        VITEST_POOL_ID: "1",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exactly \/opt\/ltx-studio\/releases/i);
  });

});
