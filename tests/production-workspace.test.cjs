// Run with: node --test tests/production-workspace.test.cjs
// Real Express handlers, validation, Knex and temporary SQLite; no app startup,
// production database, authentication server, model calls or external storage.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const ts = require('typescript');
const express = require('express');
const knex = require('knex');

const root = path.resolve(__dirname, '..');
const GATE_KEY = 'advertisement:asset-preparation';
const WORKSPACE_KEY = 'productionAgent';

// Load the actual route modules without importing utils.ts, which initializes
// the user's database and external services. Only the utils boundary is replaced.
function routeLoader(utils) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    });
    const module = { exports: {} };
    cache.set(filename, module);
    function localRequire(name) {
      if (name === '@/utils') return utils;
      if (name.startsWith('@/')) return load(path.join(root, 'src', name.slice(2) + '.ts'));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'));
      return require(name);
    }
    new Function('require', 'module', 'exports', compiled.outputText)(localRequire, module, module.exports);
    return module.exports;
  }
  return load;
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toonflow-workspace-'));
  const filename = path.join(directory, 'test.sqlite');
  const connect = () => knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true });
  const utils = { db: connect(), oss: { getSmallImageUrl: async value => `test-image:${value}` } };
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await utils.db.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Minimal columns used by these routes; workspace schema matches initDB.ts.
  await utils.db.schema.createTable('o_agentWorkData', table => {
    table.integer('id').notNullable();
    table.integer('projectId');
    table.integer('episodesId');
    table.string('key');
    table.string('data');
    table.integer('createTime');
    table.integer('updateTime');
    table.primary(['id']);
    table.unique(['id']);
  });
  await utils.db.schema.createTable('o_project', table => {
    table.integer('id').primary(); table.string('projectType'); table.string('type');
  });
  await utils.db.schema.createTable('o_script', table => {
    table.integer('id').primary(); table.integer('projectId'); table.text('content'); table.integer('createTime');
  });
  await utils.db.schema.createTable('o_scriptAssets', table => {
    table.integer('scriptId'); table.integer('assetId');
  });
  await utils.db.schema.createTable('o_assets', table => {
    table.integer('id').primary(); table.integer('projectId'); table.integer('assetsId');
    table.integer('imageId'); table.string('name'); table.string('type');
  });
  await utils.db.schema.createTable('o_image', table => {
    table.integer('id').primary(); table.integer('assetsId'); table.string('state'); table.string('filePath'); table.string('errorReason');
  });
  await utils.db.schema.createTable('o_storyboard', table => {
    table.integer('id').primary(); table.integer('scriptId'); table.integer('index'); table.string('filePath');
  });
  await utils.db.schema.createTable('o_assets2Storyboard', table => {
    table.integer('storyboardId'); table.integer('assetId');
  });
  await utils.db('o_project').insert({ id: 1, projectType: 'general_video', type: 'advertisement' });
  await utils.db('o_script').insert({ id: 10, projectId: 1, content: 'Brief', createTime: 1 });
  await utils.db('o_assets').insert({ id: 100, projectId: 1, imageId: 200, name: 'Logo', type: 'prop' });
  await utils.db('o_image').insert({ id: 200, assetsId: 100, state: '已完成', filePath: 'fixture-logo.png' });
  await utils.db('o_scriptAssets').insert({ scriptId: 10, assetId: 100 });
  const load = routeLoader(utils);
  await load(path.join(root, 'src/lib/advertisementAssetPlanSchema.ts')).initializeAssetPlanSchema(utils.db);
  await load(path.join(root, 'src/services/advertisementAssetPlan.ts')).saveAssetPlan({ projectId: 1, scriptId: 10, items: [
    { assetKey: 'brand', name: 'Brand', category: 'brand', required: true, sourcePolicy: 'AI_ALLOWED', assetId: 100 },
  ] });
  const app = express();
  app.use(express.json());
  app.use('/confirm', load(path.join(root, 'src/routes/project/advertisement/confirmAssetPreparation.ts')).default);
  app.use('/get', load(path.join(root, 'src/routes/production/getFlowData.ts')).default);
  app.use('/save', load(path.join(root, 'src/routes/production/saveFlowData.ts')).default);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    get db() { return utils.db; },
    async post(route, body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.code, 200);
      return result.data;
    },
    async reopen() { await utils.db.destroy(); utils.db = connect(); },
    row(key, projectId = 1, episodesId = 10) {
      return utils.db('o_agentWorkData').where({ projectId, episodesId, key }).first();
    },
  };
}

const workspace = label => ({
  script: 'Brief', scriptPlan: `director-${label}`, assets: [],
  storyboardTable: `table-${label}`, storyboard: [], workbench: { videoList: [], note: label },
});
const request = data => ({ projectId: 1, episodesId: 10, data });

test('Gate-only record is not returned as the production workspace', async t => {
  const h = await fixture(t);
  await h.post('/confirm', { projectId: 1, scriptId: 10, confirmed: true });
  const gate = await h.row(GATE_KEY);
  const flow = await h.post('/get', request());
  assert.equal(flow.script, 'Brief');
  assert.equal(flow.scriptPlan, '');
  assert.equal(flow.storyboardTable, '');
  assert.deepEqual(flow.storyboard, []);
  assert.equal(Object.hasOwn(flow, 'confirmed'), false);
  assert.equal(await h.row(WORKSPACE_KEY), undefined);
  assert.deepEqual(await h.row(GATE_KEY), gate);
});

test('confirm assets, save first workspace, reopen SQLite and read persisted fields', async t => {
  const h = await fixture(t);
  const state = await h.post('/confirm', { projectId: 1, scriptId: 10, confirmed: true });
  assert.equal(state.ready, true);
  const gate = await h.row(GATE_KEY);
  const data = workspace('first');
  await h.post('/save', request(data));
  const saved = await h.row(WORKSPACE_KEY);
  assert.ok(saved, 'HTTP 200 must correspond to a persisted productionAgent row');
  assert.deepEqual(JSON.parse(saved.data), data);
  await h.reopen();
  const flow = await h.post('/get', request());
  assert.equal(flow.scriptPlan, data.scriptPlan);
  assert.equal(flow.storyboardTable, data.storyboardTable);
  assert.deepEqual(flow.workbench, data.workbench);
  assert.equal(Object.hasOwn(flow, 'confirmed'), false);
  assert.deepEqual(await h.row(GATE_KEY), gate);
  assert.equal((await h.db('o_agentWorkData')).length, 2);
});

test('repeat saves update one workspace without modifying Gate or other keys', async t => {
  const h = await fixture(t);
  await h.post('/confirm', { projectId: 1, scriptId: 10, confirmed: true });
  await h.db('o_agentWorkData').insert({ projectId: 1, episodesId: 10, key: 'otherAgent', data: '{"keep":true}' });
  const untouched = await h.db('o_agentWorkData').orderBy('id');
  await h.post('/save', request(workspace('first')));
  const first = await h.row(WORKSPACE_KEY);
  assert.ok(first, 'first save must insert a workspace even when other keys exist');
  const id = first.id;
  await h.post('/save', request(workspace('second')));
  await h.post('/save', request(workspace('second')));
  assert.equal((await h.row(WORKSPACE_KEY)).id, id);
  assert.deepEqual(JSON.parse((await h.row(WORKSPACE_KEY)).data), workspace('second'));
  assert.deepEqual(await h.db('o_agentWorkData').whereNot('key', WORKSPACE_KEY).orderBy('id'), untouched);
  assert.equal((await h.db('o_agentWorkData').where('key', WORKSPACE_KEY)).length, 1);
  assert.equal((await h.post('/get', request())).scriptPlan, 'director-second');
});

test('workspace without Gate retains first-save and existing-workspace behavior', async t => {
  const h = await fixture(t);
  await h.post('/save', request(workspace('legacy')));
  const first = await h.row(WORKSPACE_KEY);
  await h.post('/save', request(workspace('updated')));
  assert.equal((await h.row(WORKSPACE_KEY)).id, first.id);
  assert.equal((await h.post('/get', request())).scriptPlan, 'director-updated');
  assert.equal((await h.db('o_agentWorkData')).length, 1);
});

test('read and save stay scoped to both project and episode', async t => {
  const h = await fixture(t);
  await h.db('o_agentWorkData').insert([
    { projectId: 2, episodesId: 10, key: WORKSPACE_KEY, data: JSON.stringify(workspace('other-project')) },
    { projectId: 1, episodesId: 11, key: WORKSPACE_KEY, data: JSON.stringify(workspace('other-episode')) },
  ]);
  const untouched = await h.db('o_agentWorkData').orderBy('id');
  assert.equal((await h.post('/get', request())).scriptPlan, '');
  await h.post('/save', request(workspace('target')));
  await h.post('/save', request(workspace('target-updated')));
  assert.equal((await h.post('/get', request())).scriptPlan, 'director-target-updated');
  assert.deepEqual(await h.db('o_agentWorkData').whereIn('id', untouched.map(row => row.id)).orderBy('id'), untouched);
  assert.equal((await h.db('o_agentWorkData')).length, 3);
});

test('existing workspace is selected even when an unrelated key has invalid JSON', async t => {
  const h = await fixture(t);
  await h.db('o_agentWorkData').insert({ projectId: 1, episodesId: 10, key: GATE_KEY, data: 'not-workspace-json' });
  await h.db('o_agentWorkData').insert({ projectId: 1, episodesId: 10, key: WORKSPACE_KEY, data: JSON.stringify(workspace('existing')) });
  assert.equal((await h.post('/get', request())).scriptPlan, 'director-existing');
  await h.post('/save', request(workspace('saved')));
  assert.equal((await h.row(GATE_KEY)).data, 'not-workspace-json');
  assert.equal((await h.post('/get', request())).scriptPlan, 'director-saved');
});
