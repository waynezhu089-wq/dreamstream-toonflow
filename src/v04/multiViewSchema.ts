import type {Knex} from 'knex';
export const MULTIVIEW_TABLE='o_v04MultiViewExperiment';
export async function initializeMultiViewSchema(db:Knex){
  if(!await db.schema.hasTable(MULTIVIEW_TABLE))await db.schema.createTable(MULTIVIEW_TABLE,t=>{
    t.text('id').primary();t.bigInteger('projectId').notNullable();t.integer('scriptId').notNullable();
    t.text('status').notNullable();t.text('compiledJson').notNullable();t.text('executionJson').notNullable();
    t.text('evaluationJson');t.bigInteger('createdAt').notNullable();t.bigInteger('updatedAt').notNullable();
    t.index(['projectId','scriptId','createdAt']);
  });
  await db.raw(`CREATE TRIGGER IF NOT EXISTS v04_multiview_immutable BEFORE UPDATE OF compiledJson,projectId,scriptId,createdAt ON ${MULTIVIEW_TABLE}
    BEGIN SELECT RAISE(ABORT,'MULTIVIEW_IMMUTABLE'); END`);
  // Recovery records uncertainty; it never resubmits a possibly accepted prompt.
  const rows=await db(MULTIVIEW_TABLE).whereIn('status',['RENDERING_SIDE','RENDERING_BACK']);
  for(const r of rows){const e=JSON.parse(r.executionJson);for(const side of ['SIDE','BACK']){
    if(e[side]?.status==='RUNNING'){e[side].status='FAILED';e[side].errorCode='EXECUTION_UNCERTAIN';
      if(await db.schema.hasTable('o_v04ExecutionTrace'))await db('o_v04ExecutionTrace').where({jobId:e[side].id,status:'RUNNING'}).update({status:'FAILED',errorCode:'EXECUTION_UNCERTAIN',errorDetail:'EXECUTION_UNCERTAIN',completedAt:Date.now(),updatedAt:Date.now()});}
    else if(e[side]?.status==='QUEUED')e[side].status='NOT_RUN';
  }e.errorCode='EXECUTION_UNCERTAIN';await db(MULTIVIEW_TABLE).where({id:r.id}).update({status:e.SIDE?.artifact||e.BACK?.artifact?'PARTIAL':'FAILED',executionJson:JSON.stringify(e),updatedAt:Date.now()});}
}
