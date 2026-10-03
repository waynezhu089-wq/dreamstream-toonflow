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
    if (name === '@/utils') return { oss, vendor: { getModelList: async () => ['vision','vision-v2'].map(modelName => ({ modelName, type: 'text', supports: { image_input: true } })), getCode: () => 'vision-adapter-v1' }, Ai: { Text: model => ({ trackedSession: async () => { if (oss.sessionError) throw oss.sessionError; oss.sessionCount=(oss.sessionCount||0)+1; return { modelReference: model, invokeObject: async input => {
      oss.modelCalls.push({ model, ...input, method: 'invokeObject' });
      if (model === 'fake:local') {
        const next=oss.skillResponses?.shift();
        if (next instanceof Error) throw next;
        return {object: next ?? oss.proposalOutput};
      }
      oss.visionCalls++;
      if (oss.visionFailure) throw oss.visionFailure;
      if (oss.modelError) throw Error('provider call failed');
      return { object: oss.visionResult ?? { summary: 'A dark blue image with a bright logo', dominantColors: ['deep blue'], visibleText: ['DreamStream'], uncertainty: [] } };
    } }; }, invoke: async input => {
      oss.modelCalls.push({ model, ...input });
      if (model.startsWith('fake:vision')) throw Error('Vision must use structured output');
      if (oss.textError) throw Error('text provider failed');
      return { text: 'I can discuss the observed image in this project.', output: oss.proposalOutput };
    } }) } };
    if (name === '@/utils/getPath') return () => path.join(oss.testDir,'v04-conversation');
    if (name === '@/services/modelPreset') { oss.ModelConfigError ??= class ModelConfigError extends Error {}; return { ModelConfigError: oss.ModelConfigError, requireModel: async (_projectId, slot) => { if (slot === 'vision' && !oss.visionModel || slot === 'text' && oss.textModelUnavailable) throw new oss.ModelConfigError('model unavailable'); return slot === 'vision' ? oss.visionModel : 'fake:local'; }, resolveModels: async () => ({ models: { vision: oss.visionModel } }) }; }
    if (name === '@/utils/agent/memory') return class { async get() { if (oss.contextFailure) throw oss.contextFailure; return {rag:[], summaries:[]}; } };
    if (name === '@/utils/agent/embedding') return { getEmbedding: async () => [] };
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

test('existing experimental Asset Bible schema upgrades additively and stays idempotent', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v04-asset-upgrade-'));
  const db=knex({client:'better-sqlite3',connection:{filename:path.join(dir,'upgrade.sqlite')},useNullAsDefault:true});
  t.after(async()=>{await db.destroy();fs.rmSync(dir,{recursive:true,force:true});});
  await db.schema.createTable('o_v04Asset',x=>{x.integer('projectId');x.text('canonicalKey');x.text('name');x.text('category');x.text('sourcePolicy');x.text('status');x.primary(['projectId','canonicalKey']);});
  await db.schema.createTable('o_v04AssetBinding',x=>{x.integer('projectId');x.integer('scriptId');x.text('canonicalKey');x.integer('assetId');x.primary(['projectId','scriptId','canonicalKey']);});
  await db('o_v04Asset').insert({projectId:17,canonicalKey:'BRAND-001',name:'Original logo',category:'BRAND',sourcePolicy:'REAL_REQUIRED',status:'ACTIVE'});
  await db('o_v04AssetBinding').insert({projectId:17,scriptId:2,canonicalKey:'BRAND-001',assetId:9});
  const schema=loadSource(path.join(root,'src/v04/schema.ts'),db);
  await schema.initializeV04Schema(db);await schema.initializeV04Schema(db);
  const row=await db('o_v04Asset').where({projectId:17,canonicalKey:'BRAND-001'}).first();
  assert.equal(row.name,'Original logo');assert.equal(row.assetKind,'OTHER');assert.equal(row.importance,'SUPPORTING');assert.equal(row.relatedKeys,'[]');
  for(const column of ['previewSpec','turnaroundSpec']) assert.equal(await db.schema.hasColumn('o_v04AssetReviewPlan',column),true);
  const review=await db('o_v04AssetReviewPlan').where({projectId:17,scriptId:2,canonicalKey:'BRAND-001'});
  assert.equal(review.length,1,'upgrade backfills an existing confirmed identity exactly once');
  assert.equal(review[0].previewStatus,'REFERENCE_REQUIRED');
  assert.equal(JSON.parse(review[0].previewSpec).aiRedrawAllowed,false);
});
test('Project Agent keeps a project-level memory identity and reads selected shot context without a production write route', () => {
  const source=fs.readFileSync(path.join(root,'src/v04/router.ts'),'utf8');
  const shared=fs.readFileSync(path.join(root,'src/v04/agentContext.ts'),'utf8');
  assert.match(shared,/project:\$\{projectId\}:projectAgent/);
  assert.match(shared,/storyboardContext: selectedShotIndex < 0/);
  assert.match(source,/buildProjectAgentContext\(/);
  assert.match(source,/answerProjectAgent\(\{ projectId: ctx\.projectId/);
  assert.doesNotMatch(source,/trx\("o_storyboard"\)\.insert|trx\("o_storyboard"\)\.update/);
});

test('confirmed Asset Bible truth follows Project Agent from Assets to Creative without leaking into another project', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Brand pilot',brief:'Brand ending',targetDuration:30,aspectRatio:'16:9'},7);
  const other=await s.createPilotProject({name:'Other project',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const express=require('express'); const app=express();
  app.use(express.json({limit:'12mb'})); app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async (route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,route);return (await response.json()).data;};
  const changes=[
    {operation:'ADD',clientRef:'brand-logo',asset:asset('Dream Stream Logo','BRAND','REAL_REQUIRED')},
    {operation:'ADD',clientRef:'character',asset:asset('小男孩','CHAR','AI_ALLOWED')},
  ];
  const preview=await post('/assets/preview',{...scope,changes});
  const applied=await post('/assets/apply',{...scope,changes,previewHash:preview.previewHash});
  assert.equal(applied.applied[0].canonicalKey,'BRAND-001');
  assert.equal(applied.applied[1].canonicalKey,'CHAR-001');
  const assets={...scope,currentStage:'assets',currentRoute:'pilot/assets',selectedObject:{type:'ASSET',key:'BRAND-001'}};
  const png=await require('sharp')({create:{width:8,height:8,channels:4,background:'#203070'}}).png().toBuffer();
  const uploaded=await post('/agent/image/upload',{context:assets,name:'dreamstream桌面.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  await post('/agent/chat',{context:assets,message:'这是 Logo 的对话图片。',attachmentIds:[uploaded.id]});
  const reference={context:assets,attachmentId:uploaded.id,targetType:'ASSET_BIBLE',targetKey:'BRAND-001'};
  const referencePreview=await post('/agent/reference/preview',reference);
  await post('/agent/reference/apply',{...reference,previewHash:referencePreview.previewHash});
  assert.equal((await db('o_v04AgentAttachment').where({id:uploaded.id}).first()).purpose,'CONVERSATIONAL_REFERENCE','upload purpose is not silently promoted');
  assert.equal((await db('o_v04AgentReference').where({projectId:scope.projectId,targetKey:'BRAND-001',targetType:'ASSET_BIBLE'}).count({n:'id'}).first()).n,1);

  const creative={...scope,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null};
  const reply=await post('/agent/chat',{context:creative,message:'请讨论品牌结尾。',attachmentIds:[]});
  const system=oss.modelCalls.filter(call=>call.model==='fake:local').at(-1).system;
  const line=system.split('\n').find(line=>line.startsWith('项目 ACTIVE Asset Bible 索引'));
  const index=JSON.parse(line.slice(line.indexOf(': ')+2));
  assert.equal(index.length,2,'all active canonical identities remain visible without a selected asset');
  assert.deepEqual(index[0].confirmedAssetBibleReferences,['dreamstream桌面.png']);
  assert.equal(index[0].confirmedAssetBibleReferenceCount,1);
  assert.equal(index[0].canonicalKey,'BRAND-001');
  assert.equal(index[0].sourcePolicy,'REAL_REQUIRED');
  assert.equal(index[0].currentUnitProductionBinding.assetId,null,'confirmed Bible reference is not a production binding');
  assert.match(system,/CONFIRMED_ASSET_BIBLE_REFERENCE/);
  assert.match(system,/不要把已确认 reference 说成仍只是对话参考/);
  const relevantLine=system.split('\n').find(line=>line.startsWith('当前话题相关资产'));
  const relevant=JSON.parse(relevantLine.slice(relevantLine.indexOf(': ')+2));
  assert.deepEqual(relevant.map(item=>item.canonicalKey),['BRAND-001']);
  assert.equal(relevant[0].confirmedAssetBibleReferences[0].provenance,'CONFIRMED_ASSET_BIBLE_REFERENCE');
  assert.match(system,/已选资产详情（仅当前关注对象）: null/);
  assert.doesNotMatch(reply.reply,/仍然只是对话参考|尚未确认/);
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0,'context lookup does not create production media');

  const [shotId]=await db('o_storyboard').insert({projectId:scope.projectId,scriptId:scope.scriptId,index:0,prompt:'CHAR-001 小男孩在画面中',duration:3,state:'未生成'});
  await post('/agent/chat',{context:{...scope,currentStage:'storyboard',currentRoute:'pilot/storyboard',selectedObject:{type:'SHOT',key:String(shotId)}},message:'继续这个镜头的讨论。',attachmentIds:[]});
  const shotSystem=oss.modelCalls.filter(call=>call.model==='fake:local').at(-1).system;
  const shotRelevantLine=shotSystem.split('\n').find(line=>line.startsWith('当前话题相关资产'));
  assert.deepEqual(JSON.parse(shotRelevantLine.slice(shotRelevantLine.indexOf(': ')+2)).map(item=>item.canonicalKey),['CHAR-001']);

  await post('/agent/chat',{context:{...other,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null},message:'讨论品牌结尾。',attachmentIds:[]});
  const otherSystem=oss.modelCalls.filter(call=>call.model==='fake:local').at(-1).system;
  const otherLine=otherSystem.split('\n').find(line=>line.startsWith('项目 ACTIVE Asset Bible 索引'));
  assert.deepEqual(JSON.parse(otherLine.slice(otherLine.indexOf(': ')+2)),[]);
  assert.doesNotMatch(otherSystem,/dreamstream桌面\.png|BRAND-001|Dream Stream Logo/);
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
  oss.proposalOutput={proposedText:'Original brief, with a restrained reveal.',reason:'Keeps the exact interface while sharpening the opening.',proposedTargetDuration:null};
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const before=await db('o_v04Creative').where(scope).first();
  const result=await skills.previewCreativeProposal({...scope,target:'brief',instruction:'Make the opening clearer.'});
  assert.equal(result.applied,false);
  assert.equal(result.candidate.proposedText,oss.proposalOutput.proposedText);
  assert.equal(result.candidate.proposedTargetDuration,null);
  assert.match(oss.modelCalls[0].system,/Keep the product interface exact/);
  assert.match(oss.modelCalls[0].messages[0].content[0].text,/Make the opening clearer/);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before);
  const preview=await s.previewCreative({...scope,brief:result.candidate.proposedText,treatment:'',script:'',targetDuration:before.targetDuration,expectedVersion:before.version});
  assert.equal(preview.proposed.brief,result.candidate.proposedText);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before);
});

test('OPT-019 duration is versioned Creative Truth with zero-write preview and stale protection', async t => {
  const {db,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Duration',brief:'An unchanged brief',targetDuration:30,aspectRatio:'16:9'},7);
  const original=await db('o_v04Creative').where(scope).first();
  const change={...scope,brief:original.brief,treatment:original.treatment,script:original.script,targetDuration:40,expectedVersion:original.version};
  const preview=await s.previewCreative(change);
  assert.equal(preview.current.targetDuration,30);
  assert.equal(preview.proposed.targetDuration,40);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),original,'duration-only Preview does not write');
  await assert.rejects(s.applyCreative({...change,targetDuration:39,previewHash:preview.previewHash}),e=>e.code==='PILOT_PREVIEW_STALE','duration is part of preview hash');
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),original);
  await s.applyCreative({...change,previewHash:preview.previewHash});
  const persisted=await s.readPilot(scope);
  assert.equal(persisted.creative.targetDuration,40);
  assert.equal(persisted.creative.version,original.version+1);
  assert.equal(persisted.creative.brief,original.brief,'Brief is never rewritten to match duration');
  await assert.rejects(s.applyCreative({...change,previewHash:preview.previewHash}),e=>e.code==='PILOT_PREVIEW_STALE');
  const old={...scope,brief:'Old preview',treatment:'',script:'',targetDuration:40,expectedVersion:2};
  const oldPreview=await s.previewCreative(old);
  const other={...old,brief:'New confirmed brief'};
  const otherPreview=await s.previewCreative(other);
  await s.applyCreative({...other,previewHash:otherPreview.previewHash});
  await assert.rejects(s.applyCreative({...old,previewHash:oldPreview.previewHash}),e=>e.code==='PILOT_PREVIEW_STALE');
  assert.equal((await s.readPilot(scope)).creative.targetDuration,40);
});

test('OPT-019 Agent and Storyboard Skill receive confirmed duration; proposal duration requires explicit instruction', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Duration context',brief:'A brand story',targetDuration:30,aspectRatio:'16:9'},7);
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  oss.proposalOutput={proposedText:'Treatment explores a 38–40 second arc.',reason:'A clear arc.',proposedTargetDuration:40};
  const before=await db('o_v04Creative').where(scope).first();
  const implicit=await skills.previewCreativeProposal({...scope,target:'treatment',instruction:'Expand this treatment.'});
  assert.equal(implicit.candidate.proposedTargetDuration,null,'Treatment text cannot silently change canonical duration');
  assert.match(oss.modelCalls.at(-1).system,/"targetDuration":30/);
  const mention=await skills.previewCreativeProposal({...scope,target:'treatment',instruction:'Treatment 正文提到 40 秒，但目标时长不改。'});
  assert.equal(mention.candidate.proposedTargetDuration,null,'a duration mention with no change request remains null');
  const explicit=await skills.previewCreativeProposal({...scope,target:'treatment',instruction:'目标时长先按 38–40 秒设计，建议一个正式时长。'});
  assert.equal(explicit.candidate.proposedTargetDuration,40);
  assert.equal(explicit.applied,false);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before,'proposal never writes');
  const change={...scope,brief:before.brief,treatment:explicit.candidate.proposedText,script:before.script,targetDuration:explicit.candidate.proposedTargetDuration,expectedVersion:before.version};
  const preview=await s.previewCreative(change);
  assert.equal(preview.current.targetDuration,30);
  assert.equal(preview.proposed.targetDuration,40);
  assert.equal((await db('o_v04Creative').where(scope).first()).targetDuration,30);
  await s.applyCreative({...change,previewHash:preview.previewHash});
  await skills.previewCreativeProposal({...scope,target:'script',instruction:'Continue the script.'});
  assert.match(oss.modelCalls.at(-1).system,/"targetDuration":40/,'Project Agent reads the confirmed value');
  assert.match(oss.modelCalls.at(-1).system,/"aspectRatio":"16:9"/);
  oss.proposalOutput={shots:[{duration:3,prompt:'Brand ending',videoDesc:'',productionMode:'AI_TEXT_TO_IMAGE',primaryKey:null,canonicalKeys:[]}]};
  await skills.previewSkill({...scope,method:'STORYBOARD_BATCH'});
  assert.match(oss.modelCalls.at(-1).system,/"targetDuration":40/,'Storyboard Skill reads confirmed duration');
  assert.doesNotMatch(oss.modelCalls.at(-1).system,/"targetDuration":30/);
});

test('OPT-021 Skill provider failures are distinct, safely logged and zero-write for every method', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Skill errors',brief:'Current truth',targetDuration:40,aspectRatio:'16:9'},7);
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const before=await db('o_v04Creative').where(scope).first();
  const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
  for (const method of ['ASSET_EXTRACTION','ASSET_PROMPTS','STORYBOARD_BATCH']) {
    oss.skillResponses=[Object.assign(new Error('Authorization: Bearer private-token apiKey=secret'),{name:'APICallError',statusCode:503})];
    await assert.rejects(skills.previewSkill({...scope,method}),e=>e.code==='PILOT_SKILL_MODEL_FAILED');
    assert.equal(logs.at(-1)[1].method,method);
    assert.equal(logs.at(-1)[1].projectId,scope.projectId);
    assert.equal(logs.at(-1)[1].scriptId,scope.scriptId);
    assert.equal(logs.at(-1)[1].errorCode,'PILOT_SKILL_MODEL_FAILED');
    assert.equal(logs.at(-1)[1].status,503);
    assert.match(logs.at(-1)[1].correlationId,/^[0-9a-f-]{36}$/);
  }
  assert.doesNotMatch(JSON.stringify(logs),/private-token|apiKey=secret|Bearer/);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before);
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
});

test('OPT-021 shared structured classifier inspects wrapped causes without mistaking provider rejection for schema failure', async t => {
  const {db,cache,oss}=await fixture(t);
  const helper=loadSource(path.join(root,'src/v04/structuredOutputError.ts'),db,cache,oss);
  const z=require('zod');
  let malformed;try{z.object({required:z.string()}).parse({});}catch(error){malformed=error;}
  assert.equal(helper.structuredFailure(Object.assign(Error('wrapped'),{errors:[malformed]})),true);
  assert.equal(helper.structuredFailure(Object.assign(Error('wrapped'),{cause:Object.assign(Error('provider 503'),{name:'APICallError',statusCode:503})})),false);
  assert.equal(helper.safeStructuredStatus(Object.assign(Error('wrapped'),{cause:Object.assign(Error('provider 503'),{statusCode:503})})),503);
});

test('OPT-021 Skill HTTP returns separate safe provider and schema errors', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Skill HTTP',brief:'',targetDuration:40,aspectRatio:'16:9'},7);
  const express=require('express');const app=express();
  app.use(express.json());app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04/skills/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...scope,method:'ASSET_EXTRACTION'})});return {status:response.status,body:await response.json()};};
  oss.skillResponses=[Error('Authorization: Bearer private-token')];
  const provider=await post();
  assert.equal(provider.status,502);assert.equal(provider.body.code,'PILOT_SKILL_MODEL_FAILED');
  assert.match(provider.body.message,/供应商配置/);
  assert.doesNotMatch(JSON.stringify(provider.body),/private-token/);
  oss.skillResponses=[{candidates:[{}],mergeSuggestions:[]},{candidates:[{}],mergeSuggestions:[]}];
  const schema=await post();
  assert.equal(schema.status,502);assert.equal(schema.body.code,'PILOT_SKILL_SCHEMA_FAILED');
  assert.match(schema.body.message,/结构/);
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
});

test('OPT-021 structured Skill repair uses one pinned session and never persists a candidate', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Repair',brief:'Blue light',targetDuration:40,aspectRatio:'16:9'},7);
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const valid={candidates:[asset('Blue luminous matter','FX')],mergeSuggestions:[]};
  oss.skillResponses=[{candidates:[{name:'Missing contract fields'}],mergeSuggestions:[]},valid];
  const result=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(result.applied,false);
  assert.equal(result.output.candidates[0].name,valid.candidates[0].name);
  assert.equal(result.output.candidates[0].assetKind,'OTHER','old provider-shaped candidate remains compatible');
  assert.deepEqual(result.output.coverage,[]);
  assert.equal(result.sourceVersion,1);
  assert.equal(oss.sessionCount,1,'repair pins one model session');
  assert.equal(oss.modelCalls.length,2,'at most one repair');
  assert.equal(oss.modelCalls[0].model,oss.modelCalls[1].model);
  assert.match(oss.modelCalls[1].messages[1].content,/Missing contract fields/);
  assert.match(oss.modelCalls[1].messages[1].content,/Repair format and field types only/);
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
  oss.skillResponses=[{candidates:[{name:'Still missing'}],mergeSuggestions:[]},{candidates:[{name:'Still missing'}],mergeSuggestions:[]}];
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_SCHEMA_FAILED' && /结构/.test(e.message));
  assert.equal(oss.modelCalls.length,4,'failed repair does not start a third attempt');
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
});

test('OPT-021 Skill context and references fail closed; existing identity stays a merge suggestion', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Brand',brief:'Logo ending',targetDuration:40,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'logo',asset:asset('Dream Stream Logo','BRAND','REAL_REQUIRED')}];
  const plan=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:plan.previewHash});
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const beforeCreative=await db('o_v04Creative').where(scope).first();
  const beforeAssets=await db('o_v04Asset').where({projectId:scope.projectId});
  oss.contextFailure=Error('project context unavailable');
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_CONTEXT_FAILED');
  oss.contextFailure=null;
  oss.textModelUnavailable=true;
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_MODEL_FAILED');
  oss.textModelUnavailable=false;
  const duplicate=asset('Dream Stream Logo','BRAND','REAL_REQUIRED');
  oss.proposalOutput={candidates:[duplicate],mergeSuggestions:[{candidateIndex:0,existingCanonicalKey:'BRAND-999',reason:'duplicate'}]};
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_REFERENCE_INVALID');
  oss.proposalOutput={candidates:[{...asset('Blue matter','FX'),ownerKey:'FX-999'}],mergeSuggestions:[]};
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_REFERENCE_INVALID');
  oss.proposalOutput={candidates:[duplicate],mergeSuggestions:[]};
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_REFERENCE_INVALID','exact existing identity needs a merge suggestion');
  oss.proposalOutput={candidates:[duplicate,asset('Blue luminous matter','FX')],mergeSuggestions:[{candidateIndex:0,existingCanonicalKey:'BRAND-001',reason:'已有品牌 Logo'}]};
  const proposal=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(proposal.applied,false);
  assert.equal(proposal.output.mergeSuggestions[0].existingCanonicalKey,'BRAND-001');
  assert.match(oss.modelCalls.at(-1).system,/已有 canonical identity 不得重复创建/);
  assert.match(oss.modelCalls.at(-1).system,/持续 FX/);
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),beforeCreative);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),beforeAssets);
  const creativeChange={...scope,brief:'New confirmed brief',treatment:'',script:'',targetDuration:40,expectedVersion:1};
  const creativePreview=await s.previewCreative(creativeChange);
  await s.applyCreative({...creativeChange,previewHash:creativePreview.previewHash});
  const staleChanges=[{operation:'ADD',clientRef:'blue',asset:asset('Blue luminous matter','FX')}];
  await assert.rejects(s.previewAssets({...scope,changes:staleChanges,sourceCreativeVersion:proposal.sourceVersion}),e=>e.code==='PILOT_SOURCE_STALE');
});

test('V0.4 coverage extraction stays proposal-only, then confirmed assets get scoped review plans and relations', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Dream matter',brief:'Dream Stream brand film',targetDuration:40,aspectRatio:'16:9'},7);
  const other=await s.createPilotProject({name:'Other film',brief:'Separate world',targetDuration:30,aspectRatio:'16:9'},7);
  const brand=[{operation:'ADD',clientRef:'logo',asset:asset('Dream Stream Logo','BRAND','REAL_REQUIRED')}];
  const brandPreview=await s.previewAssets({...scope,changes:brand});await s.applyAssets({...scope,changes:brand,previewHash:brandPreview.previewHash});
  const treatment='小男孩在静谧海岛·夜看见鲸鱼，穿过广阔海域·夜与鲸腹梦境空间。海盗船、潜水艇、飞马共享蓝色梦物质，驶向云端月夜与月亮目标构图。Dream Stream Logo 片尾出现，远处的灯塔仍待设计。';
  const creative={...scope,brief:'Dream Stream brand film',treatment,script:'',targetDuration:40,expectedVersion:1};
  const creativePreview=await s.previewCreative(creative);await s.applyCreative({...creative,previewHash:creativePreview.previewHash});
  const specs=[
    ['小男孩','CHAR','HUMAN_CHARACTER','CORE'],['鲸鱼','CHAR','CREATURE','CORE'],['海盗船','PROP','VEHICLE','CORE'],['潜水艇','PROP','VEHICLE','CORE'],['飞马','CHAR','CREATURE','CORE'],
    ['蓝色梦物质','FX','MATERIAL_FX','SUPPORTING'],['静谧海岛·夜','LOC','ENVIRONMENT','SUPPORTING'],['广阔海域·夜','LOC','ENVIRONMENT','SUPPORTING'],['鲸腹梦境空间','LOC','ENVIRONMENT','SUPPORTING'],['云端月夜','LOC','CELESTIAL','SUPPORTING'],
  ];
  const candidates=specs.map(([name,category,assetKind,importance],index)=>({...asset(name,category),assetKind,importance,relatedExistingKeys:[],relatedCandidateIndexes:index===5?[2,3,4]:[],sharedVisualSystemKey:null,sharedVisualSystemCandidateIndex:[2,3,4].includes(index)?5:null,extractionPass:index<5?'ENTITY':index===5?'VISUAL_SYSTEM':'ENVIRONMENT'}));
  const coverage=specs.map(([name],index)=>({label:name,coverageType:['PERSON','CREATURE','VEHICLE','VEHICLE','CREATURE','FX_MATERIAL','SCENE','SCENE','SCENE','COMPOSITION_GOAL'][index],classification:index===5?'VISUAL_SYSTEM':'CANONICAL_ASSET',candidateIndexes:[index],existingCanonicalKeys:[],note:''}));
  coverage.push({label:'Dream Stream Logo',coverageType:'BRAND',classification:'CANONICAL_ASSET',candidateIndexes:[],existingCanonicalKeys:['BRAND-001'],note:'Use real confirmed reference'});
  coverage.push({label:'月亮目标构图',coverageType:'COMPOSITION_GOAL',classification:'COMPOSITION_MOTIF',candidateIndexes:[],existingCanonicalKeys:[],note:'Shot composition, not a new canonical identity'});
  coverage.push({label:'远处灯塔',coverageType:'SCENE',classification:'SCENE_ANCHOR',candidateIndexes:[],existingCanonicalKeys:[],note:'Still missing'});
  oss.proposalOutput={candidates,mergeSuggestions:[],coverage};
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const proposed=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(proposed.skillId,'v04.asset-extraction.v2');
  assert.equal(proposed.output.candidates.length,10);
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId}).count({n:'canonicalKey'}).first()).n,1,'extraction alone does not persist candidates');
  assert.equal((await db('o_v04AssetCoverage').where(scope).count({n:'position'}).first()).n,0);
  assert.equal((await db('o_v04AssetReviewPlan').where(scope).count({n:'canonicalKey'}).first()).n,1);
  await assert.rejects(s.previewAssets({...scope,changes:[{operation:'ADD',clientRef:'invalid',asset:{...asset('Bad ship','PROP'),assetKind:'VEHICLE',sharedVisualSystemKey:'BRAND-001'}}]}),e=>e.code==='PILOT_RELATION_INVALID','a logo cannot masquerade as a visual system');
  const refs=candidates.map((_,i)=>`candidate_${i}`);
  const changes=candidates.map((c,i)=>{const {relatedExistingKeys,relatedCandidateIndexes,sharedVisualSystemCandidateIndex,extractionPass,...fields}=c;return {operation:'ADD',clientRef:refs[i],asset:{...fields,relatedKeys:relatedExistingKeys},relatedClientRefs:relatedCandidateIndexes.map(j=>refs[j]),sharedVisualSystemClientRef:sharedVisualSystemCandidateIndex===null?null:refs[sharedVisualSystemCandidateIndex]};});
  const coverageRequest=coverage.map(item=>({label:item.label,coverageType:item.coverageType,classification:item.classification,candidateRefs:item.candidateIndexes.map(i=>refs[i]),existingCanonicalKeys:item.existingCanonicalKeys,note:item.note}));
  const input={...scope,changes,coverage:coverageRequest,sourceCreativeVersion:proposed.sourceVersion};
  const preview=await s.previewAssets(input);
  assert.equal((await db('o_v04AssetCoverage').where(scope).count({n:'position'}).first()).n,0,'preview is zero write');
  const applied=await s.applyAssets({...input,previewHash:preview.previewHash});
  const keys=new Map(applied.applied.map(row=>[row.clientRef,row.canonicalKey]));
  const state=await s.readPilot(scope);
  assert.equal(state.assets.filter(a=>a.name==='Dream Stream Logo').length,1,'BRAND-001 not duplicated');
  assert.equal(state.assets.length,11);
  const ship=state.assets.find(a=>a.name==='海盗船'); const matter=state.assets.find(a=>a.name==='蓝色梦物质');
  assert.equal(ship.sharedVisualSystemKey,matter.canonicalKey);
  assert.deepEqual(matter.relatedKeys.sort(),[keys.get(refs[2]),keys.get(refs[3]),keys.get(refs[4])].sort());
  for(const i of [0,1,2,3,4]) { const plan=state.reviewPlans.find(p=>p.canonicalKey===keys.get(refs[i]));assert.equal(plan.turnaroundStatus,'PLANNED');assert.deepEqual(plan.turnaroundSpec.views,['FRONT','SIDE','BACK']);assert.equal(plan.previewSpec.maxEdge,512);assert.equal(plan.previewSpec.reviewOnly,true); }
  for(const i of [6,7,8,9]) {const plan=state.reviewPlans.find(p=>p.canonicalKey===keys.get(refs[i]));assert.equal(plan.previewKind,'ESTABLISHING');assert.equal(plan.turnaroundStatus,'NOT_APPLICABLE');}
  assert.equal(state.reviewPlans.find(p=>p.canonicalKey==='BRAND-001').previewStatus,'REFERENCE_REQUIRED');
  assert.equal(state.reviewPlans.find(p=>p.canonicalKey==='BRAND-001').previewSpec.aiRedrawAllowed,false);
  assert.equal(state.reviewPlans.every(p=>p.previewFilePath===null),true,'plans never pretend to contain generated media');
  assert.equal(state.coverage.items.find(x=>x.label==='远处灯塔').status,'UNCOVERED');
  assert.equal(state.coverage.items.find(x=>x.label==='月亮目标构图').status,'DOCUMENTED');
  assert.equal(state.coverage.items.find(x=>x.label==='Dream Stream Logo').status,'COVERED');
  assert.deepEqual((await s.readPilot(other)).assets,[],'another project sees no canonical assets');
  const contextApi=loadSource(path.join(root,'src/v04/agentContext.ts'),db,cache,oss);
  const agentContext=await contextApi.buildProjectAgentContext({...scope,currentStage:'storyboard',currentRoute:'pilot/storyboard',selectedObject:null},'检查素材覆盖');
  assert.equal(agentContext.assetCoverage.items.find(item=>item.label==='远处灯塔').status,'UNCOVERED');
  assert.equal(agentContext.assetBibleIndex.find(item=>item.name==='海盗船').reviewPlan.turnaroundStatus,'PLANNED');
  const otherContext=await contextApi.buildProjectAgentContext({...other,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null},'检查素材覆盖');
  assert.deepEqual(otherContext.assetCoverage.items,[]);
  await assert.rejects(s.planOptionalTurnaround({...other,canonicalKey:ship.canonicalKey}),e=>e.code==='PILOT_TURNAROUND_UNAVAILABLE');
  const supporting={...asset('Compass','PROP'),assetKind:'PROP',importance:'SUPPORTING'};
  const extra=[{operation:'ADD',clientRef:'compass',asset:supporting}];const extraPreview=await s.previewAssets({...scope,changes:extra});
  const extraApplied=await s.applyAssets({...scope,changes:extra,previewHash:extraPreview.previewHash});
  const compassKey=extraApplied.applied[0].canonicalKey;
  assert.equal((await s.readPilot(scope)).reviewPlans.find(p=>p.canonicalKey===compassKey).turnaroundStatus,'OPTIONAL');
  const express=require('express');const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04/assets/turnaround/plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...scope,canonicalKey:compassKey})});
  assert.equal(response.status,200);assert.equal((await response.json()).data.generated,false);
  assert.equal((await s.readPilot(scope)).reviewPlans.find(p=>p.canonicalKey===compassKey).turnaroundStatus,'PLANNED');
  const realEdit=[{operation:'EDIT',canonicalKey:compassKey,expectedRevision:1,patch:{sourcePolicy:'REAL_REQUIRED'}}];
  const realPreview=await s.previewAssets({...scope,changes:realEdit});await s.applyAssets({...scope,changes:realEdit,previewHash:realPreview.previewHash});
  const realState=await s.readPilot(scope);const realReview=realState.reviewPlans.find(p=>p.canonicalKey===compassKey);
  assert.equal(realReview.previewStatus,'REFERENCE_REQUIRED');assert.equal(realReview.turnaroundStatus,'NOT_APPLICABLE');assert.equal(realReview.previewSpec.aiRedrawAllowed,false);
  assert.equal(realState.assetPlan.find(item=>item.assetKey===compassKey).assetId,null,'REAL_REQUIRED is not inferred from a planned AI asset');
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0,'planning never creates a production image');
  const changedCreative={...scope,brief:'Dream Stream brand film',treatment:treatment+' 新的场景需求。',script:'',targetDuration:40,expectedVersion:2};
  const changePreview=await s.previewCreative(changedCreative);await s.applyCreative({...changedCreative,previewHash:changePreview.previewHash});
  assert.equal((await s.readPilot(scope)).coverage.stale,true,'changed Creative truth invalidates accepted coverage audit');
  assert.equal(oss.modelCalls.length,1,'no image or paid production calls');
});

test('nonempty Treatment requires a real coverage audit; repair is bounded and still zero-write', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Audit',brief:'A boy and a whale',targetDuration:30,aspectRatio:'16:9'},7);
  const creative={...scope,brief:'A boy and a whale',treatment:'A whale crosses the night sea.',script:'',targetDuration:30,expectedVersion:1};
  const preview=await s.previewCreative(creative);await s.applyCreative({...creative,previewHash:preview.previewHash});
  const valid={candidates:[{...asset('Whale','CHAR'),assetKind:'CREATURE',importance:'CORE',extractionPass:'ENTITY'}],mergeSuggestions:[],coverage:[{label:'Whale',coverageType:'CREATURE',classification:'CANONICAL_ASSET',candidateIndexes:[0],existingCanonicalKeys:[],note:''},{label:'Night sea',coverageType:'SCENE',classification:'SCENE_ANCHOR',candidateIndexes:[],existingCanonicalKeys:[],note:'Missing environment'}]};
  oss.skillResponses=[{...valid,coverage:[]},valid];
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const result=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(result.output.coverage.length,2);
  assert.equal(oss.sessionCount,1);
  assert.equal(oss.modelCalls.length,2);
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
  assert.equal((await db('o_v04AssetCoverage').count({n:'position'}).first()).n,0);
  oss.skillResponses=[{...valid,coverage:[]},{...valid,coverage:[]}];
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_SCHEMA_FAILED');
  assert.equal((await db('o_v04AssetCoverage').count({n:'position'}).first()).n,0);
});

test('OPT-018 Proposal uses shared project truth and cached Vision text, never a recent raw image in the text model', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Creative truth',brief:'品牌片尾',targetDuration:30,aspectRatio:'16:9'},7);
  const other=await s.createPilotProject({name:'Separate project',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'logo',asset:asset('Dream Stream Logo','BRAND','REAL_REQUIRED')}];
  const plan=await s.previewAssets({...scope,changes});
  await s.applyAssets({...scope,changes,previewHash:plan.previewHash});
  const ctx={...scope,currentStage:'assets',currentRoute:'pilot/assets',selectedObject:{type:'ASSET',key:'BRAND-001'}};
  const express=require('express'); const app=express();
  app.use(express.json({limit:'12mb'})); app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async (route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const png=await require('sharp')({create:{width:8,height:8,channels:4,background:'#203070'}}).png().toBuffer();
  const upload=await post('/agent/image/upload',{context:ctx,name:'dreamstream桌面.png',dataUrl:`data:image/png;base64,${png.toString('base64')}`});
  assert.equal(upload.status,200);
  const attachmentId=upload.body.data.id;
  assert.equal((await post('/agent/chat',{context:ctx,message:'分析 Logo 构图。',attachmentIds:[attachmentId]})).status,200);
  const ref={context:ctx,attachmentId,targetType:'ASSET_BIBLE',targetKey:'BRAND-001'};
  const refPreview=await post('/agent/reference/preview',ref);
  assert.equal((await post('/agent/reference/apply',{...ref,previewHash:refPreview.body.data.previewHash})).status,200);
  await db('memories').insert({id:'old-wrong-agent',isolationKey:`project:${scope.projectId}:projectAgent`,type:'message',role:'assistant',content:'BRAND-001 不存在；Logo 只是对话参考。',embedding:null,summarized:0,createTime:Date.now()+1});
  const before=await db('o_v04Creative').where(scope).first();
  const visionCalls=oss.visionCalls;
  oss.proposalOutput={proposedText:'保留真实 Dream Stream Logo 的品牌片尾。',reason:'使用当前确认的品牌参考。',proposedTargetDuration:null};
  const proposal=await post('/agent/creative-proposal',{...scope,target:'treatment',instruction:'就按刚才这一版，核心内容不要再改。'});
  assert.equal(proposal.status,200);
  assert.equal(proposal.body.data.applied,false);
  const call=oss.modelCalls.at(-1);
  assert.equal(call.model,'fake:local');
  assert.ok(call.output,'Proposal still uses schema-native Output.object');
  assert.ok(call.messages[0].content.every(part=>part.type==='text'),'text-only model receives no image parts');
  assert.doesNotMatch(JSON.stringify(call.messages),/data:image|base64/i);
  assert.match(call.system,/BRAND-001/);
  assert.match(call.system,/Dream Stream Logo/);
  assert.match(call.system,/dreamstream桌面\.png/);
  assert.match(call.system,/CONFIRMED_ASSET_BIBLE_REFERENCE/);
  assert.match(call.system,/"currentUnitProductionBinding":\{"assetId":null/);
  assert.match(call.system,/A dark blue image with a bright logo/,'confirmed reference reuses cached VisionObservation');
  assert.match(call.system,/BRAND-001 不存在/,'old false conversation remains history, not truth');
  assert.match(call.system,/若旧对话、视觉观察或摘要与当前项目权威状态冲突/);
  assert.match(call.messages[0].content[0].text,/就按刚才这一版/);
  assert.equal(oss.visionCalls,visionCalls,'Proposal does not recall Vision provider when cache exists');
  assert.deepEqual(await db('o_v04Creative').where(scope).first(),before,'Proposal remains a candidate');
  assert.equal((await db('o_image').count({n:'id'}).first()).n,0,'confirmed Bible reference is not production media');

  await db('o_v04VisionAnalysis').where({attachmentId}).del();
  assert.equal((await post('/agent/creative-proposal',{...scope,target:'treatment',instruction:'仍保留品牌结尾。'})).status,200);
  assert.equal(oss.visionCalls,visionCalls,'missing cache does not silently trigger a Vision provider call');
  assert.doesNotMatch(oss.modelCalls.at(-1).system,/A dark blue image with a bright logo/,'without cache, Proposal does not invent visual details');
  for (const target of ['brief','script']) {
    assert.equal((await post('/agent/creative-proposal',{...scope,target,instruction:'保留权威 Logo 事实。'})).status,200);
    assert.match(oss.modelCalls.at(-1).system,/CONFIRMED_ASSET_BIBLE_REFERENCE/);
    assert.ok(oss.modelCalls.at(-1).messages[0].content.every(part=>part.type==='text'));
  }

  oss.proposalOutput={candidates:[],mergeSuggestions:[]};
  const skill=await post('/skills/preview',{...scope,method:'ASSET_EXTRACTION'});
  assert.equal(skill.status,200);
  assert.match(oss.modelCalls.at(-1).system,/CONFIRMED_ASSET_BIBLE_REFERENCE/,'V0.4 Skills use the same authoritative context');

  oss.proposalOutput={proposedText:'Other project treatment.',reason:'Separate truth.',proposedTargetDuration:null};
  assert.equal((await post('/agent/creative-proposal',{...other,target:'treatment',instruction:'继续。'})).status,200);
  assert.doesNotMatch(oss.modelCalls.at(-1).system,/BRAND-001|dreamstream桌面\.png|Dream Stream Logo/,'another project cannot read the first project truth');
});

test('OPT-018 Creative Proposal returns distinct safe context, model and schema errors over HTTP', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Error boundary',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const express=require('express'); const app=express();
  app.use(express.json({limit:'12mb'})); app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04/agent/creative-proposal`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...scope,target:'treatment',instruction:'保持真实 Logo'})});return {status:response.status,body:await response.json()};};
  oss.contextFailure=Error('Authorization: Bearer hidden-token');
  const context=await post();
  assert.equal(context.status,503); assert.equal(context.body.code,'PILOT_CREATIVE_CONTEXT_FAILED');
  assert.match(context.body.message,/项目上下文读取失败/);
  assert.doesNotMatch(JSON.stringify(context.body),/hidden-token/);
  oss.contextFailure=null;
  oss.textModelUnavailable=true;
  const missing=await post();
  assert.equal(missing.status,502); assert.equal(missing.body.code,'PILOT_CREATIVE_MODEL_FAILED');
  assert.match(missing.body.message,/文本模型不可用/);
  oss.textModelUnavailable=false;
  oss.textError=true;
  const provider=await post();
  assert.equal(provider.status,502); assert.equal(provider.body.code,'PILOT_CREATIVE_MODEL_FAILED');
  assert.match(provider.body.message,/供应商配置/);
  oss.textError=false;
  oss.proposalOutput={proposedText:'',reason:'bad',proposedTargetDuration:null};
  const malformed=await post();
  assert.equal(malformed.status,502); assert.equal(malformed.body.code,'PILOT_CREATIVE_SCHEMA_FAILED');
  assert.match(malformed.body.message,/结构不符合要求/);
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
  const input = {...scope,brief:'Revised',treatment:'A new treatment',script:'Scene one',targetDuration:30,expectedVersion:1};
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
  const nextCreative={...scope,brief:'Revised again',treatment:'Another treatment',script:'Scene two',targetDuration:30,expectedVersion:2};
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
