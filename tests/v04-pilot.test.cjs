const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const knex = require('knex');
const root = path.resolve(__dirname, '..');

function loadSource(file, db, cache = new Map(), oss = null) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: file }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (name === '@/utils/db') return { db };
    if (name === '@/utils') return { oss, vendor: { getModelList: async () => ['vision','vision-v2'].map(modelName => ({ modelName, type: 'text', supports: { image_input: true } })), getCode: () => 'vision-adapter-v1' }, Ai: { Text: model => ({ trackedSession: async () => ({ modelReference: model, invokeObject: async input => {
      oss.modelCalls.push({ model, ...input, method: 'invokeObject' });
      oss.visionCalls++;
      if (oss.visionFailure) throw oss.visionFailure;
      if (oss.modelError) throw Error('provider call failed');
      return { object: oss.visionResult ?? { summary: 'A dark blue image with a bright logo', dominantColors: ['deep blue'], visibleText: ['DreamStream'], uncertainty: [] } };
    } }), invoke: async input => {
      oss.modelCalls.push({ model, ...input });
      if (model.startsWith('fake:vision')) throw Error('Vision must use structured output');
      if (oss.textError) throw Error('text provider failed');
      return { text: 'I can discuss the observed image in this project.', output: oss.proposalOutput };
    } }) } };
    if (name === '@/utils/getPath') return () => path.join(oss.testDir,'v04-conversation');
    if (name === '@/services/modelPreset') { oss.ModelConfigError ??= class ModelConfigError extends Error {}; return { ModelConfigError: oss.ModelConfigError, requireModel: async (_projectId, slot) => { if (slot === 'vision' && !oss.visionModel) throw new oss.ModelConfigError('vision unavailable'); return slot === 'vision' ? oss.visionModel : 'fake:local'; }, resolveModels: async () => ({ models: { vision: oss.visionModel } }) }; }
    if (name === '@/utils/agent/memory') return class { async get() { return {rag:[], summaries:[]}; } };
    if (name === '@/utils/agent/embedding') return { getEmbedding: async () => [] };
    if (name === './skills') return { previewSkill: async () => ({}), previewCreativeProposal: async () => ({}) };
    if (name === '@/services/assetUploadSource') return { recordAssetUpload: async (trx, source) => {
      const asset = await trx('o_assets').where({ id: source.assetId, projectId: source.projectId, imageId: source.imageId }).first();
      const image = await trx('o_image').where({ id: source.imageId, assetsId: source.assetId, filePath: source.filePath }).first();
      if (!asset || !image || image.model) throw Error('UPLOAD_SOURCE_INVALID');
      await trx('o_assetUploadSource').insert(source);
    } };
    if (name === '@/services/advertisementAssetPlan') return { readAssetPlanInTransaction: async (trx, scope) => ({items: (await trx('o_advertisementAssetPlan').where(scope).orderBy('position')).map(row => ({...row,bindingValid:row.assetId != null}))}), assertAssetPlanBinding: async (trx, scope, item) => {
      const asset = await trx('o_assets').where({ id: item.assetId, projectId: scope.projectId, scriptId: scope.scriptId }).first();
      const linked = asset && await trx('o_scriptAssets').where({ scriptId: scope.scriptId, assetId: asset.id }).first();
      if (!asset || !linked) throw Error('ASSET_SCOPE');
      if (item.sourcePolicy === 'REAL_REQUIRED') {
        const image = await trx('o_image').where({ id: asset.imageId, assetsId: asset.id, state: '已完成' }).first();
        const receipt = image && await trx('o_assetUploadSource').where({ assetId: asset.id, imageId: image.id, filePath: image.filePath }).first();
        if (!receipt || image.model) throw Error('REAL_SOURCE_REQUIRED');
      }
    } };
    if (name === '@/services/orchestrator/videoProductionProfile') return { advertisement001eDefinition: {} };
    if (name === '@/services/orchestrator/profileDefinition') return { definitionHash: () => 'a'.repeat(64) };
    if (name === '@/lib/advertisementAssetPlanSchema') return { ASSET_PLAN_TABLE: 'o_advertisementAssetPlan' };
    if (name.startsWith('.')) return loadSource(path.resolve(path.dirname(file), name + '.ts'), db, cache, oss);
    return require(name);
  }, module, module.exports);
  return module.exports;
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v04-pilot-'));
  const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(dir, 'test.sqlite') }, useNullAsDefault: true });
  const oss = { writeFile: async (p, bytes) => { const target=path.join(dir,'oss',p.replace(/^\//,'')); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes); }, getFile: async p => fs.readFileSync(path.join(dir,'oss',p.replace(/^\//,''))), deleteFile: async p => fs.rmSync(path.join(dir,'oss',p.replace(/^\//,'')),{force:true}) };
  oss.modelCalls=[]; oss.visionCalls=0; oss.visionModel='fake:vision';
  oss.testDir=dir;
  t.after(async () => { await db.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.schema.createTable('o_project', x => { x.bigInteger('id').primary(); x.string('projectType'); x.string('type'); x.string('name'); x.text('intro'); x.string('artStyle'); x.string('directorManual'); x.string('videoRatio'); x.string('imageModel'); x.string('videoModel'); x.string('imageQuality'); x.string('mode'); x.integer('userId'); x.bigInteger('createTime'); });
  await db.schema.createTable('o_script', x => { x.increments('id'); x.bigInteger('projectId'); x.string('name'); x.text('content'); x.bigInteger('createTime'); });
  await db.schema.createTable('o_storyboard', x => { x.increments('id'); x.bigInteger('projectId'); x.integer('scriptId'); x.integer('index'); x.text('prompt'); x.integer('duration'); x.text('videoDesc'); x.text('productionSpec'); x.string('state'); x.string('filePath'); x.integer('currentImageAttemptId'); x.integer('activeImageAttemptId'); x.bigInteger('retiredAt'); });
  await db.schema.createTable('o_productionProfileVersion', x => { x.string('profileKey'); x.integer('version'); x.string('status'); x.string('definitionHash'); x.text('definition'); x.bigInteger('createdAt'); x.bigInteger('updatedAt'); x.bigInteger('activatedAt'); x.bigInteger('deprecatedAt'); x.primary(['profileKey','version']); });
  await db.schema.createTable('o_projectProfileBinding', x => { x.bigInteger('projectId').primary(); x.string('profileKey'); x.integer('profileVersion'); x.string('source'); x.bigInteger('createdAt'); x.bigInteger('updatedAt'); });
  await db('o_productionProfileVersion').insert({profileKey:'advertisement',version:2,status:'ACTIVE',definition:'{}',definitionHash:'a'.repeat(64)});
  await db.schema.createTable('o_assets', x => { x.increments('id'); x.bigInteger('projectId'); x.integer('scriptId'); x.integer('imageId'); x.string('name'); x.text('describe'); x.text('prompt'); x.string('type'); x.bigInteger('startTime'); });
  await db.schema.createTable('o_scriptAssets', x => { x.integer('scriptId'); x.integer('assetId'); x.primary(['scriptId','assetId']); });
  await db.schema.createTable('o_image', x => { x.increments('id'); x.integer('assetsId'); x.string('state'); x.string('filePath'); x.string('model'); x.string('type'); });
  await db.schema.createTable('o_assetUploadSource', x => { x.integer('projectId'); x.integer('assetId'); x.integer('imageId'); x.string('filePath'); });
  await db.schema.createTable('o_advertisementAssetPlan', x => { x.bigInteger('projectId'); x.integer('scriptId'); x.string('assetKey'); x.string('name'); x.string('category'); x.integer('required'); x.string('sourcePolicy'); x.integer('assetId'); x.integer('position'); x.primary(['projectId','scriptId','assetKey']); });
  await db.schema.createTable('memories', x => { x.string('id').primary(); x.string('isolationKey'); x.string('type'); x.string('role'); x.text('content'); x.text('embedding'); x.integer('summarized'); x.bigInteger('createTime'); });
  const schema = loadSource(path.join(root,'src/v04/schema.ts'),db);
  await schema.initializeV04Schema(db); await schema.initializeV04Schema(db);
  const cache = new Map();
  return { db, oss, cache, service: loadSource(path.join(root,'src/v04/service.ts'),db,cache,oss), agent: loadSource(path.join(root,'src/v04/agentAttachments.ts'),db,cache,oss) };
}
const asset = (name='Dreamer', category='CHAR', sourcePolicy='AI_ALLOWED') => ({ name, category, description:'calm', identityAnchors:['left eyebrow scar'], mustPreserve:['scar'], forbiddenChanges:['redraw brand text'], ownerKey:null, variantOf:null, sourcePolicy, prompt:'' });
test('Project Agent keeps a project-level memory identity and reads selected shot context without a production write route', () => {
  const source=fs.readFileSync(path.join(root,'src/v04/router.ts'),'utf8');
  assert.match(source,/project:\$\{projectId\}:projectAgent/);
  assert.match(source,/selectedShotAndNeighbors = selectedShotIndex < 0/);
  assert.match(source,/answerProjectAgent\(\{ projectId: ctx\.projectId/);
  assert.doesNotMatch(source,/trx\("o_storyboard"\)\.insert|trx\("o_storyboard"\)\.update/);
});

test('pilot launcher reads exactly one owner from its disposable SQLite without guessing', async t => {
  const {db,oss}=await fixture(t);
  await db.schema.createTable('o_user',x=>{x.integer('id').primary();});
  const read=()=>require('node:child_process').execFileSync(process.execPath,[path.join(root,'pilot/read-owner.cjs')],{cwd:root,env:{...process.env,V04_OWNER_DB_PATH:path.join(oss.testDir,'test.sqlite')},encoding:'utf8'});
  assert.equal(read(),'');
  await db('o_user').insert({id:42});
  assert.equal(read(),'42');
  await db('o_user').insert({id:43});
  assert.equal(read(),'');
});

test('chat image stays a scoped conversational reference until separately previewed and confirmed', async t => {
  const { db, oss, service:s, agent } = await fixture(t);
  const scope = await s.createPilotProject({name:'Image dialogue',brief:'Real UI stays real',targetDuration:30,aspectRatio:'16:9'}, 7);
  const ctx = { ...scope, currentStage:'creative', currentRoute:'pilot/creative', selectedObject:null };
  const png = await require('sharp')({create:{width:8,height:8,channels:4,background:'#17497f'}}).png().toBuffer();
  const upload = await agent.uploadAgentImage({context:ctx,name:'screen.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  assert.equal(upload.purpose,'CONVERSATIONAL_REFERENCE');
  assert.equal(fs.existsSync(path.join(oss.testDir,'oss','v04-conversation',String(scope.projectId))),false);
  assert.equal(fs.existsSync(path.join(oss.testDir,'v04-conversation',String(scope.projectId))),true);
  assert.equal((await agent.attachmentsForMessage(scope.projectId,[upload.id])).length,1);
  assert.deepEqual((await agent.getAgentAttachmentBytes(scope.projectId,upload.id)).bytes,png);
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0);
  assert.equal((await db('o_assetUploadSource').count({n:'assetId'}).first()).n,0);
  await db('o_v04AgentAttachment').where({id:upload.id}).update({messageId:'user-message-1'});
  assert.equal(JSON.parse((await db('o_v04AgentAttachment').where({id:upload.id}).first()).contextJson).currentRoute,'pilot/creative');
  const request={context:ctx,attachmentId:upload.id,targetType:'PROJECT_REFERENCE',targetKey:null};
  const preview=await agent.previewAttachmentPromotion(request);
  assert.equal((await db('o_v04AgentReference').count({n:'id'}).first()).n,0);
  await agent.applyAttachmentPromotion({...request,previewHash:preview.previewHash});
  assert.equal((await db('o_v04AgentReference').first()).targetType,'PROJECT_REFERENCE');
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0);
  await assert.rejects(agent.applyAttachmentPromotion({...request,previewHash:preview.previewHash}),e=>e.code==='PILOT_REFERENCE_EXISTS');
  const other=await s.createPilotProject({name:'Other',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  await assert.rejects(agent.getAgentAttachmentBytes(other.projectId,upload.id),e=>e.code==='PILOT_ATTACHMENT_NOT_FOUND');
  await assert.rejects(agent.uploadAgentImage({context:ctx,name:'fake.png',dataUrl:'data:image/png;base64,AAAA'}),e=>e.code==='PILOT_IMAGE_INVALID');
});

test('authenticated HTTP chat sends real image bytes to the Agent and restores them across stage changes', async t => {
  const { db, oss, cache, service:s } = await fixture(t);
  const scope=await s.createPilotProject({name:'Cross-page chat',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const express=require('express');
  const app=express(); app.use(express.json({limit:'12mb'})); app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/v04`;
  const post=async (route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const png=await require('sharp')({create:{width:8,height:8,channels:4,background:'#123456'}}).png().toBuffer();
  const creative={...scope,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null};
  const uploaded=await post('/agent/image/upload',{context:creative,name:'look.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  assert.equal(uploaded.status,200);
  const attachmentId=uploaded.body.data.id;
  const chat=await post('/agent/chat',{context:creative,message:'Compare this composition.',attachmentIds:[attachmentId]});
  assert.equal(chat.status,200);
  assert.equal(chat.body.data.applied,false);
  assert.equal(oss.modelCalls.length,2);
  assert.equal(oss.modelCalls[0].model,'fake:vision');
  assert.equal(oss.modelCalls[0].method,'invokeObject');
  assert.ok(oss.modelCalls[0].schema,'Vision uses the native structured schema');
  assert.equal(oss.modelCalls[0].messages[0].content[1].type,'image');
  assert.equal(oss.modelCalls[0].messages[0].content[1].mediaType,'image/png');
  assert.deepEqual(oss.modelCalls[0].messages[0].content[1].image,png);
  assert.equal(oss.modelCalls[1].model,'fake:local');
  assert.match(oss.modelCalls[1].system,/dark blue image/);
  const assets={...creative,currentStage:'assets',currentRoute:'pilot/assets',selectedObject:{type:'PROJECT',key:'all'}};
  const later=await post('/agent/chat',{context:assets,message:'Do you remember our composition discussion?',attachmentIds:[]});
  assert.equal(later.status,200);
  assert.match(oss.modelCalls[2].system,/Compare this composition/);
  assert.equal(oss.visionCalls,1,'a follow-up visual request reuses the observation cache');
  const history=await post('/agent/history',scope);
  assert.equal(history.status,200);
  assert.equal(history.body.data.isolationKey,`project:${scope.projectId}:projectAgent`);
  assert.equal(history.body.data.messages.length,4);
  assert.equal(history.body.data.messages[0].attachments[0].id,attachmentId);
  assert.equal(history.body.data.messages[0].attachments[0].context.currentRoute,'pilot/creative');
  const [secondUnit]=await db('o_script').insert({projectId:scope.projectId,name:'Second production unit',content:'',createTime:Date.now()});
  const nextUnit={...assets,scriptId:secondUnit,currentStage:'storyboard',currentRoute:'production/storyboard',selectedObject:{type:'SHOT',key:'9'}};
  const acrossUnit=await post('/agent/chat',{context:nextUnit,message:'Same project, new production unit.',attachmentIds:[]});
  assert.equal(acrossUnit.status,200);
  assert.match(oss.modelCalls[3].system,new RegExp(`当前制作单元: ${secondUnit}`));
  const secondHistory=await post('/agent/history',{projectId:scope.projectId,scriptId:secondUnit});
  assert.equal(secondHistory.body.data.isolationKey,history.body.data.isolationKey);
  assert.equal(secondHistory.body.data.messages.length,6);
  assert.equal((await post('/project/read',{projectId:scope.projectId,scriptId:secondUnit})).status,404);
  const image=await fetch(`${base}/agent/image/${scope.projectId}/${attachmentId}`);
  assert.equal(image.status,200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0);
  const failedUpload=await post('/agent/image/upload',{context:assets,name:'second.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  oss.modelError=true;
  const failedChat=await post('/agent/chat',{context:assets,message:'Inspect this too',attachmentIds:[failedUpload.body.data.id]});
  assert.equal(failedChat.status,200);
  assert.equal(failedChat.body.data.status,'VISION_ANALYSIS_FAILED');
  assert.equal(failedChat.body.data.errorCode,'PILOT_VISION_PROVIDER_FAILED');
  const recovered=await post('/agent/history',scope);
  assert.equal(recovered.body.data.messages.length,7);
  assert.equal(recovered.body.data.messages[6].attachments[0].id,failedUpload.body.data.id);
});

test('missing vision preserves image and message; reanalysis and follow-up use versioned cache without promotion', async t => {
  const { db, oss, cache, service:s } = await fixture(t);
  const scope = await s.createPilotProject({name:'Vision pilot',brief:'Moon ending',targetDuration:30,aspectRatio:'16:9'},7);
  const ctx = {...scope,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null};
  const express = require('express'); const app = express();
  app.use(express.json({limit:'12mb'})); app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async (route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const png=await require('sharp')({create:{width:8,height:8,channels:4,background:'#123456'}}).png().toBuffer();
  const upload=await post('/agent/image/upload',{context:ctx,name:'logo.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  oss.visionModel=null;
  const missing=await post('/agent/chat',{context:ctx,message:'你能看到这个 Logo 吗？',attachmentIds:[upload.data.data.id]});
  assert.equal(missing.status,200); assert.equal(missing.data.data.status,'VISION_MODEL_REQUIRED');
  assert.match(missing.data.data.reply,/图片已保存.*还不能分析/);
  assert.equal(oss.modelCalls.length,0,'no model was called to invent a visual answer');
  let history=await post('/agent/history',scope);
  assert.equal(history.data.data.messages.length,1);
  assert.equal(history.data.data.messages[0].attachments[0].id,upload.data.data.id);
  assert.equal(history.data.data.visionConfigured,false);
  assert.equal((await db('o_v04AgentReference')).length,0);
  assert.equal((await db('o_image')).length,0);
  const plain=await post('/agent/chat',{context:ctx,message:'继续广告创意讨论。',attachmentIds:[]});
  assert.equal(plain.data.data.status,'ANSWERED'); assert.equal(oss.visionCalls,0);
  oss.visionModel='fake:vision';
  const reanalyzed=await post('/agent/reanalyze',{context:ctx,userMessageId:missing.data.data.userMessageId});
  assert.equal(reanalyzed.data.data.status,'ANSWERED'); assert.equal(oss.visionCalls,1);
  assert.match(oss.modelCalls.at(-1).system,/dark blue image/);
  const followup=await post('/agent/chat',{context:ctx,message:'再分析这个 Logo 的颜色和构图',attachmentIds:[]});
  assert.equal(followup.data.data.status,'ANSWERED'); assert.equal(followup.data.data.visionCacheHits,1);
  assert.equal(oss.visionCalls,1,'same attachment and model use cached observation');
  await post('/agent/reanalyze',{context:ctx,userMessageId:missing.data.data.userMessageId});
  assert.equal(oss.visionCalls,2,'explicit reanalysis bypasses cache');
  oss.visionModel='fake:vision-v2';
  await post('/agent/chat',{context:ctx,message:'比较刚才 Logo 的颜色',attachmentIds:[]});
  assert.equal(oss.visionCalls,3,'different exact model produces a new observation');
  assert.equal((await db('o_v04VisionAnalysis')).length,2);
  const before=oss.modelCalls.length;
  const unsupported=await post('/agent/chat',{context:ctx,message:'帮我生成一张图',attachmentIds:[]});
  assert.equal(unsupported.data.data.status,'CAPABILITY_NOT_CONNECTED');
  assert.equal(oss.modelCalls.length,before,'unsupported generation never dispatches a producer');
  history=await post('/agent/history',scope);
  assert.equal(history.data.data.visionConfigured,true);
  assert.equal((await db('o_v04AgentReference')).length,0);
  assert.equal((await db('o_image')).length,0);
});

test('Vision structured failures keep distinct safe diagnostics and never invent an answer or production asset', async t => {
  const { db, oss, cache, service:s } = await fixture(t);
  const scope=await s.createPilotProject({name:'Vision diagnostics',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const ctx={...scope,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null};
  const express=require('express'); const app=express();
  app.use(express.json({limit:'12mb'})); app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async (route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return (await response.json()).data;};
  const png=await require('sharp')({create:{width:8,height:8,channels:4,background:'#123456'}}).png().toBuffer();
  const uploaded=await post('/agent/image/upload',{context:ctx,name:'logo.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  oss.visionModel=null;
  const original=await post('/agent/chat',{context:ctx,message:'分析这张图片',attachmentIds:[uploaded.id]});
  assert.equal(original.status,'VISION_MODEL_REQUIRED');
  oss.visionModel='fake:vision';
  const logs=[]; t.mock.method(console,'error',(...args)=>logs.push(args));
  const replay=()=>post('/agent/reanalyze',{context:ctx,userMessageId:original.userMessageId});

  oss.visionFailure=Object.assign(new Error('apiKey=supersecret Authorization: Bearer secret-token Cookie=session data:image/png;base64,AAAA'),{name:'APICallError',statusCode:401});
  const provider=await replay();
  assert.equal(provider.errorCode,'PILOT_VISION_PROVIDER_FAILED'); assert.equal(provider.status,'VISION_ANALYSIS_FAILED');
  assert.match(provider.errorId,/^[0-9a-f-]{36}$/);
  assert.match(provider.reply,/供应商配置/);
  assert.equal(logs.at(-1)[1].status,401);
  assert.equal(logs.at(-1)[1].attachmentId,uploaded.id);
  assert.doesNotMatch(JSON.stringify(logs),/supersecret|secret-token|Cookie=session|base64,AAAA/);

  oss.visionFailure=Object.assign(new Error('Retry exhausted'),{name:'RetryError',errors:[Object.assign(new Error('provider HTTP 503'),{name:'APICallError',statusCode:503})]});
  const retried=await replay();
  assert.equal(retried.errorCode,'PILOT_VISION_PROVIDER_FAILED');
  assert.equal(logs.at(-1)[1].status,503,'wrapped provider status remains available in safe diagnostics');

  oss.visionFailure=Object.assign(new Error('This model does not support image input'),{name:'APICallError',statusCode:400});
  const unsupported=await replay();
  assert.equal(unsupported.errorCode,'PILOT_VISION_INPUT_UNSUPPORTED');
  assert.match(unsupported.reply,/拒绝图片输入/);

  oss.visionFailure=null;
  oss.visionResult={summary:'',dominantColors:'blue'};
  const malformed=await replay();
  assert.equal(malformed.errorCode,'PILOT_VISION_SCHEMA_FAILED');
  assert.match(malformed.reply,/结构化分析失败/);
  assert.equal((await db('o_v04VisionAnalysis')).length,0);
  assert.equal((await db('memories').where({isolationKey:`project:${scope.projectId}:projectAgent`})).length,1,'failures do not create a fabricated Agent answer');
  assert.equal((await db('o_image')).length,0);
  assert.equal((await db('o_v04AgentReference')).length,0);

  oss.visionResult={summary:'A blue logo',dominantColors:['blue'],uncertainty:[]};
  const valid=await replay();
  assert.equal(valid.status,'ANSWERED');
  assert.equal((await db('o_v04VisionAnalysis')).length,1);
  assert.equal((await db('o_v04AgentAttachment').where({id:uploaded.id}).first()).purpose,'CONVERSATIONAL_REFERENCE');
});

test('Creative Agent proposal uses project conversation and remains zero-write until preview/apply', async t => {
  const { db, oss, cache, service:s } = await fixture(t);
  const scope=await s.createPilotProject({name:'Proposal',brief:'Original brief',targetDuration:30,aspectRatio:'16:9'},7);
  await db('memories').insert({id:'prior-user',isolationKey:`project:${scope.projectId}:projectAgent`,type:'message',role:'user',content:'Keep the product interface exact.',embedding:null,summarized:0,createTime:Date.now()});
  oss.proposalOutput={proposedText:'Original brief, with a restrained reveal.',reason:'Keeps the exact interface while sharpening the opening.'};
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const before=await db('o_v04Creative').where(scope).first();
  const result=await skills.previewCreativeProposal({...scope,target:'brief',instruction:'Make the opening clearer.'});
  assert.equal(result.applied,false);
  assert.equal(result.candidate.proposedText,oss.proposalOutput.proposedText);
  assert.match(oss.modelCalls[0].messages[0].content[0].text,/Keep the product interface exact/);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before);
  const preview=await s.previewCreative({...scope,brief:result.candidate.proposedText,treatment:'',script:'',expectedVersion:before.version});
  assert.equal(preview.proposed.brief,result.candidate.proposedText);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before);
});

test('explicit image promotion uses current-unit Asset Plan and server upload provenance', async t => {
  const { db, service:s, agent } = await fixture(t);
  const scope=await s.createPilotProject({name:'Real asset',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'screen',asset:asset('Real screen','UI','REAL_REQUIRED')}];
  const plan=await s.previewAssets({...scope,changes});
  const created=await s.applyAssets({...scope,changes,previewHash:plan.previewHash});
  const canonicalKey=created.applied[0].canonicalKey, assetId=created.applied[0].assetId;
  const ctx={...scope,currentStage:'assets',currentRoute:'pilot/assets',selectedObject:{type:'ASSET',key:canonicalKey}};
  const png=await require('sharp')({create:{width:8,height:8,channels:4,background:'#a15231'}}).png().toBuffer();
  const uploaded=await agent.uploadAgentImage({context:ctx,name:'brand-screen.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  await db('o_v04AgentAttachment').where({id:uploaded.id}).update({messageId:'user-message-2'});
  assert.equal((await db('o_advertisementAssetPlan').where({...scope,assetKey:canonicalKey}).first()).assetId,null);
  const request={context:ctx,attachmentId:uploaded.id,targetType:'PRODUCTION_ASSET',targetKey:canonicalKey};
  const preview=await agent.previewAttachmentPromotion(request);
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0);
  const promoted=await agent.applyAttachmentPromotion({...request,previewHash:preview.previewHash});
  assert.equal(promoted.assetId,assetId);
  const image=await db('o_image').where({assetsId:assetId}).first();
  assert.equal(image.state,'已完成');
  assert.deepEqual((await agent.getAgentAttachmentBytes(scope.projectId,uploaded.id)).bytes,png);
  assert.equal((await db('o_assetUploadSource').where({assetId,imageId:image.id,filePath:image.filePath}).count({n:'assetId'}).first()).n,1);
  assert.equal((await db('o_advertisementAssetPlan').where({...scope,assetKey:canonicalKey}).first()).assetId,assetId);
  assert.deepEqual((await s.resolveAssets({...scope,canonicalKeys:[canonicalKey]})).associateAssetsIds,[assetId]);
});
test('creative and asset preview have zero writes; stale preview cannot apply', async t => {
  const { db, service:s } = await fixture(t);
  const scope = await s.createPilotProject({name:'V04 Test',brief:'A dream becomes a film',targetDuration:30,aspectRatio:'16:9'}, 7);
  const before = await db('o_v04Creative').where(scope).first();
  const input = {...scope,brief:'Revised',treatment:'A new treatment',script:'Scene one',expectedVersion:1};
  const p = await s.previewCreative(input);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(), before);
  await s.applyCreative({...input, previewHash:p.previewHash});
  await assert.rejects(s.applyCreative({...input, previewHash:p.previewHash}), e => e.code === 'PILOT_PREVIEW_STALE');
  const changes = [{operation:'ADD',clientRef:'first',asset:asset()}];
  const preview = await s.previewAssets({...scope,changes});
  assert.equal(await db('o_v04Asset').count({n:'canonicalKey'}).first().then(x=>x.n),0);
  assert.equal(await db('o_assets').count({n:'id'}).first().then(x=>x.n),0);
  await s.applyAssets({...scope,changes,previewHash:preview.previewHash});
  await assert.rejects(s.applyAssets({...scope,changes,previewHash:preview.previewHash}), e => e.code === 'PILOT_PREVIEW_STALE');
  const staleChanges=[{operation:'ADD',clientRef:'from-old-script',asset:asset('Old script candidate')}];
  const stalePreview=await s.previewAssets({...scope,changes:staleChanges,sourceCreativeVersion:2});
  const nextCreative={...scope,brief:'Revised again',treatment:'Another treatment',script:'Scene two',expectedVersion:2};
  const nextPreview=await s.previewCreative(nextCreative);
  await s.applyCreative({...nextCreative,previewHash:nextPreview.previewHash});
  await assert.rejects(s.applyAssets({...scope,changes:staleChanges,sourceCreativeVersion:2,previewHash:stalePreview.previewHash}),e=>e.code==='PILOT_SOURCE_STALE');
});
test('canonical keys survive rename, never reuse retirement numbers, and do not name-merge', async t => {
  const { db, service:s } = await fixture(t);
  const scope = await s.createPilotProject({name:'A',brief:'',targetDuration:30,aspectRatio:'16:9'}, 7);
  async function apply(changes){const p=await s.previewAssets({...scope,changes});return s.applyAssets({...scope,changes,previewHash:p.previewHash});}
  assert.equal((await apply([{operation:'ADD',clientRef:'a',asset:asset()}])).applied[0].canonicalKey,'CHAR-001');
  const duplicate = await s.previewAssets({...scope,changes:[{operation:'ADD',clientRef:'b',asset:asset()}]});
  assert.deepEqual(duplicate.suggestions[0].possibleMatches,['CHAR-001']);
  assert.equal((await apply([{operation:'ADD',clientRef:'b',asset:asset()}])).applied[0].canonicalKey,'CHAR-002');
  await apply([{operation:'EDIT',canonicalKey:'CHAR-001',expectedRevision:1,patch:{name:'Renamed'}}]);
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first()).name,'Renamed');
  await apply([{operation:'RETIRE',canonicalKey:'CHAR-001',expectedRevision:2}]);
  assert.equal((await apply([{operation:'ADD',clientRef:'c',asset:asset('Third')}])).applied[0].canonicalKey,'CHAR-003');
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first()).status,'RETIRED');
  const other = await s.createPilotProject({name:'B',brief:'',targetDuration:30,aspectRatio:'16:9'}, 7);
  const otherChanges=[{operation:'ADD',clientRef:'a',asset:asset()}];const preview=await s.previewAssets({...other,changes:otherChanges});
  assert.equal((await s.applyAssets({...other,changes:otherChanges,previewHash:preview.previewHash})).applied[0].canonicalKey,'CHAR-001');
});
test('resolver returns exact current-unit numeric assetId and fails closed on real upload requirement', async t => {
  const { db, service:s } = await fixture(t);
  const scope = await s.createPilotProject({name:'A',brief:'',targetDuration:30,aspectRatio:'16:9'}, 7);
  const changes=[{operation:'ADD',clientRef:'ui',asset:asset('Real screen','UI','REAL_REQUIRED')}];const preview=await s.previewAssets({...scope,changes});
  const applied=await s.applyAssets({...scope,changes,previewHash:preview.previewHash});const assetId=applied.applied[0].assetId;
  assert.equal((await s.readPilot(scope)).assetPlan.find(item=>item.assetKey==='UI-001').status,'UNBOUND');
  await assert.rejects(s.resolveAssets({...scope,canonicalKeys:['UI-001']}), e=>e.code==='PILOT_ASSET_UNBOUND');
  const [imageId]=await db('o_image').insert({assetsId:assetId,state:'已完成',filePath:'/uploaded.png',model:'ai-model'});
  await db('o_assets').where({id:assetId}).update({imageId});
  await db('o_advertisementAssetPlan').where({...scope,assetKey:'UI-001'}).update({assetId});
  await assert.rejects(s.resolveAssets({...scope,canonicalKeys:['UI-001']}),/REAL_SOURCE_REQUIRED/);
  await db('o_image').where({id:imageId}).update({model:null});
  await db('o_assetUploadSource').insert({projectId:scope.projectId,assetId,imageId,filePath:'/uploaded.png'});
  assert.deepEqual((await s.resolveAssets({...scope,canonicalKeys:['UI-001']})).associateAssetsIds,[assetId]);
  // A later real upload may be a distinct asset. The current unit's Asset
  // Plan, not the initial placeholder binding, selects production assetId.
  const [replacementId]=await db('o_assets').insert({projectId:scope.projectId,scriptId:scope.scriptId,name:'Replacement upload'});
  await db('o_scriptAssets').insert({scriptId:scope.scriptId,assetId:replacementId});
  const [replacementImageId]=await db('o_image').insert({assetsId:replacementId,state:'已完成',filePath:'/replacement.png',model:null});
  await db('o_assets').where({id:replacementId}).update({imageId:replacementImageId});
  await db('o_assetUploadSource').insert({projectId:scope.projectId,assetId:replacementId,imageId:replacementImageId,filePath:'/replacement.png'});
  await db('o_advertisementAssetPlan').where({...scope,assetKey:'UI-001'}).update({assetId:replacementId});
  assert.deepEqual((await s.resolveAssets({...scope,canonicalKeys:['UI-001']})).associateAssetsIds,[replacementId]);
  assert.equal((await s.readPilot(scope)).assetPlan.find(item=>item.assetKey==='UI-001').status,'READY');
  const other=await s.createPilotProject({name:'B',brief:'',targetDuration:30,aspectRatio:'16:9'}, 7);
  await assert.rejects(s.resolveAssets({...other,canonicalKeys:['UI-001']}),e=>e.code==='PILOT_ASSET_UNBOUND');
});
