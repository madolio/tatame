// Etapa 6.3-C (V11): recuperação de senha. Erros de terceiros não queimam o código; uso único e consumo atômico num batch;
// invalidação em troca própria, troca pelo admin e desativação; nada parcial em falha; nada sensível em respostas,
// auditoria ou log; ferramenta manual só em terminal interativo e sem o código em argumentos/arquivos. Confere o BANCO.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';
import { generateCode as newCode, buildSql, hashCode } from '../tools/reset-code.mjs';
import { main } from '../tools/db/ops.mjs';
import { simDeps, sqliteRemote } from './cf_sim.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
const seen = [], codes = [];
const tmp = mkdtempSync(join(tmpdir(), 'tatame-reset-test-'));

function world(file = ':memory:') {
  const DB = makeD1(file); if (file === ':memory:') DB.load(SCHEMA);
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  const call = async (method, path, body, { cookie = '', ip = '198.51.100.1' } = {}) => {
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie, 'cf-connecting-ip': ip }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await r.text(); seen.push(text);
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, session: ((r.headers.getSetCookie?.() || []).find(c => c.startsWith('tatame_sid=')) || '').split(';')[0] };
  };
  const row = (sql, ...p) => DB.raw.prepare(sql).get(...p);
  const n = (sql, ...p) => row(sql, ...p).n;
  return { DB, call, row, n };
}
async function boot(w) {
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  const admin = (await w.call('POST', '/api/setup', { academy_name: 'Academia', name: 'Dono Da Silva', email: 'dono@x.test', password: 'cordafina-71', setup_code: code })).session;
  await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: admin });
  const prof = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session;
  const id = e => w.row('SELECT id FROM staff WHERE email = ?', e).id;
  return { admin, prof, ADMIN: id('dono@x.test'), PROF: id('p1@x.test') };
}
const issue = (w, id, agoMs = 0) => { const c = newCode(); codes.push(c); w.DB.raw.exec(buildSql(id, c, new Date(Date.now() - agoMs))); return c; };
const reset = (w, email, code, password, ip = '198.51.100.9') => w.call('POST', '/api/reset', { email, code, password, password_confirm: password }, { ip });
const pr = (w, id) => w.row('SELECT * FROM password_resets WHERE staff_id = ?', id);
const hashOf = (w, id) => w.row('SELECT pass_hash h FROM staff WHERE id = ?', id).h;

// ================= 1–3. terceiros não queimam o código =================
{ const w = world(); const { ADMIN } = await boot(w);
  const code = issue(w, ADMIN);
  const before = JSON.stringify(pr(w, ADMIN));
  for (let i = 0; i < 5; i++) assert.strictEqual((await reset(w, 'dono@x.test', newCode(), 'atacante-tenta-1', '203.0.113.50')).status, 400);
  ok(JSON.stringify(pr(w, ADMIN)) === before, '5 códigos errados do mesmo IP: a linha do código pendente fica idêntica (attempts, used_at, validade)');
  for (let i = 0; i < 12; i++) await reset(w, 'dono@x.test', newCode(), 'atacante-tenta-1', `203.0.113.${100 + i}`);
  ok(JSON.stringify(pr(w, ADMIN)) === before, '12 códigos errados de 12 IPs: o código pendente continua idêntico');
  const h0 = hashOf(w, ADMIN);
  const r = await reset(w, 'dono@x.test', code, 'pedra-nova-43', '198.51.100.200');
  ok(r.status === 200 && hashOf(w, ADMIN) !== h0 && pr(w, ADMIN).used_at !== null, 'depois dos erros de terceiros, o dono usa o código certo: senha redefinida, código consumido');
  ok((await w.call('POST', '/api/login', { email: 'dono@x.test', password: 'pedra-nova-43' }, { ip: '198.51.100.201' })).status === 200, 'e entra com a senha nova');
  ok(w.n("SELECT count(*) n FROM audit_log WHERE event = 'reset_failed'") === 0, '17 erros sem atingir limite nenhum: nenhuma linha reset_failed (não é uma por erro)');
  for (let i = 0; i < 3; i++) await reset(w, 'dono@x.test', newCode(), 'atacante-tenta-1', '203.0.113.50');
  ok(w.n("SELECT count(*) n FROM audit_log WHERE event = 'reset_failed'") === 1, 'o 8º erro do mesmo (e-mail, IP) atinge o limite: uma única linha reset_failed');
  ok((await reset(w, 'dono@x.test', newCode(), 'atacante-tenta-1', '203.0.113.50')).status === 429, 'limite por (e-mail, rede) preservado: o atacante do mesmo IP recebe 429'); }

// ================= 4–5. vencido e reutilização =================
{ const w = world(); const { ADMIN } = await boot(w);
  const old = issue(w, ADMIN, 31 * 60000); const h0 = hashOf(w, ADMIN);
  const r = await reset(w, 'dono@x.test', old, 'pedra-nova-43');
  ok(r.status === 400 && /expirou/.test(r.body.error) && hashOf(w, ADMIN) === h0 && pr(w, ADMIN).used_at === null, 'código com 31 minutos: recusado (expirou), senha e código inalterados');
  const c = issue(w, ADMIN);
  ok((await reset(w, 'dono@x.test', c, 'pedra-nova-43')).status === 200, 'código válido: usado');
  const h1 = hashOf(w, ADMIN);
  const again = await reset(w, 'dono@x.test', c, 'pedra-outra-44', '198.51.100.30');
  ok(again.status === 400 && /utilizado/.test(again.body.error) && hashOf(w, ADMIN) === h1 && w.n("SELECT count(*) n FROM audit_log WHERE event = 'reset_used'") === 1, 'reutilizar o código: recusado, senha continua a da 1ª vez, um único reset_used'); }

// ================= 6. dois usos simultâneos =================
{ const w = world(); const { ADMIN } = await boot(w);
  const c = issue(w, ADMIN);
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => reset(w, 'dono@x.test', c, `pedra-paralela-${i}`, `198.51.100.${50 + i}`)));
  const winners = rs.map((r, i) => r.status === 200 ? i : -1).filter(i => i >= 0);
  ok(winners.length === 1 && rs.filter(r => r.status === 400).length === 7, `8 usos simultâneos do mesmo código: exatamente 1 sucesso (${rs.map(r => r.status).join(',')})`);
  ok((await w.call('POST', '/api/login', { email: 'dono@x.test', password: `pedra-paralela-${winners[0]}` }, { ip: '198.51.100.70' })).status === 200 && w.n("SELECT count(*) n FROM audit_log WHERE event = 'reset_used'") === 1, 'a senha que vale é a da requisição vencedora; um único reset_used'); }

// ================= 7–9. invalidação: troca própria, troca pelo admin, desativação =================
{ const w = world(); const { admin, prof, PROF, ADMIN } = await boot(w);
  const own = issue(w, ADMIN);
  const adminSession = (await w.call('POST', '/api/login', { email: 'dono@x.test', password: 'cordafina-71' }, { ip: '198.51.100.80' })).session;
  ok((await w.call('PUT', '/api/me/password', { current: 'cordafina-71', password: 'pedra-nova-45' }, { cookie: adminSession })).status === 200 && !pr(w, ADMIN) && (await reset(w, 'dono@x.test', own, 'reverter-troca-1')).status === 400, 'troca própria (6.3-B): o código pendente é apagado e passa a ser recusado');
  const admin2 = (await w.call('POST', '/api/login', { email: 'dono@x.test', password: 'pedra-nova-45' }, { ip: '198.51.100.81' })).session;
  const forProf = issue(w, PROF);
  ok((await w.call('PUT', '/api/staff/' + PROF, { name: 'Prof Um', password: 'pedra-nova-46' }, { cookie: admin2 })).status === 200 && !pr(w, PROF) && (await reset(w, 'p1@x.test', forProf, 'reverter-troca-2')).status === 400, 'troca pelo admin (6.3-B): o código pendente da pessoa é apagado');
  const beforeDeact = issue(w, PROF);
  ok((await w.call('PUT', '/api/staff/' + PROF, { name: 'Prof Um', active: false }, { cookie: admin2 })).status === 200 && !pr(w, PROF), 'desativação: o código pendente é apagado no mesmo batch');
  await w.call('PUT', '/api/staff/' + PROF, { name: 'Prof Um', active: true }, { cookie: admin2 });
  ok((await reset(w, 'p1@x.test', beforeDeact, 'volta-depois-1')).status === 400 && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF) === 0, 'reativada dentro dos 30 min, o código antigo continua recusado (antes voltaria a valer)'); }

// ================= 11. nada parcial em falha =================
{ const w = world(); const { prof, PROF } = await boot(w);
  const c = issue(w, PROF);
  const h0 = hashOf(w, PROF), s0 = w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF);
  w.DB.raw.exec("CREATE TRIGGER falha_reset BEFORE INSERT ON audit_log WHEN NEW.event = 'reset_used' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  const r = await reset(w, 'p1@x.test', c, 'pedra-nova-47');
  ok(r.status === 500 && hashOf(w, PROF) === h0 && pr(w, PROF).used_at === null && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF) === s0, 'falha no meio da redefinição: senha, sessões e código intactos (antes o código ficava consumido sem a senha mudar)');
  ok((await w.call('GET', '/api/state', undefined, { cookie: prof })).status === 200, 'a sessão anterior continua valendo depois da falha');
  w.DB.raw.exec('DROP TRIGGER falha_reset');
  ok((await reset(w, 'p1@x.test', c, 'pedra-nova-47')).status === 200 && pr(w, PROF).used_at !== null && (await w.call('GET', '/api/state', undefined, { cookie: prof })).status === 401, 'removida a falha, o MESMO código conclui a redefinição e as sessões caem'); }

// ================= sem enumeração (regressão) =================
{ const w = world(); await boot(w);
  const a = await reset(w, 'ninguem@x.test', newCode(), 'qualquer-1234', '198.51.100.90');
  const b = await reset(w, 'p1@x.test', newCode(), 'qualquer-1234', '198.51.100.91');
  ok(a.status === b.status && a.body.error === b.body.error, 'e-mail inexistente e existente sem código: mesma resposta'); }

// ================= 12. ferramenta manual (operação reset-code do wrapper, Etapa 6.5-A) =================
{ const file = join(tmp, 'op.db'); const w = world(file); w.DB.raw.exec(readFileSync(SCHEMA, 'utf8'));
  const { PROF } = await boot(w);
  const calls = [], written = [];
  const exec = sqliteRemote(file, { calls, files: written });
  const out = [], err = [];
  const deps = (o = {}) => ({ ...simDeps({ exec, tty: true, answer: 'p1@x.test', out, err }), ...o });
  const tool = (argv, d = deps()) => main(['reset-code', ...argv], d);
  const refused = async (argv, d, re) => { const n0 = calls.length; err.length = 0; const code = await tool(argv, d); return code === 3 && re.test(err.join('\n')) && calls.length === n0; };
  const STG = ['--env', 'staging'];
  ok(await refused(['--email', 'p1@x.test', ...STG], deps({ isTTY: () => false }), /interativo/), 'ferramenta: sem terminal interativo, recusa ANTES de qualquer comando ao banco');
  ok(await refused(['--email', 'p1@x.test', ...STG, 'ABCDE-FGHIJ'], deps(), /não reconhecido/), 'ferramenta: argumento extra (ex.: um código) é recusado; o código nunca é argumento');
  ok(await refused(['--email', "x'@x.test", ...STG], deps(), /inválido/), 'ferramenta: e-mail inválido recusado');
  ok(await refused(['--email', 'p1@x.test', '--db', 'tatame', '--remote'], deps(), /--db não é aceito/), 'ferramenta: nome livre de banco (--db/--remote) recusado; só --env');
  ok(await refused(['--email', 'p1@x.test', '--env', 'production', '--confirm-production=tatame-prod-ficticio'], deps(), /só aceita como destino/), 'ferramenta: produção recusada, mesmo com a confirmação de produção');
  { const f0 = written.length; err.length = 0; const code = await tool(['--email', 'p1@x.test', ...STG], deps({ ask: async () => 'outro@x.test' }));
    ok(code === 3 && /Cancelado/.test(err.join('\n')) && written.length === f0 && !pr(w, PROF), 'ferramenta: e-mail digitado diferente cancela depois de ler a conta, sem nenhuma gravação'); }
  out.length = 0; const k0 = calls.length;
  ok(await tool(['--email', 'p1@x.test', ...STG]) === 0, 'ferramenta: gera o código para conta ativa (staging, identidade conferida)');
  const shown = out.join('\n').match(/\n {4}([0-9A-Z]{5}(?:-[0-9A-Z]{1,5}){5})\n/)?.[1];
  ok(shown && pr(w, PROF).code_hash === hashCode(PROF, shown), 'o código mostrado é o que ficou gravado (só o hash no banco)');
  ok(calls.every(c => !c.includes(shown) && !c.includes(shown.replace(/-/g, ''))) && written.every(s => !s.includes(shown) && !s.includes(shown.replace(/-/g, ''))), 'o código não aparece nos argumentos do wrangler nem no SQL gravado em arquivo');
  const mine = calls.slice(k0).filter(c => !/sqlite_schema|d1_migrations/.test(c));
  ok(mine.filter(c => c.includes('--command')).length === 2 && mine.filter(c => c.includes('--file')).length === 1 && mine.every(c => c.includes('--env staging')), 'leituras por --command e uma única gravação por --file, todas no ambiente conferido');
  ok((await reset(w, 'p1@x.test', shown, 'pedra-nova-48')).status === 200, 'o código gerado pela ferramenta funciona no Worker');
  const failing = sqliteRemote(file, { calls, hook: a => a.includes('--file') ? { status: 1, stdout: '', stderr: "SEGREDO-DO-STDERR INSERT ... 'hash'" } : null });
  out.length = 0; err.length = 0; let code = await tool(['--email', 'p1@x.test', ...STG], deps({ exec: failing }));
  ok(code === 3 && /acesso ao banco falhou/.test(err.join('\n')) && !err.join('\n').includes('SEGREDO') && !out.join('\n').includes('SEGREDO') && !/\n {4}[0-9A-Z]{5}-/.test(out.join('\n')), 'falha do wrangler: mensagem sem o conteúdo do stderr e nenhum código mostrado');
  const swapped = sqliteRemote(file, { calls, hook: a => { if (a.includes('--file')) { const r = sqliteRemote(file)(a); const d = new DatabaseSync(file); d.prepare('UPDATE password_resets SET code_hash = ? WHERE staff_id = ?').run('0'.repeat(64), PROF); d.close(); return r; } return null; } });
  out.length = 0; err.length = 0; code = await tool(['--email', 'p1@x.test', ...STG], deps({ exec: swapped }));
  ok(code === 3 && /NÃO foi mostrado/.test(err.join('\n')) && !/\n {4}[0-9A-Z]{5}-/.test(out.join('\n')), 'se o hash gravado não confere (emissão concorrente), o código não é mostrado');
  // local (SQLite em arquivo, sem wrangler)
  out.length = 0; const c0 = calls.length;
  ok(await tool(['--email', 'p1@x.test', '--env', 'local', '--sqlite', file], deps({ exec: () => { throw new Error('não deveria chamar o wrangler'); } })) === 0 && calls.length === c0, 'local (--env local --sqlite): gera o código sem nenhum comando ao wrangler');
  w.DB.raw.close(); }

// ================= 10. nada sensível =================
{ const all = seen.join('\n'), au = [];
  console.error = oe;
  ok(codes.every(c => !all.includes(c) && !all.includes(c.replace(/-/g, ''))), `nenhuma resposta (${seen.length}) contém código de recuperação`);
  ok(errs.every(e => /falha simulada/.test(e)) && codes.every(c => !errs.join('\n').includes(c.replace(/-/g, ''))), 'log do Worker: só as falhas simuladas, sem código');
  const w = world(); const { ADMIN } = await boot(w); const c = issue(w, ADMIN);
  for (let i = 0; i < 9; i++) await reset(w, 'dono@x.test', newCode(), 'atacante-tenta-9', '203.0.113.9');
  await reset(w, 'dono@x.test', c, 'pedra-nova-49', '198.51.100.99');
  const audits = JSON.stringify(w.DB.raw.prepare('SELECT * FROM audit_log').all());
  ok(!audits.includes(c) && !audits.includes(c.replace(/-/g, '')) && !audits.includes(hashCode(ADMIN, c)) && !/pedra-nova|atacante-tenta|cordafina/.test(audits), 'auditoria sem código, hash do código ou senhas'); }
rmSync(tmp, { recursive: true, force: true });   // o banco de arquivo já foi fechado (no Windows, aberto, a remoção falharia)
console.log('\nRECUPERAÇÃO (V11) OK');
