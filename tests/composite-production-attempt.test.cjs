const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { fixture } = require('./composite-fixture.cjs');

const scope = { projectId: 1, scriptId: 10 };
const quad = { topLeft: { x: 40, y: 30 }, topRight: { x: 200, y: 40 }, bottomRight: { x: 210, y: 225 }, bottomLeft: { x: 50, y: 230 } };
const stages = [
  { stageKey: 'asset-preparation', uiOrder: 10, exitGateKey: 'advertisement.asset-ready', operationKeys: [] },
  { stageKey: 'supervisor-review', uiOrder: 20, exitGateKey: 'supervisor.storyboard-approved.v2', operationKeys: [] },
  { stageKey: 'image-production', uiOrder: 30, exitGateKey: null, operationKeys: ['storyboard.image.generate', 'storyboard.image.attach', 'storyboard.image.composite'] },
].map(s => ({ displayName: s.stageKey, description: '', required: true, allowSkip: false, entryGateKey: null, ...s }));

async function setup(t) {
  const f = await fixture(t);
  const source = await sharp({ create: { width: 40, height: 80, channels: 4, background: '#f04080' } }).png().toBuffer();
  const background = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#204060' } }).png().toBuffer();
  const files = new Map([['/generated/1', source], ['1/editor/kept.png', source]]);
  f.utils.oss.getFile = async p => { if (!files.has(p)) throw Error(`file missing: ${p}`); return files.get(p); };
  f.utils.oss.writeFile = async (p, bytes) => { files.set(p, bytes); };
  f.utils.oss.getFileUrl = async p => p;
  let providerCalls = 0, provider = async () => ({ bytes: background, promptId: 'local-fixture' });
  f.load('services/compositeBackground').generateCompositeBackground = async input => { providerCalls++; return provider(input); };
  await f.load('lib/compositeAttemptSchema').initializeCompositeAttemptSchema(f.db);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  const registry = f.load('services/orchestrator/profileRegistry');
  const orchestrator = f.load('services/orchestrator/stageOrchestrator');
  const review = f.load('services/supervisor/review');
  const kernel = f.load('services/productionAttempt');
  const composite = f.load('services/compositeAttempt');
  const attach = f.load('services/manualAttach');
  await registry.createVersion({ profileKey: 'advertisement', definition: { schemaVersion: 2, runtimeControl: 'ENFORCED', initialStageKey: 'asset-preparation', stages,
    transitions: [{ fromStageKey: 'asset-preparation', toStageKey: 'supervisor-review' }, { fromStageKey: 'supervisor-review', toStageKey: 'image-production' }] } });
  await registry.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await registry.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  const created = await f.create();
  const shot = { ...scope, storyboardId: created.id };
  const row = () => f.db('o_storyboard').where({ id: created.id }).first();
  const generic = id => f.db('o_productionAttempt').where({ attemptId: id }).first();
  async function decide() {
    const input = { ...scope, reviewKey: 'storyboard.semantic-approval.v2' };
    const target = await review.targetRead(input);
    return review.decide({ ...input, expectedTargetHash: target.target.targetHash, expectedControlContextHash: target.controlContextHash,
      decision: 'PASS', summary: 'Approved', issues: [] }, { id: 1, name: 'Reviewer' });
  }
  await orchestrator.actOnStage('start', { ...scope, stageKey: 'asset-preparation' });
  await orchestrator.actOnStage('complete', { ...scope, stageKey: 'asset-preparation' });
  await orchestrator.actOnStage('start', { ...scope, stageKey: 'supervisor-review' });
  await decide();
  await orchestrator.actOnStage('complete', { ...scope, stageKey: 'supervisor-review' });
  await orchestrator.actOnStage('start', { ...scope, stageKey: 'image-production' });
  const direct = await kernel.beginStoryboardImageAttempt(shot);
  await kernel.runStoryboardImageAttempt(direct);
  const old = await row();
  await f.db('o_storyboard').where({ id: created.id }).update({ productionSpec: JSON.stringify({
    schemaVersion: 1, productionMode: 'REAL_AI_COMPOSITE', primaryAssetId: 1, referenceAssetIds: [], referenceAssetGroupIds: [],
    promptSkillId: null, promptSkillVersion: null, capabilityId: null }), imagePrompt: 'Execution prompt' });
  await decide();
  const input = { ...shot, primaryAssetId: 1, backgroundCapabilityId: 'comfy.z-image-turbo.txt2img.v1', prompt: 'Blank screen', width: 256, height: 256, seed: 1 };
  const start = () => composite.createCompositeAttempt(input);
  const run = a => composite.runCompositeBackground({ ...shot, attemptId: a.id });
  const finish = a => composite.finishCompositeAttempt({ ...shot, attemptId: a.id, screenQuad: quad, confirmed: true });
  await f.raw.schema.alterTable('o_imageFlow', table => table.text('flowData'));
  const [flowId] = await f.db('o_imageFlow').insert({ flowData: JSON.stringify({ nodes: [{ id: 'upload-1', type: 'upload', data: { image: '1/editor/kept.png' } }], edges: [] }) });
  const beginAttach = () => attach.beginManualAttachAttempt(shot, flowId, '1/editor/kept.png');
  return { ...f, shot, old, row, generic, kernel, composite, attach, files, source, background, input, start, run, finish,
    beginAttach, flowId, decide, providerCalls: () => providerCalls, setProvider: fn => { provider = fn; },
    provenance: async () => (await kernel.readImageProvenance(1, 10, [await row()])).get(created.id) };
}

test('schema upgrades existing rows, adds unique nullable linkage, and remains idempotent', async t => {
  const f = await fixture(t);
  await f.db.schema.createTable('o_compositeAttempt', table => { table.increments('id'); table.text('status'); });
  const [id] = await f.db('o_compositeAttempt').insert({ status: 'COMPLETED' });
  const migrate = f.load('lib/compositeAttemptSchema').initializeCompositeAttemptSchema;
  await migrate(f.db); await migrate(f.db);
  assert.equal(await f.raw.schema.hasColumn('o_compositeAttempt', 'productionAttemptId'), true);
  assert.equal((await f.db('o_compositeAttempt').where({ id }).first()).productionAttemptId, null);
  await f.db('o_compositeAttempt').insert({ status: 'COMPLETED', productionAttemptId: 'same' });
  await assert.rejects(f.db('o_compositeAttempt').insert({ status: 'COMPLETED', productionAttemptId: 'same' }));
});

test('start owns long-lived Attempt, retains old image, background waits, and final converges atomically', async t => {
  const f = await setup(t);
  const a = await f.start(), link = await f.generic(a.productionAttemptId);
  assert.equal(link.status, 'RUNNING'); assert.equal(link.producerType, 'REAL_AI_COMPOSITE');
  assert.equal(link.producerRef, `compositeAttempt:${a.id}`);
  assert.equal((await f.row()).activeImageAttemptId, a.productionAttemptId);
  assert.equal((await f.row()).filePath, f.old.filePath);
  assert.equal((await f.row()).currentImageAttemptId, f.old.currentImageAttemptId);
  assert.notEqual(a.sourceHash, link.sourceHash);
  const awaiting = await f.run(a);
  assert.equal(awaiting.status, 'AWAITING_QUAD'); assert.equal((await f.generic(a.productionAttemptId)).status, 'RUNNING');
  assert.equal((await f.row()).activeImageAttemptId, a.productionAttemptId);
  assert.equal((await f.row()).filePath, f.old.filePath);
  assert.equal(f.providerCalls(), 1);
  for (const bad of [{ ...quad, topLeft: { x: -1, y: 0 } }, undefined]) await assert.rejects(
    f.composite.finishCompositeAttempt({ ...f.shot, attemptId: a.id, screenQuad: bad, confirmed: true }));
  await assert.rejects(f.composite.finishCompositeAttempt({ ...f.shot, attemptId: a.id, screenQuad: quad, confirmed: false }));
  assert.equal((await f.row()).activeImageAttemptId, a.productionAttemptId);
  assert.equal((await f.composite.readCompositeAttempt({ ...f.shot, attemptId: a.id })).status, 'AWAITING_QUAD');
  const done = await f.finish(a);
  assert.equal(done.status, 'COMPLETED'); assert.equal((await f.generic(a.productionAttemptId)).status, 'SUCCEEDED');
  assert.equal((await f.row()).filePath, done.finalPath);
  assert.equal((await f.row()).currentImageAttemptId, a.productionAttemptId);
  assert.equal((await f.row()).activeImageAttemptId, null);
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  assert.equal((await f.provenance()).producerRef, `compositeAttempt:${a.id}`);
  const pixels = await sharp(f.files.get(done.finalPath)).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray((100 * 256 + 100) * 4, (100 * 256 + 100) * 4 + 4)], [240, 64, 128, 255]);
});

test('source drift before provider prevents call; drift after provider retains background and old current', async t => {
  const f = await setup(t), a = await f.start();
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ imagePrompt: 'changed before provider' });
  assert.equal((await f.run(a)).status, 'STALE'); assert.equal(f.providerCalls(), 0);
  assert.equal((await f.row()).filePath, f.old.filePath);
  await f.decide();
  let release, entered;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  f.setProvider(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const b = await f.start(), work = f.run(b);
  await providerEntered;
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ imagePrompt: 'changed after provider' });
  release({ bytes: f.background, promptId: 'local-delayed' });
  const stale = await work;
  assert.equal(stale.status, 'STALE'); assert.ok(stale.backgroundPath); assert.equal((await f.generic(b.productionAttemptId)).status, 'STALE');
  assert.equal((await f.row()).filePath, f.old.filePath);
});

test('generate, attach, and composite share one subject owner in both directions', async t => {
  const f = await setup(t);
  const compositeSpec = (await f.row()).productionSpec;
  const directSpec = JSON.stringify({ ...JSON.parse(compositeSpec), productionMode: 'REAL_ASSET_DIRECT' });
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ productionSpec: directSpec }); await f.decide();
  const generate = await f.kernel.beginStoryboardImageAttempt(f.shot);
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ productionSpec: compositeSpec }); await f.decide();
  const compositeA = await f.start();
  assert.equal((await f.generic(generate.attemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
  assert.equal((await f.kernel.runStoryboardImageAttempt(generate)).status, 'STALE');
  await f.run(compositeA);
  const attachA = await f.beginAttach();
  assert.equal((await f.generic(compositeA.productionAttemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
  assert.equal((await f.composite.readCompositeAttempt({ ...f.shot, attemptId: compositeA.id })).status, 'STALE');
  const compositeB = await f.start();
  assert.equal((await f.generic(attachA.attemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
  assert.equal((await f.attach.finishManualAttachAttempt(attachA.attemptId)).status, 'STALE');
  await f.run(compositeB);
  const compositeC = await f.start();
  assert.equal((await f.generic(compositeB.productionAttemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
  assert.equal((await f.composite.readCompositeAttempt({ ...f.shot, attemptId: compositeB.id })).status, 'STALE');
  await f.run(compositeC);
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ productionSpec: directSpec }); await f.decide();
  const generateB = await f.kernel.beginStoryboardImageAttempt(f.shot);
  assert.equal((await f.generic(compositeC.productionAttemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
  assert.equal((await f.row()).activeImageAttemptId, generateB.attemptId);
  assert.equal((await f.row()).filePath, f.old.filePath);
});

test('final worker after supersession retains historical final without changing current image', async t => {
  const f = await setup(t), a = await f.start(); await f.run(a);
  const geometry = f.load('services/compositeGeometry');
  const original = geometry.perspectiveComposite;
  let release, entered;
  const composing = new Promise(resolve => { entered = resolve; });
  geometry.perspectiveComposite = async (...args) => { entered(); return new Promise(resolve => { release = () => resolve(original(...args)); }); };
  t.after(() => { geometry.perspectiveComposite = original; });
  const work = f.finish(a);
  await composing;
  const newer = await f.beginAttach();
  release();
  const result = await work;
  assert.equal(result.status, 'STALE'); assert.ok(result.finalPath);
  assert.equal((await f.generic(a.productionAttemptId)).status, 'STALE');
  assert.equal((await f.row()).activeImageAttemptId, newer.attemptId);
  assert.equal((await f.row()).filePath, f.old.filePath);
  assert.equal((await f.row()).currentImageAttemptId, f.old.currentImageAttemptId);
});

test('background and final failures retain current image and source drift stales completed composite', async t => {
  const f = await setup(t), a = await f.start();
  f.setProvider(async () => { throw Error('local provider failed'); });
  const failed = await f.run(a);
  assert.equal(failed.status, 'FAILED'); assert.equal((await f.generic(a.productionAttemptId)).status, 'FAILED');
  assert.equal((await f.row()).filePath, f.old.filePath);
  f.setProvider(async () => ({ bytes: f.background, promptId: 'local' }));
  const b = await f.start(); await f.run(b);
  f.files.set((await f.composite.readCompositeAttempt({ ...f.shot, attemptId: b.id })).backgroundPath, f.source);
  const broken = await f.finish(b);
  assert.equal(broken.status, 'FAILED'); assert.equal((await f.row()).filePath, f.old.filePath);
  const c = await f.start(); await f.run(c); await f.finish(c);
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.db('o_project').where({ id: 1 }).update({ imageModel: 'unrelated:image', imageQuality: '4K' });
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ imagePrompt: 'new execution' });
  assert.equal((await f.provenance()).freshness, 'STALE');
  assert.equal((await f.generic(c.productionAttemptId)).status, 'SUCCEEDED');
});

test('exact Composite Shot Source includes real upload and execution intent, without unrelated model settings', async t => {
  const f = await setup(t), a = await f.start(); await f.run(a); await f.finish(a);
  const generic = await f.generic(a.productionAttemptId), snapshot = JSON.parse(generic.sourceSnapshot);
  assert.equal(snapshot.semantic.productionMode, 'REAL_AI_COMPOSITE');
  assert.equal(snapshot.execution.asset.assetId, 1);
  assert.equal(snapshot.execution.asset.imageId, 1);
  assert.equal(snapshot.execution.asset.sourcePolicy, 'REAL_REQUIRED');
  assert.equal(snapshot.execution.asset.filePath, '/generated/1');
  assert.equal(snapshot.execution.imagePrompt, 'Execution prompt');
  assert.equal(snapshot.execution.imageModel, undefined);
  assert.notEqual(snapshot.execution.asset.uploadedAt, undefined);
  const baseline = await f.row(), spec = JSON.parse(baseline.productionSpec);
  const changes = [
    { imagePrompt: 'changed execution' }, { prompt: 'changed semantic' },
    { productionSpec: JSON.stringify({ ...spec, promptSkillId: 'skill.image', promptSkillVersion: 'v2' }) },
    { productionSpec: JSON.stringify({ ...spec, capabilityId: 'comfy.other.v2' }) },
  ];
  for (const change of changes) {
    await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update(change);
    assert.equal((await f.provenance()).freshness, 'STALE');
    await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ prompt: baseline.prompt, imagePrompt: baseline.imagePrompt, productionSpec: baseline.productionSpec });
    assert.equal((await f.provenance()).freshness, 'CURRENT');
  }
  await f.db('o_project').where({ id: 1 }).update({ imageModel: 'new:image', imageQuality: '2K', videoRatio: '9:16' });
  assert.equal((await f.provenance()).freshness, 'CURRENT');
  await f.db('o_assetUploadSource').where({ projectId: 1, assetId: 1 }).delete();
  assert.equal((await f.provenance()).freshness, 'STALE');
});

test('control drift before and during background prevents stale provider output attaching', async t => {
  const f = await setup(t), a = await f.start();
  await f.db('o_stageRun').where({ ...scope, stageKey: 'image-production' }).update({ state: 'COMPLETED' });
  assert.equal((await f.run(a)).status, 'STALE'); assert.equal(f.providerCalls(), 0);
  assert.equal((await f.row()).filePath, f.old.filePath);
  await f.db('o_stageRun').where({ ...scope, stageKey: 'image-production' }).update({ state: 'IN_PROGRESS' });
  let release, entered;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  f.setProvider(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const b = await f.start(), work = f.run(b);
  await providerEntered;
  await f.db('o_stageRun').where({ ...scope, stageKey: 'image-production' }).update({ state: 'COMPLETED' });
  release({ bytes: f.background, promptId: 'local-delayed' });
  const stale = await work;
  assert.equal(stale.status, 'STALE'); assert.ok(stale.backgroundPath);
  assert.equal((await f.generic(b.productionAttemptId)).staleCode, 'PRODUCTION_CONTROL_CHANGED');
  assert.equal((await f.row()).filePath, f.old.filePath);
});

test('final result after source drift is historical STALE and never replaces old current', async t => {
  const f = await setup(t), a = await f.start(); await f.run(a);
  const geometry = f.load('services/compositeGeometry'), original = geometry.perspectiveComposite;
  let release, entered;
  const composing = new Promise(resolve => { entered = resolve; });
  geometry.perspectiveComposite = async (...args) => { entered(); return new Promise(resolve => { release = () => resolve(original(...args)); }); };
  t.after(() => { geometry.perspectiveComposite = original; });
  const work = f.finish(a); await composing;
  await f.db('o_storyboard').where({ id: f.shot.storyboardId }).update({ imagePrompt: 'changed while compositing' });
  release();
  const stale = await work;
  assert.equal(stale.status, 'STALE'); assert.ok(stale.finalPath);
  assert.equal((await f.generic(a.productionAttemptId)).staleCode, 'PRODUCTION_SOURCE_CHANGED');
  assert.equal((await f.row()).filePath, f.old.filePath);
  assert.equal((await f.row()).currentImageAttemptId, f.old.currentImageAttemptId);
});

test('mixed direct and Composite provenance uses bounded batched source reads', async t => {
  const f = await setup(t), a = await f.start(); await f.run(a); await f.finish(a);
  const compositeRow = await f.row();
  const directSpec = JSON.stringify({ ...JSON.parse(compositeRow.productionSpec), productionMode: 'REAL_ASSET_DIRECT' });
  const clones = [];
  for (let i = 1; i < 32; i++) {
    const [id] = await f.db('o_storyboard').insert({ ...scope, track: 'Main', index: i, duration: '3', prompt: 'Shot', imagePrompt: 'Execution prompt',
      productionSpec: i % 2 ? directSpec : compositeRow.productionSpec, filePath: compositeRow.filePath,
      currentImageAttemptId: compositeRow.currentImageAttemptId, state: '已完成' });
    clones.push(await f.db('o_storyboard').where({ id }).first());
  }
  const readCount = async rows => {
    let count = 0; const listener = () => { count++; };
    f.raw.on('query', listener);
    try { await f.kernel.readImageProvenance(1, 10, rows); } finally { f.raw.off('query', listener); }
    return count;
  };
  const small = await readCount([compositeRow, clones[0]]);
  const large = await readCount([compositeRow, ...clones]);
  assert.ok(large <= small + 1, `query graph grew by shot: two=${small}, thirty-two=${large}`);
});

test('superseded background worker retains preview but cannot alter newer owner or old image', async t => {
  const f = await setup(t);
  let release, entered;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  f.setProvider(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const a = await f.start(), work = f.run(a); await providerEntered;
  const b = await f.start();
  release({ bytes: f.background, promptId: 'local-delayed' });
  const stale = await work;
  assert.equal(stale.status, 'STALE'); assert.ok(stale.backgroundPath);
  assert.equal((await f.row()).activeImageAttemptId, b.productionAttemptId);
  assert.equal((await f.row()).filePath, f.old.filePath);
  assert.equal((await f.generic(a.productionAttemptId)).staleCode, 'PRODUCTION_ATTEMPT_SUPERSEDED');
});

test('controlled HTTP start/read/finish and Legacy V1 produce distinct provenance', async t => {
  const f = await setup(t);
  const a = await f.post('storyboard/composite/start', f.input);
  assert.equal(typeof a.productionAttemptId, 'string');
  let waiting;
  for (let i = 0; i < 30; i++) {
    waiting = await f.post('storyboard/composite/read', { ...f.shot, attemptId: a.id });
    if (waiting.status === 'AWAITING_QUAD') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(waiting.status, 'AWAITING_QUAD');
  assert.equal((await f.row()).filePath, f.old.filePath);
  const result = await f.post('storyboard/composite/finish', { ...f.shot, attemptId: a.id, screenQuad: quad, confirmed: true });
  assert.equal(result.status, 'COMPLETED'); assert.equal((await f.provenance()).producerType, 'REAL_AI_COMPOSITE');
  const legacy = await fixture(t);
  await legacy.load('lib/compositeAttemptSchema').initializeCompositeAttemptSchema(legacy.db);
  const shot = await legacy.create({ productionMode: 'REAL_AI_COMPOSITE' });
  const source = await sharp({ create: { width: 40, height: 80, channels: 4, background: '#ff0000' } }).png().toBuffer();
  legacy.utils.oss.getFile = async () => source;
  legacy.utils.oss.getFileUrl = async p => p;
  const old = await legacy.load('services/compositeAttempt').createCompositeAttempt({ ...scope, storyboardId: shot.id,
    primaryAssetId: 1, backgroundCapabilityId: 'comfy.z-image-turbo.txt2img.v1', prompt: 'Blank', width: 256, height: 256, seed: 1 });
  assert.equal(old.productionAttemptId, null);
  assert.equal((await legacy.db('o_storyboard').where({ id: shot.id }).first()).activeImageAttemptId, null);
});
