import { describe, expect, it } from "vitest";

// @ts-expect-error The immutable release-manifest CLI helper is plain ESM JavaScript.
import { productionTcbLicenses } from "../scripts/release-manifest-lib.mjs";

describe("release production-TCB license inventory", () => {
  it("includes explicit Host-TCB dynamic libraries such as nvidia-smi NVML", () => {
    const nodeLicenseSha256 = "1".repeat(64);
    const nvidiaSmiLicenseSha256 = "2".repeat(64);
    const nvmlLicenseSha256 = "3".repeat(64);

    expect(productionTcbLicenses({
      runtimeComponents: [{
        name: "node",
        license: {
          path: "apps/ltx-studio/runtime/NODE-LICENSE",
          sha256: nodeLicenseSha256,
        },
      }],
      tools: [{
        name: "nvidia-smi",
        license: {
          path: "/usr/share/doc/nvidia-utils-580/copyright",
          sha256: nvidiaSmiLicenseSha256,
        },
        dynamicLibraries: [{
          name: "nvml",
          license: {
            path: "/usr/share/doc/libnvidia-compute-580/copyright",
            sha256: nvmlLicenseSha256,
          },
        }],
      }],
    })).toEqual([
      {
        component: "node",
        scope: "in-release",
        path: "apps/ltx-studio/runtime/NODE-LICENSE",
        sha256: nodeLicenseSha256,
      },
      {
        component: "nvidia-smi",
        scope: "host",
        path: "/usr/share/doc/nvidia-utils-580/copyright",
        sha256: nvidiaSmiLicenseSha256,
      },
      {
        component: "nvidia-smi:nvml",
        scope: "host",
        path: "/usr/share/doc/libnvidia-compute-580/copyright",
        sha256: nvmlLicenseSha256,
      },
    ]);
  });

  it("fails closed when an explicit dynamic library has no exact license hash", () => {
    expect(() => productionTcbLicenses({
      runtimeComponents: [],
      tools: [{
        name: "nvidia-smi",
        license: { path: "/license/nvidia-smi", sha256: "4".repeat(64) },
        dynamicLibraries: [{
          name: "nvml",
          license: { path: "/license/nvml", sha256: "not-a-sha256" },
        }],
      }],
    })).toThrow(/dynamic library has no exact production-TCB license identity/u);
  });
});
