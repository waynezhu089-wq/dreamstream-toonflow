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
  let wrapper;
  const streams=[];
  const emptyMemory=class {async add(){} async get(){return {rag:[],summaries:[],shortTerm:[]};} getTools(){return {};}};
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
      if (id === '@/utils') return {db:wrapper,error:e=>e,getPath:parts=>path.join(root,'data',...(Array.isArray(parts)?parts:[parts])),Ai:{Text:()=>({stream:async options=>{streams.push(options);return {fullStream:(async function*(){})()};}})}};
      if(id==='ai')return {tool:x=>x,jsonSchema:x=>x};
      if(id==='lodash')return {};
      if(id==='@/services/modelPreset')return {resolveModels:async()=>({models:{image:null,video:null}}),textModelForProject:async(p,key)=>key};
      if(id==='@/utils/agent/memory')return emptyMemory;
      if(id==='@/utils/agent/skillsTools')return {scanSkills:async()=>[],createSkillTools:()=>({}),parseFrontmatter:()=>({}),useSkill:()=>({})};
      if (id.startsWith('@/')) return load(id.slice(2));
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const { default: db, db: raw } = load('utils/db');
  wrapper = db;
  await new Promise(resolve => setImmediate(resolve));
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;
  t.after(async () => { await raw.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.notEqual(db, raw);
  assert.equal(typeof db, 'function');
  assert.equal(typeof db.transaction, 'function');
  await raw.schema.createTable('o_project', t => { t.integer('id').primary(); t.string('projectType'); t.string('type'); t.string('artStyle').defaultTo('test'); t.string('directorManual').defaultTo('test'); });
  await raw.schema.createTable('o_script', t => { t.integer('id').primary(); t.integer('projectId'); t.integer('createTime'); });
  await raw.schema.createTable('o_assets', t => { t.increments('id'); t.integer('projectId'); t.integer('scriptId'); t.integer('imageId'); t.integer('assetsId'); t.string('name'); t.string('type'); t.string('prompt'); t.bigInteger('startTime'); });
  await raw.schema.createTable('o_image', t => { t.increments('id'); t.integer('assetsId'); t.string('filePath'); t.string('state'); t.string('model'); t.string('type'); t.string('artStyle').defaultTo('test'); t.string('directorManual').defaultTo('test'); });
  await raw.schema.createTable('o_scriptAssets', t => { t.integer('scriptId'); t.integer('assetId'); t.primary(['scriptId', 'assetId']); });
  await raw.schema.createTable('o_agentWorkData', t => { t.increments('id'); t.integer('projectId'); t.integer('episodesId'); t.string('key'); t.text('data'); t.integer('updateTime'); t.integer('createTime'); });
  await db('o_project').insert([{ id: 1, projectType: 'general_video', type: 'advertisement' }, { id: 2, projectType: 'general_video', type: 'advertisement' }, { id: 3, projectType: 'short_drama', type: 'story' }]);
  await db('o_script').insert([{ id: 10, projectId: 1 }, { id: 11, projectId: 1 }, { id: 20, projectId: 2 }, { id: 30, projectId: 3 }]);
  await db('o_assets').insert([{ id: 1, projectId: 1, imageId: 1 }, { id: 2, projectId: 1, imageId: 2 }, { id: 3, projectId: 2, imageId: 3 }]);
  await db('o_image').insert([1, 2, 3].map(id => ({ id, assetsId: id, filePath: '/generated/' + id, state: '已完成', model: 'test-ai' })));
  await db('o_scriptAssets').insert([{ scriptId: 10, assetId: 1 }, { scriptId: 11, assetId: 2 }, { scriptId: 20, assetId: 3 }]);

  await load('lib/advertisementAssetPlanSchema').initializeAssetPlanSchema(db);
  const plan=load('services/advertisementAssetPlan');
  const item=(id,name='Plan semantic name')=>({assetKey:'product',name,category:'product',required:true,sourcePolicy:'AI_ALLOWED',assetId:id});
  await plan.saveAssetPlan({projectId:1,scriptId:10,items:[item(1)]});
  await plan.saveAssetPlan({projectId:1,scriptId:11,items:[item(2,'Other unit')]});
  await db('o_agentWorkData').insert([10,11].map(episodesId=>({projectId:1,episodesId,key:'advertisement:asset-preparation',data:'{"confirmed":true}'})));
  await db('o_assets').insert({id:4,projectId:1,imageId:4,name:'Historical duplicate'});
  await db('o_image').insert({id:4,assetsId:4,filePath:'/old',state:'已完成'});
  await db('o_scriptAssets').insert({scriptId:10,assetId:4});
  const noop=()=>{};const output={append:noop,appendText:noop,complete:noop,error:noop,updateTitle:noop};
  const msg={datetime:new Date().toISOString(),complete:noop,error:noop,text:()=>output,thinking:()=>output};
  const events=[];
  const resTool={data:{projectId:1,scriptId:10},newMessage:()=>msg,socket:{emit:(name,data,callback)=>{events.push({name,data});callback(name==='getFlowData'?{assets:[{id:4,name:'Historical duplicate'}]}:{success:true});}}};
  const tools=(advertisement=true)=>load('agents/productionAgent/tools').default({resTool,msg,advertisement});
  return {db,raw,load,plan,item,streams,events,resTool,msg,tools,ctx:{projectId:1,scriptId:10}};
}

test('real wrapper: production uses current Plan semantics, excludes historical inventory and isolates units',async t=>{
 const f=await fixture(t), service=f.load('services/advertisementProductionContext');
 const a=await service.advertisementProductionContext(1,10);
 assert.deepEqual(a.assets,[{assetKey:'product',name:'Plan semantic name',category:'product',required:true,sourcePolicy:'AI_ALLOWED',assetId:1,id:1,ready:true}]);
 assert.equal((await service.advertisementProductionContext(1,11)).assets[0].assetId,2);
 await assert.rejects(service.advertisementProductionContext(2,10));
 assert.equal(await service.advertisementProductionContext(3,30),null);
 assert.deepEqual(await f.tools().get_flowData.execute({key:'assets'}),a.assets);
 assert.equal(f.events.length,0);
 assert.deepEqual(await f.tools().get_advertisementAssetPlan.execute({}),a);
});

test('fresh Gate validation excludes optional incomplete bindings and rejects invalidated real sources',async t=>{
 const f=await fixture(t),service=f.load('services/advertisementProductionContext');
 await f.plan.saveAssetPlan({...f.ctx,items:[f.item(1),{...f.item(null),assetKey:'optional',required:false}]});
 assert.equal((await service.advertisementProductionContext(1,10)).assets.length,1);
 await f.db('o_image').where({id:1}).update({model:null});
 await f.db('o_assetUploadSource').insert({projectId:1,assetId:1,imageId:1,filePath:'/generated/1',uploadedAt:Date.now()});
 await f.plan.saveAssetPlan({...f.ctx,items:[{...f.item(1),sourcePolicy:'REAL_REQUIRED'}]});
 assert.equal((await service.advertisementProductionContext(1,10)).assets[0].sourcePolicy,'REAL_REQUIRED');
 await f.db('o_assetUploadSource').delete();
 await assert.rejects(service.advertisementProductionContext(1,10),/尚未准备/);
});

test('storyboard association retains real assetId and rejects unbound, cross-unit and nonexistent IDs',async t=>{
 const f=await fixture(t),tools=f.tools();
 const shot={videoDesc:'Product',prompt:'text',track:'main',duration:5,associateAssetsIds:[1],shouldGenerateImage:'false'};
 for(const id of [2,3,4,999]){
  await assert.rejects(tools.add_flowData_storyboard.execute({...shot,associateAssetsIds:[id]}),/清单之外/);
  await assert.rejects(tools.replace_flowData_storyboard.execute({items:[{...shot,associateAssetsIds:[id]}]}),/清单之外/);
 }
 assert.equal(f.events.length,0);
 await tools.replace_flowData_storyboard.execute({items:[shot]});
 assert.deepEqual(f.events[0],{name:'replaceStoryboard',data:{items:[shot]}});
 await tools.add_flowData_storyboard.execute(shot);
 await new Promise(resolve=>setTimeout(resolve,850));
 assert.deepEqual(f.events[1].data.associateAssetsIds,[1]);
});

test('decision and text subagents receive Plan with empty media models and cannot dispatch auxiliary assets or images',async t=>{
 const f=await fixture(t);
 await f.load('agents/productionAgent/index').runDecisionAI({resTool:f.resTool,msg:f.msg,socket:f.resTool.socket,isolationKey:'temporary',text:'Plan advertisement',thinkConfig:{think:false,thinlLevel:0}});
 const decision=f.streams[0];assert.match(decision.messages[0].content,/Plan semantic name/);assert.doesNotMatch(decision.messages[0].content,/Historical duplicate/);
 assert.equal(decision.tools.run_sub_agent_derive_assets,undefined);assert.equal(decision.tools.run_sub_agent_generate_assets,undefined);
 for(const key of ['director_plan','storyboard_table','storyboard_panel','supervision']){
  await decision.tools['run_sub_agent_'+key].execute({prompt:'Text planning only'});
  const sub=f.streams.at(-1);assert.match(sub.system,/"assetId":1/);
  assert.equal(sub.tools.generate_storyboard,undefined);assert.equal(sub.tools.generate_deriveAsset,undefined);
 }
 assert.equal(f.events.length,0);
});

test('legacy workspace assets and generation tool availability remain unchanged',async t=>{
 const f=await fixture(t);f.resTool.data={projectId:3,scriptId:30};const tools=f.tools(false);
 assert.deepEqual(await tools.get_flowData.execute({key:'assets'}),[{id:4,name:'Historical duplicate'}]);
 assert.ok(tools.generate_storyboard);assert.ok(tools.generate_deriveAsset);assert.equal(tools.get_advertisementAssetPlan,undefined);
});

test('advertisement skills enforce review before image generation and return missing assets to preparation',()=>{
 const dir=path.join(root,'data/skills/profiles/advertisement');
 for(const name of ['production_agent_decision.md','production_agent_supervision.md','production_execution_director_plan.md','production_execution_storyboard_table.md','production_execution_storyboard_panel.md','production_execution_storyboard_gen.md','production_skills/advertisement_core.md']){
  const content=fs.readFileSync(path.join(dir,name),'utf8');
  assert.ok(content.includes('Brief + 已确认 Asset Plan → Director Plan → Storyboard Table → Storyboard Panel → Supervisor Review → 通过后 Storyboard Image Generation → Video Preparation/Generation'),name);
  assert.match(content,/监督前或监督未通过时禁止生成分镜图/);assert.match(content,/Director Plan 之前禁止自动生成辅助资产/);
  assert.match(content,/返回 Asset Preparation/);assert.match(content,/图片\/视频模型为空不阻塞/);
 }
});
