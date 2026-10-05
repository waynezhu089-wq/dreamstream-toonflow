import fs from 'node:fs/promises';
import path from 'node:path';
import {buildKreaEditWorkflow,uploadEditInput} from '../src/v04/kreaImageEditProfile';
import {submitDraft,awaitDraft,downloadDraft} from '../src/v04/comfyDraftClient';
void (async()=>{
const dir=path.resolve('../opt029a-evidence');await fs.mkdir(dir,{recursive:true});
const source=path.resolve('../userdata/pilot/data/v04-draft-artifacts/1790941805789310/f19bbdd3-109b-4cfa-bd29-b334217b66df.png');
const src=await uploadEditInput('http://127.0.0.1:8188',await fs.readFile(source),'ds-opt029a-pilot-source.png');
const prompt='Edit this same young boy into cinematic stylized realism, natural child proportions, refined face anatomy, subtle fabric texture. Preserve his age, facial identity, messy dark short hairstyle, slim body and grey sleepwear. Keep barefoot. Full body, clean background. Do not add accessories.';
const wf=buildKreaEditWorkflow({profile:'KREA2_SOURCE_EDIT_V1',prompt,seed:29001,width:768,height:768,sourceImage:src,targetRole:'EDIT_CANDIDATE',jobId:'opt029a-text-pilot'});
await fs.writeFile(path.join(dir,'text-edit-workflow.json'),JSON.stringify(wf,null,2));
const start=Date.now(),id=await submitDraft('http://127.0.0.1:8188',wf);console.log('SUBMITTED',id);await fs.writeFile(path.join(dir,'text-edit-submission.json'),JSON.stringify({id,start,prompt,source}));
const image=await awaitDraft('http://127.0.0.1:8188',id,wf.outputNode,1200000),result=await downloadDraft('http://127.0.0.1:8188',image);const out=path.join(dir,'CHAR-001-text-edit.png');await fs.writeFile(out,result.bytes);console.log(JSON.stringify({id,seconds:(Date.now()-start)/1000,image,out,width:result.width,height:result.height}));

})().catch(error=>{console.error(error);process.exitCode=1;});
