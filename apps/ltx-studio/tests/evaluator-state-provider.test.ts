import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { PhonemeVisemeEvaluatorStateProvider } from "../server/evaluatorStateProvider.js";
import { resolvePhonemeVisemeEvaluatorState } from "../server/evaluatorManifest.js";

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];
  terminateCalls = 0;
  unrefCalls = 0;

  postMessage(value: unknown): void {
    this.messages.push(value);
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }
}

function verifiedState(fingerprint: string) {
  return {
    ...resolvePhonemeVisemeEvaluatorState(""),
    fingerprint,
  };
}

describe("phoneme/viseme evaluator state provider", () => {
  it("keeps initial health fail-closed and preserves a verified state during background refresh", () => {
    let currentTime = 1_000;
    const worker = new FakeWorker();
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      now: () => currentTime,
      refreshIntervalMs: 100,
      workerFactory: () => worker,
    });

    expect(provider.get().fingerprint).toContain("verification-pending");
    expect(worker.messages).toEqual([{ type: "refresh" }]);
    expect(worker.unrefCalls).toBe(1);
    worker.emit("message", { type: "state", state: verifiedState("verified:first") });
    expect(provider.get().fingerprint).toBe("verified:first");

    currentTime += 101;
    expect(provider.get().fingerprint).toBe("verified:first");
    expect(worker.messages).toEqual([{ type: "refresh" }, { type: "refresh" }]);
    worker.emit("message", { type: "state", state: verifiedState("verified:second") });
    expect(provider.get().fingerprint).toBe("verified:second");
  });

  it("fails closed when a background revalidation of a verified state fails", () => {
    let currentTime = 1_000;
    const worker = new FakeWorker();
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      now: () => currentTime,
      refreshIntervalMs: 100,
      workerFactory: () => worker,
    });

    worker.emit("message", { type: "state", state: verifiedState("verified:first") });
    currentTime += 101;
    expect(provider.get().fingerprint).toBe("verified:first");

    worker.emit("error", new Error("background verification failed"));

    expect(provider.get().fingerprint).toContain("verification-pending");
    expect(provider.get().result.error).toContain("background verification failed");
  });

  it("retries a failed worker quickly instead of retaining a stale ready state", () => {
    let currentTime = 2_000;
    const workers = [new FakeWorker(), new FakeWorker()];
    let created = 0;
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      now: () => currentTime,
      retryIntervalMs: 30,
      workerFactory: () => workers[created++]!,
    });

    workers[0].emit("error", new Error("synthetic worker failure"));
    expect(provider.get().result.error).toContain("synthetic worker failure");
    expect(workers[0].terminateCalls).toBe(1);
    currentTime += 29;
    provider.get();
    expect(created).toBe(1);
    currentTime += 1;
    provider.get();
    expect(created).toBe(2);
    expect(workers[1].messages).toEqual([{ type: "refresh" }]);
  });

  it("terminates a hung verification at its deadline", async () => {
    const worker = new FakeWorker();
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      verificationTimeoutMs: 10,
      retryIntervalMs: 1_000,
      workerFactory: () => worker,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(worker.terminateCalls).toBe(1);
    expect(provider.get().result.error).toContain("Zeitlimit");
  });

  it("contains synchronous worker construction failures", () => {
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      workerFactory: () => {
        throw new Error("synthetic construction failure");
      },
    });

    expect(provider.get().result.error).toContain("Worker-Start fehlgeschlagen");
  });

  it("rejects an invalid worker state payload and terminates the worker", () => {
    const worker = new FakeWorker();
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      workerFactory: () => worker,
    });

    worker.emit("message", { type: "state", state: { fingerprint: "forged" } });

    expect(provider.get().result.error).toContain("ungültige Zustandsnachricht");
    expect(worker.terminateCalls).toBe(1);
  });

  it("rejects a worker state with an incomplete execution contract", () => {
    const worker = new FakeWorker();
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      workerFactory: () => worker,
    });

    worker.emit("message", {
      type: "state",
      state: {
        ...verifiedState("forged:partial-execution"),
        execution: {
          method: "mfa-mediapipe-de.v1",
          sandbox: "systemd-system-sandbox.v1",
          runnerPath: "/tmp/runner.py",
          manifestSha256: "a".repeat(64),
          readOnlyPaths: ["/tmp/runner.py"],
        },
      },
    });

    expect(provider.get().result.error).toContain("ungültige Zustandsnachricht");
    expect(worker.terminateCalls).toBe(1);
  });

  it("fails closed when a worker exits without a result", () => {
    const worker = new FakeWorker();
    const provider = new PhonemeVisemeEvaluatorStateProvider({
      manifestConfigured: true,
      workerFactory: () => worker,
    });

    worker.emit("exit", 17);

    expect(provider.get().result.error).toContain("Code 17");
  });

  it("lets a real verified worker release the Node process naturally", () => {
    const providerUrl = new URL("../server/evaluatorStateProvider.ts", import.meta.url).href;
    const probe = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--eval",
      [
        `import(${JSON.stringify(providerUrl)}).then(({ PhonemeVisemeEvaluatorStateProvider }) => {`,
        "  const provider = new PhonemeVisemeEvaluatorStateProvider({ manifestConfigured: true, verificationTimeoutMs: 4000 });",
        "  const deadline = setTimeout(() => { console.error('verification timeout'); process.exitCode = 1; }, 4000);",
        "  const poll = setInterval(() => {",
        "    const state = provider.get();",
        "    if (!state.fingerprint.includes('verification-pending')) {",
        "      clearInterval(poll);",
        "      clearTimeout(deadline);",
        "      console.log(state.result.blockerCode);",
        "    }",
        "  }, 20);",
        "});",
      ].join("\n"),
    ], {
      encoding: "utf8",
      timeout: 6_000,
      env: {
        ...process.env,
        LTX_STUDIO_PHONEME_VISEME_MANIFEST: "",
      },
    });

    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("manifest-missing");
  }, 10_000);
});
