import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ThermalGuardAction = "pause_hot" | "pause_unreadable" | "resume" | null;

export type ThermalGuardOptions = {
  pauseAtC: number;
  pausePolls: number;
  resumeBelowC: number;
  resumePolls: number;
  unreadablePolls: number;
};

type MedianOptions = {
  samples: number;
  intervalMs: number;
  read?: () => number | null;
  sleep?: (milliseconds: number) => Promise<void>;
};

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function plausibleTemperature(raw: string | null): number | null {
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10) / 1000;
  return Number.isFinite(value) && value >= 1 && value <= 150 ? Math.round(value * 10) / 10 : null;
}

export function readMaxTemperatureC(sysRoot = "/sys"): number | null {
  const readings: number[] = [];
  const thermalRoot = join(sysRoot, "class", "thermal");
  for (const entry of readDirectory(thermalRoot)) {
    if (!entry.startsWith("thermal_zone")) continue;
    const value = plausibleTemperature(readText(join(thermalRoot, entry, "temp")));
    if (value !== null) readings.push(value);
  }

  const hwmonRoot = join(sysRoot, "class", "hwmon");
  for (const entry of readDirectory(hwmonRoot)) {
    if (!entry.startsWith("hwmon")) continue;
    const sensorRoot = join(hwmonRoot, entry);
    for (const input of readDirectory(sensorRoot)) {
      if (!/^temp\d+_input$/.test(input)) continue;
      const value = plausibleTemperature(readText(join(sensorRoot, input)));
      if (value !== null) readings.push(value);
    }
  }
  return readings.length > 0 ? Math.max(...readings) : null;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export async function readMedianMaxTemperatureC({
  samples,
  intervalMs,
  read = readMaxTemperatureC,
  sleep = defaultSleep,
}: MedianOptions): Promise<number | null> {
  if (!Number.isInteger(samples) || samples < 1) throw new Error("samples must be a positive integer");
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("intervalMs must be non-negative");
  const readings: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const value = read();
    if (value !== null) readings.push(value);
    if (index < samples - 1) await sleep(intervalMs);
  }
  if (readings.length === 0) return null;
  readings.sort((left, right) => left - right);
  const middle = Math.floor(readings.length / 2);
  return readings.length % 2 === 1
    ? readings[middle]
    : (readings[middle - 1] + readings[middle]) / 2;
}

export class ThermalPauseGuard {
  private hotStreak = 0;
  private coolStreak = 0;
  private unreadableStreak = 0;

  constructor(private readonly options: ThermalGuardOptions) {
    if (options.pauseAtC <= options.resumeBelowC) {
      throw new Error("pauseAtC must be greater than resumeBelowC");
    }
    for (const value of [options.pausePolls, options.resumePolls, options.unreadablePolls]) {
      if (!Number.isInteger(value) || value < 1) throw new Error("thermal poll counts must be positive integers");
    }
  }

  observe(temperatureC: number | null, paused: boolean): ThermalGuardAction {
    if (paused) {
      this.hotStreak = 0;
      this.unreadableStreak = temperatureC === null ? this.unreadableStreak + 1 : 0;
      this.coolStreak = temperatureC !== null && temperatureC < this.options.resumeBelowC
        ? this.coolStreak + 1
        : 0;
      if (this.coolStreak >= this.options.resumePolls) {
        this.reset();
        return "resume";
      }
      return null;
    }

    this.coolStreak = 0;
    if (temperatureC === null) {
      this.unreadableStreak += 1;
      if (this.unreadableStreak >= this.options.unreadablePolls) {
        this.reset();
        return "pause_unreadable";
      }
      return null;
    }

    this.unreadableStreak = 0;
    this.hotStreak = temperatureC >= this.options.pauseAtC ? this.hotStreak + 1 : 0;
    if (this.hotStreak >= this.options.pausePolls) {
      this.reset();
      return "pause_hot";
    }
    return null;
  }

  reset(): void {
    this.hotStreak = 0;
    this.coolStreak = 0;
    this.unreadableStreak = 0;
  }

  snapshot(): { hotStreak: number; coolStreak: number; unreadableStreak: number } {
    return {
      hotStreak: this.hotStreak,
      coolStreak: this.coolStreak,
      unreadableStreak: this.unreadableStreak,
    };
  }
}
