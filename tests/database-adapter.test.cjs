const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toonflow-adapter-'));
  const cache = new Map();
  let wrapper;
  // Only legacy bootstrap and path selection are isolated. The actual db.ts
  // creates Knex, its SQLite connection and the production callable wrapper.
  // Full legacy bootstrap is also exercised by the real startup smoke check.
  function load(name) {
    const file = path.join(root, 'src', name + '.ts');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }, fileName: file }).outputText;
    new Function('require', 'module', 'exports', code)(id => {
      if (id === '@/utils/getPath') return name => path.join(dir, name);
      if (id === '@/lib/initDB' || id === '@/lib/fixDB') return async () => {};
      if (id === '@/utils') return { db: wrapper };
      if (id.startsWith('@/')) return load(id.slice(2));
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const { default: db, db: raw } = load('utils/db');
  wrapper = db;
  await new Promise(resolve => setImmediate(resolve));
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;
  t.after(async () => { await raw.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.notEqual(db, raw);
  assert.equal(typeof db, 'function');
  assert.equal(typeof db.transaction, 'function');
  await raw.schema.createTable('o_project', t => { t.integer('id').primary(); t.string('projectType'); t.string('type'); });
  await raw.schema.createTable('o_script', t => { t.integer('id').primary(); t.integer('projectId'); t.integer('createTime'); });
  await raw.schema.createTable('o_assets', t => { t.increments('id'); t.integer('projectId'); t.integer('scriptId'); t.integer('imageId'); t.integer('assetsId'); t.string('name'); t.string('type'); t.string('prompt'); t.bigInteger('startTime'); });
  await raw.schema.createTable('o_image', t => { t.increments('id'); t.integer('assetsId'); t.string('filePath'); t.string('state'); t.string('model'); t.string('type'); });
  await raw.schema.createTable('o_scriptAssets', t => { t.integer('scriptId'); t.integer('assetId'); t.primary(['scriptId', 'assetId']); });
  await raw.schema.createTable('o_agentWorkData', t => { t.increments('id'); t.integer('projectId'); t.integer('episodesId'); t.string('key'); t.text('data'); t.integer('updateTime'); t.integer('createTime'); });
  await db('o_project').insert([{ id: 1, projectType: 'general_video', type: 'advertisement' }, { id: 2, projectType: 'general_video', type: 'advertisement' }, { id: 3, projectType: 'short_drama', type: 'story' }]);
  await db('o_script').insert([{ id: 10, projectId: 1 }, { id: 11, projectId: 1 }, { id: 20, projectId: 2 }, { id: 30, projectId: 3 }]);
  await db('o_assets').insert([{ id: 1, projectId: 1, imageId: 1 }, { id: 2, projectId: 1, imageId: 2 }, { id: 3, projectId: 2, imageId: 3 }]);
  await db('o_image').insert([1, 2, 3].map(id => ({ id, assetsId: id, filePath: '/generated/' + id, state: '已完成', model: 'test-ai' })));
  await db('o_scriptAssets').insert([{ scriptId: 10, assetId: 1 }, { scriptId: 11, assetId: 2 }, { scriptId: 20, assetId: 3 }]);

  return { db, raw, load, ctx: { projectId: 1, scriptId: 10 } };
}

test('real runtime wrapper initializes Asset Plan schema, saves/reads plans and reads Gate state', async t => {
  const { db, load, ctx } = await fixture(t);
  const initialize = load('lib/advertisementAssetPlanSchema').initializeAssetPlanSchema;
  await initialize(db); await initialize(db);
  assert.equal(await db.transaction(trx => trx.schema.hasTable('o_advertisementAssetPlan')), true);
  assert.equal(await db.transaction(trx => trx.schema.hasTable('o_assetUploadSource')), true);
  const plan = load('services/advertisementAssetPlan');
  const items = [{ assetKey: 'scene', name: 'Scene', category: 'environment', required: true, sourcePolicy: 'AI_ALLOWED', assetId: 1 }];
  await plan.saveAssetPlan({ ...ctx, items });
  const read = await plan.readAssetPlan(ctx);
  assert.equal(read.items.length, 1);
  assert.equal(read.items[0].assetKey, 'scene');
  assert.equal(read.items[0].bindingValid, true);
  const state = await load('services/advertisementGate').readState(1, 10);
  assert.equal(state.prepared, true);
  assert.equal(state.ready, false);
  assert.equal(state.requiredAssetCount, 1);
});

test('real runtime wrapper commits callback and explicit transactions; legacy table calls still work', async t => {
  const { db } = await fixture(t);
  assert.equal(await db.transaction(async trx => {
    await trx('o_project').insert({ id: 40, type: 'committed' });
    return 'committed';
  }), 'committed');
  assert.equal((await db('o_project').where({ id: 40 }).first()).type, 'committed');
  const trx = await db.transaction();
  await trx('o_project').insert({ id: 41, type: 'explicit' });
  await trx.commit();
  assert.equal((await db('o_project').where({ id: 41 }).first()).type, 'explicit');
});

test('real runtime wrapper rolls back failed transactions and partial Asset Plan replacement', async t => {
  const { db, raw, load, ctx } = await fixture(t);
  await assert.rejects(db.transaction(async trx => {
    await trx('o_project').insert({ id: 40 });
    throw new Error('rollback probe');
  }), /rollback probe/);
  assert.equal(await db('o_project').where({ id: 40 }).first(), undefined);
  await load('lib/advertisementAssetPlanSchema').initializeAssetPlanSchema(db);
  const plan = load('services/advertisementAssetPlan');
  const item = { assetKey: 'original', name: 'Original', category: 'brand', required: true, sourcePolicy: 'REAL_REQUIRED', assetId: null };
  await plan.saveAssetPlan({ ...ctx, items: [item] });
  await raw.raw("CREATE TRIGGER fail_plan BEFORE INSERT ON o_advertisementAssetPlan WHEN NEW.name = 'fail' BEGIN SELECT RAISE(ABORT, 'rollback probe'); END");
  await assert.rejects(plan.saveAssetPlan({ ...ctx, items: [{ ...item, assetKey: 'new' }, { ...item, assetKey: 'bad', name: 'fail' }] }), /rollback probe/);
  assert.deepEqual((await plan.readAssetPlan(ctx)).items.map(i => i.assetKey), ['original']);
});

