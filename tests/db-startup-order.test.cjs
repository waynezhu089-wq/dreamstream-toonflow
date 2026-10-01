const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const knex = require('knex');
const Database = require('better-sqlite3');
const ts = require('typescript');
const esbuild = require('esbuild');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const sourceModel = path.join(root, 'data', 'models', 'all-MiniLM-L6-v2');
const bundlePath = path.join(root, 'tests', `.db-startup-app-${process.pid}.cjs`);
let bundlePromise;
after(() => fs.rmSync(bundlePath, { force: true }));
function currentAppBundle() {
  bundlePromise ??= esbuild.build({ entryPoints: ['src/app.ts'], outfile: bundlePath, absWorkingDir: root,
    bundle: true, platform: 'node', format: 'cjs', target: 'esnext', packages: 'external',
    tsconfig: './tsconfig.json', alias: { '@': './src' },
    define: { __APP_VERSION__: JSON.stringify(require('../package.json').version) } }).then(() => bundlePath);
  return bundlePromise;
}
const columns = {
  o_script: ['revisionEpoch'],
  o_storyboard: ['retiredAt', 'retiredByRevisionId'],
  o_stageEvent: ['revisionId', 'actorUserId', 'actorDisplayName'],
  o_productionAttempt: ['invalidatedByRevisionId'],
  o_supervisorReview: ['revisionEpoch'],
  o_videoTrack: ['storyboardManaged', 'promptRevisionEpoch'],
  o_video: ['revisionWorkGuardId'],
};
const requiredTriggers = [
  'production_revision_no_update', 'production_revision_no_delete', 'production_revision_epoch_insert',
  'revision_guard_valid_insert', 'revision_guard_valid_update', 'revision_guard_no_delete',
  'video_track_managed_insert', 'video_track_managed_update',
];
const requiredIndexes = ['idx_revision_guard_scope_state', 'idx_revision_guard_prompt_active', 'idx_video_revision_guard'];

function temporaryData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toonflow-db-startup-'));
  const modelDir = path.join(dir, 'models', 'all-MiniLM-L6-v2');
  fs.mkdirSync(path.dirname(modelDir), { recursive: true });
  assert.ok(fs.existsSync(path.join(sourceModel, 'onnx', 'model_fp16.onnx')), 'local no-paid embedding fixture must exist');
  try { fs.symlinkSync(sourceModel, modelDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { fs.cpSync(sourceModel, modelDir, { recursive: true }); }
  t.after(() => {
    const resolved = path.resolve(dir), temp = path.resolve(os.tmpdir());
    assert.ok(path.basename(resolved).startsWith('toonflow-db-startup-') && resolved.startsWith(temp + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { dir, file: path.join(dir, 'db2.sqlite') };
}

function inspect(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const names = new Set(db.prepare("select name from sqlite_master where type='table'").all().map(row => row.name));
    for (const name of ['o_user', 'o_project', 'o_script', 'o_storyboard', 'o_productionRevision', 'o_revisionWorkGuard'])
      assert.ok(names.has(name), `missing base/additive table ${name}`);
    for (const [table, expected] of Object.entries(columns)) {
      const actual = new Set(db.prepare(`pragma table_info(${table})`).all().map(row => row.name));
      for (const name of expected) assert.ok(actual.has(name), `missing ${table}.${name}`);
    }
    const triggers = new Set(db.prepare("select name from sqlite_master where type='trigger'").all().map(row => row.name));
    for (const name of requiredTriggers) assert.ok(triggers.has(name), `missing trigger ${name}`);
    const indexes = new Set(db.prepare("select name from sqlite_master where type='index'").all().map(row => row.name));
    for (const name of requiredIndexes) assert.ok(indexes.has(name), `missing index ${name}`);
    return { tableCount: names.size, triggers: [...triggers].filter(name => requiredTriggers.includes(name)).sort(),
      indexes: [...indexes].filter(name => requiredIndexes.includes(name)).sort() };
  } finally { db.close(); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startOnce(t, dir, options = {}) {
  const port = await freePort();
  const bundle = await currentAppBundle();
  const preloads = ['--require', path.join(__dirname, 'helpers', 'db-startup-port.cjs')];
  if (options.failThumbnailSendFile) preloads.push('--require', path.join(__dirname, 'helpers', 'oss-sendfile-failure.cjs'));
  const child = spawn(process.execPath, [...preloads, bundle], {
    cwd: root, env: { ...process.env, NODE_ENV: 'prod', TOONFLOW_DATA_DIR: dir,
      TOONFLOW_DB_STARTUP_TEST_PORT: String(port), DS_REVISION_CONFIRM_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '', errorOutput = '', exited = false;
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  child.on('exit', () => { exited = true; });
  const stop = async () => {
    if (exited) return;
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('startup child did not exit')), 10000))]);
  };
  t.after(stop);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`application exited before ready: ${output.slice(-1000)} ${errorOutput.slice(-1000)}`);
    if (output.includes('[服务启动成功]')) {
      const local = new Database(path.join(dir, 'db2.sqlite'), { readonly: true, fileMustExist: true });
      const account = local.prepare('select name,password from o_user order by id limit 1').get();
      local.close();
      const response = await fetch(`http://127.0.0.1:${port}/api/login/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: account.name, password: account.password }),
      });
      assert.equal(response.status, 200, `startup HTTP route not ready: ${await response.text()}`);
      return { stop, port, output: () => output, errors: () => errorOutput };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`application did not become ready: ${output.slice(-1000)} ${errorOutput.slice(-1000)}`);
}

// Load the real base-schema builder into a dedicated temporary SQLite without
// importing db.ts (which itself starts the application bootstrap).
function baseBuilder() {
  const file = path.join(root, 'src', 'lib', 'initDB.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => id === '@/utils/agent/embedding'
    ? { getEmbedding: async () => [0, 0, 0] } : require(id), module, module.exports);
  return module.exports.default;
}

test('fresh empty SQLite first boot creates base and complete B3-B schema before ready, without restart', async t => {
  const { dir, file } = temporaryData(t);
  assert.equal(fs.existsSync(file), false);
  const app = await startOnce(t, dir);
  const schema = inspect(file);
  assert.ok(schema.tableCount >= 45);
  assert.doesNotMatch(app.errors(), /SqliteError|UnhandledPromiseRejection|no such column/);
  await app.stop();
});

test('real /oss middleware serves original, generated thumbnail and original fallback', async t => {
  const { dir } = temporaryData(t);
  const original = path.join(dir, 'oss', 'capability', 'thumbnail-test', 'image-0.png');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  const source = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#164070' } }).png().toBuffer();
  fs.writeFileSync(original, source);
  const app = await startOnce(t, dir, { failThumbnailSendFile: true });
  try {
    const base = `http://127.0.0.1:${app.port}/oss/capability/thumbnail-test`;
    const full = await fetch(`${base}/image-0.png`);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-type'), /^image\/png/);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), source);

    const thumb = await fetch(`${base}/image-0.png?size=20`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers.get('content-type'), /^image\/png/);
    const thumbBytes = Buffer.from(await thumb.arrayBuffer());
    assert.deepEqual(await sharp(thumbBytes).metadata().then(({ width, height }) => ({ width, height })),
      { width: 13, height: 13 });
    assert.ok(fs.existsSync(path.join(dir, 'oss', 'smallImage', 'capability', 'thumbnail-test', 'image-0_20p.png')));

    const invalid = await fetch(`${base}/image-0.png?size=not-a-size`);
    assert.equal(invalid.status, 200);
    assert.deepEqual(Buffer.from(await invalid.arrayBuffer()), source);

    const bad = path.join(dir, 'oss', 'capability', 'thumbnail-test', 'bad.png');
    const badBytes = Buffer.from('invalid image bytes');
    fs.writeFileSync(bad, badBytes);
    const fallback = await fetch(`${base}/bad.png?size=20`);
    assert.equal(fallback.status, 200);
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), badBytes);

    const unreadable = path.join(dir, 'oss', 'capability', 'thumbnail-test', 'unreadable.png');
    fs.writeFileSync(unreadable, source);
    // ensureThumbnail considers an existing path ready; a directory at that
    // location makes the HTTP send fail and must still preserve original fallback.
    fs.mkdirSync(path.join(dir, 'oss', 'smallImage', 'capability', 'thumbnail-test', 'unreadable_20p.png'));
    const sendFailure = await fetch(`${base}/unreadable.png?size=20`);
    assert.equal(sendFailure.status, 200);
    assert.deepEqual(Buffer.from(await sendFailure.arrayBuffer()), source);
  } finally { await app.stop(); }
});

test('one startup upgrades an existing real base schema while retaining business rows', async t => {
  const { dir, file } = temporaryData(t);
  const raw = knex({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true });
  try {
    await baseBuilder()(raw);
    await raw('o_project').insert({ id: 7001, name: 'Existing business project', projectType: 'general_video', type: 'advertisement' });
    await raw('o_script').insert({ id: 7002, projectId: 7001, name: 'Existing unit', content: 'Keep me' });
    assert.equal(await raw.schema.hasColumn('o_script', 'revisionEpoch'), false);
    assert.equal(await raw.schema.hasTable('o_productionRevision'), false);
  } finally { await raw.destroy(); }
  const app = await startOnce(t, dir);
  inspect(file);
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(db.prepare('select name from o_project where id=7001').get().name, 'Existing business project');
    assert.equal(db.prepare('select content,revisionEpoch from o_script where id=7002').get().content, 'Keep me');
    assert.equal(db.prepare('select revisionEpoch from o_script where id=7002').get().revisionEpoch, 0);
  } finally { db.close(); }
  await app.stop();
});

test('repeated startup is idempotent and preserves existing data', async t => {
  const { dir, file } = temporaryData(t);
  const first = await startOnce(t, dir);
  const before = inspect(file);
  await first.stop();
  const second = await startOnce(t, dir);
  const after = inspect(file);
  assert.deepEqual(after, before);
  assert.doesNotMatch(second.errors(), /SqliteError|UnhandledPromiseRejection|no such column/);
  await second.stop();
});

test('controlled init barrier prevents actual startServe from entering additive schema early', async t => {
  const { dir } = temporaryData(t);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const events = [];
  const cache = new Map();
  function load(name) {
    const file = path.join(root, 'src', name + '.ts');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(id => {
      if (id === '@/utils/getPath') return Object.assign(name => path.join(dir, name), { isEletron: () => false });
      if (id === '@/lib/initDB') return async () => { events.push('base-start'); await barrier; events.push('base-done'); };
      if (id === '@/lib/fixDB') return async () => { events.push('fix-done'); };
      if (id === '@/utils') return { db: load('utils/db').default, getPath: name => path.join(dir, name) };
      if (id === '@/utils/db') return load('utils/db');
      if (id === '@/lib/advertisementAssetPlanSchema') return { initializeAssetPlanSchema: async () => {
        events.push('additive-start'); throw new Error('STOP_AFTER_FIRST_ADDITIVE');
      } };
      if (id.startsWith('@/')) return {};
      if (id === './err' || id === './env') return {};
      return require(id);
    }, module, module.exports);
    return module.exports;
  }
  const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true });
  let app;
  try { app = load('app'); }
  finally {
    if (originalElectron) Object.defineProperty(process.versions, 'electron', originalElectron);
    else delete process.versions.electron;
  }
  const starting = app.default();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['base-start']);
  release();
  await assert.rejects(starting, /STOP_AFTER_FIRST_ADDITIVE/);
  assert.deepEqual(events, ['base-start', 'base-done', 'fix-done', 'additive-start']);
  await load('utils/db').db.destroy();
});
