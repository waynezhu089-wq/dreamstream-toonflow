const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { z } = require('zod');
const { MockLanguageModelV3 } = require('ai/test');

test('HF2 pinned session adds structured object calls while preserving tracked text invoke', async () => {
  let generated = 0, vendorLoads = 0;
  const model = new MockLanguageModelV3({ provider: 'fixture', modelId: 'pinned', doGenerate: () => ({
    content: [{ type: 'text', text: generated++ === 0 ? 'legacy text' : '{"decision":"PASS","summary":"Approved","issues":[]}' }],
    finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [],
  }) });
  const deployment = { key: 'productionAgent:supervisionAgent', modelName: 'vendor:text', temperature: 0.35, maxOutputTokens: 456 };
  const fakeUtils = {
    db: table => ({ where(key, value) { this.key = value; return this; }, async first() {
      if (table === 'o_setting') return { value: this.key === 'agentUseMode' ? '1' : '0' };
      if (table === 'o_agentDeploy') return deployment;
      if (table === 'o_vendorConfig') return { id: 'vendor', inputValues: '{}' };
      throw Error(table);
    } }),
    vendor: { async getModelList() { vendorLoads++; return [{ modelName: 'text', think: false }]; }, getCode: () => '' },
    vm: () => ({ textRequest: () => model }),
  };
  const file = path.resolve(__dirname, '../src/utils/ai.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (id === '@/utils') return fakeUtils;
    if (id === '@/services/modelPreset') return { requireModel: async () => 'vendor:text' };
    return require(id);
  }, module, module.exports);
  const session = await module.exports.default.Text('productionAgent:supervisionAgent').trackedSession();
  assert.equal(session.modelReference, 'vendor:text');
  assert.equal(vendorLoads, 1);
  deployment.modelName = 'vendor:changed-after-pin';
  const old = await session.invoke({ prompt: 'Legacy text request' });
  assert.equal(old.text, 'legacy text');
  const schema = z.object({ decision: z.literal('PASS'), summary: z.string(), issues: z.array(z.unknown()) });
  const first = await session.invokeObject({ schema, system: 'Return JSON only', prompt: 'Review one' });
  const repair = await session.invokeObject({ schema, system: 'Return JSON only', prompt: 'Review repair' });
  assert.deepEqual(first.object, { decision: 'PASS', summary: 'Approved', issues: [] });
  assert.deepEqual(repair.object, first.object);
  assert.equal(vendorLoads, 1, 'both object attempts must use the already pinned model');
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal(model.doGenerateCalls[1].responseFormat?.type, 'json');
  assert.equal(model.doGenerateCalls[2].responseFormat?.type, 'json');
  for (const call of model.doGenerateCalls) {
    assert.equal(call.temperature, 0.35);
    assert.equal(call.maxOutputTokens, 456);
  }
});
