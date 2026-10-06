import {createHash} from 'node:crypto';
import {PilotError} from './service';
export const MULTIVIEW_VERSION='multiview.krea2-boy.1';
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
  const viewpointInstruction=side==='SIDE'?['clearly side-oriented viewpoint','head and body show useful side-view information',
    'slight three-quarter side acceptable; do not repeat the main viewpoint']:['primarily from behind','useful back-side information',
    'rear three-quarter acceptable; face must not be the principal visible surface'];
  const conservativeInferenceRules=side==='BACK'?['infer unseen back details conservatively from reference; no new costume structure, logos, pockets, straps or decorations']:[];
  const brief={version:MULTIVIEW_VERSION,targetView:side==='SIDE'?'SIDE_ISH':'BACK_ISH',
    sourceIdentity:{canonicalKey:asset.canonicalKey,assetRevision:asset.revision,sourceHash:source.sourceHash,
      identityAuthority:'CURRENT_REFERENCE_IMAGE',identityAnchors:asset.identityAnchors,mustPreserve:asset.mustPreserve,forbiddenChanges:asset.forbiddenChanges},
    preserve,viewpointInstruction,composition:['one complete subject, full body in frame','change viewpoint only'],conservativeInferenceRules,
    avoidVisuals:['no redesign','no extra people or animals','no props or new accessories','no text, labels, contact sheet or multi-view sheet']};
  const prompt=['Preserve exactly the same subject identity and design from the supplied reference image.',
    'Keep the '+preserve.map(p=>p.replace(/^same /,'')).join(', ')+'.',
    'Show the character '+viewpointInstruction.join('; ')+'.',...conservativeInferenceRules.map(p=>p+'.'),
    'Change viewpoint only. One complete subject, full body in frame.',brief.avoidVisuals.join('; ')+'.'].join(' ');
  if(prompt.split(/\s+/).length>200)throw new PilotError('MULTIVIEW_PROMPT_LIMIT','视角提示词超过安全上限',422);
  return {brief,prompt,promptHash:multiViewHash(prompt)};
}
