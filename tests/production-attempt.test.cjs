const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./composite-fixture.cjs');

const scope = { projectId: 1, scriptId: 10 };
const stages = [
  { stageKey: 'asset-preparation', displayName: 'Asset Preparation', uiOrder: 10, entryGateKey: null, exitGateKey: 'advertisement.asset-ready', operationKeys: [] },
  { stageKey: 'supervisor-review', displayName: 'Supervisor Review', uiOrder: 20, entryGateKey: null, exitGateKey: 'supervisor.storyboard-approved.v2', operationKeys: [] },
  { stageKey: 'image-production', displayName: 'Image Production', uiOrder: 30, entryGateKey: null, exitGateKey: null, operationKeys: ['storyboard.image.generate', 'storyboard.image.composite', 'storyboard.image.attach'] },
].map(s => ({ description: '', required: true, allowSkip: false, ...s }));

async function setup(t, mode = 'REAL_ASSET_DIRECT') {
  const f = await fixture(t);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  const registry = f.load('services/orchestrator/profileRegistry');
  const orchestrator = f.load('services/orchestrator/stageOrchestrator');
  const review = f.load('services/supervisor/review');
  const attempt = f.load('services/productionAttempt');
  await registry.createVersion({ profileKey: 'advertisement', definition: { schemaVersion: 2, runtimeControl: 'ENFORCED', initialStageKey: 'asset-preparation', stages,
    transitions: [{ fromStageKey: 'asset-preparation', toStageKey: 'supervisor-review' }, { fromStageKey: 'supervisor-review', toStageKey: 'image-production' }] } });
  await registry.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await registry.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  const created = await f.create(mode === 'REAL_ASSET_DIRECT' ? {} : { productionMode: mode, primaryAssetId: null, associateAssetsIds: [], shouldGenerateImage: 1 });
  const storyboardId = created.id;
  const shot = { ...scope, storyboardId };
  async function decide() {
    const input = { ...scope, reviewKey: 'storyboard.semantic-approval.v2' };
    const target = await review.targetRead(input);
    return review.decide({ ...input, expectedTargetHash: target.target.targetHash, expectedControlContextHash: target.controlContextHash,
      decision: 'PASS', summary: 'Approved', issues: [] }, { id: 1, name: 'Reviewer' });
  }
  await orchestrator.actOnStage('start', { ...scope, stageKey: 'asset-preparation' });
  await orchestrator.actOnStage('complete', { ...scope, stageKey: 'asset-preparation' });
  await orchestrator.actOnStage('start', { ...scope, stageKey: 'supervisor-review' });
  await decide();
  await orchestrator.actOnStage('complete', { ...scope, stageKey: 'supervisor-review' });
  await orchestrator.actOnStage('start', { ...scope, stageKey: 'image-production' });
  const row = () => f.db('o_storyboard').where({ id: storyboardId }).first();
  const attemptRow = id => f.db('o_productionAttempt').where({ attemptId: id }).first();
  const provenance = async () => (await attempt.readImageProvenance(1, 10, [await row()])).get(storyboardId);
  return { ...f, attempt, shot, storyboardId, row, attemptRow, provenance, decide, orchestrator };
}

test('schema is additive/idempotent and legacy files remain unprovenanced', async t => {
  const f = await fixture(t);
  const migrate = f.load('lib/storyboardProductionSchema').initializeStoryboardProductionSchema;
  await migrate(f.db); await migrate(f.db);
  assert.equal(await f.raw.schema.hasTable('o_productionAttempt'), true);
  for (const column of ['currentImageAttemptId', 'activeImageAttemptId']) assert.equal(await f.raw.schema.hasColumn('o_storyboard', column), true);
  const [id] = await f.db('o_storyboard').insert({ ...scope, prompt: 'old', filePath: '/old.jpg', state: '已完成' });
  const row = await f.db('o_storyboard').where({ id }).first();
  assert.equal(row.currentImageAttemptId, null);
  assert.equal((await f.load('services/productionAttempt').readImageProvenance(1, 10, [row])).get(id).freshness, 'LEGACY');
  const [noneId] = await f.db('o_storyboard').insert({ ...scope, prompt: 'none', filePath: '' });
  const none = await f.db('o_storyboard').where({ id: noneId }).first();
  assert.equal((await f.load('services/productionAttempt').readImageProvenance(1, 10, [none])).get(noneId).freshness, 'NONE');
});

test('direct begin/commit records exact real asset, keeps old image, and derives source STALE after edit', async t => {
  const f = await setup(t);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shot);
  assert.equal(begun.producerType, 'REAL_ASSET_DIRECT');
  assert.equal(begun.producerInput.assetId, 1);
  assert.equal((await f.row()).activeImageAttemptId, begun.attemptId);
  assert.equal((await f.row()).filePath, '');
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  const row = await f.row();
  assert.equal(row.filePath, '/generated/1');
  assert.equal(row.currentImageAttemptId, begun.attemptId);
  assert.equal(row.activeImageAttemptId, null);
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.post('storyboard/editStoryboardInfo', { ...scope, id: f.storyboardId, prompt: 'New semantic intent', videoDesc: 'Screen' });
  const after = await f.row();
  assert.equal(after.filePath, '/generated/1');
  assert.equal(after.currentImageAttemptId, begun.attemptId);
  assert.equal((await f.provenance()).freshness, 'STALE');
  assert.equal((await f.attemptRow(begun.attemptId)).status, 'SUCCEEDED');
});

test('superseded A output stays historical and cannot overwrite successful B', async t => {
  const f = await setup(t);
  const a = await f.attempt.beginStoryboardImageAttempt(f.shot);
  const b = await f.attempt.beginStoryboardImageAttempt(f.shot);
  assert.equal((await f.attemptRow(a.attemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
  assert.equal((await f.row()).activeImageAttemptId, b.attemptId);
  const first = await f.attempt.finishStoryboardImageAttempt(a.attemptId, { filePath: '/old-worker.jpg', mediaType: 'image/jpeg' });
  assert.equal(first.status, 'STALE');
  assert.equal((await f.row()).activeImageAttemptId, b.attemptId);
  assert.equal((await f.attempt.finishStoryboardImageAttempt(b.attemptId, { filePath: '/generated/1', mediaType: 'image/jpeg' })).status, 'SUCCEEDED');
  assert.equal((await f.row()).filePath, '/generated/1');
  assert.equal(JSON.parse((await f.attemptRow(a.attemptId)).outputRef).filePath, '/old-worker.jpg');
});

test('source and control races retain attempt output without attaching', async t => {
  const f = await setup(t);
  const sourceAttempt = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ prompt: 'Changed while worker runs' });
  const stale = await f.attempt.finishStoryboardImageAttempt(sourceAttempt.attemptId, { filePath: '/generated/1', mediaType: 'image/jpeg' });
  assert.equal(stale.staleCode, 'PRODUCTION_SOURCE_CHANGED');
  assert.equal((await f.row()).filePath, '');
  assert.equal(JSON.parse((await f.attemptRow(sourceAttempt.attemptId)).outputRef).filePath, '/generated/1');
  await f.decide();
  const controlAttempt = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.db('o_stageRun').where({ ...scope, stageKey: 'image-production' }).update({ state: 'COMPLETED' });
  const blocked = await f.attempt.finishStoryboardImageAttempt(controlAttempt.attemptId, { filePath: '/generated/1', mediaType: 'image/jpeg' });
  assert.equal(blocked.staleCode, 'PRODUCTION_CONTROL_CHANGED');
  assert.equal((await f.row()).filePath, '');
  assert.equal((await f.db('o_stageEvent').where({ ...scope, stageKey: 'image-production' }).count('* as n').first()).n, 1);
});

test('failed retry retains previous current output and unrelated model changes do not stale direct', async t => {
  const f = await setup(t);
  const a = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.attempt.runStoryboardImageAttempt(a);
  const b = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.attempt.failStoryboardImageAttempt(b.attemptId, new Error('stub failure'));
  const row = await f.row();
  assert.equal(row.filePath, '/generated/1');
  assert.equal(row.currentImageAttemptId, a.attemptId);
  assert.equal(row.state, '已完成');
  assert.equal((await f.provenance()).latestAttemptStatus, 'FAILED');
  await f.db('o_project').where({ id: 1 }).update({ imageQuality: '4K', imageModel: 'vendor:image' });
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.db('o_image').where({ id: 1 }).update({ filePath: '/changed-upload.jpg' });
  assert.equal((await f.provenance()).freshness, 'STALE');
});

test('real upload provenance loss stales direct, invalid producer path never attaches', async t => {
  const f = await setup(t);
  const first = await f.attempt.beginStoryboardImageAttempt(f.shot);
  const mismatch = await f.attempt.finishStoryboardImageAttempt(first.attemptId, { filePath: '/fake-ui.jpg', mediaType: 'image/jpeg' });
  assert.equal(mismatch.staleCode, 'PRODUCTION_OUTPUT_PROVENANCE_MISMATCH');
  assert.equal((await f.row()).filePath, '');
  const second = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.db('o_assetUploadSource').where({ projectId: 1, assetId: 1 }).delete();
  const result = await f.attempt.finishStoryboardImageAttempt(second.attemptId, { filePath: '/generated/1', mediaType: 'image/jpeg' });
  assert.equal(result.staleCode, 'PRODUCTION_SOURCE_CHANGED');
  assert.equal((await f.row()).filePath, '');
  assert.equal(JSON.parse((await f.attemptRow(second.attemptId)).outputRef).filePath, '/generated/1');
});

test('new Supervisor decision changes control hash without source edit', async t => {
  const f = await setup(t);
  const running = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.decide();
  const after = await f.attempt.finishStoryboardImageAttempt(running.attemptId, { filePath: '/generated/1', mediaType: 'image/jpeg' });
  assert.equal(after.staleCode, 'PRODUCTION_CONTROL_CHANGED');
  assert.equal((await f.row()).filePath, '');
});

test('AI exact prompt/model/quality enter source; delayed stub outputs are attempt-owned', async t => {
  const f = await setup(t, 'AI_TEXT_TO_IMAGE');
  await f.config();
  await f.db('o_project').where({ id: 1 }).update({ imageQuality: '1K', videoRatio: '16:9' });
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ imagePrompt: 'Execution one' });
  const first = await f.attempt.beginStoryboardImageAttempt(f.shot);
  const source = JSON.parse((await f.attemptRow(first.attemptId)).sourceSnapshot);
  assert.equal(source.execution.imagePrompt, 'Execution one');
  assert.equal(source.execution.imageModel, 'vendor:image');
  assert.equal(first.producerInput.prompt, 'Execution one');
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ imagePrompt: 'Execution two' });
  assert.equal((await f.attempt.finishStoryboardImageAttempt(first.attemptId, { filePath: `/1/production-attempts/${first.attemptId}/image.jpg`, mediaType: 'image/jpeg' })).staleCode, 'PRODUCTION_SOURCE_CHANGED');
  const second = await f.attempt.beginStoryboardImageAttempt(f.shot);
  const made = await f.attempt.runStoryboardImageAttempt(second);
  assert.equal(made.status, 'SUCCEEDED');
  assert.match((await f.row()).filePath, new RegExp(`/production-attempts/${second.attemptId}/image.jpg$`));
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.db('o_project').where({ id: 1 }).update({ imageQuality: '2K' });
  assert.equal((await f.provenance()).freshness, 'STALE');
  await f.db('o_project').where({ id: 1 }).update({ imageQuality: '1K' });
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.load('services/modelPreset').patchProject({ projectId: 1, slots: { image: 'another:image' } });
  assert.equal((await f.provenance()).freshness, 'STALE');
});

test('HTTP enforced direct produces Attempt; legacy ad retains old no-attempt path', async t => {
  const f = await setup(t);
  const response = await f.post('storyboard/batchGenerateImage', { ...scope, storyboardIds: [f.storyboardId], compulsory: true });
  assert.equal(typeof response[0].attemptId, 'string');
  for (let n = 0; n < 50 && (await f.attemptRow(response[0].attemptId)).status === 'RUNNING'; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.attemptRow(response[0].attemptId)).status, 'SUCCEEDED');
  const other = await f.post('storyboard/addStoryboard', { projectId: 2, scriptId: 20, ...f.item({ primaryAssetId: 3, associateAssetsIds: [3] }) });
  await f.generate([other.id], { projectId: 2, scriptId: 20 });
  assert.equal((await f.db('o_productionAttempt').where({ projectId: 2 }).count('* as n').first()).n, 0);
});

test('multi-shot provenance uses one transaction-local source query graph', async t => {
  const f = await setup(t);
  const first = await f.attempt.beginStoryboardImageAttempt(f.shot);
  await f.attempt.runStoryboardImageAttempt(first);
  const template = await f.row();
  const attemptTemplate = await f.attemptRow(first.attemptId);
  const ids = [f.storyboardId];
  async function addShot(index) {
    const { id, ...storyboard } = template;
    const [shotId] = await f.db('o_storyboard').insert({ ...storyboard, index, currentImageAttemptId: null, activeImageAttemptId: null });
    await f.db('o_assets2Storyboard').insert({ storyboardId: shotId, assetId: 1 });
    const source = await f.db.transaction(q => f.attempt.captureStoryboardImageSource(q, { ...scope, storyboardId: shotId }));
    const attemptId = require('node:crypto').randomUUID();
    const { attemptId: _oldAttemptId, ...attemptRow } = attemptTemplate;
    await f.db('o_productionAttempt').insert({ ...attemptRow, attemptId, subjectId: shotId,
      sourceHash: source.sourceHash, sourceSnapshot: JSON.stringify(source.snapshot) });
    await f.db('o_storyboard').where({ id: shotId }).update({ currentImageAttemptId: attemptId });
    ids.push(shotId);
  }
  await addShot(2);
  async function readAndCount() {
    const rows = await f.db('o_storyboard').whereIn('id', ids);
    let selects = 0;
    const countQuery = query => { if (/^select\b/i.test(query.sql.trim())) selects++; };
    f.raw.on('query', countQuery);
    let result;
    try { result = await f.attempt.readImageProvenance(1, 10, rows); }
    finally { f.raw.off('query', countQuery); }
    assert.equal(result.size, ids.length);
    for (const id of ids) assert.equal(result.get(id).freshness, 'CURRENT', `shot ${id}`);
    return selects;
  }
  const small = await readAndCount();
  for (let index = 3; index <= 32; index++) await addShot(index);
  const large = await readAndCount();
  assert.ok(large <= small + 1, `query graph grew with shot count: two=${small}, thirty-two=${large}`);
});
