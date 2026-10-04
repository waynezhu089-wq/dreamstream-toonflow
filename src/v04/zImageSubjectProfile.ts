// A parameterized translation of the locally verified Z-Image Turbo API graph.
// The canonical Prompt IR remains unchanged; this is only its execution prompt.
export const Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 = "Z_IMAGE_TURBO_SUBJECT_DRAFT_V1" as const;
// Executor-only rendering language. It is deliberately separate from the canonical Prompt IR.
export const Z_IMAGE_SUBJECT_RENDERING_V1 = "Z_IMAGE_SUBJECT_RENDERING_V1" as const;
export const zImageSubjectModels = {
  unet: "z_image_turbo_int8_convrot.safetensors",
  textEncoder: "qwen_3_4b_fp8_mixed.safetensors",
  vae: "ae.safetensors",
} as const;
export const zImageSubjectWorkflowVersion = "z-image-turbo-subject-draft-v1";

const contains = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value);
const string = (value: unknown) => typeof value === "string" ? value : "";
const subjectRenderingLanguage =
  "Cinematic stylized realism: natural age-appropriate child anatomy and head-to-body ratio, refined facial anatomy, " +
  "subtle realistic skin and fabric texture, soft filmic lighting, dreamlike but grounded, " +
  "premium animated-film character concept art with gentle emotional realism.";

export function zImageSubjectPrompt(ir: any) {
  const details = ir?.appearanceBlock?.details ?? {};
  const age = string(details.ageRange);
  const ageRange = age.match(/(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})/);
  const singleAge = age.match(/(\d{1,2})\s*岁/);
  const years = ageRange ? `${ageRange[1]} to ${ageRange[2]} year old` : singleAge ? `${singleAge[1]} year old` : "young";
  const gender = contains(details.genderPresentation, /男|boy|male/i) ? "boy" :
    contains(details.genderPresentation, /女|girl|female/i) ? "girl" : "child";
  const body = string(details.body?.build) + " " + string(ir?.appearanceBlock?.silhouette);
  const hair = [details.hair?.color, details.hair?.length, details.hair?.silhouette, details.hair?.styling].map(string).join(" ");
  const clothes = [details.wardrobe?.upper, details.wardrobe?.lower].map(string).join(" ");
  const palette = Array.isArray(ir?.materialBlock?.primaryPalette) ? ir.materialBlock.primaryPalette.join(" ") : "";
  const traits = [
    contains(body, /清瘦|纤细|瘦小|slim|slender/i) ? "slim child proportions" : "child proportions",
    contains(body, /窄肩|肩线.*窄|narrow shoulder/i) ? "narrow shoulders" : "",
    contains(hair, /深棕|墨黑|黑色|dark|black/i) ? "dark brown-black hair" : "",
    contains(hair, /短发|短|short/i) ? "short hair" : "",
    contains(hair, /乱|蓬松|messy|tousled/i) ? "slightly messy hair" : "",
    contains(details.face?.eyeLanguage, /深蓝灰|blue.gray/i) ? "dark blue-gray eyes" : "",
    contains(clothes, /宽松|loose/i) ? "loose clothing" : "",
    contains(clothes, /长袖|long.sleeve/i) ? "long sleeves" : "",
    contains(clothes, /睡衣|pajama/i) ? "pajamas and matching trousers" : "",
    contains(palette + " " + clothes, /月白|moon.white/i) ? "moon-white" : "",
    contains(palette + " " + clothes, /灰蓝|gray.blue|blue.gray/i) ? "muted gray-blue" : "",
    contains(details.footwear, /赤足|光脚|barefoot/i) ? "barefoot" : "",
  ].filter(Boolean);
  const identity = `One ${years} ${gender}, ${traits.join(", ")}.`;
  const composition = "Clean full-body single-character design study, head and both feet fully visible, neutral studio background.";
  const constraints = "Preserve the specified identity, hairstyle, sleepwear, footwear, body proportions and palette; " +
    "no new accessories, jewelry, logos, text, armor or extra people. " +
    "Avoid chibi or super-deformed proportions, oversized head, anime mascot styling, toy-like body, " +
    "flat vector or children's sticker illustration, and exaggerated cute facial features.";
  return [identity, subjectRenderingLanguage, composition, constraints].join(" ");
}

export function buildZImageSubjectGraph(input: { positive: string; seed: number; width: number; height: number; filenamePrefix: string }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: zImageSubjectModels.unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: zImageSubjectModels.textEncoder, type: "lumina2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: zImageSubjectModels.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: input.positive, clip: ["2", 0] } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "ModelSamplingAuraFlow", inputs: { shift: 3, model: ["1", 0] } },
    "7": { class_type: "EmptySD3LatentImage", inputs: { width: input.width, height: input.height, batch_size: 1 } },
    "8": { class_type: "KSampler", inputs: { seed: input.seed, steps: 8, cfg: 1, sampler_name: "res_multistep",
      scheduler: "simple", denoise: 1, model: ["6", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: input.filenamePrefix, images: ["9", 0] } },
  };
}
