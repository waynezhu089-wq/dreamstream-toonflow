const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./composite-fixture.cjs');

async function setup(t) {
  const f = await fixture(t);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  await f.load('lib/revisionSchema').initializeRevisionSchema(f.db);
  await f.raw.schema.createTable('o_modelPrompt', tb => { tb.text('vendorId'); tb.text('model'); tb.text('path'); });
  await f.raw.schema.createTable('o_prompt', tb => { tb.text('type'); tb.text('data'); tb.text('useData'); });
  await f.db('o_prompt').insert({ type: 'videoPromptGeneration', data: 'Generate a video prompt' });
  const shot = await f.create();
  const profiles = f.load('services/orchestrator/profileRegistry');
  const graph = f.load('services/orchestrator/videoProductionProfile').advertisementPreE001SemanticV2;
  await profiles.createVersion({ profileKey: 'advertisement', definition: graph });
  await profiles.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  const calls = [];
  f.utils.vendor.getModelList = async () => [{ modelName: 'video', type: 'video' }];
  f.utils.Ai.Video = model => ({ run: async () => { calls.push({ kind: 'video', model }); },
    save: async () => { calls.push({ kind: 'save' }); } });
  f.utils.Ai.Text = () => ({ invoke: async () => { calls.push({ kind: 'text' }); return { text: 'controlled prompt' }; } });
  f.utils.getArtPrompt = () => 'art style';
  f.utils.getPath = () => 'missing-model-prompt-directory';
  const app = express(); app.use(express.json());
  app.use(f.load('middleware/modelUseGate').modelUseGate);
  for (const name of ['generateVideo', 'batchGenerateVideo', 'generateVideoPrompt', 'batchGeneratePrompt'])
    app.use('/api/production/workbench/' + name, f.load('routes/production/workbench/' + name).default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(name, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/production/workbench/${name}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function settled(count) {
    for (let i = 0; i < 100; i++) {
      const rows = await f.db('o_revisionWorkGuard');
      if (rows.length >= count && rows.every(row => row.state !== 'ACTIVE')) return rows;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('guards did not settle');
  }
  return { ...f, shot, calls, post, settled };
}

test('controlled video admits before model resolution; missing model settles without provider call', async t => {
  const f = await setup(t);
  const input = { projectId: 1, scriptId: 10, uploadData: [], prompt: 'Shot', mode: 'text',
    resolution: '720p', duration: 5, trackId: f.shot.trackId };
  const response = await f.post('generateVideo', input);
  assert.equal(response.status, 409);
  const guards = await f.settled(1);
  assert.equal(guards[0].kind, 'VIDEO_GENERATE'); assert.equal(guards[0].outcome, 'FAILED');
  assert.equal(f.calls.length, 0);
  const videos = await f.db('o_video');
  assert.equal(videos.length, 1); assert.equal(videos[0].revisionWorkGuardId, guards[0].guardId);
});

test('single and batch guarded video workers publish only their own settled rows', async t => {
  const f = await setup(t);
  await f.load('services/modelPreset').patchProject({ projectId: 1, slots: { video: 'vendor:video' } });
  const item = { trackId: f.shot.trackId, uploadData: [], prompt: 'Shot', duration: 5 };
  const common = { projectId: 1, scriptId: 10, model: 'vendor:video', mode: 'text', resolution: '720p' };
  assert.equal((await f.post('generateVideo', { ...common, ...item })).status, 200);
  await f.settled(1);
  assert.equal((await f.post('batchGenerateVideo', { ...common, trackData: [item] })).status, 200);
  const guards = await f.settled(2);
  assert.deepEqual(guards.map(guard => guard.outcome), ['SUCCEEDED', 'SUCCEEDED']);
  assert.equal((await f.db('o_video').where({ state: '生成成功' })).length, 2);
  assert.equal(f.calls.filter(call => call.kind === 'video').length, 2);
});

test('single and batch prompt workers register first, then conditionally publish track prompt', async t => {
  const f = await setup(t);
  const item = { trackId: f.shot.trackId, info: [] };
  assert.equal((await f.post('generateVideoPrompt', { projectId: 1, ...item,
    model: 'vendor:video', mode: 'text' })).status, 200);
  await f.settled(1);
  assert.equal((await f.post('batchGeneratePrompt', { projectId: 1, trackData: [item],
    model: 'vendor:video', mode: 'text' })).status, 200);
  const guards = await f.settled(2);
  assert.deepEqual(guards.map(guard => guard.outcome), ['SUCCEEDED', 'SUCCEEDED']);
  assert.equal((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).prompt, 'controlled prompt');
  assert.equal(f.calls.filter(call => call.kind === 'text').length, 2);
});

test('batch video registers all items before workers; one producer failure settles only its own guard', async t => {
  const f = await setup(t);
  await f.load('services/modelPreset').patchProject({ projectId: 1, slots: { video: 'vendor:video' } });
  await f.db('o_videoTrack').insert({ id: 999, projectId: 1, scriptId: 10, duration: 5 });
  let started = 0;
  f.utils.Ai.Video = () => ({ run: async ({ prompt }) => {
    started++;
    assert.equal((await f.db('o_revisionWorkGuard')).length, 2);
    if (prompt === 'bad input') throw Error('local mock failure');
  }, save: async () => {} });
  const common = { projectId: 1, scriptId: 10, model: 'vendor:video', mode: 'text', resolution: '720p' };
  const response = await f.post('batchGenerateVideo', { ...common, trackData: [
    { trackId: f.shot.trackId, uploadData: [], prompt: 'bad input', duration: 5 },
    { trackId: 999, uploadData: [], prompt: 'good input', duration: 5 },
  ] });
  assert.equal(response.status, 200);
  const guards = await f.settled(2);
  assert.equal(started, 2);
  const byTrack = new Map(guards.map(row => [row.trackId, row]));
  assert.equal(byTrack.get(f.shot.trackId).outcome, 'FAILED');
  assert.equal(byTrack.get(999).outcome, 'SUCCEEDED');
  assert.equal((await f.db('o_video').where({ revisionWorkGuardId: byTrack.get(999).guardId }).first()).state,
    '生成成功');
});
