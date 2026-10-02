const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const knex = require('knex');
const root = path.resolve(__dirname, '..');

function loadSource(file, db, cache = new Map()) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: file }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (name === '@/utils/db') return { db };
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
    if (name.startsWith('.')) return loadSource(path.resolve(path.dirname(file), name + '.ts'), db, cache);
    return require(name);
  }, module, module.exports);
  return module.exports;
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v04-pilot-'));
  const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(dir, 'test.sqlite') }, useNullAsDefault: true });
  t.after(async () => { await db.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.schema.createTable('o_project', x => { x.bigInteger('id').primary(); x.string('projectType'); x.string('type'); x.string('name'); x.text('intro'); x.string('artStyle'); x.string('directorManual'); x.string('videoRatio'); x.string('imageModel'); x.string('videoModel'); x.string('imageQuality'); x.string('mode'); x.integer('userId'); x.bigInteger('createTime'); });
  await db.schema.createTable('o_script', x => { x.increments('id'); x.bigInteger('projectId'); x.string('name'); x.text('content'); x.bigInteger('createTime'); });
  await db.schema.createTable('o_storyboard', x => { x.increments('id'); x.bigInteger('projectId'); x.integer('scriptId'); x.integer('index'); x.text('prompt'); x.integer('duration'); x.text('videoDesc'); x.text('productionSpec'); x.string('state'); x.string('filePath'); x.integer('currentImageAttemptId'); x.integer('activeImageAttemptId'); x.bigInteger('retiredAt'); });
  await db.schema.createTable('o_productionProfileVersion', x => { x.string('profileKey'); x.integer('version'); x.string('status'); x.string('definitionHash'); x.text('definition'); x.bigInteger('createdAt'); x.bigInteger('updatedAt'); x.bigInteger('activatedAt'); x.bigInteger('deprecatedAt'); x.primary(['profileKey','version']); });
  await db.schema.createTable('o_projectProfileBinding', x => { x.bigInteger('projectId').primary(); x.string('profileKey'); x.integer('profileVersion'); x.string('source'); x.bigInteger('createdAt'); x.bigInteger('updatedAt'); });
  await db('o_productionProfileVersion').insert({profileKey:'advertisement',version:2,status:'ACTIVE',definition:'{}',definitionHash:'a'.repeat(64)});
  await db.schema.createTable('o_assets', x => { x.increments('id'); x.bigInteger('projectId'); x.integer('scriptId'); x.integer('imageId'); x.string('name'); x.text('describe'); x.text('prompt'); x.string('type'); x.bigInteger('startTime'); });
  await db.schema.createTable('o_scriptAssets', x => { x.integer('scriptId'); x.integer('assetId'); x.primary(['scriptId','assetId']); });
  await db.schema.createTable('o_image', x => { x.increments('id'); x.integer('assetsId'); x.string('state'); x.string('filePath'); x.string('model'); });
  await db.schema.createTable('o_assetUploadSource', x => { x.integer('projectId'); x.integer('assetId'); x.integer('imageId'); x.string('filePath'); });
  await db.schema.createTable('o_advertisementAssetPlan', x => { x.bigInteger('projectId'); x.integer('scriptId'); x.string('assetKey'); x.string('name'); x.string('category'); x.integer('required'); x.string('sourcePolicy'); x.integer('assetId'); x.integer('position'); x.primary(['projectId','scriptId','assetKey']); });
  const schema = loadSource(path.join(root,'src/v04/schema.ts'),db);
  await schema.initializeV04Schema(db); await schema.initializeV04Schema(db);
  return { db, service: loadSource(path.join(root,'src/v04/service.ts'),db) };
}
const asset = (name='Dreamer', category='CHAR', sourcePolicy='AI_ALLOWED') => ({ name, category, description:'calm', identityAnchors:['left eyebrow scar'], mustPreserve:['scar'], forbiddenChanges:['redraw brand text'], ownerKey:null, variantOf:null, sourcePolicy, prompt:'' });
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
