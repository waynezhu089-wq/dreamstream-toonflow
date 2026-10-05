import { db } from '@/utils/db';
import type { Knex } from 'knex';
import { submitDraft, DraftComfyError, type DraftWorkflow } from './comfyDraftClient';
import { captureExecutionTrace, markTraceSubmitted, failTrace } from './executionTrace';
export async function submitTracedDraft(base: string, workflow: DraftWorkflow, job: any) {
  const trace=await captureExecutionTrace(job,workflow,base);
  // Submit a frozen JSON roundtrip of exactly the bytes captured, not a mutable graph reference.
  try {
    const promptId=await submitDraft(base,{...workflow,graph:JSON.parse(trace.json)});
    await markTraceSubmitted(trace.id,promptId);
    return promptId;
  } catch(error) {
    await failTrace(trace.id,error instanceof DraftComfyError?error.code:'EXECUTION_UNCERTAIN');
    throw error;
  }
}
export async function failSubmittedTrace(job: any, code: string) {
  if(!job.comfyPromptId)return;
  const row=await (db as Knex)('o_v04ExecutionTrace').where({jobId:job.id,comfyPromptId:job.comfyPromptId,status:'RUNNING'}).first();
  if(row)await failTrace(row.id,code);
}
