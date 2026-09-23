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
      if(id==='ai')return {tool:x=>x,jsonSchema:x=>x};
      if(['sharp','axios','@ai-sdk/devtools','lodash'].includes(id))return {};
      if(id==='sucrase')return {transform:x=>({code:x})};
      if(id==='uuid')return {v4:require('node:crypto').randomUUID};
      if (id.startsWith('@/')) return load(id.slice(2));
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
  app.use((e,req,res,next)=>res.status(500).json({message:e.message}));
  const server=app.listen(0,'127.0.0.1');await require('events').once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  async function post(route,body,status=200){const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/production/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await res.json();assert.equal(res.status,status,JSON.stringify(json));return json.data??json;}
  const ctx={projectId:1,scriptId:10};
  const item=(overrides={})=>({prompt:'A shot',videoDesc:'Screen',duration:3,track:'Main',state:'未生成',src:null,shouldGenerateImage:0,associateAssetsIds:[1],productionMode:'REAL_ASSET_DIRECT',primaryAssetId:1,referenceAssetIds:[],referenceAssetGroupIds:[],promptSkillId:null,promptSkillVersion:null,capabilityId:null,...overrides});
  const create=async overrides=>post('storyboard/addStoryboard',{...ctx,...item(overrides)});
  async function generate(ids,context=ctx){await post('storyboard/batchGenerateImage',{...context,storyboardIds:ids,compulsory:true});for(let i=0;i<100;i++){const rows=await db('o_storyboard').whereIn('id',ids);if(rows.every(r=>r.state!=='生成中'))return rows;await new Promise(r=>setTimeout(r,10));}throw Error('generation timed out');}
  const config=async()=>load('services/modelPreset').patchProject({projectId:1,slots:{image:'vendor:image'}});
  return {db,raw,load,ctx,post,item,create,generate,config,calls,writes,probe,plan};
}

test('HTTP add/read/edit/replace preserve all seven fields; schema migration is additive and idempotent',async t=>{
 const f=await fixture(t);const fields={productionMode:'AI_REFERENCE_GENERATE',primaryAssetId:1,referenceAssetIds:[1],referenceAssetGroupIds:['product-views-v1'],promptSkillId:'layout',promptSkillVersion:'v2',capabilityId:'future.reference.v1'};
 const shot=await f.create(fields);const read=await f.post('storyboard/getStoryboardData',{...f.ctx,page:1,limit:20});
 for(const k of Object.keys(fields))assert.deepEqual(read.data[0][k],fields[k]);
 await f.post('storyboard/editStoryboardInfo',{id:shot.id,...f.ctx,prompt:'Rewritten',videoDesc:'New description'});
 let row=await f.db('o_storyboard').where({id:shot.id}).first();for(const k of Object.keys(fields))assert.deepEqual(f.load('services/storyboardProduction').productionSpec(row)[k],fields[k]);
 const replaced=await f.post('storyboard/replaceStoryboard',{...f.ctx,data:[f.item({...fields,shouldGenerateImage:'true'})]});
 for(const k of Object.keys(fields))assert.deepEqual(replaced[0][k],fields[k]);
 const overview=await f.post('getStoryboardData',f.ctx);for(const k of Object.keys(fields))assert.deepEqual(overview[0][k],fields[k]);
 await f.post('saveFlowData',{projectId:1,episodesId:10,data:{storyboard:replaced}});
 const flow=await f.post('getFlowData',{projectId:1,episodesId:10});for(const k of Object.keys(fields))assert.deepEqual(flow.storyboard[0][k],fields[k]);
 assert.equal((await f.db('o_storyboard')).length,1);
});

test('batch add persists modes and metadata; partial edits retain fields and invalidate stale output',async t=>{
 const f=await fixture(t);const rows=await f.post('storyboard/batchAddStoryboardInfo',{...f.ctx,data:[f.item(),f.item({productionMode:'REAL_AI_COMPOSITE',promptSkillId:'layout',promptSkillVersion:'2'})]});
 assert.deepEqual(rows.map(r=>r.productionMode),['REAL_ASSET_DIRECT','REAL_AI_COMPOSITE']);
 await f.generate([rows[0].id]);
 await f.post('storyboard/editStoryboardInfo',{id:rows[0].id,prompt:'changed',videoDesc:'screen',capabilityId:'toonflow.real-asset-direct.v1'});
 const read=await f.post('storyboard/getStoryboardData',{...f.ctx,page:1,limit:10});assert.equal(read.data[0].productionMode,'REAL_ASSET_DIRECT');assert.equal(read.data[0].primaryAssetId,1);assert.equal(read.data[0].state,'未生成');assert.equal(read.data[0].src,'');
});

test('direct mode uses current real file verbatim without a model, task or paid provider',async t=>{
 const f=await fixture(t),shot=await f.create();const [row]=await f.generate([shot.id]);
 assert.equal(row.state,'已完成');assert.equal(row.filePath,'/generated/1');assert.equal(row.shouldGenerateImage,0);
 assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);assert.equal((await f.db('o_tasks')).length,0);
});

test('invalid or foreign primary assets fail before creation and replacement never deletes existing shots',async t=>{
 const f=await fixture(t);const shot=await f.create();
 for(const assetId of [999,2,3]){
  await f.post('storyboard/addStoryboard',{...f.ctx,...f.item({primaryAssetId:assetId})},409);
  await f.post('storyboard/replaceStoryboard',{...f.ctx,data:[f.item({primaryAssetId:assetId,shouldGenerateImage:'false'})]},409);
 }
 assert.ok(await f.db('o_storyboard').where({id:shot.id}).first());
 await f.post('storyboard/getStoryboardData',{projectId:2,scriptId:10,page:1,limit:10},400);
 await f.post('storyboard/editStoryboardInfo',{projectId:1,scriptId:11,id:shot.id,prompt:'x',videoDesc:'x'},400);
 await f.post('storyboard/batchGenerateImage',{projectId:1,scriptId:11,storyboardIds:[shot.id]},400);
});

test('direct revalidates provenance, unit link, image completion and asset existence at dispatch',async t=>{
 const f=await fixture(t),shot=await f.create(),produce=f.load('services/storyboardProduction').produceAdvertisementStoryboard;
 const changes=[async()=>f.db('o_assetUploadSource').delete(),async()=>f.db('o_scriptAssets').where({assetId:1}).delete(),async()=>f.db('o_image').where({id:1}).update({state:'生成失败'}),async()=>f.db('o_assets').where({id:1}).delete()];
 const tables=['o_assetUploadSource','o_scriptAssets','o_image','o_assets']; const snapshots=await Promise.all(tables.map(name=>f.db(name)));
 for(const mutate of changes){await mutate();const result=await produce(1,10,shot.id);assert.equal(result.state,'生成失败');for(let i=0;i<tables.length;i++){await f.db(tables[i]).delete();await f.db(tables[i]).insert(snapshots[i]);}}
 assert.equal(f.calls.length,0);
});

test('text-to-image uses real shared Ai.Image, preset resolution, task records and provider failure state',async t=>{
 const f=await fixture(t),shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[],promptSkillId:'scene',promptSkillVersion:'1'});
 let [row]=await f.generate([shot.id]);assert.equal(row.state,'生成失败');assert.match(row.reason,/请先配置图片生成模型/);assert.equal(f.calls.length,0);assert.equal((await f.db('o_tasks')).length,0);
 await f.config();[row]=await f.generate([shot.id]);assert.equal(row.state,'已完成');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].referenceList,[]);assert.equal(f.writes.length,1);
 let tasks=await f.db('o_tasks');assert.equal(tasks[0].state,'已完成');assert.equal(JSON.parse(tasks[0].relatedObjects).storyboardId,shot.id);assert.equal(JSON.parse(tasks[0].relatedObjects).promptSkillId,'scene');
 f.probe.fail=true;[row]=await f.generate([shot.id]);assert.equal(row.state,'生成失败');assert.equal(row.filePath,'');assert.match(row.reason,/provider failed/);
 tasks=await f.db('o_tasks').orderBy('id');assert.equal(tasks.at(-1).state,'生成失败');
});

test('reference and composite never fall back; text input and unknown capabilities are rejected',async t=>{
 const f=await fixture(t);await f.config();
 for(const data of [{productionMode:'AI_REFERENCE_GENERATE',referenceAssetIds:[1]},{productionMode:'REAL_AI_COMPOSITE'},{productionMode:'AI_TEXT_TO_IMAGE',referenceAssetIds:[1]},{productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,referenceAssetGroupIds:['views']},{productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,capabilityId:'comfy.z-image-turbo.txt2img.v1'}]){
  const shot=await f.create(data);const [row]=await f.generate([shot.id]);assert.equal(row.state,'生成失败');assert.match(row.reason,/CAPABILITY_(INPUT_UNSUPPORTED|NOT_IMPLEMENTED)/);
 }
 assert.equal(f.calls.length,0);assert.equal((await f.db('o_tasks')).length,0);
});

test('10-shot fixture reuses five real assets: seven direct outputs, three explicit composite failures, local retry only',async t=>{
 const f=await fixture(t);
 await f.db('o_assets').where({id:3}).delete();await f.db('o_image').where({id:3}).delete();await f.db('o_assetUploadSource').where({assetId:3}).delete();await f.db('o_scriptAssets').where({assetId:3}).delete();
 for(const id of [3,4,5,6,7]){await f.db('o_assets').insert({id,projectId:1,imageId:id});await f.db('o_image').insert({id,assetsId:id,state:'已完成',filePath:'/real/'+id});await f.db('o_scriptAssets').insert({scriptId:10,assetId:id});await f.db('o_assetUploadSource').insert({projectId:1,assetId:id,imageId:id,filePath:'/real/'+id,uploadedAt:1});}
 await f.plan.saveAssetPlan({...f.ctx,items:[3,4,5,6,7].map(id=>({assetKey:'screen-'+id,name:'Screen '+id,category:'UI',required:true,sourcePolicy:'REAL_REQUIRED',assetId:id}))});
 const refs=[6,6,6,5,6,4,7,4,3,3],composite=new Set([0,2,3]);
 const rows=await f.post('storyboard/replaceStoryboard',{...f.ctx,data:refs.map((id,i)=>f.item({productionMode:composite.has(i)?'REAL_AI_COMPOSITE':'REAL_ASSET_DIRECT',primaryAssetId:id,associateAssetsIds:[id],shouldGenerateImage:'false'}))});
 const output=await f.generate(rows.map(r=>r.id));assert.equal(output.filter(r=>r.state==='已完成').length,7);assert.equal(output.filter(r=>r.state==='生成失败').length,3);
 for(let i=0;i<10;i++)if(!composite.has(i))assert.equal(output[i].filePath,'/real/'+refs[i]);
 const before=output.slice(1);await f.generate([rows[0].id]);assert.deepEqual((await f.db('o_storyboard').orderBy('id')).slice(1),before);assert.equal(f.calls.length,0);
});

test('legacy profiles preserve shouldGenerateImage dispatch, no productionMode required; legacy ad rows require explicit mode',async t=>{
 const f=await fixture(t);await f.db('o_project').where({id:3}).update({imageModel:'vendor:image'});
 const ctx={projectId:3,scriptId:30};const items=[f.item({shouldGenerateImage:0,associateAssetsIds:[]}),f.item({shouldGenerateImage:1,associateAssetsIds:[]})].map(({productionMode,primaryAssetId,referenceAssetIds,referenceAssetGroupIds,promptSkillId,promptSkillVersion,capabilityId,...rest})=>rest);
 const rows=await f.post('storyboard/batchAddStoryboardInfo',{...ctx,data:items});await f.post('storyboard/batchGenerateImage',{...ctx,storyboardIds:rows.map(r=>r.id)});
 for(let i=0;i<100;i++){if((await f.db('o_storyboard').where({id:rows[1].id}).first()).state==='已完成')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal((await f.db('o_storyboard').where({id:rows[0].id}).first()).state,'未生成');assert.equal(f.calls.length,1);
 const shot=await f.create();await f.db('o_storyboard').where({id:shot.id}).update({productionSpec:null});const [row]=await f.generate([shot.id]);assert.match(row.reason,/PRODUCTION_MODE_REQUIRED/);assert.equal(f.calls.length,1);
});

test('actual Agent schemas and Socket add/replace preserve production fields without choosing the first association',async t=>{
 const f=await fixture(t),events=[];
 const output={appendText(){},updateTitle(){},complete(){}};
 const resTool={data:f.ctx,socket:{emit:(event,data,callback)=>{events.push({event,data});callback({success:true});}}};
 const tools=f.load('agents/productionAgent/tools').default({resTool,msg:{thinking:()=>output},advertisement:true});
 const shot=f.item({productionMode:'AI_REFERENCE_GENERATE',referenceAssetIds:[1],referenceAssetGroupIds:['multi-view'],promptSkillId:'layout',promptSkillVersion:'1',capabilityId:'future.ref',shouldGenerateImage:'false'});
 for(const key of Object.keys(f.load('services/storyboardProduction').productionFields))assert.ok(tools.add_flowData_storyboard.inputSchema.properties[key]);
 await tools.add_flowData_storyboard.execute(shot);
 await tools.replace_flowData_storyboard.execute({items:[shot]});
 for(const key of Object.keys(f.load('services/storyboardProduction').productionFields)){assert.deepEqual(events[0].data[key],shot[key]);assert.deepEqual(events[1].data.items[0][key],shot[key]);}
});

test('fresh real initDB builder and additive upgrade retain old rows without guessing modes',async t=>{
 const db=require('knex')({client:'better-sqlite3',connection:{filename:':memory:'},useNullAsDefault:true});t.after(()=>db.destroy());
 function moduleAt(name){const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(path.join(root,'src',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',code)(id=>id==='uuid'?{v4:require('node:crypto').randomUUID}:id==='@/utils/agent/embedding'?{getEmbedding:async()=>[]}:require(id),module,module.exports);return module.exports;}
 const migrate=moduleAt('lib/storyboardProductionSchema').initializeStoryboardProductionSchema;
 await migrate(db);await moduleAt('lib/initDB').default(db);assert.equal(await db.schema.hasColumn('o_storyboard','productionSpec'),true);
 await db.schema.alterTable('o_storyboard',t=>t.dropColumn('productionSpec'));
 await db('o_storyboard').insert({id:42,projectId:1,scriptId:10,shouldGenerateImage:0,filePath:'/legacy'});
 await migrate(db);await migrate(db);const row=await db('o_storyboard').where({id:42}).first();assert.equal(row.productionSpec,null);assert.equal(row.filePath,'/legacy');assert.equal(row.shouldGenerateImage,0);
});
