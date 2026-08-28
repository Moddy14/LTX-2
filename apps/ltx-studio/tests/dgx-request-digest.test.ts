import { describe, expect, it } from "vitest";

import type { AdmissionRequest } from "../server/admission.js";
import {
  canonicalDgxRuntimeRequestJson,
  dgxRuntimeRequestSha256,
  dgxRuntimeRequestSha256Matches,
} from "../server/dgxRequestDigest.js";

const goldenRequest: AdmissionRequest = {
  requested_by: "ltx-studio:00000000-0000-4000-8000-000000000001",
  source_app: "LTX Studio",
  job_type: "ltx2_native_two_stage",
  runtime: "ltx2_native",
  priority: "normal",
  estimated_memory_gib: 67.4,
  caller_network: "dgx_local",
  queue_ttl_seconds: 3_600,
  idempotency_key: "ltx-studio:00000000-0000-4000-8000-000000000001",
  resumability: "required",
  scheduling: {
    mode: "segmented",
    preemptible: true,
    yield_after_each_segment: true,
    expected_segment_seconds: 9,
    resume_checkpoint: "/var/lib/ltx/Prüfung/manifest.json",
  },
  resource_profile: {
    gpu: true,
    exclusive_runtime: "ltx2_native",
    required_gib: 67.4,
  },
};

// Generated independently with the Runtime server expression:
// hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
// separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
const PYTHON_GOLDEN_SHA256 = "6b435b29223022dfdbeb36bc624cf98b9e863e5d6834079da0a877d6f74b1105";

describe("DGX Runtime request digest", () => {
  it("matches the compact sorted UTF-8 Python golden vector", () => {
    expect(canonicalDgxRuntimeRequestJson(goldenRequest)).not.toContain("\n");
    expect(dgxRuntimeRequestSha256(goldenRequest)).toBe(PYTHON_GOLDEN_SHA256);
    expect(dgxRuntimeRequestSha256Matches(goldenRequest, PYTHON_GOLDEN_SHA256)).toBe(true);
  });

  it("rejects non-finite requests and non-lowercase or malformed claims", () => {
    expect(dgxRuntimeRequestSha256({
      ...goldenRequest,
      estimated_memory_gib: Number.NaN,
    })).toBeNull();
    expect(dgxRuntimeRequestSha256Matches(
      goldenRequest,
      PYTHON_GOLDEN_SHA256.toUpperCase(),
    )).toBe(false);
    expect(dgxRuntimeRequestSha256Matches(goldenRequest, "not-a-sha256")).toBe(false);
  });

  it("uses Python float formatting for the JSON wire value", () => {
    expect(canonicalDgxRuntimeRequestJson({ value: 0.000001 })).toBe('{"value":1e-06}');
    expect(canonicalDgxRuntimeRequestJson({ value: 0.0001 })).toBe('{"value":0.0001}');
  });
});
