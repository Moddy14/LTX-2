import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");
const pipelineRoot = resolve(repoRoot, "packages/ltx-pipelines/src/ltx_pipelines");
const pipelineFiles = [
  "ti2vid_two_stages.py",
  "ti2vid_two_stages_hq.py",
  "ti2vid_one_stage.py",
  "distilled.py",
  "ic_lora.py",
  "keyframe_interpolation.py",
  "a2vid_two_stage.py",
  "retake.py",
] as const;

function source(relativePath: string): string {
  return readFileSync(resolve(pipelineRoot, relativePath), "utf8");
}

describe("Python CLI source contract", () => {
  it.each(pipelineFiles)("wires prompt enhancement in %s", (filename) => {
    expect(source(filename)).toContain("enhance_prompt=args.enhance_prompt");
  });

  it.each(pipelineFiles.filter((filename) => filename !== "ti2vid_one_stage.py"))(
    "wires the VAE tiling switch in %s",
    (filename) => {
      expect(source(filename)).toContain("None if args.disable_tiling else TilingConfig.default()");
    },
  );

  it("defines shared prompt, quantization, LoRA, and tiling flags", () => {
    const argsSource = source("utils/args.py");
    for (const flag of ["--enhance-prompt", "--disable-tiling", "--quantization", "--lora", "--image"]) {
      expect(argsSource).toContain(`"${flag}"`);
    }
  });

  it("uses the shared typed LoRA parser for Retake", () => {
    const retakeSource = source("retake.py");
    expect(retakeSource).toContain("default_1_stage_arg_parser(params=params)");
    expect(retakeSource).toContain("loras=tuple(args.lora) if args.lora else ()");
    expect(retakeSource).toContain("regenerate_video=not args.no_regenerate_video");
    expect(retakeSource).toContain("regenerate_audio=not args.no_regenerate_audio");
  });
});
