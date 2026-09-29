const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const sharp = require('sharp');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./composite-fixture.cjs');

const scope = { projectId: 1, scriptId: 10 };
const stages = [
  { stageKey: 'asset-preparation', displayName: 'Assets', uiOrder: 10, entryGateKey: null, exitGateKey: 'advertisement.asset-ready', operationKeys: [] },
  { stageKey: 'storyboard-board', displayName: 'Board', uiOrder: 15, entryGateKey: null, exitGateKey: null, operationKeys: [] },
  { stageKey: 'supervisor-review', displayName: 'Review', uiOrder: 20, entryGateKey: null, exitGateKey: 'supervisor.storyboard-approved.v2', operationKeys: [] },
  { stageKey: 'image-production', displayName: 'Images', uiOrder: 30, entryGateKey: null, exitGateKey: null,
    operationKeys: ['storyboard.image.generate', 'storyboard.image.composite', 'storyboard.image.attach'] },
].map(stage => ({ description: '', required: true, allowSkip: false, ...stage }));

function definition(endpointId) {
  return { endpointId, workflowJson: JSON.stringify({ '1': { class_type: 'Input', inputs: { prompt: '', width: 1, height: 1, seed: 1 } },
    '2': { class_type: 'Output', inputs: {} } }),
    inputPorts: [
      { name: 'prompt', type: 'text', required: true, label: 'Prompt' },
      { name: 'width', type: 'number', required: true, label: 'Width' },
      { name: 'height', type: 'number', required: true, label: 'Height' },
      { name: 'seed', type: 'number', required: true, label: 'Seed' },
    ], outputPorts: [{ name: 'image', type: 'image', label: 'Image' }],
    inputMappings: ['prompt', 'width', 'height', 'seed'].map(portName => ({ portName, nodeId: '1', inputKey: portName })),
    outputMappings: [{ portName: 'image', nodeId: '2', field: 'images' }],
    runtimeConfig: { timeoutMs: 1500, pollIntervalMs: 10 } };
}

async function setup(t, options = {}) {
  const f = await fixture(t);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  await f.load('lib/capabilitySchema').initializeCapabilitySchema(f.db);
  await f.db('o_project').where({ id: 1 }).update({ imageQuality: '1K', videoRatio: '16:9' });
  const calls = [], files = new Map();
  const comfy = { failure: null, onPrompt: null, redirectHistoryTo: null };
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#123456' } }).png().toBuffer();
  f.utils.oss.writeFile = async (path, data) => files.set(path, data);
  f.utils.oss.getFileUrl = async path => `/oss${path}`;
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    if (req.url === '/prompt') {
      let body = ''; for await (const part of req) body += part;
      calls.push(JSON.parse(body));
      if (comfy.onPrompt) await comfy.onPrompt();
      if (comfy.failure === 'COMFY_UNAVAILABLE') { req.socket.destroy(); return; }
      if (comfy.failure === 'COMFY_SUBMIT_FAILED') { res.statusCode = 502; res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ prompt_id: 'local-prompt' }));
    } else if (req.url === '/history/local-prompt') {
      if (comfy.redirectHistoryTo) { res.statusCode = 302; res.setHeader('Location', comfy.redirectHistoryTo); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      const status = comfy.failure === 'COMFY_EXECUTION_FAILED' ? { status_str: 'error' } :
        { completed: comfy.failure !== 'COMFY_TIMEOUT' };
      const outputs = comfy.failure === 'CAPABILITY_OUTPUT_NOT_FOUND' ? {} :
        { '2': { images: [{ filename: 'local.png', subfolder: '', type: 'output' }] } };
      res.end(JSON.stringify({ 'local-prompt': { status, outputs } }));
    } else if (req.url.startsWith('/view?')) { res.setHeader('Content-Type', 'image/png'); res.end(bytes); }
    else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = await f.load('services/capabilityRegistry').saveEndpoint({ name: 'Local fake Comfy',
    baseUrl: `http://127.0.0.1:${server.address().port}`, enabled: true });
  const familyKey = options.sameId ? 'toonflow.image' : 'comfy.dd-test';
  const capabilityId = `${familyKey}.v1`;
  const now = Date.now(), d = definition(endpoint.id);
  await f.db('o_capability').insert({ familyKey, displayName: 'Test', description: '', category: 'image',
    provider: 'ComfyUI', executorType: 'COMFY_UI', createdAt: now, updatedAt: now });
  await f.db('o_capabilityVersion').insert({ capabilityId, familyKey, version: 1, status: 'VERIFIED',
    workflowJson: d.workflowJson, inputPorts: JSON.stringify(d.inputPorts), outputPorts: JSON.stringify(d.outputPorts),
    inputMappings: JSON.stringify(d.inputMappings), outputMappings: JSON.stringify(d.outputMappings),
    endpointId: d.endpointId, runtimeConfig: JSON.stringify(d.runtimeConfig), createdAt: now, verifiedAt: now, updatedAt: now });
  const profile = f.load('services/orchestrator/profileRegistry');
  await profile.createVersion({ profileKey: 'advertisement', definition: { schemaVersion: 2, runtimeControl: 'ENFORCED',
    initialStageKey: 'asset-preparation', stages, transitions: [
      { fromStageKey: 'asset-preparation', toStageKey: 'storyboard-board' },
      { fromStageKey: 'storyboard-board', toStageKey: 'supervisor-review' },
      { fromStageKey: 'supervisor-review', toStageKey: 'image-production' }] } });
  await profile.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  const shot = await f.create(options.direct ? { productionMode: 'REAL_ASSET_DIRECT', primaryAssetId: 1,
    associateAssetsIds: [1], shouldGenerateImage: 1 } : { productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null,
    associateAssetsIds: [], shouldGenerateImage: 1, ...(options.explicit ? { capabilityId } : {}) });
  const builtinShot = options.builtinShot ? await f.create({ productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null,
    associateAssetsIds: [], shouldGenerateImage: 1, capabilityId: 'toonflow.image.v1' }) : null;
  await profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' });
  if (!options.explicit) {
    const recipe = f.load('services/recipeRegistry');
    await recipe.createRecipeFamily({ recipeKey: 'dd.registry', displayName: 'D-D', description: '', tags: [] });
    await recipe.createRecipeVersion({ recipeKey: 'dd.registry', definition: { schemaVersion: 1,
      profileRef: { profileKey: 'advertisement', profileVersion: 'v2' }, skillRefs: [],
      capabilityRefs: [{ roleKey: 'storyboard-image.text-to-image', stageKey: 'image-production', capabilityId }],
      assetPlanTemplate: [], notes: [] } });
    await recipe.activateRecipeVersion({ recipeKey: 'dd.registry', version: 'v1' });
    await recipe.bindRecipe({ projectId: 1, recipeKey: 'dd.registry', version: 'v1' });
  }
  const stage = f.load('services/orchestrator/stageOrchestrator');
  await stage.actOnStage('start', { ...scope, stageKey: 'asset-preparation' });
  await stage.actOnStage('complete', { ...scope, stageKey: 'asset-preparation' });
  await stage.actOnStage('start', { ...scope, stageKey: 'storyboard-board' });
  await stage.actOnStage('complete', { ...scope, stageKey: 'storyboard-board' });
  await stage.actOnStage('start', { ...scope, stageKey: 'supervisor-review' });
  const review = f.load('services/supervisor/review');
  const target = await review.targetRead({ ...scope, reviewKey: 'storyboard.semantic-approval.v2' });
  await review.decide({ ...scope, reviewKey: 'storyboard.semantic-approval.v2',
    expectedTargetHash: target.target.targetHash, expectedControlContextHash: target.controlContextHash,
    decision: 'PASS', summary: 'Approved', issues: [] }, { id: 1, name: 'Reviewer' });
  await stage.actOnStage('complete', { ...scope, stageKey: 'supervisor-review' });
  await stage.actOnStage('start', { ...scope, stageKey: 'image-production' });
  const attempt = f.load('services/productionAttempt');
  const shotScope = { ...scope, storyboardId: shot.id };
  return { ...f, calls, vendorCalls: f.calls, files, comfy, endpoint, capabilityId, shotScope, builtinShot, attempt,
    row: () => f.db('o_storyboard').where({ id: shot.id }).first(),
    attemptRow: id => f.db('o_productionAttempt').where({ attemptId: id }).first() };
}

test('Registry production uses one pinned execution and direct output; duplicate SUCCEEDED does not resubmit', async t => {
  const f = await setup(t);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal(begun.producerType, 'CAPABILITY');
  const pin = begun.producerInput;
  assert.equal(pin.logicalInputs.width, 1024);
  assert.equal(pin.logicalInputs.height, 576);
  assert.ok(Number.isSafeInteger(pin.logicalInputs.seed));
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  const execution = await f.db('o_capabilityExecution').where({ executionId: pin.reservedExecutionId }).first();
  const output = JSON.parse((await f.attemptRow(begun.attemptId)).outputRef);
  assert.equal(execution.status, 'SUCCEEDED');
  assert.deepEqual(JSON.parse(execution.inputs), JSON.parse(JSON.stringify(pin.logicalInputs)));
  assert.equal(output.filePath, `/capability/${pin.reservedExecutionId}/image-0.png`);
  assert.equal(output.capabilityExecutionId, pin.reservedExecutionId);
  assert.equal((await f.row()).filePath, output.filePath);
  assert.equal((await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId).freshness, 'CURRENT');
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal(f.calls.filter(item => typeof item === 'object').length, 1);
  assert.equal(f.calls.find(item => typeof item === 'object').prompt['1'].inputs.seed, pin.logicalInputs.seed);
  assert.equal(f.calls.length, 4);
  await f.db('o_capabilityExecution').where({ executionId: pin.reservedExecutionId }).delete();
  const stale = (await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId);
  assert.equal(stale.freshness, 'STALE');
  assert.equal(stale.staleCode, 'PRODUCTION_CAPABILITY_PROVENANCE_MISMATCH');
});

test('Registry same literal ID differs from builtin Source and executes Capability branch', async t => {
  const f = await setup(t, { sameId: true });
  const source = await f.db.transaction(q => f.attempt.captureStoryboardImageSource(q, f.shotScope));
  assert.equal(source.snapshot.adapterKey, 'storyboard.image-source.registry.v1');
  assert.equal(source.snapshot.execution.imageModel, null);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal(begun.producerType, 'CAPABILITY');
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal(f.calls.length > 0 && f.calls.filter(item => typeof item === 'object').length, 1);
});

test('explicit Shot Registry executes without a Recipe or builtin vendor branch', async t => {
  const f = await setup(t, { explicit: true });
  assert.equal((await f.db('o_projectRecipeBinding').where({ projectId: 1 }).count('* as n').first()).n, 0);
  const source = await f.db.transaction(q => f.attempt.captureStoryboardImageSource(q, f.shotScope));
  assert.equal(source.effectiveCapability.resolvedFrom, 'SHOT');
  assert.equal(source.snapshot.adapterKey, 'storyboard.image-source.registry.v1');
  assert.equal(source.snapshot.execution.imageModel, null);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal(begun.producerType, 'CAPABILITY');
  assert.equal(begun.producerInput.capabilityId, f.capabilityId);
  assert.match(begun.producerInput.reservedExecutionId, /^[0-9a-f-]{36}$/);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  assert.equal((await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).first()).status, 'SUCCEEDED');
  assert.equal((await f.attemptRow(begun.attemptId)).status, 'SUCCEEDED');
  assert.equal((await f.row()).currentImageAttemptId, begun.attemptId);
  assert.equal((await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId).freshness, 'CURRENT');
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal(f.vendorCalls.length, 0);
});

test('B3 EDIT direct to Registry AI prefetches proposed exact Source and Confirm recapture detects definition drift', async t => {
  const f = await setup(t, { direct: true });
  const direct = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(direct)).status, 'SUCCEEDED');
  const revision = f.load('services/orchestrator/revisionPreview');
  const request = { schemaVersion: 1, revisionId: randomUUID(), ...scope, revisionKey: 'storyboard.semantic.v2',
    changeSet: { operations: [{ type: 'EDIT', storyboardId: f.shotScope.storyboardId,
      patch: { productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null } }] } };
  const before = await revision.previewRevision(request);
  const impact = before.outputImpact.find(row => row.storyboardId === f.shotScope.storyboardId);
  assert.equal(impact.beforeFreshness, 'CURRENT');
  assert.equal(impact.afterFreshness, 'STALE');
  assert.equal(impact.sourceAssessment, null);
  assert.match(impact.proposedSourceHash, /^[a-f0-9]{64}$/);
  const persisted = await f.row();
  const proposedRow = { ...persisted, productionSpec: JSON.stringify({
    ...f.load('services/storyboardProduction').productionSpec(persisted),
    productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null }) };
  const canonical = await f.db.transaction(async q => {
    const context = await f.attempt.captureStoryboardImageSourceContext(q, 1, 10,
      [f.shotScope.storyboardId], [1], [f.capabilityId]);
    return f.attempt.storyboardImageSourceFromContext(context, f.shotScope, proposedRow, [1]);
  });
  assert.equal(impact.proposedSourceHash, canonical.sourceHash);
  assert.equal(canonical.snapshot.adapterKey, 'storyboard.image-source.registry.v1');
  assert.equal(canonical.snapshot.execution.imageModel, null);
  assert.match(canonical.snapshot.execution.capabilityDefinitionHash, /^[a-f0-9]{64}$/);
  const version = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
  const ports = JSON.parse(version.inputPorts); ports[0].label = 'New exact definition';
  await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ inputPorts: JSON.stringify(ports) });
  const recaptured = await f.db.transaction(q => revision.captureRevisionPlan(q, request));
  assert.notEqual(recaptured.preview.previewHash, before.previewHash);
  assert.notEqual(recaptured.preview.outputImpact[0].proposedSourceHash, impact.proposedSourceHash);
  assert.equal(recaptured.preview.outputImpact[0].afterFreshness, 'STALE');
  const addRequest = { ...request, revisionId: randomUUID(), changeSet: { operations: [{
    type: 'ADD', clientRef: 'newAiShot', storyboard: { track: 'Main', duration: 3, prompt: 'New image',
      videoDesc: 'New shot', productionMode: 'AI_TEXT_TO_IMAGE', primaryAssetId: null,
      referenceAssetIds: [], referenceAssetGroupIds: [], linkedAssetIds: [] },
  }] } };
  const addCapture = await f.db.transaction(q => revision.captureRevisionPlan(q, addRequest));
  assert.equal(addCapture.captured.sourceContext.registryVersions.has(f.capabilityId), true);
  assert.equal((await f.row()).productionSpec, persisted.productionSpec);
});

test('role and endpoint failures reject before ownership; drift before submit makes zero Comfy calls', async t => {
  const f = await setup(t);
  const before = await f.row();
  const valid = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
  for (const ports of [[{ name: 'prompt', type: 'text', required: true, label: 'Prompt' }],
    [...JSON.parse(valid.inputPorts), { name: 'extra', type: 'text', required: false, label: 'Extra' }]]) {
    await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ inputPorts: JSON.stringify(ports) });
    await assert.rejects(f.attempt.beginStoryboardImageAttempt(f.shotScope), e => e.code === 'CAPABILITY_ROLE_INCOMPATIBLE');
    assert.deepEqual(await f.row(), before);
    assert.equal((await f.db('o_productionAttempt').count('* as n').first()).n, 0);
  }
  await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ inputPorts: valid.inputPorts });
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  await f.db('o_capabilityEndpoint').where({ id: f.endpoint.id }).update({ enabled: false });
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'FAILED');
  assert.equal(f.calls.length, 0);
  const execution = await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).first();
  assert.equal(JSON.parse(execution.error).code, 'CAPABILITY_EXECUTION_CONTEXT_CHANGED');
  assert.equal((await f.row()).activeImageAttemptId, null);
});

test('already-STALE late output is retained only after proof, and prior current remains visible', async t => {
  const f = await setup(t);
  const old = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  const next = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attemptRow(old.attemptId)).status, 'STALE');
  assert.equal((await f.attempt.runStoryboardImageAttempt(old)).status, 'STALE');
  const oldRow = await f.attemptRow(old.attemptId);
  assert.ok(JSON.parse(oldRow.outputRef).outputHash);
  assert.equal((await f.row()).activeImageAttemptId, next.attemptId);
  assert.equal((await f.attempt.runStoryboardImageAttempt(next)).status, 'SUCCEEDED');
  assert.equal((await f.row()).currentImageAttemptId, next.attemptId);
});

test('late Registry output stays historical after Source or Control drift and preserves the old current image', async t => {
  for (const drift of ['source', 'control']) {
    await t.test(drift, async subtest => {
      const f = await setup(subtest);
      const first = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
      assert.equal((await f.attempt.runStoryboardImageAttempt(first)).status, 'SUCCEEDED');
      const oldPath = (await f.row()).filePath;
      const second = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
      const produced = await f.load('services/executeCapability').executePinnedImageCapability(second.attemptId);
      assert.equal(produced.status, 'SUCCEEDED');
      if (drift === 'source') {
        await f.db('o_storyboard').where({ id: f.shotScope.storyboardId }).update({ imagePrompt: 'Changed after preflight' });
      } else {
        await f.db('o_stageRun').where({ ...scope, stageKey: 'image-production' }).update({ state: 'COMPLETED' });
      }
      const result = await f.attempt.finishCurrentImageAttempt(second.attemptId, produced.output,
        { preRecordOutput: f.attempt.preRecordCapabilityOutput });
      assert.equal(result.status, 'STALE');
      assert.equal(result.staleCode, drift === 'source' ? 'PRODUCTION_SOURCE_CHANGED' : 'PRODUCTION_CONTROL_CHANGED');
      assert.equal(JSON.parse((await f.attemptRow(second.attemptId)).outputRef).filePath, produced.output.filePath);
      const shot = await f.row();
      assert.equal(shot.filePath, oldPath);
      assert.equal(shot.currentImageAttemptId, first.attemptId);
      assert.equal(shot.activeImageAttemptId, null);
      assert.equal(f.calls.filter(item => item === '/prompt').length, 2);
    });
  }
});

test('B3 Preview and normal provenance share current Capability proof and bounded evidence', async t => {
  const f = await setup(t);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  const revision = f.load('services/orchestrator/revisionPreview');
  const request = { schemaVersion: 1, revisionId: randomUUID(), ...scope, revisionKey: 'storyboard.semantic.v2',
    changeSet: { operations: [{ type: 'EDIT', storyboardId: f.shotScope.storyboardId,
      patch: { prompt: 'Proposed semantic change' } }] } };
  const before = await revision.previewRevision(request);
  assert.equal(before.outputImpact[0].beforeFreshness, 'CURRENT');
  assert.equal(before.outputImpact[0].afterFreshness, 'STALE');
  const repeat = await revision.previewRevision(request);
  assert.equal(repeat.previewHash, before.previewHash);
  await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).delete();
  const after = await revision.previewRevision(request);
  assert.equal(after.outputImpact[0].beforeFreshness, 'STALE');
  assert.notEqual(after.previewHash, before.previewHash);
  const normal = (await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId);
  assert.equal(normal.freshness, 'STALE');
  assert.equal(normal.staleCode, 'PRODUCTION_CAPABILITY_PROVENANCE_MISMATCH');
  assert.equal((await f.db('o_storyboard').where({ id: f.shotScope.storyboardId }).first()).filePath.length > 0, true);
});

test('reserved RUNNING and FAILED executions never submit twice or falsely finish an Attempt', async t => {
  const f = await setup(t);
  const first = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  const pin = first.producerInput, now = Date.now();
  await f.db('o_capabilityExecution').insert({ executionId: pin.reservedExecutionId, capabilityId: pin.capabilityId,
    endpointId: pin.endpointId, promptId: null, status: 'RUNNING', inputs: JSON.stringify(pin.logicalInputs),
    outputs: '{}', error: null, definitionHash: pin.capabilityDefinitionHash, startedAt: now, completedAt: null });
  assert.equal((await f.attempt.runStoryboardImageAttempt(first)).status, 'RUNNING');
  assert.equal((await f.attemptRow(first.attemptId)).status, 'RUNNING');
  assert.equal(f.calls.length, 0);
  await f.db('o_capabilityExecution').where({ executionId: pin.reservedExecutionId }).update({ status: 'FAILED',
    error: JSON.stringify({ code: 'COMFY_TIMEOUT', message: 'Local timeout' }), completedAt: now });
  assert.equal((await f.attempt.runStoryboardImageAttempt(first)).status, 'FAILED');
  assert.equal((await f.attemptRow(first.attemptId)).errorCode, 'COMFY_TIMEOUT');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.row()).activeImageAttemptId, null);
  assert.equal((await f.attempt.runStoryboardImageAttempt(first)).status, 'FAILED');
  assert.equal(f.calls.length, 0);
});

test('invalid late Capability proof preserves old STALE outputRef and all current pointers', async t => {
  const f = await setup(t);
  const first = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  const execution = f.load('services/executeCapability');
  const produced = await execution.executePinnedImageCapability(first.attemptId);
  assert.equal(produced.status, 'SUCCEEDED');
  const second = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  await f.db('o_productionAttempt').where({ attemptId: first.attemptId }).update({ outputRef: '{"historical":"keep"}' });
  const before = await f.row();
  const invalid = { ...produced.output, outputHash: 'f'.repeat(64) };
  const result = await f.attempt.finishCurrentImageAttempt(first.attemptId, invalid,
    { preRecordOutput: f.attempt.preRecordCapabilityOutput });
  assert.equal(result.status, 'STALE');
  assert.equal((await f.attemptRow(first.attemptId)).outputRef, '{"historical":"keep"}');
  assert.deepEqual(await f.row(), before);
  assert.equal((await f.row()).activeImageAttemptId, second.attemptId);
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
});

test('all six role dimensions and one crypto seed draw per pinned attempt', async t => {
  const f = await setup(t);
  const role = f.load('services/storyboardImageCapability');
  const table = [
    ['1K', '16:9', 1024, 576], ['1K', '9:16', 576, 1024],
    ['2K', '16:9', 2048, 1152], ['2K', '9:16', 1152, 2048],
    ['4K', '16:9', 4096, 2304], ['4K', '9:16', 2304, 4096],
  ];
  for (const [quality, ratio, width, height] of table)
    assert.deepEqual(role.imageDimensions(quality, ratio), { width, height });
  assert.throws(() => role.imageDimensions(null, '16:9'), e => e.code === 'CAPABILITY_ROLE_INCOMPATIBLE');
  assert.throws(() => role.imageDimensions('1K', '1:1'), e => e.code === 'CAPABILITY_ROLE_INCOMPATIBLE');
  await f.db.transaction(async q => {
    const selected = (await role.readRegistryVersions(q, [f.capabilityId])).get(f.capabilityId);
    let draws = 0;
    const draw = () => { draws++; return 7; };
    const first = await role.createPinnedImageProducer(q, selected, f.capabilityId, 'Prompt', 1024, 576, f.endpoint, draw);
    const retry = await role.createPinnedImageProducer(q, selected, f.capabilityId, 'Prompt', 1024, 576, f.endpoint, draw);
    assert.equal(draws, 2);
    assert.equal(first.logicalInputs.seed, 7);
    assert.equal(retry.logicalInputs.seed, 7);
    assert.notEqual(first.reservedExecutionId, retry.reservedExecutionId);
  });
});

test('Registry Source ignores vendor model drift and later Disable, but exact definition drift stales', async t => {
  const f = await setup(t);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  const originalHash = (await f.db.transaction(q => f.attempt.captureStoryboardImageSource(q, f.shotScope))).sourceHash;
  await f.config();
  await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ status: 'DISABLED' });
  const after = await f.db.transaction(q => f.attempt.captureStoryboardImageSource(q, f.shotScope));
  assert.equal(after.sourceHash, originalHash);
  assert.equal(after.snapshot.execution.imageModel, null);
  assert.equal((await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId).freshness, 'CURRENT');
  const version = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
  const ports = JSON.parse(version.inputPorts); ports[0].label = 'Changed exact definition';
  await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ inputPorts: JSON.stringify(ports) });
  assert.equal((await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId).freshness, 'STALE');
});

test('mixed builtin and invalid Registry begin rolls back all ownership; old RUNNING remains', async t => {
  const f = await setup(t, { builtinShot: true });
  await f.config();
  const builtinScope = { ...scope, storyboardId: f.builtinShot.id };
  const previous = await f.attempt.beginStoryboardImageAttempt(builtinScope);
  const beforeRows = await f.db('o_storyboard').whereIn('id', [f.builtinShot.id, f.shotScope.storyboardId]).orderBy('id');
  const beforeAttempts = await f.db('o_productionAttempt').orderBy('attemptId');
  const version = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
  await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ inputPorts: JSON.stringify([
    ...JSON.parse(version.inputPorts), { name: 'extra', type: 'text', required: false, label: 'Extra' }]) });
  const response = await f.post('storyboard/batchGenerateImage', { ...scope,
    storyboardIds: [f.builtinShot.id, f.shotScope.storyboardId] }, 409);
  assert.equal(response.code, 'CAPABILITY_ROLE_INCOMPATIBLE');
  assert.deepEqual(await f.db('o_storyboard').whereIn('id', [f.builtinShot.id, f.shotScope.storyboardId]).orderBy('id'), beforeRows);
  assert.deepEqual(await f.db('o_productionAttempt').orderBy('attemptId'), beforeAttempts);
  assert.equal((await f.attemptRow(previous.attemptId)).status, 'RUNNING');
  assert.equal(f.vendorCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test('old client vendor model override is rejected before Registry ownership write', async t => {
  const f = await setup(t);
  const before = await f.row();
  const result = await f.post('storyboard/batchGenerateImage', { ...scope,
    storyboardIds: [f.shotScope.storyboardId], model: 'vendor:image' }, 409);
  assert.equal(result.code, 'MODEL_CONFIG_MISMATCH');
  assert.deepEqual(await f.row(), before);
  assert.equal((await f.db('o_productionAttempt').count('* as n').first()).n, 0);
  assert.equal(f.calls.length, 0);
});

test('strict role rejects extra, defaulted, wrong-type and ambiguous logical contracts', async t => {
  const f = await setup(t);
  const base = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
  const cases = [
    { inputPorts: JSON.stringify(JSON.parse(base.inputPorts).slice(0, 3)) },
    { inputPorts: JSON.stringify(JSON.parse(base.inputPorts).map(p => p.name === 'width' ? { ...p, type: 'text' } : p)) },
    { inputPorts: JSON.stringify(JSON.parse(base.inputPorts).map(p => p.name === 'seed' ? { ...p, defaultValue: 1 } : p)) },
    { inputPorts: JSON.stringify(JSON.parse(base.inputPorts).map(p => p.name === 'seed' ? { ...p, options: [1, 2] } : p)) },
    { outputPorts: JSON.stringify([{ name: 'image', type: 'image[]', label: 'Image' }]) },
    { outputPorts: JSON.stringify([...JSON.parse(base.outputPorts), { name: 'other', type: 'image', label: 'Other' }]) },
    { inputMappings: JSON.stringify(JSON.parse(base.inputMappings).slice(0, 3)) },
  ];
  const initial = await f.row();
  for (const mutation of cases) {
    await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update(mutation);
    await assert.rejects(f.attempt.beginStoryboardImageAttempt(f.shotScope), e => e.code === 'CAPABILITY_ROLE_INCOMPATIBLE');
    assert.deepEqual(await f.row(), initial);
    assert.equal((await f.db('o_productionAttempt').count('* as n').first()).n, 0);
    await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({
      inputPorts: base.inputPorts, outputPorts: base.outputPorts, inputMappings: base.inputMappings });
  }
  assert.equal(f.calls.length, 0);
});

test('Capability output-link proof rejects every mismatched authority field', async t => {
  const f = await setup(t);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  const attempt = await f.attemptRow(begun.attemptId);
  const execution = await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).first();
  const output = JSON.parse(attempt.outputRef);
  const proof = f.load('services/executeCapability').proveCapabilityImageOutput;
  assert.equal(proof(attempt, execution, output), true);
  for (const [key, bad] of Object.entries({ capabilityExecutionId: randomUUID(), capabilityId: 'other.v1',
    definitionHash: 'f'.repeat(64), endpointId: randomUUID(), endpointOrigin: 'http://127.0.0.1:1',
    promptId: 'other', outputPort: 'other', filePath: '/untrusted.png', mediaType: 'image/jpeg',
    outputHash: 'f'.repeat(64), byteLength: output.byteLength + 1 })) {
    assert.equal(proof(attempt, execution, { ...output, [key]: bad }), false, key);
  }
  for (const patch of [{ status: 'RUNNING' }, { endpointId: randomUUID() },
    { inputs: JSON.stringify({ ...begun.producerInput.logicalInputs, seed: 9 }) },
    { promptId: 'other' }, { outputs: JSON.stringify({ image: { filePath: '/other.png' } }) }])
    assert.equal(proof(attempt, { ...execution, ...patch }, output), false);
});

test('Version and Endpoint drift before submit fail the reserved execution with zero external calls', async t => {
  const f = await setup(t);
  const endpointBase = f.endpoint.baseUrl;
  const changes = [
    async () => f.db('o_capabilityEndpoint').where({ id: f.endpoint.id }).update({ baseUrl: 'http://127.0.0.1:1' }),
    async () => f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ status: 'DISABLED' }),
    async () => {
      const version = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
      const ports = JSON.parse(version.inputPorts); ports[0].label = 'Drifted';
      return f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({ inputPorts: JSON.stringify(ports) });
    },
  ];
  const original = await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).first();
  for (const mutate of changes) {
    const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
    await mutate();
    assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'FAILED');
    const execution = await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).first();
    assert.equal(JSON.parse(execution.error).code, 'CAPABILITY_EXECUTION_CONTEXT_CHANGED');
    assert.equal(f.calls.length, 0);
    await f.db('o_capabilityEndpoint').where({ id: f.endpoint.id }).update({ baseUrl: endpointBase });
    await f.db('o_capabilityVersion').where({ capabilityId: f.capabilityId }).update({
      status: 'VERIFIED', inputPorts: original.inputPorts });
  }
});

test('after /prompt admission history/view use only the pinned origin despite Endpoint replacement', async t => {
  const f = await setup(t);
  const replacementCalls = [];
  const replacement = http.createServer((req, res) => { replacementCalls.push(req.url); res.statusCode = 502; res.end(); });
  replacement.listen(0, '127.0.0.1'); await once(replacement, 'listening');
  t.after(async () => { replacement.closeAllConnections(); await new Promise(resolve => replacement.close(resolve)); });
  const replacementUrl = `http://127.0.0.1:${replacement.address().port}`;
  let mutations = 0;
  f.comfy.onPrompt = async () => {
    mutations++;
    await f.db('o_capabilityEndpoint').where({ id: f.endpoint.id })
      .update({ enabled: false, baseUrl: replacementUrl });
  };
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'SUCCEEDED');
  assert.equal(mutations, 1);
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal(f.calls.filter(item => item === '/history/local-prompt').length, 1);
  assert.equal(f.calls.filter(item => typeof item === 'string' && item.startsWith('/view?')).length, 1);
  assert.deepEqual(replacementCalls, []);
  assert.equal((await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId).freshness, 'CURRENT');
});

test('pinned executor refuses a post-admission redirect rather than visiting the replacement origin', async t => {
  const f = await setup(t);
  const replacementCalls = [];
  const replacement = http.createServer((req, res) => { replacementCalls.push(req.url); res.statusCode = 200; res.end('{}'); });
  replacement.listen(0, '127.0.0.1'); await once(replacement, 'listening');
  t.after(async () => { replacement.closeAllConnections(); await new Promise(resolve => replacement.close(resolve)); });
  f.comfy.onPrompt = async () => { f.comfy.redirectHistoryTo = `http://127.0.0.1:${replacement.address().port}/history/local-prompt`; };
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'FAILED');
  const execution = await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).first();
  assert.equal(execution.status, 'FAILED');
  assert.equal(JSON.parse(execution.error).code, 'COMFY_UNAVAILABLE');
  assert.deepEqual(replacementCalls, []);
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
});

test('internal pinned external failures settle execution first, then B2, retaining the previous current image', async t => {
  for (const code of ['COMFY_UNAVAILABLE', 'COMFY_SUBMIT_FAILED', 'COMFY_EXECUTION_FAILED',
    'COMFY_TIMEOUT', 'CAPABILITY_OUTPUT_NOT_FOUND']) {
    await t.test(code, async subtest => {
      const f = await setup(subtest);
      const previous = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
      assert.equal((await f.attempt.runStoryboardImageAttempt(previous)).status, 'SUCCEEDED');
      const oldPath = (await f.row()).filePath;
      const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
      const beforeShot = await f.row();
      const beforeAttempt = await f.attemptRow(begun.attemptId);
      f.comfy.failure = code;
      const executor = f.load('services/executeCapability');
      await assert.rejects(executor.executePinnedImageCapability(begun.attemptId), error => error.code === code);
      const execution = await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).first();
      assert.equal(execution.status, 'FAILED');
      assert.equal(JSON.parse(execution.error).code, code);
      assert.equal((await f.attemptRow(begun.attemptId)).status, 'RUNNING');
      assert.deepEqual(await f.row(), beforeShot);
      assert.equal(beforeAttempt.status, 'RUNNING');
      const submissions = f.calls.filter(item => item === '/prompt').length;
      assert.equal((await f.attempt.runStoryboardImageAttempt(begun)).status, 'FAILED');
      assert.equal((await f.attemptRow(begun.attemptId)).errorCode, code);
      const after = await f.row();
      assert.equal(after.filePath, oldPath);
      assert.equal(after.currentImageAttemptId, previous.attemptId);
      assert.equal(after.activeImageAttemptId, null);
      assert.equal(f.calls.filter(item => item === '/prompt').length, submissions);
      assert.equal(f.vendorCalls.length, 0);
    });
  }
});

test('a failed Capability execution cannot re-fail a superseded Production Attempt', async t => {
  const f = await setup(t);
  const previous = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  assert.equal((await f.attempt.runStoryboardImageAttempt(previous)).status, 'SUCCEEDED');
  const first = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  f.comfy.failure = 'COMFY_EXECUTION_FAILED';
  await assert.rejects(f.load('services/executeCapability').executePinnedImageCapability(first.attemptId),
    error => error.code === 'COMFY_EXECUTION_FAILED');
  const next = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  const before = await f.row();
  assert.equal((await f.attemptRow(first.attemptId)).status, 'STALE');
  assert.equal((await f.attempt.runStoryboardImageAttempt(first)).status, 'STALE');
  assert.equal((await f.attemptRow(first.attemptId)).status, 'STALE');
  assert.deepEqual(await f.row(), before);
  assert.equal((await f.row()).currentImageAttemptId, previous.attemptId);
  assert.equal((await f.row()).activeImageAttemptId, next.attemptId);
  assert.equal(f.calls.filter(item => item === '/prompt').length, 2);
});

test('concurrent observers of one reserved execution submit at most one Comfy prompt', async t => {
  const f = await setup(t);
  const begun = await f.attempt.beginStoryboardImageAttempt(f.shotScope);
  const results = await Promise.allSettled([
    f.attempt.runStoryboardImageAttempt(begun), f.attempt.runStoryboardImageAttempt(begun),
  ]);
  assert.equal(results.every(result => result.status === 'fulfilled'), true);
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal((await f.db('o_capabilityExecution').where({ executionId: begun.producerInput.reservedExecutionId }).count('* as n').first()).n, 1);
  assert.equal((await f.attemptRow(begun.attemptId)).status, 'SUCCEEDED');
  assert.equal((await f.row()).currentImageAttemptId, begun.attemptId);
});

test('existing controlled batch HTTP route produces a Registry image without a vendor model', async t => {
  const f = await setup(t);
  const rows = await f.generate([f.shotScope.storyboardId]);
  assert.equal(rows[0].state, '已完成');
  assert.match(rows[0].filePath, /^\/capability\/[0-9a-f-]+\/image-0\.png$/);
  assert.equal(f.calls.filter(item => item === '/prompt').length, 1);
  assert.equal(f.vendorCalls.length, 0);
  assert.equal((await f.attempt.readImageProvenance(1, 10, [await f.row()])).get(f.shotScope.storyboardId).freshness, 'CURRENT');
});
