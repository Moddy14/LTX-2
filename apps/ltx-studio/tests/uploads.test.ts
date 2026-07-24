import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { matchesUploadSignature } from "../server/uploads.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name: string, bytes: number[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-upload-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, Buffer.from(bytes));
  return path;
}

describe("upload media signatures", () => {
  it("accepts matching PNG and MP4 headers", async () => {
    const png = await fixture("image.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mp4 = await fixture("video.mp4", [0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]);
    expect(matchesUploadSignature(png)).toBe(true);
    expect(matchesUploadSignature(mp4)).toBe(true);
  });

  it("rejects extension-only disguises", async () => {
    const fake = await fixture("not-an-image.png", [0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e]);
    expect(matchesUploadSignature(fake)).toBe(false);
  });
});
