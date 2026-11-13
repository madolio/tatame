// Etapa 6.4-A (V8): sempre um administrador ativo, conferido DENTRO do comando de escrita. Concorrência com atrasos de
// banco simulados (cada consulta e cada batch esperam um tempo aleatório, como a ida e volta ao D1), autorização vencida
// no meio da requisição, payload parcial e regressão. Confere o BANCO, não só os status HTTP.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// lat: atraso aleatório (ms) antes de cada consulta/batch; hook: chamado antes de cada batch (para intercalar à mão).
function world() {
  const DB = makeD1(); DB.load(SCHEMA);
  const ctl = { lat: 0, beforeBatch: null };
  const wait = () => ctl.lat ? sleep(Math.random() * ctl.lat) : null;
  const ob = DB.batch.bind(DB);
  DB.batch = async s => { await wait(); if (ctl.beforeBatch) await ctl.beforeBatch(s); return ob(s); };
  const op = DB.prepare.bind(DB);
  DB.prepare = sql => {
    const p = op(sql), pb = p.bind.bind(p);
    p.bind = (...a) => { const st = pb(...a); for (const k of ['first', 'all', 'run']) { const f = st[k]?.bind(st); if (f) st[k] = async (...x) => { await wait(); return f(...x); }; } return st; };
    return p;
  };
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  let ipn = 1;
  const call = async (method, path, body, { cookie = '', ip } = {}) => {
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie, 'cf-connecting-ip': ip || '198.51.100.' + (ipn++ % 200 + 1) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await r.text();
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, session: (set.find(c => c.startsWith('tatame_sid=')) || '').split(';')[0] };
  };
  const row = (sql, ...p) => DB.raw.prepare(sql).get(...p);
  const admins = () => row("SELECT count(*) n FROM staff WHERE role = 'admin' AND active = 1").n;
  const staff = () => DB.raw.prepare('SELECT id, name, role, belt, active, pass_hash FROM staff ORDER BY id').all();
  return { DB, ctl, call, row, admins, staff };
}
async function boot(w, { second = true } = {}) {
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  const a1 = (await w.call('POST', '/api/setup', { academy_name: 'Academia', name: 'Dono Da Silva', email: 'dono@x.test', password: 'cordafina-71', setup_code: code })).session;
  const id = e => w.row('SELECT id FROM staff WHERE email = ?', e).id;
  await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor', belt: 'roxa' }, { cookie: a1 });
  const prof = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session;
  const out = { a1, prof, A1: id('dono@x.test'), PROF: id('p1@x.test') };
  if (second) {
    await w.call('POST', '/api/staff', { name: 'Admin Dois', email: 'a2@x.test', password: 'kimono-azul-26', role: 'admin', belt: 'preta' }, { cookie: a1 });
    out.a2 = (await w.call('POST', '/api/login', { email: 'a2@x.test', password: 'kimono-azul-26' })).session; out.A2 = id('a2@x.test');
  }
  return out;
}
const put = (w, cookie, id, body) => w.call('PUT', '/api/staff/' + id, body, { cookie });
const get = (w, id) => w.row('SELECT id, name, role, belt, active, pass_hash FROM staff WHERE id = ?', id);

// ================= integridade básica =================
{ const w = world(); const s = await boot(w, { second: false });
  const before = JSON.stringify(w.staff());
  const r1 = await put(w, s.a1, s.A1, { name: 'Dono Da Silva', role: 'professor' });
  const r2 = await put(w, s.a1, s.A1, { name: 'Dono Da Silva', active: 0 });
  ok(r1.status === 400 && r2.status === 400, 'único admin: rebaixar e desativar a si mesmo são recusados (400, como antes)');
  ok(JSON.stringify(w.staff()) === before && w.admins() === 1, 'único admin: banco intacto após as recusas');
  // A condição atômica sozinha (sem a checagem em JS): rebaixar o único admin ativo não muda nenhuma linha.
  const ch = w.DB.raw.prepare(`UPDATE staff SET role = 'professor' WHERE id = ?1 AND EXISTS (SELECT 1 FROM staff WHERE id = ?2 AND role = 'admin' AND active = 1)
    AND (NOT EXISTS (SELECT 1 FROM staff WHERE id = ?1 AND role = 'admin' AND active = 1) OR EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1 AND id <> ?1))`).run(s.A1, s.A1).changes;
  ok(ch === 0 && w.admins() === 1, 'a condição do UPDATE, isolada, não rebaixa o último admin ativo');
  const r3 = await put(w, s.a1, s.A1, { name: 'Dono Renomeado', belt: 'marrom' });
  ok(r3.status === 200 && get(w, s.A1).name === 'Dono Renomeado' && get(w, s.A1).belt === 'marrom' && get(w, s.A1).role === 'admin' && get(w, s.A1).active === 1, 'admin altera os próprios outros campos sem perder o acesso');
}
{ const w = world(); const s = await boot(w);
  const r = await put(w, s.a1, s.A2, { name: 'Admin Dois', role: 'professor' });
  ok(r.status === 200 && get(w, s.A2).role === 'professor' && w.admins() === 1, 'com dois admins, um rebaixa o outro');
  const w2 = world(); const t = await boot(w2);
  const d = await put(w2, t.a1, t.A2, { name: 'Admin Dois', active: 0 });
  ok(d.status === 200 && get(w2, t.A2).active === 0 && w2.admins() === 1 && w2.row('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', t.A2).n === 0, 'com dois admins, um desativa o outro (sessões dele caem)');
  ok((await w2.call('GET', '/api/bootstrap', undefined, { cookie: t.a2 })).status === 401, 'o desativado perde a sessão');
}

// ================= concorrência: rebaixamento mútuo, repetido, com atrasos aleatórios =================
{ let rounds = 0, oneWin = 0, statuses = new Set();
  for (let i = 0; i < 25; i++) {
    const w = world(); const s = await boot(w);
    w.ctl.lat = 15;
    const mode = i % 3;   // rebaixar × rebaixar, desativar × desativar, rebaixar × desativar
    const b1 = mode === 1 ? { name: 'Admin Dois', active: 0 } : { name: 'Admin Dois', role: 'professor' };
    const b2 = mode === 0 ? { name: 'Dono Da Silva', role: 'professor' } : { name: 'Dono Da Silva', active: 0 };
    const [r1, r2] = await Promise.all([put(w, s.a1, s.A2, b1), put(w, s.a2, s.A1, b2)]);
    w.ctl.lat = 0;
    const wins = [r1, r2].filter(r => r.status === 200).length;
    statuses.add(`${r1.status}/${r2.status}`);
    assert.ok(w.admins() >= 1, `rodada ${i}: academia ficou sem administrador ativo`);
    assert.ok(wins <= 1, `rodada ${i}: dois rebaixamentos concluídos`);
    // O vencedor continua admin ativo; o perdedor tem exatamente o estado que o vencedor gravou.
    const a1 = get(w, s.A1), a2 = get(w, s.A2);
    if (r1.status === 200) assert.ok(a1.role === 'admin' && a1.active === 1 && (a2.role !== 'admin' || !a2.active));
    if (r2.status === 200) assert.ok(a2.role === 'admin' && a2.active === 1 && (a1.role !== 'admin' || !a1.active));
    if (wins === 1) oneWin++;
    rounds++;
  }
  ok(rounds === 25, '25 rodadas de rebaixamento/desativação mútua simultânea: sempre ≥ 1 admin ativo no banco, nunca 2 sucessos');
  ok(oneWin === 25, `em todas as rodadas exatamente 1 venceu (status vistos: ${[...statuses].join(', ')})`);
}
// Intercalação forçada: as DUAS requisições já passaram por toda a checagem em JS antes de qualquer escrita.
{ const w = world(); const s = await boot(w);
  let arrived = 0, release; const gate = new Promise(r => { release = r; });
  w.ctl.beforeBatch = async () => { if (++arrived === 2) release(); await gate; };
  const [r1, r2] = await Promise.all([put(w, s.a1, s.A2, { name: 'Admin Dois', role: 'professor' }), put(w, s.a2, s.A1, { name: 'Dono Da Silva', role: 'professor' })]);
  w.ctl.beforeBatch = null;
  ok(arrived === 2 && [r1, r2].filter(r => r.status === 200).length === 1 && [r1, r2].some(r => r.status === 403) && w.admins() === 1,
    'ambas autorizadas em JS e paradas antes da escrita: só 1 grava, a outra recebe 403 e resta 1 admin ativo');
}

// ================= autorização vencida no meio da requisição =================
{ const w = world(); const s = await boot(w);
  const h0 = get(w, s.PROF).pass_hash;
  // A2 começa a mudar a senha e a faixa do professor; antes do batch dele, A1 rebaixa A2.
  let fired = false;
  w.ctl.beforeBatch = async () => { if (fired) return; fired = true; w.ctl.beforeBatch = null; const r = await put(w, s.a1, s.A2, { name: 'Admin Dois', role: 'professor' }); assert.strictEqual(r.status, 200); };
  const sess0 = w.row('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', s.PROF).n;
  const r = await put(w, s.a2, s.PROF, { name: 'Prof Um', belt: 'marrom', role: 'admin', password: 'lua-cheia-tatame-9' });
  ok(r.status === 403, 'admin rebaixado durante a requisição: a escrita é recusada (403)');
  const p = get(w, s.PROF);
  ok(p.role === 'professor' && p.belt === 'roxa' && p.pass_hash === h0 && w.row('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', s.PROF).n === sess0
    && w.row("SELECT count(*) n FROM audit_log WHERE event = 'staff_password_reset'").n === 0, 'nada do batch foi aplicado: papel, faixa, senha, sessões e auditoria intactos');
  ok((await put(w, s.a2, s.PROF, { name: 'Prof Um', role: 'admin' })).status === 403, 'nova requisição do rebaixado: 403 (como antes)');
  ok((await put(w, s.prof, s.A1, { name: 'Dono Da Silva', role: 'professor' })).status === 403 && w.admins() === 1, 'professor continua recebendo 403');
  const n0 = JSON.stringify(w.staff());
  ok((await put(w, s.a1, '00000000-0000-4000-8000-000000000000', { name: 'Ninguém', role: 'professor' })).status === 404 && JSON.stringify(w.staff()) === n0, 'alvo inexistente: 404 e nada muda');
}
// Alvo apagado entre a leitura e a escrita (só possível por SQL manual hoje): 404, nada gravado.
{ const w = world(); const s = await boot(w);
  w.ctl.beforeBatch = async () => { w.ctl.beforeBatch = null; w.DB.raw.prepare('DELETE FROM staff WHERE id = ?').run(s.PROF); };
  const r = await put(w, s.a1, s.PROF, { name: 'Prof Um', belt: 'preta' });
  ok(r.status === 404 && !get(w, s.PROF), 'alvo removido durante a requisição: 404, nenhuma linha recriada');
}

// ================= payload parcial =================
{ const w = world(); const s = await boot(w);
  await put(w, s.a1, s.PROF, { name: 'Prof Um', active: 0 });
  ok(get(w, s.PROF).active === 0, 'professor desativado');
  const r = await put(w, s.a1, s.PROF, { name: 'Prof Renomeado' });
  ok(r.status === 200 && get(w, s.PROF).active === 0 && get(w, s.PROF).name === 'Prof Renomeado', 'PUT sem active mantém a conta desativada (antes: reativava)');
  ok(get(w, s.PROF).belt === 'roxa', 'PUT sem belt mantém a faixa (antes: apagava)');
  await put(w, s.a1, s.PROF, { name: 'Prof Renomeado', belt: null });
  ok(get(w, s.PROF).belt === null, 'belt: null limpa a faixa (semântica existente)');
  await put(w, s.a1, s.PROF, { name: 'Prof Renomeado', belt: 'azul' });
  await put(w, s.a1, s.PROF, { name: 'Prof Renomeado', belt: '' });
  ok(get(w, s.PROF).belt === null, "belt: '' também limpa (como a tela envia)");
  const a = await put(w, s.a1, s.PROF, { name: 'Prof Renomeado', active: 1, belt: 'marrom', role: 'admin' });
  ok(a.status === 200 && get(w, s.PROF).active === 1 && get(w, s.PROF).belt === 'marrom' && get(w, s.PROF).role === 'admin', 'campos enviados explicitamente continuam valendo (reativar, faixa, papel)');
  ok((await put(w, s.a1, s.PROF, { name: 'Prof Renomeado', active: 'talvez' })).status === 400, 'active inválido continua 400');
  ok(get(w, s.A2).belt === 'preta' && get(w, s.A2).active === 1, 'contas não envolvidas inalteradas');
}

// ================= regressão =================
{ const w = world(); const s = await boot(w);
  const c = await w.call('POST', '/api/staff', { name: 'Prof Dois', email: 'p2@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: s.a1 });
  ok(c.status === 201 && c.body.role === 'professor' && c.body.active === 1, 'criação de usuário');
  ok((await w.call('POST', '/api/staff', { name: 'X Y', email: 'p3@x.test', password: 'pedra-lisa-42' }, { cookie: s.prof })).status === 403, 'professor não cria usuário');
  const P2 = c.body.id;
  ok((await put(w, s.a1, P2, { name: 'Prof Dois', role: 'admin' })).status === 200 && get(w, P2).role === 'admin', 'promover a admin');
  ok((await put(w, s.a1, P2, { name: 'Prof Dois', role: 'professor' })).status === 200 && get(w, P2).role === 'professor', 'rebaixar a professor');
  const h0 = get(w, P2).pass_hash;
  const pw = await put(w, s.a1, P2, { name: 'Prof Dois', password: 'lua-cheia-tatame-9' });
  ok(pw.status === 200 && get(w, P2).pass_hash !== h0 && w.row("SELECT count(*) n FROM audit_log WHERE event = 'staff_password_reset' AND staff_id = ?", s.A1).n === 1, 'senha administrativa: troca e auditoria');
  ok((await w.call('POST', '/api/login', { email: 'p2@x.test', password: 'lua-cheia-tatame-9' })).status === 200, 'login com a senha nova');
  ok((await put(w, s.a1, P2, { name: 'Prof Dois', password: 'curta' })).status === 400 && (await w.call('POST', '/api/login', { email: 'p2@x.test', password: 'lua-cheia-tatame-9' })).status === 200, 'senha fraca recusada, a anterior continua valendo');
  await put(w, s.a1, P2, { name: 'Prof Dois', active: 0 });
  ok((await w.call('POST', '/api/login', { email: 'p2@x.test', password: 'lua-cheia-tatame-9' })).status === 401, 'desativado não entra');
  await put(w, s.a1, P2, { name: 'Prof Dois', active: 1 });
  ok((await w.call('POST', '/api/login', { email: 'p2@x.test', password: 'lua-cheia-tatame-9' })).status === 200, 'reativado volta a entrar');
  ok(w.admins() === 2, 'fim: academia com administradores ativos');
}

console.error = oe;
assert.ok(!errs.length, 'console.error inesperado: ' + errs.join(' | '));
console.log('\nINTEGRIDADE DOS ADMINISTRADORES OK');
