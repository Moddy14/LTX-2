import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { JobManager, JobPersistenceHoldError } from "../server/jobs.js";
import {
  PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
  PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
  publicJobPersistenceHealthSchema,
} from "../shared/healthPublic.js";
import { validRequest } from "./fixtures.js";

describe("public persistence HOLD redaction", () => {
  it("keeps an oversized private cause on stderr and exposes only the bounded public contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-studio-hold-redaction-"));
    const manager = new JobManager(join(root, "jobs.json"), false);
    const privatePath = "/home/moddy/private/jobs.json";
    const privateDigest = "b".repeat(64);
    const privateCause = `${privatePath} ${privateDigest} ${"raw-cause ".repeat(600)}`;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const enterPersistenceHold = Reflect.get(manager, "enterPersistenceHold") as (
        error: unknown,
        details: string,
      ) => JobPersistenceHoldError;
      const error = enterPersistenceHold.call(
        manager,
        new Error(privateCause),
        `synthetic durability failure at ${privatePath}`,
      );

      const stderrDiagnostic = stderr.mock.calls
        .map(([value]) => String(value))
        .join("");
      expect(stderrDiagnostic.length).toBeGreaterThan(4_096);
      expect(stderrDiagnostic).toContain(privatePath);
      expect(stderrDiagnostic).toContain(privateDigest);
      expect(stderrDiagnostic).toContain("raw-cause");

      expect(error).toMatchObject({
        message: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
        publicCode: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
        publicReason: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
        restartRequired: true,
      });
      const publicHealth = publicJobPersistenceHealthSchema.parse(manager.persistenceHealth());
      const serializedPublicState = JSON.stringify({ error, publicHealth });
      expect(serializedPublicState).not.toContain(privatePath);
      expect(serializedPublicState).not.toContain(privateDigest);
      expect(serializedPublicState).not.toContain("raw-cause");
      expect(serializedPublicState.length).toBeLessThan(1_024);
      expect(() => manager.create(validRequest())).toThrow(PUBLIC_JOB_PERSISTENCE_HOLD_REASON);
    } finally {
      stderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
