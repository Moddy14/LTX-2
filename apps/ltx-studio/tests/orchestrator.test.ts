import { describe, expect, it } from "vitest";

import { sanitizeRuntimeStatus } from "../server/orchestrator.js";

describe("public orchestrator status", () => {
  it("exposes only sanitized lane facts and preserves Avatar protection", () => {
    const status = sanitizeRuntimeStatus({
      overall: { state: "warn", summary: "internal" },
      resources: { gpu_processes: [{ pid: "secret" }] },
      runtime_lanes: {
        qwen_coding_worker: { state: "resident_ready", endpoint: "internal" },
        avatar_video: { state: "running", estimated_memory_gib: 80, consumer_only_no_self_reclaim: true, container: "internal" },
        comfyui_ideogram: { state: "ready", base_url: "internal" },
      },
    });
    expect(status).toEqual({
      overall: "warn",
      qwen: "ready",
      workloads: [
        { id: "avatar", label: "Avatar", state: "running", protected: true, estimatedMemoryGiB: 80 },
        { id: "qwen", label: "Qwen", state: "resident_ready", protected: true, estimatedMemoryGiB: null },
        { id: "comfyui", label: "ComfyUI", state: "ready", protected: false, estimatedMemoryGiB: null },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(status)).not.toContain("internal");
  });
});
