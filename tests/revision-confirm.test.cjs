const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { fixture } = require('./composite-fixture.cjs');

const stage = (stageKey, uiOrder, exitGateKey = null) => ({ stageKey, displayName: stageKey,
  description: '', required: true, allowSkip: false, uiOrder, entryGateKey: null, exitGateKey, operationKeys: [] });
const graph = { schemaVersion: 2, runtimeControl: 'ENFORCED', initialStageKey: 'root',
  stages: [stage('root', 1), stage('storyboard-board', 2), stage('supervisor-review', 3, 'supervisor.storyboard-approved.v2'), stage('image-production', 4)],
  transitions: [{ fromStageKey: 'root', toStageKey: 'storyboard-board' },
    { fromStageKey: 'storyboard-board', toStageKey: 'supervisor-review' },
    { fromStageKey: 'supervisor-review', toStageKey: 'image-production' }] };

async function setup(t, definition = graph) {
  const f = await fixture(t);
  await f.raw.schema.createTable('o_user', tb => { tb.integer('id').primary(); tb.text('name'); });
  await f.db('o_user').insert({ id: 7, name: 'Studio Owner' });
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  await f.load('lib/compositeAttemptSchema').initializeCompositeAttemptSchema(f.db);
  await f.load('lib/revisionSchema').initializeRevisionSchema(f.db);
  await f.load('lib/revisionSchema').initializeRevisionSchema(f.db);
  const profiles = f.load('services/orchestrator/profileRegistry');
  await profiles.createVersion({ profileKey: 'advertisement', definition });
  await profiles.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  const shot = await f.create();
  await profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  const oldEnabled = process.env.DS_REVISION_CONFIRM_ENABLED;
  const oldOwner = process.env.DS_STUDIO_OWNER_USER_ID;
  process.env.DS_REVISION_CONFIRM_ENABLED = 'true'; process.env.DS_STUDIO_OWNER_USER_ID = '7';
  t.after(() => { if (oldEnabled === undefined) delete process.env.DS_REVISION_CONFIRM_ENABLED;
    else process.env.DS_REVISION_CONFIRM_ENABLED = oldEnabled;
    if (oldOwner === undefined) delete process.env.DS_STUDIO_OWNER_USER_ID;
    else process.env.DS_STUDIO_OWNER_USER_ID = oldOwner; });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7, name: 'Studio Owner' }; next(); });
  app.use('/api/stageOrchestrator', f.load('routes/stageOrchestrator/index').default);
  f.utils.oss.getFileUrl = async value => value;
  app.use('/api/production/workbench/getGenerateData', f.load('routes/production/workbench/getGenerateData').default);
  app.use('/api/production/workbench/selectVideo', f.load('routes/production/workbench/selectVideo').default);
  app.use('/api/production/saveFlowData', f.load('routes/production/saveFlowData').default);
  app.use('/api/production/getFlowData', f.load('routes/production/getFlowData').default);
  app.use('/api/production/storyboard/editStoryboardInfo', f.load('routes/production/storyboard/editStoryboardInfo').default);
  app.use('/api/production/storyboard/removeFrame', f.load('routes/production/storyboard/removeFrame').default);
  app.use('/api/production/storyboard/batchDelete', f.load('routes/production/storyboard/batchDelete').default);
  app.use('/api/production/getStoryboardData', f.load('routes/production/getStoryboardData').default);
  app.use('/api/production/workbench/getVideoList', f.load('routes/production/workbench/getVideoList').default);
  app.use('/api/production/workbench/delVideo', f.load('routes/production/workbench/delVideo').default);
  app.use('/api/production/workbench/deleteTrack', f.load('routes/production/workbench/deleteTrack').default);
  app.use('/api/production/workbench/updateVideoPrompt', f.load('routes/production/workbench/updateVideoPrompt').default);
  app.use('/api/production/workbench/updateVideoDuration', f.load('routes/production/workbench/updateVideoDuration').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/stageOrchestrator/revision/`;
  async function post(action, body, status = 200) {
    const response = await fetch(url + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json));
    return json.data ?? json;
  }
  async function workbench(action, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/production/workbench/${action}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json));
    return json.data ?? json;
  }
  async function production(action, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/production/${action}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json));
    return json.data ?? json;
  }
  const base = changeSet => ({ schemaVersion: 1, revisionId: randomUUID(), projectId: 1, scriptId: 10,
    revisionKey: 'storyboard.semantic.v2', changeSet });
  async function preview(changeSet) { const command = base(changeSet); return { command, result: await post('preview', command) }; }
  async function confirm(command, result, status = 200) {
    return post('confirm', { ...command, previewHash: result.previewHash,
      expectedRevisionEpoch: result.baseRevisionEpoch, humanReason: 'Human-approved semantic revision' }, status);
  }
  return { ...f, shot, post, workbench, production, preview, confirm };
}

test('explicit migration is repeatable; Confirm EDIT is atomic, replayable, and epoch-bound', async t => {
  const f = await setup(t);
  const { command, result } = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Approved new semantic' } }] });
  assert.equal(result.baseRevisionEpoch, 0);
  const applied = await f.confirm(command, result);
  assert.equal(applied.delivery, 'APPLIED'); assert.equal(applied.epochAfter, 1);
  assert.equal((await f.db('o_storyboard').where({ id: f.shot.id }).first()).prompt, 'Approved new semantic');
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 1);
  assert.equal((await f.db('o_productionRevision')).length, 1);
  const replay = await f.confirm(command, result);
  assert.equal(replay.delivery, 'REPLAYED'); assert.equal(replay.resultTargetHash, applied.resultTargetHash);
  assert.equal((await f.db('o_productionRevision')).length, 1);
  const conflict = await f.post('confirm', { ...command, previewHash: result.previewHash,
    expectedRevisionEpoch: 0, humanReason: 'different reason' }, 409);
  assert.equal(conflict.reason, 'REVISION_ID_CONFLICT');
});

test('revision audit and work guard reject invalid epochs, states and deletion', async t => {
  const f = await setup(t);
  const scope = { projectId: 1, scriptId: 10 };
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const [guard] = await work.admitRevisionWork(scope, 'VIDEO_PROMPT', [
    { trackId: f.shot.trackId, references: [] }]);
  await assert.rejects(() => f.db('o_revisionWorkGuard').where({ guardId: guard.guardId }).update({ state: 'UNKNOWN' }));
  await assert.rejects(() => f.db('o_revisionWorkGuard').where({ guardId: guard.guardId }).delete());
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Audited' } }] });
  await work.fenceRevisionWork(scope, guard.guardId, { id: 7 }, 'test recovery');
  await f.confirm(draft.command, draft.result);
  await assert.rejects(() => f.db('o_productionRevision').where({ revisionId: draft.command.revisionId }).update({ epochAfter: 9 }));
  await assert.rejects(() => f.db('o_productionRevision').where({ revisionId: draft.command.revisionId }).delete());
});

test('RETIRE keeps identity/history and stale Preview leaves no partial writes', async t => {
  const f = await setup(t);
  const { command, result } = await f.preview({ operations: [{ type: 'RETIRE', storyboardId: f.shot.id }] });
  await f.db('o_script').where({ id: 10 }).update({ revisionEpoch: 1 });
  const stale = await f.confirm(command, result, 409);
  assert.equal(stale.reason, 'REVISION_PREVIEW_STALE');
  assert.equal((await f.db('o_storyboard').where({ id: f.shot.id }).first()).retiredAt, null);
  assert.equal((await f.db('o_productionRevision')).length, 0);
  await f.db('o_script').where({ id: 10 }).update({ revisionEpoch: 0 });
  const fresh = await f.preview({ operations: [{ type: 'RETIRE', storyboardId: f.shot.id }] });
  const applied = await f.confirm(fresh.command, fresh.result);
  assert.equal(applied.epochAfter, 1);
  assert.equal((await f.db('o_storyboard').where({ id: f.shot.id }).first()).retiredByRevisionId, fresh.command.revisionId);
  const target = f.load('services/supervisor/registry');
  await assert.rejects(() => target.readTarget(f.db, target.reviewDefinition('storyboard.semantic-approval.v2'), 1, 10),
    error => error.code === 'SUPERVISOR_TARGET_EMPTY');
});

test('ADD and REORDER persist exact semantic snapshot without changing unrelated execution duration', async t => {
  const f = await setup(t);
  const beforeTrack = await f.db('o_videoTrack').where({ id: f.shot.trackId }).first();
  const changeSet = { operations: [{ type: 'ADD', clientRef: 'new-shot', storyboard: {
    index: 1, track: 'new-group', duration: 3, prompt: 'Second semantic shot', videoDesc: '',
    productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null, referenceAssetIds: [],
    referenceAssetGroupIds: [], linkedAssetIds: [] } },
  { type: 'REORDER', order: [{ storyboardId: f.shot.id }, { clientRef: 'new-shot' }] }] };
  const { command, result } = await f.preview(changeSet);
  const applied = await f.confirm(command, result);
  const added = await f.db('o_storyboard').where({ id: applied.clientRefToId['new-shot'] }).first();
  assert.equal(added.prompt, 'Second semantic shot');
  assert.equal(added.index, 1);
  assert.equal((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).duration, beforeTrack.duration);
  assert.equal(applied.resultTargetHash.length, 64);
});

test('durable video guard registers before producer and blocks Confirm until conditional settlement', async t => {
  const f = await setup(t);
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const scope = { projectId: 1, scriptId: 10 };
  const guards = await work.admitRevisionWork(scope, 'VIDEO_GENERATE', [
    { trackId: f.shot.trackId, references: [], videoPath: '/1/video/revision-guard-test.mp4' }]);
  assert.equal(guards.length, 1);
  const guard = guards[0];
  assert.equal((await f.db('o_revisionWorkGuard').where({ guardId: guard.guardId }).first()).state, 'ACTIVE');
  assert.equal((await f.db('o_video').where({ id: guard.videoId }).first()).revisionWorkGuardId, guard.guardId);
  const { command, result } = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'After video' } }] });
  const blocked = await f.confirm(command, result, 409);
  assert.equal(blocked.reason, 'REVISION_ASYNC_WORK_BLOCKED');
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 0);
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED'), 'SETTLED');
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED'), 'FENCED');
  const applied = await f.confirm(command, result);
  assert.equal(applied.epochAfter, 1);
  assert.equal((await f.db('o_video').where({ id: guard.videoId }).first()).state, '生成成功');
});

test('fencing an uncertain work guard permanently prevents its late callback from publishing', async t => {
  const f = await setup(t);
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const scope = { projectId: 1, scriptId: 10 };
  const [guard] = await work.admitRevisionWork(scope, 'VIDEO_GENERATE', [
    { trackId: f.shot.trackId, references: [], videoPath: '/1/video/fenced.mp4' }]);
  await f.db('o_revisionWorkGuard').where({ guardId: guard.guardId }).update({ state: 'UNCERTAIN' });
  const fenced = await work.fenceRevisionWork(scope, guard.guardId, { id: 7 }, 'confirmed stopped externally');
  assert.equal(fenced.state, 'FENCED');
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED'), 'FENCED');
  assert.equal((await f.db('o_video').where({ id: guard.videoId }).first()).state, '生成中');
});

test('a prior runtime owner and fenced prompt callback cannot publish or unblock Confirm implicitly', async t => {
  const f = await setup(t);
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const scope = { projectId: 1, scriptId: 10 };
  const [guard] = await work.admitRevisionWork(scope, 'VIDEO_PROMPT', [
    { trackId: f.shot.trackId, references: [] }]);
  await f.db('o_revisionWorkGuard').where({ guardId: guard.guardId }).update({ ownerRunId: 'older-process-owner' });
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED', { prompt: 'late old prompt' }), 'FENCED');
  assert.equal((await f.db('o_revisionWorkGuard').where({ guardId: guard.guardId }).first()).state, 'ACTIVE');
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'New semantic' } }] });
  assert.equal((await f.confirm(draft.command, draft.result, 409)).reason, 'REVISION_ASYNC_WORK_BLOCKED');
  await work.fenceRevisionWork(scope, guard.guardId, { id: 7 }, 'old process drained');
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED', { prompt: 'late old prompt' }), 'FENCED');
  assert.notEqual((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).prompt, 'late old prompt');
  assert.equal((await f.confirm(draft.command, draft.result)).delivery, 'APPLIED');
});

test('late audit insert failure rolls back semantic, track and epoch writes', async t => {
  const f = await setup(t);
  const { command, result } = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Must roll back', track: 'new-group' } }] });
  const before = await f.db('o_storyboard').where({ id: f.shot.id }).first();
  const tracksBefore = await f.db('o_videoTrack').count('* as value').first();
  await f.raw.raw("CREATE TRIGGER fail_revision_audit BEFORE INSERT ON o_productionRevision BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
  await f.confirm(command, result, 500);
  assert.deepEqual(await f.db('o_storyboard').where({ id: f.shot.id }).first(), before);
  assert.equal((await f.db('o_videoTrack').count('* as value').first()).value, tracksBefore.value);
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 0);
  assert.equal((await f.db('o_productionRevision')).length, 0);
});

test('A to B to A never revives an old V2 PASS; fresh epoch review can admit guarded work', async t => {
  const f = await setup(t);
  const reviews = f.load('services/supervisor/review');
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const scope = { projectId: 1, scriptId: 10 };
  const reviewKey = 'storyboard.semantic-approval.v2';
  async function pass(epoch) {
    const current = await reviews.targetRead({ ...scope, reviewKey });
    return reviews.decide({ ...scope, reviewKey, expectedTargetHash: current.target.targetHash,
      expectedControlContextHash: current.controlContextHash, expectedRevisionEpoch: epoch,
      decision: 'PASS', summary: 'Human approved', issues: [] }, { id: 7, name: 'Studio Owner' });
  }
  const original = (await f.db('o_storyboard').where({ id: f.shot.id }).first()).prompt;
  await pass(0);
  assert.equal((await reviews.resolveGate({ ...scope, reviewKey })).pass, true);
  const b = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'B semantic' } }] });
  await f.confirm(b.command, b.result);
  assert.equal((await reviews.resolveGate({ ...scope, reviewKey })).pass, false);
  const a = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: original } }] });
  await f.confirm(a.command, a.result);
  assert.equal((await reviews.resolveGate({ ...scope, reviewKey })).pass, false);
  await assert.rejects(() => work.admitRevisionWork(scope, 'VIDEO_GENERATE', [
    { trackId: f.shot.trackId, references: [], videoPath: '/1/video/denied.mp4' }]),
  error => error.code === 'REVISION_STAGE_REVIEW_REQUIRED');
  await f.db('o_stageRun').insert({ ...scope, profileKey: 'advertisement', profileVersion: 2,
    stageKey: 'storyboard-board', state: 'COMPLETED', updatedAt: Date.now() });
  await pass(2);
  const [guard] = await work.admitRevisionWork(scope, 'VIDEO_GENERATE', [
    { trackId: f.shot.trackId, references: [], videoPath: '/1/video/current.mp4' }]);
  assert.equal(guard.admittedEpoch, 2);
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED'), 'SETTLED');
});

test('a delayed human Supervisor decision from the old epoch leaves no new review', async t => {
  const f = await setup(t);
  const reviews = f.load('services/supervisor/review');
  const scope = { projectId: 1, scriptId: 10, reviewKey: 'storyboard.semantic-approval.v2' };
  const old = await reviews.targetRead(scope);
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Changed while reviewer was reading' } }] });
  await f.confirm(draft.command, draft.result);
  await assert.rejects(() => reviews.decide({ ...scope, expectedTargetHash: old.target.targetHash,
    expectedControlContextHash: old.controlContextHash, expectedRevisionEpoch: old.revisionEpoch,
    decision: 'PASS', summary: 'Too late', issues: [] }, { id: 7, name: 'Studio Owner' }),
  error => error.code === 'SUPERVISOR_REVISION_CHANGED');
  assert.equal((await f.db('o_supervisorReview').where({ projectId: 1, scriptId: 10 })).length, 0);
});

test('an AI Supervisor result arriving after Confirm cannot become a current review', async t => {
  const f = await setup(t);
  await f.load('lib/skillSchema').initializeSkillSchema(f.db);
  const registry = f.load('services/skillRegistry');
  const contract = f.load('services/skillContract');
  const skillId = 'supervisor.revision-race';
  await registry.createSkillFamily({ skillId, displayName: 'Revision race', skillType: 'SUPERVISOR',
    description: '', tags: [] });
  await registry.createDraft({ skillId, content: { ...contract.emptyTemplate('SUPERVISOR'),
    purpose: 'Review semantic plan', rules: ['Use current snapshot'], outputRequirements: ['Decision'] } });
  await registry.activateDraft({ skillId, version: 'v1' });
  await registry.saveBinding({ scopeType: 'SYSTEM', scopeKey: 'system', skillType: 'SUPERVISOR',
    skillId, skillVersion: 'v1', overrideText: null });
  const reviews = f.load('services/supervisor/review');
  const scope = { projectId: 1, scriptId: 10, reviewKey: 'storyboard.semantic-approval.v2' };
  const pre = await reviews.targetRead(scope);
  let reached, release;
  const modelReached = new Promise(resolve => { reached = resolve; });
  const continueModel = new Promise(resolve => { release = resolve; });
  const previousText = f.utils.Ai.Text;
  f.utils.Ai.Text = () => ({ trackedSession: async () => ({ modelReference: 'local:mock',
    invokeObject: async () => { reached(); await continueModel;
      return { object: { decision: 'PASS', summary: 'Late result', issues: [] } }; } }) });
  try {
    const pending = f.load('services/supervisor/aiReview').reviewAi({ ...scope,
      expectedTargetHash: pre.target.targetHash, expectedControlContextHash: pre.controlContextHash,
      expectedRevisionEpoch: pre.revisionEpoch });
    await modelReached;
    const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
      patch: { prompt: 'Changed before AI completion' } }] });
    await f.confirm(draft.command, draft.result);
    release();
    await assert.rejects(pending, error => error.code === 'SUPERVISOR_REVISION_CHANGED');
    assert.equal((await f.db('o_supervisorReview').where({ projectId: 1, scriptId: 10 })).length, 0);
  } finally { release(); f.utils.Ai.Text = previousText; }
});

test('old selected video remains historical after revision; a current guarded result can be selected', async t => {
  const f = await setup(t);
  const scope = { projectId: 1, scriptId: 10 };
  await f.db('o_project').where({ id: 1 }).update({ videoModel: 'vendor:video' });
  const [oldVideoId] = await f.db('o_video').insert({ ...scope, videoTrackId: f.shot.trackId,
    filePath: '/1/video/old.mp4', state: '生成成功', time: 1 });
  await f.db('o_videoTrack').where({ id: f.shot.trackId }).update({ videoId: oldVideoId });
  const change = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Revised shot' } }] });
  await f.confirm(change.command, change.result);
  const view = await f.workbench('getGenerateData', scope);
  const track = view.trackList.find(row => row.id === f.shot.trackId);
  assert.equal(track.selectVideoId, undefined);
  assert.equal(track.historicalSelectedVideoId, oldVideoId);
  assert.equal(track.videoList[0].revisionStatus, 'HISTORICAL');
  const reviews = f.load('services/supervisor/review');
  const reviewKey = 'storyboard.semantic-approval.v2';
  const target = await reviews.targetRead({ ...scope, reviewKey });
  await f.db('o_stageRun').insert({ ...scope, profileKey: 'advertisement', profileVersion: 2,
    stageKey: 'storyboard-board', state: 'COMPLETED', updatedAt: Date.now() });
  await reviews.decide({ ...scope, reviewKey, expectedTargetHash: target.target.targetHash,
    expectedControlContextHash: target.controlContextHash, expectedRevisionEpoch: 1,
    decision: 'PASS', summary: 'Human approved', issues: [] }, { id: 7, name: 'Studio Owner' });
  const denied = await f.workbench('selectVideo', { trackId: f.shot.trackId, videoId: oldVideoId }, 409);
  assert.equal(denied.code, 'REVISION_VIDEO_NOT_CURRENT', JSON.stringify(denied));
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const [guard] = await work.admitRevisionWork(scope, 'VIDEO_GENERATE', [
    { trackId: f.shot.trackId, references: [], videoPath: '/1/video/current.mp4' }]);
  assert.equal(await work.settleRevisionWork(scope, guard, 'SUCCEEDED'), 'SETTLED');
  await f.workbench('selectVideo', { trackId: f.shot.trackId, videoId: guard.videoId });
  const after = await f.workbench('getGenerateData', scope);
  const current = after.trackList.find(row => row.id === f.shot.trackId);
  assert.equal(current.selectVideoId, guard.videoId);
  assert.equal(current.videoList.find(row => row.id === guard.videoId).revisionStatus, 'CURRENT');
});

test('controlled workspace rejects mixed semantic save, accepts pure layout and never revives retired shots', async t => {
  const f = await setup(t);
  const scope = { projectId: 1, episodesId: 10 };
  const before = await f.db('o_storyboard').where({ id: f.shot.id }).first();
  const mixed = await f.production('saveFlowData', { ...scope, data: { storyboard: [{ id: before.id,
    index: before.index, prompt: 'Unauthorized edit', duration: Number(before.duration),
    associateAssetsIds: [1] }], workbench: { videoList: [] } } }, 409);
  assert.equal(mixed.code, 'CONTROLLED_REVISION_REQUIRED');
  assert.equal((await f.db('o_storyboard').where({ id: before.id }).first()).prompt, before.prompt);
  assert.equal((await f.db('o_agentWorkData').where({ ...scope, key: 'productionAgent' })).length, 0);
  await f.production('saveFlowData', { ...scope, data: { storyboard: [], workbench: { videoList: [] } } });
  const live = await f.production('getFlowData', scope);
  assert.equal(live.storyboard.length, 1);
  const retire = await f.preview({ operations: [{ type: 'RETIRE', storyboardId: before.id }] });
  await f.confirm(retire.command, retire.result);
  const after = await f.production('getFlowData', scope);
  assert.equal(after.storyboard.length, 0);
  assert.equal((await f.db('o_storyboard').where({ id: before.id }).first()).retiredByRevisionId, retire.command.revisionId);
});

test('legacy semantic mutation and physical deletion endpoints reject a controlled shot without partial writes', async t => {
  const f = await setup(t);
  const before = await f.db('o_storyboard').where({ id: f.shot.id }).first();
  const track = await f.db('o_videoTrack').where({ id: before.trackId }).first();
  const edit = await f.production('storyboard/editStoryboardInfo', { id: before.id, projectId: 1, scriptId: 10,
    prompt: 'Bypass attempt', videoDesc: before.videoDesc ?? '' }, 409);
  assert.equal(edit.code, 'CONTROLLED_REVISION_REQUIRED');
  const remove = await f.production('storyboard/removeFrame', { id: before.id }, 409);
  assert.equal(remove.code, 'CONTROLLED_REVISION_REQUIRED');
  const batch = await f.production('storyboard/batchDelete', { projectId: 1, ids: [before.id] }, 409);
  assert.equal(batch.code, 'CONTROLLED_REVISION_REQUIRED');
  assert.deepEqual(await f.db('o_storyboard').where({ id: before.id }).first(), before);
  assert.deepEqual(await f.db('o_videoTrack').where({ id: before.trackId }).first(), track);
});

test('retired storyboard and video stay in explicit scoped history, not normal production lists', async t => {
  const f = await setup(t);
  const scope = { projectId: 1, scriptId: 10 };
  const [videoId] = await f.db('o_video').insert({ ...scope, videoTrackId: f.shot.trackId,
    filePath: '/1/video/history.mp4', state: '生成成功', time: 1 });
  const retire = await f.preview({ operations: [{ type: 'RETIRE', storyboardId: f.shot.id }] });
  await f.confirm(retire.command, retire.result);
  assert.equal((await f.production('getStoryboardData', scope)).length, 0);
  const shots = await f.production('getStoryboardData', { ...scope, historyOnly: true });
  assert.equal(shots.length, 1);
  assert.equal(Number(shots[0].id), f.shot.id);
  assert.equal((await f.workbench('getVideoList', scope)).length, 0);
  const videos = await f.workbench('getVideoList', { ...scope, historyOnly: true });
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, videoId);
  assert.equal(videos[0].revisionStatus, 'HISTORICAL');
  assert.equal((await f.production('getStoryboardData', { projectId: 1, scriptId: 11, historyOnly: true })).length, 0);
});

test('owner configuration denies Confirm and replay before any state change', async t => {
  const f = await setup(t);
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Authorized revision' } }] });
  const originalOwner = process.env.DS_STUDIO_OWNER_USER_ID;
  delete process.env.DS_STUDIO_OWNER_USER_ID;
  try {
    const denied = await f.confirm(draft.command, draft.result, 403);
    assert.equal(denied.reason, 'REVISION_ACCESS_DENIED');
    assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 0);
    assert.equal((await f.db('o_productionRevision')).length, 0);
  } finally { process.env.DS_STUDIO_OWNER_USER_ID = originalOwner; }
  const applied = await f.confirm(draft.command, draft.result);
  assert.equal(applied.delivery, 'APPLIED');
  process.env.DS_STUDIO_OWNER_USER_ID = '99';
  try {
    const deniedReplay = await f.confirm(draft.command, draft.result, 403);
    assert.equal(deniedReplay.reason, 'REVISION_ACCESS_DENIED');
    assert.equal((await f.db('o_productionRevision')).length, 1);
    assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 1);
  } finally { process.env.DS_STUDIO_OWNER_USER_ID = originalOwner; }
});

test('revision audit history is scoped, paged, read-only and owner-authorized', async t => {
  const f = await setup(t);
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Audited semantic' } }] });
  await f.confirm(draft.command, draft.result);
  const beforeEpoch = (await f.db('o_script').where({ id: 10 }).first()).revisionEpoch;
  const history = await f.post('history', { projectId: 1, scriptId: 10, offset: 0, limit: 1 });
  assert.equal(history.length, 1);
  assert.equal(history[0].revisionId, draft.command.revisionId);
  assert.equal(history[0].impact.resultTargetHash, undefined);
  assert.equal(history[0].result.resultTargetHash.length, 64);
  assert.deepEqual(await f.post('history', { projectId: 1, scriptId: 10, offset: 1, limit: 1 }), []);
  assert.deepEqual(await f.post('history', { projectId: 1, scriptId: 11 }), []);
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, beforeEpoch);
  process.env.DS_STUDIO_OWNER_USER_ID = '99';
  try { assert.equal((await f.post('history', { projectId: 1, scriptId: 10 }, 403)).reason, 'REVISION_ACCESS_DENIED'); }
  finally { process.env.DS_STUDIO_OWNER_USER_ID = '7'; }
});

test('script UPDATE trigger fails closed before Confirm writes or advances epoch', async t => {
  const f = await setup(t);
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Not allowed under trigger' } }] });
  await f.raw.raw("CREATE TRIGGER script_side_effect AFTER UPDATE ON o_script BEGIN UPDATE o_project SET name=name WHERE id=NEW.projectId; END");
  const denied = await f.confirm(draft.command, draft.result, 503);
  assert.equal(denied.reason, 'REVISION_RUNTIME_UNSAFE');
  assert.equal((await f.db('o_storyboard').where({ id: f.shot.id }).first()).prompt === 'Not allowed under trigger', false);
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 0);
  assert.equal((await f.db('o_productionRevision')).length, 0);
});

test('a second process holding SQLite writer lock yields retryable Confirm with the same revisionId', async t => {
  const f = await setup(t);
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Committed after writer lock' } }] });
  const dbPath = f.raw.client.config.connection.filename;
  const child = spawn(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('LOCKED\\n');
    process.stdin.once('data', () => { db.exec('COMMIT'); db.close(); process.stdout.write('RELEASED\\n'); });
  `, dbPath], { cwd: require('node:path').resolve(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (!child.killed) child.kill(); });
  let output = '', stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const onceLine = expected => new Promise((resolve, reject) => {
    if (output.includes(expected)) return resolve();
    const onData = () => {
      if (!output.includes(expected)) return;
      child.stdout.off('data', onData); child.off('exit', onExit); resolve();
    };
    const onExit = () => { child.stdout.off('data', onData); reject(Error(`lock process ended before ${expected}: ${stderr}`)); };
    child.stdout.on('data', onData); child.once('exit', onExit);
  });
  await onceLine('LOCKED');
  const busy = await f.confirm(draft.command, draft.result, 409);
  assert.equal(busy.reason, 'REVISION_CONCURRENT_UPDATE');
  assert.equal((await f.db('o_productionRevision')).length, 0);
  child.stdin.write('release\n');
  await onceLine('RELEASED');
  const applied = await f.confirm(draft.command, draft.result);
  assert.equal(applied.delivery, 'APPLIED');
  assert.equal((await f.db('o_productionRevision')).length, 1);
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 1);
});

test('lost-response replay uses persisted audit through a fresh SQLite adapter session', async t => {
  const f = await setup(t);
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'One durable revision' } }] });
  const applied = await f.confirm(draft.command, draft.result);
  const knex = require('knex');
  const fresh = knex({ client: 'better-sqlite3', connection: { filename: f.raw.client.config.connection.filename },
    useNullAsDefault: true });
  const originalDb = f.utils.db;
  const wrapper = Object.assign(table => fresh(table), fresh);
  wrapper.transaction = fresh.transaction.bind(fresh);
  f.utils.db = wrapper;
  try {
    const replay = await f.confirm(draft.command, draft.result);
    assert.equal(replay.delivery, 'REPLAYED');
    assert.equal(replay.resultTargetHash, applied.resultTargetHash);
    assert.equal((await fresh('o_productionRevision')).length, 1);
    assert.equal((await fresh('o_script').where({ id: 10 }).first()).revisionEpoch, 1);
  } finally { f.utils.db = originalDb; await fresh.destroy(); }
});

test('live guard blocks target deletion and same-track prompt or duration writes', async t => {
  const f = await setup(t);
  const scope = { projectId: 1, scriptId: 10 };
  const work = f.load('services/orchestrator/revisionWorkGuard');
  const [guard] = await work.admitRevisionWork(scope, 'VIDEO_GENERATE', [
    { trackId: f.shot.trackId, references: [], videoPath: '/1/video/in-flight.mp4' }]);
  assert.equal((await f.workbench('delVideo', { id: guard.videoId }, 409)).code, 'REVISION_ASYNC_WORK_BLOCKED');
  assert.equal((await f.workbench('deleteTrack', { id: f.shot.trackId }, 409)).code, 'REVISION_ASYNC_WORK_BLOCKED');
  assert.equal((await f.workbench('updateVideoPrompt', { id: f.shot.trackId, prompt: 'Too early' }, 409)).code,
    'REVISION_ASYNC_WORK_BLOCKED');
  assert.equal((await f.workbench('updateVideoDuration', { id: f.shot.trackId, duration: 12 }, 409)).code,
    'REVISION_ASYNC_WORK_BLOCKED');
  assert.equal((await f.db('o_video').where({ id: guard.videoId })).length, 1);
  assert.equal((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).prompt, null);
});

test('Confirm reopens exact stages and revokes a running composite without replacing preserved current image', async t => {
  const f = await setup(t);
  const scope = { projectId: 1, scriptId: 10 };
  const now = Date.now();
  for (const [stageKey, state] of [['root', 'COMPLETED'], ['storyboard-board', 'COMPLETED'],
    ['supervisor-review', 'COMPLETED'], ['image-production', 'IN_PROGRESS']]) {
    await f.db('o_stageRun').insert({ ...scope, profileKey: 'advertisement', profileVersion: 2,
      stageKey, state, startedAt: now - 1000, completedAt: state === 'COMPLETED' ? now - 500 : null,
      updatedAt: now - 500 });
  }
  const base = { ...scope, profileKey: 'advertisement', profileVersion: 2, profileDefinitionHash: 'fixture',
    recipeKey: null, recipeVersion: null, recipeDefinitionHash: null, stageKey: 'image-production',
    operationKey: 'storyboard.image.generate', subjectType: 'STORYBOARD_IMAGE', subjectId: f.shot.id,
    sourceAdapterKey: 'storyboard.image.v1', sourceHash: 'old-source', sourceSnapshot: '{}',
    producerType: 'AI_MODEL', producerRef: null, producerInput: '{}', controlContextHash: 'old-control',
    controlSnapshot: '{}', startedAt: now - 200, updatedAt: now - 200 };
  const oldCurrent = randomUUID(), running = randomUUID();
  await f.db('o_productionAttempt').insert([
    { ...base, attemptId: oldCurrent, status: 'SUCCEEDED', completedAt: now - 100,
      outputRef: JSON.stringify({ filePath: '/1/current-kept.png' }) },
    { ...base, attemptId: running, status: 'RUNNING' },
  ]);
  await f.db('o_storyboard').where({ id: f.shot.id }).update({ filePath: '/1/current-kept.png',
    currentImageAttemptId: oldCurrent, activeImageAttemptId: running, state: '生成中' });
  await f.db('o_compositeAttempt').insert({ ...scope, storyboardId: f.shot.id, primaryAssetId: 1,
    sourceImageId: 1, width: 800, height: 800, sourcePath: '/generated/1', sourceHash: 'asset-hash',
    productionSpec: '{}', backgroundCapabilityId: 'local.fixture', prompt: 'Background', seed: '1',
    status: 'AWAITING_QUAD', productionAttemptId: running, createdAt: now, updatedAt: now });
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Revised while composite waits' } }] });
  assert.deepEqual(draft.result.stageTransitions.map(row => [row.stageKey, row.toState]).sort(), [
    ['image-production', 'PENDING'], ['storyboard-board', 'IN_PROGRESS'], ['supervisor-review', 'PENDING']]);
  assert.deepEqual(draft.result.affectedActiveAttempts.map(row => row.attemptId), [running]);
  await f.confirm(draft.command, draft.result);
  const states = await f.db('o_stageRun').where(scope).select('stageKey', 'state');
  assert.equal(states.find(row => row.stageKey === 'root').state, 'COMPLETED');
  assert.equal(states.find(row => row.stageKey === 'storyboard-board').state, 'IN_PROGRESS');
  assert.equal(states.find(row => row.stageKey === 'supervisor-review').state, 'PENDING');
  assert.equal(states.find(row => row.stageKey === 'image-production').state, 'PENDING');
  const stale = await f.db('o_productionAttempt').where({ attemptId: running }).first();
  assert.equal(stale.status, 'STALE'); assert.equal(stale.invalidatedByRevisionId, draft.command.revisionId);
  assert.equal((await f.db('o_compositeAttempt').where({ productionAttemptId: running }).first()).status, 'STALE');
  const late = await f.load('services/productionAttempt').finishCurrentImageAttempt(running,
    { filePath: '/1/late-composite.png' });
  assert.equal(late.status, 'STALE');
  await f.load('services/productionAttempt').failCurrentImageAttempt(running, Error('late failure'));
  const shot = await f.db('o_storyboard').where({ id: f.shot.id }).first();
  assert.equal(shot.filePath, '/1/current-kept.png');
  assert.equal(shot.currentImageAttemptId, oldCurrent);
  assert.equal(shot.activeImageAttemptId, null);
  assert.equal((await f.db('o_stageEvent').where({ revisionId: draft.command.revisionId })).length, 3);
});

test('Confirm preserves unrelated Profile DAG branch and its running work', async t => {
  const branch = { ...graph, stages: [...graph.stages, stage('independent', 5)],
    transitions: [...graph.transitions, { fromStageKey: 'root', toStageKey: 'independent' }] };
  const f = await setup(t, branch);
  const scope = { projectId: 1, scriptId: 10 };
  await f.db('o_stageRun').insert({ ...scope, profileKey: 'advertisement', profileVersion: 2,
    stageKey: 'independent', state: 'IN_PROGRESS', updatedAt: 100 });
  const attemptId = randomUUID();
  await f.db('o_productionAttempt').insert({ attemptId, ...scope, profileKey: 'advertisement', profileVersion: 2,
    profileDefinitionHash: 'fixture', recipeKey: null, recipeVersion: null, recipeDefinitionHash: null,
    stageKey: 'independent', operationKey: 'other.production', subjectType: 'OTHER', subjectId: 1,
    sourceAdapterKey: 'other.v1', sourceHash: 'source', sourceSnapshot: '{}', producerType: 'OTHER',
    producerRef: null, producerInput: '{}', controlContextHash: 'control', controlSnapshot: '{}',
    status: 'RUNNING', startedAt: 1, updatedAt: 1 });
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Only storyboard branch changes' } }] });
  assert.equal(draft.result.stageTransitions.some(row => row.stageKey === 'independent'), false);
  assert.equal(draft.result.affectedActiveAttempts.some(row => row.attemptId === attemptId), false);
  await f.confirm(draft.command, draft.result);
  assert.equal((await f.db('o_stageRun').where({ ...scope, stageKey: 'independent' }).first()).state, 'IN_PROGRESS');
  assert.equal((await f.db('o_productionAttempt').where({ attemptId }).first()).status, 'RUNNING');
});

test('Stage preflight from an older epoch cannot write after Confirm changes authority', async t => {
  const f = await setup(t);
  const gates = f.load('services/orchestrator/gateRegistry');
  const original = gates.checkGate;
  let reached;
  const preflightReached = new Promise(resolve => { reached = resolve; });
  let release;
  const continueStage = new Promise(resolve => { release = resolve; });
  let held = false;
  gates.checkGate = async (...args) => {
    if (!held) { held = true; reached(); await continueStage; }
    return original(...args);
  };
  try {
    const stagePromise = f.load('services/orchestrator/stageOrchestrator')
      .actOnStage('start', { projectId: 1, scriptId: 10, stageKey: 'root' });
    await preflightReached;
    const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
      patch: { prompt: 'Confirm wins race' } }] });
    await f.confirm(draft.command, draft.result);
    release();
    await assert.rejects(stagePromise, error => error.code === 'STAGE_TRANSITION_INVALID');
    assert.equal((await f.db('o_stageRun').where({ projectId: 1, scriptId: 10, stageKey: 'root' })).length, 0);
    assert.equal((await f.db('o_stageEvent').where({ projectId: 1, scriptId: 10, stageKey: 'root' })).length, 0);
  } finally { release(); gates.checkGate = original; }
});

test('ambiguous existing track group rolls back Confirm instead of marking a guessed managed track', async t => {
  const f = await setup(t);
  const original = await f.db('o_storyboard').where({ id: f.shot.id }).first();
  await f.db('o_storyboard').insert({ projectId: 1, scriptId: 10, trackId: original.trackId,
    track: 'different-group', index: 1, duration: '3', prompt: 'Other group', videoDesc: '',
    productionSpec: original.productionSpec, state: '未生成', filePath: '' });
  const draft = await f.preview({ operations: [{ type: 'EDIT', storyboardId: f.shot.id,
    patch: { prompt: 'Should not commit under mixed track' } }] });
  const denied = await f.confirm(draft.command, draft.result, 409);
  assert.equal(denied.reason, 'REVISION_TRACK_CONTEXT_UNSUPPORTED');
  assert.equal((await f.db('o_storyboard').where({ id: f.shot.id }).first()).prompt, original.prompt);
  assert.equal((await f.db('o_script').where({ id: 10 }).first()).revisionEpoch, 0);
  assert.equal((await f.db('o_productionRevision')).length, 0);
});
