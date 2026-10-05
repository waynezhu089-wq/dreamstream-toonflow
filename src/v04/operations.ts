import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { Knex } from 'knex';
import { db } from '@/utils/db';
import getPath from '@/utils/getPath';
import { PilotError } from './service';
import { localComfyOrigin } from './comfyDraftClient';
import { profileExample, workflowRegistry, routingDefaults, routingTasks, type RoutingTask } from './operationsRegistry';
const q = db as Knex;
const project = z.object({projectId: z.number().int().positive()}).strict();
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function currentRouting(trx: Knex | Knex.Transaction, projectId: number) {
  const row = await trx('o_v04RoutingChange').where({projectId}).orderBy('version','desc').first();
  return { version: row?.version ?? 0, routes: row ? JSON.parse(row.routesJson) : {...routingDefaults},
    disabledProfiles: row ? JSON.parse(row.disabledProfilesJson) : [], changedBy: row?.actorUserId ?? null, changedAt: row?.createdAt ?? null };
}
export async function resolveEditRouting(trx: Knex.Transaction, projectId: number, task: RoutingTask) {
  const routing = await currentRouting(trx, projectId), profile = routing.routes[task];
  if (routing.disabledProfiles.includes(profile)) throw new PilotError('PILOT_IMAGE_ROUTING_DISABLED', '当前图片修改暂时不可用，现有资产未改变。', 409);
  return {profile, routingVersion: routing.version};
}
const routingRequest = project.extend({ requestId: z.string().uuid(), reset: z.boolean().default(false),
  routes: z.record(z.string(), z.string().max(100)).default({}), disabledProfiles: z.array(z.string().max(100)).max(6).default([]) }).strict();
function proposedRouting(data: z.infer<typeof routingRequest>, current: Awaited<ReturnType<typeof currentRouting>>) {
  const registry = workflowRegistry();
  for (const key of Object.keys(data.routes)) if (!routingTasks.includes(key as RoutingTask)) throw new PilotError('PILOT_ROUTE_INVALID','任务类型无效',400);
  const routes = data.reset ? {...routingDefaults} : {...current.routes, ...data.routes};
  for (const key of routingTasks) if (!registry.find(p => p.profile === routes[key] && p.capabilities.includes(key)))
    throw new PilotError('PILOT_ROUTE_INCOMPATIBLE','执行器能力不兼容',409);
  const disabledProfiles = data.reset ? [] : [...new Set(data.disabledProfiles)].sort();
  if (disabledProfiles.some(p => !registry.some(r => r.profile === p && r.wiring !== 'MANUAL_LEGACY')))
    throw new PilotError('PILOT_ROUTE_INVALID','只能禁用已注册 Agent profile',400);
  return {routes, disabledProfiles};
}
export async function previewRouting(input: unknown, trx: Knex | Knex.Transaction = q) {
  const data = routingRequest.parse(input), current = await currentRouting(trx, data.projectId), proposed = proposedRouting(data,current);
  const plan = {projectId: data.projectId, requestId: data.requestId, current, proposed, scope:'THIS_PROJECT', affectedTaskTypes: routingTasks.filter(k =>
    current.routes[k] !== proposed.routes[k] || current.disabledProfiles.includes(current.routes[k]) !== proposed.disabledProfiles.includes(proposed.routes[k]))};
  return {...plan, previewHash: digest(plan), request: data};
}
export async function applyRouting(input: unknown, actorUserId: number) {
  const data = routingRequest.extend({previewHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true)}).parse(input);
  const {previewHash, confirmed: _confirmed, ...request} = data;
  return q.transaction(async trx => {
    await trx('o_project').where({id:data.projectId}).update({id:data.projectId});
    const prior = await trx('o_v04RoutingChange').where({projectId:data.projectId,requestId:data.requestId}).first();
    if (prior) {
      if (prior.requestHash !== digest(request) || prior.previewHash !== previewHash) throw new PilotError('PILOT_ROUTE_ID_CONFLICT','请求身份冲突',409);
      return {applied:true,replayed:true,version:prior.version};
    }
    const plan = await previewRouting(request,trx);
    if (plan.previewHash !== previewHash) throw new PilotError('PILOT_PREVIEW_STALE','路由已改变，请重新预览',409);
    const version = plan.current.version + 1;
    await trx('o_v04RoutingChange').insert({projectId:data.projectId,version,requestId:data.requestId,requestHash:digest(request),previewHash,
      routesJson:JSON.stringify(plan.proposed.routes),disabledProfilesJson:JSON.stringify(plan.proposed.disabledProfiles),actorUserId,createdAt:Date.now()});
    return {applied:true,replayed:false,version};
  });
}
export function runtimeCommit() {
  try { return execFileSync('git',['-c',`safe.directory=${process.cwd()}`,'rev-parse','HEAD'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return null; }
}
const loadedCommit = runtimeCommit();
export async function inspectOperations(input: unknown) {
  const {projectId} = project.parse(input), config = await q('o_v04StudioImageExecutorConfig').where({projectId}).first();
  const baseUrl = localComfyOrigin(config?.baseUrl ?? 'http://127.0.0.1:8188'), registry = workflowRegistry(config?.checkpoint);
  let comfy: any = {baseUrl,status:'OFFLINE',version:null,devices:null,queue:null};
  try {
    const read = async (route: string) => {const r=await fetch(baseUrl+route,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('COMFY_HTTP');return r.json() as Promise<any>;};
    const [stats,nodes,queue] = await Promise.all([read('/system_stats'),read('/object_info'),read('/queue').catch(()=>null)]);
    comfy = {baseUrl,status:'ONLINE',version:stats.system?.comfyui_version ?? null,
      devices:(stats.devices??[]).map((d:any)=>({name:d.name,type:d.type,vram_total:d.vram_total,vram_free:d.vram_free,torch_vram_total:d.torch_vram_total,torch_vram_free:d.torch_vram_free})),
      queue:queue?{running:queue.queue_running?.length??null,pending:queue.queue_pending?.length??null}:null};
    for(const profile of registry){
      const missingNodes=profile.requiredNodes.filter(n=>!nodes[n]);
      const missingModels=profile.models.filter(m=>{const options=nodes[m.node]?.input?.required?.[m.field]?.[0];return !Array.isArray(options)||!options.includes(m.file);}).map(m=>m.file);
      Object.assign(profile,{health:missingNodes.length?'MISSING_NODE':missingModels.length?'MISSING_MODEL':'READY',missingNodes,missingModels});
    }
  }catch{for(const p of registry)Object.assign(p,{health:'UNKNOWN',missingNodes:[],missingModels:[]});}
  return {environment:'EXPERIMENTAL',stable:'PROTECTED',backend:{status:'ONLINE',commit:loadedCommit,dataDirectory:getPath()},comfy,registry:registry.map(p=>({...p,sourceCommit:loadedCommit})),
    routing:await currentRouting(q,projectId),legacyConfig:config?{baseUrl,enabled:!!config.enabled,executorProfile:config.executorProfile,checkpoint:config.checkpoint}:null};
}
const traceColumns = ['id','jobId','projectId','scriptId','canonicalKey','generationIntent','executionPurpose','executorProfile','workflowVersion','workflowSourceType','workflowGraphHash','comfyPromptId','status','errorCode','createdAt','submittedAt','completedAt'];
export async function recentExecutions(input: unknown) {
  const data=project.extend({filter:z.enum(['All','Running','Failed','Krea','ZImage','Asset']).default('All'),canonicalKey:z.string().max(128).optional()}).parse(input);
  let query=q('o_v04ExecutionTrace').where({projectId:data.projectId});
  if(data.filter==='Running')query=query.whereIn('status',['QUEUED','RUNNING']);
  if(data.filter==='Failed')query=query.where({status:'FAILED'});
  if(data.filter==='Krea')query=query.where('executorProfile','like','KREA2_%');
  if(data.filter==='ZImage')query=query.where('executorProfile','like','Z_IMAGE_%');
  if(data.canonicalKey)query=query.where({canonicalKey:data.canonicalKey});
  return query.select(traceColumns).orderBy('createdAt','desc').orderBy('id','desc').limit(50);
}
export async function executionDetail(input: unknown) {
  const data=project.extend({traceId:z.string().uuid()}).parse(input), row=await q('o_v04ExecutionTrace').where({projectId:data.projectId,id:data.traceId}).first();
  if(!row)throw new PilotError('PILOT_TRACE_NOT_FOUND','执行记录不存在',404);
  return row;
}
export function workflowExample(input: unknown) {
  const data=project.extend({profile:z.string().max(100)}).parse(input);
  if(!workflowRegistry().some(p=>p.profile===data.profile))throw new PilotError('PILOT_PROFILE_INVALID','执行器不存在',400);
  return {exampleOnly:true,graph:profileExample(data.profile).graph};
}
