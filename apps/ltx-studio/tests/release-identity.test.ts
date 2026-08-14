import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import { loadReleaseIdentity } from "../server/releaseIdentity.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ltx-release-identity-"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "apps", "ltx-studio", "release"), { recursive: true });
  const artifact = Buffer.from("sealed\n");
  const surfaceArtifact = Buffer.from("{}\n");
  writeFileSync(join(root, "server", "index.js"), artifact, { mode: 0o644 });
  writeFileSync(
    join(root, "apps", "ltx-studio", "release", "candidate-release-surface.v1.json"),
    surfaceArtifact,
    { mode: 0o644 },
  );
  const surfaceDigest = createHash("sha256").update(surfaceArtifact).digest("hex");
  const manifest = {
    schemaVersion: "ltx-studio-release-manifest.v1",
    source: { gitCommit: "a".repeat(40), clean: true },
    surface: {
      path: "apps/ltx-studio/release/candidate-release-surface.v1.json",
      sha256: surfaceDigest,
    },
    artifacts: [
      {
        path: "apps/ltx-studio/release/candidate-release-surface.v1.json",
        type: "file",
        mode: "0644",
        sizeBytes: surfaceArtifact.byteLength,
        sha256: surfaceDigest,
      },
      {
        path: "server/index.js",
        type: "file",
        mode: "0644",
        sizeBytes: artifact.byteLength,
        sha256: createHash("sha256").update(artifact).digest("hex"),
      },
    ],
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  writeFileSync(join(root, "release-manifest.json"), manifestBytes);
  writeFileSync(join(root, "release-manifest.sha256"), `${digest}  release-manifest.json\n`);
  return { root, digest };
}

describe("sealed release identity", () => {
  it("keeps development explicitly unattested", () => {
    expect(loadReleaseIdentity({ root: "/unused", sealed: false })).toEqual({
      sealed: false,
      verified: false,
      releaseDigest: null,
      manifestSha256: null,
      surfaceDigest: null,
      sourceCommit: null,
    });
  });

  it("accepts only the expected digest and complete artifact set", () => {
    const { root, digest } = fixture();
    expect(loadReleaseIdentity({ root, sealed: true, expectedDigest: digest })).toMatchObject({
      sealed: true,
      verified: true,
      releaseDigest: digest,
      surfaceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceCommit: "a".repeat(40),
    });
    expect(() => loadReleaseIdentity({ root, sealed: true, expectedDigest: "b".repeat(64) }))
      .toThrow(/expected sealed identity/);
  });

  it("rejects artifact drift", () => {
    const { root, digest } = fixture();
    writeFileSync(join(root, "server", "index.js"), "changed\n");
    expect(() => loadReleaseIdentity({ root, sealed: true, expectedDigest: digest }))
      .toThrow(/artifact drift/);
  });
});
