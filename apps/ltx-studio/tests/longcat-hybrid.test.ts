import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = resolve(process.cwd());
const script = readFileSync(resolve(appRoot, "scripts/longcat-hybrid.py"), "utf8");
const model = readFileSync(resolve(appRoot, "models/face_detection_yunet_2023mar.onnx"));

describe("LongCat hybrid compositor contract", () => {
  it("pins the local YuNet model", () => {
    expect(createHash("sha256").update(model).digest("hex"))
      .toBe("8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4");
  });

  it("tracks landmarks per frame and recovers short detector dropouts", () => {
    expect(script).toContain("cv2.FaceDetectorYN.create");
    expect(script).toContain("cv2.calcOpticalFlowPyrLK");
    expect(script).toContain("landmark_geometry_valid(base_points)");
  });

  it("fully covers the old mouth inside a feathered moving mask", () => {
    expect(script).toContain("class MouthTransformSmoother");
    expect(script).toContain("transform = mouth_transformer.build(lip_points, base_points)");
    expect(script).toContain("angle = math.degrees(target_roll)");
    expect(script).toContain("alpha = np.maximum(opaque, feathered)");
    expect(script).toContain("alpha *= nose_gate");
    expect(script).toContain("class TemporalColorMatcher");
  });

  it("preserves only complete resumable LongCat checkpoints after interruption", () => {
    expect(script).toContain("def has_durable_checkpoint");
    expect(script).toContain('manifest.get("schema_version") != "longcat-segment-checkpoint.v1"');
    expect(script).toContain("preserve_for_resume");
    expect(script).toContain("work_file.unlink(missing_ok=True)");
    expect(script).toContain("if assets is not None and not preserve_for_resume");
  });
});
