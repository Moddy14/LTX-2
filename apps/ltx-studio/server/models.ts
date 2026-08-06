import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import {
  recommendedModelAssets,
  type ModelInventory,
  type ModelInventoryItem,
  type ModelKind,
  type RecommendedModelAsset,
} from "../shared/models.js";
import { modelRoots } from "./config.js";
import { captureProvenanceFile } from "./runProvenance.js";

const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 5;
const IGNORED_DIRECTORIES = new Set([".cache", ".git", "gguf", "node_modules", "outputs", "uploads"]);
let cached: { expiresAt: number; value: ModelInventory } | null = null;
let inFlight: Promise<ModelInventory> | null = null;
const verificationInFlight = new Map<string, Promise<ModelInventory>>();

export function classifyModelFile(path: string): ModelKind | null {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if ((extension === ".json" || extension === ".pt") && name.includes("amax")) return "amax";
  if (extension === ".safetensors" && name.startsWith("moge_")) return "geometry";
  if (extension === ".safetensors" && name.includes("gemma") && name.includes("lora")) return "lora";
  if (extension !== ".safetensors" || !name.includes("ltx")) return null;
  if (name.includes("spatial-upscaler")) return "spatial-upscaler";
  if (name.includes("lora")) return "lora";
  if (name.includes("distilled")) return "distilled-checkpoint";
  if (name.includes("dev") || name.includes("checkpoint")) return "checkpoint";
  return null;
}

function precisionFor(path: string): ModelInventoryItem["precision"] {
  const value = path.toLowerCase();
  if (value.includes("fp8")) return "fp8";
  if (value.includes("bf16") || value.endsWith(".safetensors")) return "bf16";
  return "unknown";
}

async function inventoryItem(kind: ModelKind, path: string): Promise<ModelInventoryItem> {
  const details = await stat(path);
  return {
    kind,
    path: resolve(path),
    name: basename(path),
    sizeBytes: details.size,
    modifiedAt: details.mtime.toISOString(),
    precision: kind === "gemma" ? "unknown" : precisionFor(path),
  };
}

async function modelRecommendations(
  items: readonly ModelInventoryItem[],
  verifyAssetIds: readonly RecommendedModelAsset["id"][],
): Promise<ModelInventory["recommendations"]> {
  const verifyIds = new Set(verifyAssetIds);
  const hashes = new Map<string, Promise<string>>();
  const sha256 = (path: string, role: string): Promise<string> => {
    const resolvedPath = resolve(path);
    let pending = hashes.get(resolvedPath);
    if (!pending) {
      pending = captureProvenanceFile(resolvedPath, role).then((evidence) => evidence.sha256);
      hashes.set(resolvedPath, pending);
    }
    return pending;
  };
  return Promise.all(recommendedModelAssets.map(async (rawAsset) => {
    const asset: RecommendedModelAsset = rawAsset;
    const match = items.find((item) => item.kind === asset.kind && item.path === resolve(asset.localPath))
      ?? items.find((item) =>
        item.kind === asset.kind
        && (item.name === asset.filename || item.path === asset.localPath),
      );
    if (!match) {
      return {
        ...asset,
        actualSha256: null,
        integrity: "missing" as const,
        present: false,
      };
    }
    if (asset.expectedContents && match.path === resolve(asset.localPath)) {
      for (const expected of asset.expectedContents) {
        const path = join(match.path, expected.relativePath);
        let sizeBytes: number;
        try {
          const details = await stat(path);
          if (!details.isFile()) throw new Error("not a file");
          sizeBytes = details.size;
        } catch {
          return {
            ...asset,
            localPath: match.path,
            actualSha256: null,
            integrity: "missing" as const,
            present: false,
          };
        }
        if (sizeBytes !== expected.expectedSizeBytes) {
          return {
            ...asset,
            localPath: match.path,
            actualSha256: null,
            integrity: "size-mismatch" as const,
            present: false,
          };
        }
        if (!verifyIds.has(asset.id)) continue;
        const actualSha256 = await sha256(
          path,
          `model-inventory:${asset.id}:${expected.relativePath}`,
        );
        if (actualSha256 !== expected.expectedSha256) {
          return {
            ...asset,
            localPath: match.path,
            actualSha256,
            integrity: "sha256-mismatch" as const,
            present: false,
          };
        }
      }
      return {
        ...asset,
        localPath: match.path,
        actualSha256: null,
        integrity: verifyIds.has(asset.id) ? "verified" as const : "unverified" as const,
        present: true,
      };
    }
    if (asset.expectedSizeBytes !== undefined && match.sizeBytes !== asset.expectedSizeBytes) {
      return {
        ...asset,
        localPath: match.path,
        actualSha256: null,
        integrity: "size-mismatch" as const,
        present: false,
      };
    }
    if (asset.expectedSha256) {
      if (!verifyIds.has(asset.id)) {
        return {
          ...asset,
          localPath: match.path,
          actualSha256: null,
          integrity: "unverified" as const,
          present: true,
        };
      }
      const actualSha256 = await sha256(
        match.path,
        `model-inventory:${asset.id}`,
      );
      const verified = actualSha256 === asset.expectedSha256;
      return {
        ...asset,
        localPath: match.path,
        actualSha256,
        integrity: verified ? "verified" as const : "sha256-mismatch" as const,
        present: verified,
      };
    }
    return {
      ...asset,
      localPath: match.path,
      actualSha256: null,
      integrity: "unverified" as const,
      present: true,
    };
  }));
}

export async function discoverModels(
  roots: readonly string[] = modelRoots,
  verifyAssetIds: readonly RecommendedModelAsset["id"][] = [],
): Promise<ModelInventory> {
  const items: ModelInventoryItem[] = [];
  const errors: string[] = [];
  const pending = roots.map((root) => ({ path: resolve(root), depth: 0 }));
  let visited = 0;
  let truncated = false;

  while (pending.length > 0 && visited < MAX_ENTRIES) {
    const current = pending.shift()!;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      errors.push(`${current.path}: ${error instanceof Error ? error.message : "nicht lesbar"}`);
      continue;
    }
    const remaining = MAX_ENTRIES - visited;
    const boundedEntries = entries.slice(0, remaining);
    if (boundedEntries.length < entries.length) truncated = true;
    visited += boundedEntries.length;
    const names = new Set(entries.map((entry) => entry.name));
    const isGemmaRoot = names.has("tokenizer.model") && names.has("config.json")
      && (names.has("model.safetensors.index.json") || names.has("model.safetensors"));
    if (isGemmaRoot) {
      items.push(await inventoryItem("gemma", current.path));
      continue;
    }
    for (const entry of boundedEntries) {
      const path = join(current.path, entry.name);
      if (entry.isFile()) {
        const kind = classifyModelFile(path);
        if (kind) items.push(await inventoryItem(kind, path));
      } else if (entry.isDirectory() && current.depth < MAX_DEPTH && !IGNORED_DIRECTORIES.has(entry.name)) {
        pending.push({ path, depth: current.depth + 1 });
      }
    }
  }

  items.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  return {
    roots: roots.map((root) => resolve(root)),
    scannedAt: new Date().toISOString(),
    truncated: truncated || pending.length > 0 || visited >= MAX_ENTRIES,
    errors,
    items,
    recommendations: await modelRecommendations(items, verifyAssetIds),
  };
}

export async function getModelInventory(
  force = false,
  verifyAssetIds: readonly RecommendedModelAsset["id"][] = [],
): Promise<ModelInventory> {
  const normalizedVerifyIds = [...new Set(verifyAssetIds)].sort();
  const cacheSatisfiesVerification = (value: ModelInventory) => normalizedVerifyIds.every((id) => {
    const asset = value.recommendations.find((candidate) => candidate.id === id);
    return asset?.present && asset.integrity === "verified";
  });
  if (!force && cached && cached.expiresAt > Date.now() && cacheSatisfiesVerification(cached.value)) {
    return cached.value;
  }
  if (normalizedVerifyIds.length > 0) {
    const verificationKey = normalizedVerifyIds.join(",");
    const existing = verificationInFlight.get(verificationKey);
    if (existing) return existing;
    const pending = discoverModels(modelRoots, normalizedVerifyIds).then((value) => {
      cached = { expiresAt: Date.now() + 30_000, value };
      return value;
    }).finally(() => {
      verificationInFlight.delete(verificationKey);
    });
    verificationInFlight.set(verificationKey, pending);
    return pending;
  }
  if (!force && inFlight) return inFlight;
  inFlight = discoverModels().then((value) => {
    cached = { expiresAt: Date.now() + 30_000, value };
    return value;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
