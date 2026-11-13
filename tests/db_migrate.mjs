// Operação migrate e configuração isolada do wrangler.
// Local: SQLite real. Remoto: um simulador do wrangler sobre SQLite real, que confere os argumentos recebidos
// (-c db/wrangler.migrations.jsonc --env <ambiente>) e executa as consultas de verdade. Nenhum acesso à rede.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, ROOT, MIGRATIONS_CONFIG, loadEnvironments } from '../tools/db/ops.mjs';
import { checkMigrationsConfig, applyLocal } from '../tools/db/ops-migrate.mjs';
import { MIGRATIONS_DIR, MIGRATIONS_TABLE_DDL, migrationFiles } from '../tools/db/schema.mjs';
import { PROD, infoReply, migrationsCfg, identityCfg, evidenceDir } from './cf_sim.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-migrate-'));
const sqlOf = n => readFileSync(MIGRATIONS_DIR + n, 'utf8');
const q = (f, s) => { const db = new DatabaseSync(f); try { return db.prepare(s).all(); } finally { db.close(); } };
const applied = f => q(f, 'SELECT name FROM d1_migrations ORDER BY id').map(r => r.name);
const make = (name, ...sqls) => { const f = join(tmp, name + '.db'); const db = new DatabaseSync(f); for (const s of sqls) db.exec(s); db.close(); return f; };
const register = (f, ...names) => { const db = new DatabaseSync(f); db.exec(MIGRATIONS_TABLE_DDL); for (const n of names) db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n); db.close(); };

const localDeps = () => { const out = [], err = []; return { out, err, d: { environments: () => ({ local: { kind: 'local' } }), wranglerVersion: () => 'x', exec: () => { throw new Error('não deveria chamar o wrangler'); }, isTTY: () => false, ask: async () => '', out: m => out.push(m), err: m => err.push(m) } }; };
const runLocal = async (...argv) => { const h = localDeps(); h.code = await main(argv, h.d); return h; };

try {
  // ---------- configuração isolada ----------
  const cfgText = readFileSync(MIGRATIONS_CONFIG, 'utf8');
  ok(!/pages_build_output_dir"\s*:/.test(cfgText.replace(/^\s*\/\/.*$/gm, '')), 'db/wrangler.migrations.jsonc não tem pages_build_output_dir');
  ok(checkMigrationsConfig(loadEnvironments()).length === 0, 'db/wrangler.migrations.jsonc espelha db/environments.json (nomes e IDs, migrations_dir, tabela)');
  const bad = cfgText.replace('"name": "tatame-db-ops",', '"name": "tatame-db-ops", "pages_build_output_dir": "web",');
  ok(checkMigrationsConfig(loadEnvironments(), bad).some(p => /pages_build_output_dir/.test(p)), 'a conferência acusa pages_build_output_dir se alguém o adicionar');
  const wr = d => readdirSync(d).filter(f => /^wrangler\.(toml|json|jsonc)$/i.test(f));
  ok(wr(ROOT).length === 0 && wr(ROOT + 'web').length === 0, 'não existe wrangler.toml/json/jsonc na raiz nem em web/ (bindings do Pages continuam no painel)');

  // ---------- local: banco vazio ----------
  const empty = join(tmp, 'vazio.db');
  let h = await runLocal('migrate', '--env', 'local', '--sqlite', empty);
  ok(h.code === 0 && applied(empty).join() === migrationFiles().join(), 'banco vazio: aplica e registra 000 a 003');
  ok(q(empty, "PRAGMA table_info('lessons')").some(c => c.name === 'roll_called') && q(empty, 'SELECT count(*) n FROM rules')[0].n > 0, 'banco vazio migrado tem o schema final e os dados-semente');
  h = await runLocal('migrate', '--env', 'local', '--sqlite', empty);
  ok(h.code === 0 && /nenhuma migração pendente/.test(h.out.join('\n')) && applied(empty).length === migrationFiles().length, 'segunda execução: nada pendente, nada reaplicado');

  // ---------- local: produção simulada (base registrada) ----------
  const prod = make('prod', sqlOf('000_base.sql'), "INSERT INTO students (id, name, start_date, belt_since, degree_since) VALUES ('s1','Aluno','2026-01-01','2026-01-01','2026-01-01')", "INSERT INTO lessons (id, date, start_time, end_time) VALUES ('l1','2026-02-01','19:00','20:00'),('l2','2026-02-02','19:00','20:00')", "INSERT INTO attendance (lesson_id, student_id) VALUES ('l1','s1')");
  h = await runLocal('migrate', '--env', 'local', '--sqlite', prod);
  ok(h.code === 3 && /baseline-register/.test(h.err.join('\n')) && !q(prod, "SELECT name FROM sqlite_schema WHERE name='d1_migrations'").length, 'banco com dados e sem linha de base: recusa e não cria nada');
  register(prod, '000_base.sql');
  h = await runLocal('migrate', '--env', 'local', '--sqlite', prod);
  ok(h.code === 0 && applied(prod).join() === migrationFiles().join(), 'base registrada: aplica só 001 a 003');
  ok(q(prod, "SELECT roll_called r FROM lessons ORDER BY id").map(r => r.r).join() === '1,', 'backfill da 002 preservado (aula com presença = 1, sem presença = NULL)');
  ok(q(prod, 'SELECT count(*) n FROM students')[0].n === 1 && q(prod, 'SELECT count(*) n FROM attendance')[0].n === 1, 'dados preservados');

  // ---------- 002 aplicada à mão, sem registro ----------
  const manual = make('manual', sqlOf('000_base.sql'), sqlOf('001_recuperacao_senha.sql'), sqlOf('002_marcador_de_chamada.sql'));
  register(manual, '000_base.sql', '001_recuperacao_senha.sql');
  h = await runLocal('migrate', '--env', 'local', '--sqlite', manual);
  ok(h.code === 3 && /coluna adicional: lessons.roll_called/.test(h.err.join('\n')) && applied(manual).length === 2, '002 com coluna já existente e sem registro: verificação prévia recusa, nada é registrado (sem idempotência falsa)');
  // e se alguém tentasse aplicar a 002 de novo por fora, o SQLite recusa (segunda trava)
  assert.throws(() => { const db = new DatabaseSync(manual); try { db.exec(sqlOf('002_marcador_de_chamada.sql')); } finally { db.close(); } }, /duplicate column/);
  ok(true, 'reexecutar a 002 diretamente falha no próprio SQLite (duplicate column)');

  // ---------- falha no meio: migração revertida, anteriores mantidas, sem reversão silenciosa ----------
  const half = make('half', sqlOf('000_base.sql')); register(half, '000_base.sql');
  { const db = new DatabaseSync(half); const src = { exec: s => db.exec(s) };
    assert.throws(() => applyLocal(src, ['001_recuperacao_senha.sql', '../rollbacks/nao-existe.sql'], () => {}), /ENOENT|no such file/);
    db.close(); }
  ok(applied(half).join() === '000_base.sql,001_recuperacao_senha.sql', 'falha numa migração: ela não é registrada e as anteriores continuam aplicadas (mesmo comportamento do wrangler)');
  const failing = make('failing', sqlOf('000_base.sql')); register(failing, '000_base.sql');
  { const db = new DatabaseSync(failing); const src = { exec: s => db.exec(s) };
    const realRead = sqlOf('002_marcador_de_chamada.sql');
    db.exec(sqlOf('001_recuperacao_senha.sql')); db.prepare("INSERT INTO d1_migrations (name) VALUES ('001_recuperacao_senha.sql')").run();
    db.exec('ALTER TABLE lessons ADD COLUMN roll_called INTEGER'); // estado que faz a 002 falhar no meio
    assert.throws(() => applyLocal(src, ['002_marcador_de_chamada.sql'], () => {}), /revertida/);
    db.close(); void realRead; }
  ok(applied(failing).join() === '000_base.sql,001_recuperacao_senha.sql', 'migração que falha no meio é revertida inteira e não fica registrada');

  // ---------- reversões ainda funcionam a partir de db/rollbacks/ ----------
  const rb = make('rb', ...migrationFiles().map(sqlOf));
  { const db = new DatabaseSync(rb); db.exec(readFileSync(ROOT + 'db/rollbacks/003_auditoria_e_ultimo_admin.down.sql', 'utf8')); db.exec(readFileSync(ROOT + 'db/rollbacks/002_marcador_de_chamada.down.sql', 'utf8')); db.exec(readFileSync(ROOT + 'db/rollbacks/001_recuperacao_senha.down.sql', 'utf8')); db.close(); }
  h = await runLocal('baseline', '--env', 'local', '--sqlite', rb);
  ok(/veredito: identica/.test(h.out.join('\n')), 'aplicar os rollbacks 003, 002 e 001 volta exatamente ao schema de 000_base (17f1fbd)');

  // ---------- remoto simulado ----------
  const ID = '11111111-1111-4111-8111-111111111111';
  const envs = { staging: { kind: 'remote', database_name: 'tatame-staging', database_id: ID }, production: PROD };
  const cfg = migrationsCfg(envs);
  const acc = { 'tatame-staging': ID, [PROD.database_name]: PROD.database_id };
  const remoteFile = make('remote', sqlOf('000_base.sql')); register(remoteFile, '000_base.sql');
  const calls = [];
  const sim = args => {
    calls.push(args);
    const info = infoReply(args, { account: acc, cfgEnvs: envs }); if (info) return info;
    const ci = args.indexOf('-c'), ei = args.indexOf('--env');
    assert.ok(ci > 0 && args[ci + 1] === MIGRATIONS_CONFIG && args[ei + 1] === 'staging', 'todo comando de banco usa -c db/wrangler.migrations.jsonc --env staging');
    if (args[1] === 'time-travel') return { status: 0, stdout: JSON.stringify({ bookmark: '0000abcd-teste' }) };
    if (args[1] === 'migrations') { const db = new DatabaseSync(remoteFile); try { const done = db.prepare('SELECT name FROM d1_migrations').all().map(r => r.name); applyLocal({ exec: s => db.exec(s) }, migrationFiles().filter(f => !done.includes(f)), () => {}); } finally { db.close(); } return { status: 0, stdout: '' }; }
    const sql = args[args.indexOf('--command') + 1];
    // Como o D1 real (ensaio 6.5-B, 2026-11-13): PRAGMA integrity_check é recusado com erro 7500.
    if (/^\s*PRAGMA\s+integrity_check/i.test(sql)) return { status: 1, stdout: '', stderr: JSON.stringify({ error: { text: 'not authorized', code: 7500 } }) };
    const db = new DatabaseSync(remoteFile);
    try { return { status: 0, stdout: JSON.stringify([{ results: /^\s*(SELECT|PRAGMA)/i.test(sql) ? db.prepare(sql).all() : (db.exec(sql), []), success: true, meta: {} }]) }; } finally { db.close(); }
  };
  const sqlCalls = () => calls.filter(a => a.includes('--command')).map(a => a[a.indexOf('--command') + 1]);
  const out = [], err = [];
  const rd = { environments: () => envs, migrationsConfigText: () => cfg, identityConfigText: identityCfg, env: { TATAME_EVIDENCE_DIR: evidenceDir() }, wranglerVersion: () => '4.155.0', exec: sim, isTTY: () => false, ask: async () => '', out: m => out.push(m), err: m => err.push(m) };
  let code = await main(['migrate', '--env', 'staging'], rd);
  ok(code === 0 && applied(remoteFile).join() === migrationFiles().join(), 'remoto (simulado): aplica pendentes via `wrangler d1 migrations apply` e confere o registro depois');
  ok(/bookmark do Time Travel ANTES da migração: 0000abcd-teste/.test(out.join('\n')), 'remoto: mostra o bookmark do Time Travel antes de aplicar');
  ok(calls.some(a => a.slice(0, 3).join(' ') === 'd1 migrations apply') && /OK: registradas/.test(out.join('\n')), 'remoto: verificação posterior (registro, schema, integridade) executada');
  // Regressão do ensaio 6.5-B: no D1 remoto a integridade vai por quick_check (integrity_check é recusado com 7500).
  ok(sqlCalls().some(s => /PRAGMA quick_check/.test(s)) && !sqlCalls().some(s => /integrity_check/.test(s)), 'remoto (migrate): integridade por PRAGMA quick_check; integrity_check nunca é enviado ao D1');
  calls.length = 0; out.length = 0;
  code = await main(['check', '--env', 'staging'], rd);
  ok(code === 0 && /quick_check \(D1\): ok/.test(out.join('\n')) && sqlCalls().some(s => /PRAGMA quick_check/.test(s)) && !sqlCalls().some(s => /integrity_check/.test(s)), 'remoto (check): PRAGMA quick_check aceito, integrity_check nunca enviado; veredito OK');
  { const h = await runLocal('check', '--env', 'local', '--sqlite', remoteFile);
    ok(h.code === 0 && /\] integrity_check: ok/.test(h.out.join('\n')), 'local (check): SQLite comum continua com PRAGMA integrity_check completo'); }
  { // sem a correção: o mesmo banco remoto recusando integrity_check faz o check falhar (prova que o simulador reproduz o D1)
    const r = sim(['d1', 'execute', 'tatame-staging', '--remote', '-c', MIGRATIONS_CONFIG, '--env', 'staging', '--json', '--yes', '--command', 'PRAGMA integrity_check']);
    ok(r.status === 1 && /7500/.test(r.stderr), 'simulador do D1 recusa PRAGMA integrity_check com erro 7500, como o D1 real'); }
  calls.length = 0;
  // config divergente do environments.json: recusa sem chamar nada
  calls.length = 0;
  code = await main(['migrate', '--env', 'staging'], { ...rd, migrationsConfigText: () => cfg.replace(ID, '99999999-9999-4999-8999-999999999999') });
  ok(code === 3 && calls.length === 0, 'configuração isolada com ID diferente de environments.json: recusa sem executar nada');
  // pós-verificação que falha (o "apply" diz sucesso mas não registra): erro, sem reversão automática
  const lying = make('lying', sqlOf('000_base.sql')); register(lying, '000_base.sql');
  const sim2 = args => infoReply(args, { account: acc, cfgEnvs: envs }) || (args[1] === 'migrations' ? { status: 0, stdout: '' } : (() => { const db = new DatabaseSync(lying); try { const sql = args[args.indexOf('--command') + 1]; return { status: 0, stdout: JSON.stringify(args[1] === 'time-travel' ? { bookmark: 'b' } : [{ results: db.prepare(sql).all(), success: true }]) }; } finally { db.close(); } })());
  const err2 = [];
  code = await main(['migrate', '--env', 'staging'], { ...rd, exec: sim2, err: m => err2.push(m) });
  ok(code === 1 && /Verificação POSTERIOR falhou/.test(err2.join('\n')) && /Não houve reversão automática/.test(err2.join('\n')), 'comando com código 0 mas banco não migrado: a verificação posterior acusa; nada é revertido em silêncio');
  console.log('\nMIGRATE OK');
} finally { rmSync(tmp, { recursive: true, force: true }); }
