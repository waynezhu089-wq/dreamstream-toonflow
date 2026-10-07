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
      if(input.system?.includes('VISION_CAPABILITY_PREFLIGHT')){oss.probeCalls=(oss.probeCalls||0)+1;return {object:input.messages[0].content[0].text.includes('sameSubject')?{sameSubject:true,obviousStructuralAnomaly:false,uncertain:false}:{subjectCount:1,confidence:'HIGH'}};}
      oss.visionCalls++;
      if (oss.visionFailure) throw oss.visionFailure;
      if (oss.modelError) throw Error('provider call failed');
      return { object: oss.visionResult ?? { summary: 'A dark blue image with a bright logo', dominantColors: ['deep blue'], visibleText: ['DreamStream'], uncertainty: [] } };
    }, invoke: async input => {
      oss.modelCalls.push({ model, ...input, method: input.output ? 'invokeJson' : 'invokeText' });
      if(input.system?.includes('VISION_CAPABILITY_PREFLIGHT')){oss.probeCalls=(oss.probeCalls||0)+1;return {text:'1'};}
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
  t.after(async () => {
    // Persisted terminal status precedes the worker finally block. Do not remove
    // its temporary lease directory before the real asynchronous release ends.
    const lease = path.join(dir, 'v04-draft-worker.lock');
    const deadline = Date.now() + 5000;
    while (fs.existsSync(lease) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(lease), false, 'temporary worker lease must release before fixture cleanup');
    await new Promise(resolve => setImmediate(resolve));
    await db.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  });
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

async function completePackageFixtureJob(f,job){
 const id=require('crypto').randomUUID(),bytes=await require('sharp')({create:{width:80,height:120,channels:3,background:'#ccddee'}}).png().toBuffer();
 const target=path.join(f.oss.testDir,'v04-draft-artifacts',String(f.scope.projectId),id+'.png');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
 const role=job.executionPurpose==='ASSET_MAIN_PREVIEW'||job.executionPurpose==='SUBJECT_MAIN_PREVIEW'?'MAIN_PREVIEW':job.executionPurpose;
 await f.db('o_v04StudioDraftArtifact').insert({artifactId:id,jobId:job.id,projectId:f.scope.projectId,role,mimeType:'image/png',extension:'png',width:80,height:120,createdAt:Date.now()});
 await f.db('o_v04StudioAssetDraftJob').where({id:job.id}).update({status:'SUCCEEDED',outputsJson:JSON.stringify([{artifactId:id,role,mimeType:'image/png',width:80,height:120,quality:{status:'PASS_COARSE'}}]),completedAt:Date.now()});return id;
}

async function mvFixture(t){
 const f=await fixture(t),{db,oss,cache,service}=f,load=n=>loadSource(path.join(root,'src/v04/'+n+'.ts'),db,cache,oss);
 await load('directorAssetABSchema').initializeDirectorABSchema(db);await load('multiViewSchema').initializeMultiViewSchema(db);await load('integritySchema').initializeIntegritySchema(db);
 const scope=await service.createPilotProject({name:'Multi View test',brief:'boy',targetDuration:40,aspectRatio:'16:9'},7);
 await db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey:'CHAR-007',name:'Boy',category:'CHAR',assetKind:'HUMAN_CHARACTER',sourcePolicy:'AI_ALLOWED',description:'old long-sleeve pajamas; image authority wins',identityAnchors:JSON.stringify(['white short-sleeve top']),mustPreserve:JSON.stringify(['white shorts','barefoot']),forbiddenChanges:JSON.stringify(['shoes']),status:'ACTIVE',revision:2,createdAt:1,updatedAt:1});
 const png=await require('sharp')({create:{width:768,height:768,channels:3,background:'#aabbcc'}}).png().toBuffer(),crypto=require('crypto');
 const attachmentId=crypto.randomUUID(),sha256=crypto.createHash('sha256').update(png).digest('hex'),baselineVersion=crypto.randomUUID();
 const dir=path.join(oss.testDir,'v04-conversation',String(scope.projectId));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,attachmentId+'.png'),png);
 await db('o_v04AgentAttachment').insert({id:attachmentId,...scope,messageId:crypto.randomUUID(),originalName:'boy.png',mimeType:'image/png',bytes:png.length,sha256,purpose:'CONVERSATIONAL_REFERENCE',contextJson:'{}',filePath:'/unused-test.png',createdAt:1});
 await db('o_v04Decision').insert({id:baselineVersion,...scope,category:'ASSET_EDIT_BASELINE',subjectType:'ASSET',subjectKey:'CHAR-007',content:JSON.stringify({canonicalKey:'CHAR-007',sourceAssetRevision:2,role:'GENERAL',attachmentId,sha256}),status:'ACCEPTED',sourceMessageIds:'[]',createdAt:1,acceptedAt:1});
 await db('o_v04StudioImageExecutorConfig').insert({projectId:scope.projectId,baseUrl:'http://127.0.0.1:8188',enabled:1,checkpoint:'unused',updatedAt:1});
 const truth=async()=>{const out={};for(const {name} of await db('sqlite_master').where({type:'table'}).orderBy('name')){if(['sqlite_sequence','o_v04MultiViewExperiment','o_v04ExecutionTrace','o_v04AssetIntegrity'].includes(name))continue;out[name]=(await db(name)).map(r=>JSON.stringify(r)).sort();}return out;};
 return {...f,load,scope,png,attachmentId,sha256,baselineVersion,truth,mv:load('multiView')};
}
async function abFixture(t){
 const f=await fixture(t),{db,oss,cache,service:s}=f,load=n=>loadSource(path.join(root,'src/v04/'+n+'.ts'),db,cache,oss);
 await load('directorSchema').initializeDirectorSchema(db);await load('directorAssetABSchema').initializeDirectorABSchema(db);
 const scope=await s.createPilotProject({name:'Whale A/B',brief:'A dream at night',targetDuration:40,aspectRatio:'16:9'},7);
 for(const [canonicalKey,name,assetKind,category] of [['CHAR-003','Whale','CREATURE','CHAR'],['PROP-001','Pirate Ship','VEHICLE','PROP'],['CHAR-002','Pegasus','CREATURE','CHAR']])
  await db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey,name,category,assetKind,sourcePolicy:'AI_ALLOWED',description:'living creature',identityAnchors:'[]',mustPreserve:'[]',forbiddenChanges:'[]',status:'ACTIVE',revision:1,createdAt:1,updatedAt:1});
 const a=await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-003'}).first(),spec=load('visualSpecContract').compileVisualSemantic({...a,identityAnchors:[],mustPreserve:[],forbiddenChanges:[]},{visualIdentitySummary:'A mature living whale',details:{speciesOrForm:'whale'}});
 await db('o_v04StudioAssetDraftJob').insert({id:require('crypto').randomUUID(),...scope,canonicalKey:'CHAR-003',sourceAssetRevision:1,draftHash:'a'.repeat(64),generationIntent:'SUBJECT_MAIN_PREVIEW',executionPurpose:'ASSET_MAIN_PREVIEW',executorType:'COMFY_LOCAL',executorProfile:'KREA2_T2I_ASSET_V1',workflowVersion:'old',status:'SUCCEEDED',inputSnapshotJson:JSON.stringify({visualSpecDraft:spec}),outputsJson:'[]',attemptCount:1,createdAt:1,updatedAt:1});
 const intent=load('directorContract').emptyDirectorIntent();intent.globalVisualDNA.artStyle='cinematic stylized realism';intent.globalVisualDNA.materialLanguage=['luminous Dream Matter where applicable'];
 const role=(canonicalKey,emotionalRead)=>({canonicalKey,narrativeFunction:'threshold creature and living dream-space',emotionalRead,dramaticImportance:'major',scaleFunction:'whole-ship swallowing scale',requiredAudiencePerception:['ancient majestic sublime colossus','awe first, danger second'],forbiddenInterpretations:['cute','mascot','evil monster','gore horror']});
 intent.narrativeVisualRoles=[role('CHAR-003','awe first'),role('CHAR-002','unrelated Pegasus role')];intent.scaleRelations=[{smaller:'PROP-001',larger:'CHAR-003',kind:'DRAMATIC',shotRef:null,requirement:'ship toy-sized beside whale; can swallow whole ship'}];
 oss.studioResponses=[JSON.stringify(intent)];const d=load('directorBible'),p=await d.proposeDirector(scope,7),v=await d.previewDirector({...scope,proposalId:p.id},7);await d.confirmDirector({...scope,proposalId:p.id,previewHash:v.previewHash},7);
 const truth=async()=>{const names=(await db('sqlite_master').where({type:'table'}).pluck('name')).filter(n=>!['sqlite_sequence','o_v04DirectorAssetAB','o_v04ExecutionTrace'].includes(n)).sort(),out={};for(const n of names)out[n]=(await db(n)).map(load('directorCompiler').directorCanonical).sort();return out;};
 return {...f,load,scope,ab:load('directorAssetAB'),truth};
}
async function attach(f,key='CHAR-003'){
 const id=require('crypto').randomUUID(),bytes=await require('sharp')({create:{width:128,height:128,channels:3,background:'#607080'}}).png().toBuffer(),target=path.join(f.oss.testDir,'v04-conversation',String(f.scope.projectId),id+'.png');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
 await f.db('o_v04AgentAttachment').insert({id,...f.scope,messageId:require('crypto').randomUUID(),contextJson:'{}',filePath:`/v04-conversation/${f.scope.projectId}/${id}.png`,originalName:'test.png',mimeType:'image/png',bytes:bytes.length,sha256:require('crypto').createHash('sha256').update(bytes).digest('hex'),purpose:'CONVERSATIONAL_REFERENCE',createdAt:Date.now()});return {...f.scope,canonicalKey:key,attachmentId:id,role:'GENERAL'};
}

test('034A package admission pins Krea draft -> Klein main -> same-package views; adoption preserves freshness',async t=>{
 const f=await abFixture(t),auto=f.load('autoAsset'),scope={...f.scope,canonicalKeys:['CHAR-003']};
 await auto.reconcileAutoAssets(scope);let rows=await f.db('o_v04StudioAssetDraftJob').where(f.scope).orderBy('createdAt','desc');
 const rootJob=rows.find(j=>JSON.parse(j.inputSnapshotJson).packageStage==='DRAFT_KREA');assert.equal(rootJob.executorProfile,'KREA2_T2I_ASSET_V1');
 const draftId=await completePackageFixtureJob(f,rootJob);await auto.reconcileAutoAssets(scope);rows=await f.db('o_v04StudioAssetDraftJob').where(f.scope);
 const main=rows.find(j=>JSON.parse(j.inputSnapshotJson).packageStage==='CANONICAL_MAIN_KLEIN');assert.equal(main.executorProfile,'KLEIN_ASSET_VIEW_V1');assert.equal(JSON.parse(main.inputSnapshotJson).sourceArtifactId,draftId);
 assert.equal(rows.filter(j=>JSON.parse(j.inputSnapshotJson).packageStage==='MULTIVIEW_KLEIN').length,0);
 const mainId=await completePackageFixtureJob(f,main);await auto.reconcileAutoAssets(scope);rows=await f.db('o_v04StudioAssetDraftJob').where(f.scope);
 const views=rows.filter(j=>JSON.parse(j.inputSnapshotJson).packageStage==='MULTIVIEW_KLEIN');assert.equal(views.length,2);for(const j of views){assert.equal(JSON.parse(j.inputSnapshotJson).sourceArtifactId,mainId);assert.equal(JSON.parse(j.inputSnapshotJson).packageId,JSON.parse(main.inputSnapshotJson).packageId);await completePackageFixtureJob(f,j);}
 const edit=f.load('assetImageEdit');assert.equal((await edit.listAssetImageCandidates(f.scope)).some(j=>j.id===rootJob.id),false);await assert.rejects(edit.previewAssetImageCandidate({...f.scope,jobId:rootJob.id}),e=>e.code==='PILOT_SOURCE_STALE');
 const p=await edit.previewAssetImageCandidate({...f.scope,jobId:main.id});await edit.acceptAssetImageCandidate({...f.scope,jobId:main.id,previewHash:p.previewHash});
 for(const j of [main,...views])assert.equal(await auto.autoJobFresh(j),true,'adopting same package must not fence siblings');
 const beforeDerive=(await f.db('o_v04StudioAssetDraftJob')).length;const derived=await edit.enqueueAssetImageEdit(f.scope,{canonicalKey:'CHAR-003',editMode:'DERIVE_VIEW',targetRole:'FULL_BODY_BACK',editPrompt:'Prepare the complete view package'},require('crypto').randomUUID(),undefined,true);assert.equal(derived.packagePending,true);assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,beforeDerive,'view request reuses current package without changing intent');
 const beforeReconcile=(await f.db('o_v04StudioAssetDraftJob')).length;await auto.reconcileAutoAssets(scope);assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,beforeReconcile,'Director reference continuity must not duplicate package views');
 const coverage=await auto.autoAssetCoverage(f.scope);assert.equal(coverage.items.find(i=>i.canonicalKey==='CHAR-003').firstDraftStatus,'READY');
 const requestId=require('crypto').randomUUID();await auto.reconcileAutoAssets({...scope,regenerateKey:'CHAR-003',requestId,assetIntentPatch:'Preserve identity; refine fin contours'});const count=(await f.db('o_v04StudioAssetDraftJob')).length;await auto.reconcileAutoAssets({...scope,regenerateKey:'CHAR-003',requestId,assetIntentPatch:'Preserve identity; refine fin contours'});assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,count);
 for(const j of [main,...views]){assert.equal((await f.db('o_v04StudioAssetDraftJob').where({id:j.id}).first()).status,'STALE');assert.ok(await f.db('o_v04StudioDraftArtifact').where({jobId:j.id}).first());}
});

test('034A upstream context ignores reference-adoption Director IDs but reacts to semantic/script/spec/compiler evidence',()=>{
 const load=n=>loadSource(path.join(root,'src/v04/'+n+'.ts'),null,new Map(),null),compiler=load('assetGenerationContext');
 const a={canonicalKey:'CHAR-001',revision:1,assetKind:'HUMAN_CHARACTER',sourcePolicy:'AI_ALLOWED'},d={current:{id:'d1'},intent:{globalVisualDNA:{artStyle:'cinematic'},narrativeVisualRoles:[]}},creative={treatment:'Dream story',script:'Same boy'},spec={mustPreserve:['barefoot']};
 const one=compiler.compileAssetGenerationContext(a,spec,creative,d,'');assert.equal(compiler.compileAssetGenerationContext(a,spec,creative,{...d,current:{id:'inherited'}},'').upstreamHash,one.upstreamHash);
 for(const other of [compiler.compileAssetGenerationContext(a,spec,{...creative,script:'changed'},d,''),compiler.compileAssetGenerationContext(a,{mustPreserve:['boots']},creative,d,''),compiler.compileAssetGenerationContext(a,spec,creative,{...d,intent:{...d.intent,globalVisualDNA:{artStyle:'changed'}}},'')])assert.notEqual(other.upstreamHash,one.upstreamHash);
 const prompt=load('assetPipelinePrompt').compilePipelineAssetPrompt(a,{...spec,identityAnchors:[],forbiddenChanges:[]},'SUBJECT_MAIN_PREVIEW',null,one);assert.match(prompt.renderedPrompt,/Director Visual DNA.*Narrative context.*Asset narrative role/s);assert.match(prompt.renderedPrompt,/Translate the supplied draft/);assert.match(prompt.renderedPrompt,/no extra people.*UI residue/s);
});
test('033A MAIN-only reference confirmation appends Director continuity, immutable history and replay',async t=>{
 const f=await abFixture(t),d=f.load('directorBible'),old=await f.db('o_v04DirectorVersion').first(),projection=await f.db('o_v04DirectorProjection').first(),input=await attach(f),b=f.load('assetImageBaseline');
 const p=await b.previewImageBaseline(input);await b.confirmImageBaseline({...input,previewHash:p.previewHash});
 const rows=await f.db('o_v04DirectorVersion').orderBy('directorVersion');assert.equal(rows.length,2);assert.deepEqual(rows[0],old);assert.deepEqual(await f.db('o_v04DirectorProjection').where({id:projection.id}).first(),projection);
 assert.equal(rows[1].projectBibleJson,old.projectBibleJson);assert.equal(rows[1].unitProjectionJson,old.unitProjectionJson);assert.notEqual(rows[1].sourceHash,old.sourceHash);
 const e=JSON.parse(rows[1].evidenceJson).continuity;assert.equal(e.automaticInheritance,true);assert.equal(e.inheritedFromDirectorRevision,1);assert.equal(e.inheritanceReason,'MAIN_REFERENCE_REPLACEMENT');assert.notEqual(e.oldReferenceHash,e.newReferenceHash);
 assert.equal((await d.readDirector(f.scope,7)).accepted.status,'CURRENT');await f.db.transaction(trx=>d.captureCurrentDirectorForExperiment(trx,f.scope));
 const replay=await b.confirmImageBaseline({...input,previewHash:p.previewHash});assert.equal(replay.replayed,true);assert.equal((await f.db('o_v04DirectorVersion')).length,2);
});
test('033A semantic change or unrelated reference delta fails closed, rollback preserves all versions',async t=>{
 const f=await abFixture(t),d=f.load('directorBible'),before=await f.db('o_v04DirectorVersion');
 await assert.rejects(f.db.transaction(async trx=>{const boundary=await d.captureDirectorReferenceBoundary(trx,f.scope);await trx('o_v04Asset').where({projectId:f.scope.projectId,canonicalKey:'CHAR-003'}).update({description:'changed semantics'});await d.inheritDirectorMainReference(trx,f.scope,boundary,'CHAR-003',require('crypto').randomUUID());}),e=>e.code==='DIRECTOR_RECONFIRM_REQUIRED');
 assert.deepEqual(await f.db('o_v04DirectorVersion'),before);assert.equal((await f.db('o_v04Asset').where({canonicalKey:'CHAR-003'}).first()).description,'living creature');
 await f.db('o_v04Creative').where(f.scope).update({version:2});const input=await attach(f),b=f.load('assetImageBaseline'),p=await b.previewImageBaseline(input);
 await assert.rejects(b.confirmImageBaseline({...input,previewHash:p.previewHash}),e=>e.code==='DIRECTOR_RECONFIRM_REQUIRED');assert.equal((await f.db('o_v04AgentReference')).length,0);assert.deepEqual(await f.db('o_v04DirectorVersion'),before);
});
test('033A typed Klein graph pins one MAIN reference, independent view prompts, original 8GB parameters',()=>{
 const k=loadSource(path.join(root,'src/v04/kleinAssetProfile.ts'),null);const a=k.buildKleinAssetWorkflow({prompt:'side',sourceImage:'main.png',seed:7,targetRole:'SIDE_PROFILE',jobId:'a'}),b=k.buildKleinAssetWorkflow({prompt:'rear',sourceImage:'main.png',seed:7,targetRole:'REAR_3Q',jobId:'b'});
 assert.equal(a.graph['4'].inputs.image,'main.png');assert.deepEqual(a.graph['12'].inputs.latent,['6',0]);assert.deepEqual(a.graph['6'].inputs.pixels,['5',0]);assert.equal(a.graph['9'].inputs.steps,4);assert.equal(a.graph['10'].inputs.sampler_name,'euler');assert.equal(a.graph['7'].inputs.width,768);assert.equal(a.graph['7'].inputs.height,1024);assert.notEqual(a.graph['11'].inputs.text,b.graph['11'].inputs.text);
});
test('033A type-dependent usable view plans do not require every rear to succeed',()=>{
 const {assetViewPlan:p}=loadSource(path.join(root,'src/v04/assetViewPlan.ts'),null),a={sourcePolicy:'AI_ALLOWED'};
 assert.deepEqual(p({...a,assetKind:'HUMAN_CHARACTER'}),['SIDE_PROFILE','FULL_BODY_BACK']);assert.deepEqual(p({...a,assetKind:'VEHICLE',name:'Pirate Ship'}),['SIDE_PROFILE','FULL_BODY_FRONT']);assert.deepEqual(p({...a,assetKind:'VEHICLE',name:'Submarine'}),['SIDE_PROFILE','FULL_BODY_FRONT','REAR_3Q']);assert.deepEqual(p({...a,assetKind:'ENVIRONMENT'}),[]);assert.deepEqual(p({...a,assetKind:'BRAND_MARK',sourcePolicy:'REAL_REQUIRED'}),[]);
});
test('033A clean reference compiler separates Director look, biological whale and Dream Matter',async t=>{
 const f=await abFixture(t),director=await f.db.transaction(trx=>f.load('directorBible').captureCurrentDirectorForExperiment(trx,f.scope)),compile=f.load('assetPipelinePrompt').compilePipelineAssetPrompt,asset=await f.db('o_v04Asset').where({canonicalKey:'CHAR-003'}).first(),spec=JSON.parse((await f.db('o_v04StudioAssetDraftJob').first()).inputSnapshotJson).visualSpecDraft;
 const main=compile(asset,spec,'ASSET_MAIN_PREVIEW',director).renderedPrompt,side=compile(asset,spec,'SIDE_PROFILE',director).renderedPrompt;
 assert.match(main,/white or near-white/);assert.match(main,/neutral clear/);assert.match(main,/monumental|colossus/);assert.match(main,/non-luminous/);assert.doesNotMatch(main,/cold moonlight|deep night-blue atmosphere/);assert.match(side,/MAIN is the identity reference/);assert.match(side,/left-side profile/);
 assert.throws(()=>compile({...asset,category:'BRAND',sourcePolicy:'REAL_REQUIRED'},spec,'ASSET_MAIN_PREVIEW',director),e=>e.code==='PILOT_REAL_REFERENCE_ONLY');
});
test('033A QA unavailable or incomplete remains Attention; only proven coarse defects permit retry',async()=>{
 const {inspectAssetCandidate:q}=loadSource(path.join(root,'src/v04/assetPipelineQuality.ts'),null),metadata={width:1024,height:1024},brief={view:'BACK'};
 assert.equal((await q(metadata,brief,{state:'UNAVAILABLE'})).status,'ATTENTION');
 const adapter={state:'AVAILABLE',inspect:async()=>({checks:['SUBJECT_COUNT'],confidence:'HIGH',report:{reviewed:false,identity:'UNKNOWN',view:'UNKNOWN',contamination:'FAIL',issues:[]}})};
 assert.equal((await q(metadata,brief,adapter)).status,'CLEAR_FAILURE');adapter.inspect=async()=>({checks:['SUBJECT_COUNT'],confidence:'HIGH',report:{reviewed:false,identity:'UNKNOWN',view:'UNKNOWN',contamination:'UNKNOWN',issues:[]}});assert.equal((await q(metadata,brief,adapter)).status,'ATTENTION');
 adapter.inspect=async()=>({checks:['SUBJECT_COUNT','VIEW','PART_STRUCTURE','ATTACHMENT','CONTAMINATION','CROSS_VIEW'],confidence:'HIGH',report:{reviewed:true,identity:'PASS',view:'PASS',contamination:'PASS',issues:[]}});assert.equal((await q(metadata,brief,adapter)).status,'PASS_COARSE');assert.equal((await q({width:8,height:8},brief,adapter)).status,'CLEAR_FAILURE');
});
test('033A Generate All persists bounded 6+6+1 preparation, fail-soft admission and duplicate prevention',async t=>{
 const f=await fixture(t),load=n=>loadSource(path.join(root,'src/v04/'+n+'.ts'),f.db,f.cache,f.oss);
 await load('directorSchema').initializeDirectorSchema(f.db);const scope=await f.service.createPilotProject({name:'Batch',brief:'assets',targetDuration:40,aspectRatio:'16:9'},7);
 for(let i=0;i<13;i++)await f.db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey:'PROP-'+String(i).padStart(3,'0'),name:'Object '+i,category:'PROP',assetKind:'PROP',sourcePolicy:'AI_ALLOWED',description:'object',identityAnchors:'[]',mustPreserve:'[]',forbiddenChanges:'[]',status:'ACTIVE',revision:1,createdAt:i,updatedAt:i});
 f.oss.studioResponses=[JSON.stringify(load('directorContract').emptyDirectorIntent())];const d=load('directorBible'),p=await d.proposeDirector(scope,7),v=await d.previewDirector({...scope,proposalId:p.id},7);await d.confirmDirector({...scope,proposalId:p.id,previewHash:v.previewHash},7);
 load('studioDraftImage').wakeDraftWorker=()=>{};const batches=[];let release;const barrier=new Promise(r=>release=r);
 load('visualSpec').proposeVisualSpecs=async input=>{batches.push(input.canonicalKeys);if(batches.length===1)await barrier;
 const rows=await f.db('o_v04Asset').where({projectId:scope.projectId}).whereIn('canonicalKey',input.canonicalKeys);
 return {candidates:rows.filter(a=>a.canonicalKey!=='PROP-002').map(a=>({canonicalKey:a.canonicalKey,sourceAssetRevision:a.revision,spec:load('visualSpecContract').compileVisualSemantic({...a,identityAnchors:[],mustPreserve:[],forbiddenChanges:[]},{visualIdentitySummary:a.name})})),failures:rows.filter(a=>a.canonicalKey==='PROP-002').map(a=>({canonicalKey:a.canonicalKey,code:'VISUAL_SPEC_SCHEMA_FAILED'}))};};
 const api=load('assetPipeline');await api.generateAllAssets(scope,7);await api.generateAllAssets(scope,7);assert.equal(batches.length,1);release();
 let state;for(let i=0;i<300;i++){state=await api.assetPipelineState(scope,7);if(state.latest?.phase!=='PREPARING')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.latest.phase,'ADMITTED');assert.deepEqual(batches.map(b=>b.length),[6,6,1]);assert.equal(state.latest.failures.length,1);
 const jobs=await f.db('o_v04StudioAssetDraftJob');assert.equal(jobs.filter(j=>j.executionPurpose==='ASSET_MAIN_PREVIEW').length,12);
 await api.assetPipelineState(scope,7);await api.generateAllAssets(scope,7);assert.equal(batches.length,3);assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,jobs.length);
 await assert.rejects(api.generateAllAssets(scope,99),e=>e.code==='PILOT_FORBIDDEN');
});

test('033A initial setup uses explicit Brief grounding, canonical ADD adapter and only proposes Director',async t=>{
 const f=await fixture(t),load=n=>loadSource(path.join(root,'src/v04/'+n+'.ts'),f.db,f.cache,f.oss);await load('directorSchema').initializeDirectorSchema(f.db);
 const scope=await f.service.createPilotProject({name:'Initial',brief:'A boy and a real logo',visualStyle:'cinematic dream realism',targetDuration:40,aspectRatio:'16:9'},7);
 let calls=0;load('skills').previewSkill=async(input,initial)=>{assert.equal(initial,true);calls++;return {sourceVersion:1,output:{candidates:[{...asset('Boy'),assetKind:'HUMAN_CHARACTER',importance:'CORE',relatedExistingKeys:[],relatedCandidateIndexes:[],sharedVisualSystemKey:null,sharedVisualSystemCandidateIndex:null,extractionPass:'ENTITY'}],mergeSuggestions:[],coverage:[{label:'Boy',coverageType:'PERSON',classification:'CANONICAL_ASSET',candidateIndexes:[0],existingCanonicalKeys:[],note:''}]}};};
 f.oss.studioResponses=[JSON.stringify(load('directorContract').emptyDirectorIntent())];const api=load('assetPipeline');await api.prepareInitialProject(scope,7);await api.prepareInitialProject(scope,7);
 let state;for(let i=0;i<300;i++){state=await api.assetPipelineState(scope,7);if(state.latest?.phase!=='INITIAL_STARTED')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.latest.phase,'DIRECTOR_REVIEW');assert.equal(calls,1);assert.equal((await f.db('o_v04Asset')).length,1);assert.equal((await f.db('o_v04DirectorVersion')).length,0);
 assert.equal((await f.db('o_project').where({id:scope.projectId}).first()).artStyle,'cinematic dream realism');assert.equal((await f.service.readPilot(scope)).creative.version,1);assert.equal((await f.db('o_v04StudioAssetDraftJob')).length,0);
});

test('033A superseded preparation cannot admit jobs or overwrite the newer phase',async t=>{
 const f=await abFixture(t),api=f.load('assetPipeline');f.load('studioDraftImage').wakeDraftWorker=()=>{};let release,entered;const barrier=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 f.load('visualSpec').proposeVisualSpecs=async()=>{entered();await barrier;return {candidates:[],failures:[]};};
 const before=await f.db('o_v04StudioAssetDraftJob');await api.generateAllAssets(f.scope,7);await started;
 const replacement=require('crypto').randomUUID();await f.db('o_v04Decision').insert({id:replacement,...f.scope,category:'ASSET_PIPELINE_SETUP',subjectType:'PROJECT',subjectKey:String(f.scope.projectId),status:'PREPARING',content:'{}',sourceMessageIds:'[]',createdAt:Date.now()+1,acceptedAt:null});
 let finished;const done=new Promise(r=>finished=r);const listener=q=>{if(/COMMIT/i.test(q.sql))finished();};f.db.on('query',listener);t.after(()=>f.db.off('query',listener));release();
 await Promise.race([done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('preparation did not finish')),3000);timer.unref();})]);
 assert.deepEqual(await f.db('o_v04StudioAssetDraftJob'),before);const state=await api.assetPipelineState(f.scope,7);assert.equal(state.latest.phase,'PREPARING');assert.equal(state.history[0].id,replacement);assert.equal(state.history.some(r=>r.phase==='ADMITTED'||r.phase==='ATTENTION'),false);
});


test('034A feedback distinguishes new admission, replay and active batch; preserves request identity',async t=>{
 const f=await abFixture(t),api=f.load('assetPipeline');f.load('studioDraftImage').wakeDraftWorker=()=>{};
 const req=require('crypto').randomUUID(),other=require('crypto').randomUUID(),id=require('crypto').randomUUID();
 await f.db('o_v04Decision').insert({id,...f.scope,category:'ASSET_PIPELINE_SETUP',subjectType:'PROJECT',subjectKey:String(f.scope.projectId),status:'PREPARING',content:JSON.stringify({requestId:req,batchId:id}),sourceMessageIds:'[]',createdAt:Date.now()});
 const running=await api.generateAllAssets({...f.scope,regenerate:true,requestId:other},7);assert.equal(running.status,'ALREADY_RUNNING');assert.equal(running.accepted,false);
 const before=await f.db('o_v04StudioAssetDraftJob');const replay=await api.generateAllAssets({...f.scope,regenerate:true,requestId:req},7);assert.equal(replay.status,'REPLAYED');assert.equal(replay.batchId,id);assert.deepEqual(await f.db('o_v04StudioAssetDraftJob'),before);
 await f.db('o_v04Creative').where(f.scope).update({version:2});assert.equal((await api.generateAllAssets({...f.scope,regenerate:true,requestId:req},7)).status,'REPLAYED');
 await assert.rejects(api.generateAllAssets({...f.scope,regenerate:true,requestId:other},7),e=>e.code==='DIRECTOR_AB_NOT_READY');assert.deepEqual(await f.db('o_v04StudioAssetDraftJob'),before);
 const failedId=require('crypto').randomUUID();await f.db('o_v04Decision').insert({id:failedId,...f.scope,category:'ASSET_PIPELINE_SETUP',subjectType:'PROJECT',subjectKey:String(f.scope.projectId),status:'ATTENTION',content:JSON.stringify({requestId:req,batchId:id,errorCode:'VISUAL_PREPARATION_FAILED'}),sourceMessageIds:'[]',createdAt:Date.now()+1});
 const state=await api.assetPipelineState({...f.scope,requestId:req},7);assert.equal(state.request.errorCode,'VISUAL_PREPARATION_FAILED');assert.equal(state.blocker.code,'DIRECTOR_AB_NOT_READY');assert.equal(state.runtime.protocol,'asset.prepare-feedback.1');
});
test('034A newly submitted batch carries requestId through admitted journal; no replay regeneration',async t=>{
 const f=await abFixture(t),api=f.load('assetPipeline');f.load('studioDraftImage').wakeDraftWorker=()=>{};f.load('visualSpec').proposeVisualSpecs=async()=>({candidates:[],failures:[]});
 const body={...f.scope,regenerate:true,requestId:require('crypto').randomUUID()},r=await api.generateAllAssets(body,7);assert.equal(r.status,'SUBMITTED');assert.equal(r.phase,'PREPARING');assert.equal(r.requestId,body.requestId);
 let state;for(let n=0;n<300;n++){state=await api.assetPipelineState({...f.scope,requestId:body.requestId},7);if(state.request?.phase!=='PREPARING')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.request.phase,'ADMITTED');assert.equal(state.request.batchId,r.batchId);const before=await f.db('o_v04StudioAssetDraftJob');assert.equal((await api.generateAllAssets(body,7)).status,'REPLAYED');assert.deepEqual(await f.db('o_v04StudioAssetDraftJob'),before);
});
