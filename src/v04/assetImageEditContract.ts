import { z } from 'zod';
export const imageEditIntent = z.object({
  canonicalKey: z.string().min(1).max(128),
  editMode: z.enum(['TEXT_EDIT','REFERENCE_EDIT','DERIVE_VIEW','STYLE_VARIANT']),
  targetRole: z.enum(['EDIT_CANDIDATE','STYLE_VARIANT','FACE_HERO','FULL_BODY_FRONT','FULL_BODY_BACK','SIDE_SPECIAL_LEFT','SIDE_SPECIAL_RIGHT','DETAIL_REFERENCE']),
  sourceFocus: z.enum(['FACE','BODY','BACK']).default('BODY'),
  editPrompt: z.string().min(1).max(4000),
  preserveIntent: z.object(Object.fromEntries(['identity','face','hairstyle','costume','palette','silhouette','proportions','material','composition'].map(k=>[k,z.enum(['HIGH','MEDIUM','LOW']).default('HIGH')]))).default({}),
  referenceBindings: z.array(z.object({attachmentId:z.string().uuid(),role:z.enum(['STYLE_REFERENCE','COSTUME_REFERENCE','LIGHTING_REFERENCE','MATERIAL_REFERENCE','POSE_REFERENCE','COMPOSITION_REFERENCE','DETAIL_REFERENCE'])}).strict()).max(4).default([]),
}).strict();
export type ImageEditIntent = z.infer<typeof imageEditIntent>;
export function sourceRolePriority(intent: ImageEditIntent) {
 if (intent.targetRole==='FULL_BODY_BACK'||intent.sourceFocus==='BACK') return ['FULL_BODY_BACK','FULL_BODY_FRONT','MAIN_PREVIEW'];
 if (intent.targetRole==='FACE_HERO'||intent.sourceFocus==='FACE')return ['FACE_HERO','FULL_BODY_FRONT','MAIN_PREVIEW'];
 return ['FULL_BODY_FRONT','MAIN_PREVIEW','FACE_HERO'];
}
export function editExecutionPrompt(intent: ImageEditIntent) {
 const view:Record<string,string>={FACE_HERO:'Create a chest-up portrait of this same subject, looking directly at the camera.',FULL_BODY_BACK:'Show this exact same subject from the back, full body, preserve the same clothes and colors.',FULL_BODY_FRONT:'Show this exact same subject facing directly forward, full body.',SIDE_SPECIAL_LEFT:'Show this same subject in a true left profile.',SIDE_SPECIAL_RIGHT:'Show this same subject in a true right profile.'};
 return [view[intent.targetRole]??'Edit the source image; do not replace the subject with a new design.',intent.editPrompt,
  'Preserve '+Object.entries(intent.preserveIntent).filter(([,v])=>v==='HIGH').map(([k])=>k).join(', ')+'.',
  intent.referenceBindings.length?'Image 1 provides the external reference. Image 2 is the source subject: preserve its identity and clothing. Use the external image ONLY for these aspects: '+intent.referenceBindings.map(x=>x.role).join(', ')+'.':'The source image is the identity and appearance reference.',
  'No invented accessories. Candidate only; preservation is a requested constraint, not a verified guarantee.'].join(' ');
}
