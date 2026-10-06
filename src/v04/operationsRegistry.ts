import {buildKleinAssetWorkflow,KLEIN_ASSET_VIEW_V1} from './kleinAssetProfile';
import { buildKreaEditWorkflow, kreaEditProfiles, KREA_EDIT_WORKFLOW_VERSION } from './kreaImageEditProfile';
import { buildDraftWorkflow, LOCAL_DRAFT_V1 } from './comfyDraftClient';
import { Z_IMAGE_TURBO_SUBJECT_DRAFT_V1, zImageSubjectModels } from './zImageSubjectProfile';

export const routingDefaults = {
  T2I: 'KREA2_T2I_ASSET_V1', SOURCE_EDIT: 'KREA2_SOURCE_EDIT_V1',
  REFERENCE_EDIT: 'KREA2_REFERENCE_EDIT_V1', DERIVE_VIEW: 'KREA2_DERIVE_CHARACTER_REFERENCE_V1',
} as const;
export type RoutingTask = keyof typeof routingDefaults;
export const routingTasks = Object.keys(routingDefaults) as RoutingTask[];
export function profileExample(profile: string, checkpoint = 'SELECT_INSTALLED_SDXL_CHECKPOINT') {
  if(profile===KLEIN_ASSET_VIEW_V1)return buildKleinAssetWorkflow({prompt:'One complete reference subject, clear side view.',seed:20261005,sourceImage:'example-source.png',targetRole:'SIDE_PROFILE',jobId:'example'});
  if (kreaEditProfiles.includes(profile as any)) return buildKreaEditWorkflow({ profile,
    prompt: 'Example only: preserve subject identity, neutral lighting.', seed: 1, targetRole: 'MAIN_PREVIEW', jobId: 'example',
    ...(profile !== 'KREA2_T2I_ASSET_V1' ? { sourceImage: 'example-source.png' } : {}),
    ...(profile === 'KREA2_REFERENCE_EDIT_V1' ? { referenceImage: 'example-reference.png' } : {}) });
  return buildDraftWorkflow({ profile: profile as any, intent: 'CHARACTER_TURNAROUND', positive: 'Example character study', negative: '', seed: 1,
    checkpoint: profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? zImageSubjectModels.unet : checkpoint });
}
export function graphFacts(graph: Record<string, any>) {
  const nodes = Object.values(graph);
  const sampler = nodes.find(n => n.class_type === 'KSampler')?.inputs ?? {};
  const latent = nodes.find(n => ['EmptyLatentImage', 'EmptySD3LatentImage','EmptyFlux2LatentImage'].includes(n.class_type))?.inputs ?? {};
  const models = nodes.flatMap(n => Object.entries(n.inputs ?? {}).filter(([key, value]) =>
    ['unet_name', 'clip_name', 'vae_name', 'lora_name', 'ckpt_name'].includes(key) && typeof value === 'string')
    .map(([field, file]) => ({ node: n.class_type, field, file })));
  return { requiredNodes: [...new Set(nodes.map(n => n.class_type))], models,
    parameters: { seed: sampler.seed??nodes.find(n=>n.class_type==='RandomNoise')?.inputs?.noise_seed, steps: sampler.steps??nodes.find(n=>n.class_type==='Flux2Scheduler')?.inputs?.steps, cfg: sampler.cfg??(nodes.some(n=>n.class_type==='BasicGuider')?1:undefined), sampler: sampler.sampler_name??nodes.find(n=>n.class_type==='KSamplerSelect')?.inputs?.sampler_name,
      scheduler: sampler.scheduler, denoise: sampler.denoise, width: latent.width, height: latent.height,
      editPatch: nodes.find(n=>n.class_type==='Krea2EditModelPatch')?.inputs ? Object.fromEntries(Object.entries(nodes.find(n=>n.class_type==='Krea2EditModelPatch').inputs).filter(([key])=>['fit_mode','ref_boost','ref_boost_a'].includes(key))) : null,
      loraStrength: nodes.find(n=>n.class_type==='LoraLoaderModelOnly')?.inputs?.strength_model ?? null,
      clipDevice: nodes.find(n=>n.class_type==='CLIPLoader')?.inputs?.device ?? null } };
}
export function workflowRegistry(checkpoint?: string) {
  return [...kreaEditProfiles,KLEIN_ASSET_VIEW_V1, Z_IMAGE_TURBO_SUBJECT_DRAFT_V1, LOCAL_DRAFT_V1].map(profile => {
    const workflow = profileExample(profile, checkpoint);
    const task = routingTasks.find(key => routingDefaults[key] === profile);
    return { profile, workflowVersion: workflow.version, sourceType: 'CODE_GENERATED', jsonFile: null,
      builder: profile===KLEIN_ASSET_VIEW_V1?'src/v04/kleinAssetProfile.ts':profile.startsWith('KREA2') ? 'src/v04/kreaImageEditProfile.ts' : profile.startsWith('Z_IMAGE') ?
        'src/v04/zImageSubjectProfile.ts' : 'src/v04/comfyDraftClient.ts',
      capabilities: [['KREA2_DERIVE_ASSET_REFERENCE_V1','KREA2_DERIVE_CHARACTER_REFERENCE_V1',KLEIN_ASSET_VIEW_V1].includes(profile)?'DERIVE_VIEW':task ?? 'T2I', ...(profile.startsWith('Z_IMAGE') ? ['CHARACTER'] : ['CHARACTER', 'CREATURE', 'ENVIRONMENT', 'PROP', 'VEHICLE', 'MATERIAL_FX', 'CELESTIAL'])],
      wiring: ['KREA2_T2I_ASSET_V1','KREA2_DERIVE_ASSET_REFERENCE_V1',KLEIN_ASSET_VIEW_V1].includes(profile) ? 'AUTO_ASSET' : task ? 'AGENT_EDIT' : 'MANUAL_LEGACY',
      limitations: profile.startsWith('Z_IMAGE') ? 'Subject main preview only; not a turnaround.' : profile === LOCAL_DRAFT_V1 ?
        'Legacy checkpoint configuration; example requires an installed checkpoint.' : 'Draft only; identity preservation is not guaranteed. At most one external reference.',
      ...graphFacts(workflow.graph), purpose: task ?? 'LEGACY_DRAFT',
      declaredVersion: profile.startsWith('KREA2') ? KREA_EDIT_WORKFLOW_VERSION : workflow.version };
  });
}
