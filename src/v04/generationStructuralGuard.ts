import {createHash} from 'node:crypto';
import type {IntegrityProfileKey} from './integrityProfileResolver';
export const GENERATION_GUARD_VERSION='generation.structural-guard.1';
export type GuardInput={profile:IntegrityProfileKey;targetView:string;identityAuthority:string;sourceDimensions:{width:number;height:number};confirmedCounts:{part:string;count:number}[];identityAnchors?:string[];mustPreserve?:string[];forbiddenChanges?:string[];confirmedMorphology?:unknown};
const structure:Record<IntegrityProfileKey,string>={HUMAN:'Keep natural limb attachment and stable body proportions; preserve reference clothing and footwear.',ANIMAL:'Keep the confirmed animal body structure and naturally attached limbs, fins, paws and tail where present.',FANTASY_CREATURE:'Keep confirmed fictional morphology and naturally attached confirmed appendages; ordinary animal priors must not remove them.',VEHICLE:'Keep the reference hull/body, functional assemblies and coherent attachment and axes of existing components.',PROP:'Keep coherent handles, openings, connectors and supporting geometry where present.',FURNITURE:'Keep coherent seat/back/support relationships and plausible weight support.',MACHINE:'Keep connected components, housing and functional interfaces.',ARCHITECTURE:'Keep coherent supports, floors, openings and perspective.',GENERIC_STRUCTURED_ASSET:'Keep coherent part attachment, proportions, support and materials.'};
export function buildGenerationStructuralGuard(input:GuardInput){
 const constraints=['One complete single subject, large enough for structural reading without cropping critical parts; clean unobtrusive background.',structure[input.profile]];
 if(input.profile==='HUMAN'&&input.targetView==='BACK')constraints.push('Hands, heels, feet and limb joints follow the rear-facing body orientation.');
 if(input.targetView==='SIDE')constraints.push('One side-oriented figure only; occluded parts remain attached, not duplicated or falsely removed.');
 if(['ANIMAL','FANTASY_CREATURE'].includes(input.profile)&&input.targetView==='BACK')constraints.push('Rear limb and existing tail/wing-root attachment follow the rear orientation.');
 if(input.profile==='VEHICLE'&&input.targetView==='BACK')constraints.push('Keep rear assembly and existing axle/rudder/propeller direction coherent.');
 for(const fact of input.confirmedCounts.slice(0,12)){if(Number.isInteger(fact.count)&&fact.count>=0&&fact.count<=30&&/^[\p{L} _-]{1,50}$/u.test(fact.part))constraints.push(`Preserve confirmed ${fact.part} count: ${fact.count}; occlusion does not change structural count.`);}
 const output={version:GENERATION_GUARD_VERSION,input,viewRiskProfile:`${input.profile}.${input.targetView}`,occupancy:'REFERENCE_VIEW_SUBJECT_OCCUPANCY',constraints};
 return {...output,hash:createHash('sha256').update(JSON.stringify(output)).digest('hex')};
}
