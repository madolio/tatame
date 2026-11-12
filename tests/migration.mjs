// Migração 001: aplica num banco no formato anterior (schema de antes da recuperação de senha), confere que nada se perde,
// que pode rodar duas vezes e que o .down.sql devolve o banco ao estado anterior.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const DB = makeD1();
DB.load(root + 'db/schema.sql'); DB.load(root + 'db/rollbacks/001_recuperacao_senha.down.sql'); // formato anterior = schema atual sem as tabelas da 001
const tables = () => DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };

ok(!tables().includes('password_resets') && !tables().includes('audit_log'), 'banco anterior não tem as tabelas novas');
DB.raw.exec("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES ('s1', 'Admin', 'a@x.com', 'h', 's', 'admin')");
DB.load(root + 'db/migrations/001_recuperacao_senha.sql');
ok(tables().includes('password_resets') && tables().includes('audit_log'), 'migração cria as duas tabelas');
ok(DB.raw.prepare('SELECT count(*) n FROM staff').get().n === 1, 'migração não mexe nos dados existentes');
DB.load(root + 'db/migrations/001_recuperacao_senha.sql');
ok(true, 'migração pode rodar de novo sem erro');
DB.raw.exec("INSERT INTO password_resets (staff_id, code_hash, expires_at) VALUES ('s1', 'x', '2099-01-01T00:00:00Z')");
DB.raw.exec("DELETE FROM staff WHERE id = 's1'");
ok(DB.raw.prepare('SELECT count(*) n FROM password_resets').get().n === 0, 'apagar a conta apaga o código pendente (chave estrangeira)');
DB.raw.exec("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES ('s1', 'Admin', 'a@x.com', 'h', 's', 'admin')");
DB.load(root + 'db/rollbacks/001_recuperacao_senha.down.sql');
ok(!tables().includes('password_resets') && !tables().includes('audit_log'), 'reversão remove as tabelas novas');
ok(DB.raw.prepare('SELECT count(*) n FROM staff').get().n === 1, 'reversão preserva contas e demais dados');
const fresh = makeD1(); fresh.load(root + 'db/schema.sql');
ok(['password_resets', 'audit_log'].every(t => fresh.raw.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t)), 'schema.sql novo já inclui as tabelas');
// ---------- Migração 002: marcador de chamada (lessons.roll_called) ----------
console.log('\n-- 002 marcador de chamada --');
const cols = () => DB.raw.prepare("PRAGMA table_info('lessons')").all().map(r => r.name);
DB.load(root + 'db/rollbacks/002_marcador_de_chamada.down.sql'); // banco anterior = sem a coluna
ok(!cols().includes('roll_called'), 'banco anterior não tem lessons.roll_called');
DB.raw.exec("INSERT INTO students (id, name, start_date, belt_since, degree_since) VALUES ('a1', 'Aluno', '2026-01-01', '2026-01-01', '2026-01-01')");
DB.raw.exec("INSERT INTO lessons (id, date, start_time, end_time) VALUES ('l-com', '2026-06-01', '19:00', '20:00'), ('l-sem', '2026-06-02', '19:00', '20:00')");
DB.raw.exec("INSERT INTO attendance (lesson_id, student_id) VALUES ('l-com', 'a1')");
DB.load(root + 'db/migrations/002_marcador_de_chamada.sql');
ok(cols().includes('roll_called'), 'migração cria lessons.roll_called');
const rc = id => DB.raw.prepare('SELECT roll_called r FROM lessons WHERE id = ?').get(id).r;
ok(rc('l-com') === 1, 'backfill: aula com presença vira chamada feita (evidência confiável)');
ok(rc('l-sem') === null, 'backfill: aula sem presença continua desconhecida (não é classificada como sem chamada)');
let twice = false; try { DB.load(root + 'db/migrations/002_marcador_de_chamada.sql'); } catch { twice = true; }
ok(twice, 'segunda execução é recusada pelo SQLite (aplicar uma vez só, como documentado)');
ok(DB.raw.prepare('SELECT count(*) n FROM lessons').get().n === 2 && DB.raw.prepare('SELECT count(*) n FROM attendance').get().n === 1, 'migração não perde aulas nem presenças');
let bad2 = false; try { DB.raw.exec("UPDATE lessons SET roll_called = 2 WHERE id = 'l-sem'"); } catch { bad2 = true; }
ok(bad2, 'só aceita 0, 1 ou NULL');
DB.load(root + 'db/rollbacks/002_marcador_de_chamada.down.sql');
ok(!cols().includes('roll_called') && DB.raw.prepare('SELECT count(*) n FROM lessons').get().n === 2, 'reversão remove a coluna e preserva as aulas');
ok(fresh.raw.prepare("PRAGMA table_info('lessons')").all().some(r => r.name === 'roll_called'), 'schema.sql novo já inclui a coluna');

// ---------- Cadeia 000 + 001 + 002 = db/schema.sql ----------
console.log('\n-- cadeia de migrações --');
{
  const fs = await import('node:fs');
  const checks = sql => { const out = []; const re = /CHECK\s*\(/gi; let m; while ((m = re.exec(sql))) { let d = 1, i = re.lastIndex; while (d && i < sql.length) { if (sql[i] === '(') d++; else if (sql[i] === ')') d--; i++; } out.push(sql.slice(re.lastIndex, i - 1).replace(/\s+/g, ' ').trim()); } return out.sort(); };
  const shape = db => {
    const r = db.raw, q = s => r.prepare(s).all();
    const out = {};
    for (const t of q("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
      out[t.name] = {
        cols: q(`PRAGMA table_xinfo('${t.name}')`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
        fks: q(`PRAGMA foreign_key_list('${t.name}')`).map(f => [f.table, f.from, f.to, f.on_delete]).sort(),
        idx: q(`PRAGMA index_list('${t.name}')`).filter(i => i.origin === 'c').map(i => [i.name, i.unique, i.partial, q(`PRAGMA index_info('${i.name}')`).map(c => c.name).join(',')]).sort(),
        checks: checks(t.sql)
      };
    }
    out.$seed = { rules: q('SELECT * FROM rules ORDER BY belt'), settings: q('SELECT * FROM settings ORDER BY key') };
    return out;
  };
  const chain = makeD1();
  for (const f of fs.readdirSync(root + 'db/migrations').filter(f => f.endsWith('.sql')).sort()) chain.load(root + 'db/migrations/' + f);
  const ref = makeD1(); ref.load(root + 'db/schema.sql');
  const a = shape(chain), b = shape(ref);
  ok(JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()), `cadeia e schema.sql têm as mesmas tabelas (${Object.keys(b).length - 1})`);
  for (const t of Object.keys(b)) assert.deepStrictEqual(a[t], b[t], 'diferença na tabela ' + t);
  ok(true, 'cadeia 000+001+002 é idêntica a db/schema.sql (colunas, tipos, NOT NULL, defaults, CHECK, FKs, índices, dados-semente)');
  ok(fs.readdirSync(root + 'db/migrations').every(f => !f.includes('.down.')), 'nenhum arquivo de reversão em db/migrations/');
  const base = makeD1(); base.load(root + 'db/migrations/000_base.sql');
  const hist = makeD1(); hist.raw.exec((await import('node:child_process')).execSync('git show 17f1fbd:db/schema.sql', { cwd: root, encoding: 'utf8' }));
  assert.deepStrictEqual(shape(base), shape(hist)); ok(true, '000_base.sql reproduz exatamente o schema de 17f1fbd');
}

console.log('\nMIGRAÇÃO OK');
