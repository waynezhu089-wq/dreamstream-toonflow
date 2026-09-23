const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const ts = require('typescript'), express = require('express');
const root = path.resolve(__dirname, '..');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-presets-'));
  let utils; const cache = new Map(); const calls = [];
  function load(name) {
    const file = path.join(root, 'src', name + '.ts');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', code)(id => {
      if (id === '@/utils/getPath') return name => path.join(dir, name);
      if (id === '@/lib/initDB' || id === '@/lib/fixDB') return async () => {};
      if (id === '@/utils') return utils;
      if (id === 'uuid') return { v4: require('node:crypto').randomUUID };
      if (['axios','ai','@ai-sdk/devtools','sucrase'].includes(id)) return {};
      if (id.startsWith('@/')) return load(id.slice(2));
      return require(id);
    }, module, module.exports); return module.exports;
  }
  const oldEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  const { default: db, db: raw } = load('utils/db');
  await new Promise(r => setImmediate(r)); if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  t.after(async () => { await raw.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  await raw.schema.createTable('o_project', t => { t.bigInteger('id').primary(); for (const s of ['projectType','type','name','intro','artStyle','directorManual','videoRatio','imageModel','videoModel','imageQuality','mode']) t.string(s); t.integer('userId'); t.bigInteger('createTime'); });
  await raw.schema.createTable('o_vendorConfig', t => { t.string('id').primary(); t.integer('enable'); });
  await raw.schema.createTable('o_video', t => { t.increments('id');t.string('filePath');t.bigInteger('time');t.string('state'); for(const s of ['scriptId','projectId','videoTrackId'])t.integer(s); });
  await db('o_project').insert([{ id: 1, projectType: 'general_video', type: 'advertisement', imageModel: '', videoModel: '' }, { id: 2, projectType: 'novel', type: 'story', imageModel: 'legacy:image', videoModel: 'legacy:video' }]);
  await db('o_vendorConfig').insert({ id: 'vendor', enable: 1 });
  const models = ['text','image','video','tts'].flatMap(type => [{ type, name: type, modelName: type }, { type, name: type+'2', modelName: type+'2' }]);
  const ai = type => model => ({ save: async () => {}, run: async () => { calls.push({ type, model }); return { save: async () => {} }; } });
  utils = { db, vendor: { getModelList: async () => models }, Ai: { Image: ai('image'), Video: ai('video') }, uuid: () => 'result', oss: { getSmallImageUrl: async p => p }, error: e => e };
  await load('lib/modelPresetSchema').initializeModelPresetSchema(db); await load('lib/modelPresetSchema').initializeModelPresetSchema(db);
  const service = load('services/modelPreset'); const app = express(); app.use(express.json());
  app.use('/api/modelSelect/presets', load('routes/modelSelect/presets').default);
  app.use(load('middleware/modelUseGate').modelUseGate);
  app.use('/api/project/addProject', load('routes/project/addProject').default);
  app.use('/api/project/getProject', load('routes/project/getProject').default);
  app.use('/api/project/editProject', load('routes/project/editProject').default);
  app.use('/api/production/editImage/generateFlowImage', load('routes/production/editImage/generateFlowImage').default);
  app.use('/api/production/workbench/generateVideo', load('routes/production/workbench/generateVideo').default);
  app.use('/api', (req,res) => res.json({ data: req.body }));
  app.use((e,req,res,next) => res.status(500).json({ message: e.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  async function post(route, body, status=200) { const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await r.json();assert.equal(r.status,status,JSON.stringify(json));return json.data ?? json; }
  return { db, service, post, calls, models, load };
}
const empty = () => ({ text:null,image:null,video:null,tts:null });
const project = () => ({ projectType:'general_video',type:'advertisement',name:'Temporary',intro:'Brief',artStyle:'style',directorManual:'director',videoRatio:'16:9',imageQuality:'',mode:'' });
const preset = (slots={}) => ({ name:'General preset',slots:{...empty(),...slots} });
test('real wrapper schema, empty advertisement creation and reopening inherit defaults without writing models',async t=>{
 const f=await fixture(t); await f.post('project/addProject',project()); const projects=await f.post('project/getProject',{});const p=projects.find(p=>p.name==='Temporary');assert.ok(p);assert.equal(p.imageModel,'');assert.equal(p.videoModel,'');
 const saved=await f.post('modelSelect/presets/save',preset({image:'vendor:image'}));await f.post('modelSelect/presets/default',{scope:'profile:advertisement',presetId:saved.id});
 assert.equal((await f.post('project/getProject',{})).find(x=>x.id===p.id).imageModel,'vendor:image');assert.equal((await f.db('o_project').where({id:p.id}).first()).imageModel,'');
});
test('save entire preset with all four types and nulls, update without duplicates, apply entire preset',async t=>{
 const f=await fixture(t);const p=await f.post('modelSelect/presets/save',preset({text:'vendor:text',image:'vendor:image',video:'vendor:video',tts:'vendor:tts'}));
 const applied=await f.post('modelSelect/presets/project',{projectId:1,presetId:p.id});assert.deepEqual(applied.models,p.slots);
 await f.post('modelSelect/presets/save',{...p,slots:empty()});assert.equal((await f.post('modelSelect/presets/list',{})).presets.length,1);
 assert.deepEqual((await f.post('modelSelect/presets/project',{projectId:1,presetId:p.id})).models,empty());
});
test('project > profile > system, per-slot patch preserves others and null resumes inheritance',async t=>{
 const f=await fixture(t);const sys=await f.post('modelSelect/presets/save',preset({image:'vendor:image',video:'vendor:video',text:'vendor:text'}));const ad=await f.post('modelSelect/presets/save',preset({image:'vendor:image2'}));
 await f.post('modelSelect/presets/default',{scope:'system',presetId:sys.id});await f.post('modelSelect/presets/default',{scope:'profile:advertisement',presetId:ad.id});
 let r=await f.post('modelSelect/presets/resolve',{projectId:1});assert.equal(r.models.image,'vendor:image2');assert.equal(r.sources.video,'system');
 r=await f.post('modelSelect/presets/project',{projectId:1,slots:{image:'vendor:image'}});assert.equal(r.sources.image,'project');assert.equal(r.models.video,'vendor:video');
 assert.equal((await f.post('modelSelect/presets/project',{projectId:1,slots:{image:null}})).sources.image,'profile');
 await f.post('modelSelect/presets/default',{scope:'profile:advertisement',presetId:null});assert.equal((await f.post('modelSelect/presets/resolve',{projectId:1})).sources.image,'system');
});
test('legacy editor image change does not pin or overwrite inherited video configuration',async t=>{
 const f=await fixture(t);const p=await f.post('modelSelect/presets/save',preset({image:'vendor:image',video:'vendor:video'}));await f.post('modelSelect/presets/default',{scope:'profile:advertisement',presetId:p.id});
 await f.post('project/editProject',{...project(),id:1,imageModel:'vendor:image2',videoModel:'vendor:video'});
 let r=await f.service.resolveModels(1);assert.equal(r.sources.image,'project');assert.equal(r.sources.video,'profile');
 await f.post('modelSelect/presets/save',{...p,slots:{...p.slots,video:'vendor:video2'}});assert.equal((await f.service.resolveModels(1)).models.video,'vendor:video2');
});
test('all advertisement generation boundaries reject missing models before writes or paid dispatch',async t=>{
 const f=await fixture(t);for(const route of ['assetsGenerate/generateAssets','assetsGenerate/batchGenerateImageAssets','production/editImage/generateFlowImage','production/assets/batchGenerateAssetsImage','production/storyboard/batchGenerateImage']) { const r=await f.post(route,{projectId:1,model:'fake:request'},409);assert.match(r.message,/请先配置图片生成模型/); }
 for(const route of ['production/workbench/generateVideo','production/workbench/batchGenerateVideo']) { const r=await f.post(route,{projectId:1},409);assert.match(r.message,/请先配置视频生成模型/); }
 assert.equal(f.calls.length,0);assert.equal((await f.db('o_video')).length,0);
});
test('valid resolved models preserve actual image/video handlers; disabled/deleted/wrong-type models fail closed',async t=>{
 const f=await fixture(t);await f.post('modelSelect/presets/project',{projectId:1,slots:{image:'vendor:image',video:'vendor:video'}});
 await f.post('production/editImage/generateFlowImage',{projectId:1,prompt:'test',quality:'1K',ratio:'16:9',model:'vendor:image'});
 await f.post('production/workbench/generateVideo',{projectId:1,scriptId:1,prompt:'test',uploadData:[],mode:'text',duration:5,resolution:'720p',trackId:1});
 assert.deepEqual(f.calls,[{type:'image',model:'vendor:image'},{type:'video',model:'vendor:video'}]);
 await f.post('production/editImage/generateFlowImage',{projectId:1,model:'vendor:image2'},409);assert.equal(f.calls.length,2);
 await f.db('o_vendorConfig').update({enable:0});await f.post('modelSelect/presets/check',{projectId:1,slot:'image'},409);
 await f.db('o_vendorConfig').update({enable:1});await f.post('modelSelect/presets/project',{projectId:1,slots:{image:'vendor:video'}});await f.post('modelSelect/presets/check',{projectId:1,slot:'image'},409);
 await f.post('modelSelect/presets/project',{projectId:1,slots:{image:'vendor:removed'}});await f.post('modelSelect/presets/check',{projectId:1,slot:'image'},409);
});
test('non-advertisement model behavior remains unchanged; invalid preset/project input fails',async t=>{
 const f=await fixture(t);const p=await f.post('modelSelect/presets/save',preset({image:'vendor:image'}));await f.post('modelSelect/presets/default',{scope:'system',presetId:p.id});
 assert.equal((await f.service.resolveModels(2)).models.image,'legacy:image');assert.equal(await f.service.requireModel(2,'image','legacy:chosen'),'legacy:chosen');
 await f.post('modelSelect/presets/project',{projectId:2,presetId:p.id},400);await f.post('modelSelect/presets/resolve',{projectId:999},404);
 await f.post('modelSelect/presets/save',preset({image:'not-an-id'}),400);
});

test('new advertisement inherits existing profile default; text preset resolves while legacy deployment remains fallback',async t=>{
 const f=await fixture(t);const p=await f.post('modelSelect/presets/save',preset({text:'vendor:text',image:'vendor:image'}));await f.post('modelSelect/presets/default',{scope:'profile:advertisement',presetId:p.id});await f.post('project/addProject',project());const created=(await f.post('project/getProject',{})).find(p=>p.name==='Temporary');assert.equal(created.imageModel,'vendor:image');assert.equal(await f.service.textModelForProject(created.id,'productionAgent'),'vendor:text');assert.equal(await f.service.textModelForProject(2,'productionAgent'),'productionAgent');
});
test('shared actual AI runtime also rejects missing advertisement image/video/TTS before task or provider work',async t=>{
 const f=await fixture(t);const ai=f.load('utils/ai').default;
 for(const [name,label] of [['Image','图片生成'],['Video','视频生成'],['Audio','音频/TTS']])await assert.rejects(ai[name]('fake:request').run({}, {projectId:1}),new RegExp('请先配置'+label+'模型'));
 assert.equal(f.calls.length,0);
});
