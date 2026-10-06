import {z} from 'zod';
import {PilotError} from './service';
export const ASSET_RENDERING_BRIEF_VERSION='asset.rendering-brief.1';
const phrases=z.array(z.string().min(1).max(180)).max(30);
export const assetRenderingBriefSchema=z.object({version:z.literal(ASSET_RENDERING_BRIEF_VERSION),subjectIdentity:phrases,appearance:phrases,anatomyAndProportion:phrases,palette:phrases,materials:phrases,composition:phrases,genericCinematicQuality:phrases,avoidVisuals:phrases}).strict();
export type AssetRenderingBrief=z.infer<typeof assetRenderingBriefSchema>;
type Omission={path:string;reason:string};
// Field-level serialization only. Neither Director nor Creative paragraphs are inputs.
export function compileAssetRenderingBrief(asset:any,spec:any){
 const omitted:Omission[]=[];
 const collect=(value:unknown,path:string):string[]=>{
   if(value==null||value==='')return [];
   if(Array.isArray(value))return value.flatMap((v,i)=>collect(v,`${path}.${i}`));
   if(typeof value==='object')return Object.entries(value).flatMap(([k,v])=>collect(v,`${path}.${k}`));
   if(typeof value!=='string'){omitted.push({path,reason:'NON_VISUAL_VALUE'});return [];}
   const s=value.replace(/\s+/g,' ').trim();if(!s)return [];
   if(/[\u3400-\u9fff]/.test(s)){
     const mappings:[RegExp,string][]=[[/灰黑.*皮|皮.*灰黑/,'gray-black natural skin'],[/巨.*鲸|鲸/,'biological whale'],[/细长/,'elongated silhouette']];
     // Narrative summaries are not a source of additional design or Director emotion.
     omitted.push({path,reason:'UNMAPPED_SOURCE_RETAINED_IN_AUDIT'});
     return /description|visualIdentitySummary/.test(path)?[]:mappings.filter(([r])=>r.test(s)).map(([,v])=>v);
   }
   if(s.length>180||s.split(/\s+/).length>20||/[{}\[\]]|\b(?:canonicalKey|directorVersion|narrativeRole|assetVisualDNA|scaleRelations|transformationLineage|schema|storyboard)\b|(?:CHAR|PROP|FX|BRAND)-\d|\b(?:swallow|sneeze|boy|crew|pirate|submarine|then|afterward)\b/i.test(s)){
     omitted.push({path,reason:'NARRATIVE_OR_UNSAFE_FIELD'});return [];
   }
   return [s];
 };
 if(asset.canonicalKey!=='CHAR-003'||asset.assetKind!=='CREATURE'||!/鲸|whale/i.test([asset.name,spec?.visualIdentitySummary].join(' ')))throw new PilotError('DIRECTOR_AB_NOT_READY','当前三组实验仅支持 CHAR-003 鲸鱼',409);
 const canonicalList=(v:any)=>{if(typeof v==='string'&&v.startsWith('[')){try{return JSON.parse(v);}catch{return v;}}return v;};
 const fallback=(v:any,a:any)=>Array.isArray(v)?v.length?v:canonicalList(a):v||canonicalList(a);
 const brief=assetRenderingBriefSchema.parse({version:ASSET_RENDERING_BRIEF_VERSION,
   subjectIdentity:['mature biological whale',...collect(spec.visualIdentitySummary?null:asset.description,'asset.description'),...collect(spec.visualIdentitySummary,'spec.visualIdentitySummary'),...collect(fallback(spec.identityAnchors,asset.identityAnchors),'identityAnchors'),...collect(fallback(spec.mustPreserve,asset.mustPreserve),'mustPreserve')],
   appearance:[...collect(spec.silhouette,'spec.silhouette'),...collect(spec.surfaceLanguage,'spec.surfaceLanguage'),...collect(spec.distinctiveFeatures,'spec.distinctiveFeatures'),...collect(spec.details,'spec.details')],
   anatomyAndProportion:['grounded biological anatomy',...collect(spec.scale,'spec.scale'),...collect(spec.proportion,'spec.proportion')],
   palette:[...collect(spec.primaryPalette,'spec.primaryPalette'),...collect(spec.secondaryPalette,'spec.secondaryPalette')],
   materials:['physical natural skin',...collect(spec.materials,'spec.materials')],
   composition:['one complete isolated whale, single isolated subject','readable silhouette; preserve current visual identity; no scale-reference objects'],
   genericCinematicQuality:['cinematic concept rendering, coherent physical volume'],
   avoidVisuals:[...collect(fallback(spec.forbiddenChanges,asset.forbiddenChanges),'forbiddenChanges'),'no people, no other whales or creatures','no cute mascot, chibi or horror-monster styling','no text, no typography, no labels, no captions, no annotations','no infographic, no diagram, no poster layout, no contact sheet, no reference sheet']});
 return {brief,omitted};
}
export function renderAssetRenderingBrief(brief:AssetRenderingBrief){
 const phrases=[brief.subjectIdentity,brief.materials,brief.anatomyAndProportion,brief.appearance,brief.palette,brief.composition,brief.genericCinematicQuality,brief.avoidVisuals].flat();
 const prompt=[...new Set(phrases)].join('. ')+'.';
 // Do not silently discard explicitly serialized identity facts to hit a budget.
 if(prompt.split(/\s+/).length>150)throw new PilotError('DIRECTOR_AB_NOT_READY','资产身份短语超过实验长度上限，请先人工审阅规格',409);
 return prompt;
}
