// Impressão digital e comparação de schema SQLite/D1.
// A fonte é sempre a lista de objetos de sqlite_schema (type, name, tbl_name, sql), que se obtém igual do D1 remoto
// (consulta somente leitura) e de um arquivo local. Os objetos são recriados num SQLite vazio em memória e lidos por
// PRAGMA, então a comparação é por estrutura (colunas, tipos, NOT NULL, defaults, PK, CHECK, FKs, índices),
// não por texto do CREATE (que muda com ALTER TABLE e formatação).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MIGRATIONS_DIR = ROOT + 'db/migrations/';
export const MIGRATIONS_TABLE = 'd1_migrations';
// DDL idêntica à que o wrangler 4.155.0 usa (getCreateMigrationsTableQuery), para o registro ser compatível.
export const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

// Objetos internos ignorados: do SQLite (sqlite_*), do D1 (_cf_*) e o registro de migrações.
export const isInternal = name => /^sqlite_/i.test(name) || /^_cf_/i.test(name) || name === MIGRATIONS_TABLE;

export const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name";

export const migrationFiles = (dir = MIGRATIONS_DIR) => readdirSync(dir).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();

// Lê os objetos de um banco aberto (node:sqlite ou d1shim.raw).
export const schemaRows = raw => raw.prepare(SCHEMA_QUERY).all().map(r => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql }));

function checksOf(sql) {
  const out = []; const re = /CHECK\s*\(/gi; let m;
  while ((m = re.exec(sql))) {
    let d = 1, i = re.lastIndex;
    while (d && i < sql.length) { if (sql[i] === '(') d++; else if (sql[i] === ')') d--; i++; }
    out.push(sql.slice(re.lastIndex, i - 1).replace(/\s+/g, ' ').replace(/\s*([(),=<>])\s*/g, '$1').trim());
  }
  return out.sort();
}
const norm = v => v == null ? null : String(v).replace(/\s+/g, ' ').trim();

// Impressão digital a partir dos objetos: { tables: { nome: { columns, checks, foreign_keys, indexes } } }.
export function fingerprint(rows) {
  const db = new DatabaseSync(':memory:');
  try {
    const user = rows.filter(r => !isInternal(r.name) && r.sql);
    for (const r of user.filter(r => r.type === 'table')) db.exec(r.sql);
    for (const r of user.filter(r => r.type !== 'table')) db.exec(r.sql);
    const tables = {};
    for (const t of user.filter(r => r.type === 'table').sort((a, b) => a.name < b.name ? -1 : 1)) {
      const q = s => db.prepare(s).all();
      const id = t.name.replace(/'/g, "''");
      tables[t.name] = {
        columns: q(`PRAGMA table_xinfo('${id}')`).map(c => ({ name: c.name, type: String(c.type).toUpperCase(), notnull: !!c.notnull, default: norm(c.dflt_value), pk: c.pk })),
        checks: checksOf(t.sql),
        foreign_keys: q(`PRAGMA foreign_key_list('${id}')`).map(f => ({ table: f.table, from: f.from, to: f.to, on_delete: f.on_delete, on_update: f.on_update }))
          .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
        indexes: q(`PRAGMA index_list('${id}')`).filter(i => i.origin === 'c').map(i => {
          const sql = (user.find(r => r.type === 'index' && r.name === i.name) || {}).sql || '';
          const where = /\bWHERE\b([\s\S]*)$/i.exec(sql);
          return { name: i.name, unique: !!i.unique, columns: q(`PRAGMA index_xinfo('${i.name.replace(/'/g, "''")}')`).filter(c => c.key).map(c => `${c.name ?? '<expr>'} ${c.desc ? 'DESC' : 'ASC'}`), where: where ? norm(where[1]) : null };
        }).sort((a, b) => a.name < b.name ? -1 : 1)
      };
    }
    const views = user.filter(r => r.type === 'view' || r.type === 'trigger').map(r => ({ type: r.type, name: r.name, sql: norm(r.sql) })).sort((a, b) => a.name < b.name ? -1 : 1);
    return { tables, others: views };
  } finally { db.close(); }
}

export const fingerprintHash = fp => createHash('sha256').update(JSON.stringify(fp)).digest('hex');

// Diferenças legíveis entre o esperado e o real. Lista vazia = idênticos.
export function diffSchemas(expected, actual) {
  const d = [];
  const E = expected.tables, A = actual.tables;
  for (const t of Object.keys(E)) if (!A[t]) d.push({ kind: 'tabela_ausente', table: t });
  for (const t of Object.keys(A)) if (!E[t]) d.push({ kind: 'tabela_inesperada', table: t });
  for (const t of Object.keys(E).filter(t => A[t])) {
    const e = E[t], a = A[t];
    const ec = new Map(e.columns.map(c => [c.name, c])), ac = new Map(a.columns.map(c => [c.name, c]));
    for (const [n] of ec) if (!ac.has(n)) d.push({ kind: 'coluna_ausente', table: t, column: n });
    for (const [n] of ac) if (!ec.has(n)) d.push({ kind: 'coluna_adicional', table: t, column: n });
    for (const [n, c] of ec) {
      const x = ac.get(n); if (!x) continue;
      for (const k of ['type', 'notnull', 'default', 'pk']) if (JSON.stringify(c[k]) !== JSON.stringify(x[k])) d.push({ kind: `coluna_${k}_diferente`, table: t, column: n, expected: c[k], actual: x[k] });
    }
    if (ec.size === ac.size && [...ec.keys()].every(n => ac.has(n)) && e.columns.map(c => c.name).join() !== a.columns.map(c => c.name).join()) d.push({ kind: 'ordem_de_colunas_diferente', table: t });
    if (JSON.stringify(e.checks) !== JSON.stringify(a.checks)) d.push({ kind: 'check_diferente', table: t, expected: e.checks, actual: a.checks });
    if (JSON.stringify(e.foreign_keys) !== JSON.stringify(a.foreign_keys)) d.push({ kind: 'chave_estrangeira_diferente', table: t, expected: e.foreign_keys, actual: a.foreign_keys });
    const ei = new Map(e.indexes.map(i => [i.name, i])), ai = new Map(a.indexes.map(i => [i.name, i]));
    for (const [n] of ei) if (!ai.has(n)) d.push({ kind: 'indice_ausente', table: t, index: n });
    for (const [n] of ai) if (!ei.has(n)) d.push({ kind: 'indice_adicional', table: t, index: n });
    for (const [n, i] of ei) { const x = ai.get(n); if (x && JSON.stringify(i) !== JSON.stringify(x)) d.push({ kind: 'indice_divergente', table: t, index: n, expected: i, actual: x }); }
  }
  if (JSON.stringify(expected.others) !== JSON.stringify(actual.others)) d.push({ kind: 'views_ou_triggers_diferentes', expected: expected.others.map(o => o.name), actual: actual.others.map(o => o.name) });
  return d;
}

export const describeDiff = x => {
  const where = [x.table, x.column || x.index].filter(Boolean).join('.');
  const extra = 'expected' in x ? ` (esperado ${JSON.stringify(x.expected)}, real ${JSON.stringify(x.actual)})` : '';
  return `${x.kind.replace(/_/g, ' ')}: ${where}${extra}`;
};

// Schema esperado depois de aplicar, num banco vazio, as migrações listadas (por nome de arquivo, na ordem).
export function expectedAfter(names, dir = MIGRATIONS_DIR) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const n of names) db.exec(readFileSync(dir + n, 'utf8'));
    return fingerprint(schemaRows(db));
  } finally { db.close(); }
}

// Verificações de integridade num banco aberto (SQLite local). Remotamente, as mesmas consultas vão pelo wrangler.
export const INTEGRITY_QUERIES = { integrity: 'PRAGMA integrity_check', foreign_keys: 'PRAGMA foreign_key_check' };
export function integrityLocal(raw) {
  const ic = raw.prepare(INTEGRITY_QUERIES.integrity).all();
  const fk = raw.prepare(INTEGRITY_QUERIES.foreign_keys).all();
  return { integrity_ok: ic.length === 1 && Object.values(ic[0])[0] === 'ok', integrity: ic.map(r => Object.values(r)[0]).slice(0, 20), foreign_key_violations: fk.length, foreign_key_sample: fk.slice(0, 5).map(r => ({ table: r.table, parent: r.parent })) };
}
