// Etapa 6.5-A: banco sintético nas três variantes, em especial --base (formato 17f1fbd, sem d1_migrations: o estado da
// produção hoje). Ensaia offline o caminho real da produção: baseline -> baseline-register -> migrate (001, 002, 003) ->
// check. Também confere que o backup sintético é verificável (é o que vai para staging/restore-test).
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syntheticSql } from '../tools/db-synthetic.mjs';
import { buildManifest, verifyContent } from '../tools/db/backup.mjs';
import { analyze } from '../tools/db/dump.mjs';
import { loadSql } from '../tools/db/dump.mjs';
import { main } from '../tools/db/ops.mjs';
import { migrationFiles } from '../tools/db/schema.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-synth-'));
const local = async (...argv) => { const out = [], err = []; const code = await main(argv, { environments: () => ({ local: { kind: 'local' } }), wranglerVersion: () => 'x', exec: () => { throw new Error('não deveria chamar o wrangler'); }, isTTY: () => false, ask: async () => '', out: m => out.push(m), err: m => err.push(m), env: {} }); return { code, out: out.join('\n'), err: err.join('\n') }; };
const toFile = (name, sql) => { const f = join(tmp, name + '.db'); const src = loadSql(sql), db = new DatabaseSync(f); try { db.exec(sql); } finally { db.close(); src.close(); } return f; };

try {
  const base = await syntheticSql('base');
  const m = buildManifest(base, { source_env: 'sintetico-base', source_database: 'cenario-sintetico-etapa4', wrangler: 'n/a', anonymized: true });
  const v = verifyContent(base, m);
  ok(v.ok && m.migrations.length === 0 && !/d1_migrations/.test(base), '--base: sem d1_migrations, verificável e com o schema esperado de 000_base (17f1fbd)');
  ok(!/password_resets|audit_log|roll_called/.test(base), '--base: sem as estruturas das migrações 001, 002 e 003');
  { const db = loadSql(base); const a = analyze(db); db.close(); ok(a.counts.students > 0 && a.counts.attendance > 0 && a.counts.staff > 0, `--base: com dados sintéticos (${a.counts.students} alunos, ${a.counts.attendance} presenças)`); }
  const f = toFile('base', base);
  let r = await local('migrate', '--env', 'local', '--sqlite', f);
  ok(r.code === 3 && /baseline/.test(r.err), 'migrate direto no formato 17f1fbd é recusado (exige baseline antes): nada aplicado');
  r = await local('baseline', '--env', 'local', '--sqlite', f);
  ok(r.code === 0 && /veredito: identica/.test(r.out), 'baseline: idêntica a 17f1fbd');
  r = await local('baseline-register', '--env', 'local', '--sqlite', f, '--confirm-baseline=000_base.sql');
  ok(r.code === 0 && /registrada: 000_base\.sql/.test(r.out), 'baseline-register: só 000_base registrada');
  r = await local('migrate', '--env', 'local', '--sqlite', f);
  ok(r.code === 0 && /aplicada: 001_recuperacao_senha\.sql/.test(r.out) && /aplicada: 002_marcador_de_chamada\.sql/.test(r.out) && /aplicada: 003_auditoria_e_ultimo_admin\.sql/.test(r.out), 'migrate: aplica 001, 002 e 003, nesta ordem');
  r = await local('check', '--env', 'local', '--sqlite', f);
  ok(r.code === 0 && new RegExp(`registradas: ${migrationFiles().join(', ')}`).test(r.out), 'check depois: as 4 registradas, schema esperado, integridade e FKs ok');
  r = await local('migrate', '--env', 'local', '--sqlite', f);
  ok(r.code === 0 && /nenhuma migração pendente/.test(r.out), 'migrate de novo: nada pendente (sem aplicação duplicada)');
  { const db = new DatabaseSync(f); const n = db.prepare('SELECT count(*) n FROM students').get().n, t = db.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'staff_keep_active_admin%'").get().n; db.close();
    ok(n === analyze(loadSql(base)).counts.students && t === 2, 'dados preservados pela migração e os dois gatilhos do último admin presentes'); }

  const s2 = await syntheticSql('sem-002');
  const m2 = buildManifest(s2, { source_env: 'sintetico-sem002', source_database: 'x', wrangler: 'n/a', anonymized: true });
  ok(verifyContent(s2, m2).ok && m2.migrations.join() === '000_base.sql,001_recuperacao_senha.sql', '--sem-002 continua igual: 000 e 001 registradas');
  const full = await syntheticSql('completo');
  const mf = buildManifest(full, { source_env: 'sintetico', source_database: 'x', wrangler: 'n/a', anonymized: true });
  ok(verifyContent(full, mf).ok && mf.migrations.length === 4, 'completo continua igual: 000 a 003 registradas');
  await assert.rejects(syntheticSql('outra'), /variante desconhecida/); ok(true, 'variante desconhecida recusada');
  console.log('\nSINTÉTICO OK');
} finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: arquivo aberto após falha */ } }
