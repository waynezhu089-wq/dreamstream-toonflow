const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./composite-fixture.cjs');

test('migration adds AI provenance to an existing review table without rewriting rows', async t => {
  const f = await fixture(t);
  await f.db.schema.createTable('o_supervisorReview', table => { table.string('reviewId').primary(); table.text('summary'); });
  await f.db('o_supervisorReview').insert({ reviewId: 'accepted-human', summary: 'Accepted HUMAN row' });
  const schema = f.load('lib/supervisorSchema');
  await schema.initializeSupervisorSchema(f.db); await schema.initializeSupervisorSchema(f.db);
  const row = await f.db('o_supervisorReview').where({ reviewId: 'accepted-human' }).first();
  assert.equal(row.summary, 'Accepted HUMAN row');
  assert.equal(row.supervisorResolutionHash, null);
  assert.equal(row.supervisorResolutionTrace, null);
  assert.equal(row.supervisorOverrideChain, null);
  await assert.rejects(f.db('o_supervisorReview').where({ reviewId: 'accepted-human' }).update({ summary: 'mutated' }));
});

async function setup(t) {
  const f = await fixture(t);
  for (const name of ['productionProfileSchema', 'recipeSchema', 'skillSchema', 'supervisorSchema']) await f.load(`lib/${name}`)[`initialize${{productionProfileSchema:'ProductionProfile',recipeSchema:'Recipe',skillSchema:'Skill',supervisorSchema:'Supervisor'}[name]}Schema`](f.db);
  const registry = f.load('services/skillRegistry');
  const contract = f.load('services/skillContract');
  const skillId = 'supervisor.review-fixture';
  await registry.createSkillFamily({ skillId, displayName: 'Review Fixture', skillType: 'SUPERVISOR', description: '', tags: [] });
  const content = { ...contract.emptyTemplate('SUPERVISOR'), purpose: 'Review storyboard semantics', rules: ['Use the exact snapshot'], outputRequirements: ['Choose a valid decision'] };
  await registry.createDraft({ skillId, content }); await registry.activateDraft({ skillId, version: 'v1' });
  await registry.saveBinding({ scopeType: 'SYSTEM', scopeKey: 'system', skillType: 'SUPERVISOR', skillId, skillVersion: 'v1', overrideText: null });
  const ids = { projectId: 1, scriptId: 10, reviewKey: 'storyboard.semantic-approval' };
  const shotId = (await f.db('o_storyboard').insert({ projectId: 1, scriptId: 10, index: 1, duration: '3', prompt: 'A shot', videoDesc: 'A screen', shouldGenerateImage: 0, productionSpec: '{}', state: '未生成' }))[0];
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { id: 42, name: 'Reviewer' }; next(); });
  app.use('/api/supervisor', f.load('routes/supervisor/index').default);
  const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(path, body = ids, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/supervisor/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, status, JSON.stringify(json)); return json.data ?? json;
  }
  const target = () => post('target/read');
  const aiInput = async () => { const value = await target(); return { ...ids, expectedTargetHash: value.target.targetHash, expectedControlContextHash: value.controlContextHash }; };
  const calls = [], sessionRefs = [];
  const stub = (results) => { let index = 0; f.utils.Ai.Text = key => ({ trackedSession: async () => {
    sessionRefs.push(key); return { modelReference: 'vendor:actual-model', invoke: async input => { calls.push(input); const result = results[Math.min(index++, results.length - 1)]; if (result instanceof Error) throw result; if (typeof result === 'function') return result(input); return { output: result }; } };
  } }); };
  const pass = { decision: 'PASS', summary: 'Approved', issues: [] };
  const revise = { decision: 'REVISE', summary: 'Revise', issues: [{ severity: 'BLOCKER', code: 'SHOT_CHANGE', message: 'Fix shot', suggestion: null, evidence: null }] };
  return { ...f, registry, contract, skillId, content, ids, shotId, post, target, aiInput, calls, sessionRefs, stub, pass, revise };
}

test('additive schema preserves immutable HUMAN rows and AI columns', async t => {
  const f = await setup(t), target = await f.target();
  await f.post('review/decide', { ...await f.aiInput(), decision: 'PASS', summary: 'Human approved', issues: [] });
  await f.load('lib/supervisorSchema').initializeSupervisorSchema(f.db);
  const row = await f.db('o_supervisorReview').first();
  assert.equal(row.source, 'HUMAN'); assert.equal(row.supervisorResolutionHash, null);
  assert.equal(await f.db.schema.hasColumn('o_supervisorReview', 'supervisorOverrideChain'), true);
  await assert.rejects(f.db('o_supervisorReview').where({ reviewId: row.reviewId }).update({ summary: 'changed' }));
});

test('AI context is scoped, transaction-backed, ordered and read-only', async t => {
  const f = await setup(t);
  await f.registry.saveBinding({ scopeType: 'PROJECT', scopeKey: 'project:1', skillType: 'SUPERVISOR', skillId: null, skillVersion: null, overrideText: 'Project rule' });
  await f.registry.saveBinding({ scopeType: 'STAGE', scopeKey: 'project:1:script:10:stage:supervisor-review', skillType: 'SUPERVISOR', skillId: null, skillVersion: null, overrideText: 'Stage rule' });
  const context = await f.post('ai/context');
  assert.equal(context.skillId, f.skillId); assert.equal(context.stageKey, 'supervisor-review');
  assert.deepEqual(context.overrideChain.map(x => x.scopeType), ['PROJECT', 'STAGE']);
  assert.equal(context.resolutionTrace.at(-1).scopeType, 'STAGE');
  assert.equal((await f.db('o_supervisorReview')).length, 0);
  assert.equal((await f.post('ai/context', { ...f.ids, scriptId: 11 }, 409)).reason, 'SUPERVISOR_TARGET_EMPTY');
  await f.db('o_skillBinding').where({ scopeType: 'SYSTEM', skillType: 'SUPERVISOR' }).delete();
  assert.equal((await f.post('ai/context', f.ids, 409)).reason, 'SUPERVISOR_SKILL_NOT_RESOLVED');
  assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_REVIEW_REQUIRED');
});

test('stage Skill and exact Recipe resolution perform no off-transaction reads', async t => {
  const f = await setup(t);
  let transactions = 0;
  const original = f.utils.db;
  f.utils.db = new Proxy(original, {
    apply() { throw new Error('NON_TRANSACTIONAL_SUPERVISOR_SKILL_READ'); },
    get(target, key) { if (key === 'transaction') return callback => { transactions++; return target.transaction(callback); }; return Reflect.get(target, key); },
  });
  try { assert.equal((await f.post('ai/context')).skillId, f.skillId); assert.equal(transactions, 1); }
  finally { f.utils.db = original; }
});

test('preflight rejects stale scope, hashes, missing skill and large payload before model', async t => {
  const f = await setup(t); f.stub([f.pass]);
  const input = await f.aiInput();
  assert.equal((await f.post('review/ai', { ...input, expectedTargetHash: '0'.repeat(64) }, 409)).reason, 'SUPERVISOR_TARGET_CHANGED');
  assert.equal((await f.post('review/ai', { ...input, expectedControlContextHash: '0'.repeat(64) }, 409)).reason, 'SUPERVISOR_CONTEXT_CHANGED');
  assert.equal((await f.post('review/ai', { ...input, skillId: f.skillId }, 400)).reason, 'SUPERVISOR_DECISION_INVALID');
  await f.db('o_storyboard').where({ id: f.shotId }).update({ prompt: 'x'.repeat(270000) });
  const big = await f.aiInput();
  assert.equal((await f.post('review/ai', big, 413)).reason, 'SUPERVISOR_AI_INPUT_TOO_LARGE');
  assert.equal(f.calls.length, 0);
});

test('structured PASS/REVISE/HUMAN_CONFIRM persist exact provenance and drive Gate without production mutation', async t => {
  const f = await setup(t); f.stub([f.pass, f.revise, { decision: 'HUMAN_CONFIRM', summary: 'Needs human', issues: [] }]);
  const before = await f.db('o_storyboard').select('*');
  const input = await f.aiInput();
  const first = await f.post('review/ai', input);
  assert.equal(first.modelReference, 'vendor:actual-model'); assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_PASS');
  await f.post('review/ai', input); assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_REVISE_REQUIRED');
  await f.post('review/ai', input); assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_HUMAN_CONFIRM_REQUIRED');
  const history = (await f.post('review/history')).history;
  assert.equal(history[0].effective, true); assert.equal(history[1].effective, false);
  assert.equal(history[0].supervisorSkillId, f.skillId);
  assert.equal(history[0].supervisorResolutionHash.length, 64);
  assert.equal(history[0].modelReference, 'vendor:actual-model');
  assert.equal(history[0].actorUserId, null);
  assert.deepEqual(await f.db('o_storyboard').select('*'), before);
  assert.equal(f.calls.length, 3); assert.equal(f.sessionRefs.length, 3);
  for (const call of f.calls) { assert.equal(call.output?.name, 'object'); assert.match(call.system, /untrusted review data/); assert.doesNotMatch(call.system, /A shot/); }
});

test('one structured repair uses one pinned session; runtime failure does not retry', async t => {
  const f = await setup(t), input = await f.aiInput();
  f.stub([{ decision: 'PASS', summary: '', issues: [] }, f.pass]);
  await f.post('review/ai', input);
  assert.equal(f.calls.length, 2); assert.equal(f.sessionRefs.length, 1);
  assert.match(f.calls[1].messages[0].content, /valid JSON object/);
  const before = (await f.db('o_supervisorReview')).length;
  f.stub([new Error('provider down')]);
  assert.equal((await f.post('review/ai', input, 502)).reason, 'SUPERVISOR_AI_FAILED');
  assert.equal((await f.db('o_supervisorReview')).length, before);
});

test('policy drift stales AI, while HUMAN remains effective after later AI review', async t => {
  const f = await setup(t), input = await f.aiInput(); f.stub([f.pass, f.revise]);
  await f.post('review/ai', input);
  await f.registry.saveBinding({ scopeType: 'PROJECT', scopeKey: 'project:1', skillType: 'SUPERVISOR', skillId: null, skillVersion: null, overrideText: 'New policy' });
  assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_REVIEW_REQUIRED');
  assert.equal((await f.post('review/history')).history[0].staleReason, 'SUPERVISOR_POLICY_CHANGED');
  await f.post('review/decide', { ...input, decision: 'PASS', summary: 'Human approved', issues: [] });
  await f.post('review/ai', input);
  assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_PASS');
  const history = (await f.post('review/history')).history;
  assert.equal(history.find(x => x.effective).source, 'HUMAN');
  await f.db('o_skillBinding').where({ scopeType: 'SYSTEM', skillType: 'SUPERVISOR' }).delete();
  assert.equal((await f.post('gate/check')).code, 'SUPERVISOR_PASS');
});

test('postflight target or policy change discards AI result', async t => {
  const f = await setup(t), input = await f.aiInput();
  f.stub([async () => { await f.db('o_storyboard').where({ id: f.shotId }).update({ prompt: 'Changed during AI' }); return { output: f.pass }; }]);
  assert.equal((await f.post('review/ai', input, 409)).reason, 'SUPERVISOR_TARGET_CHANGED');
  assert.equal((await f.db('o_supervisorReview')).length, 0);
  const next = await f.aiInput();
  f.stub([async () => { await f.registry.saveBinding({ scopeType: 'PROJECT', scopeKey: 'project:1', skillType: 'SUPERVISOR', skillId: null, skillVersion: null, overrideText: 'Changed during AI' }); return { output: f.pass }; }]);
  assert.equal((await f.post('review/ai', next, 409)).reason, 'SUPERVISOR_SKILL_CHANGED');
  assert.equal((await f.db('o_supervisorReview')).length, 0);
});

test('stage resolver uses exact Recipe ref, PROFILE/PROJECT/STAGE priority and ignores legacy Recipe rows', async t => {
  const f = await setup(t);
  await f.load('services/orchestrator/profileRegistry').adoptLegacy({ projectId: 1 });
  const secondId = 'supervisor.recipe-fixture';
  await f.registry.createSkillFamily({ skillId: secondId, displayName: 'Recipe Supervisor', skillType: 'SUPERVISOR', description: '', tags: [] });
  await f.registry.createDraft({ skillId: secondId, content: f.content }); await f.registry.activateDraft({ skillId: secondId, version: 'v1' });
  const recipeContract = f.load('services/recipeContract');
  const definition = { schemaVersion: 1, profileRef: { profileKey: 'advertisement', profileVersion: 'v1' }, skillRefs: [{ skillType: 'SUPERVISOR', skillId: secondId, skillVersion: 'v1' }], capabilityRefs: [], assetPlanTemplate: [], notes: [] };
  const hash = recipeContract.recipeHash(recipeContract.validateRecipeDefinition(definition));
  await f.db('o_recipe').insert({ recipeKey: 'supervisor-fixture', displayName: 'Fixture', description: '', tags: '[]', createdAt: 1, updatedAt: 1 });
  await f.db('o_recipeVersion').insert({ recipeKey: 'supervisor-fixture', version: 1, status: 'ACTIVE', definition: JSON.stringify(definition), definitionHash: hash, createdAt: 1, updatedAt: 1 });
  await f.db('o_projectRecipeBinding').insert({ projectId: 1, recipeKey: 'supervisor-fixture', recipeVersion: 1, recipeDefinitionHash: hash, source: 'MANUAL', createdAt: 1, updatedAt: 1 });
  await f.db('o_skillBinding').insert({ scopeType: 'RECIPE', scopeKey: 'recipe:supervisor-fixture', skillType: 'SUPERVISOR', skillId: f.skillId, skillVersion: 1, overrideText: 'Legacy unversioned row', createdAt: 1, updatedAt: 1 });
  let context = await f.post('ai/context');
  assert.equal(context.skillId, secondId); assert.equal(context.resolvedFrom.scopeType, 'RECIPE');
  assert.deepEqual(context.overrideChain, []);
  await f.registry.saveBinding({ scopeType: 'PROJECT', scopeKey: 'project:1', skillType: 'SUPERVISOR', skillId: f.skillId, skillVersion: 'v1', overrideText: 'Project override' });
  context = await f.post('ai/context'); assert.equal(context.skillId, f.skillId); assert.equal(context.resolvedFrom.scopeType, 'PROJECT');
  assert.deepEqual(context.overrideChain.map(x => x.text), ['Project override']);
  await f.registry.saveBinding({ scopeType: 'STAGE', scopeKey: 'project:1:script:10:stage:supervisor-review', skillType: 'SUPERVISOR', skillId: secondId, skillVersion: 'v1', overrideText: 'Stage override' });
  context = await f.post('ai/context'); assert.equal(context.skillId, secondId); assert.equal(context.resolvedFrom.scopeType, 'STAGE');
  assert.deepEqual(context.overrideChain.map(x => x.text), ['Project override', 'Stage override']);
  assert.equal(context.resolutionTrace.some(x => x.scopeType === 'SHOT'), false);
});

test('missing trusted Stage and missing model fail before paid invocation', async t => {
  const f = await setup(t), input = await f.aiInput();
  assert.equal((await f.post('review/ai', input, 409)).reason, 'SUPERVISOR_MODEL_UNAVAILABLE');
  assert.equal((await f.db('o_supervisorReview')).length, 0);
  const profile = f.load('services/orchestrator/profileRegistry');
  await profile.adoptLegacy({ projectId: 1 });
  const version = await profile.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
  const def = version.definition;
  def.stages = def.stages.filter(stage => stage.stageKey !== 'supervisor-review');
  def.transitions = def.transitions.filter(x => x.fromStageKey !== 'supervisor-review' && x.toStageKey !== 'supervisor-review');
  def.transitions.push({ fromStageKey: 'storyboard-board', toStageKey: 'image-production' });
  // An exact Profile without the registered Supervisor stage must fail closed.
  await profile.editVersion({ profileKey: 'advertisement', version: 'v2', definition: def });
  await profile.activateVersion({ profileKey: 'advertisement', version: 'v2' });
  await f.db('o_projectProfileBinding').where({ projectId: 1 }).update({ profileVersion: 2 });
  const changed = await f.aiInput();
  assert.equal((await f.post('ai/context', f.ids, 409)).reason, 'SUPERVISOR_STAGE_NOT_AVAILABLE');
  assert.equal((await f.post('review/ai', changed, 409)).reason, 'SUPERVISOR_STAGE_NOT_AVAILABLE');
});

test('invalid structured decisions repair only once and never write invalid row', async t => {
  const f = await setup(t), input = await f.aiInput();
  f.stub([{ ...f.pass, issues: f.revise.issues }, f.pass]);
  await f.post('review/ai', input); assert.equal(f.calls.length, 2); assert.equal(f.sessionRefs.length, 1);
  f.stub([{ ...f.revise, issues: [] }, { ...f.revise, issues: [] }]);
  assert.equal((await f.post('review/ai', input, 502)).reason, 'SUPERVISOR_AI_OUTPUT_INVALID');
  assert.equal((await f.db('o_supervisorReview')).length, 1);
});

test('postflight exact Profile change discards AI with context changed', async t => {
  const f = await setup(t), input = await f.aiInput();
  f.stub([async () => {
    const profile = f.load('services/orchestrator/profileRegistry');
    await profile.adoptLegacy({ projectId: 1 });
    const version = await profile.createVersion({ profileKey: 'advertisement', sourceVersion: 'v1' });
    await profile.activateVersion({ profileKey: 'advertisement', version: version.version });
    await f.db('o_projectProfileBinding').where({ projectId: 1 }).update({ profileVersion: 2 });
    return { output: f.pass };
  }]);
  assert.equal((await f.post('review/ai', input, 409)).reason, 'SUPERVISOR_CONTEXT_CHANGED');
  assert.equal((await f.db('o_supervisorReview')).length, 0);
});
