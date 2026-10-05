import { createHash, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@/utils/db';
import { graphFacts } from './operationsRegistry';
const q = db as Knex;
export const graphHash = (json: string) => createHash('sha256').update(json).digest('hex');
// Refuse unsafe graphs BEFORE submit: redacting and then claiming exact capture would be dishonest.
export function assertTraceSafe(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertTraceSafe); return; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/password|api.?key|authorization|cookie|secret|access.?token|auth.?token|headers|credentials|^token$/i.test(key))
        throw new Error('TRACE_SENSITIVE_GRAPH_REJECTED');
      assertTraceSafe(child);
    }
  } else if (typeof value === 'string' && (/data:image\//i.test(value) || /Bearer\s+\S+/i.test(value) ||
    /https?:\/\/[^\s/]+:[^\s/]+@/i.test(value) || /[?&](?:token|api_key|key)=/i.test(value)))
    throw new Error('TRACE_SENSITIVE_GRAPH_REJECTED');
}
export async function captureExecutionTrace(job: any, workflow: {graph: Record<string, any>; version: string}, baseUrl: string) {
  assertTraceSafe(workflow.graph);
  const json = JSON.stringify(workflow.graph);
  if (Buffer.byteLength(json) > 1_000_000) throw new Error('TRACE_GRAPH_TOO_LARGE');
  const snapshot = JSON.parse(job.inputSnapshotJson), facts = graphFacts(workflow.graph), id = randomUUID(), now = Date.now();
  const sources = { sourceType: snapshot.sourceType ?? null, sourceAssetRevision: job.sourceAssetRevision,
    sourceAttachmentId: snapshot.sourceAttachmentId ?? null, sourceArtifactId: snapshot.sourceArtifactId ?? null,
    sourceJobId: snapshot.sourceJobId ?? null, sourceSha256: snapshot.sourceSha256 ?? null, baselineVersion: snapshot.baselineVersion ?? null };
  const references = (snapshot.referenceBindings ?? []).map((r: any) => ({attachmentId: r.attachmentId, sha256: r.sha256, role: r.role}));
  await q('o_v04ExecutionTrace').insert({ id, jobId: job.id, projectId: job.projectId, scriptId: job.scriptId,
    canonicalKey: job.canonicalKey, generationIntent: job.generationIntent, executionPurpose: job.executionPurpose,
    executorType: job.executorType, executorProfile: job.executorProfile, workflowVersion: workflow.version,
    workflowSourceType: 'CODE_GENERATED', workflowGraphHash: graphHash(json), workflowGraphJson: json,
    comfyPromptId: null, parametersJson: JSON.stringify({...facts.parameters, baseUrl}), modelsJson: JSON.stringify(facts.models),
    sourcesJson: JSON.stringify(sources), referencesJson: JSON.stringify(references), outputArtifactIdsJson: '[]',
    status: 'QUEUED', errorCode: null, errorDetail: null, createdAt: now, updatedAt: now });
  return { id, json, hash: graphHash(json) };
}
export async function markTraceSubmitted(id: string, promptId: string) {
  await q('o_v04ExecutionTrace').where({id}).update({comfyPromptId: promptId, status: 'RUNNING', submittedAt: Date.now(), updatedAt: Date.now()});
}
export async function failTrace(id: string, code: string) {
  // Never save upstream messages which can contain credentials or full prompts.
  await q('o_v04ExecutionTrace').where({id}).update({status: 'FAILED', errorCode: code, errorDetail: code,
    completedAt: Date.now(), updatedAt: Date.now()});
}
export async function settleJobTraces(jobId: string) {
  const job = await q('o_v04StudioAssetDraftJob').where({id: jobId}).first();
  if (!job || !['SUCCEEDED', 'FAILED', 'STALE', 'CANCELLED'].includes(job.status)) return;
  await q('o_v04ExecutionTrace').where({jobId}).whereIn('status', ['QUEUED','RUNNING']).update({status: job.status,
    errorCode: job.errorCode, errorDetail: job.errorCode, outputArtifactIdsJson: JSON.stringify(JSON.parse(job.outputsJson).map((a: any) => a.artifactId)),
    completedAt: job.completedAt ?? Date.now(), updatedAt: Date.now()});
}
