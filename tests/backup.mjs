// Backup criptografado, verificação, anonimização, importação e restauração — com dados SINTÉTICOS (cenário da
// Etapa 4 criado pela API real) e SQLite real. O "remoto" é um simulador do wrangler sobre SQLite; nada acessa a rede.
// Diretórios de backup e chaves de teste ficam no temporário do sistema e são apagados no fim.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorld, unfreezeClock } from './ref/harness.mjs';
import { buildManual } from './ref/scenarios.mjs';
import { main, ROOT, MIGRATIONS_CONFIG } from '../tools/db/ops.mjs';
import { buildManifest, verifyContent, restoreLocal, checkImportAllowed, sealBackup, openVerified, WORK_PREFIX } from '../tools/db/backup.mjs';
import { dumpSql, loadSql, analyze } from '../tools/db/dump.mjs';
import { generateKey, encrypt } from '../tools/backup/crypto.mjs';
import { validateDir, dirAdapter, createStorage, retentionPlan, StorageError } from '../tools/backup/storage.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-backup-test-'));
assert.ok(!/onedrive/i.test(tmp), 'o temporário do sistema não pode estar no OneDrive');
const store = join(tmp, 'store'); mkdirSync(store);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const KEY_HEX = generateKey(), KEY = Buffer.from(KEY_HEX, 'hex'), OTHER = Buffer.from(generateKey(), 'hex');
const keyFile = join(tmp, 'chave-de-teste.txt'); writeFileSync(keyFile, KEY_HEX);
const ENV = { TATAME_BACKUP_DIR: store, TATAME_BACKUP_KEY_FILE: keyFile };
const workDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith(WORK_PREFIX)).length;
const workBefore = workDirs();
const PII = /@sintetico\.test|98877-|observação sintética|Apelido |Tema sintético|nota da aula|admin@paridade\.test|Academia Paridade/;

try {
  // ---------- dados sintéticos realistas ----------
  const world = await openWorld(today);
  await buildManual(world);
  unfreezeClock();
  const raw = world.DB.raw;
  raw.exec("UPDATE students SET phone = '11 98877-' || substr(id, 1, 4), email = lower(replace(name, ' ', '.')) || '@sintetico.test', notes = 'observação sintética de ' || name, nickname = 'Apelido ' || name");
  raw.exec("UPDATE lessons SET title = 'Tema sintético ' || date, notes = 'nota da aula ' || date WHERE rowid % 3 = 0");
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('000_base.sql'), ('001_recuperacao_senha.sql'), ('002_marcador_de_chamada.sql')");
  const text = dumpSql(raw);
  const origCounts = analyze(raw).counts;
  ok(origCounts.students >= 30 && origCounts.attendance > 50 && origCounts.promotions > 0 && origCounts.auth_sessions > 0, `cenário sintético: ${origCounts.students} alunos, ${origCounts.lessons} aulas, ${origCounts.attendance} presenças, ${origCounts.promotions} graduações`);
  const manifest = buildManifest(text, { source_env: 'production', source_database: 'tatame-prod-ficticio', wrangler: '4.155.0', created_at: '2026-11-12T10:00:00.000Z' });
  ok(manifest.manifest_version === 2 && manifest.container.algorithm === 'AES-256-GCM' && manifest.contains_personal_data === true && !PII.test(JSON.stringify(manifest)) && !JSON.stringify(manifest).includes(KEY_HEX), 'manifesto v2: metadados do contêiner, sem valores das linhas e sem a chave');
  ok(['source_env', 'source_database', 'created_at', 'migrations', 'schema_hash', 'counts', 'sha256', 'wrangler', 'commit'].every(k => k in manifest), 'manifesto tem origem, banco, data UTC, migrações, schema, contagens, SHA-256, wrangler e commit');
  const box = sealBackup(text, manifest, KEY);
  ok(!PII.test(box.toString('latin1')) && !box.toString('latin1').includes('INSERT INTO'), 'backup selado não contém SQL nem dados pessoais em claro');

  // ---------- conteúdo autenticado: verificação SQL ----------
  let v = openVerified(box, KEY).verification;
  ok(v.ok && Object.values(v.checks).every(Boolean), 'autenticado e íntegro: hash, import, integrity, FKs, contagens e schema ok');
  const resealed = (t2, m2 = manifest) => openVerified(sealBackup(t2, m2, KEY), KEY).verification; // quem TEM a chave e gera conteúdo ruim
  v = resealed(text.slice(0, Math.floor(text.length * 0.6)));
  ok(!v.ok && !v.checks.hash, 'conteúdo truncado antes de selar (defeito de quem exportou): hash e import reprovam');
  { const t2 = text.replace(/INSERT INTO "attendance"[^\n]*\n/, ''); const m2 = { ...manifest, sha256: buildManifest(t2, { source_env: 'x', source_database: 'x', wrangler: 'x' }).sha256 }; const r = resealed(t2, m2); ok(!r.ok && r.checks.hash && !r.checks.counts, 'SHA-256 recalculável não prova nada: com hash coerente, a contagem ainda reprova'); }
  { const t2 = text.replace('CREATE TABLE', 'CREATE TABEL'); const r = resealed(t2, { ...manifest, sha256: buildManifest(text, { source_env: 'x', source_database: 'x', wrangler: 'x' }).sha256 }); ok(!r.ok && r.checks.import === false, 'SQL inválido: reprovado na importação'); }
  { const r = resealed(text, { ...manifest, counts: { ...manifest.counts, students: manifest.counts.students + 1 } }); ok(!r.ok && !r.checks.counts, 'contagem divergente do manifesto: reprovado'); }
  { const t2 = text.replace('  goals TEXT,\n', '  goals TEXT,\n  extra TEXT,\n'); assert.ok(t2 !== text);
    const r = resealed(t2, buildManifest(t2, { source_env: 'production', source_database: 'x', wrangler: 'x' })); ok(!r.ok && r.checks.schema_manifest && !r.checks.schema_expected, 'schema divergente do esperado para as migrações registradas: reprovado mesmo com manifesto coerente'); }
  { const t2 = text + "INSERT INTO attendance (lesson_id, student_id) VALUES ('fantasma', 'fantasma');\n"; const r = resealed(t2, buildManifest(t2, { source_env: 'production', source_database: 'x', wrangler: 'x' })); ok(!r.ok && !r.checks.foreign_keys, 'violação de integridade referencial: reprovado'); }

  // ---------- restauração local com o Worker real (depois da descriptografia) ----------
  let r = await restoreLocal(box, KEY);
  ok(r.ok && r.authenticated && r.stats.divergences === 0 && r.stats.compared_fields > 300, `descriptografado e restaurado: Worker real bate com a referência independente (${r.stats.compared_fields} campos, 0 divergências)`);
  r = await restoreLocal(box, OTHER);
  ok(!r.ok && r.authenticated === false && /Chave incorreta/.test(r.problems[0]), 'restauração com chave errada: nada é aberto');
  { const t = Buffer.from(box); t[t.length - 100] ^= 1; r = await restoreLocal(t, KEY); ok(!r.ok && !r.authenticated && /Autenticação falhou/.test(r.problems[0]), 'restauração de arquivo adulterado: autenticação falha antes de qualquer SQL'); }
  { const db = loadSql(text); db.exec("ALTER TABLE lessons DROP COLUMN roll_called; DELETE FROM d1_migrations WHERE name = '002_marcador_de_chamada.sql'"); const t2 = dumpSql(db); db.close();
    const rr = await restoreLocal(sealBackup(t2, buildManifest(t2, { source_env: 'production', source_database: 'x', wrangler: 'x' }), KEY), KEY);
    ok(rr.ok && rr.notes.some(n => /002_marcador_de_chamada/.test(n)), 'backup de antes da 002: autenticado, 002 aplicada na cópia, Worker atual compatível'); }

  // ---------- armazenamento ----------
  assert.throws(() => createStorage({}), /não está definido/); ok(true, 'sem TATAME_BACKUP_DIR: recusa gravar');
  assert.throws(() => validateDir('relativo/backups'), /absoluto/); ok(true, 'caminho relativo: recusado');
  assert.throws(() => validateDir(join(tmp, 'nao-existe')), /não existe/); ok(true, 'diretório inexistente: recusado (não cria sozinho)');
  assert.throws(() => validateDir(join(ROOT, 'db')), /dentro do repositório/); ok(true, 'diretório dentro do repositório: recusado');
  const od = join(tmp, 'OneDrive - Pessoal'); mkdirSync(od);
  assert.throws(() => validateDir(od), /OneDrive/); ok(true, 'caminho com OneDrive no nome: recusado');
  const odRoot = join(tmp, 'nuvem'); mkdirSync(join(odRoot, 'sub'), { recursive: true });
  assert.throws(() => validateDir(join(odRoot, 'sub'), { OneDrive: odRoot }), /OneDrive/); ok(true, 'dentro da pasta do OneDrive configurada no sistema: recusado');
  { const f = join(tmp, 'arquivo.txt'); writeFileSync(f, ''); assert.throws(() => validateDir(f), /não é um diretório/); ok(true, 'caminho que não é diretório: recusado'); }
  { const sys = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/proc';
    let refused = false; try { validateDir(sys); } catch (e) { refused = e instanceof StorageError && /escrita/.test(e.message); }
    if (refused) ok(true, `diretório sem permissão de escrita (${sys}): recusado`);
    else console.log(`AVISO: não foi possível testar "sem permissão de escrita" aqui (${sys} é gravável para este usuário); teste NÃO contado como aprovado`); }
  const st = dirAdapter(store);
  const sim = []; for (let i = 0; i < 150; i++) { const d = new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString(); sim.push({ id: `production-${i}`, source_env: 'production', anonymized: false, created_at: d }); }
  const plan = retentionPlan(sim);
  const kept = sim.filter(m => plan.keep.includes(m.id)).map(m => m.created_at.slice(0, 10));
  ok(kept.sort().join() === '2026-08-31,2026-09-30,2026-10-11,2026-10-18,2026-10-25,2026-10-28', `retenção 4 semanais + 3 mensais: mantém ${plan.keep.length} (${kept.join(', ')}), remove ${plan.remove.length}`);
  ok(retentionPlan(sim.concat(sim.slice(0, 20).map(m => ({ ...m, id: m.id + '-anon', anonymized: true })))).keep.some(id => id.endsWith('-anon')), 'retenção separa backups integrais e anonimizados');

  const boxFile = join(tmp, 'selado.tbk'); writeFileSync(boxFile, box);
  const id = st.put(boxFile, manifest);
  ok(existsSync(join(store, id, 'backup.tbk')) && !existsSync(join(store, id, 'backup.sql')) && !PII.test(readFileSync(join(store, id, 'backup.tbk')).toString('latin1')), `armazenamento grava só o contêiner criptografado (${id})`);
  assert.throws(() => st.put(boxFile, manifest), /nada foi sobrescrito/); ok(true, 'armazenamento nunca sobrescreve um backup');

  // ---------- verify pelo wrapper: chave, adulteração, manifesto externo ----------
  const offOut = [], offErr = [];
  const offDeps = env => ({ environments: () => ({}), wranglerVersion: () => 'x', exec: () => { throw new Error('não deveria chamar o wrangler'); }, isTTY: () => false, ask: async () => '', out: m => offOut.push(m), err: m => offErr.push(m), env });
  let code = await main(['verify', '--backup', id], offDeps(ENV));
  ok(code === 0 && /autêntico, íntegro/.test(offOut.join('\n')), 'verify --backup: autentica, descriptografa e verifica');
  code = await main(['verify', '--backup', id], offDeps({ TATAME_BACKUP_DIR: store }));
  ok(code === 3 && /Chave de backup ausente/.test(offErr.join('\n')), 'verify sem chave: recusado (falha fechada)');
  code = await main(['verify', '--backup', id], offDeps({ TATAME_BACKUP_DIR: store, TATAME_BACKUP_KEY: OTHER.toString('hex') }));
  ok(code === 3 && /Chave incorreta/.test(offErr.join('\n')), 'verify com chave errada: recusado');
  ok(!offOut.concat(offErr).join('\n').includes(KEY_HEX) && !offOut.concat(offErr).join('\n').includes(OTHER.toString('hex')), 'nenhuma chave aparece na saída');
  const mfFile = join(store, id, 'manifest.json'), mfOrig = readFileSync(mfFile, 'utf8');
  writeFileSync(mfFile, mfOrig.replace(`"students": ${manifest.counts.students}`, `"students": ${manifest.counts.students + 7}`));
  code = await main(['verify', '--backup', id], offDeps(ENV));
  ok(code === 3 && /manifest\.json externo difere/.test(offErr.join('\n')), 'manifest.json externo alterado: detectado (vale o autenticado)');
  writeFileSync(mfFile, mfOrig);
  const tbk = join(store, id, 'backup.tbk'), tbkOrig = readFileSync(tbk);
  { const t = Buffer.from(tbkOrig); t[Math.floor(t.length / 2)] ^= 0x40; writeFileSync(tbk, t); }
  code = await main(['verify', '--backup', id], offDeps(ENV));
  ok(code === 3 && /Autenticação falhou/.test(offErr.join('\n')), 'conteúdo do .tbk alterado: autenticação falha');
  writeFileSync(tbk, encrypt(Buffer.from(text.replace(/INSERT INTO "attendance"[^\n]*\n/, '')), { ...manifest, counts: { ...manifest.counts, attendance: manifest.counts.attendance - 1 } }, OTHER));
  code = await main(['verify', '--backup', id], offDeps(ENV));
  ok(code === 3 && /Chave incorreta/.test(offErr.join('\n')), 'backup e manifesto trocados juntos sem a chave: recusado');
  writeFileSync(tbk, tbkOrig.subarray(0, 30));
  code = await main(['verify', '--backup', id], offDeps(ENV));
  ok(code === 3 && /truncado/.test(offErr.join('\n')), 'arquivo .tbk truncado: recusado como corrompido');
  writeFileSync(tbk, tbkOrig);

  // ---------- anonimização (abre o criptografado, grava criptografado) ----------
  offOut.length = 0;
  code = await main(['anonymize', '--backup', id], offDeps(ENV));
  ok(code === 0 && /pseudonimizado/.test(offOut.join('\n')), 'anonymize: autentica, anonimiza e grava cópia criptografada');
  const anon = st.list().find(m => m.anonymized);
  const anonBox = readFileSync(st.get(anon.id).boxPath);
  const anonOpen = openVerified(anonBox, KEY, st.get(anon.id).manifest);
  ok(anonOpen.verification.ok && !PII.test(anonOpen.sqlText), 'cópia anonimizada: autêntica, íntegra e sem nomes, e-mails, telefones, apelidos, observações, títulos ou nome da academia sintéticos');
  { const db = loadSql(anonOpen.sqlText), o = loadSql(text); const a = analyze(db);
    for (const t of ['students', 'lessons', 'attendance', 'promotions', 'skills', 'lesson_techniques', 'staff']) assert.strictEqual(a.counts[t], origCounts[t], t);
    const ids = (d, s) => d.prepare(s).all().map(x => Object.values(x).join('|')).join(',');
    ok(ids(o, 'SELECT lesson_id, student_id FROM attendance ORDER BY 1, 2') === ids(db, 'SELECT lesson_id, student_id FROM attendance ORDER BY 1, 2') && a.foreign_key_violations === 0, 'quantidades, IDs, relações e integridade referencial preservados');
    o.close(); db.close(); }
  r = await restoreLocal(anonBox, KEY);
  ok(r.ok && r.stats.divergences === 0, `cópia anonimizada restaura e o Worker real funciona sobre ela (${r.stats.compared_fields} campos)`);

  // ---------- regras de importação (manifesto autenticado) ----------
  assert.throws(() => checkImportAllowed(manifest, 'staging', {}, true, id), /não pode ser importado em staging/); ok(true, 'backup com dados pessoais → staging: recusado');
  assert.throws(() => checkImportAllowed(manifest, 'restore-test', {}, true, id), /autorização específica/); ok(true, 'dados pessoais → restore-test sem autorização específica: recusado');
  assert.throws(() => checkImportAllowed(manifest, 'restore-test', { 'confirm-personal-data': id }, false, id), /terminal interativo/); ok(true, 'dados pessoais com autorização mas sem terminal: recusado');
  checkImportAllowed(manifest, 'restore-test', { 'confirm-personal-data': id }, true, id); ok(true, 'dados pessoais → restore-test só com --confirm-personal-data=<id> e terminal');
  checkImportAllowed(anon, 'staging', {}, false); ok(true, 'backup anonimizado → staging: permitido');

  // ---------- import / restore-test pelo wrapper, remoto simulado ----------
  const IDS = { staging: '11111111-1111-4111-8111-111111111111', rt: '22222222-2222-4222-8222-222222222222' };
  const envs = { staging: { kind: 'remote', database_name: 'tatame-staging', database_id: IDS.staging }, 'restore-test': { kind: 'remote', database_name: 'tatame-restore-test', database_id: IDS.rt } };
  const remoteDb = { 'tatame-staging': join(tmp, 'remote-staging.db'), 'tatame-restore-test': join(tmp, 'remote-rt.db') };
  const calls = [], importedFiles = [];
  const simExec = args => {
    calls.push(args.join(' '));
    assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === MIGRATIONS_CONFIG, 'usa a configuração isolada');
    const db = new DatabaseSync(remoteDb[args[2]]);
    try {
      if (args[1] === 'export') { writeFileSync(args[args.indexOf('--output') + 1], dumpSql(db)); return { status: 0, stdout: '' }; }
      if (args.includes('--file')) { const f = args[args.indexOf('--file') + 1]; importedFiles.push(f); db.exec(readFileSync(f, 'utf8')); return { status: 0, stdout: '[]' }; }
      const sql = args[args.indexOf('--command') + 1];
      const single = !/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''));
      const isQuery = single && /^\s*(SELECT|PRAGMA (integrity_check|foreign_key_check))/i.test(sql);
      return { status: 0, stdout: JSON.stringify([{ results: isQuery ? db.prepare(sql).all() : (db.exec(sql), []), success: true }]) };
    } finally { db.close(); }
  };
  const out = [], err = [];
  const rdeps = (env = ENV, exec = simExec) => ({ environments: () => envs, wranglerVersion: () => '4.155.0', exec, isTTY: () => false, ask: async () => '', out: m => out.push(m), err: m => err.push(m), env });
  calls.length = 0;
  code = await main(['import', '--env', 'staging', '--backup', id, '--confirm-destination=tatame-staging'], rdeps());
  ok(code === 3 && calls.length === 0, 'import de backup com dados pessoais em staging: recusado sem nenhum comando');
  code = await main(['import', '--env', 'staging', '--backup', anon.id], rdeps());
  ok(code === 3 && calls.length === 0, 'import sem --confirm-destination: recusado sem nenhum comando');
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging'], rdeps({ TATAME_BACKUP_DIR: store }));
  ok(code === 3 && calls.length === 0, 'import sem chave: recusado sem nenhum comando');
  const anonTbk = st.get(anon.id).boxPath, anonOrig = readFileSync(anonTbk);
  { const t = Buffer.from(anonOrig); t[t.length - 3] ^= 1; writeFileSync(anonTbk, t); }
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging'], rdeps());
  ok(code === 3 && calls.length === 0 && !existsSync(remoteDb['tatame-staging']), 'tag de autenticação inválida no import: falha antes de qualquer comando; nada importado');
  writeFileSync(anonTbk, anonOrig);
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging'], rdeps());
  ok(code === 0 && (() => { const d = new DatabaseSync(remoteDb['tatame-staging']); try { return analyze(d).counts.students; } finally { d.close(); } })() === origCounts.students, 'import do anonimizado em staging (vazio): autenticado, verificado, contagens conferidas no destino');
  ok(importedFiles.length === 1 && !existsSync(importedFiles[0]), 'o .sql em claro usado no import foi apagado logo depois');
  calls.length = 0;
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging'], rdeps());
  ok(code === 3 && calls.every(c => !c.includes('--file')), 'destino não vazio sem --replace: recusado antes de importar (sem sobrescrita silenciosa)');
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging', '--replace'], rdeps());
  ok(code === 0, 'destino não vazio com --replace explícito: substitui e confere');
  out.length = 0;
  code = await main(['restore-test', '--env', 'restore-test', '--backup', anon.id, '--confirm-destination=tatame-restore-test'], rdeps());
  ok(code === 0 && /ida e volta idêntica, Worker real/.test(out.join('\n')), 'restore-test: descriptografa, importa, reexporta, compara e valida com o Worker real');
  ok(st.status(anon.id)?.restore_test?.ok === true && JSON.stringify(st.get(anon.id).manifest) === JSON.stringify({ ...anon, status: undefined, id: anon.id }).replace(',"status":null', ''), 'resultado do restore-test fica em status.json; o manifesto autenticado não muda');
  ok(openVerified(readFileSync(st.get(anon.id).boxPath), KEY, st.get(anon.id).manifest).verification.ok, 'o backup continua autêntico depois do restore-test (manifesto externo intacto)');
  ok(!PII.test(out.concat(err).join('\n')) && !out.concat(err).join('\n').includes(KEY_HEX), 'nenhum dado pessoal nem chave impressos durante as operações');
  const brokenExec = args => { const r2 = simExec(args); if (args.includes('--file')) { const db = new DatabaseSync(remoteDb['tatame-restore-test']); db.exec('DELETE FROM attendance WHERE rowid % 2 = 0'); db.close(); } return r2; };
  code = await main(['restore-test', '--env', 'restore-test', '--backup', anon.id, '--confirm-destination=tatame-restore-test', '--replace'], rdeps(ENV, brokenExec));
  ok(code !== 0 && st.status(anon.id).restore_test.ok === false, 'falha simulada (linhas perdidas): reprovado e registrado em status.json');
  // export pelo wrapper: sem chave, recusa antes do wrangler
  calls.length = 0;
  code = await main(['export', '--env', 'staging'], rdeps({ TATAME_BACKUP_DIR: store }));
  ok(code === 3 && calls.length === 0, 'export sem chave: recusado antes de qualquer comando remoto');
  code = await main(['export', '--env', 'staging'], rdeps());
  const exp = st.list().find(m => m.source_env === 'staging');
  ok(code === 0 && exp && openVerified(readFileSync(st.get(exp.id).boxPath), KEY, st.get(exp.id).manifest).verification.ok, 'export (simulado) grava contêiner criptografado que reabre e verifica');
  ok(workDirs() === workBefore, `áreas temporárias com texto puro removidas em sucesso e em erro (${workDirs()} restante(s), antes ${workBefore})`);
  console.log('\nBACKUP E RESTAURAÇÃO OK');
} finally { unfreezeClock(); try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('AVISO: limpeza do temporário: ' + e.code); } }
