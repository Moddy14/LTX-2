import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../server/assets.js";
import {
  captureIdentityEvidence,
  resolveIdentityEvidenceReferences,
  verifyIdentityEvidence,
} from "../server/inputEvidence.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ltx-input-evidence-"));
  roots.push(root);
  const uploadRoot = join(root, "uploads");
  const imageRoot = join(uploadRoot, "image");
  const path = join(imageRoot, "6d6d624b-12c3-4a97-9e4e-152a69423b6c.png");
  await mkdir(imageRoot, { recursive: true });
  await writeFile(path, "stable-reference");
  const stats = await stat(path);
  const assets = new AssetStore(join(root, "assets.json"), uploadRoot);
  const asset = assets.add({
    filename: "6d6d624b-12c3-4a97-9e4e-152a69423b6c.png",
    path,
    originalname: "reference.png",
    size: stats.size,
  }, "image");
  return { assets, asset, path };
}

describe("identity input evidence", () => {
  it("binds a Studio reference and resolves it only after post-render verification", async () => {
    const { assets, asset, path } = await fixture();
    const request = validRequest("audio-to-video");
    request.images = [{ path, name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];

    const captured = await captureIdentityEvidence(request, assets);
    expect(captured).toMatchObject({
      status: "captured",
      source: "image-conditioning",
      references: [{ assetId: asset.id, kind: "image", sizeBytes: 16 }],
    });
    expect(captured.references[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveIdentityEvidenceReferences(captured, assets)).toEqual([]);

    const verified = await verifyIdentityEvidence(captured, assets);
    expect(verified.error).toBeNull();
    expect(verified.evidence.status).toBe("verified");
    expect(resolveIdentityEvidenceReferences(verified.evidence, assets)).toEqual([{
      path,
      sha256: captured.references[0].sha256,
    }]);
  });

  it("binds native image-to-video dialogue references for identity analysis", async () => {
    const { assets, asset, path } = await fixture();
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Hallo.";
    request.images = [{ path, name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];

    const captured = await captureIdentityEvidence(request, assets);

    expect(captured).toMatchObject({
      status: "captured",
      source: "image-conditioning",
      references: [{ assetId: asset.id, kind: "image" }],
    });
  });

  it("detects a changed reference and never exposes its path to the evaluator", async () => {
    const { assets, path } = await fixture();
    const request = validRequest("audio-to-video");
    request.images = [{ path, name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];
    const captured = await captureIdentityEvidence(request, assets);

    await writeFile(path, "changed-reference");
    const verified = await verifyIdentityEvidence(captured, assets);

    expect(verified.error).toContain("verändert");
    expect(resolveIdentityEvidenceReferences(captured, assets)).toEqual([]);
  });

  it("marks missing or unregistered visual references honestly", async () => {
    const request = validRequest("audio-to-video");
    expect((await captureIdentityEvidence(request, null)).status).toBe("not-applicable");

    request.images = [{
      path: "/outside/reference.png",
      name: "reference.png",
      frameIndex: 0,
      strength: 1,
      crf: 33,
    }];
    const result = await captureIdentityEvidence(request, null);
    expect(result.status).toBe("unavailable");
    expect(result.references).toEqual([]);
  });

  it("binds the first LongCat source even when its LTX conditioning strength is zero", async () => {
    const { assets, asset: longCatAsset, path: longCatPath } = await fixture();
    const secondPath = join(longCatPath, "..", "second.png");
    await writeFile(secondPath, "second-reference");
    const secondStats = await stat(secondPath);
    const ltxAsset = assets.add({
      filename: "second.png",
      path: secondPath,
      originalname: "second.png",
      size: secondStats.size,
    }, "image");
    const request = validRequest("audio-to-video");
    request.postprocess.longcatLipsync.enabled = true;
    request.images = [
      { path: longCatPath, name: "reference.png", frameIndex: 0, strength: 0, crf: 33 },
      { path: secondPath, name: "second.png", frameIndex: 8, strength: 1, crf: 33 },
    ];

    const captured = await captureIdentityEvidence(request, assets);

    expect(captured.status).toBe("captured");
    expect(captured.references.map((reference) => reference.assetId)).toEqual([
      longCatAsset.id,
      ltxAsset.id,
    ]);
  });
});
