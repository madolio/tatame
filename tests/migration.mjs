// Migração 001: aplica num banco no formato anterior (schema de antes da recuperação de senha), confere que nada se perde,
// que pode rodar duas vezes e que o .down.sql devolve o banco ao estado anterior.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const DB = makeD1();
// formato anterior = schema atual sem as tabelas da 001 e sem as travas da 003 (que são posteriores à 001)
DB.load(root + 'db/schema.sql'); DB.load(root + 'db/rollbacks/003_auditoria_e_ultimo_admin.down.sql'); DB.load(root + 'db/rollbacks/001_recuperacao_senha.down.sql');
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

// ---------- Migração 003: auditoria estruturada e trava do último admin ----------
console.log('\n-- 003 auditoria estruturada e último admin --');
{
  const M3 = root + 'db/migrations/003_auditoria_e_ultimo_admin.sql', R3 = root + 'db/rollbacks/003_auditoria_e_ultimo_admin.down.sql';
  const old = makeD1();
  for (const f of ['000_base.sql', '001_recuperacao_senha.sql', '002_marcador_de_chamada.sql']) old.load(root + 'db/migrations/' + f);
  const r = old.raw, q = (s, ...p) => r.prepare(s).all(...p);
  const acols = () => q("PRAGMA table_info('audit_log')").map(c => c.name);
  const trig = () => q("SELECT name FROM sqlite_master WHERE type = 'trigger'").map(t => t.name);
  const NEW = ['actor_id', 'target_type', 'target_id', 'outcome'];
  const fails = sql => { try { r.exec(sql); return null; } catch (e) { return String(e.message); } };
  ok(!NEW.some(c => acols().includes(c)) && !trig().length, 'banco no formato 002: sem as colunas novas e sem trigger');
  r.exec(`INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES ('adm1', 'Admin Um', 'a1@x.test', 'h', 's', 'admin'), ('prof', 'Prof', 'p@x.test', 'h', 's', 'professor');
    INSERT INTO audit_log (at, event, staff_id, detail) VALUES ('2026-01-01T00:00:00.000Z', 'login_ok', 'adm1', '{"rede":"203.0.113.1"}'),
      ('2026-01-02T00:00:00.000Z', 'staff_password_reset', 'adm1', '{"conta":"prof"}'), ('2026-01-03T00:00:00.000Z', 'reset_failed', NULL, NULL);`);
  const before = JSON.stringify(q('SELECT id, at, event, staff_id, detail FROM audit_log ORDER BY id'));
  old.load(M3);
  ok(NEW.every(c => acols().includes(c)) && q("PRAGMA table_info('audit_log')").filter(c => NEW.includes(c.name)).every(c => !c.notnull && c.dflt_value === null), 'migração cria actor_id, target_type, target_id e outcome, todas anuláveis e sem default');
  ok(acols().slice(0, 5).join() === 'id,at,event,staff_id,detail', 'colunas antigas preservadas (staff_id continua)');
  ok(JSON.stringify(q('SELECT id, at, event, staff_id, detail FROM audit_log ORDER BY id')) === before && q('SELECT count(*) n FROM audit_log WHERE actor_id IS NOT NULL OR target_type IS NOT NULL OR target_id IS NOT NULL OR outcome IS NOT NULL')[0].n === 0, 'registros antigos intactos e sem preenchimento retroativo');
  r.exec("INSERT INTO audit_log (event, staff_id, detail, actor_id, target_type, target_id, outcome) VALUES ('staff_role_changed', NULL, '{}', 'adm1', 'staff', 'prof', 'ok')");
  ok(q("SELECT actor_id, target_type, target_id, outcome FROM audit_log WHERE event = 'staff_role_changed'")[0].outcome === 'ok', 'registro novo usa os campos estruturados');
  ok(fails("INSERT INTO audit_log (event, target_type) VALUES ('x', 'senha')") && fails("INSERT INTO audit_log (event, outcome) VALUES ('x', 'talvez')"), 'target_type e outcome só aceitam os valores previstos (ou NULL)');
  ok(['staff', 'student', 'lesson', 'promotion', 'class', 'technique', 'rules', 'settings', 'export'].every(t => !fails(`INSERT INTO audit_log (event, target_type, outcome) VALUES ('t', '${t}', 'denied')`)) && !fails("INSERT INTO audit_log (event, outcome) VALUES ('t', 'limit')"), 'todos os target_type e outcome previstos são aceitos');
  r.exec("DELETE FROM audit_log WHERE event = 't'");
  const snap = () => JSON.stringify([q('SELECT * FROM audit_log ORDER BY id'), q("SELECT sql FROM sqlite_master WHERE name IN ('audit_log', 'staff_keep_active_admin', 'staff_keep_active_admin_on_delete') ORDER BY name")]);
  const s0 = snap();
  let again = null; try { old.load(M3); } catch (e) { again = String(e.message); }
  ok(/duplicate column/.test(again || '') && snap() === s0, 'segunda execução é recusada pelo SQLite (duplicate column) sem mudar nada (aplicar uma vez só, como a 002)');

  // ----- trigger -----
  const admins = () => q("SELECT count(*) n FROM staff WHERE role = 'admin' AND active = 1")[0].n;
  const e1 = fails("UPDATE staff SET active = 0 WHERE id = 'adm1'"), e2 = fails("UPDATE staff SET role = 'professor' WHERE id = 'adm1'");
  ok(/ultimo_admin_ativo/.test(e1 || '') && /ultimo_admin_ativo/.test(e2 || '') && admins() === 1, 'SQL direto: desativar ou rebaixar o único admin ativo é abortado pelo banco');
  ok(!/a1@x\.test|adm1|Admin Um/.test(e1 + e2), 'a mensagem do trigger não expõe dados da conta');
  ok(!fails("UPDATE staff SET role = 'professor', active = 0 WHERE id = 'adm1' AND 0") && !fails("UPDATE staff SET name = 'Admin Renomeado', belt = 'preta', pass_hash = 'h2' WHERE id = 'adm1'") && !fails("UPDATE staff SET role = 'admin', active = 1 WHERE id = 'adm1'"), 'último admin: nome, faixa, senha e reafirmar admin ativo continuam permitidos');
  ok(!fails("UPDATE staff SET active = 0 WHERE id = 'prof'") && !fails("UPDATE staff SET active = 1 WHERE id = 'prof'"), 'professores: desativar e reativar não são afetados');
  ok(!fails("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES ('adm2', 'Admin Dois', 'a2@x.test', 'h', 's', 'admin')") && admins() === 2, 'criar outro administrador é permitido');
  ok(!fails("UPDATE staff SET role = 'professor' WHERE id = 'adm2'") && admins() === 1, 'com outro admin ativo, rebaixar é permitido');
  r.exec("UPDATE staff SET role = 'admin' WHERE id = 'adm2'");
  ok(!fails("UPDATE staff SET active = 0 WHERE id = 'adm1'") && admins() === 1, 'com outro admin ativo, desativar é permitido');
  ok(/ultimo_admin_ativo/.test(fails("UPDATE staff SET active = 0 WHERE id = 'adm2'") || '') && admins() === 1, 'agora o restante é o último: desativá-lo é abortado');
  r.exec("UPDATE staff SET active = 1 WHERE id = 'adm1'");
  ok(/ultimo_admin_ativo/.test(fails("UPDATE staff SET role = 'professor' WHERE role = 'admin'") || '') && admins() === 2, 'rebaixar TODOS os admins num só comando: abortado inteiro (nenhuma linha muda)');
  ok(/ultimo_admin_ativo/.test(fails("BEGIN; UPDATE staff SET active = 0 WHERE id = 'adm1'; UPDATE staff SET active = 0 WHERE id = 'adm2'; COMMIT;") || '') && (r.exec('ROLLBACK'), admins() === 2), 'dois comandos na mesma transação: o segundo é abortado; com rollback, nada muda');

  // ----- trigger de DELETE (staff_keep_active_admin_on_delete) -----
  const row = id => JSON.stringify(q('SELECT * FROM staff WHERE id = ?', id));
  const nStaff = () => q('SELECT count(*) n FROM staff')[0].n;
  const addAdmin = (id, active = 1) => r.exec(`INSERT INTO staff (id, name, email, pass_hash, pass_salt, role, active) VALUES ('${id}', 'Admin ${id}', '${id}@x.test', 'h', 's', 'admin', ${active})`);
  ok(trig().sort().join() === 'staff_keep_active_admin,staff_keep_active_admin_on_delete', 'migração cria também a trava de exclusão');
  r.exec("UPDATE staff SET active = 0 WHERE id = 'adm2'"); // adm1 volta a ser o único admin ATIVO; adm2 fica admin inativo
  const adm1 = row('adm1'), auditRefs = q("SELECT count(*) n FROM audit_log WHERE staff_id = 'adm1'")[0].n;
  const d1 = fails("DELETE FROM staff WHERE id = 'adm1'");
  ok(/ultimo_admin_ativo/.test(d1 || '') && admins() === 1, 'SQL direto: excluir o único administrador ativo é abortado pelo banco');
  ok(row('adm1') === adm1 && q("SELECT count(*) n FROM audit_log WHERE staff_id = 'adm1'")[0].n === auditRefs, 'o registro do admin fica intacto (e o ON DELETE SET NULL da auditoria não chegou a rodar)');
  ok(!/a1@x\.test|adm1|Admin Um/.test(d1), 'a mensagem da trava de exclusão não expõe dados da conta');
  ok(!fails("DELETE FROM staff WHERE id = 'adm2'") && !q("SELECT 1 FROM staff WHERE id = 'adm2'").length && admins() === 1, 'excluir um administrador INATIVO é permitido (não reduz os admins ativos)');
  ok(!fails("DELETE FROM staff WHERE id = 'prof'") && !q("SELECT 1 FROM staff WHERE id = 'prof'").length && admins() === 1, 'excluir um professor é permitido');
  addAdmin('adm2');
  ok(!fails("DELETE FROM staff WHERE id = 'adm2'") && admins() === 1 && row('adm1') === adm1, 'com outro admin ativo, excluir um administrador ativo é permitido');
  addAdmin('adm2'); addAdmin('adm3'); r.exec("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES ('prof', 'Prof', 'p@x.test', 'h', 's', 'professor')");
  const all = JSON.stringify(q('SELECT * FROM staff ORDER BY id'));
  ok(/ultimo_admin_ativo/.test(fails("DELETE FROM staff WHERE role = 'admin'") || '') && JSON.stringify(q('SELECT * FROM staff ORDER BY id')) === all, 'excluir TODOS os admins ativos num só comando: abortado inteiro (nenhuma linha some)');
  ok(/ultimo_admin_ativo/.test(fails('DELETE FROM staff') || '') && JSON.stringify(q('SELECT * FROM staff ORDER BY id')) === all && nStaff() === 4, 'DELETE FROM staff sem WHERE: abortado inteiro, nem o professor é apagado');
  ok(/ultimo_admin_ativo/.test(fails("BEGIN; DELETE FROM staff WHERE id = 'adm1'; DELETE FROM staff WHERE id = 'adm2'; DELETE FROM staff WHERE id = 'adm3'; COMMIT;") || '') && (r.exec('ROLLBACK'), JSON.stringify(q('SELECT * FROM staff ORDER BY id')) === all), 'exclusões em sequência na mesma transação: a última é abortada; com rollback, nada muda');
  ok(/ultimo_admin_ativo/.test(fails("BEGIN; UPDATE staff SET active = 0 WHERE id IN ('adm2', 'adm3'); DELETE FROM staff WHERE id = 'adm1'; COMMIT;") || '') && (r.exec('ROLLBACK'), admins() === 3), 'desativar os outros e depois excluir o restante: a exclusão é abortada (as duas travas se somam)');
  r.exec("DELETE FROM staff WHERE id = 'adm3'; UPDATE staff SET role = 'admin', active = 1 WHERE id = 'adm2'");
  ok(admins() === 2 && nStaff() === 3, 'estado de volta ao da seção anterior (adm1 e adm2 admins ativos, prof professor)');
  const empty = makeD1(); empty.load(root + 'db/schema.sql');
  empty.raw.exec("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES ('first', 'Primeiro Admin', 'f@x.test', 'h', 's', 'admin')");
  ok(empty.raw.prepare("SELECT count(*) n FROM staff WHERE role = 'admin' AND active = 1").get().n === 1, 'criar o primeiro administrador num banco vazio é permitido (sem trava de INSERT)');

  // ----- reversão -----
  const kept = JSON.stringify(q('SELECT id, at, event, staff_id, detail FROM audit_log ORDER BY id'));
  const nAudit = q('SELECT count(*) n FROM audit_log')[0].n;
  old.load(R3);
  ok(!trig().length, 'reversão remove os dois triggers (UPDATE e DELETE)');
  ok(acols().join() === 'id,at,event,staff_id,detail', 'reversão remove só as 4 colunas novas');
  ok(JSON.stringify(q('SELECT id, at, event, staff_id, detail FROM audit_log ORDER BY id')) === kept && q('SELECT count(*) n FROM audit_log')[0].n === nAudit, 'reversão não apaga nem altera registros de auditoria');
  ok(!fails("UPDATE staff SET role = 'professor' WHERE id = 'adm2'") && !fails("UPDATE staff SET active = 0 WHERE id = 'adm1'"), 'sem o trigger, o banco volta a aceitar (comportamento anterior à 003)');
  r.exec("UPDATE staff SET active = 1 WHERE id = 'adm1'");
  r.exec('BEGIN'); const delOk = !fails("DELETE FROM staff WHERE id = 'adm1'") && admins() === 0; r.exec('ROLLBACK');
  ok(delOk && admins() === 1, 'sem o trigger de DELETE, excluir o último admin volta a ser aceito (testado em transação desfeita)');
  old.load(M3);
  ok(NEW.every(c => acols().includes(c)) && trig().sort().join() === 'staff_keep_active_admin,staff_keep_active_admin_on_delete' && /ultimo_admin_ativo/.test(fails("UPDATE staff SET active = 0 WHERE id = 'adm1'") || '') && /ultimo_admin_ativo/.test(fails("DELETE FROM staff WHERE id = 'adm1'") || ''), 'a migração pode ser reaplicada depois da reversão (colunas e as duas travas de volta)');
}

// ---------- Cadeia 000 + 001 + 002 + 003 = db/schema.sql ----------
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
    out.$triggers = q("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map(x => ({ ...x, sql: x.sql.replace(/\s+/g, ' ').trim() }));
    return out;
  };
  const chain = makeD1();
  for (const f of fs.readdirSync(root + 'db/migrations').filter(f => f.endsWith('.sql')).sort()) chain.load(root + 'db/migrations/' + f);
  const ref = makeD1(); ref.load(root + 'db/schema.sql');
  const a = shape(chain), b = shape(ref);
  ok(JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()), `cadeia e schema.sql têm as mesmas tabelas (${Object.keys(b).length - 1})`);
  for (const t of Object.keys(b)) assert.deepStrictEqual(a[t], b[t], 'diferença na tabela ' + t);
  assert.deepStrictEqual(a.$triggers, b.$triggers);
  ok(a.$triggers.map(t => t.name).join() === 'staff_keep_active_admin,staff_keep_active_admin_on_delete', 'cadeia e schema.sql têm os mesmos dois triggers (UPDATE e DELETE, texto idêntico)');
  ok(true, 'cadeia 000..003 é idêntica a db/schema.sql (colunas, tipos, NOT NULL, defaults, CHECK, FKs, índices, triggers, dados-semente)');
  ok(fs.readdirSync(root + 'db/migrations').every(f => !f.includes('.down.')), 'nenhum arquivo de reversão em db/migrations/');
  const base = makeD1(); base.load(root + 'db/migrations/000_base.sql');
  const hist = makeD1(); hist.raw.exec((await import('node:child_process')).execSync('git show 17f1fbd:db/schema.sql', { cwd: root, encoding: 'utf8' }));
  assert.deepStrictEqual(shape(base), shape(hist)); ok(true, '000_base.sql reproduz exatamente o schema de 17f1fbd');
}

console.log('\nMIGRAÇÃO OK');
