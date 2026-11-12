// Backup, verificação, anonimização, importação e restauração — com dados SINTÉTICOS (cenário da Etapa 4 criado
// pela API real) e SQLite real. O "remoto" é um simulador do wrangler sobre SQLite; nada acessa a rede.
// Diretórios de backup ficam no temporário do sistema e são apagados no fim.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorld, unfreezeClock } from './ref/harness.mjs';
import { buildManual } from './ref/scenarios.mjs';
import { main, ROOT, MIGRATIONS_CONFIG } from '../tools/db/ops.mjs';
import { buildManifest, verifyBackup, restoreLocal, checkImportAllowed } from '../tools/db/backup.mjs';
import { dumpSql, loadSql, analyze } from '../tools/db/dump.mjs';
import { anonymize, AnonymizationError } from '../tools/db/anonymize.mjs';
import { validateDir, dirAdapter, createStorage, retentionPlan, StorageError } from '../tools/backup/storage.mjs';
import { MIGRATIONS_DIR } from '../tools/db/schema.mjs';
import { applyLocal } from '../tools/db/ops-migrate.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-backup-test-'));
assert.ok(!/onedrive/i.test(tmp), 'o temporário do sistema não pode estar no OneDrive');
const store = join(tmp, 'store'); mkdirSync(store);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

try {
  // ---------- dados sintéticos realistas ----------
  const world = await openWorld(today);
  await buildManual(world);
  unfreezeClock();
  const raw = world.DB.raw;
  raw.exec("UPDATE students SET phone = '11 98877-' || substr(id, 1, 4), email = lower(replace(name, ' ', '.')) || '@sintetico.test', notes = 'observação sintética de ' || name, nickname = 'Apelido ' || name");
  raw.exec("UPDATE lessons SET title = 'Tema sintético ' || date, notes = 'nota da aula ' || date WHERE rowid % 3 = 0");
  // registra 000/001/002 como um banco migrado de verdade (o schema já é o final)
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('000_base.sql'), ('001_recuperacao_senha.sql'), ('002_marcador_de_chamada.sql')");
  const origFile = join(tmp, 'orig.sql'); writeFileSync(origFile, dumpSql(raw));
  const origCounts = analyze(raw).counts;
  ok(origCounts.students >= 30 && origCounts.attendance > 50 && origCounts.promotions > 0 && origCounts.auth_sessions > 0, `cenário sintético: ${origCounts.students} alunos, ${origCounts.lessons} aulas, ${origCounts.attendance} presenças, ${origCounts.promotions} graduações`);
  const manifest = buildManifest(origFile, { source_env: 'production', source_database: 'tatame-prod-ficticio', wrangler: '4.155.0', created_at: '2026-11-12T10:00:00.000Z' });
  ok(manifest.sha256.length === 64 && manifest.migrations.length === 3 && manifest.contains_personal_data === true && !JSON.stringify(manifest).includes('@sintetico.test'), 'manifesto: hash, migrações, contagens, versão, commit; marca dados pessoais; sem nenhum valor das linhas');
  ok(['source_env', 'source_database', 'created_at', 'migrations', 'schema_hash', 'counts', 'sha256', 'wrangler', 'commit'].every(k => k in manifest), 'manifesto tem origem, banco, data UTC, migrações, schema, contagens, SHA-256, wrangler e commit');

  // ---------- verify ----------
  let v = verifyBackup(origFile, manifest);
  ok(v.ok && Object.values(v.checks).every(Boolean), 'backup íntegro: hash, import, integrity, FKs, contagens e schema ok');
  const text = readFileSync(origFile, 'utf8');
  const variant = (name, content, m = manifest) => { const f = join(tmp, name + '.sql'); writeFileSync(f, content); return verifyBackup(f, m); };
  v = variant('truncado', text.slice(0, Math.floor(text.length * 0.6)));
  ok(!v.ok && !v.checks.hash, 'arquivo truncado: reprovado');
  v = variant('adulterado', text.replace(/INSERT INTO "attendance"[^\n]*\n/, ''));
  ok(!v.ok && !v.checks.hash && !v.checks.counts, 'arquivo adulterado (linha removida): hash e contagem reprovam');
  // adulteração com hash recalculado: o hash passa, mas a contagem denuncia
  { const t2 = text.replace(/INSERT INTO "attendance"[^\n]*\n/, ''); const f = join(tmp, 'rehash.sql'); writeFileSync(f, t2); const m2 = { ...manifest, sha256: (await import('../tools/db/dump.mjs')).sha256File(f) }; const r = verifyBackup(f, m2); ok(!r.ok && r.checks.hash && !r.checks.counts, 'hash recalculado por quem adulterou: o hash não basta, a contagem reprova'); }
  { const f = join(tmp, 'invalido.sql'); writeFileSync(f, text.replace('CREATE TABLE', 'CREATE TABEL')); const m2 = { ...manifest, sha256: (await import('../tools/db/dump.mjs')).sha256File(f) }; const r = verifyBackup(f, m2); ok(!r.ok && r.checks.hash && r.checks.import === false, 'SQL inválido com hash coerente: reprovado na importação'); }
  { const f = join(tmp, 'contagem.sql'); writeFileSync(f, text); const r = verifyBackup(f, { ...manifest, counts: { ...manifest.counts, students: manifest.counts.students + 1 } }); ok(!r.ok && !r.checks.counts, 'contagem divergente do manifesto: reprovado'); }
  { const t2 = text.replace('  goals TEXT,\n', '  goals TEXT,\n  extra TEXT,\n'); assert.ok(t2 !== text, 'alteração de schema aplicada no texto');
    const f = join(tmp, 'schema.sql'); writeFileSync(f, t2); const m2 = buildManifest(f, { source_env: 'production', source_database: 'x', wrangler: 'x' });
    const r = verifyBackup(f, m2); ok(!r.ok && r.checks.schema_manifest && !r.checks.schema_expected, 'schema divergente do esperado para as migrações registradas: reprovado mesmo com manifesto coerente'); }
  { const fk = text.replace(/PRAGMA defer_foreign_keys=TRUE;/, "PRAGMA defer_foreign_keys=TRUE;\n") + "INSERT INTO attendance (lesson_id, student_id) VALUES ('fantasma', 'fantasma');\n"; const f = join(tmp, 'fk.sql'); writeFileSync(f, fk);
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }); db.exec(fk); const n = db.prepare('PRAGMA foreign_key_check').all().length; db.close();
    const m2 = { ...buildManifest(f, { source_env: 'production', source_database: 'x', wrangler: 'x' }) }; const r = verifyBackup(f, m2); ok(n > 0 && !r.ok && !r.checks.foreign_keys, 'violação de integridade referencial no backup: reprovado'); }

  // ---------- restauração local com o Worker real ----------
  let r = await restoreLocal(origFile, manifest);
  ok(r.ok && r.stats.divergences === 0 && r.stats.compared_fields > 300, `restauração local: Worker real respondeu e bateu com a referência independente (${r.stats.compared_fields} campos, 0 divergências)`);
  // backup antigo (só 000 + 001): a validação aplica a 002 na cópia e o Worker atual funciona
  { const db = loadSql(text); db.exec("ALTER TABLE lessons DROP COLUMN roll_called; DELETE FROM d1_migrations WHERE name = '002_marcador_de_chamada.sql'"); const f = join(tmp, 'antigo.sql'); writeFileSync(f, dumpSql(db)); db.close();
    const m = buildManifest(f, { source_env: 'production', source_database: 'x', wrangler: 'x' });
    const rr = await restoreLocal(f, m); ok(rr.ok && rr.notes.some(n => /002_marcador_de_chamada/.test(n)), 'backup de antes da 002: verificado, 002 aplicada na cópia e Worker atual compatível'); }

  // ---------- armazenamento ----------
  assert.throws(() => createStorage({}), /não está definido/); ok(true, 'sem TATAME_BACKUP_DIR: recusa gravar');
  assert.throws(() => validateDir('relativo/backups'), /absoluto/); ok(true, 'caminho relativo: recusado');
  assert.throws(() => validateDir(join(tmp, 'nao-existe')), /não existe/); ok(true, 'diretório inexistente: recusado (não cria sozinho)');
  assert.throws(() => validateDir(join(ROOT, 'db')), /dentro do repositório/); ok(true, 'diretório dentro do repositório: recusado');
  const od = join(tmp, 'OneDrive - Pessoal'); mkdirSync(od);
  assert.throws(() => validateDir(od), /OneDrive/); ok(true, 'caminho com OneDrive no nome: recusado');
  const odRoot = join(tmp, 'nuvem'); mkdirSync(join(odRoot, 'sub'), { recursive: true });
  assert.throws(() => validateDir(join(odRoot, 'sub'), { OneDrive: odRoot }), /OneDrive/); ok(true, 'dentro da pasta do OneDrive configurada no sistema (variável OneDrive): recusado');
  { const f = join(tmp, 'arquivo.txt'); writeFileSync(f, ''); assert.throws(() => validateDir(f), /não é um diretório/); ok(true, 'caminho que não é diretório: recusado'); }
  { const sys = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/proc';
    let refused = false; try { validateDir(sys); } catch (e) { refused = e instanceof StorageError && /escrita/.test(e.message); }
    if (refused) ok(true, `diretório sem permissão de escrita (${sys}): recusado`);
    else console.log(`AVISO: não foi possível testar "sem permissão de escrita" aqui (${sys} é gravável para este usuário); teste NÃO contado como aprovado`); }
  const st = dirAdapter(store);
  // retenção com datas simuladas: um backup por dia durante 150 dias
  const sim = []; for (let i = 0; i < 150; i++) { const d = new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString(); sim.push({ id: `production-${i}`, source_env: 'production', anonymized: false, created_at: d }); }
  const plan = retentionPlan(sim);
  const kept = sim.filter(m => plan.keep.includes(m.id)).map(m => m.created_at.slice(0, 10));
  // último dia simulado: 28/10. Semanais: o mais novo de cada uma das 4 últimas semanas ISO (28/10, 25/10, 18/10, 11/10);
  // mensais: o mais novo de cada um dos 3 últimos meses (28/10, 30/09, 31/08). União = 6.
  ok(kept.sort().join() === '2026-08-31,2026-09-30,2026-10-11,2026-10-18,2026-10-25,2026-10-28', `retenção 4 semanais + 3 mensais: mantém ${plan.keep.length} (${kept.join(', ')}), remove ${plan.remove.length}`);
  const sim2 = sim.concat(sim.slice(0, 20).map(m => ({ ...m, id: m.id + '-anon', anonymized: true })));
  ok(retentionPlan(sim2).keep.filter(id => id.endsWith('-anon')).length > 0, 'retenção separa backups integrais e anonimizados');

  // ---------- anonimização pelo wrapper ----------
  const id = st.put(origFile, manifest);
  ok(existsSync(join(store, id, 'backup.sql')) && !existsSync(join(store, id + 'x')), `armazenamento grava ${id} com manifesto`);
  assert.throws(() => st.put(origFile, manifest), /nada foi sobrescrito/); ok(true, 'armazenamento nunca sobrescreve um backup');
  const outA = [], errA = [];
  const offDeps = { environments: () => ({}), wranglerVersion: () => 'x', exec: () => { throw new Error('não deveria chamar o wrangler'); }, isTTY: () => false, ask: async () => '', out: m => outA.push(m), err: m => errA.push(m), env: { TATAME_BACKUP_DIR: store } };
  let code = await main(['anonymize', '--backup', id], offDeps);
  ok(code === 0, 'anonymize: gera cópia anonimizada a partir de backup verificado');
  const anon = st.list().find(m => m.anonymized);
  const { sqlPath: anonPath } = st.get(anon.id);
  const anonText = readFileSync(anonPath, 'utf8');
  ok(!/@sintetico\.test|98877-|observação sintética|Apelido |Tema sintético|nota da aula|admin@paridade\.test|Academia Paridade/.test(anonText), 'nenhum nome, e-mail, telefone, apelido, observação, título ou nome da academia sintéticos sobra no anonimizado');
  { const db = loadSql(anonText); const a = analyze(db);
    const names = db.prepare('SELECT name FROM students').all().map(x => x.name);
    ok(names.every(n => /^Aluno \d+$/.test(n)) && new Set(names).size === names.length, 'nomes viram "Aluno N" (únicos, sem relação com o nome real)');
    ok(db.prepare("SELECT count(*) n FROM students WHERE birth_date IS NOT NULL AND substr(birth_date, 6) <> '07-01'").get().n === 0, 'datas de nascimento generalizadas para 1º de julho do mesmo ano (sem data continua sem data)');
    ok(a.counts.auth_sessions === 0 && a.counts.login_attempts === 0 && a.counts.password_resets === 0 && db.prepare("SELECT count(*) n FROM staff WHERE pass_hash <> 'anonimizado'").get().n === 0, 'sessões, tentativas de login, códigos e hashes de senha removidos');
    for (const t of ['students', 'lessons', 'attendance', 'promotions', 'skills', 'lesson_techniques', 'staff']) assert.strictEqual(a.counts[t], origCounts[t], t);
    ok(true, 'quantidade de linhas preservada em alunos, aulas, presenças, graduações, avaliações e equipe');
    ok(a.foreign_key_violations === 0 && a.integrity_ok, 'integridade referencial preservada na cópia anonimizada');
    const ids = (d, s) => d.prepare(s).all().map(x => Object.values(x).join('|')).join(',');
    const o = loadSql(text);
    ok(ids(o, 'SELECT lesson_id, student_id FROM attendance ORDER BY 1, 2') === ids(db, 'SELECT lesson_id, student_id FROM attendance ORDER BY 1, 2') && ids(o, 'SELECT id, belt, degrees, status, start_date FROM students ORDER BY id') === ids(db, 'SELECT id, belt, degrees, status, start_date FROM students ORDER BY id'), 'IDs, relações, faixas, graus, estados e datas de início preservados');
    o.close(); db.close(); }
  r = await restoreLocal(anonPath, anon);
  ok(r.ok && r.stats.divergences === 0, `cópia anonimizada restaura e o Worker real funciona sobre ela (${r.stats.compared_fields} campos conferidos)`);
  // regra fechada: coluna nova sem regra impede a anonimização
  { const db = loadSql(text); db.exec('ALTER TABLE students ADD COLUMN cpf TEXT'); assert.throws(() => anonymize(db), e => e instanceof AnonymizationError && /students\.cpf/.test(e.message)); db.close(); ok(true, 'coluna sem regra de anonimização (students.cpf): anonimização recusada'); }
  { const db = loadSql(text); db.exec('CREATE TABLE contatos (id TEXT, telefone TEXT)'); assert.throws(() => anonymize(db), /tabela sem regra/); db.close(); ok(true, 'tabela sem regra de anonimização: recusada'); }

  // ---------- regras de importação ----------
  const tty = true, noTTY = false;
  assert.throws(() => checkImportAllowed({ ...manifest, id }, 'staging', {}, tty), /não pode ser importado em staging/); ok(true, 'backup de produção com dados pessoais → staging: recusado');
  assert.throws(() => checkImportAllowed({ ...manifest, id }, 'restore-test', {}, tty), /autorização específica/); ok(true, 'backup com dados pessoais → restore-test sem autorização específica: recusado');
  assert.throws(() => checkImportAllowed({ ...manifest, id }, 'restore-test', { 'confirm-personal-data': id }, noTTY), /terminal interativo/); ok(true, 'dados pessoais com autorização mas sem terminal interativo: recusado');
  checkImportAllowed({ ...manifest, id }, 'restore-test', { 'confirm-personal-data': id }, tty); ok(true, 'dados pessoais → restore-test só com --confirm-personal-data=<id> e terminal');
  checkImportAllowed(anon, 'staging', {}, noTTY); ok(true, 'backup anonimizado → staging: permitido');

  // ---------- import / restore-test pelo wrapper, com remoto simulado ----------
  const IDS = { staging: '11111111-1111-4111-8111-111111111111', rt: '22222222-2222-4222-8222-222222222222' };
  const envs = { staging: { kind: 'remote', database_name: 'tatame-staging', database_id: IDS.staging }, 'restore-test': { kind: 'remote', database_name: 'tatame-restore-test', database_id: IDS.rt } };
  const remoteDb = { 'tatame-staging': join(tmp, 'remote-staging.db'), 'tatame-restore-test': join(tmp, 'remote-rt.db') };
  const calls = [];
  const simExec = args => {
    calls.push(args.join(' '));
    assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === MIGRATIONS_CONFIG, 'usa a configuração isolada');
    const file = remoteDb[args[2]];
    const db = new DatabaseSync(file);
    try {
      if (args[1] === 'export') { writeFileSync(args[args.indexOf('--output') + 1], dumpSql(db)); return { status: 0, stdout: '' }; }
      if (args.includes('--file')) { db.exec(readFileSync(args[args.indexOf('--file') + 1], 'utf8')); return { status: 0, stdout: '[]' }; }
      const sql = args[args.indexOf('--command') + 1];
      // consulta única (SELECT ou PRAGMA de verificação) devolve linhas; lotes e escritas são executados inteiros, como no D1
      const single = !/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''));
      const isQuery = single && /^\s*(SELECT|PRAGMA (integrity_check|foreign_key_check))/i.test(sql);
      return { status: 0, stdout: JSON.stringify([{ results: isQuery ? db.prepare(sql).all() : (db.exec(sql), []), success: true }]) };
    } finally { db.close(); }
  };
  const out = [], err = [];
  const rdeps = { environments: () => envs, wranglerVersion: () => '4.155.0', exec: simExec, isTTY: () => false, ask: async () => '', out: m => out.push(m), err: m => err.push(m), env: { TATAME_BACKUP_DIR: store } };
  calls.length = 0;
  code = await main(['import', '--env', 'staging', '--backup', id, '--confirm-destination=tatame-staging'], rdeps);
  ok(code === 3 && calls.length === 0, 'import de backup com dados pessoais em staging pelo wrapper: recusado sem nenhum comando');
  code = await main(['import', '--env', 'staging', '--backup', anon.id], rdeps);
  ok(code === 3 && calls.length === 0, 'import sem --confirm-destination: recusado sem nenhum comando');
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging'], rdeps);
  ok(code === 0 && (() => { const d = new DatabaseSync(remoteDb['tatame-staging']); try { return analyze(d).counts.students; } finally { d.close(); } })() === origCounts.students, 'import do anonimizado em staging (vazio): contagens conferidas no destino');
  calls.length = 0;
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging'], rdeps);
  ok(code === 3 && calls.every(c => !c.includes('--file')), 'destino não vazio sem --replace: recusado antes de importar');
  code = await main(['import', '--env', 'staging', '--backup', anon.id, '--confirm-destination=tatame-staging', '--replace'], rdeps);
  ok(code === 0, 'destino não vazio com --replace explícito: substitui e confere');
  out.length = 0;
  code = await main(['restore-test', '--env', 'restore-test', '--backup', anon.id, '--confirm-destination=tatame-restore-test'], rdeps);
  ok(code === 0 && /ida e volta idêntica, Worker real/.test(out.join('\n')), 'restore-test: importa, reexporta, compara ida e volta e valida com o Worker real');
  ok(st.get(anon.id).manifest.restore_test?.ok === true, 'resultado do restore-test fica registrado no manifesto do backup');
  ok(!out.concat(err).join('\n').match(/@sintetico\.test|98877-|observação sintética/), 'nenhum dado pessoal impresso durante as operações');
  // falha simulada: o banco restaurado perde linhas -> restore-test reprova
  const brokenExec = args => { const r2 = simExec(args); if (args.includes('--file')) { const db = new DatabaseSync(remoteDb['tatame-restore-test']); db.exec('DELETE FROM attendance WHERE rowid % 2 = 0'); db.close(); } return r2; };
  code = await main(['restore-test', '--env', 'restore-test', '--backup', anon.id, '--confirm-destination=tatame-restore-test', '--replace'], { ...rdeps, exec: brokenExec, err: () => {} });
  ok(code !== 0 && st.get(anon.id).manifest.restore_test.ok === false, 'falha simulada (linhas perdidas na restauração): reprovado e registrado como reprovado no manifesto');
  console.log('\nBACKUP E RESTAURAÇÃO OK');
} finally { unfreezeClock(); try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('AVISO: limpeza do temporário: ' + e.code); } }
void MIGRATIONS_DIR; void applyLocal;
