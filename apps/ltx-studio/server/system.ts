import { readFileSync, statfsSync } from "node:fs";

import { outputRoot } from "./config.js";

export type ResourceSnapshot = {
  availableMemoryGiB: number | null;
  totalMemoryGiB: number | null;
  swapFreeGiB: number | null;
  swapTotalGiB: number | null;
  outputFreeGiB: number | null;
};

export type StartResourceRequirements = {
  estimatedMemoryGiB: number;
  minAvailableGiB: number;
  minResidualMemoryGiB: number;
  minSwapFreeGiB: number;
  outputGiB: number;
};

function kibToGiB(value: number): number {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}

export function validateStartResources(
  resource: ResourceSnapshot,
  requirements: StartResourceRequirements,
): string | null {
  const requiredMemoryGiB = Math.max(
    requirements.minAvailableGiB,
    requirements.estimatedMemoryGiB + requirements.minResidualMemoryGiB,
  );
  const requiredDiskGiB = Math.max(1, Math.ceil(requirements.outputGiB * 3 * 100) / 100);
  if (resource.availableMemoryGiB === null) {
    return "RAM-Status ist unbekannt; Start aus Sicherheitsgründen blockiert.";
  }
  if (resource.swapFreeGiB === null) {
    return "Swap-Status ist unbekannt; Start aus Sicherheitsgründen blockiert.";
  }
  if (resource.swapFreeGiB < requirements.minSwapFreeGiB) {
    return `Nur ${resource.swapFreeGiB.toFixed(2)} GiB Swap frei; mindestens ${requirements.minSwapFreeGiB} GiB sind als Sicherheitsreserve erforderlich.`;
  }
  if (resource.availableMemoryGiB < requiredMemoryGiB) {
    return `Nur ${resource.availableMemoryGiB.toFixed(2)} GiB RAM frei; ${requirements.estimatedMemoryGiB} GiB Prognose plus ${requirements.minResidualMemoryGiB} GiB Restpuffer erfordern ${requiredMemoryGiB} GiB.`;
  }
  if (resource.outputFreeGiB === null) {
    return "Freier Ausgabeplatz ist unbekannt; Start aus Sicherheitsgründen blockiert.";
  }
  if (resource.outputFreeGiB < requiredDiskGiB) {
    return `Nur ${resource.outputFreeGiB.toFixed(2)} GiB Ausgabeplatz frei; erforderlich sind mindestens ${requiredDiskGiB.toFixed(2)} GiB.`;
  }
  return null;
}

export function readResourceSnapshot(): ResourceSnapshot {
  let availableMemoryGiB: number | null = null;
  let totalMemoryGiB: number | null = null;
  let swapFreeGiB: number | null = null;
  let swapTotalGiB: number | null = null;
  try {
    const entries = Object.fromEntries(
      readFileSync("/proc/meminfo", "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [key, rawValue] = line.split(":");
          return [key, Number.parseInt(rawValue.trim().split(/\s+/)[0], 10)];
        }),
    );
    availableMemoryGiB = kibToGiB(entries.MemAvailable);
    totalMemoryGiB = kibToGiB(entries.MemTotal);
    swapFreeGiB = kibToGiB(entries.SwapFree);
    swapTotalGiB = kibToGiB(entries.SwapTotal);
  } catch {
    // Unknown memory is handled fail-closed by the job manager.
  }

  let outputFreeGiB: number | null = null;
  try {
    const stats = statfsSync(outputRoot);
    outputFreeGiB = Math.round((Number(stats.bavail) * Number(stats.bsize) / 1024 ** 3) * 100) / 100;
  } catch {
    // The health endpoint reports unavailable disk evidence explicitly.
  }
  return { availableMemoryGiB, totalMemoryGiB, swapFreeGiB, swapTotalGiB, outputFreeGiB };
}
