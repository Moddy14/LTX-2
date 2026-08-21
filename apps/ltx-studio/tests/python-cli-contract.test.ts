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
  "t2a_one_stage.py",
  "ic_lora.py",
  "inoutpaint.py",
  "flf2v.py",
  "a2vid_two_stage.py",
  "dubit.py",
  "retake.py",
] as const;

function source(relativePath: string): string {
  return readFileSync(resolve(pipelineRoot, relativePath), "utf8");
}

describe("Python CLI source contract", () => {
  it.each(pipelineFiles)("wires prompt enhancement in %s", (filename) => {
    expect(source(filename)).toContain("enhance_prompt=args.enhance_prompt");
  });

  it.each(pipelineFiles.filter((filename) => !["ti2vid_one_stage.py", "dubit.py", "t2a_one_stage.py"].includes(filename)))(
    "wires the VAE tiling switch in %s",
    (filename) => {
      expect(source(filename)).toContain("None if args.disable_tiling else");
    },
  );

  it("defines shared prompt, quantization, LoRA, and tiling flags", () => {
    const argsSource = source("utils/args.py");
    for (const flag of [
      "--enhance-prompt",
      "--disable-tiling",
      "--quantization",
      "--lora",
      "--gemma-lora",
      "--image",
    ]) {
      expect(argsSource).toContain(`"${flag}"`);
    }
  });

  it("keeps FLF2V on the official single-stage distilled contract", () => {
    const flfSource = source("flf2v.py");
    expect(flfSource).toContain("class FLF2VPipeline");
    expect(flfSource).toContain("DISTILLED_SIGMAS");
    expect(flfSource).toContain("image_conditionings_by_adding_guiding_latent");
    expect(flfSource).toContain("len(images) != 2");
    expect(flfSource).toContain("images[1].frame_idx != num_frames - 1");
    expect(flfSource).toContain("EulerAncestralDiffusionStep(eta=0.0, s_noise=1.0)");
    expect(flfSource).toContain("_official_flf_stepper()");
    expect(flfSource).toContain("euler_ancestral_denoising_loop");
    expect(flfSource).toContain("noise_seed=seed");
    expect(flfSource).not.toContain("VideoUpsampler");
    expect(flfSource).not.toContain("STAGE_2_DISTILLED_SIGMAS");
  });

  it("exposes the official distilled single-stage layout without requiring an upscaler", () => {
    const distilledSource = source("distilled.py");
    expect(distilledSource).toContain('"--skip-stage-2"');
    expect(distilledSource).toContain("skip_stage_2=args.skip_stage_2");
    expect(distilledSource).toContain("action.required = False");
    expect(distilledSource).toContain(
      'parser.error("--spatial-upsampler-path is required unless --skip-stage-2 is selected")',
    );
  });

  it("keeps T2A audio-only while matching the official fixed sampler", () => {
    const t2aSource = source("t2a_one_stage.py");
    expect(t2aSource).toContain("LTXAudioOnlyModelConfigurator");
    expect(t2aSource).toContain("LTXV_AUDIO_ONLY_MODEL_COMFY_RENAMING_MAP");
    expect(t2aSource).toContain("DISTILLED_SIGMAS");
    expect(t2aSource).toContain("EulerCfgPpDiffusionStep()");
    expect(t2aSource).toContain("euler_cfg_pp_denoising_loop");
    expect(t2aSource).toContain("force_uncond_pass=official_comfy_workflow");
    expect(t2aSource).toContain('"--official-comfy-workflow"');
    expect(t2aSource).toContain("encode_audio(audio=audio");
    expect(t2aSource).not.toContain("VideoDecoder");
  });

  it("uses the shared typed LoRA parser for Retake", () => {
    const retakeSource = source("retake.py");
    expect(retakeSource).toContain("video_editing_arg_parser(distilled=True)");
    expect(retakeSource).toContain("loras=tuple(args.lora) if args.lora else ()");
    expect(retakeSource).toContain("enhance_prompt=args.enhance_prompt");
  });

  it("supports both the official Comfy HQ and reproducible legacy LipDub CLI contracts", () => {
    const lipdubSource = source("dubit.py");
    const argsSource = source("utils/args.py");
    expect(argsSource).toContain("def dubit_arg_parser");
    expect(argsSource).toContain('"--reference-video"');
    expect(argsSource).toContain('"--pipeline-profile"');
    expect(argsSource).toContain('"--distilled-lora"');
    expect(argsSource).toContain('"--stage-2-seed"');
    expect(lipdubSource).toContain("len(args.lora) != 1");
    expect(lipdubSource).toContain("len(args.distilled_lora) != 1");
    expect(lipdubSource).toContain("stage_2_seed=args.stage_2_seed");
    expect(lipdubSource).not.toContain("num_frames=args.num_frames");
    expect(lipdubSource).not.toContain("frame_rate=args.frame_rate");
    expect(lipdubSource).not.toContain("negative_prompt=args.negative_prompt");
  });

  it("keeps ID-LoRA on the official reference-audio and identity-guidance contract", () => {
    const idLoraSource = source("id_lora.py");
    expect(idLoraSource).toContain('"--reference-audio-path"');
    expect(idLoraSource).toContain('"--id-lora"');
    expect(idLoraSource).toContain('"--identity-guidance-scale"');
    expect(idLoraSource).toContain("conditioned_video - no_reference_video");
    expect(idLoraSource).toContain("OFFICIAL_COMFY_STAGE_2_SIGMAS");
    expect(idLoraSource).toContain("OFFICIAL_COMFY_STAGE_2_SEED");
    expect(idLoraSource).toContain("noiser=stage_2_noiser");
    expect(idLoraSource).toContain("enhance_first_prompt=False");
    expect(idLoraSource).toContain('"--stage-1-image-strength"');
    expect(idLoraSource).toContain(
      "cap_image_conditioning_strength(images, stage_1_image_strength)",
    );
    expect(idLoraSource).not.toContain("--stage-2-image-strength");
  });

  it("wires IC-LoRA control preprocessing before native conditioning", () => {
    const icLoraSource = source("ic_lora.py");
    const icLoraUtilsSource = source("iclora_utils.py");
    expect(icLoraSource).toContain('"--control-preprocessor"');
    expect(icLoraSource).toContain('"--moge-model-path"');
    expect(icLoraSource).toContain('"--official-comfy-workflow"');
    expect(icLoraSource).toContain('"--official-comfy-sampler"');
    expect(icLoraSource).toContain('"--repeat-static-control"');
    expect(icLoraSource).toContain('"--freeze-control-audio"');
    expect(icLoraSource).toContain('"--checkpoint-path"');
    expect(icLoraSource).toContain("preprocess_control_video(");
    expect(icLoraSource).toContain("EulerAncestralDiffusionStep()");
    expect(icLoraSource).toContain("euler_ancestral_denoising_loop");
    expect(icLoraSource).toContain("EulerCfgPpDiffusionStep(");
    expect(icLoraSource).toContain("euler_cfg_pp_denoising_loop");
    expect(icLoraSource).toContain("force_uncond_pass=True");
    expect(icLoraSource).toContain("frozen=initial_audio_latent is not None");
    expect(icLoraSource).toContain("vae_encode_audio(decoded_audio, enc, None)");
    expect(icLoraUtilsSource).toContain("repeat_static_reference_video(video, num_frames)");
  });

  it("exposes exact single-output control for the native HDR pipeline", () => {
    const hdrSource = source("hdr_ic_lora.py");
    expect(hdrSource).toContain('"--output-path"');
    expect(hdrSource).toContain('"--width"');
    expect(hdrSource).toContain('"--height"');
    expect(hdrSource).toContain('"--frame-rate"');
    expect(hdrSource).toContain("output_path=Path(args.output_path)");
    expect(hdrSource).toContain("save_exr_tensor");
    expect(hdrSource).toContain("encode_exr_sequence_to_mp4");
  });

  it("keeps In-/Outpainting on the published two-stage preservation contract", () => {
    const inoutSource = source("inoutpaint.py");
    const blendSource = source("utils/inpaint.py");
    expect(inoutSource).toContain('"--edit-mode"');
    expect(inoutSource).toContain('"--source-video"');
    expect(inoutSource).toContain('"--mask-video"');
    expect(inoutSource).toContain("DISTILLED_SIGMAS");
    expect(inoutSource).toContain("STAGE_2_SIGMAS = torch.tensor([0.725, 0.421875, 0.0])");
    expect(inoutSource).toContain("EulerCfgPpDiffusionStep(eta=1.0, s_noise=1.0)");
    expect(inoutSource).toContain("EulerCfgPpDiffusionStep(eta=0.0, s_noise=0.0)");
    expect(inoutSource).toContain("frozen=initial_audio_latent is not None");
    expect(inoutSource).toContain("mask_low_res_dilation=6 if mode == \"inpaint\" else 2");
    expect(blendSource).toContain("_GREEN = (2 * 102 / 255 - 1, 1.0, -1.0)");
    expect(blendSource).toContain("build_laplacian_pyramid");
  });

  it("wires the official fixed workflow into T2V/I2V and IA2V", () => {
    for (const filename of ["ti2vid_two_stages.py", "a2vid_two_stage.py"]) {
      const pipelineSource = source(filename);
      expect(pipelineSource).toContain('"--official-comfy-workflow"');
      expect(pipelineSource).toContain("DISTILLED_SIGMAS");
      expect(pipelineSource).toContain("OFFICIAL_COMFY_STAGE_2_SIGMAS");
      expect(pipelineSource).toContain("OFFICIAL_COMFY_STAGE_2_SEED");
      expect(pipelineSource).toContain("noiser=stage_2_noiser");
      expect(pipelineSource).toContain("official_comfy_workflow");
      expect(pipelineSource).toContain(
        "official_comfy_prompt_enhancement=official_comfy_workflow",
      );
      expect(pipelineSource).toContain("cap_image_conditioning_strength(images, 0.7)");
      expect(pipelineSource).toContain("images=stage_1_images");
      expect(pipelineSource).toContain("images=images");
      expect(pipelineSource.indexOf("images=stage_1_images")).toBeLessThan(
        pipelineSource.lastIndexOf("images=images"),
      );
    }
    expect(source("ic_lora.py")).toContain(
      "official_comfy_prompt_enhancement=official_comfy_workflow",
    );
  });

  it("pins the current official ComfyUI refinement schedule exactly", () => {
    const constantsSource = source("utils/constants.py");
    expect(constantsSource).toContain(
      "OFFICIAL_COMFY_STAGE_2_SIGMA_VALUES = [0.85, 0.725, 0.421875, 0.0]",
    );
    expect(constantsSource).toContain("OFFICIAL_COMFY_STAGE_2_SEED = 42");
  });
});
