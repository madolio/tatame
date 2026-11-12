// Etapa 6.1 (V1): primeiro acesso só com código de ativação válido, consumo atômico, um único administrador inicial.
// Worker real + shim do D1 (node:sqlite). Dados sintéticos; nada acessa a rede.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, setupHash, buildSetupSql } from '../tools/setup-token.mjs';
import { run as setupTool, SetupToolError } from '../tools/setup-code.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-setup-test-'));
const seen = [];                                   // tudo o que o Worker respondeu (para procurar código/hash)
const logs = [];
const origErr = console.error, origLog = console.log;
console.error = (...a) => { logs.push(a.join(' ')); };

const fresh = (file = ':memory:') => { const DB = makeD1(file); DB.load(SCHEMA); return DB; };
const client = DB => {
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  return async (method, path, body, { raw = false, cookie = '' } = {}) => {
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) }), env);
    const text = await r.text(); seen.push(text);
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
};
const form = (code, extra = {}) => ({ academy_name: 'Academia Nova', name: 'Responsável', email: 'dono@x.test', password: 'senhaforte1', setup_code: code, ...extra });
const count = (DB, sql) => DB.raw.prepare(sql).get().n;
const staffN = DB => count(DB, 'SELECT count(*) n FROM staff');
const tokenN = DB => count(DB, "SELECT count(*) n FROM settings WHERE key IN ('setup_token', 'setup_token_hash', 'setup_token_expires')");

try {
  // ================= sem código configurado: setup fechado =================
  { const DB = fresh(), call = client(DB);
    const st = await call('GET', '/api/status');
    ok(st.body.setup_needed && st.body.setup_code_required, 'instalação nova: /api/status pede código (sempre, mesmo sem código configurado)');
    ok((await call('POST', '/api/setup', form(undefined))).status === 403 && staffN(DB) === 0, 'sem código configurado e sem código enviado: 403, ninguém criado');
    ok((await call('POST', '/api/setup', form(generateCode()))).status === 403 && staffN(DB) === 0, 'sem código configurado, com um código qualquer: 403');
    DB.raw.exec("INSERT INTO settings (key, value) VALUES ('setup_token', 'K7Q2-TATAME')");
    ok((await call('POST', '/api/setup', form('K7Q2-TATAME'))).status === 403 && staffN(DB) === 0, 'código antigo em texto puro (formato anterior): não é mais aceito'); }

  // ================= código configurado: entradas inválidas =================
  const CODE = generateCode();
  { const DB = fresh(), call = client(DB); DB.raw.exec(buildSetupSql(CODE));
    ok(!JSON.stringify(DB.raw.prepare('SELECT * FROM settings').all()).includes(CODE.replace(/-/g, '')) && count(DB, `SELECT count(*) n FROM settings WHERE key = 'setup_token_hash' AND value = '${setupHash(CODE)}'`) === 1, 'no banco fica só o hash (o código não aparece em settings)');
    ok((await call('POST', '/api/setup', form(undefined))).status === 403, 'código ausente no corpo: 403');
    ok((await call('POST', '/api/setup', form(generateCode()))).status === 403, 'código incorreto (outro código válido no formato): 403');
    ok((await call('POST', '/api/setup', form(CODE.slice(0, 20)))).status === 403, 'código truncado: 403');
    ok((await call('POST', '/api/setup', form(CODE + 'X'))).status === 403, 'código com caractere a mais: 403');
    ok((await call('POST', '/api/setup', form(setupHash(CODE)))).status === 403, 'enviar o hash do banco no lugar do código: 403');
    for (const f of ['setupCode', 'code', 'token', 'setup_token', 'setup_token_hash']) {
      const b = form(undefined); b[f] = CODE;
      assert.strictEqual((await call('POST', '/api/setup', b)).status, 403, f);
    }
    ok(true, 'código em campo inesperado (setupCode, code, token, setup_token, setup_token_hash): 403');
    ok((await call('POST', '/api/setup', form(12345))).status === 403 && (await call('POST', '/api/setup', form({ code: CODE }))).status === 403 && (await call('POST', '/api/setup', form([CODE]))).status === 403, 'código com tipo errado (número, objeto, lista): 403');
    ok((await call('POST', '/api/setup', '{"academy_name":', { raw: true })).status === 400 && (await call('POST', '/api/setup', '[1,2]', { raw: true })).status === 400 && (await call('POST', '/api/setup', 'null', { raw: true })).status === 400 && (await call('POST', '/api/setup', '"texto"', { raw: true })).status === 400, 'corpo malformado (JSON inválido, lista, null, string): 400');
    ok(staffN(DB) === 0 && tokenN(DB) === 2, 'depois de todas as tentativas inválidas: ninguém criado e o código continua válido'); }

  // ================= código vencido =================
  { const DB = fresh(), call = client(DB); const c = generateCode();
    DB.raw.exec(buildSetupSql(c, { now: new Date(Date.now() - 2 * 3600e3), hours: 1 }));
    ok((await call('POST', '/api/setup', form(c))).status === 403 && staffN(DB) === 0, 'código vencido: 403, ninguém criado'); }

  // ================= caminho feliz =================
  { const DB = fresh(), call = client(DB); DB.raw.exec(buildSetupSql(CODE));
    const r = await call('POST', '/api/setup', form(CODE.toLowerCase().replace(/-/g, ' '), { role: 'professor', active: 0, id: '00000000-0000-4000-8000-000000000000', is_admin: false, pass_hash: 'x' }));
    ok(r.status === 201 && /^tatame_sid=[0-9a-f]{64}$/.test(r.cookie), 'código válido (sem diferenciar maiúsculas/separadores): 201 e sessão criada');
    const s = DB.raw.prepare('SELECT * FROM staff').all();
    ok(s.length === 1 && s[0].role === 'admin' && s[0].active === 1 && s[0].id !== '00000000-0000-4000-8000-000000000000' && s[0].email === 'dono@x.test', 'um administrador; role, active e id enviados no JSON foram ignorados (definidos pelo servidor)');
    ok(/^[A-Za-z0-9+/]{43}=$/.test(s[0].pass_hash) && s[0].pass_hash !== 'x' && /^[A-Za-z0-9+/]{22}==$/.test(s[0].pass_salt), 'senha guardada como hoje (PBKDF2, hash e sal em base64)');
    ok(tokenN(DB) === 0 && DB.raw.prepare("SELECT value FROM settings WHERE key = 'setup_done'").get().value === '1' && DB.raw.prepare("SELECT value FROM settings WHERE key = 'academy_name'").get().value === 'Academia Nova', 'código consumido (hash e validade apagados), setup_done = 1, nome da academia gravado');
    ok((await call('GET', '/api/me', undefined, { cookie: r.cookie })).body?.me?.role === 'admin', 'a sessão do setup funciona');
    const login = await call('POST', '/api/login', { email: 'dono@x.test', password: 'senhaforte1' });
    ok(login.status === 200 && (await call('GET', '/api/state', undefined, { cookie: login.cookie })).status === 200, 'login e uso normal funcionam depois do setup');
    ok((await call('POST', '/api/staff', { name: 'Professor', email: 'p@x.test', password: 'senhaprof1', role: 'professor' }, { cookie: login.cookie })).status === 201, 'instalação operacional: administrador cadastra a equipe normalmente');
    const st = await call('GET', '/api/status');
    ok(!st.body.setup_needed && !st.body.setup_code_required, '/api/status: setup não é mais necessário');
    ok((await call('POST', '/api/setup', form(CODE, { email: 'outro@x.test' }))).status === 409, 'reutilizar o código já consumido: 409');
    ok((await call('POST', '/api/setup', form(generateCode(), { email: 'outro2@x.test' }))).status === 409 && count(DB, "SELECT count(*) n FROM staff WHERE role = 'admin'") === 1, 'nova tentativa após o setup (criar outro administrador pelo endpoint inicial): 409, continua 1 administrador');
    DB.raw.exec(buildSetupSql(generateCode(), { replace: true }));
    ok(tokenN(DB) === 0, 'configurar código numa instalação com equipe: o SQL não grava nada (setup não reabre)');
    // estado incoerente forjado: sem equipe e sem código (ex.: alguém apagou a equipe direto no banco)
    DB.raw.exec('PRAGMA foreign_keys = OFF; DELETE FROM staff; PRAGMA foreign_keys = ON;');
    ok((await call('POST', '/api/setup', form(CODE))).status === 403 && staffN(DB) === 0, 'código consumido não volta a valer nem se a equipe sumir: 403'); }

  // ================= concorrência (mesmo código) =================
  { const DB = fresh(), call = client(DB); const c = generateCode(); DB.raw.exec(buildSetupSql(c));
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/api/setup', form(c, { email: `p${i}@x.test`, academy_name: `Academia ${i}` }))));
    const st = rs.map(r => r.status), win = st.indexOf(201);
    const admins = DB.raw.prepare('SELECT email FROM staff').all();
    ok(st.filter(x => x === 201).length === 1 && st.every(x => x === 201 || x === 409), `10 setups simultâneos com o mesmo código: exatamente 1 sucesso (${st.join(',')})`);
    ok(admins.length === 1 && admins[0].email === `p${win}@x.test` && DB.raw.prepare("SELECT value FROM settings WHERE key = 'academy_name'").get().value === `Academia ${win}`, 'um único administrador, e o nome da academia é o da mesma requisição que venceu');
    ok(tokenN(DB) === 0 && count(DB, 'SELECT count(*) n FROM auth_sessions') === 1, 'código consumido uma vez; só a requisição vencedora ganhou sessão'); }

  // ================= falha no meio do batch: rollback =================
  { const DB = fresh(), call = client(DB); const c = generateCode(); DB.raw.exec(buildSetupSql(c));
    DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON settings WHEN NEW.key = 'setup_done' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
    const r = await call('POST', '/api/setup', form(c));
    ok(r.status >= 400 && staffN(DB) === 0 && tokenN(DB) === 2 && count(DB, "SELECT count(*) n FROM settings WHERE key = 'academy_name' AND value IS NOT NULL") === 0, `falha num comando do batch (${r.status}): nada gravado — sem administrador, código intacto, sem nome de academia`);
    DB.raw.exec('DROP TRIGGER falha');
    ok((await call('POST', '/api/setup', form(c))).status === 201 && staffN(DB) === 1 && tokenN(DB) === 0, 'depois da falha, o mesmo código conclui o setup normalmente'); }

  // ================= SQLite real, duas conexões: a condição vale dentro da transação =================
  { const file = join(tmp, 'duas-conexoes.db');
    const A = new DatabaseSync(file); A.exec(readSchema()); const c = generateCode(); A.exec(buildSetupSql(c));
    const B = new DatabaseSync(file, { timeout: 0 });
    const guarded = db => db.prepare(`INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) SELECT ?, 'Pessoa', ?, 'h', 's', 'admin'
      WHERE NOT EXISTS (SELECT 1 FROM staff) AND EXISTS (SELECT 1 FROM settings WHERE key = 'setup_token_hash' AND value = ?) AND EXISTS (SELECT 1 FROM settings WHERE key = 'setup_token_expires' AND value > ?)`);
    const now = new Date().toISOString();
    A.exec('BEGIN IMMEDIATE');
    const a = guarded(A).run(crypto.randomUUID(), 'a@x.test', setupHash(c), now);
    let busy = false; try { B.exec('BEGIN IMMEDIATE'); } catch { busy = true; }
    A.prepare("DELETE FROM settings WHERE key IN ('setup_token_hash', 'setup_token_expires')").run(); A.exec('COMMIT');
    B.exec('BEGIN IMMEDIATE'); const b = guarded(B).run(crypto.randomUUID(), 'b@x.test', setupHash(c), now); B.exec('COMMIT');
    ok(a.changes === 1 && busy && b.changes === 0 && B.prepare('SELECT count(*) n FROM staff').get().n === 1, 'SQLite real com 2 conexões: a 2ª escrita espera a 1ª; depois, a mesma inserção condicionada não insere nada');
    A.close(); B.close(); }

  // ================= hash: Worker e ferramenta calculam igual =================
  { const DB = fresh(), call = client(DB); const c = generateCode(); DB.raw.exec(`INSERT INTO settings (key, value) VALUES ('setup_token_hash', '${setupHash(c)}'), ('setup_token_expires', '${new Date(Date.now() + 3600e3).toISOString()}')`);
    ok((await call('POST', '/api/setup', form(c.replace(/0/g, 'O').replace(/1/g, 'l')))).status === 201, 'hash do Worker = hash da ferramenta (inclui a normalização O→0, I/L→1)'); }

  // ================= ferramenta do operador (wrangler simulado sobre SQLite) =================
  { const file = join(tmp, 'operador.db');
    const db0 = new DatabaseSync(file); db0.exec(readSchema()); db0.close();
    const calls = [];
    const exec = args => {
      calls.push(args.join(' ')); const db = new DatabaseSync(file);
      try {
        if (args.includes('--command')) return { status: 0, stdout: JSON.stringify([{ results: db.prepare(args[args.indexOf('--command') + 1]).all(), success: true }]) };
        db.exec('BEGIN'); try { db.exec(readFileSyncUtf8(args[args.indexOf('--file') + 1])); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); return { status: 1, stdout: '', stderr: 'falha' }; }
        return { status: 0, stdout: '[]' };
      } finally { db.close(); }
    };
    const out = [];
    const deps = (over = {}) => ({ exec, ask: async () => 'tatame-nova', isTTY: () => true, out: m => out.push(m), productionName: () => 'tatame-producao', ...over });
    const refusedWith = async (argv, d, re) => { try { await setupTool(argv, d); return false; } catch (e) { return e instanceof SetupToolError && re.test(e.message); } };
    ok(await refusedWith(['--db', 'tatame-producao', '--remote'], deps(), /PRODUÇÃO/), 'ferramenta: banco de produção de db/environments.json recusado');
    ok(await refusedWith(['--db', 'tatame-nova', '--remote'], deps({ isTTY: () => false }), /interativo/), 'ferramenta: terminal não interativo recusado');
    ok(await refusedWith(['--db', 'tatame-nova', '--remote'], deps({ ask: async () => 'outro' }), /Cancelado/) && tokenFile(file) === 0, 'ferramenta: nome digitado diferente cancela sem gravar');
    ok(await refusedWith(['--db', "x'; DROP TABLE staff;--", '--remote'], deps(), /inválido/), 'ferramenta: nome de banco com caracteres inválidos recusado');
    ok(await refusedWith(['--db', 'tatame-nova', '--remote', '--hours', '999'], deps(), /--hours/), 'ferramenta: validade fora de 1–168 h recusada');
    out.length = 0;
    ok(await setupTool(['--db', 'tatame-nova', '--remote'], deps()) === 0 && tokenFile(file) === 2, 'ferramenta: gera e grava o código numa instalação sem equipe');
    const shown = out.join('\n').match(/\n {4}([0-9A-Z]{5}(?:-[0-9A-Z]{1,5}){5})\n/)?.[1];
    ok(shown && !out.join('\n').includes(setupHash(shown)) && calls.every(c => !c.includes(shown) && !c.includes(shown.replace(/-/g, ''))), 'o código aparece só na tela do operador; não vai nos argumentos do wrangler; o hash não é exibido');
    ok(await refusedWith(['--db', 'tatame-nova', '--remote'], deps(), /--replace/), 'ferramenta: código já configurado não é sobrescrito sem --replace');
    out.length = 0;
    ok(await setupTool(['--db', 'tatame-nova', '--remote', '--replace'], deps()) === 0, 'ferramenta: --replace (com nova confirmação) troca o código');
    const second = out.join('\n').match(/\n {4}([0-9A-Z]{5}(?:-[0-9A-Z]{1,5}){5})\n/)?.[1];
    const DB = makeD1(file), call = client(DB);
    ok((await call('POST', '/api/setup', form(shown))).status === 403, 'o código anterior deixa de valer depois do --replace');
    ok((await call('POST', '/api/setup', form(second))).status === 201 && tokenFile(file) === 0, 'o código gerado pela ferramenta conclui o setup no Worker');
    ok(await refusedWith(['--db', 'tatame-nova', '--remote', '--replace'], deps(), /já tem equipe/), 'ferramenta: instalação já configurada recusada, mesmo com --replace'); }

  // ================= nada vazou =================
  const all = seen.join('\n') + logs.join('\n');
  ok(!all.includes(CODE) && !all.includes(CODE.replace(/-/g, '')) && !all.includes(setupHash(CODE)) && !/setup_token/.test(all), `nenhuma resposta (${seen.length}) nem log contém código, hash ou chave setup_token`);
  console.log('\nSETUP OK');
} finally {
  console.error = origErr;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: arquivo SQLite ainda aberto após falha */ }
}

function readSchema() { return readFileSyncUtf8(SCHEMA); }
function readFileSyncUtf8(f) { return (globalThis.__fs ||= await_fs()).readFileSync(f, 'utf8'); }
function await_fs() { return process.getBuiltinModule('node:fs'); }
function tokenFile(file) { const db = new DatabaseSync(file); try { return db.prepare("SELECT count(*) n FROM settings WHERE key IN ('setup_token_hash', 'setup_token_expires')").get().n; } finally { db.close(); } }
