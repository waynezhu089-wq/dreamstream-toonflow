import {z} from 'zod';
export const DIRECTOR_RENDERING_BRIEF_VERSION='director.rendering-brief.1';
const phrases=z.array(z.string().min(1).max(180)).max(30);
export const directorRenderingBriefSchema=z.object({version:z.literal(DIRECTOR_RENDERING_BRIEF_VERSION),subjectIdentity:phrases,visualCharacter:phrases,scalePresence:phrases,environmentStyle:phrases,lighting:phrases,materialIdentity:phrases,compositionRules:phrases,avoidVisuals:phrases}).strict();
type Brief=z.infer<typeof directorRenderingBriefSchema>;
// Closed visual vocabulary: source prose is examined, never copied into image input.
// Unknown descriptions remain available in audit evidence; they are not invented translations.
function matches(text:string,rules:[RegExp,string][]):string[]{return rules.filter(([rule])=>rule.test(text)).map(([,phrase])=>phrase);}
const rules:[RegExp,string][]=[
 [/cinematic|电影/i,'cinematic dream realism'],[/dreamlike|梦幻|梦境/i,'dreamlike but grounded'],[/spatial|depth|空间|层次/i,'realistic spatial depth'],
 [/night.?blue|深夜蓝|暗夜蓝/i,'deep night-blue atmosphere'],[/violet|蓝紫/i,'blue-violet atmosphere'],
 [/moonlight|月光|月夜/i,'cold moonlight'],[/blue.*light|冷蓝环境光/i,'blue environmental light'],[/volumetric|体积光/i,'volumetric illumination'],
 [/shadow|暗部/i,'deep readable shadows'],[/ancient|古老/i,'ancient physical presence'],[/majestic|庄严|庄重/i,'majestic solemn presence'],
 [/sublime|colossus|巨物|崇高/i,'sublime colossus'],[/awe|敬畏/i,'awe before fear'],[/solemn|平静|沉静|静/i,'solemn natural presence'],
 [/geological|地质|重量|沉而/i,'grounded geological weight'],[/non.aggressive|不带攻击|不.*恶意|自然现象|天象/i,'overwhelming but non-aggressive'],
 [/monumental|massive|巨大|体量|吞.*船|ship.*swallow|swallow.*ship/i,'monumental scale and overwhelming physical mass'],
];
function sourceText(x:unknown):string{return typeof x==='string'?x:Array.isArray(x)?x.map(sourceText).join(' '):x&&typeof x==='object'?Object.values(x).map(sourceText).join(' '):'';}
export function compileDirectorRenderingBrief(asset:any,spec:any,projection:any):Brief{
 const identity=sourceText([spec?.visualIdentitySummary,spec?.identityAnchors,spec?.mustPreserve,spec?.details,spec?.materials,spec?.primaryPalette,asset.name,asset.description]);
 const role=sourceText(projection.narrativeRole),dna=projection.assetVisualDNA.inherited;
 const biological=projection.assetVisualDNA.materialIdentity==='LIVING_BIOLOGICAL_CREATURE';
 const kind=asset.assetKind,whale=kind==='CREATURE'&&/whale|鲸/i.test(identity);
 const subject=whale?'whale':({CREATURE:'creature',HUMAN_CHARACTER:'character',VEHICLE:'vehicle',PROP:'object',ENVIRONMENT:'environment',MATERIAL_FX:'material',CELESTIAL:'celestial form'} as Record<string,string>)[kind]||'subject';
 const subjectIdentity=[biological?`mature biological ${subject}`:subject];
 // Preserve explicit visual facts only, not story participants or incident verbs.
 const facts:[RegExp,string][]=[[/dark.*skin|黑.*皮|灰黑/i,'dark natural skin'],[/slim|清瘦/i,'slim build'],[/barefoot|赤足/i,'barefoot'],[/black.*hair|黑.*发/i,'dark hair']];
 subjectIdentity.push(...matches(identity,facts));
 const materialIdentity=biological?['living biological creature with physical skin and grounded anatomy','non-luminous body; blue light is environmental only','preserve source-defined natural material and palette']:['preserve source-defined constitution and palette'];
 const visualCharacter=matches(role,rules).filter(p=>/presence|colossus|awe|weight|aggressive/.test(p));
 const scalePresence=matches(sourceText([role,projection.relevantScaleRelations,spec?.scale,spec?.proportion]),rules).filter(p=>/monumental/.test(p));
 const environmentStyle=matches(sourceText([dna.artStyle,dna.colorLanguage,dna.realismLevel,dna.atmosphere]),rules).filter(p=>/realism|grounded|depth|atmosphere/.test(p));
 const lighting=matches(sourceText(dna.lightingLanguage),rules).filter(p=>/light|illumination|shadows/.test(p));
 const compositionRules=[`one complete isolated ${subject}, single subject`,'readable silhouette and physical volume','subject dominates the visual field; no scale-reference objects'];
 const avoidVisuals=['no people, no other animals, no story actors','no cute mascot, chibi or horror-monster styling','no text, no typography, no labels, no captions, no annotations','no infographic, no diagram, no poster layout, no contact sheet, no reference sheet'];
 const raw={version:DIRECTOR_RENDERING_BRIEF_VERSION,subjectIdentity,visualCharacter,scalePresence,environmentStyle,lighting,materialIdentity,compositionRules,avoidVisuals};
 // Priority budget is deterministic and applies before model adaptation. Never truncate words.
 let count=0;for(const field of ['subjectIdentity','materialIdentity','scalePresence','visualCharacter','lighting','environmentStyle','compositionRules'] as const)raw[field]=[...new Set(raw[field])].filter(()=>++count<=26);
 return directorRenderingBriefSchema.parse(raw);
}
export function renderKreaDirectorBrief(brief:Brief):string{
 const ordered=[brief.subjectIdentity,brief.materialIdentity,brief.scalePresence,brief.visualCharacter,brief.lighting,brief.environmentStyle,brief.compositionRules,brief.avoidVisuals].flat();
 let words=0;return ordered.filter(phrase=>{const n=phrase.split(/\s+/).length;if(words+n>250)return false;words+=n;return true;}).join('. ')+'.';
}
