// Read only. The launcher must never infer an owner ID from account order.
const Database = require('better-sqlite3');
const db = new Database(process.env.V04_OWNER_DB_PATH, { readonly: true, fileMustExist: true });
try {
  const ids = db.prepare('SELECT id FROM o_user ORDER BY id LIMIT 2').all().map(row => row.id);
  if (ids.length === 1) process.stdout.write(String(ids[0]));
} finally {
  db.close();
}
