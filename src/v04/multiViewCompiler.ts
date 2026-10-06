import {createHash} from 'node:crypto';
import {PilotError} from './service';
export const MULTIVIEW_VERSION='multiview.krea2-boy.1';
// Source-capture identity remains V1: changing it would also change the seed.
// View prompt versions are part of experimentHash; MAIN and execution settings stay fixed.
export const MULTIVIEW_SIDE_VERSION='multiview.krea2-boy.side.3';
export const MULTIVIEW_BACK_VERSION='multiview.krea2-boy.back.2';
export const multiViewHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const multiViewSides=['SIDE','BACK'] as const;
export function resolveMultiViewBoy(assets:any[]){
  const boys=assets.filter(a=>a.status==='ACTIVE'&&a.assetKind==='HUMAN_CHARACTER'&&/(男孩|\bboy\b)/i.test(a.name));
  if(boys.length!==1)throw new PilotError('MULTIVIEW_TARGET_AMBIGUOUS','当前项目无法唯一解析男孩',409);
  if(boys[0].sourcePolicy!=='AI_ALLOWED')throw new PilotError('MULTIVIEW_SOURCE_NOT_READY','该资产不允许实验派生',409);
  return boys[0];
}
// The image is the identity authority. Old textual costume details stay in audit
// evidence only; this compiler never substitutes a new costume for the reference.
export function compileMultiViewBrief(asset:any,source:any,side:'SIDE'|'BACK'){
  const preserve=['same subject identity','same apparent age and face family','same hairstyle','same body proportions',
    'same clothing construction, sleeve and shorts length','same footwear state','same colors, materials and distinctive details'];
  const viewpointInstruction=side==='SIDE'?['clear side-oriented standing view','side-ish is acceptable; no strict angle required']:['clear back-oriented standing view','primarily from behind; back-ish is acceptable; no strict angle required'];
  const conservativeInferenceRules=side==='BACK'?['infer unseen back details conservatively; no new clothing structure or decorations']:[];
  const structure='Natural hands, wrists, fingers, knees, ankles, heels and toes aligned with the standing body orientation. No twisted, fused, extra or missing limbs.';
  const brief={version:side==='SIDE'?MULTIVIEW_SIDE_VERSION:MULTIVIEW_BACK_VERSION,targetView:side==='SIDE'?'SIDE_ISH':'BACK_ISH',
    sourceIdentity:{canonicalKey:asset.canonicalKey,assetRevision:asset.revision,sourceHash:source.sourceHash,identityAuthority:'CURRENT_REFERENCE_IMAGE',identityAnchors:asset.identityAnchors,mustPreserve:asset.mustPreserve,forbiddenChanges:asset.forbiddenChanges},
    preserve,viewpointInstruction,composition:['exactly one child, one person and one body','single centered full-body standing figure; change viewpoint only'],conservativeInferenceRules,
    structuralConstraints:[structure],avoidVisuals:['no redesign','no duplicate or second child','no collage or turnaround sheet','no extra pose, text, props, accessories or cropped body']};
  const view=side==='SIDE'?'Rotate this same boy into one clear side-oriented standing view. Replace the current frontal presentation; only the transformed figure remains.':'Show a clear back-oriented standing view, primarily from behind. Infer unseen back details conservatively; no new clothing structure or decorations.';
  const prompt='Preserve exactly the same child from the reference. '+view+' Change viewpoint only; '+(side==='SIDE'?'side-ish':'back-ish')+' is acceptable. Keep the same apparent age, same face identity, same hairstyle, same body proportions, same clothing construction, sleeve and shorts length, colors and details. Keep the same barefoot footwear state; no shoes. Exactly one child, one person and one body. Single centered full-body standing figure, head to toes visible. '+structure+' No redesign, duplicate, second child, collage, turnaround sheet, extra pose, text, props, accessories or cropped body.';
  if(prompt.split(/\s+/).length>160)throw new PilotError('MULTIVIEW_PROMPT_LIMIT','视角提示词超过安全上限',422);
  return {brief,prompt,promptHash:multiViewHash(prompt)};

}
