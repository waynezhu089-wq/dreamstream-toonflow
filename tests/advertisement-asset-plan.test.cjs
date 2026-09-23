const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const express = require('express');
const knex = require('knex');
const root = path.resolve(__dirname, '..');
function loader(utils) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }, fileName: file }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (name === '@/utils') return utils;
      if (name === 'uuid') return { v4: randomUUID };
      if (name.startsWith('@/')) return load(path.join(root, 'src', name.slice(2) + '.ts'));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      return require(name);
    }, module, module.exports);
    return module.exports;
  }
  return name => load(path.join(root, 'src', name + '.ts'));
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-plan-'));
  const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(dir, 'test.sqlite') }, useNullAsDefault: true });
  await db.schema.createTable('o_project', t => { t.integer('id').primary(); t.string('projectType'); t.string('type'); });
  await db.schema.createTable('o_script', t => { t.integer('id').primary(); t.integer('projectId'); t.integer('createTime'); });
  await db.schema.createTable('o_assets', t => { t.increments('id'); t.integer('projectId'); t.integer('scriptId'); t.integer('imageId'); t.integer('assetsId'); t.string('name'); t.string('type'); t.string('prompt'); t.bigInteger('startTime'); });
  await db.schema.createTable('o_image', t => { t.increments('id'); t.integer('assetsId'); t.string('filePath'); t.string('state'); t.string('model'); t.string('type'); });
  await db.schema.createTable('o_scriptAssets', t => { t.integer('scriptId'); t.integer('assetId'); t.primary(['scriptId', 'assetId']); });
  await db.schema.createTable('o_agentWorkData', t => { t.increments('id'); t.integer('projectId'); t.integer('episodesId'); t.string('key'); t.text('data'); t.integer('updateTime'); t.integer('createTime'); });
  await db('o_project').insert([{ id: 1, projectType: 'general_video', type: 'advertisement' }, { id: 2, projectType: 'general_video', type: 'advertisement' }, { id: 3, projectType: 'short_drama', type: 'story' }]);
  await db('o_script').insert([{ id: 10, projectId: 1 }, { id: 11, projectId: 1 }, { id: 20, projectId: 2 }, { id: 30, projectId: 3 }]);
  await db('o_assets').insert([{ id: 1, projectId: 1, imageId: 1 }, { id: 2, projectId: 1, imageId: 2 }, { id: 3, projectId: 2, imageId: 3 }]);
  await db('o_image').insert([1, 2, 3].map(id => ({ id, assetsId: id, filePath: '/generated/' + id, state: '已完成', model: 'test-ai' })));
  await db('o_scriptAssets').insert([{ scriptId: 10, assetId: 1 }, { scriptId: 11, assetId: 2 }, { scriptId: 20, assetId: 3 }]);
  const storage = { fail: false, writes: [] };
  const load = loader({ db, oss: { writeFile: async (file, bytes) => { if (storage.fail) throw Error('upload failed'); storage.writes.push({ file, bytes }); } } });
  const initialize = load('lib/advertisementAssetPlanSchema').initializeAssetPlanSchema;
  await initialize(db);
  const app = express(); app.use(express.json());
  load('middleware/productionGate').registerProductionGate(app);
  app.use('/api/project/advertisement/assetPlan', load('routes/project/advertisement/assetPlan').default);
  app.use('/api/production', (req, res) => res.json({ code: 200, data: 'dispatched' }));
  app.use('/upload', load('routes/assets/uploadClip').default);
  app.use('/save-image', load('routes/assets/saveAssets').default);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function post(route, body, status = 200) {
    route = route.replace(/^\/plan/, '/api/project/advertisement/assetPlan');
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json(); assert.equal(res.status, status, JSON.stringify(json)); return json.data;
  }
  const ctx = { projectId: 1, scriptId: 10 };
  const item = (overrides = {}) => ({ assetKey: 'brand-mark', name: 'Brand mark', category: 'brand', required: true, sourcePolicy: 'REAL_REQUIRED', assetId: null, ...overrides });
  const save = (items, context = ctx, status = 200) => post('/plan/save', { ...context, items }, status);
  const upload = async (context = ctx) => (await post('/upload', { ...context, name: 'uploaded', type: 'tool', base64Data: 'data:image/png;base64,aGVsbG8=' })).id;
  return { db, post, ctx, item, save, upload, storage, initialize, load };
}
test('same stable keys in different units remain isolated; replace and repeated save preserve flags without duplicates', async t => {
  const f = await fixture(t); const { db, ctx, item, save, post } = f;
  const items = [item(), item({ assetKey: 'environment', required: false, sourcePolicy: 'AI_ALLOWED', category: 'environment' })];
  await save(items); await save([item({ name: 'Other unit' })], { projectId: 1, scriptId: 11 });
  await Promise.all([save(items), save(items), save(items)]);
  assert.equal((await db('o_advertisementAssetPlan').where(ctx)).length, 2);
  const read = await post('/plan/read', ctx); assert.equal(read.items[0].required, true); assert.equal(read.items[1].required, false); assert.equal(read.items[1].sourcePolicy, 'AI_ALLOWED');
  await save([item({ name: 'renamed', category: 'custom' })]);
  assert.equal((await post('/plan/read', ctx)).items[0].assetKey, 'brand-mark');
  await save([]); assert.equal((await post('/plan/read', ctx)).items.length, 0);
  assert.equal((await post('/plan/read', { projectId: 1, scriptId: 11 })).items[0].name, 'Other unit');
});
test('actual uploadClip upload can bind REAL_REQUIRED; unbind is idempotent', async t => {
  const { db, ctx, item, save, upload, post, storage } = await fixture(t);
  await save([item()]); const assetId = await upload();
  assert.equal(storage.writes.length, 1); assert.equal((await db('o_assetUploadSource')).length, 1);
  const bound = await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId });
  assert.equal(bound.items[0].assetId, assetId); assert.equal(bound.items[0].bindingValid, true);
  await post('/plan/unbind', { ...ctx, assetKey: 'brand-mark' });
  assert.equal((await post('/plan/unbind', { ...ctx, assetKey: 'brand-mark' })).items[0].assetId, null);
});
test('actual saveAssets upload records provenance; selecting an AI image cannot reuse old proof', async t => {
  const { db, ctx, item, save, post } = await fixture(t);
  await post('/save-image', { id: 1, projectId: 1, type: 'tool', base64: 'data:image/png;base64,aGVsbG8=' });
  await save([item({ assetId: 1 })]);
  await post('/save-image', { id: 1, projectId: 1, type: 'tool', imageId: 1 });
  assert.equal((await post('/plan/read', ctx)).items[0].bindingIssue, 'ASSET_PLAN_REAL_SOURCE_REQUIRED');
  await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId: 1 }, 409);
  await post('/save-image', { id: 1, projectId: 2, type: 'tool', base64: 'data:image/png;base64,aA==' }, 400);
  assert.equal((await db('o_assetUploadSource')).length, 1);
});
test('REAL_REQUIRED rejects AI, unproven legacy upload paths and client-forged source declarations', async t => {
  const { db, ctx, item, save, post } = await fixture(t); await save([item()]);
  await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId: 1 }, 409);
  await db('o_image').where({ id: 1 }).update({ model: null, filePath: '/1/assets/looks-uploaded.png' });
  await save([item({ assetId: 1 })], ctx, 409);
  await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId: 1, source: 'upload' }, 400);
  assert.equal((await post('/plan/read', ctx)).items[0].assetId, null);
});
test('AI_ALLOWED accepts current-unit AI and uploaded assets', async t => {
  const { ctx, item, save, post, upload } = await fixture(t);
  await save([item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 })]);
  const assetId = await upload();
  assert.equal((await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId })).items[0].bindingValid, true);
});
test('cross-project and cross-unit binding rejected, including full save and explicit foreign script owner', async t => {
  const { db, ctx, item, save, post } = await fixture(t); await save([item({ sourcePolicy: 'AI_ALLOWED' })]);
  for (const assetId of [2, 3, 999]) {
    await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId }, 400);
    await save([item({ sourcePolicy: 'AI_ALLOWED', assetId })], ctx, 400);
  }
  await db('o_scriptAssets').insert({ scriptId: 10, assetId: 3 });
  await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId: 3 }, 400);
  await db('o_assets').where({ id: 1 }).update({ scriptId: 11 });
  await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId: 1 }, 400);
  assert.equal((await db('o_scriptAssets').where({ scriptId: 10, assetId: 2 })).length, 0);
});
test('missing/wrong unit, legacy profile, duplicate keys and malformed policies fail without writes', async t => {
  const { ctx, item, save, post } = await fixture(t); await save([item()]);
  for (const body of [{ projectId: 1 }, { projectId: 1, scriptId: 20 }, { projectId: 3, scriptId: 30 }, { projectId: 1, scriptId: 999 }]) await post('/plan/read', body, 400);
  await save([item(), item({ assetKey: ' brand-mark ' })], ctx, 400);
  await save([item({ sourcePolicy: 'UPLOAD' })], ctx, 400);
  await save([item({ required: 'true' })], ctx, 400);
  await post('/plan/bind', { ...ctx, assetKey: 'missing', assetId: 1 }, 404);
  await post('/plan/unbind', { ...ctx, assetKey: 'missing' }, 404);
  assert.equal((await post('/plan/read', ctx)).items.length, 1);
});
test('replacement rolls back deletions and partial inserts on database failure', async t => {
  const { db, ctx, item, save, post } = await fixture(t); await save([item()]);
  await db.raw(`CREATE TRIGGER fail_plan BEFORE INSERT ON o_advertisementAssetPlan WHEN NEW.name = 'fail' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  await save([item({ assetKey: 'new' }), item({ assetKey: 'bad', name: 'fail' })], ctx, 500);
  assert.deepEqual((await post('/plan/read', ctx)).items.map(i => i.assetKey), ['brand-mark']);
});
test('schema initialization is additive/idempotent; upload failure leaves no asset or source receipt', async t => {
  const { db, item, save, initialize, storage, post, ctx } = await fixture(t); await save([item()]);
  await initialize(db); assert.equal((await db('o_advertisementAssetPlan')).length, 1); assert.equal((await db('o_project')).length, 3);
  storage.fail = true;
  await post('/upload', { ...ctx, name: 'failure', base64Data: 'data:image/png;base64,aA==' }, 500);
  assert.equal((await db('o_assets')).length, 3); assert.equal((await db('o_assetUploadSource')).length, 0);
});
test('read detects removed unit relation and cannot accept proof for changed file or different asset image', async t => {
  const { db, ctx, item, save, upload, post } = await fixture(t); const assetId = await upload(); await save([item({ assetId })]);
  const asset = await db('o_assets').where({ id: assetId }).first();
  await db('o_image').where({ id: asset.imageId }).update({ filePath: '/changed.png' });
  assert.equal((await post('/plan/read', ctx)).items[0].bindingValid, false);
  await db('o_assets').where({ id: 1 }).update({ imageId: asset.imageId });
  await post('/plan/bind', { ...ctx, assetKey: 'brand-mark', assetId: 1 }, 409);
  await db('o_scriptAssets').where({ scriptId: 10, assetId }).delete();
  assert.equal((await post('/plan/read', ctx)).items[0].bindingIssue, 'ASSET_PLAN_ASSET_SCOPE_MISMATCH');
});
test('Gate reads the latest Asset Plan without mutating confirmation records', async t => {
  const { db, ctx, item, save, load } = await fixture(t);
  await db('o_agentWorkData').insert({ projectId: 1, episodesId: 10, key: 'advertisement:asset-preparation', data: '{"confirmed":true}', updateTime: 1 });
  const gate = load('services/advertisementGate'); const before = await gate.readState(1, 10); assert.equal(before.ready, false);
  await save([item()]); const after = await gate.readState(1, 10); assert.equal(after.ready, false); assert.equal(after.confirmed, true); assert.equal(after.incompleteAssets[0].reason, 'UNBOUND');
  assert.equal((await db('o_agentWorkData')).length, 1);
});

test('committed plans and upload receipts are visible through a reopened SQLite connection', async t => {
  const { db, ctx, item, save, upload } = await fixture(t);
  const assetId = await upload(); await save([item({ assetId })]);
  const reopened = knex({ client: 'better-sqlite3', connection: db.client.config.connection, useNullAsDefault: true });
  try {
    const read = await loader({ db: reopened })('services/advertisementAssetPlan').readAssetPlan(ctx);
    assert.equal(read.items[0].assetId, assetId); assert.equal(read.items[0].bindingValid, true);
  } finally { await reopened.destroy(); }
});

const gateStatus = (f, context = f.ctx) => f.post('/api/project/advertisement/getWorkflowState', context);
const confirmPlan = (f, status = 200, context = f.ctx) => f.post('/api/project/advertisement/confirmAssetPreparation', { ...context, confirmed: true }, status);
const production = (f, status, context = f.ctx) => f.post('/api/production/getFlowData', { projectId: context.projectId, episodesId: context.scriptId }, status);

test('DS-BE-004: empty plan and unbound required item deny confirmation and Production; preparation remains reachable', async t => {
  const f = await fixture(t);
  assert.equal((await gateStatus(f)).prepared, false); await confirmPlan(f, 400); await production(f, 409);
  await f.save([f.item()]); await confirmPlan(f, 400); await production(f, 409);
  assert.equal((await gateStatus(f)).incompleteAssets[0].reason, 'UNBOUND');
  const assetId = await f.upload();
  await f.post('/plan/bind', { ...f.ctx, assetKey: 'brand-mark', assetId });
  const prepared = await gateStatus(f); assert.equal(prepared.prepared, true); assert.equal(prepared.confirmed, false); assert.equal(prepared.ready, false);
  await production(f, 409); assert.equal((await confirmPlan(f)).ready, true); await production(f, 200);
  await f.post('/plan/unbind', { ...f.ctx, assetKey: 'brand-mark' }); await production(f, 409);
  await f.save([]); await confirmPlan(f, 400);
});
test('DS-BE-004: all required images must belong to their asset, be complete and have a nonblank path', async t => {
  const f = await fixture(t); await f.save([f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 })]); await confirmPlan(f);
  for (const update of [{ state: '生成中' }, { state: '失败' }, { state: '已完成', filePath: '' }, { filePath: '  ' }, { filePath: '/image', assetsId: 2 }]) {
    await f.db('o_image').where({ id: 1 }).update(update); assert.equal((await gateStatus(f)).prepared, false); await confirmPlan(f, 400); await production(f, 409);
  }
  await f.db('o_image').where({ id: 1 }).update({ assetsId: 1, state: '已完成', filePath: '/image' });
  assert.equal((await gateStatus(f)).ready, true);
  await f.db('o_image').where({ id: 1 }).delete(); await production(f, 409);
});
test('DS-BE-004: deleted/relinked assets and foreign project/unit bindings cannot pass Gate', async t => {
  const f = await fixture(t); await f.save([f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 })]); await confirmPlan(f);
  await f.db('o_scriptAssets').where({ scriptId: 10, assetId: 1 }).delete(); await production(f, 409); await confirmPlan(f, 400);
  await f.db('o_scriptAssets').insert({ scriptId: 10, assetId: 1 });
  for (const update of [{ scriptId: 11 }, { scriptId: null, projectId: 2 }]) {
    await f.db('o_assets').where({ id: 1 }).update(update); await production(f, 409);
  }
  await f.db('o_assets').where({ id: 1 }).update({ projectId: 1 });
  for (const assetId of [2, 3, 999]) {
    await f.db('o_advertisementAssetPlan').where(f.ctx).update({ assetId });
    assert.equal((await gateStatus(f)).incompleteAssets[0].reason, 'ASSET_PLAN_ASSET_SCOPE_MISMATCH'); await production(f, 409);
  }
  await f.db('o_advertisementAssetPlan').where(f.ctx).update({ assetId: 1 });
  await f.db('o_assets').where({ id: 1 }).delete(); await production(f, 409);
});
test('DS-BE-004: REAL_REQUIRED rechecks current upload evidence after confirmation', async t => {
  const f = await fixture(t); const assetId = await f.upload(); await f.save([f.item({ assetId })]); await confirmPlan(f);
  const asset = await f.db('o_assets').where({ id: assetId }).first();
  await f.db('o_image').where({ id: asset.imageId }).update({ model: 'ai-model' });
  assert.equal((await gateStatus(f)).incompleteAssets[0].reason, 'ASSET_PLAN_REAL_SOURCE_REQUIRED'); await production(f, 409);
  await f.db('o_image').where({ id: asset.imageId }).update({ model: null }); assert.equal((await gateStatus(f)).ready, true);
  await f.db('o_assetUploadSource').where({ assetId }).delete(); await confirmPlan(f, 400); await production(f, 409);
});
test('DS-BE-004: missing, invalid and incomplete optional items never block required completion', async t => {
  const f = await fixture(t);
  await f.save([f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 }), f.item({ assetKey: 'optional', required: false })]);
  assert.equal((await confirmPlan(f)).ready, true);
  await f.db('o_advertisementAssetPlan').where({ ...f.ctx, assetKey: 'optional' }).update({ assetId: 2 });
  let state = await gateStatus(f); assert.equal(state.ready, true); assert.equal(state.incompleteAssets.length, 0); assert.equal(state.planItems[1].ready, false);
  await f.db('o_scriptAssets').insert({ scriptId: 10, assetId: 2 });
  await f.save([f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 }), f.item({ assetKey: 'optional', sourcePolicy: 'AI_ALLOWED', required: false, assetId: 2 })]);
  await f.db('o_image').where({ id: 2 }).update({ state: '生成中', filePath: null });
  state = await gateStatus(f); assert.equal(state.ready, true); assert.equal(state.planItems[1].issue, 'ASSET_PLAN_IMAGE_INCOMPLETE');
  // An optional-only nonempty plan has no required obligations.
  await f.save([f.item({ required: false })]); assert.equal((await gateStatus(f)).ready, true);
  await f.save([]); assert.equal((await gateStatus(f)).ready, false);
});
test('DS-BE-004: Gate is strictly unit scoped and never falls back when IDs are absent or mismatched', async t => {
  const f = await fixture(t); await f.save([f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 })]); await confirmPlan(f);
  const other = { projectId: 1, scriptId: 11 };
  await confirmPlan(f, 400, other); await production(f, 409, other);
  await f.save([f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 2 })], other); await confirmPlan(f, 200, other);
  await f.save([]); await production(f, 409); await production(f, 200, other);
  for (const ctx of [{ projectId: 1 }, { projectId: 1, scriptId: 20 }, { projectId: 2, scriptId: 10 }]) {
    await f.post('/api/project/advertisement/getWorkflowState', ctx, 400); await confirmPlan(f, 400, ctx);
  }
  await production(f, 200, { projectId: 3, scriptId: 30 });
});
test('DS-BE-004: adding/changing/removing required items immediately reevaluates previously confirmed Gate', async t => {
  const f = await fixture(t); const ready = f.item({ sourcePolicy: 'AI_ALLOWED', assetId: 1 });
  await f.save([ready]); await confirmPlan(f);
  const pending = f.item({ assetKey: 'new-required', sourcePolicy: 'AI_ALLOWED' });
  await f.save([ready, pending]); let state = await gateStatus(f); assert.equal(state.confirmed, true); assert.equal(state.ready, false); await production(f, 409);
  await f.save([ready, { ...pending, required: false }]); await production(f, 200);
  await f.save([{ ...ready, sourcePolicy: 'REAL_REQUIRED', assetId: null }]); await production(f, 409);
  await f.save([ready]); await production(f, 200);
});
