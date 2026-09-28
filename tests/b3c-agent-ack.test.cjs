const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/agents/productionAgent/tools.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const mod = { exports: {} };
const stub = name => {
  if (name === 'ai') return { tool: value => value, jsonSchema: value => value };
  if (name === '@/utils') return { error: error => error };
  if (name === '@/services/storyboardProduction') return { productionFields: {} };
  if (name === '@/services/advertisementProductionContext') return { assertAdvertisementAssetReferences: async () => {} };
  if (name.startsWith('@/')) return {};
  return require(name);
};
new Function('require', 'module', 'exports', compiled)(stub, mod, mod.exports);
const { createSocketQueue, emitStoryboardAcknowledged } = mod.exports;

class FakeSocket extends EventEmitter {
  connected = true;
  emit(event, ...args) {
    if (event === 'disconnect') return super.emit(event, ...args);
    this.onEmit?.(event, ...args);
    return true;
  }
}
const raw = { videoDesc: 'scene', prompt: 'prompt', track: 'A', duration: 3, associateAssetsIds: [], shouldGenerateImage: 'false' };
function agent(socket, options = {}) {
  const titles = [];
  const tools = mod.exports.default({ resTool: { socket, data: { projectId: 1, scriptId: 2 } },
    msg: { thinking: () => ({ appendText() {}, updateTitle: title => titles.push(title), complete() {} }) }, ...options });
  return { tools, titles };
}

test('rejected/timeout item does not poison serial Socket queue', async () => {
  const socket = new FakeSocket();
  let firstAck;
  const events = [];
  socket.onEmit = (event, _payload, ack) => { events.push(event); if (event === 'generateStoryboard') firstAck = ack; else ack({ success: true }); };
  const queue = createSocketQueue(0);
  const first = queue(() => emitStoryboardAcknowledged(socket, 'generateStoryboard', { projectId: 1, scriptId: 2, ids: [7] }, 5));
  const second = queue(() => emitStoryboardAcknowledged(socket, 'addStoryboard', { projectId: 1, scriptId: 2 }, 50));
  await assert.rejects(first, /回执超时/);
  assert.deepEqual(await second, { success: true });
  firstAck({ success: true });
  assert.deepEqual(events, ['generateStoryboard', 'addStoryboard']);
  assert.equal(socket.listenerCount('disconnect'), 0);
});

test('generate tool sends its original unit envelope and a failed ACK does not strand a following add', async () => {
  const socket = new FakeSocket(), { tools } = agent(socket, { storyboardGeneration: true });
  const events = [];
  socket.onEmit = (event, payload, ack) => {
    events.push({ event, payload });
    if (event === 'generateStoryboard') ack({ status: 'CONTEXT_MISMATCH', applied: false });
    else ack({ status: 'PENDING_HUMAN', applied: false, proposalId: payload.proposalId });
  };
  const first = tools.generate_storyboard.execute({ ids: [7] });
  const second = tools.add_flowData_storyboard.execute(raw);
  await assert.rejects(first, /CONTEXT_MISMATCH/);
  assert.match(await second, /尚未应用/);
  assert.deepEqual(events.map(item => item.event), ['generateStoryboard', 'addStoryboard']);
  assert.deepEqual(events[0].payload, { projectId: 1, scriptId: 2, ids: [7] });
});

test('disconnect and synchronous emit failure settle once and clean listeners', async () => {
  const socket = new FakeSocket();
  socket.onEmit = () => { socket.connected = false; socket.emit('disconnect'); };
  await assert.rejects(emitStoryboardAcknowledged(socket, 'addStoryboard', {}, 100), /连接中断/);
  assert.equal(socket.listenerCount('disconnect'), 0);
  socket.connected = true;
  socket.onEmit = () => { throw Error('transport'); };
  await assert.rejects(emitStoryboardAcknowledged(socket, 'addStoryboard', {}, 100), /发送失败/);
  assert.equal(socket.listenerCount('disconnect'), 0);
  socket.connected = false;
  await assert.rejects(emitStoryboardAcknowledged(socket, 'addStoryboard', {}, 100), /连接已断开/);
});

test('controlled proposal is pending, while Legacy success needs actual ACK', async () => {
  const socket = new FakeSocket();
  const { tools, titles } = agent(socket);
  socket.onEmit = (_event, payload, ack) => ack({ status: 'PENDING_HUMAN', applied: false, proposalId: payload.proposalId });
  const pending = await tools.add_flowData_storyboard.execute(raw);
  assert.match(pending, /尚未应用/);
  assert.match(titles.at(-1), /等待人工确认/);
  socket.onEmit = (_event, _payload, ack) => ack({ success: true, applied: true, message: 'applied' });
  assert.equal(await tools.add_flowData_storyboard.execute(raw), 'applied');
  assert.equal(titles.at(-1), '新增分镜成功');
});

test('failed/uncertain acknowledgement never reports semantic success', async () => {
  const socket = new FakeSocket();
  const { tools, titles } = agent(socket);
  socket.onEmit = (_event, _payload, ack) => ack({ status: 'PROPOSAL_BUSY', applied: false });
  await assert.rejects(tools.add_flowData_storyboard.execute(raw), /PROPOSAL_BUSY/);
  assert.equal(titles.at(-1), '新增分镜未应用');
  socket.connected = false;
  await assert.rejects(tools.replace_flowData_storyboard.execute({ items: [raw] }), /可能仍有待确认提案/);
  assert.equal(titles.at(-1), '整套替换分镜失败');
});
