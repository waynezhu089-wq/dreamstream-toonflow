const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./composite-fixture.cjs');
const express=require('express');

async function setup(t){
 const f=await fixture(t);const schema=f.load('lib/skillSchema');await schema.initializeSkillSchema(f.db);await schema.initializeSkillSchema(f.db);
 await f.load('lib/capabilitySchema').initializeCapabilitySchema(f.db);
 await f.raw.schema.createTable('o_setting',table=>{table.string('key').primary();table.string('value');});
 await f.raw.schema.createTable('o_agentDeploy',table=>{table.string('key').primary();table.string('modelName');});
 await f.db('o_agentDeploy').insert({key:'productionAgent:storyboardGenAgent',modelName:'vendor:text'});
 const registry=f.load('services/skillRegistry'),compiler=f.load('services/skillCompiler'),contract=f.load('services/skillContract'),builder=f.load('services/skillBuilder');
 const app=express();app.use(express.json());app.use('/api/skills',f.load('routes/skills/index').default);
 const server=app.listen(0,'127.0.0.1');await require('node:events').once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 async function post(route,body,status=200){const res=await fetch(`http://127.0.0.1:${server.address().port}/api/skills/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await res.json();assert.equal(res.status,status,JSON.stringify(json));return json.data??json;}
 const family=(skillId='image-prompt.tech-product-cinematic')=>({skillId,displayName:'Tech Product Image Prompt',skillType:'IMAGE_PROMPT',description:'Reusable image prompt method',tags:['product']});
 const content=(overrides={})=>({...contract.emptyTemplate('IMAGE_PROMPT'),purpose:'Create a cinematic product image prompt',rules:['Preserve real product UI pixels'],outputRequirements:['One complete prompt'],lighting:'Soft side light',...overrides});
 async function active(skillId='image-prompt.tech-product-cinematic'){await registry.createSkillFamily(family(skillId));await registry.createDraft({skillId,content:content()});await registry.activateDraft({skillId,version:'v1'});return skillId;}
 return {...f,registry,compiler,contract,builder,post,family,content,active};
}

test('UX1 quick preview is read-only, normalizes IDs, saves Family and Draft V1 atomically, and rolls back on failed V1 insert',async t=>{
 const f=await setup(t),calls=[];
 f.utils.Ai.Text=key=>({invoke:async input=>{calls.push({key,input});return{text:JSON.stringify({suggestedSlug:'tech-product-cinematic',displayName:'Tech Product',description:'Reusable',tags:['product'],content:f.content()})};}});
 const candidate=await f.builder.quickPreview({skillType:'IMAGE_PROMPT',instruction:'Cinematic product imagery with real UI preserved'});
 assert.equal(calls[0].key,'universalAi');assert.equal(candidate.skillId,'image-prompt.tech-product-cinematic');
 assert.equal((await f.db('o_skillRegistry')).length,0);assert.equal((await f.db('o_skillVersion')).length,0);
 const saved=await f.builder.quickSave({family:{skillId:candidate.skillId,displayName:candidate.displayName,skillType:'IMAGE_PROMPT',description:candidate.description,tags:candidate.tags},candidateContent:candidate.candidateContent});
 assert.equal(saved.version.version,'v1');assert.equal(saved.version.status,'DRAFT');
 const again=await f.builder.quickPreview({skillType:'IMAGE_PROMPT',instruction:'Cinematic product imagery with real UI preserved'});assert.equal(again.skillId,'image-prompt.tech-product-cinematic-2');
 await f.raw.raw("CREATE TRIGGER fail_skill_v1 BEFORE INSERT ON o_skillVersion BEGIN SELECT RAISE(FAIL, 'fail'); END");
 await assert.rejects(f.builder.quickSave({family:f.family('image-prompt.rollback'),candidateContent:f.content()}));
 assert.equal((await f.db('o_skillRegistry').where({skillId:'image-prompt.rollback'})).length,0);
});

test('UX1 draft preview edits same Draft only after confirmation; Active improvement is a field diff and an existing Draft blocks another version',async t=>{
 const f=await setup(t),id='image-prompt.tech';await f.registry.createSkillFamily(f.family(id));await f.registry.createDraft({skillId:id,content:f.content()});
 f.utils.Ai.Text=()=>({invoke:async()=>({text:JSON.stringify({suggestedSlug:'tech',displayName:'Tech',description:'Reusable',tags:[],content:f.content({lighting:'Natural daylight'})})})});
 const preview=await f.builder.draftPreview({skillId:id,version:'v1',instruction:'Use brighter natural light'});
 assert.equal(preview.candidateContent.lighting,'Natural daylight');assert.equal((await f.registry.getSkill({skillId:id})).versions.length,1);
 assert.equal((await f.registry.getSkill({skillId:id,version:'v1'})).versions[0].content.lighting,'Soft side light');
 await f.registry.editDraft({skillId:id,version:'v1',content:preview.candidateContent});
 assert.equal((await f.registry.getSkill({skillId:id,version:'v1'})).versions[0].content.lighting,'Natural daylight');
 await f.registry.activateDraft({skillId:id,version:'v1'});
 f.utils.Ai.Text=()=>({invoke:async()=>({text:JSON.stringify({suggestedSlug:'tech',displayName:'Tech',description:'Reusable',tags:[],content:f.content({lighting:'Bright outdoor light'})})})});
 const improved=await f.builder.improvePreview({skillId:id,version:'v1',instruction:'More natural light'});
 assert.equal(improved.changes.find(row=>row.field==='lighting').changeType,'MODIFIED');assert.equal(improved.changes.find(row=>row.field==='lighting').accepted,false);
 assert.equal((await f.registry.getSkill({skillId:id,version:'v1'})).versions[0].status,'ACTIVE');
 await f.registry.createDraft({skillId:id,sourceVersion:'v1',content:improved.candidateContent});
 await assert.rejects(f.registry.createDraft({skillId:id,sourceVersion:'v1'}),e=>e.code==='SKILL_DRAFT_NOT_ALLOWED');
 assert.equal((await f.registry.getSkill({skillId:id})).versions.length,2);
});

test('UX1 Builder limits invalid JSON to one repair, fails second invalid output, and normalizes missing model errors',async t=>{
 const f=await setup(t);let count=0;
 f.utils.Ai.Text=()=>({invoke:async()=>{count++;return{text:count===1?'bad JSON':JSON.stringify({suggestedSlug:'director-guide',displayName:'Director',description:'General',tags:[],content:{...f.contract.emptyTemplate('DIRECTOR'),purpose:'Plan shots'}})};}});
 const result=await f.builder.quickPreview({skillType:'DIRECTOR',instruction:'Plan a clear visual narrative'});assert.equal(result.skillId,'director.director-guide');assert.equal(count,2);
 f.utils.Ai.Text=()=>({invoke:async()=>{count++;return{text:'bad JSON'};}});count=0;
 await assert.rejects(f.builder.quickPreview({skillType:'DIRECTOR',instruction:'Plan a clear visual narrative'}),e=>e.code==='SKILL_BUILDER_INVALID_OUTPUT');assert.equal(count,2);
 f.utils.Ai.Text=()=>({invoke:async()=>{throw Error('未找到部署配置');}});
 await assert.rejects(f.builder.quickPreview({skillType:'DIRECTOR',instruction:'Plan a clear visual narrative'}),e=>e.code==='SKILL_BUILDER_MODEL_UNAVAILABLE');
});

test('UX1 contextual Project Derived preview uses the real scoped source, saves unchanged hash and provenance, rejects changed source',async t=>{
 const f=await setup(t);await f.raw.schema.alterTable('o_project',table=>table.string('name'));await f.db('o_project').where({id:1}).update({name:'睿译读'});
 const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[],prompt:'睿译读 product screen; lighting: soft blue; projectId:1'});let inputText='';
 f.utils.Ai.Text=()=>({invoke:async input=>{inputText=JSON.stringify(input);return{text:JSON.stringify({suggestedSlug:'product-light',displayName:'睿译读 Visual Method',description:'Reusable',tags:[],content:f.content({lighting:'睿译读 cool light'})})};}});
 const preview=await f.builder.projectDerivedPreview({projectId:1,scriptId:10,storyboardId:shot.id,skillType:'IMAGE_PROMPT'});
 assert.equal((await f.db('o_skillRegistry')).length,0);assert.equal(inputText.includes('projectId:1'),false);assert.equal(preview.sourceHash.length,64);
 const family={skillId:preview.skillId,displayName:preview.displayName,skillType:'IMAGE_PROMPT',description:preview.description,tags:preview.tags};
 await f.db('o_storyboard').where({id:shot.id}).update({prompt:'new source'});
 await assert.rejects(f.builder.projectDerivedSave({projectId:1,scriptId:10,storyboardId:shot.id,expectedSourceHash:preview.sourceHash,family,candidateContent:preview.candidateContent}),e=>e.code==='SKILL_SOURCE_CHANGED');
 assert.equal((await f.db('o_skillRegistry')).length,0);
 await f.db('o_storyboard').where({id:shot.id}).update({prompt:'睿译读 product screen; lighting: soft blue; projectId:1'});
 const saved=await f.builder.projectDerivedSave({projectId:1,scriptId:10,storyboardId:shot.id,expectedSourceHash:preview.sourceHash,family,candidateContent:preview.candidateContent});
 assert.equal(saved.version.sourceType,'PROJECT_DERIVED');assert.equal(saved.version.sourceData.sourceId,shot.id);assert.equal(saved.version.sourceData.sourceHash,preview.sourceHash);
 assert.match(saved.version.sourceData.sourceSnapshot,/projectId:1/);assert.equal(JSON.stringify(saved.version.content).includes('睿译读'),false);
 await assert.rejects(f.builder.projectDerivedPreview({projectId:1,scriptId:11,storyboardId:shot.id,skillType:'IMAGE_PROMPT'}),e=>e.code==='SKILL_SOURCE_INVALID');
});

test('additive schema, family, Draft V1, Active V1 immutability, Draft V2, Active V2 and historical exact V1',async t=>{
 const f=await setup(t),id=await f.active();
 assert.equal(await f.raw.schema.hasTable('o_skillRegistry'),true);assert.equal(await f.raw.schema.hasTable('o_skillList'),false);
 const family=(await f.registry.listSkills())[0];assert.equal('status' in family,false);assert.equal(family.versions[0].version,'v1');
 assert.equal((await f.registry.loadSkill(id,'v1')).skillStatus,'ACTIVE');
 await assert.rejects(f.registry.editDraft({skillId:id,version:'v1',content:f.content({lighting:'New light'})}),e=>e.code==='SKILL_DRAFT_NOT_ALLOWED');
 const v2=await f.registry.createDraft({skillId:id,sourceVersion:'v1'});assert.equal(v2.version,'v2');assert.equal(v2.status,'DRAFT');
 await assert.rejects(f.registry.loadSkill(id,'v2'),e=>e.code==='SKILL_DRAFT_NOT_ALLOWED');
 await f.registry.editDraft({skillId:id,version:'v2',content:f.content({lighting:'Brighter natural light'})});
 await f.registry.activateDraft({skillId:id,version:'v2'});
 assert.equal((await f.registry.loadSkill(id,'v1')).skillStatus,'DEPRECATED');
 assert.match((await f.registry.loadSkill(id,'v2')).runtimeInstruction,/Brighter natural light/);
 await assert.rejects(f.registry.loadSkill(id,'1'),e=>e.code==='SKILL_VERSION_NOT_FOUND');
 await assert.rejects(f.registry.loadSkill(id,'v3'),e=>e.code==='SKILL_VERSION_NOT_FOUND');
});

test('canonical bindings resolve SHOT > STAGE > PROJECT > RECIPE > PROFILE > SYSTEM; overrides accumulate low to high',async t=>{
 const f=await setup(t),id=await f.active();const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[]});
 const context={projectId:1,scriptId:10,storyboardId:shot.id,profileKey:'advertisement',recipeKey:'product'};
 const keys=[['SYSTEM','system'],['PROFILE','profile:advertisement'],['RECIPE','recipe:product'],['PROJECT','project:1'],['STAGE','project:1:script:10:stage:image-prompt'],['SHOT',`project:1:script:10:storyboard:${shot.id}`]];
 for(const [scopeType,scopeKey] of keys){await f.registry.saveBinding({scopeType,scopeKey,skillType:'IMAGE_PROMPT',skillId:id,skillVersion:'v1',overrideText:`${scopeType} override`});const r=await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'});assert.equal(r.resolvedFrom.scopeType,scopeType);}
 const resolved=await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'});
 assert.deepEqual(resolved.overrideChain.map(x=>x.scopeType),keys.map(x=>x[0]));assert.equal(resolved.resolutionTrace.length,6);assert.equal(resolved.resolutionTrace.at(-1).selected,true);
 await f.registry.saveBinding({scopeType:'SHOT',scopeKey:keys.at(-1)[1],skillType:'IMAGE_PROMPT',skillId:null,skillVersion:null,overrideText:'Shot only bright and natural'});
 const inherited=await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'});assert.equal(inherited.resolvedFrom.scopeType,'STAGE');assert.equal(inherited.overrideChain.at(-1).text,'Shot only bright and natural');
 await f.registry.removeBinding({scopeType:'STAGE',scopeKey:keys[4][1],skillType:'IMAGE_PROMPT'});assert.equal((await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'})).resolvedFrom.scopeType,'PROJECT');
 await f.registry.removeBinding({scopeType:'PROJECT',scopeKey:'project:1',skillType:'IMAGE_PROMPT'});assert.equal((await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'})).resolvedFrom.scopeType,'RECIPE');
 await f.registry.removeBinding({scopeType:'RECIPE',scopeKey:'recipe:product',skillType:'IMAGE_PROMPT'});assert.equal((await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'})).resolvedFrom.scopeType,'PROFILE');
 await f.registry.removeBinding({scopeType:'PROFILE',scopeKey:'profile:advertisement',skillType:'IMAGE_PROMPT'});assert.equal((await f.registry.resolveSkill({...context,skillType:'IMAGE_PROMPT'})).resolvedFrom.scopeType,'SYSTEM');
});

test('production binding rejects Draft and new Deprecated, preserves exact historical V1 through V2 activation and explicit upgrade',async t=>{
 const f=await setup(t),id=await f.active();const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[]});
 const binding={scopeType:'PROJECT',scopeKey:'project:1',skillType:'IMAGE_PROMPT',skillId:id,skillVersion:'v1',overrideText:null};
 await f.registry.saveBinding(binding);await f.registry.createDraft({skillId:id,sourceVersion:'v1'});
 await assert.rejects(f.registry.saveBinding({...binding,scopeKey:`project:1:script:10:storyboard:${shot.id}`,scopeType:'SHOT',skillVersion:'v2'}),e=>e.code==='SKILL_DRAFT_NOT_ALLOWED');
 await f.registry.activateDraft({skillId:id,version:'v2'});
 assert.equal((await f.registry.resolveSkill({projectId:1,scriptId:10,storyboardId:shot.id,skillType:'IMAGE_PROMPT'})).skillVersion,'v1');
 await assert.rejects(f.registry.saveBinding({...binding,scopeType:'SHOT',scopeKey:`project:1:script:10:storyboard:${shot.id}`}),e=>e.code==='SKILL_DEPRECATED_NEW_BINDING_BLOCKED');
 await f.registry.saveBinding({...binding,overrideText:'Existing V1 local rule'});
 await f.registry.saveBinding({...binding,skillVersion:'v2'});
 assert.equal((await f.registry.resolveSkill({projectId:1,scriptId:10,storyboardId:shot.id,skillType:'IMAGE_PROMPT'})).skillVersion,'v2');
 await assert.rejects(f.registry.saveBinding({...binding,scopeKey:'project:2'}),e=>e.code==='SKILL_DEPRECATED_NEW_BINDING_BLOCKED');
 await assert.rejects(f.registry.saveBinding({...binding,scopeType:'SHOT',scopeKey:`project:1:script:11:storyboard:${shot.id}`,skillVersion:'v2'}),e=>e.code==='SKILL_BINDING_INVALID');
});

test('Manual, Copy and selected-source Project Derived builders retain provenance without copying project names into public rules',async t=>{
 const f=await setup(t),id=await f.active();const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[],prompt:'主体: 睿译读手机；光线: soft side light；style: cinematic；projectId:1；C:\\secret\\asset.png'});
 const copied=await f.registry.copySkill({sourceSkillId:id,sourceVersion:'v1',family:f.family('image-prompt.copy')});
 assert.equal(copied.version.version,'v1');assert.equal(copied.version.status,'DRAFT');assert.equal(copied.version.sourceType,'COPY');
 const derived=await f.registry.buildFromSelectedSource({family:f.family('image-prompt.derived'),projectId:1,scriptId:10,sourceType:'STORYBOARD_PROMPT',sourceId:shot.id});
 assert.equal(derived.version.sourceType,'PROJECT_DERIVED');assert.equal(derived.version.sourceData.sourceId,shot.id);assert.equal(derived.version.sourceData.sourceHash.length,64);
 assert.equal(derived.version.sourceData.sourceSnapshot.includes('projectId:1'),true);assert.equal(JSON.stringify(derived.version.content).includes('projectId:1'),false);
 await assert.rejects(f.registry.buildFromSelectedSource({family:f.family('image-prompt.bad'),projectId:1,scriptId:11,sourceType:'STORYBOARD_PROMPT',sourceId:shot.id}),e=>e.code==='SKILL_SOURCE_INVALID');
 const recommendation=await f.registry.recommendSkills({skillType:'IMAGE_PROMPT',tags:['product']});assert.equal(recommendation.recommended.skillId,id);assert.match(recommendation.recommended.reason,/product/);
 const check=await f.registry.checkReversePromptCompatibility();assert.equal(check.available,false);
 await assert.rejects(f.registry.requireReversePromptExecution(),e=>e.code==='REVERSE_PROMPT_CAPABILITY_UNSUPPORTED');
});

test('IMAGE_PROMPT compiler loads exact Skill, sends full context to existing text route, previews without mutation, then human Apply reuses storyboard invalidation',async t=>{
 const f=await setup(t),id=await f.active();const shot=await f.create({productionMode:'REAL_AI_COMPOSITE',primaryAssetId:1,associateAssetsIds:[1],prompt:'Old prompt'});
 await f.registry.saveBinding({scopeType:'PROJECT',scopeKey:'project:1',skillType:'IMAGE_PROMPT',skillId:id,skillVersion:'v1',overrideText:null});
 await f.registry.saveBinding({scopeType:'SHOT',scopeKey:`project:1:script:10:storyboard:${shot.id}`,skillType:'IMAGE_PROMPT',skillId:null,skillVersion:null,overrideText:'Brighter and natural'});
 const calls=[];f.utils.Ai.Text=key=>({invoke:async input=>{calls.push({key,input});return{text:'A complete new cinematic background prompt, soft natural side light, blank screen, no text or interface.'};}});
 const preview=await f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:shot.id});
 assert.equal(preview.resolvedSkill.skillVersion,'v1');assert.equal(preview.resolvedSkill.resolvedFrom.scopeType,'PROJECT');
 assert.equal(calls[0].key,'productionAgent:storyboardGenAgent');assert.match(calls[0].input.system,/真实 UI/);
 const context=JSON.parse(calls[0].input.messages[0].content);assert.equal(context.currentStoryboard.prompt,'Old prompt');assert.equal(context.assetConstraints.assets[0].assetId,1);assert.equal(context.currentStoryboard.primaryAssetId,1);assert.equal(context.overrideChain.at(-1).text,'Brighter and natural');
 assert.equal((await f.db('o_storyboard').where({id:shot.id}).first()).prompt,'Old prompt');
 const record=await f.compiler.readCompile({compileId:preview.compileId,projectId:1,scriptId:10,storyboardId:shot.id});assert.equal(record.appliedAt,null);assert.equal(record.skillDefinitionHash.length,64);assert.equal(record.modelReference,'productionAgent:storyboardGenAgent');
 const applied=await f.compiler.applyCompile({compileId:preview.compileId,projectId:1,scriptId:10,storyboardId:shot.id});
 const row=await f.db('o_storyboard').where({id:shot.id}).first();assert.equal(row.prompt,preview.compiledPrompt);assert.equal(row.state,'未生成');assert.equal(row.filePath,'');
 const spec=f.load('services/storyboardProduction').productionSpec(row);assert.equal(spec.promptSkillId,id);assert.equal(spec.promptSkillVersion,'v1');assert.ok(applied.appliedAt);
 await assert.rejects(f.compiler.applyCompile({compileId:preview.compileId,projectId:1,scriptId:10,storyboardId:shot.id}),e=>e.code==='SKILL_BINDING_INVALID');
});

test('compile rejects mechanical append, unsupported direct production and absent exact Skill; HTTP exposes stable codes',async t=>{
 const f=await setup(t),id=await f.active();const direct=await f.create();
 await assert.rejects(f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:direct.id}),e=>e.code==='SKILL_TEMPLATE_INVALID');
 const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[],prompt:'Old scene'});
 await assert.rejects(f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:shot.id}),e=>e.code==='SKILL_RESOLUTION_FAILED');
 await f.registry.saveBinding({scopeType:'PROJECT',scopeKey:'project:1',skillType:'IMAGE_PROMPT',skillId:id,skillVersion:'v1',overrideText:null});
 await f.registry.saveBinding({scopeType:'SHOT',scopeKey:`project:1:script:10:storyboard:${shot.id}`,skillType:'IMAGE_PROMPT',skillId:null,skillVersion:null,overrideText:'Brighter'});
 f.utils.Ai.Text=()=>({invoke:async()=>({text:'Old scene\nBrighter'})});
 await assert.rejects(f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:shot.id}),e=>e.code==='SKILL_COMPILE_FAILED');
 assert.equal((await f.db('o_skillCompile')).length,0);
 const response=await f.post('load',{skillId:id,skillVersion:'v3'},404);assert.equal(response.reason,'SKILL_VERSION_NOT_FOUND');
});

test('generic Skill types use the common template; only IMAGE_PROMPT enters the compiler; recommendations never bind automatically',async t=>{
 const f=await setup(t),family={skillId:'director.general',displayName:'General Director',skillType:'DIRECTOR',description:'General directions',tags:['general']};
 await f.registry.createSkillFamily(family);const generic=f.contract.emptyTemplate('DIRECTOR');generic.purpose='Plan scenes';generic.rules=['Keep visual continuity'];
 const draft=await f.registry.createDraft({skillId:family.skillId,content:generic});assert.equal(draft.templateId,'generic.v1');
 await f.registry.activateDraft({skillId:family.skillId,version:'v1'});assert.match((await f.registry.loadSkill(family.skillId,'v1')).runtimeInstruction,/Keep visual continuity/);
 const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[]});
 await f.registry.saveBinding({scopeType:'PROJECT',scopeKey:'project:1',skillType:'DIRECTOR',skillId:family.skillId,skillVersion:'v1',overrideText:null});
 await assert.rejects(f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:shot.id}),e=>e.code==='SKILL_RESOLUTION_FAILED');
 await f.registry.recommendSkills({skillType:'DIRECTOR',tags:['general']});assert.equal((await f.db('o_skillBinding')).length,1);
 await assert.rejects(f.registry.createDraft({skillId:family.skillId,content:{...generic,lighting:'invalid'}}),e=>e.code==='SKILL_TEMPLATE_INVALID');
});

test('point-of-use text model check, stale preview and scoped Compile read prevent unintended Apply',async t=>{
 const f=await setup(t),id=await f.active();const shot=await f.create({productionMode:'AI_TEXT_TO_IMAGE',primaryAssetId:null,associateAssetsIds:[],prompt:'Before'});
 await f.registry.saveBinding({scopeType:'PROJECT',scopeKey:'project:1',skillType:'IMAGE_PROMPT',skillId:id,skillVersion:'v1',overrideText:null});
 await f.db('o_agentDeploy').delete();
 await assert.rejects(f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:shot.id}),e=>e.code==='SKILL_COMPILE_MODEL_UNAVAILABLE');
 assert.equal((await f.db('o_skillCompile')).length,0);
 await f.db('o_agentDeploy').insert({key:'productionAgent:storyboardGenAgent',modelName:'vendor:text'});
 f.utils.Ai.Text=()=>({invoke:async()=>({text:'A fully rewritten cinematic frame with soft light and no product UI redrawing.'})});
 const preview=await f.compiler.compileImagePrompt({projectId:1,scriptId:10,storyboardId:shot.id});
 await assert.rejects(f.compiler.readCompile({compileId:preview.compileId,projectId:1,scriptId:11,storyboardId:shot.id}),e=>e.code==='SKILL_SOURCE_INVALID');
 await f.db('o_storyboard').where({id:shot.id}).update({prompt:'Human changed this prompt'});
 await assert.rejects(f.compiler.applyCompile({compileId:preview.compileId,projectId:1,scriptId:10,storyboardId:shot.id}),e=>e.code==='SKILL_BINDING_INVALID');
 assert.equal((await f.db('o_skillCompile').where({compileId:preview.compileId}).first()).appliedAt,null);
});

test('selected Director and Production text snapshots are sourced from one scoped workspace record',async t=>{
 const f=await setup(t);const row=await f.db('o_agentWorkData').insert({projectId:1,episodesId:10,key:'productionAgent',data:JSON.stringify({scriptPlan:'光线: soft ambient',storyboardTable:'style: natural cinematic'})});
 const director=await f.registry.buildFromSelectedSource({family:f.family('image-prompt.from-director'),projectId:1,scriptId:10,sourceType:'DIRECTOR_OUTPUT_SNAPSHOT',sourceId:row[0]});
 assert.equal(director.version.content.lighting,'soft ambient');assert.equal(director.version.sourceData.sourceType,'DIRECTOR_OUTPUT_SNAPSHOT');
 const production=await f.registry.buildFromSelectedSource({family:f.family('image-prompt.from-production'),projectId:1,scriptId:10,sourceType:'PRODUCTION_TEXT_RESULT',sourceId:row[0]});
 assert.equal(production.version.content.style,'natural cinematic');
 await assert.rejects(f.registry.buildFromSelectedSource({family:f.family('image-prompt.cross-unit'),projectId:1,scriptId:11,sourceType:'PRODUCTION_TEXT_RESULT',sourceId:row[0]}),e=>e.code==='SKILL_SOURCE_INVALID');
});
