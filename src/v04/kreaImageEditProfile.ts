import { DraftComfyError, type DraftWorkflow } from './comfyDraftClient';
export const kreaEditProfiles=['KREA2_T2I_ASSET_V1','KREA2_SOURCE_EDIT_V1','KREA2_REFERENCE_EDIT_V1','KREA2_DERIVE_CHARACTER_REFERENCE_V1'] as const;
export const KREA_EDIT_WORKFLOW_VERSION='krea2-identity-edit-1.2-fit-v1';
export const kreaModels={unet:'krea2_turbo_fp8_scaled.safetensors',clip:'qwen3vl_4b_fp8_scaled.safetensors',vae:'qwen_image_vae.safetensors',lora:'krea2_identity_edit_v1_2.safetensors'};
export function buildKreaEditWorkflow(input:{profile:string;prompt:string;seed:number;width?:number;height?:number;sourceImage?:string;referenceImage?:string;targetRole:string;jobId:string}):DraftWorkflow{
 const g:any={
  '1':{class_type:'UNETLoader',inputs:{unet_name:kreaModels.unet,weight_dtype:'default'}},
  '2':{class_type:'CLIPLoader',inputs:{clip_name:kreaModels.clip,type:'krea2',device:'cpu'}},
  '3':{class_type:'VAELoader',inputs:{vae_name:kreaModels.vae}},
  '4':{class_type:'EmptySD3LatentImage',inputs:{width:input.width??768,height:input.height??768,batch_size:1}},
  '20':{class_type:'KSampler',inputs:{model:['1',0],positive:['5',0],negative:['6',0],latent_image:['4',0],seed:input.seed,steps:8,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:1}},
  '21':{class_type:'VAEDecodeTiled',inputs:{samples:['20',0],vae:['3',0],tile_size:256,overlap:64,temporal_size:64,temporal_overlap:8}},
  '22':{class_type:'SaveImage',inputs:{images:['21',0],filename_prefix:'DreamStreamV04Edit_'+input.jobId.slice(0,8)}},
 };
 if(input.profile==='KREA2_T2I_ASSET_V1'){
  if(input.sourceImage||input.referenceImage)throw new DraftComfyError('CAPABILITY_LIMITED','有源图的编辑不能降级成纯文生图');
  g['5']={class_type:'CLIPTextEncode',inputs:{clip:['2',0],text:input.prompt}};
 }else{
  if(!input.sourceImage)throw new DraftComfyError('SOURCE_MISSING','当前素材尚无可用于修改的图片');
  g['7']={class_type:'LoadImage',inputs:{image:input.sourceImage}};
  g['8']={class_type:'VAEEncode',inputs:{pixels:['7',0],vae:['3',0]}};
  g['9']={class_type:'LoraLoaderModelOnly',inputs:{model:['1',0],lora_name:kreaModels.lora,strength_model:1}};
  const patch:any={model:['9',0],source_latent:['8',0],vae:['3',0],source_image:['7',0],target_latent:['4',0],fit_mode:'fit',ref_boost:4,ref_boost_a:1};
  const encode:any={clip:['2',0],prompt:input.prompt,image:['7',0],grounding_px:768};
  if(input.referenceImage){
   g['10']={class_type:'LoadImage',inputs:{image:input.referenceImage}};
   g['11']={class_type:'VAEEncode',inputs:{pixels:['10',0],vae:['3',0]}};
   // Training-matched ordering: external scene/style first, identity subject second.
   patch.source_latent=['11',0];patch.source_image=['10',0];patch.source_latent_b=['8',0];patch.source_image_b=['7',0];
   encode.image=['10',0];encode.image_b=['7',0];
  }
  g['12']={class_type:'Krea2EditModelPatch',inputs:patch};
  g['5']={class_type:'Krea2EditGroundedEncode',inputs:encode};g['20'].inputs.model=['12',0];
 }
 g['6']={class_type:'ConditioningZeroOut',inputs:{conditioning:['5',0]}};
 return {graph:g,outputNode:'22',role:input.targetRole,version:KREA_EDIT_WORKFLOW_VERSION};
}
export async function uploadEditInput(base:string,bytes:Buffer,name:string){
 const body=new FormData();body.append('image',new Blob([new Uint8Array(bytes)],{type:'image/png'}),name);body.append('overwrite','false');
 const r=await fetch(base+'/upload/image',{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new DraftComfyError('EXECUTION_FAILED','参考图片传递失败');
 const result:any=await r.json();if(typeof result.name!=='string'||!/^[-\w.]+$/.test(result.name)||result.type!=='input'||(result.subfolder&&result.subfolder!==''))throw new DraftComfyError('EXECUTION_FAILED','执行器返回的输入位置无效');return result.name as string;
}
