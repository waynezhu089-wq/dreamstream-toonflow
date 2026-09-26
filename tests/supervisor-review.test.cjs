const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./composite-fixture.cjs');

async function setup(t) {
  const f = await fixture(t);
  await f.load('lib/productionProfileSchema').initializeProductionProfileSchema(f.db);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  const schema = f.load('lib/supervisorSchema');
  await schema.initializeSupervisorSchema(f.db);
  await schema.initializeSupervisorSchema(f.db);
  const review = f.load('services/supervisor/review');
  const gateRegistry = f.load('services/orchestrator/gateRegistry');
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 42, name: 'Human Reviewer' }; next(); });
  app.use('/api/supervisor', f.load('routes/supervisor/index').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(path, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/supervisor/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json)); return json.data ?? json;
  }
  const input = { projectId: 1, scriptId: 10, reviewKey: 'storyboard.semantic-approval' };
  async function addStoryboard(overrides = {}) {
    const ids = await f.db('o_storyboard').insert({ projectId: 1, scriptId: 10, index: 1, duration: '3', prompt: 'A shot', videoDesc: 'A phone screen', shouldGenerateImage: 0, productionSpec: JSON.stringify({ productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1 }), state: '未生成', filePath: null, ...overrides });
    return ids[0];
  }
  return { ...f, schema, review, gateRegistry, post, input, addStoryboard };
}
function decision(input, target, decision = 'PASS', issues = []) { return { ...input, expectedTargetHash: target.target.targetHash, expectedControlContextHash: target.controlContextHash, decision, summary: 'Human review', issues }; }
const blocker = { severity: 'BLOCKER', code: 'SHOT_REVISION', message: 'Revise the shot', suggestion: null, evidence: 'Shot 1' };

test('schema is idempotent, immutable, and empty target fails closed', async t => {
  const f = await setup(t);
  const empty = await f.post('target/read', f.input, 409); assert.equal(empty.reason, 'SUPERVISOR_TARGET_EMPTY');
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_TARGET_EMPTY');
  await f.addStoryboard();
  const target = await f.post('target/read', f.input);
  assert.equal(target.target.targetType, 'STORYBOARD_SEMANTIC');
  await f.post('review/decide', decision(f.input, target));
  const row = await f.db('o_supervisorReview').first();
  await assert.rejects(f.db('o_supervisorReview').where({ reviewId: row.reviewId }).update({ summary: 'tampered' }));
  await assert.rejects(f.db('o_supervisorReview').where({ reviewId: row.reviewId }).delete());
  assert.equal((await f.db('o_supervisorReview').count('* as count').first()).count, 1);
});

test('snapshot is deterministic, scoped, semantic-only and rejects invalid spec', async t => {
  const f = await setup(t), id = await f.addStoryboard();
  await f.db('o_assets2Storyboard').insert([{ storyboardId: id, assetId: 3 }, { storyboardId: id, assetId: 1 }]);
  const first = await f.post('target/read', f.input);
  assert.deepEqual(first.target.snapshot[0].linkedAssetIds, [1, 3]);
  assert.equal(first.target.snapshot[0].productionSpec.primaryAssetId, 1);
  await f.db('o_storyboard').where({ id }).update({ filePath: '/different.png', state: '完成', reason: 'runtime' });
  assert.equal((await f.post('target/read', f.input)).target.targetHash, first.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ productionSpec: '{"primaryAssetId":1,"productionMode":"REAL_ASSET_DIRECT"}' });
  assert.equal((await f.post('target/read', f.input)).target.targetHash, first.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ duration: '4' });
  assert.notEqual((await f.post('target/read', f.input)).target.targetHash, first.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ duration: '3', productionSpec: '{"primaryAssetId":2,"productionMode":"REAL_ASSET_DIRECT"}' });
  assert.notEqual((await f.post('target/read', f.input)).target.targetHash, first.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ productionSpec: '{"primaryAssetId":1,"productionMode":"REAL_ASSET_DIRECT"}' });
  await f.db('o_assets2Storyboard').where({ storyboardId: id, assetId: 3 }).update({ assetId: 2 });
  assert.notEqual((await f.post('target/read', f.input)).target.targetHash, first.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ prompt: 'Changed semantics' });
  assert.notEqual((await f.post('target/read', f.input)).target.targetHash, first.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ productionSpec: '{invalid' });
  assert.equal((await f.post('target/read', f.input, 503)).reason, 'SUPERVISOR_TARGET_UNAVAILABLE');
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_TARGET_UNAVAILABLE');
});

test('B1 Semantic V2 excludes execution changes, canonicalizes arrays, and stales on semantic changes', async t => {
  const f = await setup(t), id = await f.addStoryboard({ track: 'Opening', productionSpec: JSON.stringify({ productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1, referenceAssetIds: [3, 2], referenceAssetGroupIds: ['z', 'a'] }) });
  const input = { ...f.input, reviewKey: 'storyboard.semantic-approval.v2' };
  const baseline = await f.post('target/read', input);
  assert.equal(baseline.target.targetAdapterKey, 'storyboard.semantic.v2');
  assert.deepEqual(baseline.target.snapshot[0].referenceAssetIds, [2, 3]);
  assert.deepEqual(baseline.target.snapshot[0].referenceAssetGroupIds, ['a', 'z']);
  await f.post('review/decide', decision(input, baseline));
  await f.db('o_storyboard').where({ id }).update({ imagePrompt: 'Execution only', shouldGenerateImage: 1, filePath: '/output.png', state: '已完成', reason: 'runtime', productionSpec: JSON.stringify({ productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1, referenceAssetIds: [2, 3], referenceAssetGroupIds: ['a', 'z'], promptSkillId: 'skill', promptSkillVersion: 'v1', capabilityId: 'capability' }) });
  assert.equal((await f.post('target/read', input)).target.targetHash, baseline.target.targetHash);
  assert.equal((await f.post('gate/check', input)).code, 'SUPERVISOR_PASS');
  const original = await f.db('o_storyboard').where({ id }).first();
  for (const update of [{ prompt: 'Revised' }, { videoDesc: 'New desc' }, { duration: '4' }, { track: 'Other' }, { productionSpec: JSON.stringify({ productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: 1, referenceAssetIds: [2, 3], referenceAssetGroupIds: ['a', 'z'] }) }, { productionSpec: JSON.stringify({ productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 2, referenceAssetIds: [2, 3], referenceAssetGroupIds: ['a', 'z'] }) }, { productionSpec: JSON.stringify({ productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1, referenceAssetIds: [4, 3], referenceAssetGroupIds: ['a', 'z'] }) }, { productionSpec: JSON.stringify({ productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1, referenceAssetIds: [2, 3], referenceAssetGroupIds: ['a', 'new'] }) }]) {
    await f.db('o_storyboard').where({ id }).update(update);
    assert.notEqual((await f.post('target/read', input)).target.targetHash, baseline.target.targetHash, JSON.stringify(update));
    await f.db('o_storyboard').where({ id }).update({ prompt: original.prompt, videoDesc: original.videoDesc, duration: original.duration, track: original.track, productionSpec: original.productionSpec });
  }
  await f.db('o_assets2Storyboard').insert({ storyboardId: id, assetId: 1 });
  assert.notEqual((await f.post('target/read', input)).target.targetHash, baseline.target.targetHash);
  await f.db('o_assets2Storyboard').where({ storyboardId: id }).delete();
  const second = await f.addStoryboard({ index: 2, prompt: 'Second shot' });
  const withSecond = (await f.post('target/read', input)).target.targetHash;
  assert.notEqual(withSecond, baseline.target.targetHash);
  await f.db('o_storyboard').where({ id: second }).update({ index: 0 });
  assert.notEqual((await f.post('target/read', input)).target.targetHash, withSecond);
  await f.db('o_storyboard').where({ id: second }).delete();
  assert.equal((await f.post('target/read', input)).target.targetHash, baseline.target.targetHash);
  await f.db('o_storyboard').where({ id }).update({ duration: 'bad' });
  assert.equal((await f.post('target/read', input, 503)).reason, 'SUPERVISOR_TARGET_UNAVAILABLE');
  await f.db('o_storyboard').where({ id }).update({ duration: original.duration, prompt: 'Changed semantics' });
  assert.equal((await f.post('review/history', input)).history[0].status, 'STALE');
  assert.equal((await f.post('gate/check', input)).code, 'SUPERVISOR_REVIEW_REQUIRED');
});

test('B1 server resolves legacy advisory and exact enforced V2 review; missing Gate fails closed', async t => {
  const f = await setup(t); await f.addStoryboard();
  const legacy = await f.post('current/resolve', { projectId: 1, scriptId: 10 });
  assert.equal(legacy.mode, 'LEGACY_ADVISORY'); assert.equal(legacy.gateDriving, false); assert.equal(legacy.reviewKey, 'storyboard.semantic-approval');
  const profile = f.load('services/orchestrator/profileRegistry');
  const stage = (key, order, exitGateKey) => ({ stageKey: key, displayName: key, description: '', required: true, allowSkip: false, uiOrder: order, entryGateKey: null, exitGateKey, operationKeys: [] });
  const definition = { schemaVersion: 2, runtimeControl: 'ENFORCED', initialStageKey: 'supervisor-review', stages: [stage('supervisor-review', 10, 'supervisor.storyboard-approved')], transitions: [] };
  await profile.createVersion({ profileKey: 'advertisement', definition }); await profile.activateVersion({ profileKey: 'advertisement', version: 'v2' }); await profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  assert.equal((await f.post('current/resolve', { projectId: 1, scriptId: 10 })).reviewKey, 'storyboard.semantic-approval');
  await profile.createVersion({ profileKey: 'advertisement', definition: { ...definition, stages: [stage('supervisor-review', 10, 'supervisor.storyboard-approved.v2')] } });
  await profile.activateVersion({ profileKey: 'advertisement', version: 'v3' });
  await profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v3' });
  const resolved = await f.post('current/resolve', { projectId: 1, scriptId: 10 });
  assert.equal(resolved.reviewKey, 'storyboard.semantic-approval.v2'); assert.equal(resolved.targetAdapterKey, 'storyboard.semantic.v2'); assert.equal(resolved.gateKey, 'supervisor.storyboard-approved.v2');
  const input = { ...f.input, reviewKey: resolved.reviewKey };
  const target = await f.post('target/read', input); await f.post('review/decide', decision(input, target));
  assert.equal((await f.gateRegistry.checkGate(resolved.gateKey, { projectId: 1, scriptId: 10, profileKey: 'advertisement', profileVersion: 'v3', stageKey: 'supervisor-review' })).code, 'SUPERVISOR_PASS');
  await profile.createVersion({ profileKey: 'advertisement', definition: { ...definition, stages: [stage('supervisor-review', 10, null)] } });
  await profile.activateVersion({ profileKey: 'advertisement', version: 'v4' });
  await profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v4' });
  assert.equal((await f.post('current/resolve', { projectId: 1, scriptId: 10 }, 409)).reason, 'SUPERVISOR_CURRENT_REVIEW_NOT_CONFIGURED');
});

test('human PASS, REVISE and stale history feed same diagnostic and Stage Gate', async t => {
  const f = await setup(t), id = await f.addStoryboard();
  const target = await f.post('target/read', f.input);
  const stageContext = { projectId: 1, scriptId: 10, profileKey: target.profile.profileKey, profileVersion: target.profile.profileVersion, stageKey: 'review' };
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_REVIEW_REQUIRED');
  await f.post('review/decide', decision(f.input, target, 'PASS'));
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_PASS');
  assert.deepEqual(await f.gateRegistry.checkGate('supervisor.storyboard-approved', stageContext), await f.post('gate/check', f.input));
  assert.equal((await f.post('review/history', f.input)).history[0].actorDisplayName, 'Human Reviewer');
  await f.db('o_storyboard').where({ id }).update({ prompt: 'Changed after approval' });
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_REVIEW_REQUIRED');
  assert.equal((await f.post('review/history', f.input)).history[0].status, 'STALE');
  const changed = await f.post('target/read', f.input);
  await f.post('review/decide', decision(f.input, changed, 'REVISE', [blocker]));
  const blocked = await f.post('gate/check', f.input);
  assert.equal(blocked.code, 'SUPERVISOR_REVISE_REQUIRED'); assert.match(blocked.reason, /Revise the shot/);
  assert.deepEqual(await f.gateRegistry.checkGate('supervisor.storyboard-approved', stageContext), blocked);
  await f.post('review/decide', decision(f.input, changed, 'PASS'));
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_PASS');
  assert.equal((await f.db('o_stageRun').count('* as count').first()).count, 0);
});

test('decision rejects stale hashes, invalid issue rules, spoofed identity and cross-unit scope without residues', async t => {
  const f = await setup(t); await f.addStoryboard();
  const target = await f.post('target/read', f.input);
  assert.equal((await f.post('review/decide', decision(f.input, target, 'PASS', [blocker]), 400)).reason, 'SUPERVISOR_DECISION_INVALID');
  assert.equal((await f.post('review/decide', decision(f.input, target, 'REVISE'), 400)).reason, 'SUPERVISOR_DECISION_INVALID');
  assert.equal((await f.post('review/decide', { ...decision(f.input, target), actorUserId: 999 }, 400)).reason, 'SUPERVISOR_DECISION_INVALID');
  assert.equal((await f.post('review/decide', { ...decision(f.input, target), expectedTargetHash: '0'.repeat(64) }, 409)).reason, 'SUPERVISOR_TARGET_CHANGED');
  assert.equal((await f.post('review/decide', { ...decision(f.input, target), expectedControlContextHash: '0'.repeat(64) }, 409)).reason, 'SUPERVISOR_CONTEXT_CHANGED');
  assert.equal((await f.post('target/read', { ...f.input, projectId: 2 }, 404)).reason, 'SUPERVISOR_SCOPE_INVALID');
  assert.equal((await f.post('target/read', { ...f.input, reviewKey: 'invented' }, 404)).reason, 'SUPERVISOR_REVIEW_KEY_NOT_REGISTERED');
  assert.equal((await f.db('o_supervisorReview').count('* as count').first()).count, 0);
});

test('exact Recipe/Profile context changes stale decisions and rejects preview-time drift', async t => {
  const f = await setup(t); await f.addStoryboard();
  const before = await f.post('target/read', f.input);
  await f.post('review/decide', decision(f.input, before));
  const profile = f.load('services/orchestrator/profileRegistry');
  await profile.adoptLegacy({ projectId: 1 });
  const pinned = await f.post('target/read', f.input);
  assert.equal(pinned.controlContextHash, before.controlContextHash); // pinning the same exact version is not a semantic change
  const contract = f.load('services/recipeContract');
  const definition = { schemaVersion: 1, profileRef: { profileKey: 'advertisement', profileVersion: 'v1' }, skillRefs: [], capabilityRefs: [], assetPlanTemplate: [], notes: [] };
  const hash = contract.recipeHash(contract.validateRecipeDefinition(definition));
  await f.db('o_recipe').insert({ recipeKey: 'review-fixture', displayName: 'Fixture', description: '', tags: '[]', createdAt: 1, updatedAt: 1 });
  await f.db('o_recipeVersion').insert({ recipeKey: 'review-fixture', version: 1, status: 'ACTIVE', definition: JSON.stringify(definition), definitionHash: hash, createdAt: 1, updatedAt: 1 });
  await f.db('o_projectRecipeBinding').insert({ projectId: 1, recipeKey: 'review-fixture', recipeVersion: 1, recipeDefinitionHash: hash, source: 'MANUAL', createdAt: 1, updatedAt: 1 });
  const recipeTarget = await f.post('target/read', f.input);
  assert.equal(recipeTarget.recipe.recipeKey, 'review-fixture'); assert.equal(recipeTarget.recipe.recipeVersion, 'v1');
  assert.notEqual(recipeTarget.controlContextHash, before.controlContextHash);
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_REVIEW_REQUIRED');
  assert.equal((await f.post('review/history', f.input)).history[0].status, 'STALE');
  assert.equal((await f.post('review/decide', decision(f.input, before), 409)).reason, 'SUPERVISOR_CONTEXT_CHANGED');
  await f.post('review/decide', decision(f.input, recipeTarget));
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_PASS');
  await f.db('o_projectRecipeBinding').where({ projectId: 1 }).delete();
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_PASS'); // identical exact context reuses its own prior review
  assert.equal((await f.post('review/history', f.input)).history[0].status, 'STALE');
  await f.db('o_projectRecipeBinding').insert({ projectId: 1, recipeKey: 'review-fixture', recipeVersion: 1, recipeDefinitionHash: hash, source: 'MANUAL', createdAt: 1, updatedAt: 1 });
  await f.db('o_projectRecipeBinding').where({ projectId: 1 }).update({ recipeDefinitionHash: '0'.repeat(64) });
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_CONTEXT_UNAVAILABLE');
  await f.db('o_projectRecipeBinding').where({ projectId: 1 }).delete();
  await profile.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  await profile.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await f.db('o_projectProfileBinding').where({ projectId: 1 }).update({ profileVersion: 2 });
  const changedProfile = await f.post('target/read', f.input);
  assert.equal(changedProfile.profile.profileVersion, 'v2');
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_REVIEW_REQUIRED');
  assert.equal((await f.post('review/decide', decision(f.input, before), 409)).reason, 'SUPERVISOR_CONTEXT_CHANGED');
  assert.equal((await f.db('o_supervisorReview').count('* as count').first()).count, 2);
});

test('oversize target and cross-script review cannot pass', async t => {
  const f = await setup(t); await f.addStoryboard();
  const second = { ...f.input, scriptId: 11 };
  assert.equal((await f.post('gate/check', second)).code, 'SUPERVISOR_TARGET_EMPTY');
  const target = await f.post('target/read', f.input); await f.post('review/decide', decision(f.input, target));
  assert.equal((await f.post('gate/check', second)).code, 'SUPERVISOR_TARGET_EMPTY');
  await f.db('o_storyboard').where({ projectId: 1, scriptId: 10 }).update({ prompt: 'x'.repeat(1024 * 1024) });
  assert.equal((await f.post('target/read', f.input, 503)).reason, 'SUPERVISOR_TARGET_UNAVAILABLE');
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_TARGET_UNAVAILABLE');
});

test('human review appends only its own row and never mutates production or bindings', async t => {
  const f = await setup(t); await f.addStoryboard();
  const tables = ['o_stageRun', 'o_stageEvent', 'o_storyboard', 'o_assets', 'o_advertisementAssetPlan', 'o_projectProfileBinding', 'o_projectRecipeBinding'];
  const before = Object.fromEntries(await Promise.all(tables.map(async name => [name, await f.db(name).select('*')])));
  const target = await f.post('target/read', f.input);
  await f.post('review/decide', decision(f.input, target));
  for (const name of tables) assert.deepEqual(await f.db(name).select('*'), before[name], name);
  assert.equal((await f.db('o_supervisorReview').count('* as count').first()).count, 1);
  assert.equal(f.calls.length, 0, 'Supervisor must not call image/model providers');
});

test('registry fails closed for an unregistered adapter and snapshot sorts index then id', async t => {
  const f = await setup(t);
  const a = await f.addStoryboard({ index: 2 });
  const b = await f.addStoryboard({ index: 1 });
  const c = await f.addStoryboard({ index: 1 });
  const result = await f.post('target/read', f.input);
  assert.deepEqual(result.target.snapshot.map(row => row.id), [b, c, a]);
  f.load('services/supervisor/registry').registerReview({ reviewKey: 'test.missing-adapter', displayName: 'Missing', targetAdapterKey: 'not.registered', humanDecisions: ['PASS','REVISE'], gateKey: 'test.missing-gate' });
  assert.equal((await f.post('target/read', { ...f.input, reviewKey: 'test.missing-adapter' }, 503)).reason, 'SUPERVISOR_TARGET_ADAPTER_NOT_REGISTERED');
});

test('HF1 target, history, diagnostic Gate and Stage Gate read only inside their own transaction', async t => {
  const f = await setup(t); await f.addStoryboard();
  const initial = await f.post('target/read', f.input);
  await f.post('review/decide', decision(f.input, initial));
  let readTransactions = 0;
  const originalDb = f.utils.db;
  f.utils.db = new Proxy(originalDb, {
    apply() { throw new Error('NON_TRANSACTIONAL_SUPERVISOR_READ'); },
    get(target, key) {
      if (key === 'transaction') return callback => { readTransactions++; return target.transaction(callback); };
      return Reflect.get(target, key);
    },
  });
  try {
    const target = await f.post('target/read', f.input);
    const history = await f.post('review/history', f.input);
    const diagnostic = await f.post('gate/check', f.input);
    const stage = await f.gateRegistry.checkGate('supervisor.storyboard-approved', { projectId: 1, scriptId: 10, profileKey: 'advertisement', profileVersion: 'v1', stageKey: 'supervisor-review' });
    assert.equal(target.target.targetHash, initial.target.targetHash);
    assert.equal(history.history[0].status, 'CURRENT');
    assert.equal(diagnostic.code, 'SUPERVISOR_PASS');
    assert.deepEqual(stage, diagnostic);
    assert.equal(readTransactions, 4, 'each read request must use one transaction for context, target and candidate rows');
  } finally { f.utils.db = originalDb; }
});

test('HF1 missing exact Profile produces stable context error on read and Gate', async t => {
  const f = await setup(t); await f.addStoryboard();
  await f.load('services/orchestrator/profileRegistry').adoptLegacy({ projectId: 1 });
  await f.db('o_projectProfileBinding').where({ projectId: 1 }).update({ profileVersion: 999 });
  assert.equal((await f.post('target/read', f.input, 409)).reason, 'SUPERVISOR_CONTEXT_UNAVAILABLE');
  assert.equal((await f.post('review/history', f.input, 409)).reason, 'SUPERVISOR_CONTEXT_UNAVAILABLE');
  assert.equal((await f.post('gate/check', f.input)).code, 'SUPERVISOR_CONTEXT_UNAVAILABLE');
});
