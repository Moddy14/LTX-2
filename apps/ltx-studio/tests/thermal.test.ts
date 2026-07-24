import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  thermalPauseC,
} from "../server/config.js";
import {
  readMaxTemperatureC,
  readMedianMaxTemperatureC,
  ThermalPauseGuard,
} from "../server/thermal.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeTemperature(path: string, milliCelsius: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${milliCelsius}\n`);
}

describe("sysfs thermal measurements", () => {
  it("uses the hottest plausible thermal-zone or hwmon value", async () => {
    const root = await temporaryRoot("ltx-thermal-");
    await writeTemperature(join(root, "class/thermal/thermal_zone0/temp"), 61_300);
    await writeTemperature(join(root, "class/thermal/thermal_zone1/temp"), 0);
    await writeTemperature(join(root, "class/hwmon/hwmon0/temp1_input"), 72_500);
    await writeTemperature(join(root, "class/hwmon/hwmon0/temp2_input"), 250_000);
    expect(readMaxTemperatureC(root)).toBe(72.5);
  });

  it("returns null when no plausible sensor can be read", async () => {
    const root = await temporaryRoot("ltx-thermal-empty-");
    await writeTemperature(join(root, "class/thermal/thermal_zone0/temp"), -40_000);
    expect(readMaxTemperatureC(root)).toBeNull();
  });

  it("uses a median for the start decision and skips isolated missing samples", async () => {
    const readings = [63.4, 67.1, null, 62.9, 63.1];
    const median = await readMedianMaxTemperatureC({
      samples: readings.length,
      intervalMs: 0,
      read: () => readings.shift() ?? null,
      sleep: async () => undefined,
    });
    expect(median).toBe(63.25);
  });
});

describe("lossless thermal pause guard", () => {
  const options = {
    pauseAtC: 90,
    pausePolls: 3,
    resumeBelowC: 66,
    resumePolls: 5,
    unreadablePolls: 3,
  };

  it("pauses after sustained heat and resumes only after sustained cooling", () => {
    const guard = new ThermalPauseGuard(options);
    expect(guard.observe(92, false)).toBeNull();
    expect(guard.observe(95, false)).toBeNull();
    expect(guard.observe(91, false)).toBe("pause_hot");
    expect(guard.observe(65, true)).toBeNull();
    expect(guard.observe(64, true)).toBeNull();
    expect(guard.observe(67, true)).toBeNull();
    expect(guard.observe(65, true)).toBeNull();
    expect(guard.observe(65, true)).toBeNull();
    expect(guard.observe(65, true)).toBeNull();
    expect(guard.observe(65, true)).toBeNull();
    expect(guard.observe(65, true)).toBe("resume");
  });

  it("pauses fail-closed after persistent sensor blindness and never resumes blind", () => {
    const guard = new ThermalPauseGuard(options);
    expect(guard.observe(null, false)).toBeNull();
    expect(guard.observe(null, false)).toBeNull();
    expect(guard.observe(null, false)).toBe("pause_unreadable");
    for (let index = 0; index < 8; index += 1) expect(guard.observe(null, true)).toBeNull();
  });

  it("keeps the hardware pause threshold independent of a workload start threshold", () => {
    expect(thermalPauseC).toBe(90);
  });
});
