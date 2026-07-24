import { describe, expect, it } from "vitest";

import {
  pythonRuntimeAvailable,
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
});
