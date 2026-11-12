// Migração 001: aplica num banco no formato anterior (schema de antes da recuperação de senha), confere que nada se perde,
// que pode rodar duas vezes e que o .down.sql devolve o banco ao estado anterior.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const DB = makeD1();
DB.load(root + 'db/schema.sql'); DB.load(root + 'db/migrations/001_recuperacao_senha.down.sql'); // formato anterior = schema atual sem as tabelas da 001
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
DB.load(root + 'db/migrations/001_recuperacao_senha.down.sql');
ok(!tables().includes('password_resets') && !tables().includes('audit_log'), 'reversão remove as tabelas novas');
ok(DB.raw.prepare('SELECT count(*) n FROM staff').get().n === 1, 'reversão preserva contas e demais dados');
const fresh = makeD1(); fresh.load(root + 'db/schema.sql');
ok(['password_resets', 'audit_log'].every(t => fresh.raw.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t)), 'schema.sql novo já inclui as tabelas');
console.log('\nMIGRAÇÃO OK');
