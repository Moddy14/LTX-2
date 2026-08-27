import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analysisPythonExecutable, appRoot } from "../server/config.js";

const converter = join(appRoot, "scripts", "convert-xlsr-phoneme-checkpoint.py");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pinned XLSR phoneme checkpoint converter", () => {
  it("pins the reviewed source and preserves the fail-closed conversion boundary", () => {
    const source = readFileSync(converter, "utf8");

    expect(source).toContain('MODEL_REVISION = "2c733782da5604684829819a5eb744c193fe9398"');
    expect(source).toContain(
      'SOURCE_WEIGHT_SHA256 = "04366b6c8d24099ef313cf02f0e58d26f5dddfda16edbfc8eb2c713d94a9f551"',
    );
    expect(source).toContain("torch.load(source_handle, map_location=\"cpu\", weights_only=True)");
    expect(source).toContain("second_sha256, source_after = _hash_open_file(source_handle)");
    expect(source).toContain('save_file(tensors, temporary_weight, metadata={"format": "pt"})');
    expect(source).toContain("safe_open(output_weight, framework=\"pt\", device=\"cpu\")");
    expect(source).toContain("Wav2Vec2Config.from_dict(config_value)");
    expect(source).toContain("Wav2Vec2ForCTC.from_pretrained(");
    expect(source).toContain("_tensor_content_sha256(sealed_tensor) != source_content_sha256");
    expect(source).toContain("_tensor_content_sha256(output_tensor) != expected_content[key]");
    expect(source).toContain('"tensorContentVerified": True');
    expect(source).toContain(
      '"stateKeyMigration": "deferred-to-pinned-Wav2Vec2ForCTC.from_pretrained"',
    );
    expect(source).toContain("_fsync_regular_path(output_weight)");
    expect(source).toContain("_rename_noreplace(parent_fd, staging.name, output_dir.name)");
    expect(source).toContain('((socket.AF_INET, "AF_INET"), (socket.AF_INET6, "AF_INET6"))');
    expect(source).toContain('raise ConversionError(f"{label} socket creation must be blocked")');
    expect(source).toContain("error.errno != errno.EAFNOSUPPORT");
    expect(source).toContain('raise ConversionError("Cgroup memory.swap.max must be zero")');
    expect(source).toContain("memory_max_raw == \"max\" or int(memory_max_raw) != EXPECTED_CGROUP_MEMORY_BYTES");
    expect(source).toContain("_verify_parent_path_identity(output_dir.parent, parent_stat)");
    expect(source).toContain("published-durability-unknown");
    expect(source).not.toContain("Wav2Vec2Config.from_pretrained(source_dir");
    expect(source).not.toContain("roundtrip_model.load_state_dict");
    expect(source).not.toContain('"createdAt"');
    expect(source).not.toContain("trust_remote_code");
  });

  it("offers a side-effect-free help contract", () => {
    const result = spawnSync(analysisPythonExecutable, ["-I", converter, "--help"], {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PYTHONNOUSERSITE: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--source-dir");
    expect(result.stdout).toContain("--output-dir");
  });

  it("refuses an ordinary process before creating a staging directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-xlsr-converter-boundary-"));
    roots.push(root);
    const sourceDir = join(root, "source");
    const outputDir = join(root, "sealed");
    await mkdir(sourceDir);

    const result = spawnSync(
      analysisPythonExecutable,
      ["-I", converter, "--source-dir", sourceDir, "--output-dir", outputDir],
      {
        cwd: appRoot,
        encoding: "utf8",
        env: {
          CUDA_VISIBLE_DEVICES: "",
          HF_HUB_OFFLINE: "1",
          PATH: process.env.PATH,
          PYTHONNOUSERSITE: "1",
          TRANSFORMERS_OFFLINE: "1",
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("AF_INET socket creation must be blocked");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("unit-checks deterministic JSON, tensor-content hashing, and legacy key migration", () => {
    const program = [
      "import json, runpy, torch",
      "from transformers.conversion_mapping import get_checkpoint_conversion_mapping",
      "from transformers.core_model_loading import WeightRenaming, WeightConverter, rename_source_key",
      `module = runpy.run_path(${JSON.stringify(converter)})`,
      "assert module['_canonical_json']({'b': 2, 'a': 1}) == module['_canonical_json']({'a': 1, 'b': 2})",
      "first = module['_tensor_content_sha256'](torch.tensor([1.0, 2.0], dtype=torch.float32))",
      "same = module['_tensor_content_sha256'](torch.tensor([1.0, 2.0], dtype=torch.float32))",
      "changed = module['_tensor_content_sha256'](torch.tensor([1.0, 2.5], dtype=torch.float32))",
      "assert first == same and first != changed",
      "legacy = get_checkpoint_conversion_mapping('legacy')",
      "renamings = [item for item in legacy if isinstance(item, WeightRenaming)]",
      "converters = [item for item in legacy if isinstance(item, WeightConverter)]",
      "mapped, source_pattern = rename_source_key('wav2vec2.encoder.pos_conv_embed.conv.weight_g', renamings, converters)",
      "assert source_pattern is None and mapped.endswith('parametrizations.weight.original0')",
      "try:",
      "  module['_strict_json_loads'](b'{\"a\":1,\"a\":2}', description='fixture')",
      "  raise AssertionError('duplicate key was accepted')",
      "except module['ConversionError']:",
      "  pass",
      "print(json.dumps({'digest': first, 'mapped': mapped}))",
    ].join("\n");
    const result = spawnSync(analysisPythonExecutable, ["-I", "-c", program], {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        CUDA_VISIBLE_DEVICES: "",
        HF_HUB_OFFLINE: "1",
        PATH: process.env.PATH,
        PYTHONNOUSERSITE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as { digest: string; mapped: string };
    expect(payload.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(payload.mapped).toContain("parametrizations.weight.original0");
  });
});
