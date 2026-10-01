const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./composite-fixture.cjs');

const scope = { projectId: 1, scriptId: 10 };
const stage = (stageKey, uiOrder, exitGateKey = null) => ({
  stageKey, displayName: stageKey, description: '', required: true, allowSkip: false,
  uiOrder, entryGateKey: null, exitGateKey, operationKeys: [],
});
const graph = {
  schemaVersion: 2, runtimeControl: 'ENFORCED', initialStageKey: 'root',
  stages: [stage('root', 10), stage('storyboard-board', 20), stage('independent', 30),
    stage('supervisor-review', 40, 'supervisor.storyboard-approved.v2'), stage('image-production', 50)],
  transitions: [
    { fromStageKey: 'root', toStageKey: 'storyboard-board' },
    { fromStageKey: 'root', toStageKey: 'independent' },
    { fromStageKey: 'storyboard-board', toStageKey: 'supervisor-review' },
    { fromStageKey: 'supervisor-review', toStageKey: 'image-production' },
  ],
};
const complete = (overrides = {}) => ({
  track: 'Main', duration: 3, prompt: 'New shot', videoDesc: 'Screen',
  productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1,
  referenceAssetIds: [], referenceAssetGroupIds: [], linkedAssetIds: [1], ...overrides,
});

async function setup(t) {
  const f = await fixture(t);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  const profiles = f.load('services/orchestrator/profileRegistry');
  await profiles.createVersion({ profileKey: 'advertisement', definition: graph });
  await profiles.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  const created = await f.create();
  await profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  // These are fixture rows for read-only Preview scenarios. Once V2 is bound,
  // the real legacy add endpoint correctly requires controlled Confirm.
  f.create = async overrides => {
    const item = f.item(overrides);
    const max = await f.db('o_storyboard').where(scope).max('index as value').first();
    const [id] = await f.db('o_storyboard').insert({ ...scope, trackId: created.trackId,
      track: item.track, index: Number(max?.value ?? -1) + 1, prompt: item.prompt,
      videoDesc: item.videoDesc, duration: String(item.duration), state: item.state,
      filePath: '', reason: '', shouldGenerateImage: item.shouldGenerateImage,
      productionSpec: JSON.stringify({ schemaVersion: 1, productionMode: item.productionMode,
        primaryAssetId: item.primaryAssetId, referenceAssetIds: item.referenceAssetIds,
        referenceAssetGroupIds: item.referenceAssetGroupIds, promptSkillId: item.promptSkillId,
        promptSkillVersion: item.promptSkillVersion, capabilityId: item.capabilityId }) });
    if (item.associateAssetsIds.length) await f.db('o_assets2Storyboard').insert(
      item.associateAssetsIds.map(assetId => ({ storyboardId: id, assetId })));
    return f.db('o_storyboard').where({ id }).first();
  };
  const app = express(); app.use(express.json());
  app.use('/api/stageOrchestrator', f.load('routes/stageOrchestrator/index').default);
  const server = app.listen(0, '127.0.0.1');
  await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(changeSet, status = 200, extra = {}) {
    const body = { schemaVersion: 1, revisionId: randomUUID(), ...scope, revisionKey: 'storyboard.semantic.v2', changeSet, ...extra };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stageOrchestrator/revision/preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json.data ?? json;
  }
  async function state() {
    const tables = (await f.raw.raw("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'o_%' ORDER BY name"))
      .map(row => row.name);
    const contents = {};
    for (const table of tables) contents[table] = await f.db(table).orderByRaw('rowid ASC');
    return contents;
  }
  return { ...f, profiles, storyboardId: created.id, post, state };
}

test('HTTP Preview shares B1 hash, is deterministic and performs zero writes or external work', async t => {
  const f = await setup(t);
  const before = await f.state();
  const changeSet = { operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'Edited intent' } }] };
  const a = await f.post(changeSet);
  const b = await f.post(changeSet);
  const registry = f.load('services/supervisor/registry');
  const accepted = await registry.readTarget(f.db, registry.reviewDefinition('storyboard.semantic-approval.v2'), 1, 10);
  assert.equal(a.sourceTargetHash, accepted.targetHash);
  // Frozen pre-B3 Semantic V2 fixture hash; not derived from the current adapter.
  assert.equal(a.sourceTargetHash, 'fc0beaa529eb774098a7aa1e92ea56662159229f09e6016c9ea479fcdd04a21b');
  assert.equal(a.previewHash, b.previewHash);
  assert.equal(a.proposedSemanticHash, b.proposedSemanticHash);
  assert.equal(a.outputImpact[0].sourceChanged, true);
  assert.equal(a.outputImpact[0].currentSourceHash,
    (await f.db.transaction(q => f.load('services/productionAttempt').captureStoryboardImageSource(q,
      { ...scope, storyboardId: f.storyboardId }))).sourceHash);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('EDIT/ADD/RETIRE/REORDER are plans with logical clientRef and full-order validation', async t => {
  const f = await setup(t);
  const second = await f.create({ prompt: 'Second', associateAssetsIds: [1] });
  const add = { type: 'ADD', clientRef: 'addedA', storyboard: complete() };
  const operations = [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { track: 'Cut', duration: 4, linkedAssetIds: [1] } },
    { type: 'RETIRE', storyboardId: second.id }, add,
    { type: 'REORDER', order: [{ clientRef: 'addedA' }, { storyboardId: f.storyboardId }] }];
  const before = await f.state();
  const value = await f.post({ operations });
  assert.equal((await f.post({ operations })).previewHash, value.previewHash);
  assert.deepEqual(value.proposedSemantic.map(row => row.clientRef ?? row.id), ['addedA', f.storyboardId]);
  assert.equal(value.proposedSemantic[0].id, undefined);
  assert.match(value.proposedSemanticHash, /^[a-f0-9]{64}$/);
  assert.equal(value.outputImpact.find(row => row.storyboardId === second.id).retired, true);
  assert.deepEqual(await f.state(), before);
  await f.post({ operations: [add, { type: 'REORDER', order: [{ clientRef: 'addedA' }] }] }, 409);
  await f.post({ operations: [add, add] }, 409);
  await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'x' } },
    { type: 'RETIRE', storyboardId: f.storyboardId }] }, 409);
  await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'A shot' } }] }, 409);
  await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { primaryAssetId: 2 } }] }, 409);
  await f.post({ operations: [{ type: 'EDIT', storyboardId: second.id, patch: { duration: -1 } }] }, 400);
  await f.post({ operations: [{ type: 'EDIT', storyboardId: 99999, patch: { prompt: 'other' } }] }, 409);
  assert.deepEqual(await f.state(), before);
});

test('exact branched DAG and implicit PENDING yield only planned transitions; drift changes hash', async t => {
  const f = await setup(t);
  const changeSet = { operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { videoDesc: 'New video description' } }] };
  const base = await f.post(changeSet);
  assert.deepEqual(base.stageTransitions, []);
  const exact = { ...scope, profileKey: 'advertisement', profileVersion: 2 };
  await f.db('o_stageRun').insert([
    { ...exact, stageKey: 'storyboard-board', state: 'COMPLETED', updatedAt: 1 },
    { ...exact, stageKey: 'supervisor-review', state: 'COMPLETED', updatedAt: 2 },
    { ...exact, stageKey: 'independent', state: 'COMPLETED', updatedAt: 3 },
  ]);
  const protectedPreview = await f.post(changeSet);
  assert.notEqual(protectedPreview.previewHash, base.previewHash);
  assert.deepEqual(protectedPreview.stageTransitions.map(row => row.stageKey), ['storyboard-board', 'supervisor-review']);
  assert.equal(protectedPreview.descendantStageKeys.includes('independent'), false);
  assert.equal(protectedPreview.stageTransitions.some(row => row.stageKey === 'image-production'), false);
  await f.db('o_stageRun').where({ ...exact, stageKey: 'independent' }).update({ state: 'IN_PROGRESS', updatedAt: 4 });
  const unrelated = await f.post(changeSet);
  assert.equal(unrelated.previewHash, protectedPreview.previewHash);
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ productionSpec: JSON.stringify({
    schemaVersion: 1, productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null,
    referenceAssetIds: [], referenceAssetGroupIds: [], promptSkillId: null, promptSkillVersion: null, capabilityId: null,
  }) });
  const modePreview = await f.post(changeSet);
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ imagePrompt: 'Execution-only' });
  const execution = await f.post(changeSet);
  assert.equal(execution.sourceTargetHash, modePreview.sourceTargetHash);
  assert.notEqual(execution.previewHash, modePreview.previewHash);
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ duration: '5' });
  const duration = await f.post(changeSet);
  assert.notEqual(duration.sourceTargetHash, execution.sourceTargetHash);
  assert.notEqual(duration.previewHash, execution.previewHash);
});

test('denied and exceptional paths leave temporary SQLite unchanged; Legacy remains unmodified', async t => {
  const f = await setup(t);
  const before = await f.state();
  await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'x' } }] },
    400, { suppliedTargetHash: 'forbidden' });
  await f.post({ operations: [{ type: 'ADD', clientRef: 'x', storyboard: complete({ primaryAssetId: 3 }) }] }, 409);
  assert.deepEqual(await f.state(), before);
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ productionSpec: '{invalid' });
  const corrupt = await f.state();
  await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'x' } }] }, 500);
  assert.deepEqual(await f.state(), corrupt);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('attempt ownership, exact Profile and source provenance drift invalidate Preview without writes', async t => {
  const f = await setup(t);
  const changeSet = { operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { duration: 5 } }] };
  const initial = await f.post(changeSet);
  const reviews = f.load('services/supervisor/review');
  const reviewInput = { ...scope, reviewKey: 'storyboard.semantic-approval.v2' };
  const target = await reviews.targetRead(reviewInput);
  await reviews.decide({ ...reviewInput, expectedTargetHash: target.target.targetHash,
    expectedControlContextHash: target.controlContextHash, decision: 'PASS', summary: 'Reviewed', issues: [] },
    { id: 1, name: 'Reviewer' });
  const reviewed = await f.post(changeSet);
  assert.notEqual(reviewed.previewHash, initial.previewHash);
  const profile = await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', version: 2 }).first();
  const attemptId = randomUUID();
  await f.db('o_productionAttempt').insert({
    attemptId, ...scope, profileKey: 'advertisement', profileVersion: 2,
    profileDefinitionHash: profile.definitionHash, recipeKey: null, recipeVersion: null, recipeDefinitionHash: null,
    stageKey: 'image-production', operationKey: 'storyboard.image.generate',
    subjectType: 'STORYBOARD_IMAGE', subjectId: f.storyboardId,
    sourceAdapterKey: 'storyboard.image-source.v1', sourceHash: 'source', sourceSnapshot: '{}',
    producerType: 'REAL_ASSET_DIRECT', producerRef: null, producerInput: '{}',
    controlContextHash: 'control', controlSnapshot: '{}', status: 'RUNNING',
    startedAt: 1, updatedAt: 1,
  });
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ activeImageAttemptId: attemptId });
  const active = await f.post(changeSet);
  assert.notEqual(active.previewHash, reviewed.previewHash);
  assert.deepEqual(active.affectedActiveAttempts.map(row => row.attemptId), [attemptId]);
  const [receipt] = await f.db('o_assetUploadSource').where({ projectId: 1, assetId: 1 });
  await f.db('o_assetUploadSource').where({ projectId: 1, assetId: 1 }).update({ uploadedAt: Number(receipt.uploadedAt) + 1 });
  const provenance = await f.post(changeSet);
  assert.notEqual(provenance.previewHash, active.previewHash);
  assert.notEqual(provenance.outputImpact[0].currentSourceHash, active.outputImpact[0].currentSourceHash);
  await f.db('o_productionAttempt').where({ attemptId }).update({ status: 'STALE' });
  const inconsistent = await f.state();
  await f.post(changeSet, 409);
  assert.deepEqual(await f.state(), inconsistent);
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ activeImageAttemptId: null });
  const terminal = await f.post(changeSet);
  assert.notEqual(terminal.previewHash, provenance.previewHash);
  assert.equal(terminal.affectedActiveAttempts.length, 0);
  await f.profiles.createVersion({ profileKey: 'advertisement', sourceVersion: 'v2' });
  const v3 = await f.profiles.getProfile({ profileKey: 'advertisement', version: 'v3' });
  await f.profiles.editVersion({ profileKey: 'advertisement', version: 'v3',
    definition: { ...v3.versions[0].definition,
      stages: v3.versions[0].definition.stages.map(s => ({ ...s, description: s.stageKey === 'independent' ? 'changed' : s.description })) } });
  await f.profiles.activateVersion({ profileKey: 'advertisement', version: 'v3' });
  await f.profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v3' });
  const changedProfile = await f.post(changeSet);
  assert.notEqual(changedProfile.previewHash, terminal.previewHash);
  assert.equal(changedProfile.profile.version, 'v3');
});

test('reorder and duration changes retain accepted B2 source meaning; no model is required for AI planning', async t => {
  const f = await setup(t);
  const second = await f.create({ prompt: 'Second' });
  const reorder = await f.post({ operations: [{ type: 'REORDER',
    order: [{ storyboardId: second.id }, { storyboardId: f.storyboardId }] }] });
  assert.equal(reorder.outputImpact.length, 2);
  assert.ok(reorder.outputImpact.every(row => row.sourceChanged));
  const duration = await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { duration: 4 } }] });
  assert.equal(duration.outputImpact.find(row => row.storyboardId === f.storyboardId).sourceChanged, true);
  const ai = await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId,
    patch: { productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null, linkedAssetIds: [] } }] });
  assert.equal(ai.proposedSemantic.find(row => row.id === f.storyboardId).productionMode, 'AI_TEXT_TO_IMAGE');
  assert.equal(f.calls.length, 0);
  await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId,
    patch: { referenceAssetGroupIds: ['group-from-other-unit'] } }] }, 409);
});

test('V1 Legacy Preview rejects without adoption or creating control rows', async t => {
  const f = await setup(t);
  const before = await f.state();
  await f.post({ operations: [{ type: 'ADD', clientRef: 'legacy', storyboard: complete({ primaryAssetId: 3, linkedAssetIds: [3] }) }] },
    409, { projectId: 2, scriptId: 20 });
  assert.deepEqual(await f.state(), before);
  assert.equal(await f.db('o_projectProfileBinding').where({ projectId: 2 }).first(), undefined);
});

test('batched source capture keeps query count bounded when shot count grows', async t => {
  const f = await setup(t);
  const queries = [];
  const listener = value => queries.push(value.sql);
  f.raw.on('query', listener);
  const changeSet = { operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'Batch check' } }] };
  await f.post(changeSet);
  const one = queries.length;
  queries.length = 0;
  for (let i = 0; i < 5; i++) await f.create({ prompt: 'Extra ' + i });
  queries.length = 0;
  await f.post(changeSet);
  const many = queries.length;
  f.raw.off('query', listener);
  assert.ok(many <= one + 2, `one=${one} many=${many}`);
  assert.equal(queries.filter(sql => sql.includes('o_storyboard')).length <= 3, true);
});

test('Preview can report a stale current image becoming CURRENT again when proposed source matches B2', async t => {
  const f = await setup(t);
  const source = await f.db.transaction(q => f.load('services/productionAttempt').captureStoryboardImageSource(q,
    { ...scope, storyboardId: f.storyboardId }));
  const profile = await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', version: 2 }).first();
  const attemptId = randomUUID();
  await f.db('o_productionAttempt').insert({
    attemptId, ...scope, profileKey: 'advertisement', profileVersion: 2, profileDefinitionHash: profile.definitionHash,
    recipeKey: null, recipeVersion: null, recipeDefinitionHash: null, stageKey: 'image-production',
    operationKey: 'storyboard.image.generate', subjectType: 'STORYBOARD_IMAGE', subjectId: f.storyboardId,
    sourceAdapterKey: 'storyboard.image-source.v1', sourceHash: source.sourceHash,
    sourceSnapshot: JSON.stringify(source.snapshot), producerType: 'REAL_ASSET_DIRECT', producerRef: null,
    producerInput: '{}', controlContextHash: 'control', controlSnapshot: '{}', status: 'SUCCEEDED',
    outputRef: JSON.stringify({ filePath: '/generated/1' }), startedAt: 1, completedAt: 2, updatedAt: 2,
  });
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({
    currentImageAttemptId: attemptId, filePath: '/generated/1', state: '已完成', prompt: 'Changed',
  });
  const result = await f.post({ operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'A shot' } }] });
  assert.equal(result.outputImpact[0].beforeFreshness, 'STALE');
  assert.equal(result.outputImpact[0].afterFreshness, 'CURRENT');
  assert.equal((await f.db('o_storyboard').where({ id: f.storyboardId }).first()).prompt, 'Changed');
});

test('ADD can preview an empty production unit without reserving a storyboard id', async t => {
  const f = await setup(t);
  await f.db('o_assets2Storyboard').where({ storyboardId: f.storyboardId }).delete();
  await f.db('o_storyboard').where({ id: f.storyboardId }).delete();
  const before = await f.state();
  const value = await f.post({ operations: [{ type: 'ADD', clientRef: 'first', storyboard: complete({
    productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null, linkedAssetIds: [],
  }) }] });
  assert.equal(value.proposedSemantic.length, 1);
  assert.equal(value.proposedSemantic[0].clientRef, 'first');
  assert.equal(value.proposedSemantic[0].id, undefined);
  assert.deepEqual(await f.state(), before);
});

test('HF1 F1: untouched raw null index stays CURRENT and proposed Source matches an explicitly patched SQLite fixture', async t => {
  const f = await setup(t);
  const expected = await setup(t);
  const b = await f.create({ prompt: 'Second', associateAssetsIds: [1] });
  const expectedB = await expected.create({ prompt: 'Second', associateAssetsIds: [1] });
  assert.equal(b.id, expectedB.id);
  const [receipt] = await f.db('o_assetUploadSource').where({ assetId: 1, imageId: 1 });
  await expected.db('o_assetUploadSource').where({ assetId: 1, imageId: 1 }).update({ uploadedAt: receipt.uploadedAt });
  for (const fixture of [f, expected]) {
    await fixture.db('o_storyboard').where({ id: fixture.storyboardId }).update({ index: null });
    await fixture.db('o_storyboard').where({ id: b.id }).update({ index: 7 });
  }
  const source = await f.db.transaction(q => f.load('services/productionAttempt').captureStoryboardImageSource(q,
    { ...scope, storyboardId: f.storyboardId }));
  const profile = await f.db('o_productionProfileVersion').where({ profileKey: 'advertisement', version: 2 }).first();
  const attemptId = randomUUID();
  await f.db('o_productionAttempt').insert({
    attemptId, ...scope, profileKey: 'advertisement', profileVersion: 2, profileDefinitionHash: profile.definitionHash,
    recipeKey: null, recipeVersion: null, recipeDefinitionHash: null, stageKey: 'image-production',
    operationKey: 'storyboard.image.generate', subjectType: 'STORYBOARD_IMAGE', subjectId: f.storyboardId,
    sourceAdapterKey: 'storyboard.image-source.v1', sourceHash: source.sourceHash,
    sourceSnapshot: JSON.stringify(source.snapshot), producerType: 'REAL_ASSET_DIRECT', producerRef: null,
    producerInput: '{}', controlContextHash: 'control', controlSnapshot: '{}', status: 'SUCCEEDED',
    outputRef: JSON.stringify({ filePath: '/generated/current' }), startedAt: 1, completedAt: 2, updatedAt: 2,
  });
  await f.db('o_storyboard').where({ id: f.storyboardId }).update({ currentImageAttemptId: attemptId, filePath: '/generated/current' });
  const before = await f.state();
  for (const patch of [{ prompt: null }, { prompt: '' }, { videoDesc: null }, { videoDesc: '' }, { track: '' }]) {
    const result = await f.post({ operations: [{ type: 'EDIT', storyboardId: b.id, patch }] });
    const aImpact = result.outputImpact.find(row => row.storyboardId === f.storyboardId);
    assert.equal(aImpact.sourceChanged, false, JSON.stringify(patch));
    assert.equal(aImpact.afterFreshness, 'CURRENT', JSON.stringify(patch));
    await expected.db('o_storyboard').where({ id: b.id }).update(patch);
    const accepted = await expected.db.transaction(q => expected.load('services/productionAttempt').captureStoryboardImageSource(q,
      { ...scope, storyboardId: b.id }));
    const bImpact = result.outputImpact.find(row => row.storyboardId === b.id);
    assert.equal(bImpact.proposedSourceHash, accepted.sourceHash, JSON.stringify(patch));
    await expected.db('o_storyboard').where({ id: b.id }).update({ prompt: 'Second', videoDesc: 'Screen', track: 'Main' });
  }
  assert.deepEqual(await f.state(), before);
});

test('HF1 F2: explicit and omitted ADD indices append in operation order, with or without complete REORDER', async t => {
  const f = await setup(t);
  const adds = [
    { type: 'ADD', clientRef: 'explicit', storyboard: complete({ index: 1 }) },
    { type: 'ADD', clientRef: 'implicit', storyboard: complete() },
    { type: 'ADD', clientRef: 'later', storyboard: complete({ index: 5 }) },
    { type: 'ADD', clientRef: 'last', storyboard: complete() },
  ];
  const before = await f.state();
  const result = await f.post({ operations: adds });
  assert.deepEqual(result.proposedSemantic.map(row => row.index), [0, 1, 2, 5, 6]);
  const ordered = await f.post({ operations: [...adds, { type: 'REORDER', order: [
    { clientRef: 'last' }, { storyboardId: f.storyboardId }, { clientRef: 'later' },
    { clientRef: 'implicit' }, { clientRef: 'explicit' },
  ] }] });
  assert.deepEqual(ordered.proposedSemantic.map(row => row.clientRef ?? row.id),
    ['last', f.storyboardId, 'later', 'implicit', 'explicit']);
  assert.deepEqual(ordered.proposedSemantic.map(row => row.index), [0, 1, 2, 5, 6]);
  await f.post({ operations: [{ type: 'ADD', clientRef: 'conflict', storyboard: complete({ index: 0 }) }] }, 409);
  await f.post({ operations: [{ type: 'ADD', clientRef: 'conflict', storyboard: complete({ index: 0 }) },
    { type: 'REORDER', order: [{ clientRef: 'conflict' }, { storyboardId: f.storyboardId }] }] }, 409);
  assert.deepEqual(await f.state(), before);
});

test('HF1 F3: irrelevant historical receipts do not alter Preview and receipt rows read stay bounded', async t => {
  const f = await setup(t);
  const changeSet = { operations: [{ type: 'EDIT', storyboardId: f.storyboardId, patch: { prompt: 'Changed' } }] };
  const baseline = await f.post(changeSet);
  const history = Array.from({ length: 40 }, (_, n) => ({ id: n + 100, assetsId: 1,
    filePath: `/historical/${n}`, state: '已完成', model: null }));
  await f.db('o_image').insert(history);
  await f.db('o_assetUploadSource').insert(history.map(image => ({ projectId: 1, assetId: 1,
    imageId: image.id, filePath: image.filePath, uploadedAt: image.id })));
  const received = [];
  const listener = (response, obj) => { if (obj?.sql?.includes('o_assetUploadSource')) received.push(response.length); };
  f.raw.on('query-response', listener);
  let after;
  try { after = await f.post(changeSet); } finally { f.raw.off('query-response', listener); }
  assert.equal(after.previewHash, baseline.previewHash);
  assert.deepEqual(received, [1]);
  await f.db('o_assetUploadSource').where({ assetId: 1, imageId: 1 }).update({ uploadedAt: 123456789 });
  const changed = await f.post(changeSet);
  assert.notEqual(changed.previewHash, baseline.previewHash);
  assert.notEqual(changed.outputImpact[0].currentSourceHash, baseline.outputImpact[0].currentSourceHash);
});
