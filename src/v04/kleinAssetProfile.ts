import type {DraftWorkflow} from './comfyDraftClient';
export const KLEIN_ASSET_VIEW_V1='KLEIN_ASSET_VIEW_V1';
export const KLEIN_ASSET_WORKFLOW_VERSION='klein.asset-view.1';
export const kleinModels={unet:'flux-2-klein-4b-Q4_K_M.gguf',clip:'qwen_3_4b_fp8_mixed.safetensors',vae:'flux2-vae.safetensors'};
// The real Pilot's reference-conditioned topology. Never load a user's mutable JSON at runtime.
export function buildKleinAssetWorkflow(input:{prompt:string;sourceImage:string;seed:number;targetRole:string;jobId:string}):DraftWorkflow{
 const node=(class_type:string,inputs:Record<string,unknown>)=>({class_type,inputs});
 return {version:KLEIN_ASSET_WORKFLOW_VERSION,role:input.targetRole,outputNode:'22',graph:{
 '1':node('UnetLoaderGGUF',{unet_name:kleinModels.unet}),'2':node('CLIPLoader',{clip_name:kleinModels.clip,type:'flux2',device:'cpu'}),
 '3':node('VAELoader',{vae_name:kleinModels.vae}),'4':node('LoadImage',{image:input.sourceImage}),
 '5':node('ImageScaleToTotalPixels',{image:['4',0],upscale_method:'lanczos',megapixels:0.6,resolution_steps:16}),
 '6':node('VAEEncode',{pixels:['5',0],vae:['3',0]}),'7':node('EmptyFlux2LatentImage',{width:768,height:1024,batch_size:1}),
 '8':node('RandomNoise',{noise_seed:input.seed}),'9':node('Flux2Scheduler',{steps:4,width:768,height:1024}),'10':node('KSamplerSelect',{sampler_name:'euler'}),
 '11':node('CLIPTextEncode',{clip:['2',0],text:input.prompt}),'12':node('ReferenceLatent',{conditioning:['11',0],latent:['6',0]}),
 '13':node('BasicGuider',{model:['1',0],conditioning:['12',0]}),
 '14':node('SamplerCustomAdvanced',{noise:['8',0],guider:['13',0],sampler:['10',0],sigmas:['9',0],latent_image:['7',0]}),
 '21':node('VAEDecode',{samples:['14',0],vae:['3',0]}),'22':node('SaveImage',{images:['21',0],filename_prefix:'DreamStream_Draft/'+input.jobId.replace(/[^a-zA-Z0-9_-]/g,'')})}};
}
export async function assertKleinAvailable(base:string){
 const {DraftComfyError}=await import('./comfyDraftClient');
 const r=await fetch(base+'/object_info',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw new DraftComfyError('WORKFLOW_UNAVAILABLE','多视角执行器不可用');
 const info:any=await r.json(),wf=buildKleinAssetWorkflow({prompt:'example',sourceImage:'example.png',seed:1,targetRole:'SIDE_PROFILE',jobId:'example'});
 for(const n of Object.values(wf.graph) as any[]){if(!info[n.class_type])throw new DraftComfyError('WORKFLOW_UNAVAILABLE','多视角节点尚未就绪');for(const key of ['unet_name','clip_name','vae_name'])if(n.inputs[key]&&!info[n.class_type]?.input?.required?.[key]?.[0]?.includes(n.inputs[key]))throw new DraftComfyError('WORKFLOW_UNAVAILABLE','多视角模型尚未就绪');}
}
