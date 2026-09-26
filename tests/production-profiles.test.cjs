const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./composite-fixture.cjs');

async function setup(t) {
  const f = await fixture(t);
  const schema = f.load('lib/productionProfileSchema');
  await schema.initializeProductionProfileSchema(f.db);
  const registry = f.load('services/orchestrator/profileRegistry');
  const definition = f.load('services/orchestrator/profileDefinition');
  const stage = f.load('services/orchestrator/stageOrchestrator');
  const gates = f.load('services/orchestrator/gateRegistry');
  const app = express(); app.use(express.json());
  app.use('/api/productionProfiles', f.load('routes/productionProfiles/index').default);
  app.use('/api/stageOrchestrator', f.load('routes/stageOrchestrator/index').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(path, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json)); return json.data ?? json;
  }
  return { ...f, schema, registry, definition, stage, gates, post };
}
const ctx = { projectId: 1, scriptId: 10 };
const mini = (overrides = {}) => ({ schemaVersion: 1, initialStageKey: 'a', stages: [
  { stageKey: 'a', displayName: 'A', description: '', required: true, allowSkip: false, uiOrder: 10, entryGateKey: null, exitGateKey: null },
  { stageKey: 'b', displayName: 'B', description: '', required: false, allowSkip: true, uiOrder: 20, entryGateKey: null, exitGateKey: null },
  { stageKey: 'c', displayName: 'C', description: '', required: true, allowSkip: false, uiOrder: 30, entryGateKey: null, exitGateKey: null },
], transitions: [{ fromStageKey: 'a', toStageKey: 'b' }, { fromStageKey: 'b', toStageKey: 'c' }], ...overrides });

// Serialized by the pre-D-A V1 schema (52c790a), with its separately captured
// SHA-256. Keep both literal: deriving the expected hash from today's parser
// would repeat the regression that missed historical persisted rows.
const historicalV1 = '{"schemaVersion":1,"initialStageKey":"brief","stages":[{"stageKey":"brief","displayName":"Brief","description":"","required":true,"allowSkip":false,"uiOrder":10,"entryGateKey":null,"exitGateKey":null},{"stageKey":"image-production","displayName":"Image Production","description":"","required":true,"allowSkip":false,"uiOrder":20,"entryGateKey":null,"exitGateKey":null}],"transitions":[{"fromStageKey":"brief","toStageKey":"image-production"}]}';
const historicalV1Hash = '4da67969f20a017f11aa8f3c386a7c354e82a58956873121507cc8fcbf3669d8';

test('pre-D-A serialized V1 hash and persisted advertisement v1/v2 rows remain byte-compatible', async t => {
  const f = await setup(t);
  const parsed = f.definition.validateDefinition(JSON.parse(historicalV1));
  assert.equal(JSON.stringify(parsed), historicalV1);
  assert.equal(f.definition.definitionHash(parsed), historicalV1Hash);

  // Simulate existing SQLite rows. Never call a migration or recompute their
  // definitionHash after insertion; exact reads must honor stored provenance.
  const now = Date.now();
  await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', version: 1 })
    .update({ status: 'DEPRECATED', definition: historicalV1, definitionHash: historicalV1Hash });
  await f.db('o_productionProfileVersion').insert({ profileKey: 'advertisement', version: 2, status: 'ACTIVE',
    definition: historicalV1, definitionHash: historicalV1Hash, createdAt: now, updatedAt: now, activatedAt: now, deprecatedAt: null });
  const before = await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement' }).orderBy('version').select('version', 'definition', 'definitionHash');
  for (const version of ['v1', 'v2']) {
    const exact = await f.registry.getProfile({ profileKey: 'advertisement', version });
    assert.equal(exact.versions[0].version, version);
    assert.equal(exact.versions[0].definition.schemaVersion, 1);
  }
  assert.equal((await f.registry.resolveProfile({ projectId: 1 })).version, 'v1');
  const bound = await f.registry.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  assert.equal(bound.version, 'v2');
  assert.equal((await f.registry.resolveProfile({ projectId: 1 })).version, 'v2');
  assert.deepEqual(await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement' }).orderBy('version').select('version', 'definition', 'definitionHash'), before);
});

test('bootstrap is idempotent and preserves exact frozen advertisement v1', async t => {
  const f = await setup(t), first = await f.registry.getProfile({ profileKey: 'advertisement', version: 'v1' });
  assert.equal(first.versions[0].status, 'ACTIVE');
  assert.deepEqual(first.versions[0].definition.stages.map(s => s.stageKey), ['brief','asset-planning','asset-preparation','director-planning','storyboard-table','storyboard-board','supervisor-review','image-production','video-production','edit-subtitle-voice','qc','final-output']);
  assert.equal(first.versions[0].definition.stages[2].exitGateKey, 'advertisement.asset-ready');
  await f.schema.initializeProductionProfileSchema(f.db);
  assert.equal((await f.registry.getProfile({ profileKey: 'advertisement' })).versions.length, 1);
  await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', version: 1 }).update({ definition: JSON.stringify(mini()) });
  await f.schema.initializeProductionProfileSchema(f.db);
  assert.equal(JSON.parse((await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', version: 1 }).first()).definition).initialStageKey, 'a');
});

test('definition rejects duplicates, broken graph, cycles, required skip and extra fields', async t => {
  const f = await setup(t), validate = f.definition.validateDefinition;
  for (const value of [
    mini({ stages: [mini().stages[0], { ...mini().stages[1], stageKey: 'a' }] }),
    mini({ transitions: [{ fromStageKey: 'a', toStageKey: 'missing' }] }),
    mini({ initialStageKey: 'missing' }),
    mini({ transitions: [{ fromStageKey: 'a', toStageKey: 'b' }] }),
    mini({ transitions: [...mini().transitions, { fromStageKey: 'c', toStageKey: 'a' }] }),
    mini({ stages: [{ ...mini().stages[0], allowSkip: true }, ...mini().stages.slice(1)] }),
    { ...mini(), adapterKey: 'forbidden' },
  ]) assert.throws(() => validate(value), e => e.code === 'PROFILE_DEFINITION_INVALID');
});

test('registry supports draft edit, atomic activation, deprecated exact read and rejects new deprecated bindings', async t => {
  const f = await setup(t);
  await f.registry.createFamily({ profileKey: 'knowledge-video', displayName: 'Knowledge Video', description: '' });
  const v1 = await f.registry.createVersion({ profileKey: 'knowledge-video', definition: mini() });
  assert.equal(v1.status, 'DRAFT');
  await assert.rejects(f.registry.bindProfile({ projectId: 3, profileKey: 'knowledge-video', version: 'v1' }), e => e.code === 'PROFILE_VERSION_NOT_ACTIVE');
  await f.registry.editVersion({ profileKey: 'knowledge-video', version: 'v1', definition: mini({ stages: mini().stages.map(s => ({ ...s, displayName: s.displayName + ' edited' })) }) });
  await f.registry.activateVersion({ profileKey: 'knowledge-video', version: 'v1' });
  const resolved = await f.registry.bindProfile({ projectId: 3, profileKey: 'knowledge-video', version: 'v1' });
  assert.equal(resolved.version, 'v1');
  const v2 = await f.registry.createVersion({ profileKey: 'knowledge-video', sourceVersion: 'v1' });
  assert.equal(v2.version, 'v2');
  await f.registry.activateVersion({ profileKey: 'knowledge-video', version: 'v2' });
  const versions = (await f.registry.getProfile({ profileKey: 'knowledge-video' })).versions;
  assert.equal(versions.find(v => v.version === 'v1').status, 'DEPRECATED');
  assert.equal(versions.filter(v => v.status === 'ACTIVE').length, 1);
  assert.equal((await f.registry.resolveProfile({ projectId: 3 })).version, 'v1');
  await assert.rejects(f.registry.bindProfile({ projectId: 2, profileKey: 'knowledge-video', version: 'v1' }), e => e.code === 'PROFILE_VERSION_NOT_ACTIVE');
  await assert.rejects(f.registry.editVersion({ profileKey: 'knowledge-video', version: 'v1', definition: mini() }), e => e.code === 'PROFILE_VERSION_NOT_ACTIVE');
});

test('legacy advertisement read is non-writing; adoption pins v1 after v2 activation', async t => {
  const f = await setup(t);
  assert.equal((await f.registry.resolveProfile({ projectId: 1 })).version, 'v1');
  assert.equal((await f.db('o_projectProfileBinding').where({ projectId: 1 }).first()), undefined);
  assert.equal((await f.registry.resolveProfile({ projectId: 3 })).managed, false);
  await f.registry.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  await f.registry.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  assert.equal((await f.registry.resolveProfile({ projectId: 1 })).version, 'v1');
  const adopted = await f.registry.adoptLegacy({ projectId: 1 });
  assert.equal(adopted.version, 'v1'); assert.equal(adopted.source, 'LEGACY_ADAPTER'); assert.equal(adopted.persisted, true);
  await assert.rejects(f.registry.bindProfile({ projectId: 2, profileKey: 'advertisement', version: 'v1' }), e => e.code === 'PROFILE_VERSION_NOT_ACTIVE');
  assert.equal((await f.registry.resolveProfile({ projectId: 1 })).version, 'v1');
});

test('orchestrator advances by dependency, records exactly one event, and isolates production units', async t => {
  const f = await setup(t);
  let state = await f.stage.readOrchestrator(ctx);
  assert.deepEqual(state.readyStages, ['brief']); assert.ok(state.blockedStages.includes('asset-planning'));
  await assert.rejects(f.stage.actOnStage('skip', { ...ctx, stageKey: 'brief' }), e => e.code === 'STAGE_SKIP_NOT_ALLOWED');
  await f.stage.actOnStage('start', { ...ctx, stageKey: 'brief' });
  state = await f.stage.actOnStage('complete', { ...ctx, stageKey: 'brief' });
  assert.deepEqual(state.readyStages, ['asset-planning']);
  assert.equal((await f.stage.stageEvents(ctx)).length, 2);
  assert.deepEqual((await f.stage.readOrchestrator({ projectId: 1, scriptId: 11 })).readyStages, ['brief']);
  await assert.rejects(f.stage.readOrchestrator({ projectId: 2, scriptId: 10 }), e => e.code === 'PROFILE_SCOPE_INVALID');
  await assert.rejects(f.registry.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' }), e => e.code === 'PROFILE_VERSION_NOT_FOUND');
});

test('asset Gate uses existing state, blocks complete, fails closed on unknown and unavailable Gate', async t => {
  const f = await setup(t);
  for (const stageKey of ['brief', 'asset-planning', 'asset-preparation']) {
    await f.stage.actOnStage('start', { ...ctx, stageKey });
    if (stageKey !== 'asset-preparation') await f.stage.actOnStage('complete', { ...ctx, stageKey });
  }
  await f.db('o_agentWorkData').where({ projectId: 1, episodesId: 10, key: 'advertisement:asset-preparation' }).update({ data: '{"confirmed":false}' });
  const state = await f.stage.readOrchestrator(ctx);
  assert.match(state.stages.find(s => s.stageKey === 'asset-preparation').blockerReasons.join(' '), /ADVERTISEMENT_ASSET_GATE_BLOCKED/);
  await assert.rejects(f.stage.actOnStage('complete', { ...ctx, stageKey: 'asset-preparation' }), e => e.code === 'STAGE_GATE_BLOCKED');
  const context = { ...ctx, profileKey: 'advertisement', profileVersion: 'v1', stageKey: 'asset-preparation' };
  assert.equal((await f.gates.checkGate('unknown.gate', context)).code, 'GATE_ADAPTER_NOT_REGISTERED');
  f.gates.registerGate('test.broken', async () => { throw Error('DB unavailable'); });
  assert.equal((await f.gates.checkGate('test.broken', context)).code, 'STAGE_GATE_UNAVAILABLE');
  f.gates.registerGate('test.empty', async () => undefined);
  assert.equal((await f.gates.checkGate('test.empty', context)).code, 'STAGE_GATE_UNAVAILABLE');
  await f.db('o_agentWorkData').where({ projectId: 1, episodesId: 10, key: 'advertisement:asset-preparation' }).update({ data: '{"confirmed":true}' });
  const next = await f.stage.actOnStage('complete', { ...ctx, stageKey: 'asset-preparation' });
  assert.ok(next.readyStages.includes('director-planning'));
});

test('optional skip requires READY or HUMAN reason; multi-outgoing exposes parallel READY stages', async t => {
  const f = await setup(t);
  await f.registry.createFamily({ profileKey: 'mv', displayName: 'MV', description: '' });
  await f.registry.createVersion({ profileKey: 'mv', definition: mini({ transitions: [{ fromStageKey: 'a', toStageKey: 'b' }, { fromStageKey: 'a', toStageKey: 'c' }] }) });
  await f.registry.activateVersion({ profileKey: 'mv', version: 'v1' });
  await f.registry.bindProfile({ projectId: 3, profileKey: 'mv', version: 'v1' });
  const unit = { projectId: 3, scriptId: 30 };
  await assert.rejects(f.stage.actOnStage('skip', { ...unit, stageKey: 'b' }), e => e.code === 'STAGE_NOT_READY');
  await f.stage.actOnStage('start', { ...unit, stageKey: 'a' });
  const state = await f.stage.actOnStage('complete', { ...unit, stageKey: 'a' });
  assert.deepEqual(state.readyStages, ['b', 'c']);
  await f.stage.actOnStage('start', { ...unit, stageKey: 'b' });
  await assert.rejects(f.stage.actOnStage('skip', { ...unit, stageKey: 'b', actorType: 'SYSTEM' }), e => e.code === 'STAGE_SKIP_NOT_ALLOWED');
  await f.stage.actOnStage('skip', { ...unit, stageKey: 'b', actorType: 'HUMAN', reason: 'Human chooses alternate branch' });
  assert.equal((await f.stage.stageEvents(unit)).at(-1).reason, 'Human chooses alternate branch');
});

test('concurrent duplicate start has at most one success event and HTTP exposes stable scope errors', async t => {
  const f = await setup(t);
  const outcomes = await Promise.allSettled([f.stage.actOnStage('start', { ...ctx, stageKey: 'brief' }), f.stage.actOnStage('start', { ...ctx, stageKey: 'brief' })]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await f.stage.stageEvents(ctx)).length, 1);
  const response = await f.post('stageOrchestrator/read', { projectId: 2, scriptId: 10 }, 404);
  assert.equal(response.reason, 'PROFILE_SCOPE_INVALID');
  const profile = await f.post('productionProfiles/resolve', { projectId: 1 });
  assert.equal(profile.version, 'v1');
});

test('stage mutation and immutable event share one transaction', async t => {
  const f = await setup(t);
  await f.raw.raw("CREATE TRIGGER reject_stage_event BEFORE INSERT ON o_stageEvent BEGIN SELECT RAISE(ABORT, 'event unavailable'); END");
  await assert.rejects(f.stage.actOnStage('start', { ...ctx, stageKey: 'brief' }));
  assert.equal(await f.db('o_stageRun').where({ projectId: 1, scriptId: 10 }).first(), undefined);
  assert.equal((await f.stage.stageEvents(ctx)).length, 0);
});

test('stage audit events cannot be updated or deleted', async t => {
  const f = await setup(t);
  await f.stage.actOnStage('start', { ...ctx, stageKey: 'brief' });
  const event = (await f.stage.stageEvents(ctx))[0];
  await assert.rejects(f.db('o_stageEvent').where({ id: event.id }).update({ reason: 'rewritten' }));
  await assert.rejects(f.db('o_stageEvent').where({ id: event.id }).delete());
  assert.equal((await f.stage.stageEvents(ctx)).length, 1);
});

test('unknown stage Gate and real Gate database failure appear as blockers and fail closed', async t => {
  const f = await setup(t);
  await f.registry.createFamily({ profileKey: 'unknown-gate', displayName: 'Unknown Gate', description: '' });
  const definition = mini({ stages: [{ ...mini().stages[0], entryGateKey: 'future.unregistered' }], transitions: [] });
  await f.registry.createVersion({ profileKey: 'unknown-gate', definition });
  await f.registry.activateVersion({ profileKey: 'unknown-gate', version: 'v1' });
  await f.registry.bindProfile({ projectId: 3, profileKey: 'unknown-gate', version: 'v1' });
  const state = await f.stage.readOrchestrator({ projectId: 3, scriptId: 30 });
  assert.deepEqual(state.readyStages, []);
  assert.match(state.stages[0].blockerReasons.join(' '), /GATE_ADAPTER_NOT_REGISTERED/);
  await assert.rejects(f.stage.actOnStage('start', { projectId: 3, scriptId: 30, stageKey: 'a' }), e => e.code === 'GATE_ADAPTER_NOT_REGISTERED');
  await f.db.schema.dropTable('o_advertisementAssetPlan');
  const failing = await f.stage.readOrchestrator(ctx);
  assert.equal(failing.stages.find(s => s.stageKey === 'asset-preparation').exitGate.code, 'STAGE_GATE_UNAVAILABLE');
});

test('concurrent activation retains at most one ACTIVE version', async t => {
  const f = await setup(t);
  await f.registry.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  await f.registry.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  await Promise.allSettled(['v2', 'v3'].map(version => f.registry.activateVersion({ profileKey: 'advertisement', version })));
  const active = await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', status: 'ACTIVE' });
  assert.equal(active.length, 1);
});

test('failed activation rolls back deprecation of the previous ACTIVE version', async t => {
  const f = await setup(t);
  await f.registry.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  await f.raw.raw("CREATE TRIGGER reject_v2_activation BEFORE UPDATE ON o_productionProfileVersion WHEN NEW.version = 2 AND NEW.status = 'ACTIVE' BEGIN SELECT RAISE(ABORT, 'activation unavailable'); END");
  await assert.rejects(f.registry.activateVersion({ profileKey: 'advertisement', version: 'v2' }));
  const rows = await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement' });
  assert.equal(rows.find(row => row.version === 1).status, 'ACTIVE');
  assert.equal(rows.find(row => row.version === 2).status, 'DRAFT');
});
