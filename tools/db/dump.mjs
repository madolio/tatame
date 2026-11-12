// Análise local de um arquivo .sql de backup (formato do `wrangler d1 export`) e geração de dump SQL a partir de um
// SQLite. Tudo em SQLite temporário em memória; nada aqui acessa banco remoto nem imprime valores das linhas.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { schemaRows, fingerprint, fingerprintHash, isInternal, MIGRATIONS_TABLE, integrityLocal } from './schema.mjs';

export const sha256File = f => createHash('sha256').update(readFileSync(f)).digest('hex');

// Abre um .sql num SQLite em memória. Lança erro se o SQL for inválido.
export function loadSql(text) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }); // checadas depois por foreign_key_check
  try { db.exec(text); } catch (e) { db.close(); throw new Error(`O arquivo de backup não é SQL importável: ${e.message}`); }
  return db;
}

const userTables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(r => r.name).filter(n => !isInternal(n));

// Retrato do banco: contagem por tabela, schema, migrações registradas e integridade. Sem conteúdo das linhas.
export function analyze(db) {
  const counts = {};
  for (const t of userTables(db)) counts[t] = db.prepare(`SELECT count(*) n FROM "${t.replace(/"/g, '""')}"`).get().n;
  const hasMig = db.prepare('SELECT 1 FROM sqlite_schema WHERE type = \'table\' AND name = ?').get(MIGRATIONS_TABLE);
  const migrations = hasMig ? db.prepare(`SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`).all().map(r => r.name) : [];
  const fp = fingerprint(schemaRows(db));
  return { counts, migrations, schema_hash: fingerprintHash(fp), fingerprint: fp, ...integrityLocal(db) };
}

const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

// Dump SQL no mesmo espírito do `wrangler d1 export`: tabelas, linhas, depois índices/triggers/views.
// Inclui d1_migrations (o registro precisa viajar com o backup); omite sqlite_* e _cf_*.
export function dumpSql(db) {
  const objs = db.prepare('SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid').all().filter(o => !/^sqlite_|^_cf_/i.test(o.name));
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const t of objs.filter(o => o.type === 'table')) {
    out.push(t.sql.trim().replace(/;?$/, ';'));
    const cols = db.prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).all().map(c => c.name);
    const q = cols.map(c => `"${c.replace(/"/g, '""')}"`).join(',');
    for (const row of db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}" ORDER BY rowid`).all()) out.push(`INSERT INTO "${t.name}" (${q}) VALUES(${cols.map(c => lit(row[c])).join(',')});`);
  }
  for (const o of objs.filter(o => o.type !== 'table')) out.push(o.sql.trim().replace(/;?$/, ';'));
  return out.join('\n') + '\n';
}
