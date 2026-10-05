import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
// Local single-GPU ownership. Never steal from a live process based on time.
export async function acquireDraftWorkerLease(file:string){
 await fs.mkdir(path.dirname(file),{recursive:true});
 const content=JSON.stringify({pid:process.pid,nonce:randomUUID()});
 const take=async()=>{await fs.writeFile(file,content,{flag:'wx'});return async()=>{if(await fs.readFile(file,'utf8').catch(()=>null)===content)await fs.unlink(file);};};
 try{return await take();}catch(e:any){if(e.code!=='EEXIST')throw e;}
 // Serialise stale-file reclamation; a crashed reclaimer fails closed.
 const recovery=file+'.recovering';try{await fs.mkdir(recovery);}catch(e:any){if(e.code==='EEXIST')return null;throw e;}
 try{
  const old=await fs.readFile(file,'utf8').catch(()=>null);if(!old)return await take();
  let owner;try{owner=JSON.parse(old);}catch{return null;}
  if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)return null;
  try{process.kill(owner.pid,0);return null;}catch(e:any){if(e.code!=='ESRCH')return null;}
  if(await fs.readFile(file,'utf8').catch(()=>null)!==old)return null;
  await fs.unlink(file);try{return await take();}catch(e:any){if(e.code==='EEXIST')return null;throw e;}
 }finally{await fs.rmdir(recovery);}
}
