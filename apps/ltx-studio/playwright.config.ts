import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const uiPort = 14_317;
const apiPort = 14_318;
const playwrightCache = join(homedir(), ".cache", "ms-playwright");
const cachedFirefoxExecutable = [
  process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH,
  ...(existsSync(playwrightCache)
    ? readdirSync(playwrightCache)
      .filter((name) => /^firefox-\d+$/.test(name))
      .sort().reverse()
      .map((name) => join(playwrightCache, name, "firefox", "firefox"))
    : []),
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  // Every browser project deliberately exercises the same persistent authority
  // store and global Blind-v5 lock through one webServer. Parallel file/project
  // workers would therefore contend with real cross-browser lock state and can
  // trip the 500 ms fail-closed scope watchdog for an unrelated test.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1440, height: 1000 },
        ...(cachedFirefoxExecutable ? { launchOptions: { executablePath: cachedFirefoxExecutable } } : {}),
      },
    },
  ],
  webServer: {
    command: `node -e "require('node:fs').rmSync('/tmp/ltx-studio-playwright',{recursive:true,force:true})" && LTX_STUDIO_DATA_DIR=/tmp/ltx-studio-playwright LTX_STUDIO_MODEL_ROOTS=${process.cwd()}/tests/fixtures/model-inventory LTX_STUDIO_PORT=${apiPort} LTX_STUDIO_UI_PORT=${uiPort} npm run dev`,
    // Gate on the exact API bootstrap depends on, through Vite's proxy. Vite can
    // accept `/` before the concurrently started API process is listening.
    url: `http://127.0.0.1:${uiPort}/api/blind-evaluator-scope`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
