import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../server/assets.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("asset library", () => {
  it("persists uploaded assets and restores only paths below the upload root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-assets-"));
    roots.push(root);
    const uploads = join(root, "uploads");
    const imageDir = join(uploads, "image");
    const stateFile = join(root, "assets.json");
    await mkdir(imageDir, { recursive: true });
    const filename = "2c8a5dc6-8864-49f7-a639-85caef912345.png";
    const path = join(imageDir, filename);
    await writeFile(path, "image");

    const store = new AssetStore(stateFile, uploads);
    store.add({
      filename,
      path,
      originalname: "reference.png",
      size: 5,
    } as Express.Multer.File, "image");
    expect(store.list("image")).toHaveLength(1);
    expect(store.findByPath("image", path)).toMatchObject({ name: "reference.png", kind: "image" });
    expect(store.findByPath("video", path)).toBeNull();
    expect(new AssetStore(stateFile, uploads).list()).toMatchObject([
      { name: "reference.png", kind: "image", path },
    ]);

    await writeFile(stateFile, JSON.stringify([{ ...store.list()[0], id: "outside", path: "/etc/passwd" }]));
    expect(new AssetStore(stateFile, uploads).list()).toEqual([]);
  });
});
