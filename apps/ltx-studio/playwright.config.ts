import { defineConfig, devices } from "@playwright/test";

const uiPort = 14_317;
const apiPort = 14_318;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `node -e "require('node:fs').rmSync('/tmp/ltx-studio-playwright',{recursive:true,force:true})" && LTX_STUDIO_DATA_DIR=/tmp/ltx-studio-playwright LTX_STUDIO_MODEL_ROOTS=${process.cwd()}/tests/fixtures/model-inventory LTX_STUDIO_PORT=${apiPort} LTX_STUDIO_UI_PORT=${uiPort} npm run dev`,
    url: `http://127.0.0.1:${uiPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
