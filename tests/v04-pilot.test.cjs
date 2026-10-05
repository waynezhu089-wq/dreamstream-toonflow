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

test('Studio semantic ingress accepts one lightweight object and rejects ambiguous or unsafe action output', () => {
  const {parseStudioTurnSemantic:parse}=loadSource(path.join(root,'src/v04/studioTurnSemantic.ts'),null);
  for(const raw of [
    '{"mode":"DISCUSS","reply":"男孩和鲸腹场景搭配。"}',
    '```json\n{"mode":"discussion","reply":"男孩和鲸腹场景搭配。"}\n```',
    '建议如下： {"mode":"讨论","reply":"男孩和鲸腹场景搭配。"} 请核对。',
  ]) assert.deepEqual(parse(raw),{mode:'DISCUSS',reply:'男孩和鲸腹场景搭配。'});
  assert.deepEqual(parse('{"mode":"修改","reply":"请预览","summary":"肩更窄","rationale":"保持年龄感","patch":{"silhouette":"narrower shoulders"}}'),
    {mode:'PROPOSE_CHANGE',reply:'请预览',summary:'肩更窄',rationale:'保持年龄感',patch:{silhouette:'narrower shoulders'}});
  assert.deepEqual(parse('{"mode":"target_confirmation","reply":"请先选中素材。"}'),
    {mode:'NEEDS_TARGET_CONFIRMATION',reply:'请先选中素材。'});
  const rejects=[
    ['', 'EMPTY_RESPONSE'],
    ['模型认为可以讨论。', 'JSON_EXTRACTION_FAILED'],
    ['{"mode":"DISCUSS","reply":"一"} {"mode":"DISCUSS","reply":"二"}', 'JSON_EXTRACTION_FAILED'],
    ['{"mode":"PROPOSE_CHANGE","reply":"可以改","summary":"改肩","rationale":"保留年龄"}', 'STRICT_VALIDATION_FAILED'],
    ['{"mode":"unrelated","reply":"内容"}', 'SEMANTIC_NORMALIZATION_FAILED'],
  ];
  for(const [raw,stage] of rejects) assert.throws(()=>parse(raw),error=>error.stage===stage);
});

test('Studio plain-text boundary repairs malformed JSON once and classifies empty or provider failure', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const studio=loadSource(path.join(root,'src/v04/studioTurn.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Studio replies',brief:'Whale dream',targetDuration:30,aspectRatio:'16:9'},7);
  const input={context:{...scope,currentStage:'studio',currentRoute:'studio',selectedObject:null},message:'男孩和鲸腹场景搭吗？'};
  oss.studioResponses=['{"mode":"DISCUSS","reply":"很搭"}'];
  assert.equal((await studio.answerStudioTurn(input)).mode,'DISCUSS');
  assert.equal(oss.modelCalls.at(-1).output,undefined,'Studio does not require provider Output.json');
  const calls=oss.modelCalls.length;
  oss.studioResponses=['{"mode":"DISCUSS","reply":"很搭"','{"mode":"DISCUSS","reply":"场景与男孩的比例协调。"}'];
  assert.match((await studio.answerStudioTurn(input)).reply,/比例协调/);
  assert.equal(oss.modelCalls.length,calls+2,'syntax repair is bounded to one pinned-session attempt');
  const failedRepairCalls=oss.modelCalls.length;
  oss.studioResponses=['{"mode":"DISCUSS","reply":"未闭合"','{"mode":"DISCUSS","reply":"仍未闭合"'];
  await assert.rejects(studio.answerStudioTurn(input),error=>error.code==='PILOT_STUDIO_JSON_EXTRACTION_FAILED');
  assert.equal(oss.modelCalls.length,failedRepairCalls+2,'a second malformed response cannot trigger a third call');
  oss.studioResponses=['{"mode":"PROPOSE_CHANGE","reply":"修改中"','{"mode":"DISCUSS","reply":"只讨论"}'];
  await assert.rejects(studio.answerStudioTurn(input),error=>error.code==='PILOT_STUDIO_STRICT_VALIDATION_FAILED',
    'format repair may not downgrade action intent to discussion');
  oss.studioResponses=[''];
  await assert.rejects(studio.answerStudioTurn(input),error=>error.code==='PILOT_STUDIO_EMPTY_RESPONSE'&&error.terminal);
  oss.studioResponses=[Error('provider unavailable')];
  await assert.rejects(studio.answerStudioTurn(input),error=>error.code==='PILOT_STUDIO_PROVIDER_FAILED'&&error.terminal);
  oss.studioResponses=['{"mode":"PROPOSE_CHANGE","reply":"改肩","summary":"肩更窄","rationale":"保持年龄"}'];
  const before=oss.modelCalls.length;
  await assert.rejects(studio.answerStudioTurn(input),error=>error.code==='PILOT_STUDIO_STRICT_VALIDATION_FAILED');
  assert.equal(oss.modelCalls.length,before+1,'missing action patch is rejected without a speculative repair');
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId})).length,0,'failed turns do not change project truth');
});

test('Studio HTTP terminal failure returns persisted user ID; retry reuses it and cannot duplicate a completed answer', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Studio retry',brief:'Whale dream',targetDuration:30,aspectRatio:'16:9'},7);
  const context={...scope,currentStage:'studio',currentRoute:'studio',selectedObject:null};
  const express=require('express'),app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async (route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  oss.studioResponses=[''];
  const failed=await post('/agent/studio-turn',{context,message:'男孩和鲸腹场景搭吗？'});
  assert.equal(failed.status,502);assert.equal(failed.body.code,'PILOT_STUDIO_EMPTY_RESPONSE');
  assert.equal(failed.body.terminal,true);assert.equal(failed.body.retryAllowed,true);assert.equal(failed.body.checkStatusUseful,false);
  assert.match(failed.body.userMessageId,/^[0-9a-f-]{36}$/);
  const key=`project:${scope.projectId}:projectAgent`;
  assert.equal((await db('memories').where({isolationKey:key,role:'user'})).length,1);
  assert.equal((await db('memories').where({isolationKey:key,role:'assistant'})).length,0);
  oss.studioResponses=['{"mode":"DISCUSS","reply":"男孩的尺度可以和鲸腹空间形成对照。"}'];
  const retried=await post('/agent/studio-turn/retry',{context,userMessageId:failed.body.userMessageId});
  assert.equal(retried.status,200);assert.equal(retried.body.data.mode,'DISCUSS');
  assert.equal(retried.body.data.userMessageId,failed.body.userMessageId);
  assert.equal((await db('memories').where({isolationKey:key,role:'user'})).length,1,'retry never inserts another user message');
  assert.equal((await db('memories').where({isolationKey:key,role:'assistant'})).length,1);
  const calls=oss.modelCalls.length;
  const duplicate=await post('/agent/studio-turn/retry',{context,userMessageId:failed.body.userMessageId});
  assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'PILOT_STUDIO_ALREADY_ANSWERED');
  assert.equal(oss.modelCalls.length,calls,'completed answer is rejected before another model call');
  const other=await s.createPilotProject({name:'Other',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const cross=await post('/agent/studio-turn/retry',{context:{...context,...other},userMessageId:failed.body.userMessageId});
  assert.equal(cross.status,404);
});

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

test('OPT-030 Agent action proposals are scoped, machine-readable and zero-write for Visual Spec and Shot', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const action=loadSource(path.join(root,'src/v04/agentActionProposal.ts'),db,cache,oss);
  const visual=loadSource(path.join(root,'src/v04/visualSpec.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Studio',brief:'A quiet night journey',targetDuration:30,aspectRatio:'16:9'},7);
  const other=await s.createPilotProject({name:'Other',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'boy',asset:{...asset('Boy'),assetKind:'HUMAN_CHARACTER',importance:'CORE'}},
    {operation:'ADD',clientRef:'night',asset:{...asset('Night Island','LOC'),assetKind:'ENVIRONMENT',importance:'CORE'}}];
  const ap=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:ap.previewHash});
  oss.proposalOutput={visualIdentitySummary:'Young boy in a blue coat',silhouette:'small child',primaryPalette:['blue'],details:{ageRange:'8–10',footwear:'shoes',hair:{color:'black',silhouette:'short fringe'},body:{build:'slim'},wardrobe:{upper:'blue coat'}}};
  const candidate=(await visual.proposeVisualSpecs({...scope,canonicalKeys:['CHAR-001']})).candidates[0];
  const vp=await visual.previewVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:candidate.sourceAssetRevision,spec:candidate.spec});
  await visual.applyVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:candidate.sourceAssetRevision,spec:candidate.spec,previewHash:vp.previewHash});
  const [shotId]=await db('o_storyboard').insert({...scope,index:1,prompt:'Boy walks through the island',videoDesc:'Slow tracking',duration:5,state:'未生成',productionSpec:'{}'});
  const beforeAsset=await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first();
  const beforeSpec=await db('o_v04AssetVisualSpec').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).orderBy('revision','desc').first();
  const beforeShot=await db('o_storyboard').where({id:shotId}).first();
  const callsBefore=oss.modelCalls.length;
  const ambiguous=await action.proposeAgentAction({...scope,instruction:'再瘦一点',scope:{type:'PROJECT'}});
  assert.equal(ambiguous.status,'NEEDS_TARGET_CONFIRMATION');assert.equal(ambiguous.applied,false);assert.equal(oss.modelCalls.length,callsBefore);
  oss.proposalOutput={summary:'让男孩更瘦',rationale:'保留儿童比例',patch:{silhouette:'slim child in blue coat',details:{body:{build:'slender child'}}}};
  const proposed=await action.proposeAgentAction({...scope,instruction:'再瘦一点',scope:{type:'ASSET',key:'CHAR-001'}});
  assert.equal(proposed.targetType,'VISUAL_SPEC');assert.equal(proposed.applied,false);
  assert.equal(proposed.proposal.spec.details.body.build,'slender child');
  assert.equal(proposed.proposal.spec.assetKind,'HUMAN_CHARACTER');
  assert.equal(proposed.sourceRevision,candidate.sourceAssetRevision);
  oss.proposalOutput={visualIdentitySummary:'Night island under blue stars',silhouette:'low island',primaryPalette:['blue'],details:{spaceType:'island',foreground:'shore',midground:'trees',background:'night sky',lighting:'moonlight',atmosphere:'quiet'}};
  const environment=(await visual.proposeVisualSpecs({...scope,canonicalKeys:['LOC-001']})).candidates[0];
  oss.proposalOutput={summary:'夜空更深',rationale:'保持岛屿布局',patch:{details:{lighting:'deeper blue moonlight'}}};
  const environmental=await action.proposeAgentAction({...scope,instruction:'更像夜空',scope:{type:'ASSET',key:'LOC-001'},optionalDraft:{sourceAssetRevision:environment.sourceAssetRevision,spec:environment.spec}});
  assert.equal(environmental.targetType,'VISUAL_SPEC');assert.equal(environmental.proposal.spec.details.lighting,'deeper blue moonlight');
  assert.equal((await db('o_v04AssetVisualSpec').where({projectId:scope.projectId,canonicalKey:'LOC-001'})).length,0,'unconfirmed Studio draft remains zero-write');
  const identity=await action.proposeAgentAction({...scope,instruction:'把这个名字改成小梦',scope:{type:'ASSET',key:'CHAR-001'}});
  assert.equal(identity.status,'NEEDS_TARGET_CONFIRMATION');assert.equal(identity.suggestedTargetType,'ASSET_IDENTITY');
  oss.proposalOutput={summary:'缩短镜头',rationale:'节奏更紧',patch:{duration:3}};
  const shot=await action.proposeAgentAction({...scope,instruction:'缩短到3秒',scope:{type:'SHOT',key:String(shotId)}});
  assert.equal(shot.targetType,'STORYBOARD_SHOT');assert.deepEqual(shot.proposal,{type:'EDIT',storyboardId:shotId,patch:{duration:3}});
  await assert.rejects(action.proposeAgentAction({...other,instruction:'缩短到3秒',scope:{type:'SHOT',key:String(shotId)}}),e=>e.code==='PILOT_ACTION_TARGET_INVALID');
  const studio=loadSource(path.join(root,'src/v04/studioTurn.ts'),db,cache,oss);
  const turn=(message,selectedObject,optionalDraft)=>studio.answerStudioTurn({context:{...scope,currentStage:'studio',currentRoute:'studio',selectedObject},message,...(optionalDraft?{optionalDraft}:{})});
  let calls=oss.modelCalls.length;
  oss.proposalOutput={mode:'PROPOSE_CHANGE',reply:'建议让男孩更瘦；需要你预览确认。',summary:'体型更瘦',rationale:'保持年龄感',patch:{silhouette:'noticeably slender child in blue coat',details:{body:{build:'very slender child'}}}};
  const boyTurn=await turn('再瘦一点，但保持年龄感',{type:'ASSET',key:'CHAR-001'});
  assert.equal(boyTurn.mode,'PROPOSE_CHANGE');assert.equal(boyTurn.actionProposal.targetType,'VISUAL_SPEC');assert.equal(boyTurn.actionProposal.applied,false);
  assert.equal(oss.modelCalls.length,calls+1,'Studio text turn uses one model call');
  oss.proposalOutput={mode:'DISCUSS',reply:'赤足是为了让触感更直接。'};
  assert.equal((await turn('为什么现在是赤足？',{type:'ASSET',key:'CHAR-001'})).mode,'DISCUSS');
  oss.proposalOutput={mode:'PROPOSE_CHANGE',reply:'夜空更深的草案已准备。',summary:'深化夜空',rationale:'保持岛屿构图',patch:{details:{lighting:'deeper blue moonlight'}}};
  const envTurn=await turn('更像第二片夜空',{type:'ASSET',key:'LOC-001'},{sourceAssetRevision:environment.sourceAssetRevision,spec:environment.spec});
  assert.equal(envTurn.actionProposal.targetType,'VISUAL_SPEC');
  oss.proposalOutput={mode:'PROPOSE_CHANGE',reply:'建议缩短到三秒。',summary:'缩短镜头',rationale:'更紧凑',patch:{duration:3}};
  const shotTurn=await turn('缩短到3秒',{type:'SHOT',key:String(shotId)});
  assert.deepEqual(shotTurn.actionProposal.proposal,{type:'EDIT',storyboardId:shotId,patch:{duration:3}});
  oss.proposalOutput={mode:'DISCUSS',reply:'五秒用于建立空间。'};
  assert.equal((await turn('为什么需要5秒？',{type:'SHOT',key:String(shotId)})).mode,'DISCUSS');
  assert.equal((await turn('这部片子的情绪如何？',null)).mode,'DISCUSS');
  oss.proposalOutput={mode:'PROPOSE_CHANGE',reply:'需要先明确身份修改目标。',summary:'更名',rationale:'',patch:{}};
  assert.equal((await turn('把名字改了',{type:'ASSET',key:'CHAR-001'})).mode,'NEEDS_TARGET_CONFIRMATION');
  assert.equal((await turn('删掉那个素材',null)).mode,'NEEDS_TARGET_CONFIRMATION');
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first(),beforeAsset);
  assert.deepEqual(await db('o_v04AssetVisualSpec').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).orderBy('revision','desc').first(),beforeSpec);
  assert.deepEqual(await db('o_storyboard').where({id:shotId}).first(),beforeShot);
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
  oss.proposalOutput={mode:'DISCUSS',reply:'已确认的品牌参考会在创意和分镜讨论中持续可见。'};
  const studioReply=await post('/agent/studio-turn',{context:creative,message:'继续讨论品牌结尾。'});
  assert.equal(studioReply.mode,'DISCUSS');assert.equal(studioReply.applied,false);
  const sharedHistory=await post('/agent/history',scope);
  assert.equal(sharedHistory.isolationKey,studioReply.isolationKey);
  assert.equal(sharedHistory.messages.find(m=>m.id===studioReply.userMessageId)?.content,'继续讨论品牌结尾。');
  assert.equal(sharedHistory.messages.find(m=>m.id===studioReply.assistantMessageId)?.content,studioReply.reply);

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
  assert.equal(result.output.candidates[0].assetKind,'MATERIAL_FX','unambiguous FX kind is derived server-side');
  assert.deepEqual(result.output.coverage,[]);
  assert.equal(result.sourceVersion,1);
  assert.equal(oss.sessionCount,1,'repair pins one model session');
  assert.equal(oss.modelCalls.length,2,'at most one repair');
  assert.equal(oss.modelCalls[0].model,oss.modelCalls[1].model);
  assert.match(oss.modelCalls[1].messages[1].content,/Missing contract fields/);
  assert.match(oss.modelCalls[1].messages[1].content,/Repair references and format only/);
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
  oss.skillResponses=[{candidates:[{name:'Still missing'}],mergeSuggestions:[]},{candidates:[{name:'Still missing'}],mergeSuggestions:[]}];
  await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_SCHEMA_FAILED' && /结构/.test(e.message));
  assert.equal(oss.modelCalls.length,4,'failed repair does not start a third attempt');
  assert.equal((await db('o_v04Asset').count({n:'canonicalKey'}).first()).n,0);
});

test('OPT-024 compact extraction normalizes safe defaults and name refs without weakening final proposal', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Compact extraction',brief:'Dream Stream logo and blue matter',targetDuration:40,aspectRatio:'16:9'},7);
  const brand=[{operation:'ADD',clientRef:'brand',asset:asset('Dream Stream Logo','BRAND','REAL_REQUIRED')}];
  const brandPreview=await s.previewAssets({...scope,changes:brand});await s.applyAssets({...scope,changes:brand,previewHash:brandPreview.previewHash});
  const creative={...scope,brief:'Dream Stream logo and blue matter',treatment:'Dream Stream Logo appears over blue dream matter and a ship.',script:'',targetDuration:40,expectedVersion:1};
  const creativePreview=await s.previewCreative(creative);await s.applyCreative({...creative,previewHash:creativePreview.previewHash});
  const compact={candidates:[
    {name:'Dream Stream Logo',category:'BRAND',description:'Existing real logo',sourcePolicy:'REAL_REQUIRED'},
    {name:'Blue Dream Matter',category:'FX',description:'Shared blue luminous material',sourcePolicy:'AI_ALLOWED',identityAnchors:null,prompt:null},
    {name:'Ship',category:'PROP',assetKind:'VEHICLE',importance:'CORE',description:'A ship with dream matter',sourcePolicy:'AI_ALLOWED',sharedVisualSystemRef:'Blue Dream Matter'},
  ],mergeSuggestions:[{candidateRef:'Dream Stream Logo',existingCanonicalKey:'BRAND-001',reason:'Use confirmed identity'}],coverage:[
    {label:'Dream Stream Logo',coverageType:'BRAND',classification:'CANONICAL_ASSET',existingCanonicalKeys:['BRAND-001']},
    {label:'Blue Dream Matter',coverageType:'FX_MATERIAL',classification:'VISUAL_SYSTEM',candidateRefs:['Blue Dream Matter']},
    {label:'Ship',coverageType:'VEHICLE',classification:'CANONICAL_ASSET',candidateRefs:['Ship']},
  ]};
  oss.proposalOutput=compact;
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const before=await db('o_v04Asset').where({projectId:scope.projectId});
  const result=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(result.applied,false);
  assert.equal(result.output.candidates[1].assetKind,'MATERIAL_FX');
  assert.equal(result.output.candidates[1].extractionPass,'VISUAL_SYSTEM');
  assert.deepEqual(result.output.candidates[1].identityAnchors,[]);
  assert.equal(result.output.candidates[1].prompt,'');
  assert.equal(result.output.candidates[2].sharedVisualSystemCandidateIndex,1);
  assert.deepEqual(result.output.coverage[2].candidateIndexes,[2]);
  assert.equal(result.output.mergeSuggestions[0].candidateIndex,0);
  assert.equal(result.sourceVersion,2);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),before);
  assert.equal((await db('o_v04AssetCoverage').where(scope)).length,0);
  assert.match(oss.modelCalls.at(-1).system,/elementNames/);
  assert.doesNotMatch(oss.modelCalls.at(-1).system,/relatedCandidateIndexes\/sharedVisualSystemCandidateIndex/);
  const diagnostics=[];t.mock.method(console,'error',(...args)=>diagnostics.push(args));
  const schemaInvalids=[
    {...compact,candidates:[{...compact.candidates[1],sourcePolicy:'UNSAFE'}]},
    {...compact,candidates:[compact.candidates[1],{...compact.candidates[2],sharedVisualSystemRef:'Missing'}],mergeSuggestions:[],coverage:compact.coverage.slice(1)},
    {...compact,coverage:[]},
  ];
  for(const invalid of schemaInvalids){
    oss.skillResponses=[invalid,invalid];
    await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_SCHEMA_FAILED');
    assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),before,'failed output is zero-write');
  }
  assert.equal(oss.modelCalls.length,7,'three malformed shapes each receive exactly one repair');
  assert.deepEqual(diagnostics.slice(0,2).map(entry=>entry[1].repairAttempt),[0,1]);
  assert.deepEqual(diagnostics[0][1].validation,[{path:'candidates.0.sourcePolicy',failureType:'custom'}]);
  assert.deepEqual(diagnostics[0][1].semanticLabels,[{path:'candidates.0.sourcePolicy',failureType:'unknown_or_ambiguous',receivedLabel:'UNSAFE',normalizedLabelKey:'UNSAFE'}]);
  assert.doesNotMatch(JSON.stringify(diagnostics),/Shared blue luminous material|Dream Stream Logo|Bearer|Authorization/,'diagnostics contain paths and types, not model content');
  for(const invalid of [
    {...compact,candidates:[{...compact.candidates[1],relatedCandidateIndexes:[99]}],mergeSuggestions:[],coverage:[compact.coverage[1]]},
    {...compact,candidates:[{...compact.candidates[0],sourcePolicy:'AI_ALLOWED'}],mergeSuggestions:[],coverage:[{...compact.coverage[0],candidateRefs:['Dream Stream Logo']}]},
  ]) {
    oss.proposalOutput=invalid;
    await assert.rejects(skills.previewSkill({...scope,method:'ASSET_EXTRACTION'}),e=>e.code==='PILOT_SKILL_REFERENCE_INVALID');
    assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),before);
  }
  assert.equal(oss.modelCalls.length,9,'semantic violations do not trigger blind structured retries');
});

test('V0.4 semantic JSON compiles pilot-scale entities and coverage without model-owned canonical fields', () => {
  const {compileAssetExtractionSemantic}=loadSource(path.join(root,'src/v04/assetExtractionSemantic.ts'),null);
  const names=[
    ['Boy','HUMAN_CHARACTER'],['Dream Matter','MATERIAL_FX'],['Pirate Ship','VEHICLE'],
    ['Submarine','VEHICLE'],['Pegasus','CREATURE'],['Whale','CREATURE'],
    ['Island Night','ENVIRONMENT'],['Sea Night','ENVIRONMENT'],['Whale Dream','ENVIRONMENT'],
    ['Cloud Moon Night','ENVIRONMENT'],['Moon','CELESTIAL'],['Dream Stream Logo','BRAND_MARK'],
  ];
  const visualElements=names.map(([name,type])=>({name,type,description:name,
    ...(name==='Dream Stream Logo'?{existingCanonicalKey:'BRAND-001'}:{}),
    ...(['Pirate Ship','Submarine','Pegasus'].includes(name)?{sharedVisualSystemName:'Dream Matter',relatedNames:['Dream Matter',name]}:{}),
  }));
  const coverage=[...names.map(([name,type])=>({label:name,type,elementNames:[name]})),
    ...Array.from({length:6},(_,i)=>({label:`Beat ${i+1}`,type:'COMPOSITION_GOAL',elementNames:[],note:'composition only'}))];
  const existing=[{canonicalKey:'BRAND-001',name:'Dream Stream Logo',category:'BRAND'}];
  const result=compileAssetExtractionSemantic({visualElements,coverage},existing);
  assert.equal(result.candidates.length,12);assert.equal(result.coverage.length,18);
  assert.equal(result.candidates[4].assetKind,'CREATURE','a mount remains a creature by identity');
  assert.equal(result.candidates[11].sourcePolicy,'REAL_REQUIRED');
  assert.equal(result.mergeSuggestions[0].existingCanonicalKey,'BRAND-001');
  assert.equal(result.candidates[2].sharedVisualSystemCandidateIndex,null,'entity phase cannot author relationships');
  assert.deepEqual(result.candidates[2].relatedCandidateIndexes,[]);
  assert.equal(result.coverage[1].classification,'VISUAL_SYSTEM');
  assert.equal(result.coverage[12].classification,'COMPOSITION_MOTIF');
  assert.throws(()=>compileAssetExtractionSemantic({visualElements:[{name:'Unknown',type:'MYSTERY',description:''}],coverage:[]},existing),e=>e.issues?.[0]?.path?.join('.')==='visualElements.0.type');
  assert.equal(compileAssetExtractionSemantic({visualElements:[{name:'Ship',type:'VEHICLE',description:'',sharedVisualSystemName:'Absent'}],coverage:[{label:'Ship',elementNames:['Ship']}]},existing).candidates[0].sharedVisualSystemCandidateIndex,null,'incidental relationship hints are ignored until relation phase');
  assert.throws(()=>compileAssetExtractionSemantic({visualElements:[{name:'Logo',type:'BRAND_MARK',description:'',existingCanonicalKey:'BRAND-OTHER'}],coverage:[]},existing),e=>e.issues?.[0]?.path?.join('.')==='visualElements.0.existingCanonicalKey');
  assert.throws(()=>compileAssetExtractionSemantic({visualElements:[{name:'Ship',type:'VEHICLE',description:''}],coverage:[{label:'Ship',type:'CREATURE',elementNames:['Ship']}]},existing),e=>e.issues?.[0]?.path?.join('.')==='coverage.0.type');
  const mixed=compileAssetExtractionSemantic({visualElements:[{name:'Matter',type:'MATERIAL_FX',description:''},{name:'Ship',type:'VEHICLE',description:''}],coverage:[{label:'Matter forms Ship',type:'VEHICLE',elementNames:['Matter','Ship']}]},existing);
  assert.equal(mixed.coverage.length,2,'shared visual system gets its own audit row even in a mixed beat');
  assert.equal(mixed.coverage[1].classification,'VISUAL_SYSTEM');
});

test('OPT-026 direct identities stay in Asset Bible while linked story beats and brand composition move to Storyboard', () => {
  const {compileAssetExtractionSemantic}=loadSource(path.join(root,'src/v04/assetExtractionSemantic.ts'),null);
  const {auditAssetSufficiency}=loadSource(path.join(root,'src/v04/assetSufficiency.ts'),null);
  const existing=[{canonicalKey:'BRAND-001',name:'Dream Stream Logo',category:'BRAND'}];
  const visualElements=[
    {name:'男孩',type:'HUMAN_CHARACTER'},{name:'鲸鱼',type:'CREATURE'},
    {name:'潜水艇',type:'VEHICLE'},{name:'飞马',type:'CREATURE'},
    {name:'鲸腹内景',type:'ENVIRONMENT'},{name:'海面',type:'ENVIRONMENT'},
    {name:'蓝色荧光物质',type:'MATERIAL_FX'},
    {name:'Dream Stream Logo',type:'BRAND_MARK',existingCanonicalKey:'BRAND-001'},
  ];
  const rows=[
    {label:'男孩',elementNames:['男孩']},
    {label:'蓝色荧光物质',elementNames:['蓝色荧光物质']},
    {label:'鲸腹内景',elementNames:['鲸腹内景']},
    {label:'男孩第一次主动伸手',elementNames:['男孩','蓝色荧光物质','鲸腹内景']},
    {label:'鲸鱼喷嚏把男孩和潜水艇喷出',elementNames:['鲸鱼','男孩','潜水艇']},
    {label:'片尾飞马掠海面与 Dream Stream Logo 对齐',elementNames:['飞马','海面'],existingCanonicalKeys:['BRAND-001']},
    {label:'Dream Stream Logo',existingCanonicalKeys:['BRAND-001']},
  ];
  const proposal=compileAssetExtractionSemantic({visualElements,coverage:rows},existing);
  assert.deepEqual(proposal.coverage.slice(0,7).map(row=>row.classification),
    ['CANONICAL_ASSET','VISUAL_SYSTEM','SCENE_ANCHOR','SHOT_LOCAL','SHOT_LOCAL','COMPOSITION_MOTIF','CANONICAL_ASSET']);
  assert.equal(proposal.coverage[5].coverageType,'COMPOSITION_GOAL');
  assert.equal(proposal.coverage[5].existingCanonicalKeys[0],'BRAND-001');
  const treatment=rows.map(row=>row.label).join('，');
  const audit={environments:[{label:'鲸腹内景',evidenceQuote:'鲸腹内景',coveredByName:'鲸腹内景',reason:''}],missing:[],unsupportedCoverageLabels:[]};
  const review=auditAssetSufficiency(proposal,treatment,audit,existing);
  assert.equal(review.existingReferenceCount,1,'merge and Coverage reuse the same BRAND identity once');
  assert.equal(review.requirements.find(row=>row.label==='男孩第一次主动伸手').status,'DOCUMENTED');
  assert.equal(review.requirements.find(row=>row.label==='片尾飞马掠海面与 Dream Stream Logo 对齐').status,'DOCUMENTED');
  const mixed=compileAssetExtractionSemantic({visualElements:[{name:'男孩',type:'HUMAN_CHARACTER'}],
    coverage:[{label:'男孩',elementNames:['男孩'],existingCanonicalKeys:['LOC-001']}]},
    [{canonicalKey:'LOC-001',name:'鲸腹内景',category:'LOC'}]);
  assert.equal(mixed.coverage[0].classification,'SHOT_LOCAL','an additional existing identity makes the row a beat, even when its label names one participant');
});

test('OPT-025 sufficiency checks ownership, exact Treatment evidence and false requirements without counting assets', () => {
  const {compileAssetExtractionSemantic}=loadSource(path.join(root,'src/v04/assetExtractionSemantic.ts'),null);
  const {auditAssetSufficiency}=loadSource(path.join(root,'src/v04/assetSufficiency.ts'),null);
  const treatment='A boy leaves the island at night, enters the whale interior, then rises toward the moon in the final sky.';
  const proposal=compileAssetExtractionSemantic({visualElements:[
    {name:'Boy',type:'HUMAN_CHARACTER',description:''},
    {name:'Island Night',type:'ENVIRONMENT',description:''},
    {name:'Whale Interior',type:'ENVIRONMENT',description:''},
  ],coverage:[
    {label:'Boy',type:'HUMAN_CHARACTER',elementNames:['Boy']},
    {label:'Island Night',type:'ENVIRONMENT',elementNames:['Island Night']},
    {label:'Whale Interior',type:'ENVIRONMENT',elementNames:['Whale Interior']},
    {label:'Software UI screen',type:'UI_REFERENCE',elementNames:[]},
    {label:'Boy reaches',type:'COMPOSITION_GOAL',elementNames:[]},
  ]},[]);
  const audit={environments:[
    {label:'Island Night',evidenceQuote:'island at night',coveredByName:'Island Night',reason:'Opening'},
    {label:'Whale Interior',evidenceQuote:'whale interior',coveredByName:'Whale Interior',reason:'Interior'},
    {label:'Final Sky',evidenceQuote:'rises toward the moon',coveredByName:null,reason:'Distinct destination environment'},
  ],missing:[],unsupportedCoverageLabels:['Software UI screen']};
  const review=auditAssetSufficiency(proposal,treatment,audit);
  assert.equal(review.status,'NEEDS_REVIEW');
  assert.deepEqual(review.requirements.filter(row=>row.status==='MISSING').map(row=>row.label),['Final Sky']);
  assert.equal(new Set(review.requirements.map(row=>row.requirementKey)).size,review.requirements.length);
  assert.deepEqual(auditAssetSufficiency(proposal,treatment,audit).requirements.map(row=>row.requirementKey),review.requirements.map(row=>row.requirementKey),'same proposal snapshot yields stable requirement identity');
  assert.equal(review.requirements.at(-1).sourceCoverageIndex,null,'audit missing is not identified by a coverage array position');
  const twoMissingAudit={...audit,environments:[...audit.environments,{label:'Moonlit cloud bank',evidenceQuote:'final sky',coveredByName:null,reason:'Second distinct space'}]};
  const twoMissing=auditAssetSufficiency(proposal,treatment,twoMissingAudit).requirements.filter(row=>row.sourceCoverageIndex===null);
  assert.equal(twoMissing.length,2);assert.equal(new Set(twoMissing.map(row=>row.requirementKey)).size,2);
  assert.deepEqual(twoMissing.map(row=>row.requirementKey),auditAssetSufficiency(proposal,treatment,twoMissingAudit).requirements.filter(row=>row.sourceCoverageIndex===null).map(row=>row.requirementKey));
  assert.equal(review.requirements.find(row=>row.label==='Boy reaches').status,'DOCUMENTED','a beat does not become a required asset');
  assert.equal(review.proposal.coverage.some(row=>row.label==='Software UI screen'),false,'policy-only UI cannot become a missing requirement');
  assert.equal(review.excludedUngroundedCoverage,1);
  const noAuditRejection=auditAssetSufficiency(proposal,treatment,{...audit,unsupportedCoverageLabels:[]});
  assert.equal(noAuditRejection.proposal.coverage.some(row=>row.label==='Software UI screen'),false,'an unlinked UI requirement absent from Treatment is excluded without depending on model judgement');
  assert.equal(review.candidateCount,3,'no fixed target asset count');
  const invented=auditAssetSufficiency(proposal,treatment,{...audit,environments:[{label:'Invented',evidenceQuote:'not in Treatment',coveredByName:null,reason:''}]});
  assert.equal(invented.status,'NEEDS_REVIEW');assert.equal(invented.requirements.some(row=>row.label==='Invented'),false,'ungrounded model warning is ignored');
  const incomplete=auditAssetSufficiency(proposal,treatment);
  assert.equal(incomplete.status,'NEEDS_REVIEW','model audit failure cannot be reported as READY');
  const ascent='飞船从海面起飞，转向月亮，向上。';
  const ascentProposal=compileAssetExtractionSemantic({visualElements:[
    {name:'飞船',type:'VEHICLE',description:''},{name:'海面',type:'ENVIRONMENT',description:''},
  ],coverage:[{label:'飞船',elementNames:['飞船']},{label:'海面',elementNames:['海面']}]},[]);
  const ascentAudit={environments:[{label:'海面',evidenceQuote:'海面起飞',coveredByName:'海面',reason:'出发地'}],missing:[],unsupportedCoverageLabels:[]};
  const ascentReview=auditAssetSufficiency(ascentProposal,ascent,ascentAudit);
  assert.equal(ascentReview.status,'NEEDS_REVIEW','a final skyward transition cannot be hidden by a complete-looking environment list');
  assert.match(ascentReview.requirements.find(row=>row.status==='MISSING').label,/目的地环境/);
  const skyProposal=compileAssetExtractionSemantic({visualElements:[
    {name:'飞船',type:'VEHICLE',description:''},{name:'云端夜空',type:'ENVIRONMENT',description:''},
  ],coverage:[{label:'飞船',elementNames:['飞船']},{label:'云端夜空',elementNames:['云端夜空']}]},[]);
  const skyReview=auditAssetSufficiency(skyProposal,ascent,{...ascentAudit,environments:[{label:'云端夜空',evidenceQuote:'转向月亮，向上',coveredByName:'云端夜空',reason:'目的地'}]});
  assert.equal(skyReview.status,'READY','an explicitly proposed destination environment satisfies the grounded review cue');
});

test('OPT-025 human review cannot bypass REAL_REQUIRED for BRAND or UI', async t => {
  const {db,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Real source boundary',brief:'A real logo',targetDuration:30,aspectRatio:'16:9'},7);
  const invalid={operation:'ADD',clientRef:'bad-logo',asset:asset('Logo','BRAND','AI_ALLOWED')};
  await assert.rejects(s.previewAssets({...scope,changes:[invalid]}),e=>e.code==='PILOT_REAL_SOURCE_REQUIRED');
  const good={operation:'ADD',clientRef:'logo',asset:asset('Logo','BRAND','REAL_REQUIRED')};
  const preview=await s.previewAssets({...scope,changes:[good]});
  await s.applyAssets({...scope,changes:[good],previewHash:preview.previewHash});
  await assert.rejects(s.previewAssets({...scope,changes:[{operation:'EDIT',canonicalKey:'BRAND-001',expectedRevision:1,patch:{sourcePolicy:'AI_ALLOWED'}}]}),e=>e.code==='PILOT_REAL_SOURCE_REQUIRED');
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'BRAND-001'}).first()).sourcePolicy,'REAL_REQUIRED');
});

test('V0.4 two-stage extraction pins one session, compiles exact-name relations, and remains zero-write', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Relations pilot',brief:'Shared glowing material',targetDuration:40,aspectRatio:'16:9'},7);
  const brand={operation:'ADD',clientRef:'brand',asset:asset('Brand Mark','BRAND','REAL_REQUIRED')};
  const brandPreview=await s.previewAssets({...scope,changes:[brand]});
  await s.applyAssets({...scope,changes:[brand],previewHash:brandPreview.previewHash});
  const creative={...scope,brief:'Shared glowing material',treatment:'One glowing material becomes a ship, then a submarine, then a winged creature. It rises into the high night sky. A Brand Mark appears at the end.',script:'',targetDuration:40,expectedVersion:1};
  const preview=await s.previewCreative(creative);await s.applyCreative({...creative,previewHash:preview.previewHash});
  const lean={visualElements:[
    {name:'Glow',type:'MATERIAL_FX',description:'shared material'},
    {name:'Ship',type:'VEHICLE',description:'first form'},
    {name:'Submarine',type:'VEHICLE',description:'second form'},
    {name:'Winged Creature',type:'CREATURE',description:'third form'},
    {name:'Brand Mark',type:'BRAND_MARK',description:'existing mark',existingCanonicalKey:'BRAND-001'},
  ],coverage:[...['Glow','Ship','Submarine','Winged Creature','Brand Mark'].map(name=>({label:name,elementNames:[name]})),{label:'Software UI screen',type:'UI_REFERENCE',elementNames:[]}]};
  const relations={sharedSystems:[{systemName:'Glow',memberNames:['Ship','Submarine','Winged Creature']}],
    continuityGroups:[{memberNames:['Ship','Submarine','Winged Creature']}]};
  const audit={missing:[{label:'High night sky',type:'SCENE',evidenceQuote:'high night sky',reason:'Distinct final environment'}],unsupportedCoverageLabels:['Software UI screen']};
  const beforeAssets=await db('o_v04Asset').where({projectId:scope.projectId});
  const beforeCoverage=await db('o_v04AssetCoverage').where(scope);
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  oss.skillResponses=[lean,relations,audit];
  const result=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(result.applied,false);assert.equal(result.repairAttempts,0);
  assert.equal(result.relationStatus,'READY');assert.equal(result.relationIssue,null);
  assert.equal(result.output.candidates[1].sharedVisualSystemCandidateIndex,0);
  assert.deepEqual(result.output.candidates[1].relatedCandidateIndexes,[0,2,3]);
  assert.equal(oss.sessionCount,1);assert.equal(oss.modelCalls.length,3);
  assert.equal(oss.modelCalls[0].method,'invokeJson');assert.equal(oss.modelCalls[1].method,'invokeJson');
  assert.match(oss.modelCalls[1].system,/持续身份\/形态关系/);
  assert.equal(result.sufficiency.status,'NEEDS_REVIEW');
  assert.equal(result.sufficiency.requirements.at(-1).label,'High night sky');
  assert.equal(result.output.coverage.some(item=>item.label==='Software UI screen'),false);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),beforeAssets);
  assert.deepEqual(await db('o_v04AssetCoverage').where(scope),beforeCoverage);
  oss.skillResponses=[lean,{sharedSystems:[{systemName:'Ship',memberNames:['Submarine']}],continuityGroups:[]},relations,audit];
  const repaired=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(repaired.repairAttempts,1);assert.equal(repaired.relationStatus,'READY');assert.equal(oss.modelCalls.length,7,'relation repair is bounded to one additional call');
  oss.skillResponses=[lean,{sharedSystems:[{systemName:'Other',memberNames:['Ship']}],continuityGroups:[]},{sharedSystems:[{systemName:'Other',memberNames:['Ship']}],continuityGroups:[]},audit];
  const unresolved=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(unresolved.applied,false);assert.equal(unresolved.repairAttempts,1);
  assert.equal(unresolved.relationStatus,'NEEDS_REVIEW');assert.equal(unresolved.relationIssue.code,'PILOT_RELATION_SCHEMA_FAILED');
  assert.equal(unresolved.output.candidates.length,lean.visualElements.length);
  assert.equal(unresolved.output.mergeSuggestions.some(item=>item.existingCanonicalKey==='BRAND-001'),true,'fail-soft preserves confirmed identity merge');
  assert.equal(unresolved.output.candidates.every(item=>item.relatedCandidateIndexes.length===0 && item.sharedVisualSystemCandidateIndex===null),true,'invalid relations are never retained');
  assert.ok(unresolved.output.coverage.length>0);assert.equal(unresolved.sufficiency.status,'NEEDS_REVIEW');
  const beforeProviderCalls=oss.modelCalls.length;
  oss.skillResponses=[lean,Error('Authorization: Bearer private-token'),audit];
  const providerUnresolved=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(providerUnresolved.relationStatus,'NEEDS_REVIEW');
  assert.equal(providerUnresolved.relationIssue.code,'PILOT_RELATION_MODEL_FAILED');
  assert.doesNotMatch(JSON.stringify(providerUnresolved.relationIssue),/private-token/);
  assert.equal(oss.modelCalls.length-beforeProviderCalls,3,'provider failure does not add a blind relation retry');
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),beforeAssets);
  assert.deepEqual(await db('o_v04AssetCoverage').where(scope),beforeCoverage);
});

test('OPT-024B provider labels accept common English and Chinese aliases; canonical proposal remains strict', () => {
  const {assetExtractionModelSchema,normalizeAssetExtraction,assetExtractionProposalSchema}=loadSource(path.join(root,'src/v04/assetExtractionOutput.ts'),null);
  const rows=[
    ['Boy','CHARACTER','HUMAN_CHARACTER','PERSON'],['Whale','生物','动物','CREATURE'],
    ['Ship','VEHICLE','载具','VEHICLE'],['Island','ENVIRONMENT',null,'SCENE'],
    ['Dream matter','VISUAL_SYSTEM','MATERIAL','FX_MATERIAL'],['Glow','材质',null,'FX_MATERIAL'],
    ['Logo','LOGO','品牌标识','BRAND'],['Girl','人物','人类角色','PERSON'],
    ['Submarine','交通工具',null,'VEHICLE'],['Night sea','环境',null,'SCENE'],
    ['Brand mark','品牌标识',null,'BRAND'],
  ];
  const output={candidates:rows.map(([name,category,assetKind])=>({name,category,assetKind,description:'Pilot fixture',sourcePolicy:name.includes('Logo')||name==='Brand mark'?'必须上传真实素材':'允许AI生成',importance:['Boy','Whale','Ship','Girl','Submarine'].includes(name)?'核心':undefined})),
    coverage:rows.map(([name,, ,coverageType])=>({label:name,coverageType:coverageType==='CREATURE'?'CHARACTER':coverageType,classification:coverageType==='FX_MATERIAL'?'视觉系统':'正式资产',candidateRefs:[name]}))};
  assert.equal(assetExtractionModelSchema.safeParse(output).success,true,'provider-facing DTO accepts aliases before normalization');
  const normalized=normalizeAssetExtraction(output);
  assert.equal(normalized.candidates.length,11);
  assert.deepEqual(normalized.candidates.map(c=>c.category),['CHAR','CHAR','PROP','LOC','FX','FX','BRAND','CHAR','PROP','LOC','BRAND']);
  assert.deepEqual(normalized.candidates.map(c=>c.assetKind),['HUMAN_CHARACTER','CREATURE','VEHICLE','ENVIRONMENT','MATERIAL_FX','MATERIAL_FX','BRAND_MARK','HUMAN_CHARACTER','VEHICLE','ENVIRONMENT','BRAND_MARK']);
  assert.equal(normalized.coverage[1].coverageType,'CREATURE','linked candidate determines coverage despite ambiguous duplicate classification');
  assert.equal(normalized.candidates[6].sourcePolicy,'REAL_REQUIRED');
  assert.equal(assetExtractionProposalSchema.safeParse(normalized).success,true);
  assert.equal(assetExtractionProposalSchema.safeParse(output).success,false,'persisted proposal never accepts aliases');
  const celestial=structuredClone(output);
  celestial.candidates[3].assetKind='CELESTIAL';
  assert.equal(normalizeAssetExtraction(celestial).candidates[3].assetKind,'CELESTIAL','a broad environment label can still describe a celestial asset');
  for(const [mutate,expectedPath] of [
    [x=>{x.candidates[0].category='UNKNOWN_CREATURE';x.candidates[0].assetKind='UNKNOWN_KIND'},'candidates.0.category'],
    [x=>{x.candidates[0].category='CHARACTER';delete x.candidates[0].assetKind},'candidates.0.assetKind'],
    [x=>x.candidates[0].assetKind='UNKNOWN_KIND','candidates.0.assetKind'],
    [x=>{x.coverage[0].candidateRefs=[];x.coverage[0].coverageType='UNKNOWN_TYPE'},'coverage.0.coverageType'],
  ]){
    const invalid=structuredClone(output);mutate(invalid);
    assert.throws(()=>normalizeAssetExtraction(invalid),e=>e.issues?.some(issue=>issue.path.join('.')===expectedPath));
  }
});

test('OPT-024C cross-field category and coverage classification use deterministic evidence, not arbitrary labels', () => {
  const {normalizeAssetExtraction,semanticLabelDiagnostics,assetExtractionProposalSchema}=loadSource(path.join(root,'src/v04/assetExtractionOutput.ts'),null);
  const input={candidates:[
    {name:'Boy',category:'CHARACTER',assetKind:'HUMAN_CHARACTER',importance:'CORE',description:'boy',sourcePolicy:'AI_ALLOWED'},
    {name:'Moon',category:'CELESTIAL',assetKind:'CELESTIAL',description:'moon',sourcePolicy:'AI_ALLOWED'},
    {name:'Dream Matter',category:'VISUAL_SYSTEM',assetKind:'MATERIAL_FX',description:'matter',sourcePolicy:'AI_ALLOWED'},
    {name:'Variant Ship',category:'VEHICLE',assetKind:'VEHICLE',importance:'CORE',description:'ship',sourcePolicy:'AI_ALLOWED',variantOf:'PROP-001'},
  ],coverage:[
    {label:'Boy',coverageType:'PERSON',classification:'PERSON',candidateRefs:['Boy']},
    {label:'Moon composition',coverageType:'COMPOSITION_GOAL',classification:'COMPOSITION_GOAL',candidateRefs:[]},
    {label:'Dream Matter',coverageType:'FX_MATERIAL',classification:'FX_MATERIAL',candidateRefs:['Dream Matter']},
    {label:'Unresolved setting',coverageType:'SCENE',classification:'SCENE',candidateRefs:[]},
    {label:'Variant ship',coverageType:'VEHICLE',classification:'VEHICLE',candidateRefs:['Variant Ship']},
  ]};
  const output=normalizeAssetExtraction(input);
  assert.equal(output.candidates[1].category,'LOC');
  assert.deepEqual(output.coverage.map(row=>row.classification),['CANONICAL_ASSET','COMPOSITION_MOTIF','VISUAL_SYSTEM','SCENE_ANCHOR','VARIANT']);
  assert.equal(assetExtractionProposalSchema.safeParse(output).success,true);
  assert.deepEqual(output.coverage[3].candidateIndexes,[],'classification never manufactures coverage linkage');
  const unknownButRedundant=structuredClone(input);
  unknownButRedundant.coverage[2].classification='SHARED_VISUAL_SYSTEM';
  assert.equal(normalizeAssetExtraction(unknownButRedundant).coverage[2].classification,'VISUAL_SYSTEM');
  const recognizedConflict=structuredClone(input);
  recognizedConflict.coverage[2].classification='CANONICAL_ASSET';
  assert.throws(()=>normalizeAssetExtraction(recognizedConflict),error=>{
    const detail=semanticLabelDiagnostics(error)[0];
    return detail?.path==='coverage.2.classification' && detail.failureType==='conflict';
  });
  const noEvidence=structuredClone(input);
  noEvidence.coverage[3].coverageType='OTHER';
  noEvidence.coverage[3].classification='SHARED_VISUAL_SYSTEM';
  assert.throws(()=>normalizeAssetExtraction(noEvidence),error=>{
    const detail=semanticLabelDiagnostics(error)[0];
    return detail?.path==='coverage.3.classification' && detail.failureType==='unknown_or_ambiguous';
  });
  for(const [mutate,path,failureType] of [
    [x=>x.candidates[0].category='VEHICLE','candidates.0.category','conflict'],
    [x=>{x.candidates[1].category='MYSTERY';x.candidates[1].assetKind='UNKNOWN_KIND'},'candidates.1.category','unknown_or_ambiguous'],
    [x=>{x.coverage[3].classification='PERSON'},'coverage.3.classification','conflict'],
    [x=>{x.coverage[3].candidateRefs=['Moon']},'coverage.3.classification','conflict'],
  ]) {
    const invalid=structuredClone(input);mutate(invalid);
    assert.throws(()=>normalizeAssetExtraction(invalid),error=>{
      const detail=semanticLabelDiagnostics(error)[0];
      return detail?.path===path && detail.failureType===failureType;
    });
  }
  const secret=structuredClone(input);secret.candidates[1].category='Authorization: Bearer sample-token';secret.candidates[1].assetKind='UNKNOWN_KIND';
  assert.throws(()=>normalizeAssetExtraction(secret),error=>{
    const detail=semanticLabelDiagnostics(error)[0];
    return detail.path==='candidates.1.category' && detail.receivedLabel===null && detail.normalizedLabelKey===null;
  });
});

test('OPT-024E resolves category and kind independently while rejecting ambiguity and real contradictions', () => {
  const {normalizeAssetExtraction,assetExtractionProposalSchema,semanticLabelDiagnostics}=loadSource(path.join(root,'src/v04/assetExtractionOutput.ts'),null);
  const input={candidates:[
    {name:'Matter',category:'FX',assetKind:'FX_SYSTEM',description:'shared material',sourcePolicy:'AI_ALLOWED'},
    {name:'Sea',category:'ENV',assetKind:'ENVIRONMENT',description:'night sea',sourcePolicy:'AI_ALLOWED'},
    {name:'Moon',category:'UNKNOWN_SKY_LABEL',assetKind:'CELESTIAL',description:'moon',sourcePolicy:'AI_ALLOWED'},
    {name:'Logo',category:'BRAND',assetKind:'UNRECOGNIZED_LOGO_KIND',description:'real logo',sourcePolicy:'REAL_REQUIRED'},
  ]};
  const output=normalizeAssetExtraction(input);
  assert.deepEqual(output.candidates.map(row=>[row.category,row.assetKind]),[
    ['FX','MATERIAL_FX'],['LOC','ENVIRONMENT'],['LOC','CELESTIAL'],['BRAND','BRAND_MARK'],
  ]);
  assert.equal(assetExtractionProposalSchema.safeParse(output).success,true);
  for(const [mutate,expectedPath,expectedType] of [
    [x=>{x.candidates[0].category='VEHICLE';x.candidates[0].assetKind='HUMAN_CHARACTER'},'candidates.0.category','conflict'],
    [x=>{x.candidates[1].category='UNKNOWN_CATEGORY';x.candidates[1].assetKind='UNKNOWN_KIND'},'candidates.1.category','unknown_or_ambiguous'],
    [x=>{x.candidates[0].category='CHAR';x.candidates[0].assetKind='UNKNOWN_KIND'},'candidates.0.assetKind','unknown_or_ambiguous'],
    [x=>{x.candidates[1].category='LOC';x.candidates[1].assetKind='UNKNOWN_KIND'},'candidates.1.assetKind','unknown_or_ambiguous'],
  ]) {
    const invalid=structuredClone(input);mutate(invalid);
    assert.throws(()=>normalizeAssetExtraction(invalid),error=>{
      const detail=semanticLabelDiagnostics(error)[0];
      return detail?.path===expectedPath && detail.failureType===expectedType;
    });
  }
});

test('OPT-024B pilot-scale 11 candidates and 18 coverage rows remain proposal-only with existing BRAND merge', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Alias pilot',brief:'Dream Stream film',targetDuration:40,aspectRatio:'16:9'},7);
  const brand=[{operation:'ADD',clientRef:'brand',asset:asset('Dream Stream Logo','BRAND','REAL_REQUIRED')}];
  const brandPreview=await s.previewAssets({...scope,changes:brand});await s.applyAssets({...scope,changes:brand,previewHash:brandPreview.previewHash});
  const creative={...scope,brief:'Dream Stream film',treatment:'Boy, whale, ship, submarine, pegasus and blue dream matter cross an island and night sea. The real Dream Stream Logo closes the film.',script:'',targetDuration:40,expectedVersion:1};
  const creativePreview=await s.previewCreative(creative);await s.applyCreative({...creative,previewHash:creativePreview.previewHash});
  const candidates=[
    ['Boy','CHARACTER','HUMAN_CHARACTER'],['Whale','CREATURE','CREATURE'],['Ship','VEHICLE','VEHICLE'],['Submarine','载具','VEHICLE'],['Pegasus','生物','CREATURE'],
    ['Dream Matter','VISUAL_SYSTEM','MATERIAL'],['Island','ENVIRONMENT','ENVIRONMENT'],['Night Sea','场景','ENVIRONMENT'],['Whale Interior','LOCATION','ENVIRONMENT'],['Moon','CELESTIAL','CELESTIAL'],['Dream Stream Logo','LOGO','LOGO'],
  ].map(([name,category,assetKind],i)=>({name,category,assetKind,description:'Pilot semantic alias',sourcePolicy:i===10?'REAL_REQUIRED':'AI_ALLOWED',importance:i<5?'CORE':undefined,
    relatedCandidateRefs:i===5?['Ship','Submarine','Pegasus']:[],sharedVisualSystemRef:[2,3,4].includes(i)?'Dream Matter':undefined}));
  candidates[5].assetKind='FX_SYSTEM';
  candidates[6].category='ENV';
  const coverage=candidates.map((candidate,i)=>({label:candidate.name,coverageType:i===9?'COMPOSITION_GOAL':i===10?'LOGO':'CHARACTER',classification:i===5?'SHARED_VISUAL_SYSTEM':i===9?'COMPOSITION_GOAL':i===10?'BRAND':'CANONICAL_ASSET',
    candidateRefs:i===10?[]:[candidate.name],existingCanonicalKeys:i===10?['BRAND-001']:[]}));
  for(let i=0;i<7;i++) coverage.push({label:`Additional scene beat ${i}`,coverageType:i%2?'SCENE':'COMPOSITION_GOAL',classification:i%2?'SCENE':'COMPOSITION_GOAL',candidateRefs:[],existingCanonicalKeys:[],note:'Human review required'});
  const output={candidates,mergeSuggestions:[{candidateRef:'Dream Stream Logo',existingCanonicalKey:'BRAND-001',reason:'Existing real logo'}],coverage};
  const model=loadSource(path.join(root,'src/v04/assetExtractionOutput.ts'),db,cache,oss);
  assert.equal(model.assetExtractionModelSchema.safeParse(output).success,true);
  const normalized=model.normalizeAssetExtraction(output);
  assert.deepEqual([...new Set([...normalized.coverage.flatMap(row=>row.candidateIndexes),...normalized.mergeSuggestions.map(row=>row.candidateIndex)])].sort((a,b)=>a-b),Array.from({length:11},(_,i)=>i));
  const beforeAssets=await db('o_v04Asset').where({projectId:scope.projectId});
  oss.proposalOutput=output;
  const skills=loadSource(path.join(root,'src/v04/skills.ts'),db,cache,oss);
  const preview=await skills.previewSkill({...scope,method:'ASSET_EXTRACTION'});
  assert.equal(preview.output.candidates.length,11);
  assert.equal(preview.output.coverage.length,18);
  assert.equal(preview.output.mergeSuggestions[0].existingCanonicalKey,'BRAND-001');
  assert.equal(preview.output.candidates[10].sourcePolicy,'REAL_REQUIRED');
  assert.equal(preview.output.coverage[1].coverageType,'CREATURE');
  assert.equal(preview.output.candidates[9].category,'LOC');
  assert.equal(preview.output.candidates[5].assetKind,'MATERIAL_FX');
  assert.equal(preview.output.candidates[6].category,'LOC');
  assert.equal(preview.output.coverage[5].classification,'VISUAL_SYSTEM');
  assert.equal(preview.output.coverage[16].classification,'SCENE_ANCHOR');
  assert.equal(preview.output.coverage[17].classification,'COMPOSITION_MOTIF');
  assert.equal(preview.applied,false);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}),beforeAssets);
  assert.equal((await db('o_v04AssetCoverage').where(scope)).length,0);
  assert.equal(oss.modelCalls.length,1,'valid alias output needs no repair or paid model');
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
  assert.match(oss.modelCalls.at(-1).system,/已有 canonical identity 不得重复创建.*existingCanonicalKey 建议合并/);
  assert.match(oss.modelCalls.at(-1).system,/共享视觉系统/);
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
  const coverage=specs.map(([name],index)=>({label:name,coverageType:['PERSON','CREATURE','VEHICLE','VEHICLE','CREATURE','FX_MATERIAL','SCENE','SCENE','SCENE','COMPOSITION_GOAL'][index],classification:index===5?'VISUAL_SYSTEM':index===9?'COMPOSITION_MOTIF':'CANONICAL_ASSET',candidateIndexes:[index],existingCanonicalKeys:[],note:''}));
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
  assert.match(oss.modelCalls.at(-1).system,/"canonicalKey":"BRAND-001"/,'Extraction retains the authoritative Asset Bible identity');
  assert.doesNotMatch(oss.modelCalls.at(-1).system,/CONFIRMED_ASSET_BIBLE_REFERENCE|最近对话|历史摘要/,'Extraction must not turn Agent policies or memory into Treatment requirements');

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

test('OPT-027A Visual Spec proposal/preview are zero-write; confirm versions, projects, continuity projection and Prompt freshness', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const visual=loadSource(path.join(root,'src/v04/visualSpec.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Visual definition',brief:'A boy on a dream voyage',targetDuration:40,aspectRatio:'16:9'},7);
  const other=await s.createPilotProject({name:'Other',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'boy',asset:{...asset('Boy'),assetKind:'HUMAN_CHARACTER',importance:'CORE'}}];
  const p=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:p.previewHash});
  oss.proposalOutput={visualIdentitySummary:'Young dreamer with a blue coat',silhouette:'small child, oversized coat',primaryPalette:['deep blue'],identityAnchors:['crescent pendant'],mustPreserve:['blue coat'],forbiddenChanges:['different face'],details:{ageRange:'8–10',footwear:'canvas shoes',hair:{color:'black',length:'short',silhouette:'short fringe'},body:{build:'slim'},wardrobe:{upper:'blue coat'}}};
  const before=await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first();
  const proposed=await visual.proposeVisualSpecs({...scope,canonicalKeys:['CHAR-001']});
  assert.equal(proposed.candidates[0].spec.details.hair.color,'black');
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first(),before);
  const body={...scope,...proposed.candidates[0]};
  const preview=await visual.previewVisualSpec({projectId:scope.projectId,scriptId:scope.scriptId,canonicalKey:'CHAR-001',sourceAssetRevision:body.sourceAssetRevision,spec:body.spec});
  assert.deepEqual(preview.issues,[]);
  const incomplete={...body.spec,details:{...body.spec.details,footwear:''}};
  const incompletePreview=await visual.previewVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:body.sourceAssetRevision,spec:incomplete});
  assert.ok(incompletePreview.issues.includes('details.footwear'));
  await assert.rejects(visual.applyVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:body.sourceAssetRevision,spec:incomplete,previewHash:incompletePreview.previewHash}),e=>e.code==='PILOT_VISUAL_INCOMPLETE');
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
  const applied=await visual.applyVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:body.sourceAssetRevision,spec:body.spec,previewHash:preview.previewHash});
  assert.equal(applied.revision,1);assert.equal(applied.promptStatus,'READY');
  const confirmed=await s.readPilot(scope);
  assert.equal(confirmed.visualSpecs[0].effectiveStatus,'CONFIRMED');
  assert.equal(confirmed.promptBuilds[0].effectiveStatus,'READY');
  assert.deepEqual(confirmed.assets[0].identityAnchors,['crescent pendant']);
  assert.deepEqual(confirmed.assets[0].mustPreserve,['blue coat']);
  assert.equal(confirmed.promptBuilds[0].generationIntent,'CHARACTER_TURNAROUND');
  assert.equal(confirmed.promptBuilds[0].compilerVersion,'v04.prompt-ir.2');
  const turnaround=confirmed.promptBuilds[0];
  assert.deepEqual(turnaround.promptIr.characterTurnaround.identityLock,
    ['same character identity','same face','same hairstyle','same clothing','same footwear','same body proportions','same color palette']);
  assert.deepEqual(turnaround.promptIr.characterTurnaround.allowedVariation,['camera orientation','body orientation']);
  assert.deepEqual(turnaround.promptIr.characterTurnaround.forbiddenChanges,
    ['no redesign between views','no clothing changes','no hairstyle changes','no age changes','no body proportion changes','no extra accessories']);
  for(const view of ['FRONT','LEFT_PROFILE','BACK','THREE_QUARTER']) assert.ok(turnaround.renderedPrompt.text.includes(view));
  for(const rule of [...turnaround.promptIr.characterTurnaround.identityLock,...turnaround.promptIr.characterTurnaround.forbiddenChanges,
    'Only camera orientation and body orientation may vary between views']) assert.ok(turnaround.renderedPrompt.text.includes(rule),rule);
  assert.deepEqual(turnaround.renderedPrompt.views.map(view=>view.orientation),['FRONT','LEFT_PROFILE','BACK','THREE_QUARTER']);
  assert.ok(turnaround.renderedPrompt.views.every(view=>view.text.includes('Shared Identity Lock across all views')));
  const agentContext=loadSource(path.join(root,'src/v04/agentContext.ts'),db,cache,oss);
  const context=await agentContext.buildProjectAgentContext({...scope,currentStage:'creative',currentRoute:'pilot/creative',selectedObject:null},'Boy visual appearance');
  assert.equal(context.assetBibleIndex[0].visualSpecRevision,1);
  assert.equal(context.assetBibleIndex[0].promptStatus,'READY');
  assert.equal('visualSpec' in context.assetBibleIndex[0],false,'always-on index stays compact');
  assert.equal(context.relevantAssets[0].visualSpec.visualIdentitySummary,'Young dreamer with a blue coat');
  assert.deepEqual(confirmed.promptBuilds[0].promptIr.viewIntent.map(v=>v.orientation),['FRONT','LEFT_PROFILE','BACK','THREE_QUARTER']);
  assert.ok(confirmed.promptBuilds[0].promptIr.viewIntent.every(v=>v.identityInvariant==='CHAR-001'));
  await db('o_v04AssetPromptBuild').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).update({compilerVersion:'v04.prompt-ir.1'});
  assert.equal((await s.readPilot(scope)).promptBuilds[0].effectiveStatus,'STALE','pre-hotfix character Prompt must be rebuilt');
  const rebuilt=await visual.rebuildVisualPrompt({...scope,canonicalKey:'CHAR-001'});
  assert.equal(rebuilt.promptBuild.compilerVersion,'v04.prompt-ir.2');
  assert.equal((await s.readPilot(scope)).promptBuilds.find(row=>row.compilerVersion==='v04.prompt-ir.2').effectiveStatus,'READY');
  assert.equal((await s.readPilot(other)).visualSpecs.length,0);
  await assert.rejects(visual.previewVisualSpec({...other,canonicalKey:'CHAR-001',sourceAssetRevision:applied.sourceAssetRevision,spec:body.spec}),e=>e.code==='PILOT_VISUAL_SCOPE_INVALID');
  await assert.rejects(visual.applyVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:body.sourceAssetRevision,spec:body.spec,previewHash:preview.previewHash}),e=>e.code==='PILOT_VISUAL_SOURCE_STALE');
  const second={...body.spec,visualIdentitySummary:'Same boy, refined face'};
  const p2=await visual.previewVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:applied.sourceAssetRevision,spec:second});
  await visual.applyVisualSpec({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:applied.sourceAssetRevision,spec:second,previewHash:p2.previewHash});
  assert.deepEqual((await db('o_v04AssetVisualSpec').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).orderBy('revision')).map(r=>r.status),['SUPERSEDED','CONFIRMED']);
  assert.equal((await db('o_v04AssetPromptBuild').where({projectId:scope.projectId,canonicalKey:'CHAR-001',visualSpecRevision:1}).first()).status,'STALE');
  const edit=[{operation:'EDIT',canonicalKey:'CHAR-001',expectedRevision:applied.sourceAssetRevision,patch:{name:'Older boy'}}];
  const ep=await s.previewAssets({...scope,changes:edit});await s.applyAssets({...scope,changes:edit,previewHash:ep.previewHash});
  const stale=await s.readPilot(scope);
  assert.equal(stale.visualSpecs[0].effectiveStatus,'STALE');
  assert.ok(stale.promptBuilds.every(r=>r.effectiveStatus==='STALE'));
});

test('OPT-027A kind-specific compiler preserves Material states, empty environments, embedded elements and real-reference boundary', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const compiler=loadSource(path.join(root,'src/v04/promptCompiler.ts'),db,cache,oss);
  const visual=loadSource(path.join(root,'src/v04/visualSpec.ts'),db,cache,oss);
  const base={name:'Example',description:'Stable visual identity',identityAnchors:['same shape'],mustPreserve:['same color'],forbiddenChanges:['redesign']};
  for(const kind of ['HUMAN_CHARACTER','CREATURE','VEHICLE','PROP','ENVIRONMENT','MATERIAL_FX','CELESTIAL','OTHER']){
    const spec=contract.compileVisualSemantic({...base,assetKind:kind},{visualIdentitySummary:'Distinct form',embeddedElements:[{name:'Moon pendant',placement:'neck',promotionRecommendation:'HIGH'}]});
    assert.equal(contract.visualSpecSchema.parse(spec).assetKind,kind);
    assert.equal(spec.embeddedElements[0].promotionRecommendation,'HIGH');
    const intent=compiler.intentFromReviewPlan({assetKind:kind,sourcePolicy:'AI_ALLOWED'},{previewKind:'ESTABLISHING'});
    const ir=compiler.compilePromptIR({canonicalKey:'CHAR-001',name:'Example',description:'',ownerKey:'CHAR-999'},spec,intent);
    assert.equal(ir.compilerVersion,compiler.compilerVersionForIntent(intent));
    if(kind!=='HUMAN_CHARACTER'){
      assert.equal(ir.compilerVersion,compiler.PROMPT_COMPILER_VERSION);
      assert.equal('characterTurnaround' in ir,false,'other generation intents keep their original IR');
    }
    assert.equal(ir.identityBlock.ownerKey,'CHAR-999');
    assert.ok(!JSON.stringify(ir).includes('CHAR-999 prompt'), 'parent is never recursively expanded');
    assert.equal(compiler.renderGenericPrompt(ir).adapter,'generic.text.v1');
    if(kind==='ENVIRONMENT')assert.equal(ir.environmentBlock.emptyCanonicalReference,true);
    if(kind==='MATERIAL_FX')assert.deepEqual(ir.compositionIntent.states.map(s=>s.key),['MIST','PARTICLE','SILHOUETTE','SOLID']);
  }
  const scope=await s.createPilotProject({name:'Real reference',brief:'Official mark',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'brand',asset:{...asset('Official logo','BRAND','REAL_REQUIRED'),assetKind:'BRAND_MARK'}}];
  const p=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:p.previewHash});
  await assert.rejects(visual.proposeVisualSpecs({...scope,canonicalKeys:['BRAND-001']}),e=>e.code==='PILOT_VISUAL_REAL_REFERENCE_REQUIRED');
  await db('o_v04AgentAttachment').insert({id:'attachment-1',projectId:scope.projectId,scriptId:scope.scriptId,messageId:null,contextJson:'{}',filePath:'/safe.png',originalName:'official.png',mimeType:'image/png',bytes:12,sha256:'a'.repeat(64),purpose:'CONVERSATIONAL_REFERENCE',createdAt:1});
  await db('o_v04AgentReference').insert({id:'reference-1',projectId:scope.projectId,scriptId:scope.scriptId,attachmentId:'attachment-1',targetType:'ASSET_BIBLE',targetKey:'BRAND-001',assetId:null,createdAt:2});
  await db('o_v04VisionAnalysis').insert({attachmentId:'attachment-1',modelFingerprint:'local-vision',analysisVersion:1,observationJson:JSON.stringify({summary:'Blue official wordmark',uncertainty:['fine text requires human verification']}),createdAt:3});
  const proposal=await visual.proposeVisualSpecs({...scope,canonicalKeys:['BRAND-001']});
  assert.equal(oss.modelCalls.length,0,'real brand proposal does not call a model');
  assert.equal(proposal.candidates[0].spec.details.aiRedrawAllowed,false);
  assert.deepEqual(proposal.candidates[0].spec.details.referenceAttachmentIds,['attachment-1']);
  assert.equal(proposal.candidates[0].spec.details.observedReferenceNotes[0].summary,'Blue official wordmark');
  const bp=await visual.previewVisualSpec({...scope,canonicalKey:'BRAND-001',sourceAssetRevision:1,spec:proposal.candidates[0].spec});
  const applied=await visual.applyVisualSpec({...scope,canonicalKey:'BRAND-001',sourceAssetRevision:1,spec:proposal.candidates[0].spec,previewHash:bp.previewHash});
  assert.equal(applied.promptStatus,'REFERENCE_ONLY');
  assert.equal((await db('o_v04AssetPromptBuild').where({projectId:scope.projectId}).count({n:'canonicalKey'}).first()).n,0);
  await assert.rejects(visual.rebuildVisualPrompt({...scope,canonicalKey:'BRAND-001'}),e=>e.code==='PILOT_VISUAL_REFERENCE_ONLY');
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId}).count({n:'canonicalKey'}).first()).n,1,'embedded elements do not auto-promote');
});

test('OPT-027A-HOTFIX-02 MATERIAL_FX semantic states compile into one strict ordered four-state spec', async t => {
  const {db,oss,cache}=await fixture(t);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const asset={assetKind:'MATERIAL_FX',name:'Dream Matter',description:'Blue fluorescent matter moves from mist to particles, contour and solid form',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]};
  const base={visualIdentitySummary:'One continuous dream material',silhouette:'A changing blue luminous form',primaryPalette:['blue'],
    details:{baseColor:'blue',emissionColor:'cyan',particleLanguage:'fine glowing grains',edgeLanguage:'soft luminous outline'}};
  const cases=[
    {name:'four out of order',states:[{key:'SOLID',appearance:'solid A'},{key:'MIST',appearance:'mist A'},{key:'SILHOUETTE',appearance:'contour A'},{key:'PARTICLE',appearance:'particle A'}],expected:['mist A','particle A','contour A','solid A']},
    {name:'three states',states:[{key:'mist',appearance:'mist B'},{key:'particle',appearance:'particle B'},{key:'solid',appearance:'solid B'}],expected:['mist B','particle B',null,'solid B']},
    {name:'natural language labels',states:[{key:'final form',description:'solid C'},{key:'fog',description:'mist C'},{key:'emerging form',description:'contour C'},{key:'condensation',description:'particle C'}],expected:['mist C','particle C','contour C','solid C']},
    {name:'appearance without keys and out of order',states:[{description:'solid D'},{appearance:'particle D'},{description:'mist D'},{appearance:'contour D'}],expected:['mist D','particle D','contour D','solid D']},
    {name:'extra unknown state',states:[{key:'fog',appearance:'mist E'},{key:'particles',appearance:'particle E'},{key:'outline',appearance:'contour E'},{key:'manifested',appearance:'solid E'},{key:'liquid',appearance:'unrelated E'}],expected:['mist E','particle E','contour E','solid E']},
  ];
  for(const scenario of cases){
    const spec=contract.compileVisualSemantic(asset,{...base,details:{...base.details,states:scenario.states}});
    assert.equal(contract.visualSpecSchema.parse(spec).assetKind,'MATERIAL_FX',scenario.name);
    assert.deepEqual(spec.details.states.map(state=>state.key),['MIST','PARTICLE','SILHOUETTE','SOLID'],scenario.name);
    scenario.expected.forEach((appearance,index)=>appearance===null
      ? assert.match(spec.details.states[index].appearance,/Dream Matter.*Blue fluorescent matter/,scenario.name)
      : assert.equal(spec.details.states[index].appearance,appearance,scenario.name));
    assert.equal(spec.details.transitionRules.length,1,scenario.name);
    assert.equal(spec.details.interactionRules.length,1,scenario.name);
    assert.equal(spec.details.manifestationRules.length,1,scenario.name);
  }
  const strict=contract.compileVisualSemantic(asset,{...base,details:{...base.details,states:[]}});
  assert.throws(()=>contract.visualSpecSchema.parse({...strict,details:{...strict.details,states:[...strict.details.states,strict.details.states[0]]}}),'canonical validation still rejects extra states');
});

test('Visual Semantic Ingress compiles clean, dirty, minimal and mixed payloads for every AI asset kind', async t => {
  const {db,oss,cache}=await fixture(t);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const kindDetails={
    HUMAN_CHARACTER:{faceShape:'round',hairColor:'black',bodyBuild:'slim',wardrobeUpper:'blue coat',footwear:'赤足或软底鞋',expressionRange:'curious',embeddedElements:'ignored'},
    CREATURE:{species:'whale',bodyStructure:'large whale',skin:'blue skin',movement:'swimming'},
    VEHICLE:{type:'pirate ship',silhouette:'curved hull',structure:'wooden frame',surface:'weathered'},
    PROP:{type:'compass',construction:'brass casing',purpose:'navigation'},
    ENVIRONMENT:{spaceType:'island',foreground:'shore',midground:'trees',background:'sea',lighting:'moonlight',atmosphere:'quiet',architectureOrNaturalForms:'rock arch',recurringAnchors:['moon',null,17],emptyEnvironmentPolicy:'空场景'},
    MATERIAL_FX:{baseColor:'blue',emissionColor:'cyan',states:[{key:'solid form',appearance:'solid'},{key:'fog',appearance:'mist'}],transitionRules:null},
    CELESTIAL:{form:'moon',surface:'silver glow',palette:'silver blue',role:'final composition'},
    OTHER:{type:'keepsake',construction:'wood',function:'reminder'},
  };
  for(const [kind,details] of Object.entries(kindDetails)){
    const identity={assetKind:kind,name:'Example',description:'Known visual identity',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]};
    const shapes=[
      {visualIdentitySummary:'Example identity',primaryPalette:['blue'],details:contract.visualDetailTemplate(kind)},
      {result:{visualIdentitySummary:'Example identity',primaryPalette:'blue',materials:null,details,
        embeddedElements:[{name:'Moon pendant',placement:'neck',continuityImportance:'high',promotionRecommendation:'高'},{name:'',placement:''}]}},
      {visualSpec:{details:{}}},
      [{visualIdentitySummary:'Example identity',primaryPalette:['blue',null,5],distinctiveFeatures:'glowing',details:{...details,unknownProviderField:'ignored'},irrelevant:'ignored'}],
    ];
    for(const raw of shapes){
      const result=contract.compileVisualSemanticWithDiagnostics(identity,raw);
      assert.equal(contract.visualSpecSchema.parse(result.spec).assetKind,kind);
      assert.equal(result.spec.assetKind,kind);
      assert.ok(Array.isArray(result.normalizationWarnings));
    }
  }
  const human={assetKind:'HUMAN_CHARACTER',name:'Boy',description:'Dreamer',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]};
  const proposed=contract.compileVisualSemanticWithDiagnostics(human,{details:kindDetails.HUMAN_CHARACTER,
    embeddedElements:[{name:'Moon pendant',placement:'neck',continuityImportance:'high',promotionRecommendation:'高'},{name:'Nameless',placement:''}]});
  assert.equal(proposed.spec.details.face.faceShape,'round');
  assert.equal(proposed.spec.details.hair.color,'black');
  assert.equal(proposed.spec.details.body.build,'slim');
  assert.equal(proposed.spec.embeddedElements.length,1,'unplaced human accessory is not made canonical-looking');
  assert.equal(proposed.spec.embeddedElements[0].promotionRecommendation,'HIGH');
  assert.deepEqual(proposed.qualityWarnings,[{path:'details.footwear',code:'AMBIGUOUS_IDENTITY_VALUE'}]);
  const env={assetKind:'ENVIRONMENT',name:'Island',description:'Night island',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]};
  const environment=contract.compileVisualSemanticWithDiagnostics(env,{details:kindDetails.ENVIRONMENT});
  assert.equal(environment.spec.details.emptyEnvironmentPolicy,'EMPTY_CANONICAL_REFERENCE');
  assert.deepEqual(environment.spec.details.architectureOrNaturalForms,['rock arch']);
  assert.deepEqual(environment.spec.details.recurringAnchors,['moon']);
  assert.throws(()=>contract.compileVisualSemantic(human,[]),error=>error.code==='SEMANTIC_ROOT_INVALID');
  assert.throws(()=>contract.compileVisualSemantic(human,[{},{}]),error=>error.code==='SEMANTIC_ROOT_INVALID');
});

test('Visual Spec batch preserves five zero-write candidates when the sixth semantic root fails and permits one-item retry', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const visual=loadSource(path.join(root,'src/v04/visualSpec.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Visual batch',brief:'Six visual identities',targetDuration:40,aspectRatio:'16:9'},7);
  const changes=Array.from({length:6},(_,index)=>({operation:'ADD',clientRef:`item-${index}`,asset:{...asset(`Boy ${index}`),assetKind:'HUMAN_CHARACTER'}}));
  const preview=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:preview.previewHash});
  const semantic={visualIdentitySummary:'Blue-coated boy',silhouette:'small child',primaryPalette:'blue',details:{faceShape:'round',hairColor:'black',bodyBuild:'slim',wardrobeUpper:'blue coat',footwear:'canvas shoes'}};
  oss.skillResponses=[semantic,semantic,semantic,semantic,semantic,[]];
  const keys=Array.from({length:6},(_,index)=>`CHAR-${String(index+1).padStart(3,'0')}`);
  const result=await visual.proposeVisualSpecs({...scope,canonicalKeys:keys});
  assert.equal(result.candidates.length,5);assert.equal(result.failures.length,1);
  assert.equal(result.failures[0].canonicalKey,keys[5]);
  assert.equal(result.failures[0].code,'PILOT_VISUAL_SEMANTIC_ROOT_INVALID');
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
  assert.equal((await db('o_v04AssetPromptBuild').count({n:'canonicalKey'}).first()).n,0);
  oss.skillResponses=[semantic];
  const retry=await visual.proposeVisualSpecs({...scope,canonicalKeys:[keys[5]]});
  assert.equal(retry.candidates.length,1);assert.deepEqual(retry.failures,[]);
  const missing=await visual.previewVisualSpec({...scope,canonicalKey:keys[5],sourceAssetRevision:retry.candidates[0].sourceAssetRevision,spec:retry.candidates[0].spec});
  assert.ok(missing.issues.includes('details.hair.silhouette'),'missing creative detail is reviewed rather than invented or rejected as structure');
  await assert.rejects(visual.applyVisualSpec({...scope,canonicalKey:keys[5],sourceAssetRevision:retry.candidates[0].sourceAssetRevision,spec:retry.candidates[0].spec,previewHash:missing.previewHash}),error=>error.code==='PILOT_VISUAL_INCOMPLETE');
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
});

test('OPT-027A future library binding pins version without allocating a global identity or changing project key', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const visual=loadSource(path.join(root,'src/v04/visualSpec.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Library foundation',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'asset',asset:asset()}];const p=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:p.previewHash});
  assert.equal((await db('o_v04AssetLibraryBinding').where({projectId:scope.projectId}).count({n:'canonicalKey'}).first()).n,0);
  await assert.rejects(visual.setLibraryBinding({...scope,canonicalKey:'CHAR-001',libraryAssetId:'LIB-1',libraryVersion:null,visualProfileId:null,visualProfileVersion:null,reuseMode:'EXACT_REUSE'}),e=>e.code==='PILOT_LIBRARY_PIN_INVALID');
  const binding=await visual.setLibraryBinding({...scope,canonicalKey:'CHAR-001',libraryAssetId:'LIB-1',libraryVersion:3,visualProfileId:'cinematic',visualProfileVersion:2,reuseMode:'VARIANT'});
  assert.equal(binding.globalIdentityCreated,false);
  assert.equal((await s.readPilot(scope)).assets[0].canonicalKey,'CHAR-001');
  assert.equal((await s.readPilot(scope)).libraryBindings[0].libraryVersion,3);
  await visual.setLibraryBinding({...scope,canonicalKey:'CHAR-001',libraryAssetId:null,libraryVersion:null,visualProfileId:null,visualProfileVersion:null,reuseMode:null});
  assert.equal((await s.readPilot(scope)).libraryBindings[0].libraryAssetId,null,'binding may be explicitly cleared without changing project identity');
  const other=await s.createPilotProject({name:'Other',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  assert.equal((await s.readPilot(other)).libraryBindings.length,0);
});

test('OPT-027A authenticated HTTP proposal and preview remain read-only until human apply', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const scope=await s.createPilotProject({name:'Visual HTTP',brief:'A glowing material',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'matter',asset:{...asset('Dream material','FX'),assetKind:'MATERIAL_FX'}}];
  const p=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:p.previewHash});
  const express=require('express');const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:7};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v04${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,payload:await response.json()};};
  oss.proposalOutput={visualIdentitySummary:'One blue glowing material',silhouette:'fine moving cloud',primaryPalette:['blue'],details:{baseColor:'blue',emissionColor:'violet',particleLanguage:'fine grains',edgeLanguage:'soft luminous edge',states:[{key:'Solid Form',appearance:'solid form'},{key:'Mist',appearance:'thin mist'},{key:'Particles',appearance:'dense particles'}]}};
  const proposed=await post('/visual-spec/propose',{...scope,canonicalKeys:['FX-001']});
  assert.equal(proposed.status,200);
  const candidate=proposed.payload.data.candidates[0];
  assert.deepEqual(candidate.spec.details.states.map(state=>state.key),['MIST','PARTICLE','SILHOUETTE','SOLID']);
  assert.match(candidate.spec.details.states[2].appearance,/Dream material/);
  const draftPrompt=await post('/visual-spec/draft-prompts',{...scope,items:[{canonicalKey:'FX-001',sourceAssetRevision:candidate.sourceAssetRevision,spec:candidate.spec}]});
  assert.equal(draftPrompt.status,200);assert.equal(draftPrompt.payload.data.candidates[0].generationIntent,'MATERIAL_STATE_BOARD');
  assert.equal(draftPrompt.payload.data.applied,false);
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
  assert.equal((await db('o_v04AssetPromptBuild').count({n:'canonicalKey'}).first()).n,0);
  const input={...scope,canonicalKey:'FX-001',sourceAssetRevision:candidate.sourceAssetRevision,spec:candidate.spec};
  const preview=await post('/visual-spec/preview',input);
  assert.equal(preview.status,200);assert.deepEqual(preview.payload.data.issues,[]);
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
  assert.equal((await db('o_v04AssetPromptBuild').count({n:'canonicalKey'}).first()).n,0);
  const applied=await post('/visual-spec/apply',{...input,previewHash:preview.payload.data.previewHash});
  assert.equal(applied.status,200);assert.equal(applied.payload.data.promptStatus,'READY');
  assert.equal((await s.readPilot(scope)).promptBuilds[0].generationIntent,'MATERIAL_STATE_BOARD');
});

test('OPT-031 Studio draft Prompt compiles against unconfirmed Visual Spec without truth writes', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const visual=loadSource(path.join(root,'src/v04/visualSpec.ts'),db,cache,oss);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Studio drafts',brief:'One boy',targetDuration:30,aspectRatio:'16:9'},7);
  const foreign=await s.createPilotProject({name:'Foreign',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'boy',asset:{...asset('Boy'),assetKind:'HUMAN_CHARACTER',importance:'CORE'}}];
  const preview=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:preview.previewHash});
  const spec=contract.compileVisualSemantic({name:'Boy',description:'calm',assetKind:'HUMAN_CHARACTER',identityAnchors:['scar'],mustPreserve:['scar'],forbiddenChanges:[]},
    {visualIdentitySummary:'Boy with blue coat',silhouette:'small boy',primaryPalette:['blue'],details:{ageRange:'8-10',footwear:'canvas shoes',hair:{color:'black',silhouette:'short'},body:{build:'slim'},wardrobe:{upper:'blue coat'}}});
  const beforeAsset=await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first();
  const input={...scope,items:[{canonicalKey:'CHAR-001',sourceAssetRevision:1,spec}]};
  const result=await visual.compileStudioDraftPrompts(input);
  assert.equal(result.candidates.length,1);assert.equal(result.failures.length,0);
  assert.equal(result.candidates[0].generationIntent,'CHARACTER_TURNAROUND');
  assert.deepEqual(result.candidates[0].draftPromptIR.viewIntent.map(v=>v.orientation),['FRONT','LEFT_PROFILE','BACK','THREE_QUARTER']);
  assert.ok(result.candidates[0].draftRenderedPrompt.text.includes('same face'));
  assert.equal(result.candidates[0].applied,false);
  assert.equal((await db('o_v04AssetVisualSpec').count({n:'revision'}).first()).n,0);
  assert.equal((await db('o_v04AssetPromptBuild').count({n:'canonicalKey'}).first()).n,0);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).first(),beforeAsset);
  const cross=await visual.compileStudioDraftPrompts({...foreign,items:input.items});
  assert.equal(cross.candidates.length,0);assert.equal(cross.failures[0].code,'PILOT_VISUAL_SCOPE_INVALID');
  const stale=await visual.compileStudioDraftPrompts({...scope,items:[{...input.items[0],sourceAssetRevision:2}]});
  assert.equal(stale.failures[0].code,'PILOT_VISUAL_SOURCE_STALE');
  assert.equal(oss.modelCalls.length,0,'draft compilation never calls the provider');
});

test('OPT-031 explicit Studio ASSET_CREATE stays proposal-only until existing Asset Preview and Apply', async t => {
  const {db,oss,cache,service:s}=await fixture(t);
  const studio=loadSource(path.join(root,'src/v04/studioTurn.ts'),db,cache,oss);
  const scope=await s.createPilotProject({name:'Asset create',brief:'Boy with pendant',targetDuration:30,aspectRatio:'16:9'},7);
  const foreign=await s.createPilotProject({name:'Other scope',brief:'',targetDuration:30,aspectRatio:'16:9'},7);
  const changes=[{operation:'ADD',clientRef:'boy',asset:{...asset('Boy'),assetKind:'HUMAN_CHARACTER'}}];
  const first=await s.previewAssets({...scope,changes});await s.applyAssets({...scope,changes,previewHash:first.previewHash});
  const before=await db('o_v04Asset').where({projectId:scope.projectId}).orderBy('canonicalKey');
  oss.studioResponses=[JSON.stringify({mode:'ASSET_CREATE',reply:'可以讨论挂件造型。',
    summary:'未经请求新增素材',rationale:'模型误判',asset:{name:'月牙挂件',category:'ACC'}})];
  const unrelated=await studio.answerStudioTurn({context:{...scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}},
    message:'月牙挂件的造型适合这个角色吗？'});
  assert.equal(unrelated.applied,false);
  assert.equal(unrelated.actionProposal,undefined,'generic discussion cannot produce an independent asset proposal');
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}).orderBy('canonicalKey'),before);
  oss.studioResponses=[JSON.stringify({mode:'ASSET_CREATE',reply:'可以把月牙挂件作为独立素材，先请你预览确认。',
    summary:'新增月牙挂件',rationale:'作为男孩的可识别随身物',asset:{name:'月牙挂件',category:'ACC',assetKind:'PROP',description:'Small crescent pendant',sourcePolicy:'AI_ALLOWED',relatedKeys:['CHAR-001']}})];
  const turn=await studio.answerStudioTurn({context:{...scope,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:'CHAR-001'}},
    message:'给这个男孩增加一个具有识别性的月牙挂件，作为独立资产。'});
  assert.equal(turn.mode,'ASSET_CREATE');assert.equal(turn.applied,false);
  assert.equal(turn.actionProposal.targetType,'ASSET_CREATE');
  assert.equal(turn.actionProposal.proposal.operation,'ADD');
  assert.equal(turn.actionProposal.proposal.asset.ownerKey,'CHAR-001');
  assert.deepEqual(turn.actionProposal.proposal.asset.relatedKeys,['CHAR-001']);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}).orderBy('canonicalKey'),before,'agent proposal/preview are zero-write');
  const body={...scope,sourceCreativeVersion:turn.actionProposal.sourceCreativeVersion,changes:[turn.actionProposal.proposal]};
  const preview=await s.previewAssets(body);
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}).orderBy('canonicalKey'),before,'human preview is zero-write');
  await assert.rejects(s.applyAssets({...body,previewHash:'0'.repeat(64)}),error=>error.code==='PILOT_PREVIEW_STALE');
  assert.deepEqual(await db('o_v04Asset').where({projectId:scope.projectId}).orderBy('canonicalKey'),before,'failed apply creates no identity');
  const applied=await s.applyAssets({...body,previewHash:preview.previewHash});
  assert.deepEqual(applied.applied.map(row=>row.canonicalKey),['ACC-001']);
  const created=await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'ACC-001'}).first();
  assert.equal(created.ownerKey,'CHAR-001');
  await assert.rejects(s.applyAssets({...body,previewHash:preview.previewHash}),error=>error.code==='PILOT_PREVIEW_STALE');
  assert.equal((await db('o_v04Asset').where({projectId:scope.projectId,category:'ACC'})).length,1,'stale replay cannot duplicate the identity');
  await assert.rejects(s.previewAssets({...foreign,sourceCreativeVersion:turn.actionProposal.sourceCreativeVersion,changes:[turn.actionProposal.proposal]}),
    error=>['PILOT_RELATION_INVALID','PILOT_SOURCE_STALE'].includes(error.code));
  assert.equal(oss.modelCalls.filter(call=>call.method==='invokeText').length,2);
});

test('OPT-028 draft executor persists one scoped Comfy job and private artifact without confirming Visual Spec', async t => {
  const {db,cache,oss,service}=await fixture(t);
  const http=require('node:http');
  const sharp=require('sharp');
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#3659ad'}}).png().toBuffer();
  let submissions=0,holdHistory=false,waitingHistory=[];
  const comfy=http.createServer((req,res)=>{
    res.setHeader('content-type',req.url.startsWith('/view')?'image/png':'application/json');
    if(req.url==='/system_stats')return res.end(JSON.stringify({system:{comfyui_version:'test'}}));
    if(req.url==='/object_info')return res.end(JSON.stringify({CheckpointLoaderSimple:{input:{required:{ckpt_name:[['test.safetensors']]}}},CLIPTextEncode:{},EmptyLatentImage:{},KSampler:{},VAEDecode:{},SaveImage:{}}));
    if(req.url==='/prompt'){submissions++;return res.end(JSON.stringify({prompt_id:'test-prompt',node_errors:{}}));}
    if(req.url==='/history/test-prompt'){const respond=()=>res.end(JSON.stringify({'test-prompt':{status:{completed:true},outputs:{'7':{images:[{filename:'draft.png',subfolder:'',type:'output'}]}}}}));if(holdHistory)waitingHistory.push(respond);else respond();return;}
    if(req.url.startsWith('/view'))return res.end(png);
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>comfy.listen(0,'127.0.0.1',resolve));
  t.after(()=>comfy.close());
  const image=loadSource(path.join(root,'src/v04/studioDraftImage.ts'),db,cache,oss);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const scope=await service.createPilotProject({name:'Draft test',brief:'Boy on the island',targetDuration:30,aspectRatio:'16:9'},7);
  await db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey:'CHAR-001',category:'CHAR',name:'Boy',description:'Small boy in blue coat',
    sourcePolicy:'AI_ALLOWED',assetKind:'HUMAN_CHARACTER',importance:'CORE',status:'ACTIVE',revision:1,createdAt:Date.now(),updatedAt:Date.now()});
  const spec=contract.compileVisualSemantic({assetKind:'HUMAN_CHARACTER',name:'Boy',description:'Small boy in blue coat',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]},
    {visualIdentitySummary:'Small boy in blue coat',silhouette:'child',primaryPalette:['blue'],details:{ageRange:'8–10',footwear:'shoes',hair:{color:'black',silhouette:'short'},body:{build:'slim'},wardrobe:{upper:'blue coat'}}});
  const baseUrl=`http://127.0.0.1:${comfy.address().port}`;
  assert.equal((await image.testDraftExecutor({projectId:scope.projectId,baseUrl})).status,'CONNECTED');
  await image.configureDraftExecutor({projectId:scope.projectId,baseUrl,checkpoint:'test.safetensors',enabled:true});
  const input={...scope,canonicalKey:'CHAR-001',sourceAssetRevision:1,visualSpecDraft:spec};
  const first=await image.enqueueDraftImage(input);
  const second=await image.enqueueDraftImage(input);
  assert.equal(second.reused,true);
  assert.equal(second.job.id,first.job.id);
  for(let i=0;i<80;i++){
    const row=await db('o_v04StudioAssetDraftJob').where({id:first.job.id}).first();
    if(row.status==='SUCCEEDED')break;
    if(row.status==='FAILED')assert.fail(row.errorCode+' '+row.errorMessage);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const row=await db('o_v04StudioAssetDraftJob').where({id:first.job.id}).first();
  assert.equal(row.status,'SUCCEEDED');
  const legacySnapshot=JSON.parse(row.inputSnapshotJson);
  assert.equal(row.draftHash,require('node:crypto').createHash('sha256').update(JSON.stringify([
    legacySnapshot.visualSpecDraft,legacySnapshot.draftPromptIR,legacySnapshot.generationIntent,
    legacySnapshot.draftPromptIR.referenceBindings,row.executorProfile,row.workflowVersion,
    legacySnapshot.checkpoint,legacySnapshot.baseUrl])).digest('hex'),'old NULL-purpose hash bytes preserved');
  assert.equal(submissions,1);
  const artifact=JSON.parse(row.outputsJson)[0];
  assert.equal(artifact.role,'TURNAROUND_SHEET');
  assert.deepEqual((await image.getDraftArtifact(scope.projectId,artifact.artifactId)).bytes,png);
  await assert.rejects(image.getDraftArtifact(scope.projectId+1,artifact.artifactId),error=>error.code==='ARTIFACT_MISSING');
  const express=require('express');
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:Number(req.headers['x-test-user']||7)};next();});
  app.use('/api/v04',loadSource(path.join(root,'src/v04/router.ts'),db,cache,oss).default);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>server.close());
  const artifactUrl=`http://127.0.0.1:${server.address().port}${artifact.fileRef}`;
  const allowed=await fetch(artifactUrl,{headers:{'x-test-user':'7'}});
  assert.equal(allowed.status,200);assert.equal(allowed.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()),png);
  assert.equal((await fetch(artifactUrl,{headers:{'x-test-user':'8'}})).status,403);
  assert.equal((await db('o_v04AssetVisualSpec')).length,0);
  assert.equal((await db('o_v04AssetPromptBuild')).length,0);
  const retry=await image.enqueueDraftImage({...input,force:true});
  assert.notEqual(retry.job.id,first.job.id);
  assert.equal((await db('o_v04StudioAssetDraftJob').where({id:first.job.id}).first()).status,'STALE');
  for(let i=0;i<80;i++){
    const status=(await db('o_v04StudioAssetDraftJob').where({id:retry.job.id}).first()).status;
    if(['SUCCEEDED','FAILED','STALE'].includes(status))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  // Reference purposes share the producer, but never supersede other purposes or legacy NULL.
  const settled=async job=>{for(let i=0;i<100;i++){const r=await db('o_v04StudioAssetDraftJob').where({id:job.id}).first();if(['SUCCEEDED','FAILED','STALE'].includes(r.status))return r;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail('job did not settle');};
  const face=await image.enqueueDraftImage({...input,executionPurpose:'FACE_HERO'});
  assert.equal((await settled(face.job)).status,'SUCCEEDED');
  const front=await image.enqueueDraftImage({...input,executionPurpose:'FULL_BODY_FRONT'});
  const back=await image.enqueueDraftImage({...input,executionPurpose:'FULL_BODY_BACK'});
  assert.equal((await settled(front.job)).status,'SUCCEEDED');assert.equal((await settled(back.job)).status,'SUCCEEDED');
  assert.equal((await db('o_v04StudioAssetDraftJob').where({id:face.job.id}).first()).status,'SUCCEEDED');
  assert.equal((await db('o_v04StudioAssetDraftJob').where({id:retry.job.id}).first()).status,'SUCCEEDED','legacy NULL not superseded');
  assert.equal((await db('o_v04StudioAssetDraftJob').where({id:retry.job.id}).first()).executionPurpose,null);
  assert.notEqual(face.job.draftHash,front.job.draftHash);
  assert.equal((await image.enqueueDraftImage({...input,executionPurpose:'FACE_HERO'})).job.id,face.job.id);
  const face2=await image.enqueueDraftImage({...input,executionPurpose:'FACE_HERO',force:true});
  assert.equal((await settled(face2.job)).status,'SUCCEEDED');
  assert.equal((await db('o_v04StudioAssetDraftJob').where({id:face.job.id}).first()).status,'STALE');
  for(const j of [front.job,back.job])assert.equal((await db('o_v04StudioAssetDraftJob').where({id:j.id}).first()).status,'SUCCEEDED');
  for(const j of [face2.job,front.job,back.job]){const r=await db('o_v04StudioAssetDraftJob').where({id:j.id}).first();assert.equal(JSON.parse(r.outputsJson)[0].role,r.executionPurpose);}
  holdHistory=true;
  const late=await image.enqueueDraftImage({...input,executionPurpose:'FACE_HERO',force:true});
  for(let i=0;i<100&&!waitingHistory.length;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(waitingHistory.length,'producer is held after submit');
  const replacement=await image.enqueueDraftImage({...input,executionPurpose:'FACE_HERO',force:true});
  holdHistory=false;for(const release of waitingHistory.splice(0))release();
  assert.equal((await settled(replacement.job)).status,'SUCCEEDED');
  const stale=await db('o_v04StudioAssetDraftJob').where({id:late.job.id}).first();
  assert.equal(stale.status,'STALE');assert.equal(JSON.parse(stale.outputsJson).length,1,'late output preserved, never restored success');
  const schema=loadSource(path.join(root,'src/v04/schema.ts'),db,cache,oss);
  await schema.initializeV04Schema(db);await schema.initializeV04Schema(db);
  assert.equal(await db.schema.hasColumn('o_v04StudioAssetDraftJob','executionPurpose'),true);
  assert.equal((await db('o_v04StudioAssetDraftJob').where({id:retry.job.id}).first()).executionPurpose,null,'migration never backfills legacy purposes');
  assert.equal((await db('o_v04AssetVisualSpec')).length,0);assert.equal((await db('o_v04AssetPromptBuild')).length,0);
  await db('o_v04Asset').where({projectId:scope.projectId,canonicalKey:'CHAR-001'}).update({sourcePolicy:'REAL_REQUIRED'});
  await assert.rejects(image.enqueueDraftImage(input),error=>error.code==='PILOT_VISUAL_REFERENCE_ONLY');
});

test('Reference Pack optional spec, derived routing and unchanged turnaround',()=>{
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),null);
  const pack=loadSource(path.join(root,'src/v04/characterReferencePack.ts'),null);
  const compiler=loadSource(path.join(root,'src/v04/promptCompiler.ts'),null);
  const asset={canonicalKey:'CHAR-001',assetKind:'HUMAN_CHARACTER',name:'Boy',description:'Boy',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]};
  const spec=contract.compileVisualSemantic(asset,{});assert.deepEqual(spec.referencePlan.required,['FACE_HERO','FULL_BODY_FRONT']);
  const old={...spec};delete old.referencePlan;const bytes=JSON.stringify(old);
  assert.deepEqual(contract.visualSpecSchema.parse(old),old);assert.equal(JSON.stringify(old),bytes);
  assert.equal(pack.resolveCharacterReferencePlan(old).recommended[0],'FULL_BODY_BACK');
  assert.equal(pack.deriveCharacterReferenceIntent(old).identityAuthority,'FACE_HERO');
  const ir=compiler.compilePromptIR(asset,old,'CHARACTER_TURNAROUND');
  assert.deepEqual(ir.viewIntent.map(v=>v.orientation),['FRONT','LEFT_PROFILE','BACK','THREE_QUARTER']);
  assert.match(compiler.renderGenericPrompt(ir).text,/four-view character turnaround/);
  const refs=['FACE_HERO','FULL_BODY_FRONT','FULL_BODY_BACK'].map(role=>({role}));
  const route=(framing,view,available=refs)=>pack.resolveCharacterReferencesForShot({framing,view},available).map(r=>r.role);
  assert.deepEqual(route('CLOSE_UP','FRONT'),['FACE_HERO']);assert.deepEqual(route('FULL_BODY','FRONT'),['FULL_BODY_FRONT','FACE_HERO']);
  assert.deepEqual(route('MEDIUM','BACK'),['FULL_BODY_BACK']);assert.deepEqual(route('FULL_BODY','LEFT'),['FACE_HERO','FULL_BODY_FRONT']);
  assert.deepEqual(route('FULL_BODY','LEFT',[...refs,{role:'SIDE_SPECIAL_LEFT'}]),['SIDE_SPECIAL_LEFT','FACE_HERO']);
  assert.deepEqual(route('FULL_BODY','RIGHT',[...refs,{role:'SIDE_SPECIAL_RIGHT'}]),['SIDE_SPECIAL_RIGHT','FACE_HERO']);
  assert.deepEqual(route('CLOSE_UP','FRONT',[]),[]);
});

test('Reference Pack additive migration upgrades old job table without rewriting history',async t=>{
  const {db,cache,oss}=await fixture(t);
  await db.schema.alterTable('o_v04StudioAssetDraftJob',table=>table.dropColumn('executionPurpose'));
  const old={id:'legacy-job',projectId:1,scriptId:2,canonicalKey:'CHAR-001',sourceAssetRevision:1,draftHash:'unchanged',
    generationIntent:'CHARACTER_TURNAROUND',executorType:'COMFY_LOCAL',executorProfile:'LOCAL_DRAFT_V1',workflowVersion:'local-sdxl-draft-v1',status:'SUCCEEDED',
    comfyPromptId:null,inputSnapshotJson:'{}',outputsJson:'[]',errorCode:null,errorMessage:null,attemptCount:1,createdAt:10,startedAt:10,completedAt:11,updatedAt:11};
  await db('o_v04StudioAssetDraftJob').insert(old);
  const schema=loadSource(path.join(root,'src/v04/schema.ts'),db,cache,oss);
  await schema.initializeV04Schema(db);await schema.initializeV04Schema(db);
  assert.deepEqual(await db('o_v04StudioAssetDraftJob').where({id:old.id}).first(),{...old,executionPurpose:null});
});

test('OPT-028B Z-Image subject profile compiles a short English prompt and preserves the verified workflow topology',()=>{
  const {zImageSubjectPrompt,zImageSubjectModels,Z_IMAGE_TURBO_SUBJECT_DRAFT_V1,Z_IMAGE_SUBJECT_RENDERING_V1}=loadSource(path.join(root,'src/v04/zImageSubjectProfile.ts'),null);
  const {buildDraftWorkflow,draftWorkflowVersion}=loadSource(path.join(root,'src/v04/comfyDraftClient.ts'),null);
  const prompt=zImageSubjectPrompt({appearanceBlock:{silhouette:'纤细，窄肩',details:{ageRange:'约7–9岁',genderPresentation:'男孩',
    hair:{color:'深棕至墨黑',silhouette:'微乱短发'},body:{build:'清瘦纤细，窄肩'},wardrobe:{upper:'宽松月白长袖睡衣',lower:'灰蓝宽松长裤'},
    footwear:'赤足',face:{eyeLanguage:'深蓝灰瞳'}}},materialBlock:{primaryPalette:['月白 #E8E6DF','灰蓝 #7C8DA6']}});
  assert.match(prompt,/7 to 9 year old boy/);assert.match(prompt,/slim child proportions/);
  for(const term of ['dark brown-black hair','short hair','slightly messy hair','pajamas','barefoot','moon-white','muted gray-blue',
    'Cinematic stylized realism','natural age-appropriate child anatomy','refined facial anatomy',
    'realistic skin and fabric texture','soft filmic lighting','dreamlike but grounded','premium animated-film',
    'head and both feet fully visible','chibi','super-deformed','oversized head','anime mascot','toy-like',
    'flat vector','sticker illustration','no new accessories'])assert.ok(prompt.includes(term),term);
  assert.equal(Z_IMAGE_SUBJECT_RENDERING_V1,'Z_IMAGE_SUBJECT_RENDERING_V1');
  assert.doesNotMatch(prompt,/[\u3400-\u9fff]/,'execution prompt is English; canonical spec and IR remain unchanged');
  const workflow=buildDraftWorkflow({profile:Z_IMAGE_TURBO_SUBJECT_DRAFT_V1,intent:'CHARACTER_TURNAROUND',
    checkpoint:zImageSubjectModels.unet,positive:prompt,negative:'unused by ConditioningZeroOut',seed:20261004,width:1024,height:1024,
    filenamePrefix:'opt028b-test'});
  const graph=workflow.graph;
  assert.equal(workflow.role,'MAIN_PREVIEW');assert.equal(workflow.outputNode,'10');
  assert.equal(workflow.version,draftWorkflowVersion(Z_IMAGE_TURBO_SUBJECT_DRAFT_V1));
  assert.equal(graph['1'].class_type,'UNETLoader');assert.equal(graph['1'].inputs.unet_name,zImageSubjectModels.unet);
  assert.equal(graph['2'].inputs.clip_name,zImageSubjectModels.textEncoder);assert.equal(graph['3'].inputs.vae_name,zImageSubjectModels.vae);
  assert.deepEqual(graph['5'].inputs.conditioning,['4',0]);assert.deepEqual(graph['8'].inputs.negative,['5',0]);
  assert.deepEqual([graph['7'].inputs.width,graph['7'].inputs.height],[1024,1024]);
  assert.deepEqual([graph['8'].inputs.steps,graph['8'].inputs.cfg,graph['8'].inputs.sampler_name,graph['8'].inputs.scheduler],[8,1,'res_multistep','simple']);
  assert.equal(graph['6'].inputs.shift,3);assert.equal(graph['8'].inputs.seed,20261004);
  assert.equal(graph['10'].inputs.filename_prefix,'opt028b-test');
  assert.throws(()=>buildDraftWorkflow({profile:Z_IMAGE_TURBO_SUBJECT_DRAFT_V1,intent:'MATERIAL_STATE_BOARD',
    checkpoint:zImageSubjectModels.unet,positive:prompt,negative:'',seed:1}),error=>error.code==='WORKFLOW_UNAVAILABLE');
});

test('OPT-028B Z-Image subject uses the existing persistent job and artifact pipeline with a distinct draft hash',async t=>{
  const {db,cache,oss,service}=await fixture(t);
  const http=require('node:http'),sharp=require('sharp');
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#647b9c'}}).png().toBuffer();
  const graphs=[];
  const comfy=http.createServer(async(req,res)=>{
    res.setHeader('content-type',req.url.startsWith('/view')?'image/png':'application/json');
    if(req.url==='/system_stats')return res.end(JSON.stringify({system:{comfyui_version:'test'}}));
    if(req.url==='/object_info')return res.end(JSON.stringify({
      CheckpointLoaderSimple:{input:{required:{ckpt_name:[['dreamshaper.safetensors']]}}},
      UNETLoader:{input:{required:{unet_name:[['z_image_turbo_int8_convrot.safetensors']]}}},
      CLIPLoader:{input:{required:{clip_name:[['qwen_3_4b_fp8_mixed.safetensors']]}}},
      VAELoader:{input:{required:{vae_name:[['ae.safetensors']]}}},
      CLIPTextEncode:{},EmptyLatentImage:{},EmptySD3LatentImage:{},ConditioningZeroOut:{},ModelSamplingAuraFlow:{},KSampler:{},VAEDecode:{},SaveImage:{}}));
    if(req.url==='/prompt'){
      let body='';for await(const chunk of req)body+=chunk;graphs.push(JSON.parse(body).prompt);
      return res.end(JSON.stringify({prompt_id:`prompt-${graphs.length}`,node_errors:{}}));
    }
    if(req.url?.startsWith('/history/')){const number=Number(req.url.split('-')[1]);return res.end(JSON.stringify({[`prompt-${number}`]:{
      status:{completed:true},outputs:{[graphs[number-1]?.['10']?'10':'7']:{images:[{filename:'draft.png',subfolder:'',type:'output'}]}}}}));}
    if(req.url?.startsWith('/view'))return res.end(png);
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>comfy.listen(0,'127.0.0.1',resolve));t.after(()=>comfy.close());
  const image=loadSource(path.join(root,'src/v04/studioDraftImage.ts'),db,cache,oss);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const scope=await service.createPilotProject({name:'Z subject test',brief:'Character',targetDuration:30,aspectRatio:'16:9'},7);
  await db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey:'CHAR-001',category:'CHAR',name:'Boy',description:'A slender boy',
    sourcePolicy:'AI_ALLOWED',assetKind:'HUMAN_CHARACTER',importance:'CORE',status:'ACTIVE',revision:1,createdAt:Date.now(),updatedAt:Date.now()});
  const spec=contract.compileVisualSemantic({assetKind:'HUMAN_CHARACTER',name:'Boy',description:'A slender boy',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]},
    {visualIdentitySummary:'A slim boy in pajamas',silhouette:'清瘦窄肩',primaryPalette:['月白','灰蓝'],
      details:{ageRange:'7–9岁',genderPresentation:'男孩',footwear:'赤足',hair:{color:'黑色',silhouette:'凌乱短发'},body:{build:'清瘦'},wardrobe:{upper:'宽松长袖睡衣',lower:'宽松长裤'}}});
  const baseUrl=`http://127.0.0.1:${comfy.address().port}`;
  await image.configureDraftExecutor({projectId:scope.projectId,baseUrl,checkpoint:'dreamshaper.safetensors',enabled:true});
  const input={...scope,canonicalKey:'CHAR-001',sourceAssetRevision:1,visualSpecDraft:spec};
  const old=await image.enqueueDraftImage(input);
  for(let i=0;i<100;i++){const row=await db('o_v04StudioAssetDraftJob').where({id:old.job.id}).first();if(row.status==='SUCCEEDED')break;
    if(row.status==='FAILED')assert.fail(row.errorCode);await new Promise(resolve=>setTimeout(resolve,30));}
  const inspected=await image.testDraftExecutor({projectId:scope.projectId,baseUrl,profile:'Z_IMAGE_TURBO_SUBJECT_DRAFT_V1'});
  assert.equal(inspected.status,'CONNECTED');assert.deepEqual(inspected.checkpoints,['z_image_turbo_int8_convrot.safetensors']);
  await image.configureDraftExecutor({projectId:scope.projectId,baseUrl,profile:'Z_IMAGE_TURBO_SUBJECT_DRAFT_V1',
    checkpoint:'z_image_turbo_int8_convrot.safetensors',enabled:true});
  const current=await image.readDraftExecutor({projectId:scope.projectId});
  assert.equal(current.profile,'Z_IMAGE_TURBO_SUBJECT_DRAFT_V1');
  const z=await image.enqueueDraftImage({...input,width:1024,height:1024,seed:20261004});
  assert.notEqual(z.job.draftHash,old.job.draftHash,'profile/version are part of the hash');
  const reused=await image.enqueueDraftImage({...input,width:1024,height:1024,seed:20261004});
  assert.equal(reused.reused,true);assert.equal(reused.job.id,z.job.id);
  for(let i=0;i<100;i++){const row=await db('o_v04StudioAssetDraftJob').where({id:z.job.id}).first();if(row.status==='SUCCEEDED')break;
    if(row.status==='FAILED')assert.fail(row.errorCode);await new Promise(resolve=>setTimeout(resolve,30));}
  const row=await db('o_v04StudioAssetDraftJob').where({id:z.job.id}).first();
  assert.equal(row.status,'SUCCEEDED');assert.equal(row.executorProfile,'Z_IMAGE_TURBO_SUBJECT_DRAFT_V1');
  const snapshot=JSON.parse(row.inputSnapshotJson);
  assert.equal(snapshot.renderingLanguageVersion,'Z_IMAGE_SUBJECT_RENDERING_V1');
  const beforeRenderingVersion=[snapshot.visualSpecDraft,snapshot.draftPromptIR,snapshot.generationIntent,
    snapshot.draftPromptIR.referenceBindings,row.executorProfile,row.workflowVersion,snapshot.checkpoint,snapshot.baseUrl,
    snapshot.width,snapshot.height,snapshot.requestedSeed,snapshot.executionPrompt];
  const preVersionHash=require('node:crypto').createHash('sha256').update(JSON.stringify(beforeRenderingVersion)).digest('hex');
  assert.notEqual(row.draftHash,preVersionHash,'rendering-language version changes draft identity independently of prompt text');
  const artifact=JSON.parse(row.outputsJson)[0];assert.equal(artifact.role,'MAIN_PREVIEW');
  assert.deepEqual((await image.getDraftArtifact(scope.projectId,artifact.artifactId)).bytes,png);
  assert.equal(graphs.length,2);assert.equal(graphs[1]['8'].inputs.steps,8);
  assert.equal((await db('o_v04AssetVisualSpec')).length,0);assert.equal((await db('o_v04AssetPromptBuild')).length,0);
});

test('OPT-028B-01 optional real CHAR-001 rendering preview uses readonly Pilot truth and one disposable Z-Image job',
  {skip:process.env.V04_Z_RENDERING_REAL_TEST!=='1'},async t=>{
  const sourceDb=require('better-sqlite3')(path.resolve(root,'../userdata/pilot/data/db2.sqlite'),{readonly:true,fileMustExist:true});
  t.after(()=>sourceDb.close());
  const sourceProjectId=1790941805789310,canonicalKey='CHAR-001';
  const asset=sourceDb.prepare('select * from o_v04Asset where projectId=? and canonicalKey=? and status=?')
    .get(sourceProjectId,canonicalKey,'ACTIVE');
  const specRow=sourceDb.prepare('select * from o_v04AssetVisualSpec where projectId=? and canonicalKey=? and status=? order by revision desc limit 1')
    .get(sourceProjectId,canonicalKey,'CONFIRMED');
  assert.ok(asset&&specRow&&Number(asset.revision)===Number(specRow.sourceAssetRevision));
  const {db,cache,oss,service}=await fixture(t);
  const image=loadSource(path.join(root,'src/v04/studioDraftImage.ts'),db,cache,oss);
  const scope=await service.createPilotProject({name:'OPT-028B-01 disposable CHAR-001',brief:'Subject rendering comparison',
    targetDuration:40,aspectRatio:'16:9'},7);
  await db('o_v04Asset').insert({...asset,projectId:scope.projectId});
  const baseUrl='http://127.0.0.1:8188',profile='Z_IMAGE_TURBO_SUBJECT_DRAFT_V1';
  const checkpoint='z_image_turbo_int8_convrot.safetensors';
  const available=await image.testDraftExecutor({projectId:scope.projectId,baseUrl,profile});
  assert.equal(available.status,'CONNECTED',JSON.stringify(available));
  assert.ok(available.checkpoints.includes(checkpoint));
  await image.configureDraftExecutor({projectId:scope.projectId,baseUrl,profile,checkpoint,enabled:true});
  const started=Date.now();
  const {job}=await image.enqueueDraftImage({...scope,canonicalKey,sourceAssetRevision:asset.revision,
    visualSpecDraft:JSON.parse(specRow.specJson),seed:20261004,width:1024,height:1024});
  let row;
  for(let i=0;i<480;i++){
    row=await db('o_v04StudioAssetDraftJob').where({id:job.id}).first();
    if(['SUCCEEDED','FAILED','STALE'].includes(row.status))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(row?.status,'SUCCEEDED',`${row?.errorCode}: ${row?.errorMessage}`);
  const snapshot=JSON.parse(row.inputSnapshotJson);
  assert.equal(snapshot.renderingLanguageVersion,'Z_IMAGE_SUBJECT_RENDERING_V1');
  const artifact=JSON.parse(row.outputsJson)[0];
  assert.equal(artifact.role,'MAIN_PREVIEW');
  const downloaded=await image.getDraftArtifact(scope.projectId,artifact.artifactId);
  const outDir=path.resolve(root,`../logs/opt028b01-rendering-${Date.now()}`);
  fs.mkdirSync(outDir,{recursive:true});
  const file=path.join(outDir,'char-001.png');fs.writeFileSync(file,downloaded.bytes,{flag:'wx'});
  const report={canonicalKey,sourceProjectId,sourceAssetRevision:asset.revision,profile,renderingLanguageVersion:snapshot.renderingLanguageVersion,
    workflowVersion:row.workflowVersion,draftHash:row.draftHash,jobId:row.id,artifactId:artifact.artifactId,
    executionPrompt:snapshot.executionPrompt,seed:snapshot.seed,width:artifact.width,height:artifact.height,
    elapsedMs:Date.now()-started,file,sha256:require('node:crypto').createHash('sha256').update(downloaded.bytes).digest('hex'),
    projectTruthWrites:0};
  assert.equal((await db('o_v04AssetVisualSpec')).length,0);
  assert.equal((await db('o_v04AssetPromptBuild')).length,0);
  fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log('[OPT-028B-01 CHAR-001]',JSON.stringify({outputDir:outDir,elapsedMs:report.elapsedMs,width:report.width,
    height:report.height,seed:report.seed,projectTruthWrites:0}));
});

test('OPT-028 optional real local Comfy smoke uses disposable SQLite and no project-truth write', {skip:process.env.V04_REAL_COMFY_TEST!=='1'}, async t => {
  const {db,cache,oss,service}=await fixture(t);
  const image=loadSource(path.join(root,'src/v04/studioDraftImage.ts'),db,cache,oss);
  const contract=loadSource(path.join(root,'src/v04/visualSpecContract.ts'),db,cache,oss);
  const scope=await service.createPilotProject({name:'Disposable Comfy smoke',brief:'A small blue-coated dreamer',targetDuration:20,aspectRatio:'16:9'},7);
  await db('o_v04Asset').insert({projectId:scope.projectId,canonicalKey:'CHAR-001',category:'CHAR',name:'Young dreamer',description:'A young dreamer in a blue coat',
    sourcePolicy:'AI_ALLOWED',assetKind:'HUMAN_CHARACTER',importance:'CORE',status:'ACTIVE',revision:1,createdAt:Date.now(),updatedAt:Date.now()});
  const spec=contract.compileVisualSemantic({assetKind:'HUMAN_CHARACTER',name:'Young dreamer',description:'A young dreamer in a blue coat',identityAnchors:[],mustPreserve:[],forbiddenChanges:[]},
    {visualIdentitySummary:'Young boy with short messy dark hair and a simple blue coat',silhouette:'small human child',primaryPalette:['deep blue'],
      details:{ageRange:'8–10',footwear:'plain shoes',hair:{color:'dark',silhouette:'short and messy'},body:{build:'slim'},wardrobe:{upper:'simple blue coat'}}});
  const baseUrl='http://127.0.0.1:8188';
  const checked=await image.testDraftExecutor({projectId:scope.projectId,baseUrl});
  assert.equal(checked.status,'CONNECTED',JSON.stringify(checked));
  const checkpoint='DreamShaperXL1.0Alpha2_fixedVae_half_00001_.safetensors';
  assert.ok(checked.checkpoints.includes(checkpoint),'preinstalled DreamShaper XL checkpoint is required');
  await image.configureDraftExecutor({projectId:scope.projectId,baseUrl,checkpoint,enabled:true});
  const started=Date.now();
  const {job}=await image.enqueueDraftImage({...scope,canonicalKey:'CHAR-001',sourceAssetRevision:1,visualSpecDraft:spec});
  let row;
  for(let i=0;i<480;i++){
    row=await db('o_v04StudioAssetDraftJob').where({id:job.id}).first();
    if(['SUCCEEDED','FAILED','STALE'].includes(row.status))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(row?.status,'SUCCEEDED',`${row?.errorCode}: ${row?.errorMessage}`);
  const artifact=JSON.parse(row.outputsJson)[0];
  const downloaded=await image.getDraftArtifact(scope.projectId,artifact.artifactId);
  assert.ok(downloaded.bytes.length>1000);
  assert.equal((await db('o_v04AssetVisualSpec')).length,0);
  assert.equal((await db('o_v04AssetPromptBuild')).length,0);
  console.log('[OPT-028 Real Comfy Smoke]',{elapsedMs:Date.now()-started,artifactId:artifact.artifactId,width:artifact.width,height:artifact.height,
    bytes:downloaded.bytes.length,checkpoint,sourceTableWrites:0});
});

test('OPT-028B optional real CHAR-001 A/B benchmark uses readonly Pilot source and disposable job database',
  {skip:process.env.V04_Z_SUBJECT_REAL_TEST!=='1'},async t=>{
  const sourceDb=require('better-sqlite3')(path.resolve(root,'../userdata/pilot/data/db2.sqlite'),{readonly:true,fileMustExist:true});
  t.after(()=>sourceDb.close());
  const sourceProjectId=1790941805789310,canonicalKey='CHAR-001';
  const asset=sourceDb.prepare('select * from o_v04Asset where projectId=? and canonicalKey=? and status=?')
    .get(sourceProjectId,canonicalKey,'ACTIVE');
  const specRow=sourceDb.prepare('select * from o_v04AssetVisualSpec where projectId=? and canonicalKey=? and status=? order by revision desc limit 1')
    .get(sourceProjectId,canonicalKey,'CONFIRMED');
  assert.ok(asset&&specRow&&Number(asset.revision)===Number(specRow.sourceAssetRevision));
  const {db,cache,oss,service}=await fixture(t);
  const image=loadSource(path.join(root,'src/v04/studioDraftImage.ts'),db,cache,oss);
  const scope=await service.createPilotProject({name:'OPT-028B disposable A/B',brief:'CHAR-001 subject benchmark',targetDuration:40,aspectRatio:'16:9'},7);
  await db('o_v04Asset').insert({...asset,projectId:scope.projectId});
  const input={...scope,canonicalKey,sourceAssetRevision:asset.revision,visualSpecDraft:JSON.parse(specRow.specJson)};
  const baseUrl='http://127.0.0.1:8188';
  const outDir=path.resolve(root,`../logs/opt028b-benchmark-${Date.now()}`);fs.mkdirSync(outDir,{recursive:true});
  async function execute(profile,checkpoint,seed,width,height,label){
    const available=await image.testDraftExecutor({projectId:scope.projectId,baseUrl,profile});
    assert.equal(available.status,'CONNECTED',JSON.stringify(available));assert.ok(available.checkpoints.includes(checkpoint));
    await image.configureDraftExecutor({projectId:scope.projectId,baseUrl,profile,checkpoint,enabled:true});
    const started=Date.now();
    const {job}=await image.enqueueDraftImage({...input,...(seed==null?{}:{seed}),...(width==null?{}:{width,height})});
    let row;
    for(let i=0;i<480;i++){
      row=await db('o_v04StudioAssetDraftJob').where({id:job.id}).first();
      if(['SUCCEEDED','FAILED','STALE'].includes(row.status))break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(row?.status,'SUCCEEDED',`${label}: ${row?.errorCode} ${row?.errorMessage}`);
    const artifact=JSON.parse(row.outputsJson)[0];
    const downloaded=await image.getDraftArtifact(scope.projectId,artifact.artifactId);
    const file=path.join(outDir,`${label}.png`);fs.writeFileSync(file,downloaded.bytes,{flag:'wx'});
    const snapshot=JSON.parse(row.inputSnapshotJson);
    return {label,profile,workflowVersion:row.workflowVersion,draftHash:row.draftHash,jobId:row.id,
      role:artifact.role,width:artifact.width,height:artifact.height,elapsedMs:Date.now()-started,
      seed:snapshot.seed??parseInt(row.draftHash.slice(0,12),16),executionPrompt:snapshot.executionPrompt??snapshot.draftRenderedPrompt.text,
      file,sha256:require('node:crypto').createHash('sha256').update(downloaded.bytes).digest('hex')};
  }
  const baseline=await execute('LOCAL_DRAFT_V1','DreamShaperXL1.0Alpha2_fixedVae_half_00001_.safetensors',null,null,null,'dreamshaper-char');
  const subject=await execute('Z_IMAGE_TURBO_SUBJECT_DRAFT_V1','z_image_turbo_int8_convrot.safetensors',20261004,1024,1024,'z-image-char');
  assert.notEqual(subject.draftHash,baseline.draftHash);
  assert.equal(subject.role,'MAIN_PREVIEW');assert.equal(subject.width,1024);
  assert.equal((await db('o_v04AssetVisualSpec')).length,0);
  assert.equal((await db('o_v04AssetPromptBuild')).length,0);
  const report={canonicalKey,sourceProjectId,sourceAssetRevision:asset.revision,
    results:[baseline,subject],projectTruthWrites:0};
  fs.writeFileSync(path.join(outDir,'benchmark.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log('[OPT-028B Benchmark]',JSON.stringify({outputDir:outDir,results:report.results.map(({label,profile,role,width,height,elapsedMs,seed})=>
    ({label,profile,role,width,height,elapsedMs,seed}))}));
});
