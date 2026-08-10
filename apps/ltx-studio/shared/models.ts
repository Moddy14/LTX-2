import {
  hasDialogueIntent,
  isAudioConditionedMode,
  needsGemmaAbliteratedLoraForRequest,
  usesOfficialComfyLipDub,
  type GenerationRequest,
} from "./pipelines.js";

export type ModelKind =
  | "checkpoint"
  | "distilled-checkpoint"
  | "spatial-upscaler"
  | "lora"
  | "amax"
  | "gemma"
  | "geometry";

export type RecommendedModelAsset = {
  id:
    | "ltx23-dev-checkpoint"
    | "ltx23-dev-fp8-checkpoint"
    | "ltx23-distilled-fp8-checkpoint"
    | "ltx23-gemma"
    | "ltx23-gemma-abliterated-lora"
    | "ltx23-comfy-distilled-lora"
    | "ltx23-distilled-lora"
    | "ltx23-spatial-upscaler"
    | "ltx23-union-control-lora"
    | "ltx23-ingredients-lora"
    | "ltx23-motion-track-lora"
    | "ltx23-pixel-upscaler-x4-lora"
    | "ltx23-instant-shave-lora"
    | "ltx23-inoutpaint-lora"
    | "ltx23-hdr-lora"
    | "ltx23-hdr-scene-embeddings"
    | "ltx23-moge"
    | "ltx23-id-lora-talkvid"
    | "lipdub-lora"
    | "lipdub-distilled-checkpoint"
    | "lipdub-spatial-upscaler";
  kind: ModelKind;
  label: string;
  repoId: string;
  filename: string;
  localPath: string;
  present: boolean;
  access: "public" | "gated";
  expectedSizeBytes?: number;
  expectedSha256?: string;
  expectedContents?: readonly {
    relativePath: string;
    expectedSizeBytes: number;
    expectedSha256: string;
  }[];
  actualSha256?: string | null;
  integrity: "verified" | "missing" | "unverified" | "size-mismatch" | "sha256-mismatch";
};

export type ModelInventoryItem = {
  kind: ModelKind;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  precision: "bf16" | "fp8" | "unknown";
};

export type ModelInventory = {
  roots: string[];
  scannedAt: string;
  truncated: boolean;
  errors: string[];
  items: ModelInventoryItem[];
  recommendations: RecommendedModelAsset[];
};

export const recommendedModelAssets = [
  {
    id: "ltx23-dev-checkpoint",
    kind: "checkpoint",
    label: "LTX-2.3 Dev Checkpoint",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-22b-dev.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-dev.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 46_149_344_974,
    expectedSha256: "7ab7225325bc403448ea84b6db2269811a880e5118cd2ee2b6282a93d585016f",
    integrity: "missing",
  },
  {
    id: "ltx23-dev-fp8-checkpoint",
    kind: "checkpoint",
    label: "LTX-2.3 Dev FP8 (ComfyUI Workflow)",
    repoId: "Lightricks/LTX-2.3-fp8",
    filename: "ltx-2.3-22b-dev-fp8.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-fp8/ltx-2.3-22b-dev-fp8.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 29_145_431_166,
    expectedSha256: "28606c5b5a06ce56f896d4dfcb20f212739e07a68fbe48e53638188449d26450",
    integrity: "missing",
  },
  {
    id: "ltx23-distilled-fp8-checkpoint",
    kind: "distilled-checkpoint",
    label: "LTX-2.3 Distilled FP8 (ComfyUI Workflow)",
    repoId: "Lightricks/LTX-2.3-fp8",
    filename: "ltx-2.3-22b-distilled-fp8.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-fp8/ltx-2.3-22b-distilled-fp8.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 29_531_884_062,
    expectedSha256: "d9646b6f2d5c42d337b23671634c43bfeece6989644f51b4a3aa088465ccd3b2",
    integrity: "missing",
  },
  {
    id: "ltx23-gemma",
    kind: "gemma",
    label: "LTX-2.3 Gemma QAT Q4",
    repoId: "google/gemma-3-12b-it-qat-q4_0-unquantized",
    filename: "google__gemma-3-12b-it-qat-q4_0-unquantized",
    localPath:
      "/home/moddy/LTX-2.3-max/google__gemma-3-12b-it-qat-q4_0-unquantized",
    present: false,
    access: "public",
    expectedContents: [
      {
        relativePath: "config.json",
        expectedSizeBytes: 1_611,
        expectedSha256: "72ba569f583e58bfd39e192d859bc0c0905c3d08b2d0d4e520b7f8543fc87cdc",
      },
      {
        relativePath: "preprocessor_config.json",
        expectedSizeBytes: 570,
        expectedSha256: "f688d6bb20c5017601c4011de7ca656da8485b540b05013efdaf986c0fcc918d",
      },
      {
        relativePath: "tokenizer.json",
        expectedSizeBytes: 33_384_570,
        expectedSha256: "7d4046bf0505a327dd5a0abbb427ecd4fc82f99c2ceaa170bc61ecde12809b0c",
      },
      {
        relativePath: "tokenizer.model",
        expectedSizeBytes: 4_689_074,
        expectedSha256: "1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c",
      },
      {
        relativePath: "tokenizer_config.json",
        expectedSizeBytes: 1_157_001,
        expectedSha256: "31e860fdfa360fa5aa58fe93252799facde5a52d1352f77d45978ab2a7e9eeb1",
      },
      {
        relativePath: "chat_template.json",
        expectedSizeBytes: 1_615,
        expectedSha256: "fe16baf728db49457cde32802cd7efc0ac8a7a9877dbe22fe3322b2d9dc6ccd9",
      },
      {
        relativePath: "added_tokens.json",
        expectedSizeBytes: 35,
        expectedSha256: "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946",
      },
      {
        relativePath: "generation_config.json",
        expectedSizeBytes: 173,
        expectedSha256: "13da6aad6852a008419f46df754b3452fc96387a4213c25811509d474e5a4776",
      },
      {
        relativePath: "processor_config.json",
        expectedSizeBytes: 70,
        expectedSha256: "3ffd5f11778dc73e2b69b3c00535e4121e1badf7018136263cd17b5b34fbaa53",
      },
      {
        relativePath: "special_tokens_map.json",
        expectedSizeBytes: 662,
        expectedSha256: "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397",
      },
      {
        relativePath: "model.safetensors.index.json",
        expectedSizeBytes: 108_605,
        expectedSha256: "788cc42a1a92835df62d9a3791f47105f63504c7c404637a73288e9b11bc7b82",
      },
      {
        relativePath: "model-00001-of-00005.safetensors",
        expectedSizeBytes: 4_979_902_192,
        expectedSha256: "e6fb899db428481aafb45a20130457df6e247e7cb03b7d9f01ee4bc2a9a08138",
      },
      {
        relativePath: "model-00002-of-00005.safetensors",
        expectedSizeBytes: 4_931_296_592,
        expectedSha256: "d251e7fe9799d529405ddb61705a44cd700bd30a8b66a8d44ae26ddf8365dbc6",
      },
      {
        relativePath: "model-00003-of-00005.safetensors",
        expectedSizeBytes: 4_931_296_656,
        expectedSha256: "0684ef801385f0669a0b3e4ab160c50877efdbfa40eb97788595985de2743e78",
      },
      {
        relativePath: "model-00004-of-00005.safetensors",
        expectedSizeBytes: 4_931_296_656,
        expectedSha256: "b4b964e6526f81ccfa625c900b72ce92d5e0fd2debb75998763038ad06b9c541",
      },
      {
        relativePath: "model-00005-of-00005.safetensors",
        expectedSizeBytes: 4_601_000_928,
        expectedSha256: "4ef2de8f93e165b4e02425769fc566000b0674256ef0c3a27b23a0d45eb12088",
      },
    ],
    integrity: "missing",
  },
  {
    id: "ltx23-gemma-abliterated-lora",
    kind: "lora",
    label: "Gemma 3 12B Abliterated LoRA",
    repoId: "Comfy-Org/ltx-2",
    filename: "gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Comfy-Org__ltx-2/split_files/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 628_203_616,
    expectedSha256: "87bcabeac9bec9f374232b5122d6511c2b2112d479e50176149e944b3712eb4a",
    integrity: "missing",
  },
  {
    id: "ltx23-comfy-distilled-lora",
    kind: "lora",
    label: "LTX-2.3 Comfy Distilled LoRA 1.1",
    repoId: "Comfy-Org/ltx-2.3",
    filename: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Comfy-Org__ltx-2.3/split_files/loras/"
      + "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 2_741_024_390,
    expectedSha256: "31e0c0195fb841bf31af78e8b60858f489e87ddcea4a5239abc80943da65e3ac",
    integrity: "missing",
  },
  {
    id: "ltx23-distilled-lora",
    kind: "lora",
    label: "LTX-2.3 Distilled LoRA 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 7_605_507_256,
    expectedSha256: "f5d4953f3386197a4b4f5abdb17616ff256171e8075c111d6e7d2dfa6e823b3a",
    integrity: "missing",
  },
  {
    id: "ltx23-spatial-upscaler",
    kind: "spatial-upscaler",
    label: "LTX-2.3 Spatial Upscaler x2 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 995_743_560,
    expectedSha256: "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed",
    integrity: "missing",
  },
  {
    id: "ltx23-moge",
    kind: "geometry",
    label: "MoGe 2 ViT-L Normal FP16",
    repoId: "Comfy-Org/MoGe",
    filename: "moge_2_vitl_normal_fp16.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Comfy-Org__MoGe/geometry_estimation/moge_2_vitl_normal_fp16.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 661_859_924,
    expectedSha256: "cb1a692d03235671e959e81360d7b4d9f44aefadb1f852d6ca6aa17799d5e31f",
    integrity: "missing",
  },
  {
    id: "ltx23-union-control-lora",
    kind: "lora",
    label: "LTX-2.3 Union-Control IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control",
    filename: "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Union-Control/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 654_465_352,
    expectedSha256: "a1b888a87f661d27f08b394ae559e8e1050be33900bcc36a5cdf659e48f88d18",
    integrity: "missing",
  },
  {
    id: "ltx23-ingredients-lora",
    kind: "lora",
    label: "LTX-2.3 Ingredients IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients",
    filename: "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Ingredients/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 1_308_778_338,
    expectedSha256: "515e4e139001ac6282357a5b35372e42e98b3affd5fcc886a52242abeed19559",
    integrity: "missing",
  },
  {
    id: "ltx23-motion-track-lora",
    kind: "lora",
    label: "LTX-2.3 Motion-Track IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-Motion-Track-Control",
    filename: "ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Motion-Track-Control/ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 327_309_314,
    expectedSha256: "e279807ee3aa3db1ce60188d665ff83342860367dcd6bac19f8bd5a99a9e1dca",
    integrity: "missing",
  },
  {
    id: "ltx23-pixel-upscaler-x4-lora",
    kind: "lora",
    label: "LTX-2.3 Pixel Spatial Upscaler x4 IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler",
    filename: "ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x4-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler/ltx-2.3-22b-ic-lora-pixel-spatial-upscaler-x4-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 654_465_286,
    expectedSha256: "5b6370c3cc3a9a773f3655a411fd8ea4b47f4237bd2288a35b3291e2a33840f5",
    integrity: "missing",
  },
  {
    id: "ltx23-instant-shave-lora",
    kind: "lora",
    label: "LTX-2.3 Instant-Shave V2V IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-Instant-Shave",
    filename: "ltx-2.3-22b-ic-lora-instant-shave-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-Instant-Shave/ltx-2.3-22b-ic-lora-instant-shave-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 654_465_349,
    expectedSha256: "04231f1befeda653ab98081dd0f58114b9bc71782cdc687239a1610a39a9b0a2",
    integrity: "missing",
  },
  {
    id: "ltx23-inoutpaint-lora",
    kind: "lora",
    label: "LTX-2.3 In-/Outpainting IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-In-Outpainting",
    filename: "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-In-Outpainting/ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 1_308_778_338,
    expectedSha256: "73dd0841c0d4f0eb26fb1f017781b841b2752021944ac5ecefe57917f6dae6b5",
    integrity: "missing",
  },
  {
    id: "ltx23-hdr-lora",
    kind: "lora",
    label: "LTX-2.3 HDR IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-HDR",
    filename: "ltx-2.3-22b-ic-lora-hdr-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-HDR/ltx-2.3-22b-ic-lora-hdr-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 327_309_312,
    expectedSha256: "c56bfa0f2e4461a8b2f318f494c61c5bf97f462f2220e31ece93ea7851ca871e",
    integrity: "missing",
  },
  {
    id: "ltx23-hdr-scene-embeddings",
    kind: "lora",
    label: "LTX-2.3 HDR Szenen-Embeddings",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-HDR",
    filename: "ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-HDR/ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 12_583_096,
    expectedSha256: "78bffa6049bae2649a4365ec8769db88052c21348d643e8fc1ce6d483d994c5b",
    integrity: "missing",
  },
  {
    id: "ltx23-id-lora-talkvid",
    kind: "lora",
    label: "LTX-2.3 ID-LoRA TalkVid",
    repoId: "Comfy-Org/ltx-2.3",
    filename: "ltx-2.3-id-lora-talkvid-3k.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Comfy-Org__ltx-2.3/split_files/loras/ltx-2.3-id-lora-talkvid-3k.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 1_157_884_304,
    expectedSha256: "e5af73441743b4852f228b03e444888dff3da80d2666033af2367ab7bda6d8b9",
    integrity: "missing",
  },
  {
    id: "lipdub-lora",
    kind: "lora",
    label: "LipDub IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-LipDub",
    filename: "ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-LipDub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 2_466_665_072,
    expectedSha256: "fc415b12cb639e78511bc264f85080c2f7b188e334c1d9fade76b310e2bc419c",
    integrity: "missing",
  },
  {
    id: "lipdub-distilled-checkpoint",
    kind: "distilled-checkpoint",
    label: "LipDub Distilled Checkpoint 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-22b-distilled-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 46_149_345_334,
    expectedSha256: "b33b7fe4bbfe084f484be4aaf90b0f1d95dca20d403ac4c0e037eb8c4f0af7cc",
    integrity: "missing",
  },
  {
    id: "lipdub-spatial-upscaler",
    kind: "spatial-upscaler",
    label: "LipDub Spatial Upscaler x2 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 995_743_560,
    expectedSha256: "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed",
    integrity: "missing",
  },
] as const satisfies readonly RecommendedModelAsset[];

export function recommendedModelAsset(
  id: RecommendedModelAsset["id"],
): (typeof recommendedModelAssets)[number] {
  const asset = recommendedModelAssets.find((candidate) => candidate.id === id);
  if (!asset) throw new Error(`Unbekanntes empfohlenes Modellasset: ${id}`);
  return asset;
}

export function usesOfficialSpeechStack(request: GenerationRequest): boolean {
  return isAudioConditionedMode(request.mode)
    || request.mode === "id-lora"
    || request.mode === "text-to-audio"
    || hasDialogueIntent(request);
}

function usesDocumentedLtx23Workflow(request: GenerationRequest): boolean {
  return needsGemmaAbliteratedLoraForRequest(request)
    || request.mode === "ic-lora"
    || request.mode === "keyframes"
    || request.mode === "id-lora"
    || request.mode === "text-to-audio";
}

export function documentedLtx23CheckpointAssetId(
  request: GenerationRequest,
): RecommendedModelAsset["id"] | null {
  if (["two-stage", "two-stage-hq", "image-audio-to-video", "id-lora"].includes(request.mode)) {
    return "ltx23-dev-fp8-checkpoint";
  }
  if (request.mode === "keyframes") {
    return "ltx23-distilled-fp8-checkpoint";
  }
  if (request.mode === "ic-lora") {
    return request.icLora.profile === "union-control"
      ? "ltx23-distilled-fp8-checkpoint"
      : "ltx23-dev-checkpoint";
  }
  if (request.mode === "text-to-audio") {
    return "ltx23-dev-checkpoint";
  }
  return null;
}

export function documentedLtx23DistilledLoraAssetId(
  request: GenerationRequest,
): RecommendedModelAsset["id"] {
  return ["two-stage", "image-audio-to-video", "id-lora"].includes(request.mode)
    ? "ltx23-comfy-distilled-lora"
    : "ltx23-distilled-lora";
}

export function icLoraModelAssetId(
  request: Pick<GenerationRequest, "icLora">,
): RecommendedModelAsset["id"] {
  switch (request.icLora.profile) {
    case "ingredients":
      return "ltx23-ingredients-lora";
    case "motion-track":
      return "ltx23-motion-track-lora";
    case "pixel-upscaler":
      return "ltx23-pixel-upscaler-x4-lora";
    case "v2v-instant-shave":
      return "ltx23-instant-shave-lora";
    case "inpainting":
    case "outpainting":
      return "ltx23-inoutpaint-lora";
    case "hdr":
      return "ltx23-hdr-lora";
    default:
      return "ltx23-union-control-lora";
  }
}

export function requiredOfficialSpeechAssetIds(
  request: GenerationRequest,
): RecommendedModelAsset["id"][] {
  if (request.mode === "ic-lora" && request.icLora.profile === "hdr") {
    return [
      "lipdub-distilled-checkpoint",
      "ltx23-spatial-upscaler",
      "ltx23-hdr-lora",
      "ltx23-hdr-scene-embeddings",
    ];
  }
  const controlAssets = request.mode === "ic-lora"
    ? [
        icLoraModelAssetId(request),
        ...(request.icLora.profile === "union-control" && request.icLora.controlType === "depth"
          ? ["ltx23-moge" as const]
          : []),
      ]
    : request.mode === "id-lora"
      ? ["ltx23-id-lora-talkvid" as const]
      : [];
  const gemmaLoraAssets = needsGemmaAbliteratedLoraForRequest(request)
    ? ["ltx23-gemma-abliterated-lora" as const]
    : [];
  if (!usesOfficialSpeechStack(request) && !usesDocumentedLtx23Workflow(request)) {
    return [...gemmaLoraAssets, ...controlAssets];
  }
  const officialComfyLipDub = usesOfficialComfyLipDub(request);
  const nativeUnionControl = request.mode === "ic-lora" && request.icLora.profile === "union-control";
  const usesDistilledCheckpoint = ["distilled", "keyframes"].includes(request.mode)
    || nativeUnionControl
    || (request.mode === "lipdub" && !officialComfyLipDub)
    || (request.mode === "retake" && request.retake.distilled);
  const documentedCheckpoint = documentedLtx23CheckpointAssetId(request);
  return [
    "ltx23-gemma",
    documentedCheckpoint
      ?? (usesDistilledCheckpoint ? "lipdub-distilled-checkpoint" : "ltx23-dev-checkpoint"),
    ...(!["one-stage", "ic-lora", "keyframes", "retake", "text-to-audio"].includes(request.mode)
      ? [request.mode === "lipdub" ? "lipdub-spatial-upscaler" as const : "ltx23-spatial-upscaler" as const]
      : []),
    ...(["two-stage", "two-stage-hq", "image-audio-to-video", "audio-to-video", "id-lora", "text-to-audio"].includes(request.mode)
      || (request.mode === "ic-lora" && request.icLora.profile !== "union-control")
      || officialComfyLipDub
      ? [documentedLtx23DistilledLoraAssetId(request)]
      : []),
    ...gemmaLoraAssets,
    ...(request.mode === "lipdub" ? ["lipdub-lora" as const] : []),
    ...controlAssets,
  ];
}

export function withOfficialSpeechModelPaths(request: GenerationRequest): GenerationRequest {
  if (!usesOfficialSpeechStack(request) && !usesDocumentedLtx23Workflow(request)) return request;
  const officialComfyLipDub = usesOfficialComfyLipDub(request);
  const hdrICLora = request.mode === "ic-lora" && request.icLora.profile === "hdr";
  const nativeUnionControl = request.mode === "ic-lora" && request.icLora.profile === "union-control";
  const usesDistilledCheckpoint = ["distilled", "keyframes"].includes(request.mode)
    || hdrICLora
    || nativeUnionControl
    || (request.mode === "lipdub" && !officialComfyLipDub)
    || (request.mode === "retake" && request.retake.distilled);
  const documentedCheckpoint = hdrICLora
    ? "lipdub-distilled-checkpoint" as const
    : documentedLtx23CheckpointAssetId(request);
  const checkpointAsset = recommendedModelAsset(
    documentedCheckpoint
      ?? (usesDistilledCheckpoint ? "lipdub-distilled-checkpoint" : "ltx23-dev-checkpoint"),
  );
  return {
    ...request,
    enhancePrompt: ["id-lora", "keyframes", "lipdub", "ic-lora"].includes(request.mode) || hasDialogueIntent(request)
      ? false
      : request.enhancePrompt,
    models: {
      ...request.models,
      checkpointPath: usesDistilledCheckpoint
        ? request.models.checkpointPath
        : checkpointAsset.localPath,
      distilledCheckpointPath: usesDistilledCheckpoint
        ? checkpointAsset.localPath
        : request.models.distilledCheckpointPath,
      gemmaRoot: recommendedModelAsset("ltx23-gemma").localPath,
      gemmaLora: {
        ...request.models.gemmaLora,
        path: needsGemmaAbliteratedLoraForRequest(request)
          ? recommendedModelAsset("ltx23-gemma-abliterated-lora").localPath
          : request.models.gemmaLora.path,
      },
      spatialUpscalerPath: hdrICLora
        ? recommendedModelAsset("ltx23-spatial-upscaler").localPath
        : !["one-stage", "ic-lora", "keyframes", "retake", "text-to-audio"].includes(request.mode)
        ? recommendedModelAsset(
          request.mode === "lipdub" ? "lipdub-spatial-upscaler" : "ltx23-spatial-upscaler",
        ).localPath
        : request.models.spatialUpscalerPath,
      distilledLora: {
        ...request.models.distilledLora,
        path: ((["two-stage", "two-stage-hq", "image-audio-to-video", "audio-to-video", "id-lora", "text-to-audio"].includes(request.mode)
          || (request.mode === "ic-lora" && !nativeUnionControl))
          && !hdrICLora) || officialComfyLipDub
          ? recommendedModelAsset(documentedLtx23DistilledLoraAssetId(request)).localPath
          : request.models.distilledLora.path,
        strength: (["two-stage", "image-audio-to-video", "text-to-audio"].includes(request.mode)
          || (request.mode === "ic-lora" && !hdrICLora && !nativeUnionControl)) || officialComfyLipDub
          ? 0.5
          : request.models.distilledLora.strength,
      },
    },
    quantization: request.mode === "ic-lora" && !hdrICLora && !nativeUnionControl
      ? { ...request.quantization, mode: "none" }
      : documentedCheckpoint?.includes("fp8")
      ? { ...request.quantization, mode: "fp8-scaled-mm" }
      : request.mode === "text-to-audio"
        ? { ...request.quantization, mode: "fp8-cast" }
        : request.quantization,
    lipDub: {
      ...request.lipDub,
      lora: {
        ...request.lipDub.lora,
        path: request.mode === "lipdub"
          ? recommendedModelAsset("lipdub-lora").localPath
          : request.lipDub.lora.path,
      },
    },
    icLora: {
      ...request.icLora,
      hdrTextEmbeddingsPath: hdrICLora
        ? recommendedModelAsset("ltx23-hdr-scene-embeddings").localPath
        : request.icLora.hdrTextEmbeddingsPath,
      mogeModelPath: request.mode === "ic-lora"
        && request.icLora.profile === "union-control"
        && request.icLora.controlType === "depth"
        ? recommendedModelAsset("ltx23-moge").localPath
        : request.icLora.mogeModelPath,
      lora: {
        ...request.icLora.lora,
        path: request.mode === "ic-lora"
          ? recommendedModelAsset(icLoraModelAssetId(request)).localPath
          : request.icLora.lora.path,
      },
    },
    idLora: {
      ...request.idLora,
      lora: {
        ...request.idLora.lora,
        path: request.mode === "id-lora"
          ? recommendedModelAsset("ltx23-id-lora-talkvid").localPath
          : request.idLora.lora.path,
      },
    },
  };
}

export function withDiscoveredModelDefaults(
  request: GenerationRequest,
  inventory: ModelInventory,
): GenerationRequest {
  if (usesOfficialSpeechStack(request)) {
    return withOfficialSpeechModelPaths(request);
  }
  if (usesDocumentedLtx23Workflow(request)) {
    const official = withOfficialSpeechModelPaths(request);
    const nativeUnionControl = request.mode === "ic-lora" && request.icLora.profile === "union-control";
    return {
      ...official,
      models: {
        ...official.models,
        checkpointPath: request.models.checkpointPath || official.models.checkpointPath,
        distilledCheckpointPath:
          nativeUnionControl
            ? official.models.distilledCheckpointPath
            : request.models.distilledCheckpointPath || official.models.distilledCheckpointPath,
        gemmaRoot: request.models.gemmaRoot || official.models.gemmaRoot,
        gemmaLora: {
          ...official.models.gemmaLora,
          path: request.models.gemmaLora.path || official.models.gemmaLora.path,
        },
        spatialUpscalerPath:
          request.models.spatialUpscalerPath || official.models.spatialUpscalerPath,
        distilledLora: {
          ...official.models.distilledLora,
          path: request.models.distilledLora.path || official.models.distilledLora.path,
        },
      },
    };
  }
  const find = (kind: ModelKind, predicate: (name: string) => boolean = () => true) =>
    inventory.items.find((item) => item.kind === kind && predicate(item.name.toLowerCase()))?.path ?? "";
  const recommended = (id: RecommendedModelAsset["id"]) => {
    const asset = inventory.recommendations.find((item) => item.id === id && item.present);
    return asset?.localPath ?? "";
  };
  const officialUpscaler = request.mode === "lipdub"
    ? recommended("lipdub-spatial-upscaler")
    : recommended("ltx23-spatial-upscaler");
  const officialCheckpoint = recommended("ltx23-dev-checkpoint");
  const officialDistilledCheckpoint = recommended("lipdub-distilled-checkpoint");
  const officialGemma = recommended("ltx23-gemma");
  const officialDistilledLora = recommended("ltx23-distilled-lora");
  const officialLipDubLora = recommended("lipdub-lora");
  const usesDistilledCheckpoint = ["distilled", "ic-lora", "keyframes", "lipdub"].includes(request.mode)
    || (request.mode === "retake" && request.retake.distilled);
  const choose = (current: string, official: string, fallback: () => string) =>
    current || official || fallback();

  return {
    ...request,
    enhancePrompt: request.enhancePrompt,
    models: {
      ...request.models,
      checkpointPath: choose(
        request.models.checkpointPath,
        !usesDistilledCheckpoint ? officialCheckpoint : "",
        () => find("checkpoint", (name) => !name.includes("fp8")) || find("checkpoint"),
      ),
      distilledCheckpointPath: choose(
        request.models.distilledCheckpointPath,
        usesDistilledCheckpoint ? officialDistilledCheckpoint : "",
        () => find("distilled-checkpoint"),
      ),
      gemmaRoot: choose(request.models.gemmaRoot, officialGemma, () => find("gemma")),
      spatialUpscalerPath: choose(
        request.models.spatialUpscalerPath,
        officialUpscaler,
        () => find("spatial-upscaler", (name) => name.includes("x2")) || find("spatial-upscaler"),
      ),
      distilledLora: {
        ...request.models.distilledLora,
        path: choose(
          request.models.distilledLora.path,
          officialDistilledLora,
          () => find("lora", (name) => name.includes("distilled")),
        ),
      },
    },
    lipDub: {
      ...request.lipDub,
      lora: {
        ...request.lipDub.lora,
        path: request.mode === "lipdub"
          ? officialLipDubLora || request.lipDub.lora.path
          : request.lipDub.lora.path
            || recommended("lipdub-lora")
            || find("lora", (name) => name.includes("lipdub") || name.includes("lip-dub")),
      },
    },
  };
}
