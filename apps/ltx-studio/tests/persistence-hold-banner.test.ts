import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { PersistenceHoldBanner } from "../src/components/PersistenceHoldBanner.js";
import { settleStudioStartup } from "../src/startupLoad.js";
import {
  PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
  PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
  publicHealthSchema,
  publicJobPersistenceHoldHealth,
} from "../shared/healthPublic.js";

function health(status: "ok" | "hold") {
  return publicHealthSchema.parse({
    state: status === "hold" ? "blocked" : "ready",
    release: {
      sealed: false,
      verified: false,
      authorityIsolation: {
        status: "hold",
        mechanism: "unattested-development",
        reasonCode: "runtime-trust-unavailable",
      },
    },
    resources: {
      availableMemoryGiB: 64,
      totalMemoryGiB: 128,
      swapFreeGiB: 16,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    },
    engine: "available",
    analysisEngine: "available",
    orchestrator: "available",
    qwen: "ready",
    runtimeOverall: "ready",
    workloads: [],
    evaluators: {
      phonemeViseme: {
        status: "not-applicable",
        blockerCode: "none",
        message: null,
        productGo: "blocked",
        measurementReady: false,
        method: null,
      },
      t2aAudio: {
        status: "blocked",
        claimScope: null,
        blockerCode: "development-opt-in-required",
        message: "blocked",
        productGo: "blocked",
        measurementReady: false,
      },
    },
    jobPersistence: status === "hold"
      ? publicJobPersistenceHoldHealth()
      : { status: "ok", restartRequired: false },
    queueDepth: 0,
  });
}

describe("PersistenceHoldBanner", () => {
  it("renders an inline restart-required safety notice only for HOLD", () => {
    const holdMarkup = renderToStaticMarkup(createElement(PersistenceHoldBanner, {
      health: health("hold"),
      onReload: vi.fn(),
    }));
    expect(holdMarkup).toContain("Job-Persistenz ist im Sicherheits-HOLD");
    expect(holdMarkup).toContain("ein Neustart ist erforderlich");
    expect(holdMarkup).toContain("Status neu laden");
    expect(holdMarkup).toContain("separaten Server-Neustart");
    expect(holdMarkup).toContain(PUBLIC_JOB_PERSISTENCE_HOLD_REASON);
    expect(holdMarkup).not.toContain("/home/");
    expect(holdMarkup).not.toMatch(/[a-f0-9]{64}/u);
    expect(health("hold").jobPersistence).toMatchObject({
      code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
    });

    const healthyMarkup = renderToStaticMarkup(createElement(PersistenceHoldBanner, {
      health: health("ok"),
      onReload: vi.fn(),
    }));
    expect(healthyMarkup).toBe("");
  });

  it("keeps schema-valid HOLD health visible when fail-closed output loading returns 503", async () => {
    const holdHealth = health("hold");
    const settled = await settleStudioStartup({
      core: Promise.resolve({ config: true }),
      health: Promise.resolve(holdHealth),
      outputs: Promise.reject(new Error("503 outputs blocked by persistence HOLD")),
      experiments: Promise.resolve([]),
    });

    expect(settled.healthResult).toEqual({ status: "fulfilled", value: holdHealth });
    expect(settled.outputResult.status).toBe("rejected");
    if (settled.healthResult.status !== "fulfilled") throw new Error("HOLD health unexpectedly rejected");
    const markup = renderToStaticMarkup(createElement(PersistenceHoldBanner, {
      health: settled.healthResult.value,
      onReload: vi.fn(),
    }));
    expect(markup).toContain("Job-Persistenz ist im Sicherheits-HOLD");
    expect(markup).toContain("ein Neustart ist erforderlich");
  });

  it("applies HOLD health before unresolved core and output requests settle", async () => {
    const holdHealth = health("hold");
    let resolveCore!: (value: { config: true }) => void;
    let resolveOutputs!: (value: readonly never[]) => void;
    const core = new Promise<{ config: true }>((resolve) => {
      resolveCore = resolve;
    });
    const outputs = new Promise<readonly never[]>((resolve) => {
      resolveOutputs = resolve;
    });
    let applyHealth!: (result: PromiseSettledResult<typeof holdHealth>) => void;
    const healthApplied = new Promise<PromiseSettledResult<typeof holdHealth>>((resolve) => {
      applyHealth = resolve;
    });

    let startupSettled = false;
    const startup = settleStudioStartup({
      core,
      health: Promise.resolve(holdHealth),
      outputs,
      experiments: Promise.resolve([]),
      onHealthSettled: applyHealth,
    }).finally(() => {
      startupSettled = true;
    });

    const earlyHealth = await healthApplied;
    expect(startupSettled).toBe(false);
    expect(earlyHealth).toEqual({ status: "fulfilled", value: holdHealth });
    if (earlyHealth.status !== "fulfilled") throw new Error("HOLD health unexpectedly rejected");
    const markup = renderToStaticMarkup(createElement(PersistenceHoldBanner, {
      health: earlyHealth.value,
      onReload: vi.fn(),
    }));
    expect(markup).toContain("Job-Persistenz ist im Sicherheits-HOLD");

    resolveCore({ config: true });
    resolveOutputs([]);
    await expect(startup).resolves.toMatchObject({
      healthResult: { status: "fulfilled", value: holdHealth },
    });
    expect(startupSettled).toBe(true);
  });
});
