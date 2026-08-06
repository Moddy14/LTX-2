import type { GenerationRequest, ICLoraProfile } from "./pipelines.js";
import type { ProvenanceUpstreamContract } from "./provenance.js";

// Two deliberately separate upstream sources: the ComfyUI documentation templates
// (Comfy-Org, euler + CFG 1) are the binding contract for the native two-stage modes,
// while the Lightricks example workflows (CFG++ samplers) bind the IC-LoRA, LipDub,
// and T2A paths. Never mix parameters across the two sources.
const LIGHTRICKS_REPOSITORY = "https://github.com/Lightricks/ComfyUI-LTXVideo";
const LIGHTRICKS_COMMIT = "3b9c5cde4700917074823d45e25401d81049f8fc";
const LIGHTRICKS_WORKFLOW_ROOT = "example_workflows/2.3";

const COMFY_TEMPLATES_REPOSITORY = "https://github.com/Comfy-Org/workflow_templates";
const COMFY_TEMPLATES_COMMIT = "7653f1cdef1d92394b6ef9946018c0a8aa4136b8";
const COMFY_TEMPLATES_ROOT = "templates";

function workflow(
  role: string,
  filename: string,
  sha256: string,
): ProvenanceUpstreamContract {
  return {
    role,
    repository: LIGHTRICKS_REPOSITORY,
    commit: LIGHTRICKS_COMMIT,
    path: `${LIGHTRICKS_WORKFLOW_ROOT}/${filename}`,
    sha256,
  };
}

function template(
  role: string,
  filename: string,
  sha256: string,
): ProvenanceUpstreamContract {
  return {
    role,
    repository: COMFY_TEMPLATES_REPOSITORY,
    commit: COMFY_TEMPLATES_COMMIT,
    path: `${COMFY_TEMPLATES_ROOT}/${filename}`,
    sha256,
  };
}

const T2V_TEMPLATE = template(
  "official-template:t2v",
  "video_ltx2_3_t2v.json",
  "75b10f3ee48c1fe00c7fb21b24c0c247b133e5ee34676144de4b652ac7dcbe7f",
);
const I2V_TEMPLATE = template(
  "official-template:i2v",
  "video_ltx2_3_i2v.json",
  "77a16503db8476dec5891de9de9e024c265b6e01b0cd79edac995faa0504ddc8",
);
const IA2V_TEMPLATE = template(
  "official-template:ia2v",
  "video_ltx2_3_ia2v.json",
  "7823a703f472d9c5e6f82c462235ff89a0fa14752ec1fd947c4422cf53e47685",
);
const ID_LORA_TEMPLATE = template(
  "official-template:id-lora",
  "video_ltx2_3_id_lora.json",
  "fcffe421129bac16b4f0655e54130d633280cdaf6949e145221e7090be42151f",
);
const TEXT_TO_AUDIO = workflow(
  "official-workflow:text-to-audio",
  "LTX-2.3_T2A_Single_Stage_Distilled.json",
  "80361c22fbeb9b7ed3a0e128f368536ec5dee0de0a44762d3cba826675385171",
);
const LIPDUB = workflow(
  "official-workflow:lipdub-two-stage",
  "LTX-2.3_ICLoRA_Lipdub_Two_Stage_Distilled.json",
  "620c4fc838866c4fa0819b04db6aa199818ddcff73b7636e44138fed6f1e4a35",
);

const IC_LORA_WORKFLOWS: Partial<Record<ICLoraProfile, ProvenanceUpstreamContract>> = {
  "union-control": workflow(
    "official-workflow:ic-lora-union-control",
    "LTX-2.3_ICLoRA_Union_Control_Distilled.json",
    "f93143d5b1e3024d88c6b1f3aa8460bd3711b4e77328175fb0daa2cee3a512c6",
  ),
  ingredients: workflow(
    "official-workflow:ic-lora-ingredients",
    "LTX-2.3_ICLoRA_Ingredients_Single_Stage_Distilled.json",
    "77385cd26ce46f5a22f3f532776984e3b0e5742e1cf8f29e102608d80e9abd74",
  ),
  "motion-track": workflow(
    "official-workflow:ic-lora-motion-track",
    "LTX-2.3_ICLoRA_Motion_Track_Distilled.json",
    "05546a69f72653f7ffc24dbc5f8815e44dcce34c39866943ad10a63c156db5c8",
  ),
  "pixel-upscaler": workflow(
    "official-workflow:ic-lora-pixel-upscaler",
    "LTX-2.3_ICLoRA_Pixel_Spatial_Upscaler_Distilled.json",
    "c4acc08def6656316b44f838bac4fca23d5a75a3690c30344df2a2f99be21ba9",
  ),
  "v2v-instant-shave": workflow(
    "official-workflow:ic-lora-video-to-video",
    "LTX-2.3_V2V_ICLoRA_Single_Stage_Distilled.json",
    "1b0344f57795d2e08cfd544465c16c6fe02d37a2cf881f7a0b1983f79af64461",
  ),
  inpainting: workflow(
    "official-workflow:ic-lora-inpainting",
    "LTX-2.3_ICLoRA_Inpaint_Two_Stage_Distilled.json",
    "b4d002e2d15eb716654f234797b464daf8aa4f23261f30137ac16dfffdda42bd",
  ),
  outpainting: workflow(
    "official-workflow:ic-lora-outpainting",
    "LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json",
    "4d40049e080486bcc5f1332fba5bc51a9878a7d211ef720f91ea5a82b7fe5c57",
  ),
  // "hdr" is deliberately unbound: the studio runs it through the legacy
  // hdr_ic_lora runner (distilled checkpoint, precomputed scene embeddings),
  // which does not execute the published official HDR graph.
};

export function upstreamWorkflowContractsForRequest(
  request: Pick<GenerationRequest, "mode" | "icLora" | "lipDub" | "images">,
): ProvenanceUpstreamContract[] {
  if (request.mode === "two-stage") {
    return [structuredClone(request.images.length > 0 ? I2V_TEMPLATE : T2V_TEMPLATE)];
  }
  if (request.mode === "image-audio-to-video") return [structuredClone(IA2V_TEMPLATE)];
  if (request.mode === "id-lora") return [structuredClone(ID_LORA_TEMPLATE)];
  if (request.mode === "text-to-audio") return [structuredClone(TEXT_TO_AUDIO)];
  if (request.mode === "lipdub" && request.lipDub.pipelineProfile === "official-comfy-hq") {
    return [structuredClone(LIPDUB)];
  }
  if (request.mode === "ic-lora") {
    const contract = IC_LORA_WORKFLOWS[request.icLora.profile];
    return contract ? [structuredClone(contract)] : [];
  }
  return [];
}
