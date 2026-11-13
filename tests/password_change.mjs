// Etapa 6.3-B (V9): troca de senha. Limite de 5 conferências da senha atual por conta em 15 min (vaga reservada antes do
// hash: vale com requisições simultâneas e de qualquer IP), senha nova diferente da atual, política centralizada,
// invalidação de códigos de recuperação, auditoria sem segredos e nada parcial em falha. Confere o BANCO.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';
import { generateCode as resetCode, buildSql as resetSql } from '../tools/reset-code.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
const seen = [];

function world() {
  const DB = makeD1(); DB.load(SCHEMA);
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  const call = async (method, path, body, { cookie = '', ip = '198.51.100.1' } = {}) => {
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie, 'cf-connecting-ip': ip }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await r.text(); seen.push(text);
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, session: (set.find(c => c.startsWith('tatame_sid=')) || '').split(';')[0] };
  };
  const n = (sql, ...p) => DB.raw.prepare(sql).get(...p).n;
  const row = (sql, ...p) => DB.raw.prepare(sql).get(...p);
  return { DB, call, n, row };
}
async function boot(w) {
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  const admin = (await w.call('POST', '/api/setup', { academy_name: 'Academia', name: 'Dono Da Silva', email: 'dono@x.test', password: 'cordafina-71', setup_code: code })).session;
  await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: admin });
  const prof = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session;
  const id = e => w.row('SELECT id FROM staff WHERE email = ?', e).id;
  return { admin, prof, ADMIN: id('dono@x.test'), PROF: id('p1@x.test') };
}
const change = (w, cookie, current, password, ip) => w.call('PUT', '/api/me/password', { current, password }, { cookie, ip });
const hashOf = (w, id) => w.row('SELECT pass_hash h FROM staff WHERE id = ?', id).h;
const counter = (w, id) => w.n('SELECT count(*) n FROM login_attempts WHERE key = ?', 'pwchange:' + id);
const ev = (w, e) => w.DB.raw.prepare('SELECT * FROM audit_log WHERE event = ? ORDER BY id').all(e);

// ================= limite exato, 6ª tentativa, IPs e sessões diferentes, janela =================
{ const w = world(); const { prof, PROF } = await boot(w);
  const h0 = hashOf(w, PROF);
  const prof2 = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' }, { ip: '203.0.113.50' })).session;
  const ips = ['198.51.100.1', '203.0.113.7', '2001:db8:1::5', '192.0.2.9', '203.0.113.88'];
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await change(w, i % 2 ? prof2 : prof, 'chute-' + i, 'pedra-nova-43', ips[i])).status);
  ok(st.every(s => s === 400) && counter(w, PROF) === 5 && hashOf(w, PROF) === h0, '5 senhas atuais erradas (5 IPs, 2 sessões da mesma conta): 400 em todas, 5 vagas usadas, senha intacta');
  const sixth = await change(w, prof, 'pedra-lisa-42', 'pedra-nova-43', '198.51.100.250');
  ok(sixth.status === 429 && hashOf(w, PROF) === h0 && counter(w, PROF) === 5, '6ª tentativa (mesmo com a senha atual CERTA, de outro IP): 429, senha não muda, contador não cresce');
  ok(ev(w, 'password_change_failed').length === 1 && JSON.parse(ev(w, 'password_change_failed')[0].detail).tentativas === 5 && ev(w, 'password_change_failed')[0].staff_id === PROF, 'password_change_failed: uma única linha, gravada quando o 5º erro esgotou o limite');
  ok((await w.call('GET', '/api/state', undefined, { cookie: prof })).status === 200, 'o bloqueio da troca não derruba a sessão (a pessoa continua usando o sistema)');
  w.DB.raw.exec("UPDATE login_attempts SET at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-16 minutes') WHERE key LIKE 'pwchange:%'");
  const after = await change(w, prof, 'pedra-lisa-42', 'pedra-nova-43');
  ok(after.status === 200 && hashOf(w, PROF) !== h0 && counter(w, PROF) === 0, 'passada a janela de 15 min, a troca volta a funcionar (bloqueio não é permanente); sucesso zera o contador'); }

// ================= concorrência =================
{ const w = world(); const { prof, PROF } = await boot(w);
  const h0 = hashOf(w, PROF);
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => change(w, prof, 'chute-par-' + i, 'pedra-nova-43', `203.0.113.${i}`)));
  const c400 = rs.filter(r => r.status === 400).length, c429 = rs.filter(r => r.status === 429).length;
  ok(c400 === 5 && c429 === 15 && counter(w, PROF) === 5 && hashOf(w, PROF) === h0, `20 tentativas simultâneas: só ${c400} chegaram a conferir a senha atual (o resto ${c429}x 429); 5 vagas no banco`);
  const w2 = world(); const b2 = await boot(w2);
  const mix = await Promise.all([...Array.from({ length: 9 }, (_, i) => change(w2, b2.prof, 'chute-' + i, 'pedra-nova-43')), change(w2, b2.prof, 'pedra-lisa-42', 'pedra-nova-43')]);
  ok(mix.filter(r => r.status === 400 || r.status === 200).length <= 5 && w2.n('SELECT count(*) n FROM audit_log WHERE event = ?', 'password_changed') <= 1, `10 simultâneas com 1 certa no meio: no máximo 5 conferências (${mix.map(r => r.status).join(',')})`); }

// ================= senha nova igual à atual e política centralizada =================
{ const w = world(); const { prof, PROF } = await boot(w);
  const h0 = hashOf(w, PROF);
  for (let i = 0; i < 6; i++) assert.strictEqual((await change(w, prof, 'pedra-lisa-42', 'pedra-lisa-42')).status, 400);
  ok(hashOf(w, PROF) === h0 && counter(w, PROF) === 0 && ev(w, 'password_changed').length === 0, 'senha nova igual à atual (6 vezes seguidas): 400, nada muda e o contador não enche (a senha atual estava certa)');
  const msg = (await change(w, prof, 'pedra-lisa-42', 'pedra-lisa-42')).body.error;
  ok(/diferente da atual/.test(msg), 'mensagem clara: a senha nova precisa ser diferente');
  const same = (await change(w, prof, 'chute-errado', 'chute-errado')).body.error;
  ok(/atual incorreta/.test(same), 'com a senha atual errada, a resposta é "senha atual incorreta" (a regra "igual à atual" não vira oráculo)');
  w.DB.raw.exec('DELETE FROM login_attempts');
  const pol = [['nove-car9', 'tamanho'], ['1234567890', 'comum'], ['p1@x.test', 'igual ao e-mail'], ['prof um', 'igual ao nome'], ['zzzzzzzzzz', 'repetido'], ['x'.repeat(129), '129 caracteres']];
  let all400 = true; for (const [p] of pol) if ((await change(w, prof, 'pedra-lisa-42', p)).status !== 400) all400 = false;
  ok(all400 && hashOf(w, PROF) === h0 && counter(w, PROF) === 0, `política centralizada (${pol.map(x => x[1]).join(', ')}): 400, senha intacta, nenhuma vaga gasta`);
  ok((await change(w, prof, 'pedra-lisa-42', 'x'.repeat(5) + 'y'.repeat(5))).status === 200, 'limite exato da política: 10 caracteres aceitos'); }

// ================= troca própria: sessões, login, códigos, auditoria =================
{ const w = world(); const { prof, PROF } = await boot(w);
  const other = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' }, { ip: '203.0.113.5' })).session;
  const code = resetCode(); w.DB.raw.exec(resetSql(PROF, code));
  const r = await change(w, prof, 'pedra-lisa-42', 'pedra-nova-43');
  ok(r.status === 200 && r.session && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF) === 1, 'troca própria: 200, as sessões antigas da conta saem e fica só a nova');
  ok((await w.call('GET', '/api/state', undefined, { cookie: other })).status === 401 && (await w.call('GET', '/api/state', undefined, { cookie: prof })).status === 401 && (await w.call('GET', '/api/state', undefined, { cookie: r.session })).status === 200, 'sessão antiga (outro aparelho e a própria) caem; a nova funciona');
  ok((await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' }, { ip: '198.51.100.40' })).status === 401 && (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-nova-43' }, { ip: '198.51.100.41' })).status === 200, 'login: senha antiga não entra mais; a nova entra');
  ok(w.n('SELECT count(*) n FROM password_resets WHERE staff_id = ?', PROF) === 0 && (await w.call('POST', '/api/reset', { email: 'p1@x.test', code, password: 'tentativa-reverter-1' }, { ip: '198.51.100.42' })).status === 400, 'código de recuperação emitido antes da troca: apagado e recusado depois (antes: revertia a troca)');
  const a = ev(w, 'password_changed');
  ok(a.length === 1 && a[0].staff_id === PROF && JSON.parse(a[0].detail).por === 'propria_conta', 'password_changed: 1 linha, com a conta'); }

// ================= troca pelo administrador =================
{ const w = world(); const { admin, prof, ADMIN, PROF } = await boot(w);
  const code = resetCode(); w.DB.raw.exec(resetSql(PROF, code));
  const h0 = hashOf(w, PROF);
  const bad = await w.call('PUT', '/api/staff/' + PROF, { name: 'Prof Um', password: 'palmeiras1' }, { cookie: admin });
  ok(bad.status === 400 && hashOf(w, PROF) === h0 && ev(w, 'staff_password_reset').length === 0, 'admin com senha comum: 400, nada muda, nada auditado (política centralizada)');
  const r = await w.call('PUT', '/api/staff/' + PROF, { name: 'Prof Um', password: 'pedra-nova-43' }, { cookie: admin });
  const a = ev(w, 'staff_password_reset');
  ok(r.status === 200 && hashOf(w, PROF) !== h0 && (await w.call('GET', '/api/state', undefined, { cookie: prof })).status === 401, 'admin define senha nova: 200, hash muda, sessões da pessoa caem');
  ok(a.length === 1 && a[0].staff_id === ADMIN && JSON.parse(a[0].detail).conta === PROF && w.n('SELECT count(*) n FROM password_resets WHERE staff_id = ?', PROF) === 0, 'staff_password_reset: quem fez (admin) e para quem; código de recuperação pendente da pessoa apagado');
  ok((await w.call('PUT', '/api/staff/' + ADMIN, { name: 'Prof Um', password: 'pedra-nova-44' }, { cookie: (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-nova-43' }, { ip: '198.51.100.60' })).session })).status === 403, 'professor não troca senha de ninguém pela rota de equipe (403, regra existente)');
  ok((await w.call('PUT', '/api/me/password', { current: 'x', password: 'pedra-nova-45' })).status === 401, 'sem sessão: 401'); }

// ================= nada parcial em falha =================
{ const w = world(); const { admin, prof, PROF } = await boot(w);
  const code = resetCode(); w.DB.raw.exec(resetSql(PROF, code));
  const h0 = hashOf(w, PROF), s0 = w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF);
  w.DB.raw.exec("CREATE TRIGGER falha_pc BEFORE INSERT ON audit_log WHEN NEW.event IN ('password_changed', 'staff_password_reset') BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  const r = await change(w, prof, 'pedra-lisa-42', 'pedra-nova-43');
  ok(r.status === 500 && hashOf(w, PROF) === h0 && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF) === s0 && w.n('SELECT count(*) n FROM password_resets WHERE staff_id = ?', PROF) === 1 && r.session === '', 'falha no meio da troca própria: senha, sessões e código intactos; nenhuma sessão entregue');
  ok((await w.call('GET', '/api/state', undefined, { cookie: prof })).status === 200, 'depois da falha, a sessão antiga continua válida (nada foi apagado)');
  const r2 = await w.call('PUT', '/api/staff/' + PROF, { name: 'Prof Um', password: 'pedra-nova-43' }, { cookie: admin });
  ok(r2.status === 500 && hashOf(w, PROF) === h0 && w.n('SELECT count(*) n FROM password_resets WHERE staff_id = ?', PROF) === 1 && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', PROF) === s0, 'falha no meio da troca pelo admin: nada muda');
  w.DB.raw.exec('DROP TRIGGER falha_pc');
  ok((await change(w, prof, 'pedra-lisa-42', 'pedra-nova-43')).status === 200, 'removida a falha, a mesma troca conclui normalmente'); }

// ================= nada sensível em respostas, auditoria e log =================
{ const all = seen.join('\n') + errs.join('\n');
  ok(!/pedra-lisa-42|pedra-nova-4\d|chute-|cordafina/.test(seen.join('\n')), 'nenhuma resposta repete senha');
  const w = world(); const { prof, PROF } = await boot(w);
  for (let i = 0; i < 5; i++) await change(w, prof, 'segredo-errado-' + i, 'pedra-nova-43');
  await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' }, { ip: '198.51.100.90' });
  const after = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' }, { ip: '198.51.100.91' })).session;
  w.DB.raw.exec("DELETE FROM login_attempts WHERE key LIKE 'pwchange:%'");
  await change(w, after, 'pedra-lisa-42', 'pedra-nova-43');
  const audits = JSON.stringify(w.DB.raw.prepare('SELECT * FROM audit_log').all());
  const ph = w.row('SELECT pass_hash, pass_salt FROM staff WHERE id = ?', PROF);
  ok(!/segredo-errado|pedra-lisa|pedra-nova|tatame_sid|token/.test(audits) && !audits.includes(ph.pass_hash) && !audits.includes(ph.pass_salt), 'auditoria sem senha (atual, nova ou errada), hash, sal, sessão ou token');
  console.error = oe;
  ok(errs.every(e => /falha simulada/.test(e)) && !/pedra-|segredo-/.test(all), 'log do Worker: só os erros das falhas simuladas, sem senhas'); }
console.log('\nTROCA DE SENHA (V9) OK');
