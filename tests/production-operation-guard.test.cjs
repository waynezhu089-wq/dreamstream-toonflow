const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./composite-fixture.cjs');

const unit = { projectId: 1, scriptId: 10 };
const operations = ['storyboard.image.generate', 'storyboard.image.composite', 'storyboard.image.attach'];
const stage = (stageKey, uiOrder, extra = {}) => ({ stageKey, displayName: stageKey, description: '', required: true, allowSkip: false, uiOrder, entryGateKey: null, exitGateKey: null, operationKeys: [], ...extra });
const enforced = () => ({ schemaVersion: 2, runtimeControl: 'ENFORCED', initialStageKey: 'asset-preparation', stages: [
  stage('asset-preparation', 10, { exitGateKey: 'advertisement.asset-ready' }),
  stage('supervisor-review', 20, { exitGateKey: 'supervisor.storyboard-approved' }),
  stage('image-production', 30, { operationKeys: operations, exitGateKey: 'future.after-work' }),
], transitions: [{ fromStageKey: 'asset-preparation', toStageKey: 'supervisor-review' }, { fromStageKey: 'supervisor-review', toStageKey: 'image-production' }] });

async function setup(t, profileDefinition = enforced()) {
  const f = await fixture(t);
  await f.load('lib/productionProfileSchema').initializeProductionProfileSchema(f.db);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  const registry = f.load('services/orchestrator/profileRegistry');
  const definition = f.load('services/orchestrator/profileDefinition');
  const guard = f.load('services/orchestrator/productionOperationGuard');
  const orchestrator = f.load('services/orchestrator/stageOrchestrator');
  const operationRegistry = f.load('services/orchestrator/productionOperationRegistry');
  const review = f.load('services/supervisor/review');
  await registry.createVersion({ profileKey: 'advertisement', definition: profileDefinition });
  await registry.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await registry.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  const [shotId] = await f.db('o_storyboard').insert({ ...unit, index: 1, prompt: 'Original scene', duration: '3', videoDesc: 'Phone', shouldGenerateImage: 0, state: '未生成', productionSpec: JSON.stringify({ schemaVersion: 1, productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1, referenceAssetIds: [], referenceAssetGroupIds: [], promptSkillId: null, promptSkillVersion: null, capabilityId: null }) });
  async function decide() {
    const input = { ...unit, reviewKey: 'storyboard.semantic-approval' };
    const target = await review.targetRead(input);
    return review.decide({ ...input, expectedTargetHash: target.target.targetHash, expectedControlContextHash: target.controlContextHash, decision: 'PASS', summary: 'Approved', issues: [] }, { id: 1, name: 'Reviewer' });
  }
  async function active() {
    await orchestrator.actOnStage('start', { ...unit, stageKey: 'asset-preparation' });
    await orchestrator.actOnStage('complete', { ...unit, stageKey: 'asset-preparation' });
    await orchestrator.actOnStage('start', { ...unit, stageKey: 'supervisor-review' });
    await decide();
    await orchestrator.actOnStage('complete', { ...unit, stageKey: 'supervisor-review' });
    await orchestrator.actOnStage('start', { ...unit, stageKey: 'image-production' });
  }
  return { ...f, registry, definition, guard, orchestrator, operationRegistry, review, shotId, decide, active };
}

test('V1 hash/validation stays stable; V2 validates exact operation ownership', async t => {
  const f = await setup(t);
  const v1 = f.definition.advertisementV1;
  assert.equal(f.definition.definitionHash(v1), require('node:crypto').createHash('sha256').update(JSON.stringify(v1)).digest('hex'));
  assert.equal(f.definition.validateDefinition(v1).schemaVersion, 1);
  assert.equal(f.definition.validateDefinition(enforced()).runtimeControl, 'ENFORCED');
  for (const bad of [
    { ...enforced(), runtimeControl: undefined },
    { ...enforced(), stages: enforced().stages.map((s, i) => i === 0 ? { ...s, operationKeys: ['BAD'] } : s) },
    { ...enforced(), stages: enforced().stages.map((s, i) => i === 0 ? { ...s, operationKeys: [operations[0]] } : s) },
  ]) assert.throws(() => f.definition.validateDefinition(bad), e => e.code === 'PROFILE_DEFINITION_INVALID');
  assert.equal((await f.guard.readProductionOperationAdmission('storyboard.image.generate', { projectId: 2, scriptId: 20 })).code, 'LEGACY_ADVISORY');
});

test('enforced admission uses one read transaction, all ancestor Gates, and no Stage writes', async t => {
  const f = await setup(t);
  const read = () => f.guard.readProductionOperationAdmission('storyboard.image.generate', unit);
  assert.equal((await read()).code, 'PRODUCTION_STAGE_NOT_ACTIVE');
  assert.equal((await f.guard.readProductionOperationAdmission('storyboard.image.composite', unit)).code, 'PRODUCTION_STAGE_NOT_ACTIVE');
  assert.equal((await f.guard.readProductionOperationAdmission('storyboard.image.attach', unit)).code, 'PRODUCTION_STAGE_NOT_ACTIVE');
  assert.equal((await f.guard.readProductionOperationAdmission('future.unmapped', unit)).code, 'PRODUCTION_OPERATION_NOT_DECLARED');
  await f.db('o_stageRun').insert({ ...unit, profileKey: 'advertisement', profileVersion: 2, stageKey: 'image-production', state: 'IN_PROGRESS', updatedAt: Date.now() });
  assert.equal((await read()).code, 'PRODUCTION_STAGE_DEPENDENCY_BLOCKED');
  await f.db('o_stageRun').where({ ...unit, stageKey: 'image-production' }).delete();
  await f.active();
  const before = await f.db('o_stageEvent').count('* as count').first();
  const original = f.utils.db;
  f.utils.db = Object.assign(() => { throw Error('Control query escaped transaction'); }, { transaction: original.transaction });
  let allowed;
  try { allowed = await read(); } finally { f.utils.db = original; }
  assert.equal(allowed.code, 'PRODUCTION_OPERATION_ALLOWED');
  assert.equal(allowed.snapshotConsistent, true);
  assert.deepEqual(allowed.gates.map(g => g.gateKey), ['advertisement.asset-ready', 'supervisor.storyboard-approved']);
  assert.equal((await f.db('o_stageEvent').count('* as count').first()).count, before.count);
  await f.db('o_storyboard').where({ id: f.shotId }).update({ prompt: 'Changed semantics' });
  assert.equal((await read()).code, 'SUPERVISOR_REVIEW_REQUIRED');
  await f.decide();
  assert.equal((await read()).allowed, true);
  await f.db('o_stageRun').where({ ...unit, stageKey: 'image-production' }).update({ state: 'COMPLETED' });
  assert.equal((await read()).code, 'PRODUCTION_STAGE_REOPEN_REQUIRED');
});

test('server maps four actual routes and stale Supervisor blocks real image route', async t => {
  const f = await setup(t);
  assert.deepEqual(['/storyboard/batchGenerateImage', '/storyboard/composite/start', '/storyboard/composite/finish', '/storyboard/updateStoryboardUrl'].map(f.operationRegistry.operationForProductionRoute), [operations[0], operations[1], operations[1], operations[2]]);
  assert.equal(f.operationRegistry.operationForProductionRoute('/storyboard/pollingImage'), null);
  await f.active();
  const body = { ...unit, storyboardIds: [f.shotId], compulsory: true, stageKey: 'fake', operationKey: 'fake' };
  await f.db('o_storyboard').where({ id: f.shotId }).update({ prompt: 'Changed after approval' });
  const blocked = await f.post('storyboard/batchGenerateImage', body, 409);
  assert.equal(blocked.code, 'SUPERVISOR_REVIEW_REQUIRED');
  assert.equal((await f.db('o_storyboard').where({ id: f.shotId }).first()).state, '未生成');
  await f.decide();
  await f.post('storyboard/batchGenerateImage', body);
  assert.equal((await f.db('o_stageRun').where({ ...unit, stageKey: 'image-production' }).first()).state, 'IN_PROGRESS');
});

test('composite start/finish and current-image attach pass through real middleware before mutation', async t => {
  const f = await setup(t);
  const express = require('express');
  const app = express(); app.use(express.json());
  f.load('middleware/productionGate').registerProductionGate(app);
  app.use('/api/production/storyboard/composite', f.load('routes/production/storyboard/composite').default);
  app.use('/api/production/storyboard/updateStoryboardUrl', f.load('routes/production/storyboard/updateStoryboardUrl').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/production/storyboard/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await f.active();
  await f.db('o_storyboard').where({ id: f.shotId }).update({ prompt: 'Stale semantic edit' });
  for (const [route, body] of [
    ['composite/start', { ...unit, storyboardId: f.shotId, stageKey: 'fake' }],
    ['composite/finish', { ...unit, storyboardId: f.shotId, attemptId: 123, operationKey: 'fake' }],
    ['updateStoryboardUrl', { id: f.shotId, url: '/tmp/attached.png', flowId: 1, stageKey: 'fake' }],
  ]) {
    const response = await post(route, body);
    assert.equal(response.status, 409, route);
    assert.equal(response.body.data.code, 'SUPERVISOR_REVIEW_REQUIRED', route);
  }
  assert.equal((await f.db('o_storyboard').where({ id: f.shotId }).first()).filePath, null);
  await f.decide();
  const attached = await post('updateStoryboardUrl', { id: f.shotId, url: '/tmp/attached.png', flowId: 1 });
  assert.equal(attached.status, 200);
  assert.equal((await f.db('o_storyboard').where({ id: f.shotId }).first()).filePath, '/tmp/attached.png');
  assert.equal((await f.db('o_stageRun').where({ ...unit, stageKey: 'image-production' }).first()).state, 'IN_PROGRESS');
});

test('unknown ancestor Gate fails closed while the current Stage exit Gate is excluded', async t => {
  const definition = enforced();
  definition.stages[0].entryGateKey = 'future.unknown';
  const f = await setup(t, definition);
  const rows = definition.stages.map((item, index) => ({ ...unit, profileKey: 'advertisement', profileVersion: 2, stageKey: item.stageKey, state: index === 2 ? 'IN_PROGRESS' : 'COMPLETED', updatedAt: Date.now() }));
  await f.db('o_stageRun').insert(rows);
  const result = await f.guard.readProductionOperationAdmission('storyboard.image.generate', unit);
  assert.equal(result.code, 'GATE_ADAPTER_NOT_REGISTERED');
  assert.equal(result.gates.some(item => item.gateKey === 'future.after-work'), false);
});
