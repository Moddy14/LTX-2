import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/vitest.setup.ts"],
    // Several contract tests probe real python/ffmpeg subprocesses; the 5 s
    // default flakes under full-suite parallelism on a loaded host.
    testTimeout: 30_000,
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
