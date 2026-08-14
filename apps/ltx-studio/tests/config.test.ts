import { describe, expect, it } from "vitest";

import {
  analysisRuntimeAvailable,
  isolatedPythonEnvironment,
  pythonRuntimeAvailable,
  selectRendererPythonExecutable,
  selectPythonExecutable,
} from "../server/config.js";

describe("local endpoint configuration", () => {
  it("honors an explicit pipeline interpreter", () => {
    expect(selectPythonExecutable("/custom/ltx-python", [process.execPath]))
      .toBe("/custom/ltx-python");
  });

  it("selects the first executable fallback", () => {
    expect(selectPythonExecutable(undefined, ["/definitely/missing/python", process.execPath]))
      .toBe(process.execPath);
  });

  it("rejects an executable without the Python LTX runtime", () => {
    expect(pythonRuntimeAvailable(process.execPath)).toBe(false);
  });

  it("rejects an executable without the objective-analysis runtime", () => {
    expect(analysisRuntimeAvailable(process.execPath)).toBe(false);
  });

  it("does not let an isolated runtime inherit Python path overrides", () => {
    expect(pythonRuntimeAvailable(process.execPath, { isolated: true })).toBe(false);
  });

  it("forces offline model loading and removes Python path injection", () => {
    const environment = isolatedPythonEnvironment({
      HF_HUB_OFFLINE: "0",
      PYTHONHOME: "/host/python",
      PYTHONPATH: "/host/packages",
      TRANSFORMERS_OFFLINE: "0",
    });

    expect(environment.HF_HUB_OFFLINE).toBe("1");
    expect(environment.TRANSFORMERS_OFFLINE).toBe("1");
    expect(environment.PYTHONNOUSERSITE).toBe("1");
    expect(environment.PYTHONHOME).toBeUndefined();
    expect(environment.PYTHONPATH).toBeUndefined();
  });

  it("requires the exact in-release renderer for a sealed release", () => {
    expect(selectRendererPythonExecutable({
      sealed: true,
      explicit: process.execPath,
      sealedCandidate: process.execPath,
      developmentCandidates: [],
    })).toBe(process.execPath);
    expect(() => selectRendererPythonExecutable({
      sealed: true,
      explicit: "/outside/python",
      sealedCandidate: process.execPath,
      developmentCandidates: [],
    })).toThrow(/inside the sealed release runtime/);
    expect(() => selectRendererPythonExecutable({
      sealed: true,
      explicit: undefined,
      sealedCandidate: "/definitely/missing/python",
      developmentCandidates: [process.execPath],
    })).toThrow(/missing or not executable/);
  });
});
