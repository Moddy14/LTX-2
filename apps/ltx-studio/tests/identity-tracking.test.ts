import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appRoot, pythonExecutable } from "../server/config.js";

const roots: string[] = [];
const analyzerPath = join(appRoot, "scripts", "analyze-face-quality.py");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runPython(source: string, ...args: string[]) {
  const result = spawnSync(pythonExecutable, ["-c", source, analyzerPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const importAnalyzer = [
  "import importlib.util, json, sys",
  "import numpy as np",
  "spec = importlib.util.spec_from_file_location('ltx_analyzer', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
].join("\n");

describe("SFace target tracking and evidence isolation", () => {
  it("keeps the initial dominant subject instead of jumping to a more reference-like background face", () => {
    const output = runPython([
      importAnalyzer,
      "def unit(values):",
      "    value = np.asarray(values, dtype=np.float64)",
      "    return value / np.linalg.norm(value)",
      "def candidate(x, area, embedding, timestamp):",
      "    side = area ** 0.5",
      "    return {",
      "        'embedding': unit(embedding),",
      "        'landmarks': np.asarray([[10, 10], [30, 10], [20, 20], [14, 30], [26, 30]], dtype=np.float64),",
      "        'confidence': 0.95,",
      "        'timestamp': timestamp,",
      "        'area': area,",
      "        'area_ratio': area,",
      "        'box': np.asarray([x, 0.25, side, side], dtype=np.float64),",
      "        'center': np.asarray([x + side / 2, 0.25 + side / 2], dtype=np.float64),",
      "    }",
      "template = unit([1.0, 0.0])",
      "target = [0.78, 0.63]",
      "lookalike = [0.995, 0.1]",
      "frames = [",
      "    [candidate(0.08, 0.09, target, 0.0), candidate(0.72, 0.025, lookalike, 0.0)],",
      "    [candidate(0.13, 0.09, target, 0.04), candidate(0.66, 0.025, lookalike, 0.04)],",
      "    [candidate(0.19, 0.09, target, 0.08), candidate(0.57, 0.025, lookalike, 0.08)],",
      "    [],",
      "    [candidate(0.27, 0.09, target, 0.16), candidate(0.49, 0.025, lookalike, 0.16)],",
      "]",
      "selected, ambiguous = module.track_output_identity(frames, template)",
      "face = module.face_metrics_from_tracked_candidates(len(frames), selected)",
      "print(json.dumps({",
      "    'count': len(selected),",
      "    'max_area': min(float(item['area_ratio']) for item in selected),",
      "    'faceDetected': face['detectedFrames'],",
      "    'faceArea': face['medianFaceAreaRatio'],",
      "    'ambiguous': ambiguous,",
      "}))",
    ].join("\n"));

    expect(JSON.parse(output)).toEqual({
      count: 4,
      max_area: 0.09,
      faceDetected: 4,
      faceArea: 0.09,
      ambiguous: 0,
    });
  });

  it("refuses to reacquire a different person after a long target occlusion", () => {
    const output = runPython([
      importAnalyzer,
      "def candidate(x, embedding):",
      "    value = np.asarray(embedding, dtype=np.float64)",
      "    value = value / np.linalg.norm(value)",
      "    return {",
      "        'embedding': value, 'area': 0.09, 'area_ratio': 0.09,",
      "        'box': np.asarray([x, 0.2, 0.3, 0.3], dtype=np.float64),",
      "        'center': np.asarray([x + 0.15, 0.35], dtype=np.float64),",
      "    }",
      "template = np.asarray([1.0, 0.0], dtype=np.float64)",
      "frames = [[candidate(0.1, [0.8, 0.6])], [], [], [], [], [candidate(0.65, [1.0, 0.0])]]",
      "selected, ambiguous = module.track_output_identity(frames, template)",
      "print(json.dumps({'count': len(selected), 'ambiguous': ambiguous}))",
    ].join("\n"));

    expect(JSON.parse(output)).toEqual({ count: 1, ambiguous: 1 });
  });

  it("rejects contradictory reference identities and symlinked model inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-sface-snapshot-"));
    roots.push(root);
    const source = join(root, "model.onnx");
    const link = join(root, "model-link.onnx");
    await writeFile(source, "model");
    await symlink(source, link);
    const output = runPython([
      importAnalyzer,
      "same = [[np.asarray([1.0, 0.0])], [np.asarray([0.98, 0.2]) / np.linalg.norm([0.98, 0.2])]]",
      "different = [[np.asarray([1.0, 0.0])], [np.asarray([0.0, 1.0])]]",
      "_same_template, _same_scores, same_ok = module.build_reference_template(same)",
      "_different_template, _different_scores, different_ok = module.build_reference_template(different)",
      "symlink_rejected = False",
      "try:",
      "    module.snapshot_verified_file(module.Path(sys.argv[2]), module.Path(sys.argv[3]), 'Model')",
      "except RuntimeError:",
      "    symlink_rejected = True",
      "print(json.dumps({",
      "    'same': same_ok,",
      "    'different': different_ok,",
      "    'symlinkRejected': symlink_rejected,",
      "}))",
    ].join("\n"), link, join(root, "snapshot.onnx"));

    expect(JSON.parse(output)).toEqual({
      same: true,
      different: false,
      symlinkRejected: true,
    });
  });

  it("marks a multi-person reference video ambiguous and rejects oversized snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-sface-budget-"));
    roots.push(root);
    const oversized = join(root, "oversized.mp4");
    await writeFile(oversized, "x");
    await truncate(oversized, 2 * 1024 ** 3 + 1);
    const output = runPython([
      importAnalyzer,
      "def candidate(x, embedding):",
      "    value = np.asarray(embedding, dtype=np.float64)",
      "    value = value / np.linalg.norm(value)",
      "    return {",
      "        'embedding': value, 'area': 0.09, 'area_ratio': 0.09,",
      "        'box': np.asarray([x, 0.2, 0.3, 0.3], dtype=np.float64),",
      "        'center': np.asarray([x + 0.15, 0.35], dtype=np.float64),",
      "    }",
      "first = candidate(0.1, [1.0, 0.0])",
      "second = candidate(0.6, [0.0, 1.0])",
      "selected, ambiguous = module.track_reference_identity([[first, second], [first]], None)",
      "oversized_rejected = False",
      "try:",
      "    module.enforce_snapshot_budget([(module.Path(sys.argv[2]), 'Oversized')], module.Path(sys.argv[3]))",
      "except RuntimeError:",
      "    oversized_rejected = True",
      "print(json.dumps({",
      "    'selected': len(selected),",
      "    'ambiguous': ambiguous,",
      "    'oversizedRejected': oversized_rejected,",
      "}))",
    ].join("\n"), oversized, root);

    expect(JSON.parse(output)).toEqual({
      selected: 1,
      ambiguous: 1,
      oversizedRejected: true,
    });
  });
});
