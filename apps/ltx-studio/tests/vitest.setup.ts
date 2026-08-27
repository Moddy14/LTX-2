import { rm } from "node:fs/promises";

import { afterAll } from "vitest";

import {
  assertSafeVitestCleanupRoot,
  closeActiveVitestDataRootClaim,
  dataRoot,
} from "../server/config.js";

afterAll(async () => {
  const safe = assertSafeVitestCleanupRoot(dataRoot);
  try {
    await rm(safe.path, { recursive: true, force: false });
  } finally {
    closeActiveVitestDataRootClaim();
  }
});
