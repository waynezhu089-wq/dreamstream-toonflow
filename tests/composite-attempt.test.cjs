const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { fixture } = require('./composite-fixture.cjs');
const quad = { topLeft:{x:40,y:30},topRight:{x:200,y:40},bottomRight:{x:210,y:225},bottomLeft:{x:50,y:230} };
async function setup(t) {
  const f=await fixture(t), files=new Map();
  const source=await sharp({create:{width:40,height:80,channels:4,background:'#f04080'}}).png().toBuffer();
  const background=await sharp({create:{width:256,height:256,channels:4,background:'#204060'}}).png().toBuffer();
  files.set('/generated/1',source);
  f.utils.oss.getFile=async p=>{if(!files.has(p))throw Error('file missing');return files.get(p);};
  f.utils.oss.writeFile=async(p,b)=>files.set(p,b);
  f.utils.oss.getFileUrl=async p=>p;
  await f.load('lib/compositeAttemptSchema').initializeCompositeAttemptSchema(f.db);
  await f.load('lib/compositeAttemptSchema').initializeCompositeAttemptSchema(f.db);
  const shot=await f.create({productionMode:'REAL_AI_COMPOSITE'});
  const untouched=await f.create();
  const service=f.load('services/compositeAttempt');
  const input={...f.ctx,storyboardId:shot.id,primaryAssetId:1,backgroundCapabilityId:'comfy.z-image-turbo.txt2img.v1',prompt:'Blank screen on desk',width:256,height:256,seed:1};
  const previousFetch=global.fetch,requests=[];let providerFails=false;
  global.fetch=async(url,init)=>{
    // Preserve the real local HTTP regression server.
    if(!String(url).startsWith('http://127.0.0.1:8188'))return previousFetch(url,init);
    requests.push({url,body:init?.body});
    if(providerFails)return new Response('offline',{status:503});
    if(String(url).endsWith('/prompt'))return Response.json({prompt_id:'fixture-run',node_errors:{}});
    if(String(url).includes('/history/'))return Response.json({'fixture-run':{status:{completed:true},outputs:{'9':{images:[{filename:'bg.png',type:'output'}]}}}});
    return new Response(background);
  };
  t.after(()=>{global.fetch=previousFetch;});
  async function start(){const a=await service.createCompositeAttempt(input);return service.runCompositeBackground({...input,attemptId:a.id});}
  const finish=a=>service.finishCompositeAttempt({...input,attemptId:a.id,screenQuad:quad,confirmed:true});
  return {...f,service,input,shot,untouched,files,source,background,requests,start,finish,setFailure:()=>{providerFails=true;}};
}
test('two stages use real wrapper: background never completes; confirmed warp sets final only; other shots unchanged',async t=>{
  const f=await setup(t),before=await f.db('o_storyboard').where({id:f.untouched.id}).first();
  const a=await f.start();assert.equal(a.status,'AWAITING_QUAD');assert.equal(a.screenQuad,null);assert.equal(a.finalPath,null);
  let shot=await f.db('o_storyboard').where({id:f.shot.id}).first();assert.equal(shot.filePath,'');assert.notEqual(shot.state,'已完成');
  const out=await f.finish(a);assert.equal(out.status,'COMPLETED');assert.notEqual(out.finalPath,out.backgroundPath);
  shot=await f.db('o_storyboard').where({id:f.shot.id}).first();assert.equal(shot.filePath,out.finalPath);assert.equal(shot.state,'已完成');
  assert.deepEqual(await f.db('o_storyboard').where({id:f.untouched.id}).first(),before);
  assert.equal(JSON.parse(shot.productionSpec).screenQuad,undefined);assert.equal(f.calls.length,0);
  const graph=JSON.parse(f.requests[0].body).prompt;assert.match(graph['57:27'].inputs.text,/no user interface/);assert.ok(!f.requests[0].body.includes('/generated/1'));
});
test('homography copies source pixels and leaves all outside-mask pixels untouched',async t=>{
  const f=await setup(t),a=await f.start(),out=await f.finish(a);
  const pixels=await sharp(f.files.get(out.finalPath)).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray((100*256+100)*4,(100*256+100)*4+4)],[240,64,128,255]);
  assert.deepEqual([...pixels.subarray(0,4)],[32,64,96,255]);
  const geometry=f.load('services/compositeGeometry');
  const identity={topLeft:{x:0,y:0},topRight:{x:39,y:0},bottomRight:{x:39,y:79},bottomLeft:{x:0,y:79}};
  const raw=Buffer.from(Array.from({length:40*80*4},(_,i)=>i%4===3?255:(i*13)%256));
  const patterned=await sharp(raw,{raw:{width:40,height:80,channels:4}}).png().toBuffer();
  const identical=await geometry.perspectiveComposite(patterned,patterned,identity);
  assert.deepEqual(await sharp(identical).raw().toBuffer(),raw);
});
test('missing, outside, crossed, degenerate quads and absent human confirmation reject without completing',async t=>{
  const f=await setup(t),a=await f.start();
  for(const [q,code] of [[undefined,'SCREEN_QUAD_REQUIRED'],[{...quad,topLeft:{x:-1,y:0}},'SCREEN_QUAD_INVALID'],[{...quad,topRight:quad.bottomLeft,bottomLeft:quad.topRight},'SCREEN_QUAD_INVALID'],[{...quad,topRight:quad.topLeft},'SCREEN_QUAD_INVALID']])
    await assert.rejects(f.service.finishCompositeAttempt({...f.input,attemptId:a.id,screenQuad:q,confirmed:true}),e=>e.code===code);
  await assert.rejects(f.service.finishCompositeAttempt({...f.input,attemptId:a.id,screenQuad:quad,confirmed:false}),e=>e.code==='SCREEN_QUAD_REQUIRED');
  assert.equal((await f.service.readCompositeAttempt({...f.input,attemptId:a.id})).status,'AWAITING_QUAD');
});
test('current Plan, current provenance and current source bytes are revalidated at finish',async t=>{
  for(const mutation of ['unbind','provenance','bytes','image']){
    const f=await setup(t),a=await f.start();
    if(mutation==='unbind')await f.plan.unbindAssetPlanItem({...f.ctx,assetKey:'screen'});
    if(mutation==='provenance')await f.db('o_assetUploadSource').where({assetId:1}).delete();
    if(mutation==='bytes')f.files.set('/generated/1',f.background);
    if(mutation==='image')await f.db('o_image').where({id:1}).update({model:'ai'});
    const out=await f.finish(a);assert.equal(out.status,'FAILED');assert.equal(out.errorCode,'PRIMARY_ASSET_INVALID');assert.equal(out.finalPath,null);
  }
});
test('cross-unit/project and nonexistent primary assets reject; unsupported capability never calls provider',async t=>{
  const f=await setup(t);
  for(const patch of [{scriptId:11},{projectId:2}])await assert.rejects(f.service.createCompositeAttempt({...f.input,...patch}),e=>e.code==='PRIMARY_ASSET_INVALID');
  await f.db('o_storyboard').where({id:f.shot.id}).update({productionSpec:JSON.stringify({productionMode:'REAL_AI_COMPOSITE',primaryAssetId:999})});
  await assert.rejects(f.service.createCompositeAttempt({...f.input,primaryAssetId:999}),e=>e.code==='PRIMARY_ASSET_NOT_FOUND');
  await assert.rejects(f.service.createCompositeAttempt({...f.input,backgroundCapabilityId:'unknown'}),e=>e.code==='BACKGROUND_CAPABILITY_UNSUPPORTED');
  assert.equal(f.requests.length,0);
});
test('provider failure is explicit and never falls back; retry has no inherited quad and obsolete attempt cannot overwrite',async t=>{
  const f=await setup(t),a=await f.start(),b=await f.start();
  assert.equal(b.screenQuad,null);await assert.rejects(f.finish(a),e=>e.code==='COMPOSITE_FAILED');
  await f.finish(b);f.setFailure();const c=await f.start();
  assert.equal(c.status,'FAILED');assert.equal(c.errorCode,'BACKGROUND_GENERATION_FAILED');assert.equal(c.finalPath,null);assert.equal(f.calls.length,0);
});
test('changed background rejects deterministically without fallback',async t=>{
  const f=await setup(t),a=await f.start();f.files.set(a.backgroundPath,f.source);
  const out=await f.finish(a);assert.equal(out.status,'FAILED');assert.equal(out.errorCode,'COMPOSITE_FAILED');assert.equal(f.calls.length,0);
});
test('HTTP requires scoped ids and explicit confirmation; read/start/finish share production Gate',async t=>{
  const f=await setup(t);
  await f.post('storyboard/composite/start',{...f.input,scriptId:11},400);
  await f.post('storyboard/composite/start',{...f.input,scriptId:undefined},400);
  const a=await f.post('storyboard/composite/start',f.input);
  let ready;
  for(let i=0;i<100;i++){ready=await f.post('storyboard/composite/read',{...f.input,attemptId:a.id});if(ready.status==='AWAITING_QUAD')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(ready.status,'AWAITING_QUAD');
  const denied=await f.post('storyboard/composite/finish',{...f.input,attemptId:a.id,screenQuad:quad,confirmed:false},409);assert.equal(denied.reason,'SCREEN_QUAD_REQUIRED');
  const out=await f.post('storyboard/composite/finish',{...f.input,attemptId:a.id,screenQuad:quad,confirmed:true});assert.equal(out.status,'COMPLETED');
  await f.plan.unbindAssetPlanItem({...f.ctx,assetKey:'screen'});
  await f.post('storyboard/composite/start',f.input,409);
});
