import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { appRoot, pythonExecutable } from "../server/config.js";

const modelPath = join(appRoot, "models", "face_recognition_sface_2021dec.onnx");

describe("pinned SFace identity model", () => {
  it("matches the official artifact and carries its Apache 2.0 license", () => {
    const model = readFileSync(modelPath);
    const license = readFileSync(join(appRoot, "models", "SFACE-LICENSE.txt"), "utf8");

    expect(model).toHaveLength(38_696_353);
    expect(createHash("sha256").update(model).digest("hex")).toBe(
      "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    );
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
  });

  it("exposes the verified 112x112 to 128-dimensional OpenCV interface", () => {
    const result = spawnSync(pythonExecutable, [
      "-c",
      [
        "import cv2,numpy as np",
        `r=cv2.FaceRecognizerSF.create(${JSON.stringify(modelPath)},'')`,
        "x=r.feature(np.zeros((112,112,3),dtype=np.uint8))",
        "assert x.shape == (1,128), x.shape",
      ].join(";"),
    ], {
      encoding: "utf8",
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
      timeout: 15_000,
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
