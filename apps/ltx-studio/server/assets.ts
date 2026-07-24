import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

import { assetKinds, type AssetKind, type StudioAsset } from "../shared/assets.js";
import { assetsStatePath, uploadRoot } from "./config.js";

export type AssetFile = Pick<Express.Multer.File, "filename" | "path" | "originalname" | "size">;

export class AssetStore {
  private readonly assets = new Map<string, StudioAsset>();

  constructor(
    private readonly stateFile = assetsStatePath,
    private readonly root = uploadRoot,
  ) {
    this.restore();
  }

  list(kind?: AssetKind): StudioAsset[] {
    return [...this.assets.values()]
      .filter((asset) => !kind || asset.kind === kind)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  findByPath(kind: AssetKind, path: string): StudioAsset | null {
    const resolvedPath = resolve(path);
    return this.list(kind).find((asset) => resolve(asset.path) === resolvedPath) ?? null;
  }

  findById(kind: AssetKind, id: string): StudioAsset | null {
    const asset = this.assets.get(id);
    return asset?.kind === kind ? asset : null;
  }

  add(file: AssetFile, kind: AssetKind): StudioAsset {
    const id = file.filename.replace(/\.[^.]+$/, "");
    const asset: StudioAsset = {
      id,
      path: resolve(file.path),
      name: file.originalname,
      size: file.size,
      kind,
      url: `/api/uploads/${kind}/${file.filename}`,
      createdAt: new Date().toISOString(),
    };
    this.assets.set(id, asset);
    this.persist();
    return asset;
  }

  private persist(): void {
    const temporaryPath = `${this.stateFile}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.stateFile);
  }

  private restore(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const stored = JSON.parse(readFileSync(this.stateFile, "utf8")) as StudioAsset[];
      const safeRoot = `${resolve(this.root)}${sep}`;
      for (const asset of stored) {
        if (!assetKinds.includes(asset.kind)
          || typeof asset.id !== "string"
          || !/^[0-9a-f-]{36}$/i.test(asset.id)
          || typeof asset.path !== "string"
          || typeof asset.name !== "string"
          || typeof asset.size !== "number"
          || !Number.isFinite(asset.size)
          || asset.size < 0
          || typeof asset.createdAt !== "string") continue;
        const resolvedPath = resolve(asset.path);
        const filename = basename(resolvedPath);
        if (!resolvedPath.startsWith(safeRoot)
          || !filename.startsWith(`${asset.id}.`)
          || asset.url !== `/api/uploads/${asset.kind}/${filename}`
          || !existsSync(resolvedPath)
          || !statSync(resolvedPath).isFile()) continue;
        this.assets.set(asset.id, asset);
      }
    } catch {
      // Invalid metadata never blocks uploads or the studio itself.
    }
  }
}
