const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toonflow-adapter-'));
  const cache = new Map();
  let wrapper,utils;const calls=[],writes=[],probe={fail:false};
  // Only legacy bootstrap and path selection are isolated. The actual db.ts
  // creates Knex, its SQLite connection and the production callable wrapper.
  // Full legacy bootstrap is also exercised by the real startup smoke check.
  function load(name) {
    const file = path.join(root, 'src', name + '.ts');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }, fileName: file }).outputText;
    new Function('require', 'module', 'exports', code)(id => {
      if (id === '@/utils/getPath') return name => path.join(dir, name);
      if (id === '@/lib/initDB' || id === '@/lib/fixDB') return async () => {};
      if(id==='@/utils')return utils;
      if(id==='ai')return {tool:x=>x,jsonSchema:x=>x,Output:require('ai').Output,NoObjectGeneratedError:require('ai').NoObjectGeneratedError};
      if(['axios','@ai-sdk/devtools','lodash'].includes(id))return {};
      if(id==='sucrase')return {transform:x=>({code:x})};
      if(id==='uuid')return {v4:require('node:crypto').randomUUID};
      if (id.startsWith('@/')) return load(id.slice(2));
      if(id.startsWith('.'))return load(path.posix.normalize(path.posix.join(path.posix.dirname(name),id))); 
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const { default: db, db: raw } = load('utils/db');
  wrapper = db;
  utils={db,error:e=>e,uuid:require('node:crypto').randomUUID,replaceUrl:x=>x,
    oss:{getSmallImageUrl:async x=>x,writeFile:async (p,bytes)=>writes.push({p,bytes}),getImageBase64:async x=>x},
    vendor:{getModelList:async()=>[{modelName:'image',type:'image'}],getCode:()=>'',getVendor:()=>({version:'2.0'})},
    vm:()=>({imageRequest:async input=>{calls.push(input);if(probe.fail)throw Error('provider failed');return 'test-image-bytes';}})};
  utils.Ai=load('utils/ai').default;utils.task=load('utils/taskRecord').default;
  await new Promise(resolve => setImmediate(resolve));
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;
  t.after(async () => { await raw.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.notEqual(db, raw);
  assert.equal(typeof db, 'function');
  assert.equal(typeof db.transaction, 'function');
  await raw.schema.createTable('o_project', t => { t.integer('id').primary(); t.string('projectType'); t.string('type'); });
  await raw.schema.createTable('o_script', t => { t.integer('id').primary(); t.integer('projectId'); t.integer('createTime'); });
  await raw.schema.createTable('o_assets', t => { t.increments('id'); t.integer('projectId'); t.integer('scriptId'); t.integer('imageId'); t.integer('assetsId'); t.string('name'); t.string('type'); t.string('prompt'); t.bigInteger('startTime'); });
  await raw.schema.createTable('o_image', t => { t.increments('id'); t.integer('assetsId'); t.string('filePath'); t.string('state'); t.string('model'); t.string('type'); });
  await raw.schema.createTable('o_scriptAssets', t => { t.integer('scriptId'); t.integer('assetId'); t.primary(['scriptId', 'assetId']); });
  await raw.schema.createTable('o_agentWorkData', t => { t.increments('id'); t.integer('projectId'); t.integer('episodesId'); t.string('key'); t.text('data'); t.integer('updateTime'); t.integer('createTime'); });
  await db('o_project').insert([{ id: 1, projectType: 'general_video', type: 'advertisement' }, { id: 2, projectType: 'general_video', type: 'advertisement' }, { id: 3, projectType: 'short_drama', type: 'story' }]);
  await db('o_script').insert([{ id: 10, projectId: 1 }, { id: 11, projectId: 1 }, { id: 20, projectId: 2 }, { id: 30, projectId: 3 }]);
  await db('o_assets').insert([{ id: 1, projectId: 1, imageId: 1 }, { id: 2, projectId: 1, imageId: 2 }, { id: 3, projectId: 2, imageId: 3 }]);
  await db('o_image').insert([1, 2, 3].map(id => ({ id, assetsId: id, filePath: '/generated/' + id, state: '已完成', model: 'test-ai' })));
  await db('o_scriptAssets').insert([{ scriptId: 10, assetId: 1 }, { scriptId: 11, assetId: 2 }, { scriptId: 20, assetId: 3 }]);

  
  await raw.schema.alterTable('o_project',t=>{for(const s of ['imageModel','videoModel','imageQuality','videoRatio','artStyle'])t.string(s);});
  await raw.schema.alterTable('o_script',t=>t.text('content'));
  await raw.schema.alterTable('o_image',t=>t.string('errorReason'));
  await raw.schema.alterTable('o_assets',t=>{t.text('describe');t.integer('flowId');});
  await raw.schema.createTable('o_storyboard',t=>{t.increments('id');for(const k of ['projectId','scriptId','trackId','flowId','index','shouldGenerateImage','createTime'])t.integer(k);for(const k of ['prompt','duration','state','filePath','reason','track','videoDesc','title'])t.text(k);});
  await raw.schema.createTable('o_videoTrack',t=>{t.integer('id').primary().notNullable();t.integer('projectId');t.integer('scriptId');t.float('duration');});
  await raw.schema.createTable('o_assets2Storyboard',t=>{t.integer('assetId');t.integer('storyboardId');});
  await raw.schema.createTable('o_imageFlow',t=>t.increments('id'));
  await raw.schema.createTable('o_video',t=>{t.increments('id');t.integer('projectId');t.integer('scriptId');});
  await raw.schema.createTable('o_vendorConfig',t=>{t.string('id').primary();t.integer('enable');t.text('inputValues');});
  await raw.schema.createTable('o_tasks',t=>{t.increments('id');t.integer('projectId');t.bigInteger('startTime');for(const k of ['taskClass','relatedObjects','model','describe','state','reason'])t.text(k);});
  await load('lib/advertisementAssetPlanSchema').initializeAssetPlanSchema(db);
  await load('lib/modelPresetSchema').initializeModelPresetSchema(db);
  const migrate=load('lib/storyboardProductionSchema').initializeStoryboardProductionSchema;await migrate(db);await migrate(db);
  await db('o_vendorConfig').insert({id:'vendor',enable:1});
  await db('o_image').update({model:null});
  await db('o_assetUploadSource').insert([1,2,3].map(id=>({projectId:id===3?2:1,assetId:id,imageId:id,filePath:'/generated/'+id,uploadedAt:Date.now()})));
  const plan=load('services/advertisementAssetPlan');
  for(const [projectId,scriptId,id] of [[1,10,1],[1,11,2],[2,20,3]]){
   await plan.saveAssetPlan({projectId,scriptId,items:[{assetKey:'screen',name:'Uploaded screen',category:'UI',required:true,sourcePolicy:'REAL_REQUIRED',assetId:id}]});
   await db('o_agentWorkData').insert({projectId,episodesId:scriptId,key:'advertisement:asset-preparation',data:'{"confirmed":true}'});
  }
  const express=require('express'),app=express();app.use(express.json());
  app.use(load('middleware/modelUseGate').modelUseGate);load('middleware/productionGate').registerProductionGate(app);
  for(const name of ['addStoryboard','batchAddStoryboardInfo','replaceStoryboard','editStoryboardInfo','getStoryboardData','batchGenerateImage','pollingImage'])app.use('/api/production/storyboard/'+name,load('routes/production/storyboard/'+name).default);
  app.use('/api/production/getFlowData',load('routes/production/getFlowData').default);
  app.use('/api/production/getStoryboardData',load('routes/production/getStoryboardData').default);
  app.use('/api/production/saveFlowData',load('routes/production/saveFlowData').default);
  app.use('/api/production/storyboard/composite',load('routes/production/storyboard/composite').default);
  app.use('/api/capabilities',load('routes/capabilities/index').default);
  app.use((e,req,res,next)=>res.status(500).json({message:e.message}));
  const server=app.listen(0,'127.0.0.1');await require('events').once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  async function post(route,body,status=200){const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/production/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await res.json();assert.equal(res.status,status,JSON.stringify(json));return json.data??json;}
  const ctx={projectId:1,scriptId:10};
  const item=(overrides={})=>({prompt:'A shot',videoDesc:'Screen',duration:3,track:'Main',state:'未生成',src:null,shouldGenerateImage:0,associateAssetsIds:[1],productionMode:'REAL_ASSET_DIRECT',primaryAssetId:1,referenceAssetIds:[],referenceAssetGroupIds:[],promptSkillId:null,promptSkillVersion:null,capabilityId:null,...overrides});
  const create=async overrides=>post('storyboard/addStoryboard',{...ctx,...item(overrides)});
  async function generate(ids,context=ctx){await post('storyboard/batchGenerateImage',{...context,storyboardIds:ids,compulsory:true});for(let i=0;i<100;i++){const rows=await db('o_storyboard').whereIn('id',ids);if(rows.every(r=>r.state!=='生成中'))return rows;await new Promise(r=>setTimeout(r,10));}throw Error('generation timed out');}
  const config=async()=>load('services/modelPreset').patchProject({projectId:1,slots:{image:'vendor:image'}});
  async function postCapability(route,body,status=200){const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/capabilities/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await response.json();assert.equal(response.status,status,JSON.stringify(json));return json.data??json;}
  return {db,raw,load,ctx,post,postCapability,item,create,generate,config,calls,writes,probe,plan,utils};
}


module.exports={fixture};
