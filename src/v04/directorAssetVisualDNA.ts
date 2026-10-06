import {z} from 'zod';
import type {DirectorIntent} from './directorContract';
export const ASSET_DNA_PROJECTION_VERSION='director.asset-dna.1';
const text=z.string().max(1600),lines=z.array(text).max(30);
const fields={artStyle:text.nullable(),colorLanguage:lines,lightingLanguage:lines,realismLevel:text.nullable(),atmosphere:text.nullable(),forbiddenStyleDrift:lines,materialLanguage:lines,motionLanguage:lines,recurringVisualMotifs:lines};
export const directorAssetVisualDNASchema=z.object({
  schemaVersion:z.literal(1),projectionVersion:z.literal(ASSET_DNA_PROJECTION_VERSION),
  inherited:z.object(fields).strict(),excluded:z.object(fields).strict(),
  materialIdentity:z.enum(['LIVING_BIOLOGICAL_CREATURE','SOURCE_DEFINED_MATERIAL','CANONICAL_ASSET']),
  colorApplication:z.literal('ENVIRONMENT_AND_LIGHTING_ONLY_PRESERVE_CONFIRMED_PALETTE'),
  projectionReasons:z.array(z.object({field:z.string().max(80),decision:z.enum(['INHERIT','EXCLUDE']),reason:z.string().max(200)}).strict()).max(300),
}).strict();
// Conservative fragment classification: mixed/unknown motifs remain evidence only.
const transformation=/dream\s*matter|梦的?物质|荧光物质|material\s*transformation|材质变形|物质变形|mist|particle|contour|luminous\s*solid|semi.?transparent|雾|颗粒|粒子|轮廓|半透明|凝聚|消散|重组|condens|dissolv|reform/i;
const story=/reaching\s*hand|伸.*手|伸手|moon\s*destination|月亮.*目的|奔向.*月|pegasus|飞马|logo|标志|品牌|graphic\s*match|图形匹配|男孩|boy|crew|船员/i;
const ambient=/night|moonlight|夜|月光|blue|violet|蓝|紫|ambient|atmosphere|氛围|环境|volumetric|体积光|dreamlike|grounded|梦幻|写实/i;
const styleConstraint=/chibi|cartoon|mascot|cute|juvenile|horror|monster|people|human|萌|卡通|吉祥物|可爱|幼|恐怖|怪兽|人物|人类|写实|style|风格/i;
const explicitMaterial=/(?:made|formed|composed|constituted)\s+(?:entirely\s+)?(?:of|from)\s+(?:the\s+)?dream\s*matter|由.{0,12}(?:梦的?物质|荧光物质).{0,8}(?:构成|组成|形成)|(?:梦的?物质|荧光物质).{0,6}(?:构成|组成)/i;
export function projectGlobalVisualDNAForAsset(input:{asset:any;visualSpec:any;narrativeRole:any;globalVisualDNA:DirectorIntent['globalVisualDNA'];relevantLineage:DirectorIntent['transformationLineage'];relevantScale:DirectorIntent['scaleRelations']}){
  const {asset,visualSpec,narrativeRole,globalVisualDNA:g}=input;
  const targetLineage=input.relevantLineage.some(e=>e.relationType==='MATERIAL_TRANSFORMATION'&&e.to===asset.canonicalKey&&e.from!==asset.canonicalKey);
  const sourceIdentity=JSON.stringify({description:asset.description,identityAnchors:asset.identityAnchors,mustPreserve:asset.mustPreserve,
    summary:visualSpec?.visualIdentitySummary,materials:visualSpec?.materials,details:visualSpec?.details});
  const roleIdentity=[narrativeRole?.narrativeFunction,narrativeRole?.scaleFunction].filter(Boolean).join(' ');
  // A palette/lighting reference to Dream Matter is not a material constitution claim.
  const sourceDefinesMaterial=explicitMaterial.test(sourceIdentity)||explicitMaterial.test(roleIdentity);
  const sourceRefusesMaterial=/(?:not|never)\s+(?:made|formed|composed)\s+(?:of|from)\s+dream\s*matter|(?:不是|并非|不由).{0,8}(?:梦的?物质|荧光物质)/i.test(sourceIdentity);
  const materialAllowed=!sourceRefusesMaterial&&(targetLineage||sourceDefinesMaterial);
  const empty=()=>({artStyle:null as string|null,colorLanguage:[] as string[],lightingLanguage:[] as string[],realismLevel:null as string|null,atmosphere:null as string|null,forbiddenStyleDrift:[] as string[],materialLanguage:[] as string[],motionLanguage:[] as string[],recurringVisualMotifs:[] as string[]});
  const inherited=empty(),excluded=empty(),projectionReasons:{field:string;decision:'INHERIT'|'EXCLUDE';reason:string}[]=[];
  const decide=(field:keyof typeof inherited,value:string,allowed:boolean,reason:string)=>{
    if(['artStyle','realismLevel','atmosphere'].includes(field))(allowed?inherited:excluded)[field as 'artStyle']=value;
    else ((allowed?inherited:excluded)[field] as string[]).push(value);
    projectionReasons.push({field,decision:allowed?'INHERIT':'EXCLUDE',reason});
  };
  for(const field of ['artStyle','colorLanguage','lightingLanguage','realismLevel','atmosphere','forbiddenStyleDrift'] as const){
    const values=Array.isArray(g[field])?g[field] as string[]:g[field]?[g[field] as string]:[];
    for(const value of values){const safe=!transformation.test(value)&&!story.test(value)&&(field!=='forbiddenStyleDrift'||styleConstraint.test(value));
      decide(field,value,safe,safe?'Film direction; identity and confirmed palette remain authoritative.':'Asset/shot-specific or ambiguous global wording is not safe for this asset.');}
  }
  for(const field of ['materialLanguage','motionLanguage'] as const)for(const value of g[field]){
    const safe=materialAllowed&&!story.test(value);
    decide(field,value,safe,safe?'Explicit target material lineage or source constitution permits inheritance.':'No explicit target material constitution/lineage; global material and motion are not asset identity.');
  }
  for(const value of g.recurringVisualMotifs){
    const safe=!story.test(value)&&((transformation.test(value)&&materialAllowed)||(!transformation.test(value)&&ambient.test(value)));
    decide('recurringVisualMotifs',value,safe,safe?'Ambient film language or explicitly linked transformation motif.':'Relational, brand, other-asset or ambiguous motif stays outside this asset prompt.');
  }
  return directorAssetVisualDNASchema.parse({schemaVersion:1,projectionVersion:ASSET_DNA_PROJECTION_VERSION,inherited,excluded,
    materialIdentity:asset.assetKind==='CREATURE'&&!materialAllowed?'LIVING_BIOLOGICAL_CREATURE':materialAllowed?'SOURCE_DEFINED_MATERIAL':'CANONICAL_ASSET',
    colorApplication:'ENVIRONMENT_AND_LIGHTING_ONLY_PRESERVE_CONFIRMED_PALETTE',projectionReasons});
}
