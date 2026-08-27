import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  analysisRuntimeAvailable,
  assertClaimedVitestDataRoot,
  assertSafeVitestCleanupRoot,
  claimIsolatedVitestDataRoot,
  closeVitestDataRootClaim,
  dataRoot,
  isolatedVitestDataRootPrefix,
  isolatedPythonEnvironment,
  parseSealedReleaseMode,
  parseT2aDevelopmentMeasurementMode,
  pythonRuntimeAvailable,
  resolveConfiguredDataRoot,
  SEALED_EXECUTABLE_PATH,
  selectRendererPythonExecutable,
  selectPythonExecutable,
  validateSealedProcessEnvironment,
  validateThermalHysteresis,
} from "../server/config.js";

describe("local endpoint configuration", () => {
  it("requires at least one Celsius degree of thermal hysteresis", () => {
    expect(() => validateThermalHysteresis(90, 89)).not.toThrow();
    expect(() => validateThermalHysteresis(90, 89.01)).toThrow(/at least 1 C below/u);
    expect(() => validateThermalHysteresis(90, 90)).toThrow(/at least 1 C below/u);
  });
  it("isolates the publication authority namespace per Vitest worker", () => {
    expect(dataRoot.startsWith(`${resolve(tmpdir())}/ltx-studio-vitest-${process.pid}-`)).toBe(true);
    expect(assertSafeVitestCleanupRoot(dataRoot)).toEqual({ path: dataRoot, exists: true });
  });
  it("rejects path traversal and unbounded Vitest worker identifiers", () => {
    for (const identifier of [
      "../../../var/lib/ltx-studio",
      "worker/child",
      "worker.child",
      "worker child",
      "x".repeat(65),
      "",
    ]) {
      expect(() => isolatedVitestDataRootPrefix(identifier, 1234, "/tmp"))
        .toThrow(/test-worker identifier/i);
    }
    expect(isolatedVitestDataRootPrefix("pool_2-worker", 1234, "/tmp"))
      .toBe("/tmp/ltx-studio-vitest-1234-pool_2-worker-");
  });
  it("forbids every LTX_STUDIO_DATA_DIR override in Vitest mode", () => {
    expect(resolveConfiguredDataRoot({
      vitestMode: true,
      claimedVitestDataRoot: "/tmp/private-random-root",
      repositoryDefault: "/repository/.ltx-studio",
    })).toBe("/tmp/private-random-root");
    expect(() => resolveConfiguredDataRoot({
      vitestMode: true,
      configuredDataRoot: "/tmp/private-random-root",
      claimedVitestDataRoot: "/tmp/private-random-root",
      repositoryDefault: "/repository/.ltx-studio",
    })).toThrow(/forbidden in Vitest mode/i);
    expect(() => resolveConfiguredDataRoot({
      vitestMode: true,
      repositoryDefault: "/repository/.ltx-studio",
    })).toThrow(/atomically allocated/i);
  });
  it("ignores a preexisting predictable-root symlink without writing foreign data", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ltx-vitest-clean-root-"));
    const foreignRoot = mkdtempSync(join(tmpdir(), "ltx-vitest-clean-foreign-"));
    const temporaryLink = `${temporaryRoot}-link`;
    const marker = join(foreignRoot, "must-survive.txt");
    const predictableRoot = join(temporaryRoot, "ltx-studio-vitest-9876-worker_9");
    writeFileSync(marker, "foreign\n");
    let claim: ReturnType<typeof claimIsolatedVitestDataRoot> | undefined;
    try {
      symlinkSync(temporaryRoot, temporaryLink, "dir");
      expect(() => isolatedVitestDataRootPrefix("worker_9", 9876, temporaryLink))
        .toThrow(/canonical real directory/i);
      unlinkSync(temporaryLink);

      symlinkSync(foreignRoot, predictableRoot, "dir");
      claim = claimIsolatedVitestDataRoot("worker_9", 9876, temporaryRoot);
      expect(claim.path).not.toBe(predictableRoot);
      assertClaimedVitestDataRoot(claim);
      mkdirSync(join(claim.path, "uploads"), { mode: 0o700 });

      // This assertion intentionally runs before any cleanup: allocation and
      // the first derived-root write must never have followed the planted link.
      expect(readFileSync(marker, "utf8")).toBe("foreign\n");
      expect(existsSync(join(foreignRoot, "uploads"))).toBe(false);
    } finally {
      if (claim !== undefined) {
        assertClaimedVitestDataRoot(claim);
        closeVitestDataRootClaim(claim);
        rmSync(claim.path, { recursive: true, force: true });
      }
      try { unlinkSync(temporaryLink); } catch { /* already absent */ }
      try { unlinkSync(predictableRoot); } catch { /* already absent */ }
      rmSync(temporaryRoot, { recursive: true, force: true });
      rmSync(foreignRoot, { recursive: true, force: true });
    }
  });
  it("fails closed when a claimed root is swapped or its ownership mode changes", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ltx-vitest-identity-root-"));
    const foreignRoot = mkdtempSync(join(tmpdir(), "ltx-vitest-identity-foreign-"));
    const marker = join(foreignRoot, "must-survive.txt");
    const claim = claimIsolatedVitestDataRoot("worker_10", 9877, temporaryRoot);
    const displaced = `${claim.path}-displaced`;
    writeFileSync(marker, "foreign\n");
    try {
      chmodSync(claim.path, 0o755);
      expect(() => assertClaimedVitestDataRoot(claim)).toThrow(/mode 0700/i);
      expect(readFileSync(marker, "utf8")).toBe("foreign\n");
      chmodSync(claim.path, 0o700);
      assertClaimedVitestDataRoot(claim);

      renameSync(claim.path, displaced);
      symlinkSync(foreignRoot, claim.path, "dir");
      expect(() => assertClaimedVitestDataRoot(claim)).toThrow(/canonical real directory/i);
      expect(readFileSync(marker, "utf8")).toBe("foreign\n");
      expect(() => assertSafeVitestCleanupRoot(foreignRoot)).toThrow(/not owned by this Vitest process/i);

      unlinkSync(claim.path);
      renameSync(displaced, claim.path);
      assertClaimedVitestDataRoot(claim);
    } finally {
      try { unlinkSync(claim.path); } catch { /* it may be a restored directory */ }
      if (resolve(claim.path) !== resolve(displaced)) {
        try { renameSync(displaced, claim.path); } catch { /* already restored */ }
      }
      try {
        assertClaimedVitestDataRoot(claim);
        closeVitestDataRootClaim(claim);
        rmSync(claim.path, { recursive: true, force: true });
      } catch {
        closeVitestDataRootClaim(claim);
        rmSync(displaced, { recursive: true, force: true });
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
      rmSync(foreignRoot, { recursive: true, force: true });
    }
  });
  it("treats only an exact 1 as an explicitly sealed mode", () => {
    expect(parseSealedReleaseMode(undefined)).toBe(false);
    expect(parseSealedReleaseMode("")).toBe(false);
    expect(parseSealedReleaseMode("1")).toBe(true);
    for (const invalid of ["0", "true", " 1", "1 "]) {
      expect(() => parseSealedReleaseMode(invalid)).toThrow(/exactly 1/);
    }
  });
  it("requires exact opt-in and refuses development T2A measurement in sealed mode", () => {
    expect(parseT2aDevelopmentMeasurementMode(undefined, false)).toBe(false);
    expect(parseT2aDevelopmentMeasurementMode("", false)).toBe(false);
    expect(parseT2aDevelopmentMeasurementMode("1", false)).toBe(true);
    expect(() => parseT2aDevelopmentMeasurementMode("1", true)).toThrow(/sealed release mode/u);
    for (const invalid of ["0", "true", " 1", "1 "]) {
      expect(() => parseT2aDevelopmentMeasurementMode(invalid, false)).toThrow(/exactly 1/u);
    }
  });
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

  it("fails sealed startup closed on executable injection variables", () => {
    expect(() => validateSealedProcessEnvironment(true, {
      LTX_STUDIO_SEALED_RELEASE: "1",
      LTX_STUDIO_DATA_DIR: "/var/lib/ltx-studio",
      HF_HUB_OFFLINE: "1",
      PYTHONNOUSERSITE: "1",
      TRANSFORMERS_OFFLINE: "1",
      PATH: SEALED_EXECUTABLE_PATH,
      NODE_OPTIONS: "--import=/tmp/inject.mjs",
    })).toThrow(/NODE_OPTIONS/);
    expect(() => validateSealedProcessEnvironment(true, {
      LTX_STUDIO_SEALED_RELEASE: "1",
      LTX_STUDIO_DATA_DIR: "/var/lib/ltx-studio",
      HF_HUB_OFFLINE: "1",
      PYTHONNOUSERSITE: "1",
      TRANSFORMERS_OFFLINE: "1",
      PATH: SEALED_EXECUTABLE_PATH,
      PYTHONPATH: "/tmp/inject",
      LD_PRELOAD: "/tmp/inject.so",
    })).toThrow(/LD_PRELOAD.*PYTHONPATH|PYTHONPATH.*LD_PRELOAD/);
    expect(() => validateSealedProcessEnvironment(false, {
      NODE_OPTIONS: "--enable-source-maps",
    })).not.toThrow();
    for (const variable of ["LD_AUDIT", "LD_LIBRARY_PATH", "PYTHONSTARTUP"] as const) {
      expect(() => validateSealedProcessEnvironment(true, {
        LTX_STUDIO_SEALED_RELEASE: "1",
        LTX_STUDIO_DATA_DIR: "/var/lib/ltx-studio",
        HF_HUB_OFFLINE: "1",
        PYTHONNOUSERSITE: "1",
        TRANSFORMERS_OFFLINE: "1",
        PATH: SEALED_EXECUTABLE_PATH,
        [variable]: "/tmp/inject",
      })).toThrow(new RegExp(variable));
    }
    expect(() => validateSealedProcessEnvironment(true, {
      LTX_STUDIO_SEALED_RELEASE: "1",
      LTX_STUDIO_DATA_DIR: "/var/lib/ltx-studio",
      HF_HUB_OFFLINE: "1",
      PYTHONNOUSERSITE: "1",
      TRANSFORMERS_OFFLINE: "1",
      PATH: "/tmp/attacker:/usr/bin",
    })).toThrow(/fixed executable PATH/);
  });
});
