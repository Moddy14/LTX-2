import { describe, expect, it } from "vitest";

import {
  type ResourceSnapshot,
  validatePreAdmissionResources,
  validateStartResources,
} from "../server/system.js";

const healthy: ResourceSnapshot = {
  availableMemoryGiB: 80,
  totalMemoryGiB: 121.69,
  swapFreeGiB: 8,
  swapTotalGiB: 16,
  outputFreeGiB: 100,
};

const requirements = {
  estimatedMemoryGiB: 54,
  minAvailableGiB: 48,
  minResidualMemoryGiB: 24,
  minSwapFreeGiB: 4,
  outputGiB: 0.01,
};

describe("fail-closed start resources", () => {
  it("requires the estimate plus residual RAM headroom", () => {
    expect(validateStartResources(
      { ...healthy, availableMemoryGiB: 71 },
      requirements,
    )).toContain("54 GiB Prognose plus 24 GiB Restpuffer");
    expect(validateStartResources(
      { ...healthy, availableMemoryGiB: 78 },
      requirements,
    )).toBeNull();
  });

  it("blocks critically depleted swap even when RAM is available", () => {
    expect(validateStartResources(
      { ...healthy, swapFreeGiB: 1.96 },
      requirements,
    )).toContain("gemeinsame Sicherheitsreserve");
  });

  it("accepts low free swap only when excess available RAM covers the reserve", () => {
    expect(validateStartResources(
      { ...healthy, availableMemoryGiB: 102, swapFreeGiB: 3.7 },
      requirements,
    )).toBeNull();
  });

  it("blocks unknown memory, swap and output evidence", () => {
    expect(validateStartResources(
      { ...healthy, availableMemoryGiB: null },
      requirements,
    )).toContain("RAM-Status ist unbekannt");
    expect(validateStartResources(
      { ...healthy, swapFreeGiB: null },
      requirements,
    )).toContain("Swap-Status ist unbekannt");
    expect(validateStartResources(
      { ...healthy, outputFreeGiB: null },
      requirements,
    )).toContain("Ausgabeplatz ist unbekannt");
  });

  it("checks only non-orchestrated disk before queue admission and defers RAM/swap to the start fence", () => {
    const preAdmissionRequirements = {
      outputGiB: 0.5,
    };
    expect(validatePreAdmissionResources(
      { ...healthy, availableMemoryGiB: null },
      preAdmissionRequirements,
    )).toBeNull();
    expect(validatePreAdmissionResources(
      { ...healthy, swapFreeGiB: null },
      preAdmissionRequirements,
    )).toBeNull();
    expect(validatePreAdmissionResources(
      { ...healthy, swapFreeGiB: 0.25 },
      preAdmissionRequirements,
    )).toBeNull();
    expect(validatePreAdmissionResources(
      { ...healthy, outputFreeGiB: null },
      preAdmissionRequirements,
    )).toContain("Ausgabeplatz ist unbekannt");
    expect(validatePreAdmissionResources(
      { ...healthy, outputFreeGiB: 1.49 },
      preAdmissionRequirements,
    )).toContain("mindestens 1.50 GiB");
  });
});
