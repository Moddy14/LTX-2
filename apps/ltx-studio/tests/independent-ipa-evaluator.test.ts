import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analysisPythonExecutable, appRoot } from "../server/config.js";

const runner = join(appRoot, "scripts", "independent_ipa_evaluator.py");

const offlineEnvironment = {
  CUDA_VISIBLE_DEVICES: "",
  HF_HUB_OFFLINE: "1",
  PATH: process.env.PATH,
  PYTHONNOUSERSITE: "1",
  TRANSFORMERS_OFFLINE: "1",
};

describe("independent IPA evaluator", () => {
  it("keeps model authority out of the target-independent request", () => {
    const source = readFileSync(runner, "utf8");

    expect(source).toContain(
      'APPROVED_MODEL_MANIFEST_SHA256 = "c401b4ecc2fe774a90e5c2acd6cfcb0bde5465e6c4672f2e5ef2574b47c264a0"',
    );
    expect(source).toContain(
      'APPROVED_MODEL_WEIGHT_SHA256 = "cd23ca5a57a252ee44abfea3b06d28020285015b83b8bb0e59293193ef8c2bd4"',
    );
    expect(source).toContain(
      'APPROVED_CONVERTER_SHA256 = "f76c51f1b535deb913a03ae940ce1c124e65c6f3d48228f35d2050f8a92fb1bd"',
    );
    expect(source).toContain('parser.add_argument("--model-directory"');
    expect(source).toContain('unknown_id = vocab["<unk>"]');
    expect(source).toContain('vocab_value.get("<unk>") != 3');
    expect(source).toContain('((socket.AF_INET, "AF_INET"), (socket.AF_INET6, "AF_INET6"))');
    expect(source).toContain("torch.use_deterministic_algorithms(True)");
    expect(source).toContain("Wav2Vec2ForCTC.from_pretrained(");
    expect(source).toContain('reader.metadata() != {"format": "pt"}');
    expect(source).toContain("_decode_ctc_runs(frame_ids, blank_id)");
    expect(source).not.toContain("AutoModel");
    expect(source).not.toContain("AutoProcessor");
    expect(source).not.toContain("trust_remote_code");
  });

  it("offers side-effect-free help", () => {
    const result = spawnSync(analysisPythonExecutable, ["-I", runner, "--help"], {
      cwd: appRoot,
      encoding: "utf8",
      env: offlineEnvironment,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--model-directory");
  });

  it("rejects target-bearing request fields before model access", () => {
    const request = {
      schemaVersion: "ltx-studio-independent-ipa-request.v1",
      audioPath: "/does/not/matter.wav",
      audioSha256: "a".repeat(64),
      targetText: "must never cross this boundary",
    };
    const result = spawnSync(
      analysisPythonExecutable,
      ["-I", runner, "--model-directory", "/does/not/matter"],
      {
        cwd: appRoot,
        encoding: "utf8",
        env: offlineEnvironment,
        input: JSON.stringify(request),
      },
    );

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.targetConditioned).toBe(false);
    expect(payload.error).toContain("target-independent schema");
  });

  it("collapses repeated IDs before removing blanks", () => {
    const program = [
      "import json, runpy",
      `module = runpy.run_path(${JSON.stringify(runner)})`,
      "print(json.dumps(module['_decode_ctc_runs']([5, 5, 0, 5, 5], 0)))",
    ].join("\n");
    const result = spawnSync(analysisPythonExecutable, ["-I", "-c", program], {
      cwd: appRoot,
      encoding: "utf8",
      env: offlineEnvironment,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      [5, 0, 2],
      [5, 3, 5],
    ]);
  });

  it("behaviorally rejects unprovisioned authority, duplicate JSON, NaN, and UID zero", () => {
    const program = [
      "import json, pathlib, runpy",
      `module = runpy.run_path(${JSON.stringify(runner)})`,
      "errors = []",
      "for payload in (b'{\"a\":1,\"a\":2}', b'{\"a\":NaN}'):",
      "  try:",
      "    module['_strict_json_loads'](payload, description='fixture')",
      "    raise AssertionError('invalid JSON was accepted')",
      "  except module['EvaluationError'] as error:",
      "    errors.append(str(error))",
      "authority_globals = module['_validate_model_directory'].__globals__",
      "authority_globals['APPROVED_MODEL_MANIFEST_SHA256'] = '__UNPROVISIONED__'",
      "authority_globals['APPROVED_MODEL_WEIGHT_SHA256'] = '__UNPROVISIONED__'",
      "authority_globals['APPROVED_CONVERTER_SHA256'] = '__UNPROVISIONED__'",
      "try:",
      "  module['_validate_model_directory'](pathlib.Path('/does/not/matter'))",
      "  raise AssertionError('unprovisioned model authority was accepted')",
      "except module['EvaluationError'] as error:",
      "  errors.append(str(error))",
      "module['os'].getuid = lambda: 0",
      "module['os'].geteuid = lambda: 0",
      "try:",
      "  module['_verify_execution_boundary']()",
      "  raise AssertionError('UID zero was accepted')",
      "except module['EvaluationError'] as error:",
      "  errors.append(str(error))",
      "print(json.dumps(errors))",
    ].join("\n");
    const result = spawnSync(analysisPythonExecutable, ["-I", "-c", program], {
      cwd: appRoot,
      encoding: "utf8",
      env: offlineEnvironment,
    });

    expect(result.status, result.stderr).toBe(0);
    const errors = JSON.parse(result.stdout) as string[];
    expect(errors).toHaveLength(4);
    expect(errors.some((value) => value.includes("Duplicate JSON key"))).toBe(true);
    expect(errors.some((value) => value.includes("Non-finite JSON number"))).toBe(true);
    expect(errors.some((value) => value.includes("not provisioned"))).toBe(true);
    expect(errors.some((value) => value.includes("non-root"))).toBe(true);
  });

  it("fails closed outside the approved systemd boundary", () => {
    const request = {
      schemaVersion: "ltx-studio-independent-ipa-request.v1",
      audioPath: "/does/not/matter.wav",
      audioSha256: "a".repeat(64),
    };
    const result = spawnSync(
      analysisPythonExecutable,
      ["-I", runner, "--model-directory", "/does/not/matter"],
      {
        cwd: appRoot,
        encoding: "utf8",
        env: offlineEnvironment,
        input: JSON.stringify(request),
      },
    );

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.error).toMatch(/(?:socket creation must be blocked|non-root DynamicUser)/u);
  });
});
