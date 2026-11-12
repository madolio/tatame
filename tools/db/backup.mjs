// Backup e restauração, em operações separadas:
//   export        D1 remoto -> arquivo .sql + manifesto, gravados no armazenamento (só leitura no banco)
//   verify        offline: hash, import em SQLite temporário, integrity_check, foreign_key_check, contagens, schema
//   anonymize     offline: cópia anonimizada de um backup verificado (para staging)
//   import        backup verificado -> staging ou restore-test (nunca produção)
//   restore-test  import no restore-test + reexportação + validação com o Worker real
// O Time Travel NÃO é automatizado aqui (é destrutivo e no próprio banco): ver docs/operacao-banco.md.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerOp, GuardError, ROOT } from './cli.mjs';
import { openSource, remoteArgs, rowsFromWranglerJson } from './source.mjs';
import { createStorage } from '../backup/storage.mjs';
import { loadSql, analyze, sha256File, dumpSql } from './dump.mjs';
import { expectedAfter, fingerprintHash, isInternal } from './schema.mjs';
import { anonymize, leakCount } from './anonymize.mjs';
import { workerCheck } from './worker-check.mjs';

export const MANIFEST_VERSION = 1;
const tmpDir = () => mkdtempSync(join(tmpdir(), 'tatame-backup-'));
function gitCommit() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    return dirty ? head + '+alterações-locais' : head;
  } catch { return 'desconhecido'; }
}

// Manifesto a partir do conteúdo REAL do arquivo (não do que o comando disse ter feito).
export function buildManifest(sqlFile, { source_env, source_database, wrangler, anonymized = false, derived_from = null, created_at = new Date().toISOString() }) {
  const db = loadSql(readFileSync(sqlFile, 'utf8'));
  try {
    const a = analyze(db);
    if (!a.integrity_ok) throw new Error('O arquivo exportado não passa no integrity_check.');
    return { manifest_version: MANIFEST_VERSION, source_env, source_database, created_at, migrations: a.migrations, schema_hash: a.schema_hash, counts: a.counts,
      sha256: sha256File(sqlFile), wrangler, commit: gitCommit(), anonymized, derived_from, contains_personal_data: !anonymized };
  } finally { db.close(); }
}

// Verificação completa de um backup. Devolve { ok, problems, checks } sem nenhum valor das linhas.
export function verifyBackup(sqlFile, manifest) {
  const problems = [], checks = {};
  if (!manifest || manifest.manifest_version !== MANIFEST_VERSION) return { ok: false, problems: ['manifesto ausente ou de versão desconhecida'], checks };
  checks.hash = sha256File(sqlFile) === manifest.sha256;
  if (!checks.hash) problems.push('SHA-256 do arquivo não confere com o manifesto (arquivo alterado ou corrompido)');
  let db;
  try { db = loadSql(readFileSync(sqlFile, 'utf8')); checks.import = true; }
  catch (e) { checks.import = false; problems.push(e.message); return { ok: false, problems, checks }; }
  try {
    const a = analyze(db);
    checks.integrity = a.integrity_ok; if (!a.integrity_ok) problems.push('PRAGMA integrity_check não retornou ok');
    checks.foreign_keys = a.foreign_key_violations === 0; if (!checks.foreign_keys) problems.push(`${a.foreign_key_violations} violação(ões) de chave estrangeira`);
    const tables = new Set([...Object.keys(a.counts), ...Object.keys(manifest.counts || {})]);
    const countDiff = [...tables].filter(t => a.counts[t] !== manifest.counts?.[t]);
    checks.counts = countDiff.length === 0; if (!checks.counts) problems.push(`contagem diferente do manifesto em: ${countDiff.join(', ')}`);
    checks.schema_manifest = a.schema_hash === manifest.schema_hash; if (!checks.schema_manifest) problems.push('impressão digital do schema diferente da do manifesto');
    checks.migrations = JSON.stringify(a.migrations) === JSON.stringify(manifest.migrations); if (!checks.migrations) problems.push('migrações registradas no arquivo diferem do manifesto');
    let expected = null;
    try { expected = fingerprintHash(expectedAfter(a.migrations.length ? a.migrations : ['000_base.sql'])); } catch { problems.push('migrações registradas no backup não existem neste repositório'); }
    checks.schema_expected = expected !== null && expected === a.schema_hash; if (expected && !checks.schema_expected) problems.push('schema do backup diferente do esperado para as migrações registradas');
    return { ok: problems.length === 0, problems, checks, migrations: a.migrations, counts: a.counts };
  } finally { db.close(); }
}

const printVerify = (out, v) => {
  out(`[verify] hash ${v.checks.hash ? 'ok' : 'FALHOU'} | import ${v.checks.import ? 'ok' : 'FALHOU'} | integrity ${v.checks.integrity ? 'ok' : v.checks.integrity === undefined ? '-' : 'FALHOU'} | FKs ${v.checks.foreign_keys ? 'ok' : v.checks.foreign_keys === undefined ? '-' : 'FALHOU'} | contagens ${v.checks.counts ? 'ok' : v.checks.counts === undefined ? '-' : 'FALHOU'} | schema ${v.checks.schema_manifest && v.checks.schema_expected ? 'ok' : v.checks.schema_manifest === undefined ? '-' : 'FALHOU'}`);
  if (!v.ok) for (const p of v.problems) out('  - ' + p);
};

// Backup a partir de --backup <id> (armazenamento) ou --file <sql> --manifest <json> (arquivo avulso).
function resolveBackup(ctx) {
  const { opts } = ctx;
  if (opts.backup && opts.backup !== true) { const s = createStorage(ctx.deps.env || process.env); return { ...s.get(String(opts.backup)), storage: s }; }
  if (opts.file && opts.manifest && opts.file !== true && opts.manifest !== true) return { sqlPath: String(opts.file), manifest: JSON.parse(readFileSync(String(opts.manifest), 'utf8')), storage: null };
  throw new GuardError('Informe o backup com --backup <id> (do armazenamento) ou --file <backup.sql> --manifest <manifest.json>.');
}

registerOp('verify', async ctx => {
  const b = resolveBackup(ctx);
  const v = verifyBackup(b.sqlPath, b.manifest);
  printVerify(ctx.deps.out, v);
  ctx.deps.out(v.ok ? `[verify] backup íntegro e importável (${Object.values(v.counts).reduce((a, n) => a + n, 0)} linhas em ${Object.keys(v.counts).length} tabelas). Isso ainda não é um teste de restauração: use restore-test.` : '[verify] BACKUP REPROVADO');
  return v.ok ? 0 : 4;
});

registerOp('export', async ctx => {
  const { target, deps, opts } = ctx;
  const storage = opts['dry-run'] ? null : createStorage(deps.env || process.env); // falha antes de qualquer comando se não houver destino válido
  const dir = tmpDir();
  try {
    const file = join(dir, 'export.sql');
    const r = ctx.wrangler(['d1', 'export', target.database_name, ...remoteArgs(target), '--output', file, '--skip-confirmation']);
    if (r.dryRun) return 0;
    // staging só recebe backups anonimizados (checkImportAllowed), então o que sai dele também é anonimizado.
    const manifest = buildManifest(file, { source_env: target.name, source_database: target.database_name, wrangler: ctx.version, anonymized: target.name === 'staging' });
    const v = verifyBackup(file, manifest);
    printVerify(deps.out, v);
    if (!v.ok) throw new Error('O export não passou na verificação; nada foi gravado no armazenamento.');
    const id = storage.put(file, manifest);
    deps.out(`[export] backup ${id} gravado e verificado (${manifest.migrations.join(', ') || 'sem registro de migrações'}). ${manifest.contains_personal_data ? 'CONTÉM DADOS PESSOAIS.' : ''}`);
    return 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

registerOp('anonymize', async ctx => {
  const b = resolveBackup(ctx);
  if (!b.storage) throw new GuardError('anonymize grava no armazenamento: use --backup <id>.');
  if (b.manifest.anonymized) throw new GuardError('Este backup já é anonimizado.');
  const v = verifyBackup(b.sqlPath, b.manifest);
  printVerify(ctx.deps.out, v);
  if (!v.ok) throw new GuardError('Só se anonimiza um backup que passou na verificação.');
  const dir = tmpDir();
  try {
    const db = loadSql(readFileSync(b.sqlPath, 'utf8'));
    let res, text;
    try { res = anonymize(db); text = dumpSql(db); } finally { db.close(); }
    const leaks = leakCount(text, res.sensitive);
    if (leaks) throw new Error(`${leaks} valor(es) pessoal(is) original(is) ainda aparece(m) no resultado; nada foi gravado.`);
    const file = join(dir, 'anon.sql'); writeFileSync(file, text);
    const manifest = buildManifest(file, { source_env: b.manifest.source_env, source_database: b.manifest.source_database, wrangler: b.manifest.wrangler, anonymized: true, derived_from: b.manifest.id });
    const v2 = verifyBackup(file, manifest);
    if (!v2.ok) throw new Error('A cópia anonimizada não passou na verificação: ' + v2.problems.join('; '));
    for (const t of Object.keys(manifest.counts)) if (!['auth_sessions', 'login_attempts', 'password_resets', 'settings'].includes(t) && manifest.counts[t] !== b.manifest.counts[t]) throw new Error(`A anonimização mudou a quantidade de linhas de ${t}.`);
    const id = b.storage.put(file, manifest);
    for (const [t, s] of Object.entries(res.summary)) ctx.deps.out(`[anonymize] ${t}: ${s}`);
    ctx.deps.out(`[anonymize] backup anonimizado ${id} gravado e verificado; nenhum valor pessoal original encontrado no resultado.`);
    return 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Regras de origem × destino: backup com dados pessoais reais nunca vai para staging; para o restore-test só com
// autorização específica (--confirm-personal-data=<id do backup> e terminal interativo).
export function checkImportAllowed(manifest, destName, opts, isTTY) {
  const personal = manifest.contains_personal_data !== false || !manifest.anonymized;
  const fromProd = manifest.source_env === 'production';
  if (destName === 'staging' && (personal || fromProd && !manifest.anonymized)) throw new GuardError('Backup com dados pessoais (não anonimizado) não pode ser importado em staging. Use anonymize antes.');
  if (destName === 'restore-test' && personal) {
    if (opts['confirm-personal-data'] !== manifest.id) throw new GuardError(`Este backup contém dados pessoais reais. Importá-lo no restore-test exige autorização específica: --confirm-personal-data=${manifest.id || '<id do backup>'}.`);
    if (!isTTY) throw new GuardError('Importar dados pessoais reais exige terminal interativo.');
  }
}

async function importInto(ctx, b) {
  const { target, opts, deps } = ctx;
  if (opts['confirm-destination'] !== target.database_name) throw new GuardError(`Confirme o destino com --confirm-destination=${target.database_name}.`);
  checkImportAllowed(b.manifest, target.name, opts, deps.isTTY());
  const v = verifyBackup(b.sqlPath, b.manifest);
  printVerify(deps.out, v);
  if (!v.ok) throw new GuardError('Backup reprovado na verificação; nada foi importado.');
  if (ctx.opts['dry-run']) { ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--file', b.sqlPath, '--yes']); return null; }
  const src = openSource(ctx);
  const existing = src.query("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid");
  if (existing.length) {
    if (!opts.replace) throw new GuardError(`O banco de destino ${target.database_name} não está vazio (${existing.length} objeto(s)). Use --replace para apagá-lo antes de importar.`);
    const drop = existing.filter(o => o.type !== 'table').map(o => `DROP ${o.type.toUpperCase()} IF EXISTS "${o.name}";`)
      .concat('PRAGMA defer_foreign_keys = TRUE;', ...existing.filter(o => o.type === 'table').reverse().map(o => `DROP TABLE IF EXISTS "${o.name}";`)); // filhas antes das pais (ordem inversa da criação): o D1 não permite desligar foreign_keys
    src.exec(drop.join('\n'));
    deps.out(`[import] ${existing.length} objeto(s) removido(s) de ${target.database_name} (--replace).`);
  }
  ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--file', b.sqlPath, '--yes']);
  // conferência no banco de destino
  const counts = {};
  for (const t of Object.keys(b.manifest.counts)) counts[t] = src.query(`SELECT count(*) n FROM "${t}"`)[0]?.n;
  const diff = Object.keys(b.manifest.counts).filter(t => counts[t] !== b.manifest.counts[t]);
  if (diff.length) throw new Error(`Depois do import, contagens diferentes do manifesto em: ${diff.join(', ')}`);
  deps.out(`[import] ${target.database_name}: contagens iguais às do manifesto em ${Object.keys(counts).length} tabelas.`);
  return counts;
}

registerOp('import', async ctx => {
  const b = resolveBackup(ctx);
  await importInto(ctx, b);
  return 0;
});

registerOp('restore-test', async ctx => {
  const b = resolveBackup(ctx);
  let res;
  try { res = await importInto(ctx, b); }
  catch (e) {
    // Recusas (GuardError) não começaram a restauração; falhas depois de começar ficam registradas como reprovação.
    if (!(e instanceof GuardError) && b.storage) b.storage.updateManifest(b.manifest.id, { restore_test: { at: new Date().toISOString(), database: ctx.target.database_name, ok: false, erro: e.message.slice(0, 200) } });
    throw e;
  }
  if (res === null) return 0; // dry-run
  const dir = tmpDir();
  try {
    // Reexporta o que ficou no banco restaurado e compara com o backup original (ida e volta).
    const file = join(dir, 'roundtrip.sql');
    ctx.wrangler(['d1', 'export', ctx.target.database_name, ...remoteArgs(ctx.target), '--output', file, '--skip-confirmation']);
    const db = loadSql(readFileSync(file, 'utf8'));
    let a; try { a = analyze(db); } finally { db.close(); }
    const problems = [];
    if (!a.integrity_ok || a.foreign_key_violations) problems.push('banco restaurado falhou em integrity_check/foreign_key_check');
    if (a.schema_hash !== b.manifest.schema_hash) problems.push('schema do banco restaurado difere do backup');
    const diff = Object.keys(b.manifest.counts).filter(t => a.counts[t] !== b.manifest.counts[t]);
    if (diff.length) problems.push(`contagens diferentes após a restauração: ${diff.join(', ')}`);
    const w = await workerCheck(readFileSync(file, 'utf8'));
    for (const n of w.notes) ctx.deps.out('[restore-test] ' + n);
    if (!w.ok) problems.push(...w.problems);
    const result = { at: new Date().toISOString(), database: ctx.target.database_name, ok: problems.length === 0, worker: w.stats || null };
    if (b.storage) b.storage.updateManifest(b.manifest.id, { restore_test: result });
    if (problems.length) { for (const p of problems) ctx.deps.out('  - ' + p); ctx.deps.out('[restore-test] RESTAURAÇÃO REPROVADA'); return 4; }
    ctx.deps.out(`[restore-test] OK: restaurado em ${ctx.target.database_name}, ida e volta idêntica, Worker real respondeu e conferiu ${w.stats.compared_fields} campos com a referência independente (0 divergências).`);
    return 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Restauração local (sem rede): mesma validação do restore-test, para os testes e para ensaios offline.
export async function restoreLocal(sqlFile, manifest) {
  const v = verifyBackup(sqlFile, manifest);
  if (!v.ok) return { ok: false, problems: v.problems };
  const w = await workerCheck(readFileSync(sqlFile, 'utf8'));
  return { ok: w.ok, problems: w.problems, notes: w.notes, stats: w.stats };
}
export { isInternal, rowsFromWranglerJson };
