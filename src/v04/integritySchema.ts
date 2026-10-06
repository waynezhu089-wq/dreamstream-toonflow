import type {Knex} from 'knex';
export const INTEGRITY_TABLE='o_v04AssetIntegrity';
export async function initializeIntegritySchema(db:Knex){
 if(!await db.schema.hasTable(INTEGRITY_TABLE))await db.schema.createTable(INTEGRITY_TABLE,t=>{t.text('id').primary();t.text('experimentId').notNullable();t.bigInteger('projectId').notNullable();t.integer('scriptId').notNullable();t.text('inputJson').notNullable();t.text('reportJson').notNullable();t.integer('actorUserId').notNullable();t.bigInteger('createdAt').notNullable();t.index(['projectId','scriptId','experimentId','createdAt']);});
 await db.raw(`CREATE TRIGGER IF NOT EXISTS v04_integrity_immutable_update BEFORE UPDATE ON ${INTEGRITY_TABLE} BEGIN SELECT RAISE(ABORT,'INTEGRITY_IMMUTABLE'); END`);
 await db.raw(`CREATE TRIGGER IF NOT EXISTS v04_integrity_immutable_delete BEFORE DELETE ON ${INTEGRITY_TABLE} BEGIN SELECT RAISE(ABORT,'INTEGRITY_IMMUTABLE'); END`);
}
