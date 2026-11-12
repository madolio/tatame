// Backup e restauração, em operações separadas:
//   export        D1 remoto -> .sql temporário -> verificação -> contêiner CRIPTOGRAFADO (.tbk) no armazenamento
//   verify        offline: autentica e descriptografa, depois hash, import em SQLite temporário, integridade, contagens, schema
//   anonymize     offline: abre um backup verificado e grava uma cópia anonimizada, também criptografada
//   import        backup autenticado e verificado -> staging ou restore-test (nunca produção)
//   restore-test  import no restore-test + reexportação + validação com o Worker real
// O Time Travel NÃO é automatizado aqui (é destrutivo e no próprio banco): ver docs/operacao-banco.md.
//
// Integridade × autenticidade: o SHA-256 do .sql (no manifesto) só detecta corrupção acidental; qualquer um pode
// recalculá-lo. Quem prova autenticidade é a tag AES-256-GCM, que cobre conteúdo, manifesto e cabeçalho e só
// pode ser produzida com a chave. Por isso o conteúdo só é usado depois da autenticação (tools/backup/crypto.mjs).
//
// Texto puro existe apenas na área temporária de tools/backup/tempspace.mjs (aleatória, 0700/0600, marcada),
// apagada assim que possível, em sucesso, em erro e em interrupção tratável.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { registerOp, GuardError, ROOT } from './cli.mjs';
import { openSource, remoteArgs, rowsFromWranglerJson } from './source.mjs';
import { createStorage } from '../backup/storage.mjs';
import { encrypt, decrypt, loadKey, assertSameManifest, BackupCryptoError, FORMAT_VERSION } from '../backup/crypto.mjs';
import { loadSql, analyze, dumpSql } from './dump.mjs';
import { expectedAfter, fingerprintHash, isInternal } from './schema.mjs';
import { anonymize, leakReport } from './anonymize.mjs';
import { workspace, WORK_PREFIX, scanResidue, cleanResidue, redact } from '../backup/tempspace.mjs';
import { workerCheck } from './worker-check.mjs';

export const MANIFEST_VERSION = 2; // v2: backup em contêiner TATAMEBK v1; estado operacional fora do manifesto
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
function gitCommit() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    return dirty ? head + '+alterações-locais' : head;
  } catch { return 'desconhecido'; }
}

export { workspace, WORK_PREFIX };
// Aviso (sem apagar nada) quando há resíduos de operações interrompidas.
const warnResidue = out => { const a = scanResidue().filter(r => r.status !== 'ativo'); if (a.length) out(`[aviso] ${a.length} área(s) temporária(s) de backup deixada(s) por operação interrompida (podem conter SQL em claro). Rode: node tools/db.mjs temp-clean`); };

// Manifesto a partir do conteúdo REAL (não do que um comando disse ter feito). Sem nenhum valor das linhas.
export function buildManifest(sqlText, { source_env, source_database, wrangler, anonymized = false, derived_from = null, created_at = new Date().toISOString() }) {
  const db = loadSql(sqlText);
  try {
    const a = analyze(db);
    if (!a.integrity_ok) throw new Error('O conteúdo exportado não passa no integrity_check.');
    return { manifest_version: MANIFEST_VERSION, container: { format: 'TATAMEBK', version: FORMAT_VERSION, algorithm: 'AES-256-GCM' },
      source_env, source_database, created_at, migrations: a.migrations, schema_hash: a.schema_hash, counts: a.counts,
      sha256: sha256(Buffer.from(sqlText, 'utf8')), wrangler, commit: gitCommit(), anonymized, derived_from, contains_personal_data: !anonymized };
  } finally { db.close(); }
}

// Verificação do CONTEÚDO já autenticado. Devolve { ok, problems, checks } sem nenhum valor das linhas.
export function verifyContent(sqlText, manifest) {
  const problems = [], checks = {};
  if (!manifest || manifest.manifest_version !== MANIFEST_VERSION) return { ok: false, problems: ['manifesto ausente ou de versão desconhecida'], checks };
  checks.hash = sha256(Buffer.from(sqlText, 'utf8')) === manifest.sha256;
  if (!checks.hash) problems.push('SHA-256 do conteúdo não confere com o manifesto autenticado');
  let db;
  try { db = loadSql(sqlText); checks.import = true; }
  catch (e) { checks.import = false; problems.push(e.message); return { ok: false, problems, checks }; }
  try {
    const a = analyze(db);
    checks.integrity = a.integrity_ok; if (!a.integrity_ok) problems.push('PRAGMA integrity_check não retornou ok');
    checks.foreign_keys = a.foreign_key_violations === 0; if (!checks.foreign_keys) problems.push(`${a.foreign_key_violations} violação(ões) de chave estrangeira`);
    const tables = new Set([...Object.keys(a.counts), ...Object.keys(manifest.counts || {})]);
    const countDiff = [...tables].filter(t => a.counts[t] !== manifest.counts?.[t]);
    checks.counts = countDiff.length === 0; if (!checks.counts) problems.push(`contagem diferente do manifesto em: ${countDiff.join(', ')}`);
    checks.schema_manifest = a.schema_hash === manifest.schema_hash; if (!checks.schema_manifest) problems.push('impressão digital do schema diferente da do manifesto');
    checks.migrations = JSON.stringify(a.migrations) === JSON.stringify(manifest.migrations); if (!checks.migrations) problems.push('migrações registradas no conteúdo diferem do manifesto');
    let expected = null;
    try { expected = fingerprintHash(expectedAfter(a.migrations.length ? a.migrations : ['000_base.sql'])); } catch { problems.push('migrações registradas no backup não existem neste repositório'); }
    checks.schema_expected = expected !== null && expected === a.schema_hash; if (expected && !checks.schema_expected) problems.push('schema do backup diferente do esperado para as migrações registradas');
    return { ok: problems.length === 0, problems, checks, migrations: a.migrations, counts: a.counts };
  } finally { db.close(); }
}

// Abre um contêiner: autentica e descriptografa ANTES de qualquer uso; confere o manifesto externo, se houver.
// Lança BackupCryptoError (chave ausente/incorreta, formato, autenticação, manifesto externo) sem liberar conteúdo.
export function openBox(boxBuffer, key, externalManifest = null) {
  const { plain, manifest } = decrypt(boxBuffer, key);
  if (externalManifest) assertSameManifest(externalManifest, manifest);
  return { sqlText: plain.toString('utf8'), manifest };
}

// Autentica + verifica. É o único caminho para obter conteúdo utilizável de um backup.
export function openVerified(boxBuffer, key, externalManifest = null) {
  const { sqlText, manifest } = openBox(boxBuffer, key, externalManifest);
  const v = verifyContent(sqlText, manifest);
  return { sqlText, manifest, verification: v };
}

export function sealBackup(sqlText, manifest, key) { return encrypt(Buffer.from(sqlText, 'utf8'), manifest, key); }

const printVerify = (out, v) => {
  const s = k => v.checks[k] === undefined ? '-' : v.checks[k] ? 'ok' : 'FALHOU';
  out(`[verify] autenticação ok | hash ${s('hash')} | import ${s('import')} | integrity ${s('integrity')} | FKs ${s('foreign_keys')} | contagens ${s('counts')} | schema ${v.checks.schema_manifest && v.checks.schema_expected ? 'ok' : s('schema_manifest') === '-' ? '-' : 'FALHOU'}`);
  if (!v.ok) for (const p of v.problems) out('  - ' + p);
};

// Backup por --backup <id> (armazenamento) ou --file <backup.tbk> (contêiner avulso; o manifesto está dentro dele).
function resolveBackup(ctx) {
  const { opts } = ctx;
  if (opts.backup && opts.backup !== true) { const s = createStorage(ctx.deps.env || process.env); const g = s.get(String(opts.backup)); return { box: readFileSync(g.boxPath), external: g.manifest, id: g.manifest.id, storage: s }; }
  if (opts.file && opts.file !== true) return { box: readFileSync(String(opts.file)), external: null, id: null, storage: null };
  throw new GuardError('Informe o backup com --backup <id> (do armazenamento) ou --file <backup.tbk>.');
}
const keyOf = ctx => loadKey(ctx.deps.env || process.env);
const authenticated = (b, key) => { try { return openVerified(b.box, key, b.external); } catch (e) { if (e instanceof BackupCryptoError) throw new GuardError(e.message); throw e; } };

registerOp('verify', async ctx => {
  const b = resolveBackup(ctx);
  const o = authenticated(b, keyOf(ctx));
  printVerify(ctx.deps.out, o.verification);
  const v = o.verification;
  ctx.deps.out(v.ok ? `[verify] backup autêntico, íntegro e importável (${Object.values(v.counts).reduce((a, n) => a + n, 0)} linhas em ${Object.keys(v.counts).length} tabelas). Isso ainda não é um teste de restauração: use restore-test.` : '[verify] BACKUP REPROVADO');
  return v.ok ? 0 : 4;
});

registerOp('export', async ctx => {
  const { target, deps, opts } = ctx;
  // Chave e destino são exigidos ANTES de qualquer comando remoto (falha fechada).
  const key = opts['dry-run'] ? null : keyOf(ctx);
  const storage = opts['dry-run'] ? null : createStorage(deps.env || process.env);
  warnResidue(deps.out);
  const ws = workspace();
  try {
    const file = ws.path('export');
    const r = ctx.wrangler(['d1', 'export', target.database_name, ...remoteArgs(target), '--output', file, '--skip-confirmation']);
    if (r.dryRun) return 0;
    const sqlText = ws.read(file); ws.discard(file);                 // texto puro sai do disco assim que lido
    // staging só recebe backups anonimizados (checkImportAllowed), então o que sai dele também é anonimizado.
    const manifest = buildManifest(sqlText, { source_env: target.name, source_database: target.database_name, wrangler: ctx.version, anonymized: target.name === 'staging' });
    const v = verifyContent(sqlText, manifest);
    printVerify(deps.out, v);
    if (!v.ok) throw new Error('O export não passou na verificação; nada foi gravado no armazenamento.');
    const box = ws.write('backup', sealBackup(sqlText, manifest, key), 'tbk');
    // prova de que o contêiner gravado abre com a chave antes de considerá-lo um backup
    if (!openVerified(readFileSync(box), key).verification.ok) throw new Error('O contêiner criptografado não reabriu corretamente; nada foi gravado.');
    const id = storage.put(box, manifest);
    deps.out(`[export] backup ${id} gravado (criptografado, AES-256-GCM) e verificado. ${manifest.contains_personal_data ? 'CONTÉM DADOS PESSOAIS.' : ''}`);
    return 0;
  } finally { ws.cleanup(); }
});

registerOp('anonymize', async ctx => {
  const b = resolveBackup(ctx);
  if (!b.storage) throw new GuardError('anonymize grava no armazenamento: use --backup <id>.');
  const key = keyOf(ctx);
  const o = authenticated(b, key);
  if (o.manifest.anonymized) throw new GuardError('Este backup já é anonimizado.');
  printVerify(ctx.deps.out, o.verification);
  if (!o.verification.ok) throw new GuardError('Só se anonimiza um backup que passou na verificação.');
  const ws = workspace();
  try {
    const db = loadSql(o.sqlText);
    let res, text, leak;
    try { res = anonymize(db); leak = leakReport(db, res.sensitive); text = dumpSql(db); } finally { db.close(); }
    if (leak.count) throw new Error(`${leak.count} valor(es) pessoal(is) original(is) ainda aparece(m) no resultado (${leak.where.join(', ')}); nada foi gravado.`);
    const manifest = buildManifest(text, { source_env: o.manifest.source_env, source_database: o.manifest.source_database, wrangler: o.manifest.wrangler, anonymized: true, derived_from: b.id });
    const v2 = verifyContent(text, manifest);
    if (!v2.ok) throw new Error('A cópia anonimizada não passou na verificação: ' + v2.problems.join('; '));
    for (const t of Object.keys(manifest.counts)) if (!['auth_sessions', 'login_attempts', 'password_resets', 'settings'].includes(t) && manifest.counts[t] !== o.manifest.counts[t]) throw new Error(`A anonimização mudou a quantidade de linhas de ${t}.`);
    const box = ws.write('anon', sealBackup(text, manifest, key), 'tbk');
    const id = b.storage.put(box, manifest);
    for (const [t, s] of Object.entries(res.summary)) ctx.deps.out(`[anonymize] ${t}: ${s}`);
    ctx.deps.out(`[anonymize] backup pseudonimizado ${id} gravado (criptografado) e verificado; nenhum valor pessoal original encontrado no resultado. Datas e quase-identificadores permanecem: não é anônimo de forma absoluta (docs/operacao-banco.md).`);
    return 0;
  } finally { ws.cleanup(); }
});

// Regras de origem × destino (sobre o manifesto AUTENTICADO): backup com dados pessoais nunca vai para staging;
// para o restore-test só com autorização específica (--confirm-personal-data=<id do backup> e terminal interativo).
export function checkImportAllowed(manifest, destName, opts, isTTY, id = manifest.id) {
  const personal = manifest.contains_personal_data !== false || !manifest.anonymized;
  if (destName === 'staging' && personal) throw new GuardError('Backup com dados pessoais (não anonimizado) não pode ser importado em staging. Use anonymize antes.');
  if (destName === 'restore-test' && personal) {
    if (!id || opts['confirm-personal-data'] !== id) throw new GuardError(`Este backup contém dados pessoais reais. Importá-lo no restore-test exige autorização específica: --confirm-personal-data=${id || '<id do backup>'}.`);
    if (!isTTY) throw new GuardError('Importar dados pessoais reais exige terminal interativo.');
  }
}

async function importInto(ctx, b) {
  const { target, opts, deps } = ctx;
  if (opts['confirm-destination'] !== target.database_name) throw new GuardError(`Confirme o destino com --confirm-destination=${target.database_name}.`);
  const o = authenticated(b, keyOf(ctx));                  // 1. autentica e descriptografa (falha = nada importado)
  checkImportAllowed(o.manifest, target.name, opts, deps.isTTY(), b.id);
  printVerify(deps.out, o.verification);                    // 2. valida o SQL antes de importar
  if (!o.verification.ok) throw new GuardError('Backup reprovado na verificação; nada foi importado.');
  warnResidue(deps.out);
  const ws = workspace();
  try {
    const plainFile = ws.write('import', o.sqlText);     // 3. texto puro só na área temporária
    if (ctx.opts['dry-run']) { ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--file', plainFile, '--yes']); return { dryRun: true }; }
    const src = openSource(ctx);
    const existing = src.query("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid");
    if (existing.length) {
      if (!opts.replace) throw new GuardError(`O banco de destino ${target.database_name} não está vazio (${existing.length} objeto(s)). Use --replace para apagá-lo antes de importar.`);
      const drop = existing.filter(x => x.type !== 'table').map(x => `DROP ${x.type.toUpperCase()} IF EXISTS "${x.name}";`)
        .concat('PRAGMA defer_foreign_keys = TRUE;', ...existing.filter(x => x.type === 'table').reverse().map(x => `DROP TABLE IF EXISTS "${x.name}";`)); // filhas antes das pais: o D1 não permite desligar foreign_keys
      src.exec(drop.join('\n'));
      deps.out(`[import] ${existing.length} objeto(s) removido(s) de ${target.database_name} (--replace).`);
    }
    try { ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--file', plainFile, '--yes']); }
    finally { ws.discard(plainFile); }                       // texto puro sai do disco logo após o envio
    const counts = {};
    for (const t of Object.keys(o.manifest.counts)) counts[t] = src.query(`SELECT count(*) n FROM "${t}"`)[0]?.n;
    const diff = Object.keys(o.manifest.counts).filter(t => counts[t] !== o.manifest.counts[t]);
    if (diff.length) throw new Error(`Depois do import, contagens diferentes do manifesto em: ${diff.join(', ')}`);
    deps.out(`[import] ${target.database_name}: contagens iguais às do manifesto em ${Object.keys(counts).length} tabelas.`);
    return { counts, manifest: o.manifest };
  } finally { ws.cleanup(); }
}

registerOp('import', async ctx => { await importInto(ctx, resolveBackup(ctx)); return 0; });

registerOp('restore-test', async ctx => {
  const b = resolveBackup(ctx);
  const record = r => { if (b.storage && b.id) b.storage.updateStatus(b.id, { restore_test: r }); };
  let res;
  try { res = await importInto(ctx, b); }
  catch (e) {
    // Recusas (GuardError, inclusive autenticação) não começaram a restauração; falhas depois de começar ficam registradas.
    if (!(e instanceof GuardError)) record({ at: new Date().toISOString(), database: ctx.target.database_name, ok: false, erro: redact(e.message, 200) });
    throw e;
  }
  if (res.dryRun) return 0;
  const ws = workspace();
  try {
    // Reexporta o que ficou no banco restaurado e compara com o backup original (ida e volta).
    const file = ws.path('roundtrip');
    ctx.wrangler(['d1', 'export', ctx.target.database_name, ...remoteArgs(ctx.target), '--output', file, '--skip-confirmation']);
    const text = ws.read(file); ws.discard(file);
    const db = loadSql(text);
    let a; try { a = analyze(db); } finally { db.close(); }
    const problems = [];
    if (!a.integrity_ok || a.foreign_key_violations) problems.push('banco restaurado falhou em integrity_check/foreign_key_check');
    if (a.schema_hash !== res.manifest.schema_hash) problems.push('schema do banco restaurado difere do backup');
    const diff = Object.keys(res.manifest.counts).filter(t => a.counts[t] !== res.manifest.counts[t]);
    if (diff.length) problems.push(`contagens diferentes após a restauração: ${diff.join(', ')}`);
    const w = await workerCheck(text);
    for (const n of w.notes) ctx.deps.out('[restore-test] ' + n);
    if (!w.ok) problems.push(...w.problems);
    record({ at: new Date().toISOString(), database: ctx.target.database_name, ok: problems.length === 0, worker: w.stats || null });
    if (problems.length) { for (const p of problems) ctx.deps.out('  - ' + p); ctx.deps.out('[restore-test] RESTAURAÇÃO REPROVADA'); return 4; }
    ctx.deps.out(`[restore-test] OK: restaurado em ${ctx.target.database_name}, ida e volta idêntica, Worker real respondeu e conferiu ${w.stats.compared_fields} campos com a referência independente (0 divergências).`);
    return 0;
  } finally { ws.cleanup(); }
});

// Restauração local (sem rede): autentica, verifica e valida com o Worker real numa cópia em memória.
export async function restoreLocal(boxBuffer, key, externalManifest = null) {
  let o;
  try { o = openVerified(boxBuffer, key, externalManifest); }
  catch (e) { if (e instanceof BackupCryptoError) return { ok: false, authenticated: false, problems: [e.message] }; throw e; }
  if (!o.verification.ok) return { ok: false, authenticated: true, problems: o.verification.problems };
  const w = await workerCheck(o.sqlText);
  return { ok: w.ok, authenticated: true, problems: w.problems, notes: w.notes, stats: w.stats };
}
// Resíduos de operações interrompidas (kill -9, queda de energia). Sem --remove só lista; com --remove apaga apenas
// áreas comprovadamente do Tatame, deste computador, de processo morto e só com arquivos esperados.
registerOp('temp-clean', async ctx => {
  const rep = ctx.opts.remove ? cleanResidue() : { removed: [], kept: scanResidue() };
  for (const r of rep.removed) ctx.deps.out(`[temp-clean] removida: ${r.name} (${r.files} arquivo(s), iniciada em ${r.started_at})`);
  for (const r of rep.kept) ctx.deps.out(`[temp-clean] ${ctx.opts.remove ? 'mantida' : r.status}: ${r.name} (${r.reason})`);
  const pend = rep.kept.filter(r => r.status === 'abandonado').length;
  ctx.deps.out(rep.removed.length + rep.kept.length === 0 ? '[temp-clean] nenhum resíduo encontrado.' : ctx.opts.remove ? `[temp-clean] ${rep.removed.length} removida(s); ${rep.kept.length} mantida(s).` : `[temp-clean] ${pend} abandonada(s) podem ser removidas com --remove; as demais exigem conferência manual (docs/operacao-banco.md, 7.6).`);
  return 0;
});
export { isInternal, rowsFromWranglerJson };
