import type { ICLoraProfile, PipelineMode } from "./pipelines.js";
import type { ProvenanceUpstreamContract } from "./provenance.js";

export const LTX25_WORKFLOW_REPOSITORY = "https://github.com/Lightricks/ComfyUI-LTXVideo";
export const LTX25_WORKFLOW_COMMIT = "15d09abb5a187a8dcaea2fc31fe51ee96e6c9d0d";
export const LTX25_WORKFLOW_ROOT = "example_workflows/2.5";
export const LTX25_WORKFLOW_README_SHA256 =
  "570c8fcd28e5fd7f83673a9581fdc1542cb955059e8464dbe199ec29ed6f96ec";

export type Ltx25WorkflowId =
  | "t2v-i2v-two-stage"
  | "t2v-i2v-single-stage"
  | "a2v-two-stage"
  | "t2a-single-stage"
  | "ic-lora-union-control"
  | "v2v-ic-lora"
  | "ic-lora-ingredients"
  | "ic-lora-motion-track"
  | "ic-lora-inpaint-two-stage"
  | "ic-lora-outpaint-two-stage";

export type Ltx25NativeBinding = {
  mode: PipelineMode;
  icLoraProfile?: ICLoraProfile;
};

export type Ltx25WorkflowCatalogEntry = {
  id: Ltx25WorkflowId;
  filename: string;
  sha256: string;
  stages: 1 | 2;
  spatialUpscale: boolean;
  recommendation: "baseline" | "control" | "specialty";
  nativeBinding: Ltx25NativeBinding | null;
  nativeStatus: "implemented-contract" | "implementation-required";
};

export const LTX25_WORKFLOW_CATALOG = [
  {
    id: "t2v-i2v-two-stage",
    filename: "LTX-2.5_T2V_I2V_Two_Stage_Distilled.json",
    sha256: "b8b8d79b5cb09519e828a3cd438348b492b448547f030ed7e1098ad86ea3010a",
    stages: 2,
    spatialUpscale: true,
    recommendation: "baseline",
    nativeBinding: { mode: "distilled" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "t2v-i2v-single-stage",
    filename: "LTX-2.5_T2V_I2V_Single_Stage_Distilled.json",
    sha256: "e264b203ec4b0ff1dfd448121c96ceb5d45dfe84b70fcac9a03e5bc700338f25",
    stages: 1,
    spatialUpscale: false,
    recommendation: "baseline",
    nativeBinding: { mode: "distilled" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "a2v-two-stage",
    filename: "LTX-2.5_A2V_Two_Stage_Distilled.json",
    sha256: "871b56bd602b9e3854b00f0454d48375fb2d08a9618d7be44dec0fe4faba04a3",
    stages: 2,
    spatialUpscale: true,
    recommendation: "specialty",
    nativeBinding: { mode: "image-audio-to-video" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "t2a-single-stage",
    filename: "LTX-2.5_T2A_Single_Stage_Distilled.json",
    sha256: "3fbb5fa88a261eba46b8901a6d0438c1583b4d910f7abf03447e74c437509c88",
    stages: 1,
    spatialUpscale: false,
    recommendation: "specialty",
    nativeBinding: { mode: "text-to-audio" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "ic-lora-union-control",
    filename: "LTX-2.5_ICLoRA_Union_Control_Distilled.json",
    sha256: "c41586a1426fc68a136eb958004aaa9e529fe78f401262b475fad3180558cfd7",
    stages: 1,
    spatialUpscale: false,
    recommendation: "control",
    nativeBinding: { mode: "ic-lora", icLoraProfile: "union-control" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "v2v-ic-lora",
    filename: "LTX-2.5_V2V_ICLoRA_Single_Stage_Distilled.json",
    sha256: "5880e5025bd0e2df391a8a64c642199b6a7d0924925a1c54a71f3ce06cbfd4ff",
    stages: 1,
    spatialUpscale: false,
    recommendation: "control",
    nativeBinding: { mode: "ic-lora", icLoraProfile: "v2v-instant-shave" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "ic-lora-ingredients",
    filename: "LTX-2.5_ICLoRA_Ingredients_Single_Stage_Distilled.json",
    sha256: "afb34052b0569ffaa7930bfa2c854798b8121ce72240306eb7f49724efbe1f72",
    stages: 1,
    spatialUpscale: false,
    recommendation: "control",
    nativeBinding: { mode: "ic-lora", icLoraProfile: "ingredients" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "ic-lora-motion-track",
    filename: "LTX-2.5_ICLoRA_Motion_Track_Distilled.json",
    sha256: "6ff1604c041771f9be6a375c27f5fcb5689ffe94194f56d188ce1d3c2e809ecd",
    stages: 1,
    spatialUpscale: false,
    recommendation: "control",
    nativeBinding: { mode: "ic-lora", icLoraProfile: "motion-track" },
    nativeStatus: "implemented-contract",
  },
  {
    id: "ic-lora-inpaint-two-stage",
    filename: "LTX-2.5_ICLoRA_Inpaint_Two_Stage_Distilled.json",
    sha256: "7c77db0895cf7efa7ec6563bbedadf70abbb1e12176b888e33db74affa2c92a0",
    stages: 2,
    spatialUpscale: true,
    recommendation: "specialty",
    nativeBinding: null,
    nativeStatus: "implementation-required",
  },
  {
    id: "ic-lora-outpaint-two-stage",
    filename: "LTX-2.5_ICLoRA_Outpaint_Two_Stage_Distilled.json",
    sha256: "572efd3720d0e805b862c0262b3064be5b63f073aeee62048535b11baad87396",
    stages: 2,
    spatialUpscale: true,
    recommendation: "specialty",
    nativeBinding: null,
    nativeStatus: "implementation-required",
  },
] as const satisfies readonly Ltx25WorkflowCatalogEntry[];

export function ltx25WorkflowContract(id: Ltx25WorkflowId): ProvenanceUpstreamContract {
  const entry = LTX25_WORKFLOW_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unbekannter LTX-2.5-Workflow: ${id}`);
  return {
    role: `official-workflow:ltx-2.5:${id}`,
    repository: LTX25_WORKFLOW_REPOSITORY,
    commit: LTX25_WORKFLOW_COMMIT,
    path: `${LTX25_WORKFLOW_ROOT}/${entry.filename}`,
    sha256: entry.sha256,
  };
}

export const LTX25_MODEL_REPOSITORY = "https://huggingface.co/Lightricks/LTX-2.5";
export const LTX25_MODEL_REVISION = "6c7e5e573ac1667efc83407806fe9b0b93730e60";

export const LTX25_TRANSFORMER_CANDIDATES = [
  {
    id: "bf16",
    path: "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    sizeBytes: 42_018_190_584,
    sha256: "31eb3cad89b9e54e99dd3baf286f70825ac4f6c660a70d9184d895be76d7bff4",
    nativeRuntimeStatus: "supported",
  },
  {
    id: "comfy-int8-convrot",
    path: "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    sizeBytes: 21_504_034_224,
    sha256: "c4279eeff115cbeaca494bd2183e7d768c38fe85a184dc6afbb7159157c44334",
    nativeRuntimeStatus: "blocked-comfy-format",
  },
  {
    id: "nvfp4",
    path: "diffusion_models/ltx-2.5-22b-distilled-transformer-nvfp4.safetensors",
    sizeBytes: 18_721_548_408,
    sha256: "4b94231e734c1950f8f6826cb8bd8715d94be5b3e04f8256ee060c5bc3886c30",
    nativeRuntimeStatus: "blocked-no-native-loader-proof",
  },
] as const;

export const LTX25_MODEL_COMPONENTS = {
  transformer: LTX25_TRANSFORMER_CANDIDATES[0],
  textEncoder: {
    path: "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    sizeBytes: 26_263_858_182,
    sha256: "ef7243612fdae7a75cb4d5cee9433e81380675fb6c213bd98ae74a9cd16561d1",
  },
  videoVaeDiffusion: {
    path: "vae/ltx-2.5-video-vae-bf16.safetensors",
    sizeBytes: 1_472_223_346,
    sha256: "847e14ca7f3355debca0cea4eaa24ac0fbcdf0061da054ac89ca638a869ddba3",
  },
  videoVaeConv: {
    path: "vae/ltx-2.5-video-vae-conv-bf16.safetensors",
    sizeBytes: 1_452_269_922,
    sha256: "685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d",
  },
  audioVae: {
    path: "vae/ltx-2.5-audio-vae-bf16.safetensors",
    sizeBytes: 364_866_540,
    sha256: "c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5",
  },
  spatialUpscaler: {
    path: "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    sizeBytes: 995_778_752,
    sha256: "eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8",
  },
  durationHead: {
    path: "model_patches/ltx-2.5-duration-head-bf16.safetensors",
    sizeBytes: 3_843_690,
    sha256: "2ec71e4206ed365d015f00c05a48caccfb0ee862986809d06ae376c09f5d9190",
  },
} as const;
