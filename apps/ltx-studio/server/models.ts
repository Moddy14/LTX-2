import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { recommendedModelAssets, type ModelInventory, type ModelInventoryItem, type ModelKind } from "../shared/models.js";
import { modelRoots } from "./config.js";

const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 5;
const IGNORED_DIRECTORIES = new Set([".cache", ".git", "gguf", "node_modules", "outputs", "uploads"]);
let cached: { expiresAt: number; value: ModelInventory } | null = null;
let inFlight: Promise<ModelInventory> | null = null;

export function classifyModelFile(path: string): ModelKind | null {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if ((extension === ".json" || extension === ".pt") && name.includes("amax")) return "amax";
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

function modelRecommendations(items: readonly ModelInventoryItem[]): ModelInventory["recommendations"] {
  return recommendedModelAssets.map((asset) => {
    const match = items.find((item) =>
      item.kind === asset.kind
      && (item.name === asset.filename || item.path === asset.localPath),
    );
    return {
      ...asset,
      localPath: match?.path ?? asset.localPath,
      present: Boolean(match),
    };
  });
}

export async function discoverModels(roots: readonly string[] = modelRoots): Promise<ModelInventory> {
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
    recommendations: modelRecommendations(items),
  };
}

export async function getModelInventory(force = false): Promise<ModelInventory> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  if (!force && inFlight) return inFlight;
  inFlight = discoverModels().then((value) => {
    cached = { expiresAt: Date.now() + 30_000, value };
    return value;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
