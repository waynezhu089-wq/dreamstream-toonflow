const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),sharp=require('sharp');
const fs=require('node:fs'),path=require('node:path');const {fixture}=require('./composite-fixture.cjs');
const graph=fs.readFileSync(path.resolve(__dirname,'../examples/z-image-turbo-v1.api.json'),'utf8');
const definition=endpointId=>({endpointId,workflowJson:graph,inputPorts:[
 {name:'prompt',type:'text',required:true,label:'提示词'},
 {name:'width',type:'number',required:true,label:'宽度'},
 {name:'height',type:'number',required:true,label:'高度'},
 {name:'seed',type:'number',required:true,label:'种子'},
],outputPorts:[{name:'image',type:'image',label:'图片'}],inputMappings:[
 {portName:'prompt',nodeId:'57:27',inputKey:'text'},
 {portName:'width',nodeId:'57:13',inputKey:'width'},
 {portName:'height',nodeId:'57:13',inputKey:'height'},
 {portName:'seed',nodeId:'57:3',inputKey:'seed'},
],outputMappings:[{portName:'image',nodeId:'9',field:'images'}],runtimeConfig:{timeoutMs:1000,pollIntervalMs:10}});
const inputs={prompt:'A safe test photograph',width:576,height:1024,seed:17};
async function setup(t){
 const f=await fixture(t),store=new Map(),requests=[];f.utils.oss.writeFile=async(p,b)=>store.set(p,b);f.utils.oss.getFile=async p=>store.get(p);f.utils.oss.getFileUrl=async p=>'/oss'+p;
 const image=await sharp({create:{width:4,height:4,channels:4,background:'#123456'}}).png().toBuffer();
 const server=http.createServer(async(req,res)=>{requests.push({url:req.url,method:req.method});
  if(req.url==='/prompt'){let text='';for await(const part of req)text+=part;requests.at(-1).body=JSON.parse(text);if(f.mode==='submitError'){res.statusCode=422;res.end('bad');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({prompt_id:'fake-prompt'}));return;}
  if(req.url.startsWith('/history/')){res.setHeader('Content-Type','application/json');const run=f.mode==='timeout'?{}:f.mode==='executionError'?{status:{status_str:'error'}}:{status:{completed:true},outputs:f.mode==='missingOutput'?{}:{'9':{images:f.mode==='unsafePath'?[{filename:'../secret.png',subfolder:'',type:'output'}]:[{filename:'result.png',subfolder:'',type:'output'}]}}};res.end(JSON.stringify({'fake-prompt':run}));return;}
  if(req.url.startsWith('/view?')){res.setHeader('Content-Type','image/png');res.end(image);return;}
  res.statusCode=404;res.end();
 });server.listen(0,'127.0.0.1');await require('node:events').once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 await f.load('lib/capabilitySchema').initializeCapabilitySchema(f.db);await f.load('lib/capabilitySchema').initializeCapabilitySchema(f.db);
 const registry=f.load('services/capabilityRegistry'),executor=f.load('services/executeCapability');
 const endpoint=await registry.saveEndpoint({name:'Fake local Comfy',baseUrl:'http://127.0.0.1:'+server.address().port,enabled:true});
 return{...f,registry,executor,endpoint,store,requests,image,setMode:value=>{f.mode=value},definition:()=>definition(endpoint.id)};
}
async function draft(f){await f.registry.createFamily({familyKey:'comfy.z-image-turbo.txt2img',displayName:'Z-Image 文生图',description:'测试',category:'image',provider:'ComfyUI',executorType:'COMFY_UI'});return f.registry.createVersion({familyKey:'comfy.z-image-turbo.txt2img',definition:f.definition()});}
test('Family has no status; Draft lifecycle, current-definition Test Run, immutable Verified, V2 and Disabled exact IDs',async t=>{
 const f=await setup(t),v1=await draft(f);assert.equal(v1.capabilityId,'comfy.z-image-turbo.txt2img.v1');assert.equal(v1.status,'DRAFT');
 const listing=await f.registry.listCapabilities();assert.equal(listing.length,1);assert.equal('status'in listing[0],false);
 await assert.rejects(f.executor.executeCapability(v1.capabilityId,inputs),e=>e.code==='CAPABILITY_NOT_VERIFIED');
 await assert.rejects(f.registry.verifyVersion({capabilityId:v1.capabilityId}),e=>e.code==='CAPABILITY_NOT_VERIFIED');
 const run=await f.executor.testCapability(v1.capabilityId,inputs);assert.equal(run.status,'SUCCEEDED');assert.equal(run.capabilityId,v1.capabilityId);assert.equal(run.promptId,'fake-prompt');assert.equal(run.outputs.image.filePath.startsWith('/capability/'),true);assert.deepEqual(f.store.get(run.outputs.image.filePath),f.image);
 const changed={...f.definition(),inputPorts:f.definition().inputPorts.map(p=>p.name==='prompt'?{...p,label:'新版提示词'}:p)};
 await f.registry.updateDraft({capabilityId:v1.capabilityId,definition:changed});await assert.rejects(f.registry.verifyVersion({capabilityId:v1.capabilityId}),e=>e.code==='CAPABILITY_NOT_VERIFIED');
 await f.executor.testCapability(v1.capabilityId,inputs);const verified=await f.registry.verifyVersion({capabilityId:v1.capabilityId});assert.equal(verified.status,'VERIFIED');
 await assert.rejects(f.registry.updateDraft({capabilityId:v1.capabilityId,definition:f.definition()}),e=>e.status===409);
 const production=await f.executor.executeCapability(v1.capabilityId,inputs);assert.equal(production.status,'SUCCEEDED');
 const v2=await f.registry.createVersion({familyKey:'comfy.z-image-turbo.txt2img',sourceCapabilityId:v1.capabilityId});assert.equal(v2.capabilityId,'comfy.z-image-turbo.txt2img.v2');assert.equal(v2.status,'DRAFT');assert.equal((await f.registry.getVersion(v1.capabilityId)).inputPorts[0].label,'新版提示词');
 await f.registry.disableVersion({capabilityId:v1.capabilityId});await assert.rejects(f.executor.executeCapability(v1.capabilityId,inputs),e=>e.code==='CAPABILITY_DISABLED');
 await assert.rejects(f.executor.executeCapability(v2.capabilityId,inputs),e=>e.code==='CAPABILITY_NOT_VERIFIED');
 const provenance=await f.registry.listExecutions({capabilityId:v1.capabilityId});assert.ok(provenance.some(e=>e.status==='FAILED'));assert.ok(provenance.some(e=>e.status==='SUCCEEDED'));
 const saved=await f.registry.readExecution({executionId:production.executionId});assert.deepEqual(saved.inputs,inputs);assert.equal(saved.promptId,'fake-prompt');assert.equal(saved.endpointId,f.endpoint.id);assert.equal(saved.capabilityId,v1.capabilityId);
});
test('mapping, workflow, duplicate id, port, type, endpoint and base URL validation',async t=>{
 const f=await setup(t),v1=await draft(f),C=f.load('services/capabilityContract');
 await assert.rejects(f.registry.createVersion({familyKey:'comfy.z-image-turbo.txt2img',capabilityId:v1.capabilityId,definition:f.definition()}),e=>e.code==='CAPABILITY_MAPPING_INVALID');
 await assert.rejects(f.registry.createFamily({familyKey:'comfy.z-image-turbo.txt2img',displayName:'Duplicate',description:'',category:'image',provider:'ComfyUI',executorType:'COMFY_UI'}),e=>e.status===409);
 for(const mutation of [d=>{d.workflowJson='{invalid';},d=>{d.inputMappings[0].nodeId='missing';},d=>{d.inputMappings[0].inputKey='missing';},d=>{d.outputMappings[0].nodeId='missing';},d=>{d.inputPorts.push({...d.inputPorts[0]});}]){
  const d=f.definition();mutation(d);await assert.rejects(f.registry.updateDraft({capabilityId:v1.capabilityId,definition:d}),e=>e.code==='CAPABILITY_MAPPING_INVALID');
 }
 await assert.rejects(f.executor.testCapability(v1.capabilityId,{...inputs,width:'576'}),e=>e.code==='CAPABILITY_INPUT_INVALID');
 await assert.rejects(f.executor.testCapability(v1.capabilityId,{...inputs,prompt:undefined}),e=>e.code==='CAPABILITY_INPUT_INVALID');
 await assert.rejects(f.executor.executeCapability('comfy.missing.v1',inputs),e=>e.code==='CAPABILITY_NOT_FOUND');
 await assert.rejects(f.registry.saveEndpoint({name:'Bad',baseUrl:'file:///tmp',enabled:true}),e=>e.code==='CAPABILITY_MAPPING_INVALID');
 await f.registry.saveEndpoint({id:f.endpoint.id,name:f.endpoint.name,baseUrl:f.endpoint.baseUrl,enabled:false});await assert.rejects(f.executor.testCapability(v1.capabilityId,inputs),e=>e.code==='COMFY_UNAVAILABLE');
 assert.ok(C.parseWorkflow(graph)['9']);
});
test('fake HTTP Comfy receives direct mapped values, serves image, and leaves version graph frozen',async t=>{
 const f=await setup(t),v=await draft(f),before=(await f.registry.getVersion(v.capabilityId)).workflowJson;
 const out=await f.postCapability('version/test',{capabilityId:v.capabilityId,inputs});assert.equal(out.status,'SUCCEEDED');
 const submitted=f.requests.find(r=>r.url==='/prompt').body.prompt;assert.equal(submitted['57:27'].inputs.text,inputs.prompt);assert.equal(submitted['57:13'].inputs.width,576);assert.equal(submitted['57:13'].inputs.height,1024);assert.equal(submitted['57:3'].inputs.seed,17);
 assert.equal((await f.registry.getVersion(v.capabilityId)).workflowJson,before);
 assert.deepEqual(f.requests.map(r=>r.url.split('?')[0]),['/prompt','/history/fake-prompt','/view']);
 assert.equal((await f.postCapability('version/verify',{capabilityId:v.capabilityId})).status,'VERIFIED');
 assert.equal((await f.postCapability('execute',{capabilityId:v.capabilityId,inputs})).status,'SUCCEEDED');
});
test('Comfy unavailable, submit failure, execution error, timeout, missing output and unsafe path have stable persisted errors',async t=>{
 for(const [mode,code] of [['submitError','COMFY_SUBMIT_FAILED'],['executionError','COMFY_EXECUTION_FAILED'],['timeout','COMFY_TIMEOUT'],['missingOutput','CAPABILITY_OUTPUT_NOT_FOUND'],['unsafePath','CAPABILITY_OUTPUT_NOT_FOUND']]){
  const f=await setup(t),v=await draft(f);f.setMode(mode);await assert.rejects(f.executor.testCapability(v.capabilityId,inputs),e=>e.code===code);
  const saved=await f.registry.listExecutions({capabilityId:v.capabilityId});assert.equal(saved[0].status,'FAILED');assert.equal(JSON.parse(saved[0].error).code,code);
 }
 const f=await setup(t),v=await draft(f);await f.registry.saveEndpoint({id:f.endpoint.id,name:f.endpoint.name,baseUrl:'http://127.0.0.1:1',enabled:true});
 await assert.rejects(f.executor.testCapability(v.capabilityId,inputs),e=>e.code==='COMFY_UNAVAILABLE');
});
