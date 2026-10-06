import type { Knex } from 'knex';
export async function initializeDirectorABSchema(db: Knex) {
  if (!await db.schema.hasTable('o_v04DirectorAssetAB')) await db.schema.createTable('o_v04DirectorAssetAB', t => {
    t.text('id').primary(); t.bigInteger('projectId').notNullable(); t.integer('scriptId').notNullable();
    t.text('status').notNullable(); t.text('compiledJson').notNullable(); t.text('executionJson').notNullable();
    t.text('evaluationJson').nullable(); t.bigInteger('createdAt').notNullable(); t.bigInteger('updatedAt').notNullable();
    t.index(['projectId','scriptId','createdAt']);
  });
  await db.raw(`CREATE TRIGGER IF NOT EXISTS v04_director_ab_immutable BEFORE UPDATE OF compiledJson,projectId,scriptId,createdAt ON o_v04DirectorAssetAB
    BEGIN SELECT RAISE(ABORT,'DIRECTOR_AB_IMMUTABLE'); END`);
  // Restart never resubmits a possibly accepted Comfy prompt.
  const interrupted=await db('o_v04DirectorAssetAB').whereIn('status',['RENDERING_A','RENDERING_B']);
  for(const row of interrupted){const e=JSON.parse(row.executionJson);
    for(const side of ['A','B'])if(e[side]?.id&&await db.schema.hasTable('o_v04ExecutionTrace'))
      await db('o_v04ExecutionTrace').where({jobId:e[side].id}).whereIn('status',['QUEUED','RUNNING']).update({
        status:'FAILED',errorCode:'EXECUTION_UNCERTAIN',errorDetail:'EXECUTION_UNCERTAIN',completedAt:Date.now(),updatedAt:Date.now()});
  }
  await db('o_v04DirectorAssetAB').whereIn('status',['RENDERING_A','RENDERING_B']).update({
    status:'FAILED',executionJson:db.raw("json_set(executionJson, '$.errorCode', 'EXECUTION_UNCERTAIN')"),updatedAt:Date.now()});
}
