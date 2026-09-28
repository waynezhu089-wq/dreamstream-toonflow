const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./composite-fixture.cjs');

async function setup(t) {
  const f = await fixture(t);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  const recipe = f.load('services/recipeRegistry');
  const template = f.load('services/recipeAssetPlanTemplate');
  const app = express(); app.use(express.json());
  app.use('/api/recipes', f.load('routes/recipes/index').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(path, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recipes/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json)); return json.data ?? json;
  }
  const definition = (name = 'Recipe screen') => ({ schemaVersion: 1,
    profileRef: { profileKey: 'advertisement', profileVersion: 'v1' }, skillRefs: [], capabilityRefs: [],
    assetPlanTemplate: [
      { assetKey: 'screen', name, category: 'UI', required: true, sourcePolicy: 'REAL_REQUIRED' },
      { assetKey: 'brand', name: 'Brand', category: 'brand', required: false, sourcePolicy: 'AI_ALLOWED' },
    ], notes: [] });
  await recipe.createRecipeFamily({ recipeKey: 'ad.defaults', displayName: 'Ad defaults', description: '', tags: [] });
  await recipe.createRecipeVersion({ recipeKey: 'ad.defaults', definition: definition() });
  await recipe.activateRecipeVersion({ recipeKey: 'ad.defaults', version: 'v1' });
  await recipe.bindRecipe({ projectId: 1, recipeKey: 'ad.defaults', version: 'v1', confirmProfileAlignment: true });
  return { ...f, recipe, template, post, definition };
}

test('exact runtime context and template HTTP preview/apply preserve positions, bindings, extras and converge lost responses', async t => {
  const f = await setup(t), scope = { projectId: 1, scriptId: 10 };
  await f.plan.saveAssetPlan({ ...scope, items: [
    { assetKey: 'screen', name: 'Current screen', category: 'old', required: false, sourcePolicy: 'REAL_REQUIRED', assetId: 1 },
    { assetKey: 'extra', name: 'User extra', category: 'user', required: false, sourcePolicy: 'AI_ALLOWED', assetId: null },
  ] });
  await f.db('o_advertisementAssetPlan').where({ ...scope, assetKey: 'screen' }).update({ position: 4 });
  await f.db('o_advertisementAssetPlan').where({ ...scope, assetKey: 'extra' }).update({ position: 9 });
  const before = await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey');
  const preview = await f.post('project/asset-plan-template/preview', scope);
  assert.deepEqual(await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey'), before);
  assert.equal(preview.canApply, true);
  assert.deepEqual(preview.proposedPlan.map(row => [row.assetKey, row.position, row.assetId]),
    [['screen', 4, 1], ['extra', 9, null], ['brand', 10, null]]);
  const request = { ...scope, previewHash: preview.previewHash, proposalContextHash: preview.proposalContextHash,
    proposedPlanHash: preview.proposedPlanHash };
  await f.recipe.bindRecipe({ projectId: 1, recipeKey: 'ad.defaults', version: 'v1' });
  assert.equal((await f.post('project/asset-plan-template/preview', scope)).previewHash, preview.previewHash);
  const first = await f.post('project/asset-plan-template/apply', request);
  assert.equal(first.status, 'APPLIED'); assert.equal(first.resultPlanHash, preview.proposedPlanHash);
  const applied = await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey');
  const replay = await f.post('project/asset-plan-template/apply', request);
  assert.equal(replay.status, 'ALREADY_APPLIED'); assert.deepEqual(await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey'), applied);
  assert.deepEqual(applied.map(row => [row.assetKey, row.position, row.assetId]),
    [['brand', 10, null], ['extra', 9, null], ['screen', 4, 1]]);
  assert.equal((await f.db('o_projectRecipeBinding').where({ projectId: 1 }).first()).recipeVersion, 1);
  await f.recipe.createRecipeVersion({ recipeKey: 'ad.defaults', sourceVersion: 'v1' });
  await f.recipe.editRecipeVersion({ recipeKey: 'ad.defaults', version: 'v2', definition: f.definition('Changed screen') });
  await f.recipe.activateRecipeVersion({ recipeKey: 'ad.defaults', version: 'v2' });
  await f.recipe.bindRecipe({ projectId: 1, recipeKey: 'ad.defaults', version: 'v2' });
  const stale = await f.post('project/asset-plan-template/apply', request, 409);
  assert.equal(stale.reason, 'RECIPE_TEMPLATE_PREVIEW_STALE');
  assert.deepEqual(await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey'), applied);
});

test('template context is scoped, rejected binding is zero-write, and source change invalidates preview', async t => {
  const f = await setup(t), scope = { projectId: 1, scriptId: 10 };
  const noRecipe = await f.post('project/asset-plan-template/preview', { projectId: 2, scriptId: 20 }, 409);
  assert.equal(noRecipe.reason, 'RECIPE_NOT_BOUND');
  const unit = await f.post('project/asset-plan-template/preview', { projectId: 1, scriptId: 11 });
  assert.notEqual(unit.currentPlanHash, (await f.post('project/asset-plan-template/preview', scope)).currentPlanHash);
  const before = await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey');
  const initial = await f.post('project/asset-plan-template/preview', scope);
  await f.db('o_assetUploadSource').where({ assetId: 1, imageId: 1 }).update({ uploadedAt: Date.now() + 100000 });
  const changed = await f.post('project/asset-plan-template/preview', scope);
  assert.notEqual(changed.previewHash, initial.previewHash);
  const rejected = await f.post('project/asset-plan-template/apply', { ...scope,
    previewHash: initial.previewHash, proposalContextHash: initial.proposalContextHash,
    proposedPlanHash: initial.proposedPlanHash }, 409);
  assert.equal(rejected.reason, 'RECIPE_TEMPLATE_PREVIEW_STALE');
  await f.db('o_image').where({ id: 1 }).update({ model: 'AI' });
  const conflict = await f.post('project/asset-plan-template/preview', scope);
  assert.equal(conflict.canApply, false); assert.equal(conflict.conflicts[0].reason, 'ASSET_PLAN_REAL_SOURCE_REQUIRED');
  const refused = await f.post('project/asset-plan-template/apply', { ...scope,
    previewHash: conflict.previewHash, proposalContextHash: conflict.proposalContextHash,
    proposedPlanHash: conflict.proposedPlanHash }, 409);
  assert.equal(refused.reason, 'RECIPE_TEMPLATE_BINDING_CONFLICT');
  assert.deepEqual(await f.db('o_advertisementAssetPlan').where(scope).orderBy('assetKey'), before);
});
