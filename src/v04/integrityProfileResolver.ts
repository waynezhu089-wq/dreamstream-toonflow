export const INTEGRITY_RESOLVER_VERSION='integrity.profile-resolver.2';
export type IntegrityProfileKey='HUMAN'|'ANIMAL'|'FANTASY_CREATURE'|'VEHICLE'|'PROP'|'FURNITURE'|'MACHINE'|'ARCHITECTURE'|'GENERIC_STRUCTURED_ASSET';
export type IntegrityResolution={version:string;profile:IntegrityProfileKey;confidence:'HIGH'|'MEDIUM'|'LOW';evidence:string[];fallbackUsed:boolean};
export type IntegritySemanticContext={assetKind:string;assetCategory?:string;name?:string;confirmedVisualSpec?:any;confirmedMorphologyProfile?:IntegrityProfileKey;identityAnchors?:string[];mustPreserve?:string[];forbiddenChanges?:string[];confirmedIdentityDescription?:string};
// Adapter accepts server-read canonical facts only; it never reads Director or project narrative.
export function integritySemanticContext(asset:any,confirmedVisualSpec:any):IntegritySemanticContext{
 const lines=(v:unknown):string[]=>Array.isArray(v)?v.filter(x=>typeof x==='string'):typeof v==='string'?lines(JSON.parse(v)):[];
 return {assetKind:asset.assetKind,assetCategory:asset.category,name:asset.name,confirmedVisualSpec,identityAnchors:lines(asset.identityAnchors),mustPreserve:lines(asset.mustPreserve),forbiddenChanges:lines(asset.forbiddenChanges),confirmedIdentityDescription:asset.description};
}
const ordinary=/\b(whale|cetacean|horse|equine|dog|canine|cat|feline|bird|fish|biological animal)\b|鲸鱼|鲸类|鲸豚|马匹|普通马|犬|猫|鸟类|鱼类/i;
const horse=/\b(horse|equine|quadruped)\b|马|四足/i;
const wing=/\b(wings?|wing roots?)\b|翅膀|翼根|有翼|双翼/i;
const fiction=/\b(dragon morphology|hybrid creature|supernatural appendages|impossible anatomy|fantastical morphology|multiple tails|extra limbs)\b|龙形态|混合生物|超自然附肢|不可能的解剖|多条尾巴|额外肢体|有翼马/i;
// Negated/forbidden parts are not positive morphology evidence.
function physicalLines(values:unknown[]){return values.flatMap(v=>typeof v==='string'?v.slice(0,2000).split(/[.;；。\n]/):[]).filter(s=>!/(?:\b(no|not|without|forbid|avoid|never)\b|无翼|没有|不得|禁止|不可|不要)/i.test(s));}
function biological(lines:string[]){return lines.some(s=>ordinary.test(s)||/\b(ordinary|biological|natural)\s+(?:animal|cetacean|horse|morphology)\b|普通生物|生物鲸|自然动物/.test(s));}
function fantastical(lines:string[],m:any){
 if(m?.fantastical===true||m?.impossibleAnatomy===true)return true;
 const appendages=Array.isArray(m?.appendages)?m.appendages:[];
 if(appendages.some((a:any)=>a?.nonOrdinary===true))return true;
 const base=typeof m?.baseForm==='string'?m.baseForm:'';
 if(horse.test(base)&&appendages.some((a:any)=>/^(wing|wings|翅膀)$/i.test(a?.type??'')&&Number(a.count)>0))return true;
 return lines.some(s=>fiction.test(s))||(lines.some(s=>horse.test(s))&&lines.some(s=>wing.test(s)));
}
export function resolveIntegrityProfile(ctx:IntegritySemanticContext):IntegrityResolution{
 const result=(profile:IntegrityProfileKey,confidence:IntegrityResolution['confidence'],evidence:string[],fallbackUsed=false):IntegrityResolution=>({version:INTEGRITY_RESOLVER_VERSION,profile,confidence,evidence,fallbackUsed});
 const keys=['HUMAN','ANIMAL','FANTASY_CREATURE','VEHICLE','PROP','FURNITURE','MACHINE','ARCHITECTURE','GENERIC_STRUCTURED_ASSET'];
 if(ctx.confirmedMorphologyProfile&&keys.includes(ctx.confirmedMorphologyProfile))return result(ctx.confirmedMorphologyProfile,'HIGH',['explicit confirmed morphology profile']);
 const spec=ctx.confirmedVisualSpec,d=spec?.details??{},m=d.morphology??{};
 // Atmosphere, lighting, story, movement and Director fields are intentionally excluded.
 const structured=physicalLines([d.speciesOrForm,d.bodyStructure,d.anatomy,m.baseForm]);
 const identity=physicalLines([...(ctx.identityAnchors??[]),...(ctx.mustPreserve??[]),...(spec?.identityAnchors??[]),...(spec?.mustPreserve??[])]);
 const description=physicalLines([ctx.confirmedIdentityDescription]);
 const all=[...structured,...identity,...description];
 if(ctx.assetKind==='HUMAN_CHARACTER')return result('HUMAN','HIGH',['assetKind: HUMAN_CHARACTER']);
 if(ctx.assetKind==='CREATURE'){
  // Confirmed exceptional appendages override ordinary species evidence across layers.
  if(fantastical(structured,m))return result('FANTASY_CREATURE','HIGH',['confirmed Visual Spec: non-ordinary morphology']);
  if(fantastical([...structured,...identity],m))return result('FANTASY_CREATURE','HIGH',['confirmed Visual Spec + identity facts: non-ordinary appendages']);
  if(fantastical(identity,{}))return result('FANTASY_CREATURE','HIGH',['confirmed identity facts: non-ordinary morphology']);
  if(fantastical(description,{}))return result('FANTASY_CREATURE','MEDIUM',['confirmed asset description: non-ordinary morphology']);
  if(m.ordinaryAnimal===true||biological(structured))return result('ANIMAL','HIGH',['confirmed Visual Spec: biological animal morphology']);
  if(biological(identity))return result('ANIMAL','MEDIUM',['confirmed identity facts: biological animal morphology']);
  if(biological(description))return result('ANIMAL','MEDIUM',['confirmed asset description: biological animal morphology']);
  if(!all.length&&biological(physicalLines([ctx.name])))return result('ANIMAL','LOW',['name-only supporting evidence; morphology requires human review'],true);
  return result('GENERIC_STRUCTURED_ASSET','LOW',['no reliable confirmed creature morphology'],true);
 }
 const mapping:Record<string,IntegrityProfileKey>={ANIMAL:'ANIMAL',FANTASY_CREATURE:'FANTASY_CREATURE',VEHICLE:'VEHICLE',PROP:'PROP',FURNITURE:'FURNITURE',MACHINE:'MACHINE',ARCHITECTURE:'ARCHITECTURE'};
 if(spec?.assetKind==='VEHICLE'&&d.vehicleType)return result('VEHICLE','HIGH',['confirmed Visual Spec: vehicle structure']);
 if(mapping[ctx.assetKind])return result(mapping[ctx.assetKind],'HIGH',[`assetKind: ${ctx.assetKind}`]);
 if(ctx.assetKind==='ENVIRONMENT'&&Array.isArray(d.architectureOrNaturalForms)&&d.architectureOrNaturalForms.some((s:unknown)=>typeof s==='string'&&/\b(building|architecture|stairs|columns)\b|建筑|楼梯|柱/.test(s)))return result('ARCHITECTURE','MEDIUM',['confirmed Visual Spec: architecture']);
 return result('GENERIC_STRUCTURED_ASSET','LOW',['no specific confirmed structural profile'],true);
}
