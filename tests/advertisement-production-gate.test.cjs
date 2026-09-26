// Node 22+ (built-in WebSocket). Uses real Express, Socket.IO, Knex and a
// temporary SQLite file. Model execution and external storage are test doubles.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const express = require('express');
const knex = require('knex');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const root = path.resolve(__dirname, '..');
const namespace = '/api/socket/productionAgent';
const STATE_KEY = 'advertisement:asset-preparation';

function moduleLoader(utils, overrides = {}) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const module = { exports: {} };
    cache.set(filename, module);
    function localRequire(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === '@/utils') return utils;
      if (name.startsWith('@/')) return load(path.join(root, 'src', name.slice(2) + '.ts'));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'));
      return require(name);
    }
    new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
    return module.exports;
  }
  return load;
}

// Minimal Engine.IO/Socket.IO WebSocket client: no new test dependency or model
// service is needed. It performs a real namespace handshake and event/ACK I/O.
function socketClient(port, auth) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const bus = new EventEmitter();
  const events = [];
  const pending = new Map();
  let counter = 0;
  ws.addEventListener('message', ({ data }) => {
    const packet = String(data);
    if (packet.startsWith('0')) ws.send(`40${namespace},${JSON.stringify(auth)}`);
    else if (packet === '2') ws.send('3');
    else if (packet.startsWith(`40${namespace},`)) bus.emit('ready');
    else if (packet.startsWith(`42${namespace},`)) {
      const [name, value] = JSON.parse(packet.slice(`42${namespace},`.length));
      events.push({ name, value });
      bus.emit('event', { name, value });
    } else if (packet.startsWith(`43${namespace},`)) {
      const match = packet.slice(`43${namespace},`.length).match(/^(\d+)(\[.*)$/s);
      if (match) { pending.get(Number(match[1]))?.(JSON.parse(match[2])[0]); pending.delete(Number(match[1])); }
    } else if (packet.startsWith(`44${namespace},`)) {
      const failure = JSON.parse(packet.slice(`44${namespace},`.length));
      const event = { name: 'connect_error', value: failure.data };
      events.push(event); bus.emit('event', event);
    } else if (packet.startsWith(`41${namespace}`)) bus.emit('disconnected');
  });
  function bounded(subscribe) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket test timed out')), 4000);
      subscribe(value => { clearTimeout(timer); resolve(value); });
    });
  }
  return {
    events,
    ready: () => bounded(done => bus.once('ready', done)),
    event: name => {
      const found = events.find(event => event.name === name);
      if (found) return Promise.resolve(found.value);
      return bounded(done => {
        function listener(event) { if (event.name === name) { bus.off('event', listener); done(event.value); } }
        bus.on('event', listener);
      });
    },
    ack: (name, data) => bounded(done => {
      const id = ++counter;
      pending.set(id, done);
      ws.send(`42${namespace},${id}${JSON.stringify([name, data])}`);
    }),
    emit: (name, data) => ws.send(`42${namespace},${JSON.stringify([name, data])}`),
    close: () => ws.close(),
  };
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toonflow-gate-'));
  const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(directory, 'test.sqlite') }, useNullAsDefault: true });
  const effects = { dispatch: [], agent: [], memory: 0 };
  const utils = { db, uuid: randomUUID, error: error => error, oss: { getSmallImageUrl: async value => `fixture:${value}` } };
  let server, io;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    if (io) await new Promise(resolve => io.close(resolve));
    else if (server) await new Promise(resolve => server.close(resolve));
    await db.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.schema.createTable('o_project', table => { table.integer('id').primary(); table.string('projectType'); table.string('type'); });
  await db.schema.createTable('o_script', table => { table.integer('id').primary(); table.integer('projectId'); table.text('content'); table.integer('createTime'); });
  await db.schema.createTable('o_agentWorkData', table => {
    table.integer('id').notNullable(); table.integer('projectId'); table.integer('episodesId');
    table.string('key'); table.string('data'); table.integer('createTime'); table.integer('updateTime'); table.primary(['id']); table.unique(['id']);
  });
  await db.schema.createTable('o_assets', table => {
    table.integer('id').primary(); table.integer('projectId'); table.integer('scriptId'); table.integer('assetsId');
    table.integer('imageId'); table.integer('flowId'); table.string('name'); table.string('type');
  });
  await db.schema.createTable('o_scriptAssets', table => { table.integer('scriptId'); table.integer('assetId'); });
  await db.schema.createTable('o_image', table => { table.integer('id').primary(); table.integer('assetsId'); table.string('state'); table.string('filePath'); table.string('errorReason'); });
  await db.schema.createTable('o_storyboard', table => {
    table.integer('id').primary(); table.integer('projectId'); table.integer('scriptId'); table.integer('flowId');
    table.integer('index'); table.string('filePath'); table.string('prompt'); table.string('videoDesc');
  });
  await db.schema.createTable('o_assets2Storyboard', table => { table.integer('storyboardId'); table.integer('assetId'); });
  await db.schema.createTable('o_videoTrack', table => {
    table.integer('id').primary(); table.integer('projectId'); table.integer('scriptId'); table.integer('videoId'); table.string('prompt'); table.integer('duration');
  });
  await db.schema.createTable('o_video', table => { table.integer('id').primary(); table.integer('projectId'); table.integer('scriptId'); });
  await db.schema.createTable('o_imageFlow', table => { table.integer('id').primary(); table.string('flowData'); });
  await db.schema.createTable('o_setting', table => { table.string('key'); table.string('value'); });
  await db('o_setting').insert({ key: 'tokenKey', value: 'isolated-test-token-secret' });
  await db('o_project').insert([
    { id: 1, projectType: 'general_video', type: 'advertisement' },
    { id: 2, projectType: 'short_drama', type: 'short_drama' },
    { id: 3, projectType: 'general_video', type: 'advertisement' },
  ]);
  await db('o_script').insert([
    { id: 10, projectId: 1, content: 'first', createTime: 1 }, { id: 11, projectId: 1, content: 'current', createTime: 2 },
    { id: 20, projectId: 2, content: 'legacy', createTime: 1 }, { id: 30, projectId: 3, content: 'other-project', createTime: 1 },
  ]);
  for (const [scriptId, projectId] of [[10, 1], [11, 1], [20, 2], [30, 3]]) {
    await db('o_assets').insert({ id: scriptId + 100, projectId, imageId: scriptId + 200, name: 'Logo', type: 'prop' });
    await db('o_image').insert({ id: scriptId + 200, assetsId: scriptId + 100, state: '已完成', filePath: `logo-${scriptId}.png` });
    await db('o_scriptAssets').insert({ scriptId, assetId: scriptId + 100 });
    await db('o_storyboard').insert({ id: scriptId + 300, projectId, scriptId, prompt: 'unchanged', flowId: scriptId + 600 });
    await db('o_videoTrack').insert({ id: scriptId + 400, projectId, scriptId, prompt: 'unchanged' });
    await db('o_video').insert({ id: scriptId + 500, projectId, scriptId });
    await db('o_imageFlow').insert({ id: scriptId + 600, flowData: '{}' });
  }
  // Only the first advertisement unit is ready at fixture start.
  await db('o_agentWorkData').insert({ projectId: 1, episodesId: 10, key: STATE_KEY, data: '{"confirmed":true}' });
  const overrides = {
    '@/agents/productionAgent/index': { runDecisionAI: async ctx => {
      effects.agent.push({ ...ctx.resTool.data }); ctx.msg.complete();
    } },
    ai: { tool: value => value, jsonSchema: value => value },
    '@/utils/agent/memory': class { constructor() { effects.memory++; } async add() { effects.memory++; } },
    '@/utils/agent/skillsTools': {}, '@/agents/productionAgent/tools': () => ({}),
  };
  const load = moduleLoader(utils, overrides);
  await load(path.join(root, 'src/lib/advertisementAssetPlanSchema.ts')).initializeAssetPlanSchema(db);
  await load(path.join(root, 'src/lib/productionProfileSchema.ts')).initializeProductionProfileSchema(db);
  for (const [scriptId, projectId] of [[10, 1], [11, 1], [30, 3]]) {
    await load(path.join(root, 'src/services/advertisementAssetPlan.ts')).saveAssetPlan({ projectId, scriptId, items: [
      { assetKey: 'brand', name: 'Brand', category: 'brand', required: true, sourcePolicy: 'AI_ALLOWED', assetId: scriptId + 100 },
    ] });
  }
  const service = load(path.join(root, 'src/services/advertisementGate.ts'));
  const app = express();
  app.use(express.json());
  // Same installation function as app.ts, with real login-token verification.
  app.use((req, res, next) => {
    try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), 'isolated-test-token-secret'); next(); }
    catch { res.sendStatus(401); }
  });
  load(path.join(root, 'src/middleware/productionGate.ts')).registerProductionGate(app);
  for (const route of ['getFlowData', 'saveFlowData', 'storyboard/editStoryboardInfo', 'workbench/updateVideoPrompt']) {
    app.use(`/api/production/${route}`, load(path.join(root, 'src/routes/production', route + '.ts')).default);
  }
  // Paid generation and other production handlers stop here in the test.
  app.use('/api/production', (req, res) => { effects.dispatch.push(req.path); res.json({ code: 200, data: 'dispatched' }); });
  server = app.listen(0, '127.0.0.1');
  io = new Server(server);
  // Deterministic scheduling for context-switch race tests; the actual Gate
  // still runs after the optional pause and reads the real test database.
  overrides['@/services/advertisementGate'] = {
    ...service,
    assertProductionReady: async (...args) => {
      if (effects.beforeSocketGate) await effects.beforeSocketGate(...args);
      return service.assertProductionReady(...args);
    },
  };
  load(path.join(root, 'src/socket/routes/productionAgent.ts')).default(io.of(namespace));
  await once(server, 'listening');
  const token = jwt.sign({ id: 'fixture-user' }, 'isolated-test-token-secret');
  return {
    db, effects, load, service,
    async post(route, body, authenticated = true) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async confirm(scriptId, confirmed = true) {
      return this.post('project/advertisement/confirmAssetPreparation', { projectId: 1, scriptId, confirmed });
    },
    socket(projectId = 1, scriptId = 10, extra = {}) {
      const client = socketClient(server.address().port, { token, projectId, scriptId, isolationKey: `${projectId}:productionAgent:${scriptId}`, ...extra });
      clients.push(client); return client;
    },
    async snapshot() {
      const rows = {};
      for (const table of ['o_agentWorkData', 'o_assets', 'o_image', 'o_storyboard', 'o_videoTrack', 'o_video', 'o_imageFlow']) rows[table] = await db(table).orderBy('id');
      return rows;
    },
  };
}

test('status and confirmation use the selected unit, with missing-unit calls rejected', async t => {
  const h = await fixture(t);
  const status = scriptId => h.post('project/advertisement/getWorkflowState', { projectId: 1, ...(scriptId === undefined ? {} : { scriptId }) });
  assert.equal((await status()).status, 400);
  assert.equal((await h.confirm(undefined)).status, 400);
  assert.equal((await status(11)).body.data.ready, false);
  assert.equal((await h.confirm(11)).body.data.scriptId, 11);
  assert.equal((await status(11)).body.data.ready, true);
  assert.equal((await h.db('o_agentWorkData').where({ episodesId: 10, key: STATE_KEY }).first()).data, '{"confirmed":true}');
  assert.equal((await status(30)).status, 400);
  assert.equal((await h.confirm(30)).status, 400);
  assert.equal((await h.post('project/advertisement/confirmAssetPreparation', { projectId: 1, scriptId: null, confirmed: true })).status, 400);
});

test('direct HTTP production requests cannot use the first unit Gate for the current unit', async t => {
  const h = await fixture(t);
  const before = await h.snapshot();
  for (const [route, body] of [
    ['getFlowData', { projectId: 1, episodesId: 11 }],
    ['saveFlowData', { projectId: 1, episodesId: 11, data: { storyboard: [], scriptPlan: 'forbidden' } }],
    ['storyboard/addStoryboard', { projectId: 1, scriptId: 11 }],
    ['storyboard/replaceStoryboard', { projectId: 1, scriptId: 11 }],
    ['storyboard/batchGenerateImage', { projectId: 1, scriptId: 11, storyboardIds: [311] }],
    ['workbench/generateVideo', { projectId: 1, scriptId: 11, trackId: 411 }],
    ['assets/batchGenerateAssetsImage', { projectId: 1, scriptId: 11, assetIds: [111] }],
    ['editImage/generateFlowImage', { projectId: 1, scriptId: 11 }],
  ]) {
    const result = await h.post(`production/${route}`, body);
    assert.equal(result.status, 409, route);
    assert.equal(result.body.data.code, 'ADVERTISEMENT_ASSET_GATE_BLOCKED', route);
  }
  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(h.effects.dispatch, []);
});

test('passing the current Gate enables save/reload and downstream dispatch; revoking it blocks again', async t => {
  const h = await fixture(t);
  assert.equal((await h.confirm(11)).status, 200);
  const data = { scriptPlan: 'persisted-current', storyboard: [], storyboardTable: 'table' };
  assert.equal((await h.post('production/saveFlowData', { projectId: 1, episodesId: 11, data })).status, 200);
  assert.equal((await h.post('production/getFlowData', { projectId: 1, episodesId: 11 })).body.data.scriptPlan, data.scriptPlan);
  assert.equal((await h.post('production/storyboard/batchGenerateImage', { projectId: 1, scriptId: 11, storyboardIds: [311] })).status, 200);
  await h.confirm(11, false);
  assert.equal((await h.post('production/saveFlowData', { projectId: 1, episodesId: 11, data: {} })).status, 409);
  assert.equal(JSON.parse((await h.db('o_agentWorkData').where({ episodesId: 11, key: 'productionAgent' }).first()).data).scriptPlan, data.scriptPlan);
});

test('ID-only, mixed-batch and bound image-flow writes check actual affected units', async t => {
  const h = await fixture(t);
  const before = await h.snapshot();
  for (const [route, body] of [
    ['storyboard/editStoryboardInfo', { id: 311, prompt: 'forbidden', videoDesc: '' }],
    ['storyboard/batchDelete', { projectId: 1, ids: [310, 311] }],
    ['workbench/updateVideoPrompt', { id: 411, prompt: 'forbidden' }],
    ['workbench/delVideo', { id: 511 }],
    ['workbench/batchGeneratePrompt', { projectId: 1, trackData: [{ trackId: 410 }, { trackId: 411 }] }],
    ['assets/updateAssetsUrl', { id: 111, flowId: 611, url: 'fake.png' }],
    ['editImage/updateImageFlow', { flowId: 611, nodes: [], edges: [] }],
  ]) assert.equal((await h.post(`production/${route}`, body)).status, 409, route);
  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(h.effects.dispatch, []);
});

test('spoofed ready/legacy project, mismatched IDs and absent current unit fail closed', async t => {
  const h = await fixture(t);
  for (const [route, body] of [
    ['saveFlowData', { projectId: 2, episodesId: 11, data: {} }],
    ['saveFlowData', { projectId: 1, episodesId: 10, scriptId: 11, data: {} }],
    ['saveFlowData', { projectId: 1, episodesId: 10, data: { storyboard: [{ id: 311 }] } }],
    ['workbench/generateVideo', { projectId: 1, scriptId: 10, trackId: 411 }],
    ['storyboard/batchGenerateImage', { projectId: 1, scriptId: 10, storyboardIds: [330] }],
    ['editImage/generateFlowImage', { projectId: 1 }],
    ['editImage/generateFlowImage', { projectId: 1, scriptId: 999 }],
    ['getFlowData', { projectId: 1, episodesId: null }],
  ]) assert.equal((await h.post(`production/${route}`, body)).status, 400, route);
  assert.deepEqual(h.effects.dispatch, []);
});

test('empty, incomplete and malformed confirmation states deny even after confirmation existed', async t => {
  const h = await fixture(t);
  const body = { projectId: 1, episodesId: 10 };
  await h.db('o_image').where('id', 210).update({ state: '生成中' });
  assert.equal((await h.post('production/getFlowData', body)).status, 409);
  await h.db('o_image').where('id', 210).update({ state: '已完成', filePath: '' });
  assert.equal((await h.post('production/getFlowData', body)).status, 409);
  await h.db('o_image').where('id', 210).update({ filePath: 'logo.png' });
  for (const data of ['invalid-json', '{"confirmed":"false"}', '{"confirmed":false}']) {
    await h.db('o_agentWorkData').where('episodesId', 10).update({ data });
    assert.equal((await h.post('production/getFlowData', body)).status, 409);
  }
  await h.db('o_agentWorkData').where('episodesId', 10).update({ data: '{"confirmed":true}' });
  await h.db('o_scriptAssets').where('scriptId', 10).delete();
  assert.equal((await h.post('production/getFlowData', body)).status, 409);
});

test('non-advertisement writes still work; preparation, reads and unbound drafts are reachable', async t => {
  const h = await fixture(t);
  assert.equal((await h.post('production/saveFlowData', { projectId: 2, episodesId: 20, data: { storyboard: [] } })).status, 200);
  assert.equal((await h.post('production/workbench/updateVideoPrompt', { id: 420, prompt: 'legacy-ok' })).status, 200);
  assert.equal((await h.db('o_videoTrack').where('id', 420).first()).prompt, 'legacy-ok');
  assert.equal((await h.post('production/editImage/generateFlowImage', { projectId: 2 })).status, 200);
  assert.equal((await h.post('production/editImage/saveImageFlow', { nodes: [], edges: [] })).status, 200);
  assert.equal((await h.post('production/assets/pollingImage', { ids: [111] })).status, 200);
  assert.equal((await h.confirm(11)).status, 200);
});

test('case/trailing slash and database failures cannot skip HTTP Gate; authentication still applies', async t => {
  const h = await fixture(t);
  assert.equal((await h.post('production/SAVEFLOWDATA/', { projectId: 1, episodesId: 11, data: {} })).status, 409);
  assert.equal((await h.post('production/getFlowData', { projectId: 1, episodesId: 10 }, false)).status, 401);
  await h.db.schema.dropTable('o_agentWorkData');
  const result = await h.post('production/saveFlowData', { projectId: 1, episodesId: 10, data: {} });
  assert.equal(result.status, 503);
  assert.equal(result.body.data.code, 'PRODUCTION_GATE_UNAVAILABLE');
  assert.deepEqual(h.effects.dispatch, []);
});

test('Socket handshake blocks an unready current unit, including legacy-project spoofing', async t => {
  const h = await fixture(t);
  for (const [projectId, scriptId, code] of [[1, 11, 'ADVERTISEMENT_ASSET_GATE_BLOCKED'], [2, 11, 'PRODUCTION_CONTEXT_INVALID']]) {
    const client = h.socket(projectId, scriptId);
    assert.equal((await client.event('connect_error')).code, code);
    assert.equal(client.events.some(event => event.name === 'message'), false);
  }
  assert.deepEqual(h.effects.agent, []);
});

test('Socket chat rechecks Gate after connection and does not start AI on revocation', async t => {
  const h = await fixture(t);
  const client = h.socket('1', 10);
  await client.ready();
  // ACK synchronizes completion of the server-side asynchronous setup.
  assert.equal((await client.ack('updateContext', { projectId: 1, scriptId: 10, isolationKey: 'unit-10' })).success, true);
  assert.equal((await client.ack('chat', { content: 'allowed' })).success, true);
  const count = client.events.filter(event => event.name === 'message').length;
  await h.confirm(10, false);
  assert.equal((await client.ack('chat', { content: 'blocked' })).code, 'ADVERTISEMENT_ASSET_GATE_BLOCKED');
  assert.equal(h.effects.agent.length, 1);
  assert.equal(client.events.filter(event => event.name === 'message').length, count);
});

test('failed Socket context switch never continues using the previously ready unit', async t => {
  const h = await fixture(t);
  const client = h.socket();
  await client.ready();
  assert.equal((await client.ack('updateContext', { projectId: 1, scriptId: 11, isolationKey: 'unit-11' })).success, false);
  assert.equal((await client.ack('chat', { content: 'must-not-use-unit-10' })).success, false);
  assert.deepEqual(h.effects.agent, []);
  await h.confirm(11);
  assert.equal((await client.ack('updateContext', { projectId: 1, scriptId: 11, isolationKey: 'unit-11' })).success, true);
  assert.equal((await client.ack('chat', { content: 'current-unit' })).success, true);
  assert.deepEqual(h.effects.agent, [{ projectId: 1, scriptId: 11 }]);
});

test('direct Agent invocation rejects before memory, models or production writes', async t => {
  const h = await fixture(t);
  const before = await h.snapshot();
  const agent = h.load(path.join(root, 'src/agents/productionAgent/index.ts'));
  await assert.rejects(agent.runDecisionAI({ resTool: { data: { projectId: 1, scriptId: 11 } } }), { code: 'ADVERTISEMENT_ASSET_GATE_BLOCKED' });
  assert.equal(h.effects.memory, 0);
  assert.deepEqual(await h.snapshot(), before);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('chat cannot run while a Socket context switch is awaiting Gate validation', async t => {
  const h = await fixture(t);
  const client = h.socket();
  await client.ready();
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  h.effects.beforeSocketGate = async () => { entered.resolve(); await release.promise; };
  const switching = client.ack('updateContext', { projectId: 1, scriptId: 11, isolationKey: 'pending-11' });
  await entered.promise;
  assert.equal((await client.ack('chat', { content: 'during-switch' })).success, false);
  assert.deepEqual(h.effects.agent, []);
  release.resolve();
  assert.equal((await switching).code, 'ADVERTISEMENT_ASSET_GATE_BLOCKED');
  assert.equal(client.events.some(event => event.name === 'message'), false);
});

test('late validation from an older context switch cannot restore the old unit', async t => {
  const h = await fixture(t);
  await h.confirm(11);
  const client = h.socket();
  await client.ready();
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  h.effects.beforeSocketGate = async (_project, unit) => {
    if (unit === 10) { entered.resolve(); await release.promise; }
  };
  const older = client.ack('updateContext', { projectId: 1, scriptId: 10, isolationKey: 'older' });
  await entered.promise;
  assert.equal((await client.ack('updateContext', { projectId: 1, scriptId: 11, isolationKey: 'newer' })).success, true);
  release.resolve();
  assert.equal((await older).success, false);
  assert.equal((await client.ack('chat', { content: 'must-use-newer' })).success, true);
  assert.deepEqual(h.effects.agent, [{ projectId: 1, scriptId: 11 }]);
});

test('Gate database failure after Socket connection fails closed without new messages or AI', async t => {
  const h = await fixture(t);
  const client = h.socket();
  await client.ready();
  await h.db.schema.dropTable('o_agentWorkData');
  assert.equal((await client.ack('chat', { content: 'database-offline' })).code, 'PRODUCTION_GATE_UNAVAILABLE');
  assert.deepEqual(h.effects.agent, []);
  assert.equal(client.events.some(event => event.name === 'message'), false);
});

test('legacy Socket starts normally and invalid authentication is rejected before namespace connection', async t => {
  const h = await fixture(t);
  const invalid = h.socket(1, 10, { token: 'invalid-test-token' });
  assert.equal((await invalid.event('connect_error')).code, 'PRODUCTION_UNAUTHORIZED');
  const legacy = h.socket(2, 20);
  await legacy.ready();
  assert.equal((await legacy.ack('chat', { content: 'legacy-production' })).success, true);
  assert.deepEqual(h.effects.agent, [{ projectId: 2, scriptId: 20 }]);
});

test('DS-BE-004: plan edits revoke the same HTTP, Socket and direct Agent Gate without new model work', async t => {
  const h = await fixture(t); const client = h.socket(); await client.ready();
  assert.equal((await client.ack('updateContext', { projectId: 1, scriptId: 10, isolationKey: 'unit-10' })).success, true);
  const plans = h.load(path.join(root, 'src/services/advertisementAssetPlan.ts'));
  await plans.saveAssetPlan({ projectId: 1, scriptId: 10, items: [
    { assetKey: 'brand', name: 'Brand', category: 'brand', required: true, sourcePolicy: 'AI_ALLOWED', assetId: 110 },
    { assetKey: 'new', name: 'New required', category: 'scene', required: true, sourcePolicy: 'AI_ALLOWED', assetId: null },
  ] });
  assert.equal((await h.service.readState(1, 10)).confirmed, true);
  assert.equal((await h.post('production/getFlowData', { projectId: 1, episodesId: 10 })).status, 409);
  assert.equal((await client.ack('chat', { content: 'must-not-start' })).code, 'ADVERTISEMENT_ASSET_GATE_BLOCKED');
  const denied = h.socket(); assert.equal((await denied.event('connect_error')).code, 'ADVERTISEMENT_ASSET_GATE_BLOCKED');
  const agent = h.load(path.join(root, 'src/agents/productionAgent/index.ts'));
  await assert.rejects(agent.runDecisionAI({ resTool: { data: { projectId: 1, scriptId: 10 } } }), { code: 'ADVERTISEMENT_ASSET_GATE_BLOCKED' });
  assert.deepEqual(h.effects.agent, []); assert.equal(h.effects.memory, 0); assert.deepEqual(h.effects.dispatch, []);
});
