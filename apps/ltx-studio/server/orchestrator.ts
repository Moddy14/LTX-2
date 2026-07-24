import { runtimeApiJson } from "./runtimeApi.js";

export type PublicRuntimeLane = {
  id: "qwen" | "avatar" | "comfyui";
  label: string;
  state: string;
  protected: boolean;
  estimatedMemoryGiB: number | null;
};

export type PublicOrchestratorStatus = {
  overall: string;
  qwen: "ready" | "busy" | "offline";
  workloads: PublicRuntimeLane[];
};

type RawLane = Record<string, unknown>;

export function sanitizeRuntimeStatus(value: unknown): PublicOrchestratorStatus {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const lanes = root.runtime_lanes && typeof root.runtime_lanes === "object"
    ? root.runtime_lanes as Record<string, RawLane>
    : {};
  const qwen = lanes.qwen_coding_worker ?? {};
  const avatar = lanes.avatar_video ?? {};
  const comfyui = lanes.comfyui_ideogram ?? {};
  const state = (lane: RawLane) => typeof lane.state === "string" ? lane.state : "unknown";
  const memory = (lane: RawLane) => typeof lane.estimated_memory_gib === "number" ? lane.estimated_memory_gib : null;
  const qwenState = state(qwen);
  const overall = typeof root.overall === "string"
    ? root.overall
    : root.overall && typeof root.overall === "object" && typeof (root.overall as RawLane).state === "string"
      ? (root.overall as RawLane).state as string
      : "unknown";
  return {
    overall,
    qwen: qwenState === "resident_ready"
      ? "ready"
      : qwenState === "resident_running" || qwenState === "running"
        ? "busy"
        : "offline",
    workloads: [
      { id: "avatar", label: "Avatar", state: state(avatar), protected: avatar.consumer_only_no_self_reclaim === true, estimatedMemoryGiB: memory(avatar) },
      { id: "qwen", label: "Qwen", state: qwenState, protected: true, estimatedMemoryGiB: memory(qwen) },
      { id: "comfyui", label: "ComfyUI", state: state(comfyui), protected: false, estimatedMemoryGiB: memory(comfyui) },
    ],
  };
}

export async function readOrchestratorStatus(): Promise<PublicOrchestratorStatus> {
  return sanitizeRuntimeStatus(await runtimeApiJson("GET", "/dgx/status", undefined, { timeoutMs: 3_500 }));
}
