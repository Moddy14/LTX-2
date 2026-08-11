import { describe, expect, it } from "vitest";

import {
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

  it("does not let an isolated runtime inherit Python path overrides", () => {
    expect(pythonRuntimeAvailable(process.execPath, { isolated: true })).toBe(false);
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
