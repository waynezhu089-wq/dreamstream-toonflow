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
    }, invoke: async input => {
      oss.modelCalls.push({ model, ...input, method: input.output ? 'invokeJson' : 'invokeText' });
      const next=input.output ? oss.skillResponses?.shift() : oss.studioResponses?.shift();
      if (next instanceof Error) throw next;
      if (oss.modelError) throw Error('provider call failed');
      if (!input.output) return { text: next === undefined ? JSON.stringify(oss.proposalOutput) : next };
      return { output: next ?? oss.proposalOutput };
    } }; }, invoke: async input => {
      oss.modelCalls.push({ model, ...input });
      if (model.startsWith('fake:vision')) throw Error('Vision must use structured output');
      if (oss.textError) throw Error('text provider failed');
      const next=oss.skillResponses?.shift();
      if (next instanceof Error) throw next;
      return { text: 'I can discuss the observed image in this project.', output: next ?? oss.proposalOutput };
    } }) } };
    if (name === '@/utils/getPath') return value => path.join(oss.testDir,...(Array.isArray(value)?value:[value||'v04-conversation']));
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
const {randomUUID,createHash}=require('node:crypto');
const pngHash=b=>createHash('sha256').update(b).digest('hex');
async function editFixture(t){
 const f=await fixture(t);const {db,oss,cache,service}=f;const scope=await service.createPilotProject({name:'Image edit',brief:'A boy',targetDuration:30,aspectRatio:'16:9'},7);
 const png=await require('sharp')({create:{width:32,height:32,channels:3,background:'#527080'}}).png().toBuffer();
 await db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey:'CHAR-001',category:'CHAR',name:'Boy',description:'A boy in sleepwear',sourcePolicy:'AI_ALLOWED',assetKind:'HUMAN_CHARACTER',importance:'CORE',status:'ACTIVE',revision:1,createdAt:1,updatedAt:1});
 const media=new Map();const imageFile=path.join(root,'src/v04/studioDraftImage.ts');cache.set(imageFile,{exports:{getDraftArtifact:async(p,id)=>{const row=await db('o_v04StudioDraftArtifact').where({projectId:p,artifactId:id}).first();if(!row)throw Error('artifact missing');return {bytes:media.get(id),mimeType:'image/png'};},wakeDraftWorker:()=>{}}});
 async function source(role='MAIN_PREVIEW',status='SUCCEEDED',time=1,mode='CHARACTER_TURNAROUND'){
  const id=randomUUID(),artifactId=randomUUID(),out={artifactId,role,mimeType:'image/png',width:32,height:32,fileRef:'/api/v04/studio/artifact/'+scope.projectId+'/'+artifactId};media.set(artifactId,png);
  await db('o_v04StudioAssetDraftJob').insert({id,...scope,canonicalKey:'CHAR-001',sourceAssetRevision:1,draftHash:'a'.repeat(64),generationIntent:mode,executionPurpose:role==='MAIN_PREVIEW'?null:role,executorType:'COMFY_LOCAL',executorProfile:'OLD',workflowVersion:'old',status,inputSnapshotJson:'{}',outputsJson:JSON.stringify([out]),attemptCount:1,createdAt:time,updatedAt:time});
  await db('o_v04StudioDraftArtifact').insert({artifactId,jobId:id,projectId:scope.projectId,mimeType:'image/png',extension:'png',role,width:32,height:32,createdAt:time});return {id,artifactId,out};
 }
 const main=await source();const mod=loadSource(path.join(root,'src/v04/assetImageEdit.ts'),db,cache,oss);
 const intent={canonicalKey:'CHAR-001',editMode:'TEXT_EDIT',targetRole:'EDIT_CANDIDATE',editPrompt:'Preserve same boy, improve lighting.'};
 return {...f,scope,png,media,main,source,mod,intent};
}
async function settled(f,id,status='SUCCEEDED'){
 const j=await f.db('o_v04StudioAssetDraftJob').where({id}).first(),artifactId=randomUUID();f.media.set(artifactId,f.png);
 await f.db('o_v04StudioDraftArtifact').insert({artifactId,jobId:id,projectId:f.scope.projectId,mimeType:'image/png',extension:'png',role:j.executionPurpose,width:32,height:32,createdAt:Date.now()});await f.db('o_v04StudioAssetDraftJob').where({id}).update({status,outputsJson:JSON.stringify([{artifactId,role:j.executionPurpose}]),updatedAt:Date.now()});return artifactId;
}
test('OPT-029A profiles bind source to both latent patch and grounded encoder; edits cannot silently become T2I',()=>{
 const {buildKreaEditWorkflow:build}=loadSource(path.join(root,'src/v04/kreaImageEditProfile.ts'),null);
 const g=build({profile:'KREA2_REFERENCE_EDIT_V1',prompt:'style only',seed:1,sourceImage:'source.png',referenceImage:'style.png',targetRole:'EDIT_CANDIDATE',jobId:'test'}).graph;
 assert.equal(g['9'].inputs.lora_name,'krea2_identity_edit_v1_2.safetensors');assert.deepEqual(g['12'].inputs.source_latent_b,['8',0]);assert.deepEqual(g['5'].inputs.image_b,['7',0]);assert.deepEqual(g['12'].inputs.target_latent,['4',0]);assert.deepEqual(g['20'].inputs.model,['12',0]);assert.equal(g['12'].inputs.ref_boost,4);assert.equal(g['2'].inputs.device,'cpu');
 assert.throws(()=>build({profile:'KREA2_SOURCE_EDIT_V1',prompt:'edit',seed:1,targetRole:'EDIT_CANDIDATE',jobId:'test'}),e=>e.code==='SOURCE_MISSING');
 assert.throws(()=>build({profile:'KREA2_T2I_ASSET_V1',prompt:'edit',seed:1,sourceImage:'source.png',targetRole:'EDIT_CANDIDATE',jobId:'test'}),e=>e.code==='CAPABILITY_LIMITED');
});
test('OPT-029A enqueue persists frozen lineage but never mutates truth, source job or confirmed specs',async t=>{
 const f=await editFixture(t),before=await f.db('o_v04Asset'),id=randomUUID();const first=await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);const second=await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);assert.equal(first.jobId,second.jobId);const jobs=await f.db('o_v04StudioAssetDraftJob');assert.equal(jobs.length,2);const j=jobs.find(j=>j.id===id),s=JSON.parse(j.inputSnapshotJson);assert.equal(s.sourceArtifactId,f.main.artifactId);assert.equal(s.sourceSha256,pngHash(f.png));assert.equal(j.status,'QUEUED');assert.equal(j.executorProfile,'KREA2_SOURCE_EDIT_V1');assert.deepEqual(await f.db('o_v04Asset'),before);assert.equal((await f.db('o_v04AssetVisualSpec')).length,0);assert.equal((await f.db('o_v04AssetPromptBuild')).length,0);assert.equal((await f.db('o_v04AgentReference')).length,0);assert.equal((await f.db('o_v04StudioAssetDraftJob').where({id:f.main.id}).first()).status,'SUCCEEDED');
});
test('OPT-029A source role priority and persisted V1 to V2 survive reload, rejected parents cannot be reused',async t=>{
 const f=await editFixture(t);const front=await f.source('FULL_BODY_FRONT','SUCCEEDED',2),face=await f.source('FACE_HERO','SUCCEEDED',3);const id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,{...f.intent,targetRole:'FACE_HERO'},id);assert.equal(JSON.parse((await f.db('o_v04StudioAssetDraftJob').where({id}).first()).inputSnapshotJson).sourceArtifactId,face.artifactId);await settled(f,id);
 const v2=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,v2);const s=JSON.parse((await f.db('o_v04StudioAssetDraftJob').where({id:v2}).first()).inputSnapshotJson);assert.equal(s.parentCandidateId,id);assert.equal(s.sourceJobId,id);assert.notEqual(s.sourceArtifactId,front.artifactId);assert.equal((await f.mod.listAssetImageCandidates(f.scope)).length,2);await f.mod.rejectAssetImageCandidate({...f.scope,jobId:id});await assert.rejects(f.mod.enqueueAssetImageEdit(f.scope,f.intent,randomUUID(),id),e=>e.code==='PILOT_SOURCE_STALE');
});
test('OPT-029A REAL_REQUIRED / BRAND and cross-unit source are rejected before job insertion',async t=>{
 const f=await editFixture(t);await f.db('o_v04Asset').where({projectId:f.scope.projectId}).update({category:'BRAND',assetKind:'BRAND_MARK',sourcePolicy:'REAL_REQUIRED'});await assert.rejects(f.mod.enqueueAssetImageEdit(f.scope,f.intent,randomUUID()),e=>e.code==='PILOT_REAL_REFERENCE_ONLY');assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,1);await assert.rejects(f.mod.enqueueAssetImageEdit({...f.scope,scriptId:999},f.intent,randomUUID()),e=>e.code==='PILOT_SCOPE_INVALID');
});
test('OPT-029A candidate Preview is zero-write; accept is explicit hash-protected reference promotion and replay-safe',async t=>{
 const f=await editFixture(t),id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);const artifact=await settled(f,id);const before=await f.db('o_v04Asset');const p=await f.mod.previewAssetImageCandidate({...f.scope,jobId:id});assert.equal((await f.db('o_v04Decision')).length,0);assert.equal((await f.db('o_v04AgentReference')).length,0);
 await assert.rejects(f.mod.acceptAssetImageCandidate({...f.scope,jobId:id,previewHash:'0'.repeat(64)}),e=>e.code==='PILOT_PREVIEW_STALE');const result=await f.mod.acceptAssetImageCandidate({...f.scope,jobId:id,previewHash:p.previewHash});assert.equal(result.artifactId,artifact);assert.equal((await f.db('o_v04AgentReference'))[0].targetType,'ASSET_BIBLE');assert.equal((await f.db('o_v04AgentAttachment'))[0].purpose,'GENERATED_CANDIDATE');await f.mod.acceptAssetImageCandidate({...f.scope,jobId:id,previewHash:p.previewHash});assert.equal((await f.db('o_v04Decision')).length,1);assert.equal((await f.db('o_v04AgentAttachment')).length,1);assert.deepEqual(await f.db('o_v04Asset'),before);assert.equal((await f.db('o_v04AssetVisualSpec')).length,0);await assert.rejects(f.mod.rejectAssetImageCandidate({...f.scope,jobId:id}),e=>e.code==='PILOT_CANDIDATE_ACCEPTED');
});
test('OPT-029A asset revision drift prevents adoption and reference scope is exact',async t=>{
 const f=await editFixture(t),id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);await settled(f,id);const p=await f.mod.previewAssetImageCandidate({...f.scope,jobId:id});await f.db('o_v04Asset').where({projectId:f.scope.projectId}).update({revision:2});await assert.rejects(f.mod.acceptAssetImageCandidate({...f.scope,jobId:id,previewHash:p.previewHash}),e=>e.code==='PILOT_SOURCE_STALE');assert.equal((await f.db('o_v04Decision')).length,0);await f.db('o_v04Asset').where({projectId:f.scope.projectId}).update({revision:1});await assert.rejects(f.mod.enqueueAssetImageEdit(f.scope,{...f.intent,referenceBindings:[{attachmentId:randomUUID(),role:'STYLE_REFERENCE'}]},randomUUID()),e=>e.code==='PILOT_REFERENCE_INVALID');
});
test('OPT-029A actual worker uses fake Comfy once, persists artifact; stale completion retains output without becoming current',async t=>{
 const f=await editFixture(t);const http=require('node:http');let prompts=0,hold=false,release;
 const comfy=http.createServer((req,res)=>{res.setHeader('content-type',req.url.startsWith('/view')?'image/png':'application/json');if(req.url==='/upload/image'){req.resume();return res.end(JSON.stringify({name:'source.png',type:'input',subfolder:''}));}if(req.url==='/prompt'){let body='';req.on('data',x=>body+=x);req.on('end',()=>{const g=JSON.parse(body).prompt;assert.equal(g['12'].class_type,'Krea2EditModelPatch');prompts++;res.end(JSON.stringify({prompt_id:'edit-'+prompts}));});return;}if(req.url.startsWith('/history/')){const id=req.url.split('/').pop(),send=()=>res.end(JSON.stringify({[id]:{status:{completed:true},outputs:{'22':{images:[{filename:'edited.png',subfolder:'',type:'output'}]}}}}));if(hold){release=send;}else send();return;}if(req.url.startsWith('/view'))return res.end(f.png);res.statusCode=404;res.end('{}');});await new Promise(r=>comfy.listen(0,'127.0.0.1',r));t.after(()=>comfy.close());await f.db('o_v04StudioImageExecutorConfig').insert({projectId:f.scope.projectId,baseUrl:'http://127.0.0.1:'+comfy.address().port,checkpoint:'unused',enabled:1,updatedAt:1});
 const id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);await f.db('o_v04StudioAssetDraftJob').where({id}).update({status:'RUNNING'});await f.mod.produceAssetImageEdit(await f.db('o_v04StudioAssetDraftJob').where({id}).first(),true);assert.equal((await f.db('o_v04StudioAssetDraftJob').where({id}).first()).status,'SUCCEEDED');assert.equal(prompts,1);assert.equal((await f.db('o_v04StudioDraftArtifact').where({jobId:id})).length,1);
 // Use a separate scope source, without teaching the fake artifact reader generated files.
 f.media.set(JSON.parse((await f.db('o_v04StudioAssetDraftJob').where({id}).first()).outputsJson)[0].artifactId,f.png);const next=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,next);await f.db('o_v04StudioAssetDraftJob').where({id:next}).update({status:'RUNNING'});hold=true;const done=f.mod.produceAssetImageEdit(await f.db('o_v04StudioAssetDraftJob').where({id:next}).first(),true);while(!release)await new Promise(r=>setTimeout(r,10));await f.db('o_v04Asset').where({projectId:f.scope.projectId}).update({revision:2});release();await done;const stale=await f.db('o_v04StudioAssetDraftJob').where({id:next}).first();assert.equal(stale.status,'STALE');assert.equal(JSON.parse(stale.outputsJson).length,1);assert.equal(prompts,2);assert.equal((await f.db('o_v04AgentReference')).length,0);assert.equal((await f.db('o_v04StudioAssetDraftJob').where({id:f.main.id}).first()).status,'SUCCEEDED');
});
test('OPT-029A authenticated Studio HTTP intent persists conversation and candidate; unowned project is blocked',async t=>{
 const f=await editFixture(t),express=require('express'),app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:Number(req.headers['x-test-user']||7)};next();});app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),f.db,f.cache,f.oss).default);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>server.close());
 f.oss.studioResponses=[JSON.stringify({mode:'ASSET_IMAGE_EDIT',reply:'准备候选',imageIntent:f.intent})];const body={context:{...f.scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}},message:'把这个男孩改得更写实一点，保留睡衣。'};const post=async(route,b,user=7)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/v04'+route,{method:'POST',headers:{'content-type':'application/json','x-test-user':String(user)},body:JSON.stringify(b)});return {status:r.status,data:await r.json()};};
 const r=await post('/agent/studio-turn',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.mode,'ASSET_IMAGE_EDIT');assert.equal(r.data.data.applied,false);assert.equal((await f.db('memories').where({role:'user'})).length,1);assert.equal((await f.db('memories').where({role:'assistant'})).length,1);assert.equal((await post('/studio/image-edit/candidates',f.scope)).data.data.length,1);assert.equal((await post('/studio/image-edit/candidates',f.scope,8)).status,403);assert.equal((await f.db('o_v04AgentReference')).length,0);
});
test('OPT-029A failed worker preserves old outputs and never fabricates a successful edit',async t=>{
 const f=await editFixture(t),http=require('node:http');let prompts=0;const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/upload/image'){req.resume();res.end(JSON.stringify({name:'source.png',type:'input',subfolder:''}));return;}if(req.url==='/prompt'){prompts++;res.end(JSON.stringify({prompt_id:'fail-prompt'}));return;}if(req.url==='/history/fail-prompt'){res.end(JSON.stringify({'fail-prompt':{status:{status_str:'error',messages:[['execution_error',{exception_message:'CUDA out of memory'}]]}}}));return;}res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());await f.db('o_v04StudioImageExecutorConfig').insert({projectId:f.scope.projectId,baseUrl:'http://127.0.0.1:'+server.address().port,checkpoint:'unused',enabled:1,updatedAt:1});const id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);await f.db('o_v04StudioAssetDraftJob').where({id}).update({status:'RUNNING'});await f.mod.produceAssetImageEdit(await f.db('o_v04StudioAssetDraftJob').where({id}).first(),true);const j=await f.db('o_v04StudioAssetDraftJob').where({id}).first();assert.equal(j.status,'FAILED');assert.equal(j.errorCode,'OUT_OF_MEMORY');assert.equal(prompts,2);assert.equal(j.attemptCount,2);assert.equal(JSON.parse(j.inputSnapshotJson).recovery.width,512);assert.equal(JSON.parse(j.inputSnapshotJson).recovery.failedPromptId,'fail-prompt');assert.equal(j.outputsJson,'[]');assert.equal((await f.db('o_v04StudioAssetDraftJob').where({id:f.main.id}).first()).status,'SUCCEEDED');assert.equal((await f.db('o_v04AgentReference')).length,0);
});
test('OPT-029A recovery never resubmits an uncertain in-flight edit',async t=>{
 const f=await editFixture(t),id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);await f.db('o_v04StudioAssetDraftJob').where({id}).update({status:'RUNNING'});await f.mod.produceAssetImageEdit(await f.db('o_v04StudioAssetDraftJob').where({id}).first(),false);const j=await f.db('o_v04StudioAssetDraftJob').where({id}).first();assert.equal(j.status,'FAILED');assert.equal(j.errorCode,'EXECUTION_UNCERTAIN');assert.equal(j.comfyPromptId,null);assert.equal((await f.db('o_v04StudioDraftArtifact')).length,1);
});
test('OPT-029A explicit conversational adoption only opens Preview; rejection stays scoped and never applies truth',async t=>{
 const f=await editFixture(t),id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);await settled(f,id);const studio=loadSource(path.join(root,'src/v04/studioTurn.ts'),f.db,f.cache,f.oss);const context={...f.scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}};
 const reply=await studio.answerStudioTurn({context,message:'就用这张',parentCandidateId:id},randomUUID());assert.equal(reply.mode,'ASSET_IMAGE_REVIEW');assert.equal(reply.candidatePreview.jobId,id);assert.equal(reply.applied,false);assert.equal((await f.db('o_v04AgentReference')).length,0);assert.equal(f.oss.modelCalls.length,0);const rejected=await studio.answerStudioTurn({context,message:'不要这个版本',parentCandidateId:id},randomUUID());assert.equal(rejected.applied,false);assert.equal((await f.db('o_v04Decision'))[0].status,'REJECTED');assert.equal((await f.db('o_v04AgentReference')).length,0);
});
test('OPT-029A optional real local worker end-to-end stores candidate lineage in disposable SQLite', {skip:process.env.DS_OPT029A_REAL_WORKER!=='1'},async t=>{
 const f=await editFixture(t);const png=fs.readFileSync('D:/comfy/ComfyUI/output/Krea2_turbo_00008_.png');f.media.set(f.main.artifactId,png);await f.db('o_v04StudioImageExecutorConfig').insert({projectId:f.scope.projectId,baseUrl:'http://127.0.0.1:8188',checkpoint:'unused',enabled:1,updatedAt:1});const id=randomUUID(),before=await f.db('o_v04Asset');const turn=loadSource(path.join(root,'src/v04/studioTurn.ts'),f.db,f.cache,f.oss);f.oss.studioResponses=[JSON.stringify({mode:'ASSET_IMAGE_EDIT',reply:'准备候选',imageIntent:{...f.intent,editPrompt:'Keep this same boy, sleepwear, hair, face and bare feet. Refine only realistic fabric and skin texture, full body neutral background.'}})];
 const response=await turn.answerStudioTurn({context:{...f.scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}},message:'把这个男孩改得更写实一点，保留身份和睡衣。'},id);assert.equal(response.imageCandidate.jobId,id);await f.db('o_v04StudioAssetDraftJob').where({id}).update({status:'RUNNING'});await f.mod.produceAssetImageEdit(await f.db('o_v04StudioAssetDraftJob').where({id}).first(),true);const row=await f.db('o_v04StudioAssetDraftJob').where({id}).first();assert.equal(row.status,'SUCCEEDED',row.errorCode);assert.deepEqual(await f.db('o_v04Asset'),before);assert.equal((await f.db('o_v04AgentReference')).length,0);assert.equal((await f.db('o_v04AssetVisualSpec')).length,0);const artifact=JSON.parse(row.outputsJson)[0],output=path.join(f.oss.testDir,'v04-draft-artifacts',String(f.scope.projectId),artifact.artifactId+'.png');const evidence=path.resolve(__dirname,'../../opt029a-evidence');fs.copyFileSync(output,path.join(evidence,'real-persisted-worker.png'));fs.writeFileSync(path.join(evidence,'real-persisted-worker.json'),JSON.stringify({naturalLanguageInput:'把这个男孩改得更写实一点，保留身份和睡衣。',resolver:'MOCKED_TEXT_PROVIDER',executor:'REAL_LOCAL_COMFY',scope:f.scope,job:row,truthUnchanged:true,confirmedReferenceCount:0},null,2));
});
test('OPT-029A stale projection preserves historical SUCCEEDED row and never offers current adoption',async t=>{const f=await editFixture(t),id=randomUUID();await f.mod.enqueueAssetImageEdit(f.scope,f.intent,id);await settled(f,id);assert.equal((await f.mod.listAssetImageCandidates(f.scope))[0].status,'SUCCEEDED');await f.db('o_v04Asset').where({projectId:f.scope.projectId}).update({revision:2});assert.equal((await f.mod.listAssetImageCandidates(f.scope))[0].status,'STALE');assert.equal((await f.db('o_v04StudioAssetDraftJob').where({id}).first()).status,'SUCCEEDED');});
test('OPT-029A normal HTTP image attachment reaches reference edit; remains conversational until explicit adoption',async t=>{
 const f=await editFixture(t),express=require('express'),app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:7};next();});app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),f.db,f.cache,f.oss).default);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>server.close());const post=async(route,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/v04'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result.data;};const context={...f.scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}};
 const uploaded=await post('/agent/image/upload',{context,name:'style.png',dataUrl:'data:image/png;base64,'+f.png.toString('base64')});f.oss.studioResponses=[JSON.stringify({mode:'ASSET_IMAGE_EDIT',reply:'参考风格',imageIntent:{...f.intent,editMode:'REFERENCE_EDIT',referenceBindings:[{attachmentId:uploaded.id,role:'STYLE_REFERENCE'}]}})];const response=await post('/agent/studio-turn',{context,message:'参考这张图片的风格修改男孩，保持睡衣。',attachmentIds:[uploaded.id]});const row=await f.db('o_v04StudioAssetDraftJob').where({id:response.imageCandidate.jobId}).first(),snapshot=JSON.parse(row.inputSnapshotJson);assert.equal(row.executorProfile,'KREA2_REFERENCE_EDIT_V1');assert.equal(snapshot.referenceBindings[0].attachmentId,uploaded.id);assert.equal(snapshot.referenceBindings[0].sha256,pngHash(f.png));assert.deepEqual(snapshot.uploadedReferenceIds,[uploaded.id]);assert.equal((await f.db('o_v04AgentAttachment').where({id:uploaded.id}).first()).messageId,response.userMessageId);assert.equal((await f.db('o_v04AgentAttachment').where({id:uploaded.id}).first()).purpose,'CONVERSATIONAL_REFERENCE');assert.equal((await f.db('o_v04AgentReference')).length,0);assert.equal(f.oss.visionCalls,1);
});
test('OPT-029A missing source gives a truthful terminal message, not silent T2I or perpetual uncertainty',async t=>{const f=await editFixture(t);await f.db('o_v04StudioAssetDraftJob').where({id:f.main.id}).update({status:'STALE'});f.oss.studioResponses=[JSON.stringify({mode:'ASSET_IMAGE_EDIT',reply:'准备',imageIntent:f.intent})];const studio=loadSource(path.join(root,'src/v04/studioTurn.ts'),f.db,f.cache,f.oss);await assert.rejects(studio.answerStudioTurn({context:{...f.scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}},message:'修改男孩图片'},randomUUID()),e=>e.code==='PILOT_SOURCE_MISSING'&&e.terminal===true&&e.checkStatusUseful===false);assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,1);});
