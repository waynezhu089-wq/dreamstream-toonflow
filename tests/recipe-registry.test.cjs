const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./composite-fixture.cjs');

async function setup(t) {
  const f = await fixture(t);
  await f.load('lib/productionProfileSchema').initializeProductionProfileSchema(f.db);
  await f.load('lib/skillSchema').initializeSkillSchema(f.db);
  await f.load('lib/capabilitySchema').initializeCapabilitySchema(f.db);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  await f.load('lib/recipeSchema').initializeRecipeSchema(f.db);
  const recipe = f.load('services/recipeRegistry'), profile = f.load('services/orchestrator/profileRegistry'), contract = f.load('services/recipeContract'), skill = f.load('services/skillRegistry');
  const app = express(); app.use(express.json()); app.use('/api/recipes', f.load('routes/recipes/index').default); app.use('/api/skills', f.load('routes/skills/index').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(path, body, status = 200) { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json)); return json.data ?? json; }
  return { ...f, recipe, profile, contract, skill, post };
}
const template = { assetKey: 'brand-logo', name: 'Brand Logo', category: 'brand', required: true, sourcePolicy: 'REAL_REQUIRED' };
const definition = (profileVersion = 'v1') => ({ schemaVersion: 1, profileRef: { profileKey: 'advertisement', profileVersion }, skillRefs: [], capabilityRefs: [], assetPlanTemplate: [template], notes: [] });
async function active(f, key = 'test.recipe', d = definition()) { await f.recipe.createRecipeFamily({ recipeKey: key, displayName: key, description: '', tags: ['test'] }); await f.recipe.createRecipeVersion({ recipeKey: key, definition: d }); return f.recipe.activateRecipeVersion({ recipeKey: key, version: 'v1' }); }

test('strict Recipe definition and exact version lifecycle', async t => {
  const f = await setup(t);
  for (const d of [
    { ...definition(), extra: 1 },
    { ...definition(), skillRefs: [{ skillType: 'IMAGE_PROMPT', skillId: 'a.b', skillVersion: 'v1' }, { skillType: 'IMAGE_PROMPT', skillId: 'b.c', skillVersion: 'v1' }] },
    { ...definition(), capabilityRefs: [{ roleKey: 'image.default', capabilityId: 'one.v1' }, { roleKey: 'image.default', capabilityId: 'two.v1' }] },
    { ...definition(), assetPlanTemplate: [template, template] },
    { ...definition(), assetPlanTemplate: [{ ...template, assetId: 6 }] },
    { ...definition(), assetPlanTemplate: [{ ...template, filePath: 'real.png' }] },
    { ...definition(), profileRef: { profileKey: 'advertisement', profileVersion: 'latest' } },
  ]) assert.throws(() => f.contract.validateRecipeDefinition(d), e => e.code === 'RECIPE_DEFINITION_INVALID');
  await active(f);
  await assert.rejects(f.recipe.editRecipeVersion({ recipeKey: 'test.recipe', version: 'v1', definition: definition() }), e => e.code === 'RECIPE_VERSION_NOT_ACTIVE');
  const draft = await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', sourceVersion: 'v1' }); assert.equal(draft.version, 'v2');
  await f.recipe.editRecipeVersion({ recipeKey: 'test.recipe', version: 'v2', definition: { ...definition(), notes: ['second'] } });
  await f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v2' });
  const versions = (await f.recipe.getRecipe({ recipeKey: 'test.recipe' })).versions;
  assert.equal(versions.find(v => v.version === 'v1').status, 'DEPRECATED'); assert.equal(versions.find(v => v.version === 'v2').status, 'ACTIVE');
  await assert.rejects(f.recipe.previewRecipeBind({ projectId: 1, recipeKey: 'test.recipe', version: 'v1' }), e => e.code === 'RECIPE_VERSION_NOT_ACTIVE');
  await assert.rejects(f.recipe.previewRecipeBind({ projectId: 1, recipeKey: 'test.recipe', version: 'latest' }), e => e.code === 'RECIPE_VERSION_NOT_FOUND');
});

test('activation rollback, dependency health and stale new bind', async t => {
  const f = await setup(t); await active(f);
  await f.profile.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', sourceVersion: 'v1' });
  await f.recipe.editRecipeVersion({ recipeKey: 'test.recipe', version: 'v2', definition: definition('v2') });
  await assert.rejects(f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v2' }), e => e.code === 'RECIPE_DEPENDENCY_NOT_ACTIVE');
  assert.equal((await f.recipe.getRecipe({ recipeKey: 'test.recipe', version: 'v1' })).versions[0].status, 'ACTIVE');
  await f.profile.deprecateVersion({ profileKey: 'advertisement', version: 'v1' });
  const old = (await f.recipe.getRecipe({ recipeKey: 'test.recipe', version: 'v1' })).versions[0];
  assert.equal(old.health.healthy, false); assert.ok(old.health.issues.includes('PROFILE_NOT_ACTIVE'));
  await assert.rejects(f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true }), e => e.code === 'RECIPE_DEPENDENCY_STALE');
});

test('explicit Profile alignment is atomic, cross-locked, and no hidden apply', async t => {
  const f = await setup(t); await active(f);
  const before = { skill: await f.db('o_skillBinding').count('* as n').first(), plan: await f.db('o_advertisementAssetPlan').count('* as n').first(), shot: await f.db('o_storyboard').count('* as n').first(), stage: await f.db('o_stageRun').count('* as n').first() };
  const preview = await f.recipe.previewRecipeBind({ projectId: 1, recipeKey: 'test.recipe', version: 'v1' }); assert.equal(preview.state, 'CAN_ALIGN_PROFILE');
  assert.equal(await f.db('o_projectProfileBinding').where({ projectId: 1 }).first(), undefined);
  await assert.rejects(f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1' }), e => e.code === 'RECIPE_PROFILE_ALIGNMENT_REQUIRED');
  assert.equal(await f.db('o_projectProfileBinding').where({ projectId: 1 }).first(), undefined);
  await f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true });
  assert.equal((await f.db('o_projectProfileBinding').where({ projectId: 1 }).first()).source, 'RECIPE');
  assert.equal((await f.recipe.resolveRecipe({ projectId: 1 })).binding.recipeVersion, 'v1');
  for (const [table,key] of [['o_skillBinding','skill'],['o_advertisementAssetPlan','plan'],['o_storyboard','shot'],['o_stageRun','stage']]) assert.deepEqual(await f.db(table).count('* as n').first(), before[key]);
  await f.profile.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' }); await f.profile.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await assert.rejects(f.profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' }), e => e.code === 'PROFILE_BINDING_LOCKED_BY_RECIPE');
  await f.recipe.unbindRecipe({ projectId: 1 });
  assert.equal((await f.db('o_projectProfileBinding').where({ projectId: 1 }).first()).profileVersion, 1);
  assert.equal((await f.profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v2' })).version, 'v2');
});

test('persisted mismatch, project scope, stage lock, historical exact version', async t => {
  const f = await setup(t); await active(f);
  await assert.rejects(f.recipe.bindRecipe({ projectId: 3, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true }), e => e.code === 'RECIPE_SCOPE_INVALID');
  await f.profile.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' }); await f.profile.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await f.profile.bindProfile({ projectId: 2, profileKey: 'advertisement', version: 'v2' });
  await assert.rejects(f.recipe.bindRecipe({ projectId: 2, recipeKey: 'test.recipe', version: 'v1' }), e => e.code === 'RECIPE_DEPENDENCY_STALE');
  await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', sourceVersion: 'v1' }); await f.recipe.editRecipeVersion({ recipeKey: 'test.recipe', version: 'v2', definition: definition('v2') }); await f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v2' });
  await f.recipe.bindRecipe({ projectId: 2, recipeKey: 'test.recipe', version: 'v2' });
  await f.db('o_stageRun').insert({ projectId: 2, scriptId: 20, profileKey: 'advertisement', profileVersion: 2, stageKey: 'brief', state: 'IN_PROGRESS', updatedAt: Date.now() });
  await assert.rejects(f.recipe.unbindRecipe({ projectId: 2 }), e => e.code === 'RECIPE_BINDING_LOCKED');
  assert.equal((await f.recipe.resolveRecipe({ projectId: 2 })).binding.recipeVersion, 'v2');
});

test('Skill Recipe context is exact and public RECIPE writes are rejected', async t => {
  const f = await setup(t); await active(f);
  await f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true });
  const payload = { scopeType: 'RECIPE', scopeKey: 'recipe:test.recipe@v1', skillType: 'IMAGE_PROMPT', skillId: null, skillVersion: null, overrideText: 'shadow' };
  const rejected = await f.post('skills/binding/save', payload, 409); assert.equal(rejected.reason, 'SKILL_BINDING_INVALID');
  const context = { projectId: 1, scriptId: 10, storyboardId: 1, skillType: 'IMAGE_PROMPT' };
  const mismatch = await f.post('skills/resolve', { ...context, recipeKey: 'other.recipe', recipeVersion: 'v1' }, 409); assert.equal(mismatch.reason, 'SKILL_RECIPE_CONTEXT_MISMATCH');
  const unversioned = await f.post('skills/resolve', { ...context, recipeKey: 'test.recipe' }, 409); assert.equal(unversioned.reason, 'SKILL_RECIPE_CONTEXT_MISMATCH');
});

test('exact Recipe Skill resolves from version definition, while project binding overrides', async t => {
  const f = await setup(t), c = f.load('services/skillContract');
  const skillId = 'image-prompt.recipe-test', content = { ...c.emptyTemplate('IMAGE_PROMPT'), purpose: 'Recipe image prompt', rules: ['Preserve real UI'] };
  await f.skill.createSkillFamily({ skillId, displayName: 'Recipe prompt', skillType: 'IMAGE_PROMPT', description: '', tags: [] });
  await f.skill.createDraft({ skillId, content }); await f.skill.activateDraft({ skillId, version: 'v1' });
  const definitionWithSkill = { ...definition(), skillRefs: [{ skillType: 'IMAGE_PROMPT', skillId, skillVersion: 'v1' }] };
  await active(f, 'test.recipe', definitionWithSkill);
  await f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true });
  await f.db('o_storyboard').insert({ id: 1, projectId: 1, scriptId: 10 });
  const context = { projectId: 1, scriptId: 10, storyboardId: 1, skillType: 'IMAGE_PROMPT', recipeKey: 'test.recipe', recipeVersion: 'v1' };
  const resolved = await f.skill.resolveSkill(context);
  assert.equal(resolved.skillId, skillId); assert.deepEqual(resolved.resolvedFrom, { scopeType: 'RECIPE', scopeKey: 'recipe:test.recipe@v1' });
  await f.skill.saveBinding({ scopeType: 'PROJECT', scopeKey: 'project:1', skillType: 'IMAGE_PROMPT', skillId, skillVersion: 'v1', overrideText: null });
  assert.equal((await f.skill.resolveSkill(context)).resolvedFrom.scopeType, 'PROJECT');
  await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', sourceVersion: 'v1' });
  await f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v2' });
  assert.equal((await f.skill.resolveSkill(context)).resolutionTrace.find(x => x.scopeType === 'RECIPE').skillVersion, 'v1');
  await assert.rejects(f.skill.resolveSkill({ ...context, recipeVersion: 'v2' }), e => e.code === 'SKILL_RECIPE_CONTEXT_MISMATCH');
});

test('Recipe rejects missing exact refs, Skill type mismatch and invalid Profile stage', async t => {
  const f = await setup(t);
  await f.recipe.createRecipeFamily({ recipeKey: 'test.recipe', displayName: 'Test', description: '', tags: [] });
  const bad = [
    { ...definition(), profileRef: { profileKey: 'missing', profileVersion: 'v1' } },
    { ...definition(), skillRefs: [{ skillType: 'IMAGE_PROMPT', skillId: 'missing.skill', skillVersion: 'v1' }] },
    { ...definition(), capabilityRefs: [{ roleKey: 'image.default', stageKey: 'not-in-profile', capabilityId: 'missing.capability.v1' }] },
  ];
  for (const d of bad) await assert.rejects(f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', definition: d }), e => e.code === 'RECIPE_DEFINITION_INVALID');
  assert.equal((await f.recipe.getRecipe({ recipeKey: 'test.recipe' })).versions.length, 0);
});

test('failed Recipe insert rolls back explicit Profile alignment; competing binds have one winner', async t => {
  const f = await setup(t); await active(f, 'recipe.one'); await active(f, 'recipe.two');
  await f.raw.raw("CREATE TRIGGER reject_recipe_insert BEFORE INSERT ON o_projectRecipeBinding WHEN NEW.projectId = 1 BEGIN SELECT RAISE(ABORT, 'recipe write unavailable'); END");
  await assert.rejects(f.recipe.bindRecipe({ projectId: 1, recipeKey: 'recipe.one', version: 'v1', confirmProfileAlignment: true }));
  assert.equal(await f.db('o_projectProfileBinding').where({ projectId: 1 }).first(), undefined);
  await f.raw.raw('DROP TRIGGER reject_recipe_insert');
  const results = await Promise.allSettled(['recipe.one','recipe.two'].map(recipeKey => f.recipe.bindRecipe({ projectId: 1, recipeKey, version: 'v1', confirmProfileAlignment: true })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const bound = await f.recipe.resolveRecipe({ projectId: 1 });
  assert.equal(bound.binding.recipeKey, results.find(x => x.status === 'fulfilled').value.recipeKey);
});

test('HTTP Recipe endpoints report stable error and preserve read-only preview', async t => {
  const f = await setup(t); await active(f);
  const preview = await f.post('recipes/project/preview-bind', { projectId: 1, recipeKey: 'test.recipe', version: 'v1' });
  assert.equal(preview.state, 'CAN_ALIGN_PROFILE');
  assert.equal(await f.db('o_projectProfileBinding').where({ projectId: 1 }).first(), undefined);
  const blocked = await f.post('recipes/project/bind', { projectId: 1, recipeKey: 'test.recipe', version: 'v1' }, 409);
  assert.equal(blocked.reason, 'RECIPE_PROFILE_ALIGNMENT_REQUIRED');
  await f.post('recipes/project/bind', { projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true });
  assert.equal((await f.post('recipes/project/resolve', { projectId: 1 })).binding.recipeVersion, 'v1');
});

test('Capability exact recommendation requires VERIFIED status and a Stage from pinned Profile', async t => {
  const f = await setup(t), now = Date.now();
  await f.db('o_capability').insert({ familyKey: 'comfy.example', displayName: 'Example', description: '', category: 'image', provider: 'comfy', executorType: 'COMFY', createdAt: now, updatedAt: now });
  await f.db('o_capabilityVersion').insert({ capabilityId: 'comfy.example.v1', familyKey: 'comfy.example', version: 1, status: 'DRAFT', workflowJson: '{}', inputPorts: '[]', outputPorts: '[]', inputMappings: '[]', outputMappings: '[]', runtimeConfig: '{}', endpointId: 'test', createdAt: now, verifiedAt: null, updatedAt: now });
  await f.recipe.createRecipeFamily({ recipeKey: 'test.recipe', displayName: 'Test', description: '', tags: [] });
  const withCapability = { ...definition(), capabilityRefs: [{ roleKey: 'storyboard-image.default', stageKey: 'image-production', capabilityId: 'comfy.example.v1' }] };
  await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', definition: withCapability });
  await assert.rejects(f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v1' }), e => e.code === 'RECIPE_DEPENDENCY_NOT_ACTIVE');
  await f.db('o_capabilityVersion').where({ capabilityId: 'comfy.example.v1' }).update({ status: 'VERIFIED' });
  await f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v1' });
  await f.db('o_capabilityVersion').where({ capabilityId: 'comfy.example.v1' }).update({ status: 'DISABLED' });
  await assert.rejects(f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true }), e => e.code === 'RECIPE_DEPENDENCY_STALE');
  await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', sourceVersion: 'v1' });
  await assert.rejects(f.recipe.editRecipeVersion({ recipeKey: 'test.recipe', version: 'v2', definition: { ...withCapability, capabilityRefs: [{ ...withCapability.capabilityRefs[0], stageKey: 'missing-stage' }] } }), e => e.code === 'RECIPE_DEFINITION_INVALID');
});

test('historical project stays on exact deprecated Recipe and hash corruption fails closed', async t => {
  const f = await setup(t); await active(f);
  await f.recipe.bindRecipe({ projectId: 1, recipeKey: 'test.recipe', version: 'v1', confirmProfileAlignment: true });
  await f.recipe.createRecipeVersion({ recipeKey: 'test.recipe', sourceVersion: 'v1' });
  await f.recipe.activateRecipeVersion({ recipeKey: 'test.recipe', version: 'v2' });
  assert.equal((await f.recipe.resolveRecipe({ projectId: 1 })).binding.recipeVersion, 'v1');
  await f.profile.deprecateVersion({ profileKey: 'advertisement', version: 'v1' });
  const historical = await f.recipe.resolveRecipe({ projectId: 1 });
  assert.equal(historical.recipe.status, 'DEPRECATED'); assert.equal(historical.recipe.health.healthy, false);
  assert.equal((await f.profile.bindProfile({ projectId: 1, profileKey: 'advertisement', version: 'v1' })).version, 'v1');
  await f.db('o_recipeVersion').where({ recipeKey: 'test.recipe', version: 1 }).update({ definitionHash: '0'.repeat(64) });
  assert.equal((await f.recipe.getRecipe({ recipeKey: 'test.recipe', version: 'v1' })).versions[0].health.issues.includes('DEFINITION_HASH_MISMATCH'), true);
  await assert.rejects(f.recipe.resolveRecipe({ projectId: 1 }), e => e.code === 'RECIPE_HASH_MISMATCH');
});
