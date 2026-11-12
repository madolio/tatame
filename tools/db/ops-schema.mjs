// Operações de schema: check, baseline (comparação com 17f1fbd) e baseline-register (registro explícito de 000_base).
import { registerOp, GuardError } from './cli.mjs';
import { openSource } from './source.mjs';
import { SCHEMA_QUERY, MIGRATIONS_TABLE, MIGRATIONS_TABLE_DDL, INTEGRITY_QUERIES, fingerprint, fingerprintHash, diffSchemas, describeDiff, expectedAfter, migrationFiles } from './schema.mjs';

export const BASE = '000_base.sql';

// Estado do banco: objetos de schema, migrações registradas e integridade. Só leitura.
export function readState(src) {
  const rows = src.query(SCHEMA_QUERY);
  const hasTable = rows.some(r => r.type === 'table' && r.name === MIGRATIONS_TABLE);
  const applied = hasTable ? src.query(`SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`).map(r => r.name) : [];
  return { rows, hasMigrationsTable: hasTable, applied, userTables: rows.filter(r => r.type === 'table' && !/^sqlite_|^_cf_/i.test(r.name) && r.name !== MIGRATIONS_TABLE).length };
}
export function readIntegrity(src) {
  const ic = src.query(INTEGRITY_QUERIES.integrity).map(r => Object.values(r)[0]);
  const fk = src.query(INTEGRITY_QUERIES.foreign_keys);
  return { integrity_ok: ic.length === 1 && ic[0] === 'ok', integrity: ic.slice(0, 20), foreign_key_violations: fk.length, foreign_key_tables: [...new Set(fk.map(r => r.table))] };
}

// Linha de base: o schema real deve ser IDÊNTICO ao de 000_base.sql (= 17f1fbd) e não pode haver registro de migrações.
export function baselineReport(state) {
  const expected = expectedAfter([BASE]);
  const actual = fingerprint(state.rows);
  const diffs = diffSchemas(expected, actual);
  const later = ['password_resets', 'audit_log'].filter(t => actual.tables[t]).concat(actual.tables.lessons?.columns.some(c => c.name === 'roll_called') ? ['lessons.roll_called'] : []);
  let verdict, message;
  if (state.applied.length) { verdict = 'ja_registrada'; message = `O banco já tem migrações registradas (${state.applied.join(', ')}). Não há linha de base a registrar.`; }
  else if (!state.userTables) { verdict = 'banco_vazio'; message = 'Banco vazio: não precisa de linha de base; use migrate, que aplica 000, 001 e 002.'; }
  else if (!diffs.length) { verdict = 'identica'; message = 'Schema idêntico ao de 17f1fbd (000_base.sql). A linha de base PODE ser registrada com baseline-register.'; }
  else if (later.length) { verdict = 'contem_alteracoes_posteriores'; message = `O banco já contém estruturas de migrações posteriores sem registro (${later.join(', ')}). Alguém aplicou à mão. PARE: decisão humana necessária.`; }
  else { verdict = 'divergente'; message = 'O schema real difere do de 17f1fbd. PARE: não registre a linha de base; analise as diferenças.'; }
  return { verdict, can_register: verdict === 'identica', message, differences: diffs, expected_hash: fingerprintHash(expected), actual_hash: fingerprintHash(actual), has_migrations_table: state.hasMigrationsTable, applied: state.applied };
}

function printReport(out, rep) {
  out(`[baseline] veredito: ${rep.verdict}`);
  out(`[baseline] ${rep.message}`);
  out(`[baseline] impressão digital esperada ${rep.expected_hash.slice(0, 16)}… real ${rep.actual_hash.slice(0, 16)}…`);
  if (rep.differences.length) { out(`[baseline] ${rep.differences.length} diferença(s):`); for (const d of rep.differences) out('  - ' + describeDiff(d)); }
}

// check: compara com o esperado para as migrações REGISTRADAS e verifica integridade. Não altera nada.
export function checkReport(state, integrity) {
  const files = migrationFiles();
  const unknown = state.applied.filter(n => !files.includes(n));
  const outOfOrder = state.applied.some((n, i) => n !== files[i]);
  const expected = unknown.length || outOfOrder ? null : expectedAfter(state.applied.length ? state.applied : [BASE]);
  const actual = fingerprint(state.rows);
  const diffs = expected ? diffSchemas(expected, actual) : [];
  const problems = [];
  if (unknown.length) problems.push(`migrações registradas que não existem no repositório: ${unknown.join(', ')}`);
  else if (outOfOrder) problems.push(`registro de migrações fora da ordem dos arquivos: ${state.applied.join(', ')}`);
  if (!state.applied.length && state.userTables) problems.push('banco sem registro de migrações (linha de base não registrada)');
  if (diffs.length) problems.push(`${diffs.length} diferença(s) de schema em relação ao esperado`);
  if (!integrity.integrity_ok) problems.push('PRAGMA integrity_check não retornou ok');
  if (integrity.foreign_key_violations) problems.push(`${integrity.foreign_key_violations} violação(ões) de chave estrangeira em ${integrity.foreign_key_tables.join(', ')}`);
  return { ok: problems.length === 0, problems, differences: diffs, applied: state.applied, pending: files.filter(f => !state.applied.includes(f)), integrity, schema_hash: fingerprintHash(actual) };
}

registerOp('check', async ctx => {
  const src = openSource(ctx);
  try {
    if (src.dryRun) { src.query(SCHEMA_QUERY); return 0; }
    const rep = checkReport(readState(src), readIntegrity(src));
    ctx.deps.out(`[check] migrações registradas: ${rep.applied.join(', ') || '(nenhuma)'} | pendentes: ${rep.pending.join(', ') || '(nenhuma)'}`);
    ctx.deps.out(`[check] integrity_check: ${rep.integrity.integrity_ok ? 'ok' : 'FALHOU'} | violações de FK: ${rep.integrity.foreign_key_violations} | schema ${rep.schema_hash.slice(0, 16)}…`);
    for (const d of rep.differences) ctx.deps.out('  - ' + describeDiff(d));
    ctx.deps.out(rep.ok ? '[check] OK' : `[check] PROBLEMAS: ${rep.problems.join('; ')}`);
    return rep.ok ? 0 : 4;
  } finally { src.close(); }
});

registerOp('baseline', async ctx => {
  const src = openSource(ctx);
  try {
    if (src.dryRun) { src.query(SCHEMA_QUERY); return 0; }
    const rep = baselineReport(readState(src));
    printReport(ctx.deps.out, rep);
    return rep.can_register ? 0 : 4;
  } finally { src.close(); }
});

// Registro explícito da linha de base: refaz a comparação na hora; só registra se idêntica e sem registro prévio.
// Grava exatamente o que o wrangler gravaria ao aplicar 000_base.sql, mas SEM executar o conteúdo dela.
registerOp('baseline-register', async ctx => {
  if (ctx.opts['confirm-baseline'] !== BASE) throw new GuardError(`Registrar a linha de base exige --confirm-baseline=${BASE} (depois de rodar baseline e conferir o relatório).`);
  const src = openSource(ctx);
  try {
    if (src.dryRun) { src.query(SCHEMA_QUERY); ctx.deps.out('[baseline] simulação: nada registrado.'); return 0; }
    const rep = baselineReport(readState(src));
    printReport(ctx.deps.out, rep);
    if (!rep.can_register) throw new GuardError('Linha de base NÃO registrada: ' + rep.message);
    src.exec(`${MIGRATIONS_TABLE_DDL}\nINSERT INTO "${MIGRATIONS_TABLE}" (name) values ('${BASE}');`);
    const after = readState(src);
    if (after.applied.join() !== BASE) throw new Error(`Registro inesperado depois da gravação: ${after.applied.join(', ')}`);
    ctx.deps.out(`[baseline] registrada: ${BASE}. Próximo passo: migrate (aplica 001 e 002).`);
    return 0;
  } finally { src.close(); }
});
