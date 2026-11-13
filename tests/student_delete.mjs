// Etapa 6.4-D (V12): exclusão de aluno só sem histórico; com histórico, 409 e nada apagado; inativar preserva tudo.
// Confere o BANCO (linhas de students, attendance, promotions, skills, skill_history e audit_log), não só os status HTTP.
// Concorrência com atrasos de banco simulados (cada consulta e cada batch esperam um tempo aleatório, como no D1).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const errs = []; console.error = (...a) => errs.push(a.join(' '));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HIST = ['attendance', 'promotions', 'skills', 'skill_history'];
const CONFLICT = /tem histórico.*inativo/;

function world() {
  const DB = makeD1(); DB.load(SCHEMA);
  const ctl = { lat: 0, beforeBatch: null };
  const wait = () => ctl.lat ? sleep(Math.random() * ctl.lat) : null;
  const ob = DB.batch.bind(DB);
  DB.batch = async s => { await wait(); if (ctl.beforeBatch) { const f = ctl.beforeBatch; ctl.beforeBatch = null; await f(s); } return ob(s); };
  const op = DB.prepare.bind(DB);
  DB.prepare = sql => {
    const p = op(sql), pb = p.bind.bind(p);
    p.bind = (...a) => { const st = pb(...a); for (const k of ['first', 'all', 'run']) { const f = st[k]?.bind(st); if (f) st[k] = async (...x) => { await wait(); return f(...x); }; } return st; };
    return p;
  };
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  let ipn = 1;
  const call = async (method, path, body, { cookie = '' } = {}) => {
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie, 'cf-connecting-ip': '198.51.100.' + (ipn++ % 200 + 1) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, session: ((r.headers.getSetCookie?.() || []).find(c => c.startsWith('tatame_sid=')) || '').split(';')[0] };
  };
  const row = (sql, ...p) => DB.raw.prepare(sql).get(...p);
  const rows = (sql, ...p) => DB.raw.prepare(sql).all(...p);
  // Tudo o que pertence ao aluno, linha a linha (para provar "nada apagado / nada alterado").
  const snap = id => JSON.stringify([row('SELECT * FROM students WHERE id = ?', id), ...HIST.map(t => rows(`SELECT * FROM ${t} WHERE student_id = ? ORDER BY rowid`, id))]);
  const totals = () => JSON.stringify(['students', 'lessons', ...HIST].map(t => row(`SELECT count(*) n FROM ${t}`).n));
  const audits = () => row('SELECT count(*) n FROM audit_log').n;
  const deleted = id => rows("SELECT * FROM audit_log WHERE event = 'student_deleted' AND target_id = ?", id);
  return { DB, ctl, call, row, rows, snap, totals, audits, deleted };
}
async function boot(w) {
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  const admin = (await w.call('POST', '/api/setup', { academy_name: 'Academia', name: 'Dono Da Silva', email: 'dono@x.test', password: 'cordafina-71', setup_code: code })).session;
  await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: admin });
  const prof = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session;
  const tech = (await w.call('POST', '/api/techniques', { name: 'Armlock', category: 'Finalizações' }, { cookie: admin })).body.id;
  return { admin, prof, tech, A1: w.row("SELECT id FROM staff WHERE email = 'dono@x.test'").id, P: w.row("SELECT id FROM staff WHERE email = 'p1@x.test'").id };
}
const FULL = { nickname: 'Apelido', birth_date: '2001-02-03', sex: 'f', phone: '11 95555-4444', email: 'aluna@x.test', start_date: '2024-03-04', prior_months: 7, weight_kg: 61.5, goals: 'Competir', notes: 'Observação do professor', belt: 'azul', degrees: 2, belt_since: '2024-05-06', degree_since: '2024-09-10', imported_classes_belt: 30, imported_classes_degree: 12 };
const mk = async (w, admin, name) => (await w.call('POST', '/api/students', { name, ...FULL }, { cookie: admin })).body.student.id;
const del = (w, ck, id) => w.call('DELETE', '/api/students/' + id, undefined, { cookie: ck });

// ================= sem histórico: exclusão permitida =================
{ const w = world(); const { admin, A1 } = await boot(w);
  const S = await mk(w, admin, 'Cadastro Por Engano');
  const t0 = JSON.parse(w.totals()), a0 = w.audits();
  const r = await del(w, admin, S);
  const ev = w.deleted(S);
  ok(r.status === 200 && !w.row('SELECT 1 x FROM students WHERE id = ?', S), 'aluno sem histórico: 200 e cadastro apagado');
  ok(ev.length === 1 && ev[0].actor_id === A1 && ev[0].target_type === 'student' && ev[0].outcome === 'ok' && ev[0].staff_id === null && ev[0].detail === '{"presencas":0,"graduacoes":0,"avaliacoes":0}' && w.audits() === a0 + 1,
    'exatamente um student_deleted (ator, alvo, resultado, formato da 6.4-C com contagens 0) e nenhum outro evento');
  const t1 = JSON.parse(w.totals());
  ok(t1[0] === t0[0] - 1 && t1.slice(1).join() === t0.slice(1).join(), 'só a linha do aluno saiu: aulas, presenças, graduações e avaliações intactas');
  ok((await del(w, admin, S)).status === 404 && w.deleted(S).length === 1, 'excluir de novo: 404, nenhum evento a mais');
  ok((await del(w, admin, crypto.randomUUID())).status === 404, 'aluno inexistente: 404'); }

// ================= cada categoria de histórico, isolada =================
{ const w = world(); const { admin, tech } = await boot(w);
  const cases = [
    ['presença (attendance)', async S => { await w.call('POST', '/api/lessons', { date: '2025-06-02', start_time: '19:00', end_time: '20:00', student_ids: [S] }, { cookie: admin }); }],
    ['graduação (promotions)', async S => { await w.call('POST', `/api/students/${S}/promote`, { kind: 'grau', date: '2025-06-03', override: true }, { cookie: admin }); }],
    ['avaliação atual (skills)', async S => { w.DB.raw.prepare('INSERT INTO skills (student_id, technique_id, level) VALUES (?, ?, 2)').run(S, tech); }],
    ['registro de avaliação (skill_history)', async S => { w.DB.raw.prepare('INSERT INTO skill_history (student_id, technique_id, level) VALUES (?, ?, 2)').run(S, tech); }]
  ];
  for (const [label, add] of cases) {
    const S = await mk(w, admin, 'Aluno ' + label.slice(0, 20));
    await add(S);
    const counts = HIST.map(t => w.row(`SELECT count(*) n FROM ${t} WHERE student_id = ?`, S).n);
    assert.strictEqual(counts.filter(Boolean).length, 1, 'cenário isolado: ' + label + ' ' + counts);
    const s0 = w.snap(S), t0 = w.totals(), a0 = w.audits();
    const r = await del(w, admin, S);
    ok(r.status === 409 && CONFLICT.test(r.body.error) && w.snap(S) === s0 && w.totals() === t0 && w.audits() === a0 && !w.deleted(S).length,
      `só ${label}: 409 com orientação para inativar; cadastro e histórico idênticos, nenhuma linha a menos em nenhuma tabela, nenhum evento`);
  }
  // "visto em aula" que sobra depois de excluir a aula
  const S = await mk(w, admin, 'Aluno Aula Excluida');
  const L = (await w.call('POST', '/api/lessons', { date: '2025-06-04', start_time: '19:00', end_time: '20:00', student_ids: [S], technique_ids: [tech] }, { cookie: admin })).body.id;
  ok((await w.call('DELETE', '/api/lessons/' + L, undefined, { cookie: admin })).status === 200, 'aula com o aluno excluída');
  const left = HIST.map(t => w.row(`SELECT count(*) n FROM ${t} WHERE student_id = ?`, S).n);
  ok(left.join() === '0,0,1,0', 'sobra só o "visto em aula" (skills) criado pela chamada');
  const s0 = w.snap(S);
  ok((await del(w, admin, S)).status === 409 && w.snap(S) === s0 && !w.deleted(S).length, 'skills remanescente de aula excluída: 409, nada apagado (o caminho é inativar)'); }

// ================= histórico criado entre a leitura e o batch =================
{ const w = world(); const { admin } = await boot(w);
  const S = await mk(w, admin, 'Aluno Corrida');
  const L = (await w.call('POST', '/api/lessons', { date: '2025-06-05', start_time: '19:00', end_time: '20:00' }, { cookie: admin })).body.id;
  w.ctl.beforeBatch = () => w.DB.raw.prepare('INSERT INTO attendance (lesson_id, student_id) VALUES (?, ?)').run(L, S);   // chamada gravada no meio do caminho
  const a0 = w.audits();
  const r = await del(w, admin, S);
  ok(r.status === 409 && w.row('SELECT count(*) n FROM students WHERE id = ?', S).n === 1 && w.row('SELECT count(*) n FROM attendance WHERE student_id = ?', S).n === 1 && w.audits() === a0,
    'presença gravada depois da conferência e antes do batch: 409, aluno e presença mantidos, nenhum student_deleted (a condição vale DENTRO do batch)'); }

// ================= concorrência: chamada x exclusão =================
{ const w = world(); const { admin } = await boot(w);
  // ordem forçada 1: a exclusão acontece entre a conferência da chamada e o batch dela
  const S1 = await mk(w, admin, 'Aluno Ordem Um');
  w.ctl.beforeBatch = async () => { const r = await del(w, admin, S1); assert.strictEqual(r.status, 200); };
  const l1 = await w.call('POST', '/api/lessons', { date: '2025-06-06', start_time: '19:00', end_time: '20:00', student_ids: [S1] }, { cookie: admin });
  ok(l1.status >= 400 && l1.status < 500 && !w.row('SELECT 1 x FROM students WHERE id = ?', S1) && w.row("SELECT count(*) n FROM lessons WHERE date = '2025-06-06'").n === 0 && w.deleted(S1).length === 1,
    'exclusão primeiro: aluno excluído (1 evento) e a chamada recusada inteira (sem aula, sem presença órfã)');
  // ordem forçada 2: a chamada é gravada entre a conferência da exclusão e o batch dela
  const S2 = await mk(w, admin, 'Aluno Ordem Dois');
  w.ctl.beforeBatch = async () => { const r = await w.call('POST', '/api/lessons', { date: '2025-06-07', start_time: '19:00', end_time: '20:00', student_ids: [S2] }, { cookie: admin }); assert.strictEqual(r.status, 201); };
  const d2 = await del(w, admin, S2);
  ok(d2.status === 409 && w.row('SELECT count(*) n FROM attendance WHERE student_id = ?', S2).n === 1 && !w.deleted(S2).length, 'chamada primeiro: exclusão recusada (409), presença preservada, nenhum evento');
  // simultâneas de verdade, com atrasos aleatórios: qualquer ordem, sempre um dos dois desfechos consistentes
  w.ctl.lat = 6; const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const S = await mk(w, admin, 'Aluno Paralelo ' + i), date = `2025-07-${String(i + 1).padStart(2, '0')}`;
    const [l, d] = await Promise.all([w.call('POST', '/api/lessons', { date, start_time: '19:00', end_time: '20:00', student_ids: [S] }, { cookie: admin }), del(w, admin, S)]);
    const alive = !!w.row('SELECT 1 x FROM students WHERE id = ?', S), att = w.row('SELECT count(*) n FROM attendance WHERE student_id = ?', S).n, ls = w.row('SELECT count(*) n FROM lessons WHERE date = ?', date).n, ev = w.deleted(S).length;
    const lessonWon = l.status === 201 && d.status === 409 && alive && att === 1 && ls === 1 && ev === 0;
    const deleteWon = d.status === 200 && l.status >= 400 && !alive && att === 0 && ls === 0 && ev === 1;
    assert.ok(lessonWon !== deleteWon, `rodada ${i}: desfecho inconsistente (aula ${l.status}, exclusão ${d.status}, aluno ${alive}, presenças ${att}, aulas ${ls}, eventos ${ev})`);
    seen.add(lessonWon ? 'chamada' : 'exclusao');
  }
  w.ctl.lat = 0;
  ok(true, `25 rodadas simultâneas chamada x exclusão: sempre "chamada gravada e exclusão recusada" ou "aluno excluído e chamada recusada", nunca meio-termo (vistos: ${[...seen].join(', ')})`); }

// ================= duas exclusões simultâneas =================
{ const w = world(); const { admin } = await boot(w);
  w.ctl.lat = 6;
  for (let i = 0; i < 15; i++) {
    const S = await mk(w, admin, 'Aluno Duplo ' + i);
    const st = (await Promise.all([del(w, admin, S), del(w, admin, S)])).map(r => r.status).sort();
    assert.deepStrictEqual(st, [200, 404], `rodada ${i}: ${st}`);
    assert.strictEqual(w.deleted(S).length, 1, `rodada ${i}: eventos`);
  }
  w.ctl.lat = 0;
  ok(true, '15 rodadas de duas exclusões simultâneas: sempre um 200 e um 404, exatamente um student_deleted'); }

// ================= falhas: nada parcial =================
{ const w = world(); const { admin } = await boot(w);
  const S = await mk(w, admin, 'Aluno Falha');
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON audit_log WHEN NEW.event = 'student_deleted' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  let s0 = w.snap(S), a0 = w.audits();
  ok((await del(w, admin, S)).status === 500 && w.snap(S) === s0 && w.audits() === a0, 'falha ao gravar o evento: 500 e o aluno NÃO é excluído');
  w.DB.raw.exec('DROP TRIGGER falha');
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE DELETE ON students BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  ok((await del(w, admin, S)).status === 500 && w.snap(S) === s0 && w.audits() === a0 && !w.deleted(S).length, 'falha no DELETE: 500, aluno mantido e nenhum student_deleted');
  w.DB.raw.exec('DROP TRIGGER falha');
  ok((await del(w, admin, S)).status === 200 && w.deleted(S).length === 1, 'sem a falha, a mesma exclusão funciona e gera um único evento'); }

// ================= permissões inalteradas =================
{ const w = world(); const { admin, prof, P } = await boot(w);
  const S = await mk(w, admin, 'Aluno Sem Historico');
  const s0 = w.snap(S);
  const r = await del(w, prof, S);
  const den = w.rows("SELECT * FROM audit_log WHERE event = 'action_denied'").pop();
  ok(r.status === 403 && w.snap(S) === s0 && !w.deleted(S).length && den.actor_id === P && den.target_id === S && JSON.parse(den.detail).acao === 'student_delete', 'professor (mesmo com aluno sem histórico): 403, nada apagado, action_denied como antes');
  ok((await del(w, prof, crypto.randomUUID())).status === 404, 'professor com aluno inexistente: 404 (ordem de verificação como antes)'); }

// ================= inativar e reativar: só a situação muda =================
{ const w = world(); const { admin, prof, tech } = await boot(w);
  const S = await mk(w, admin, 'Aluna Completa');
  const L = (await w.call('POST', '/api/lessons', { date: '2025-06-02', start_time: '19:00', end_time: '20:00', student_ids: [S], technique_ids: [tech] }, { cookie: admin })).body.id;
  await w.call('POST', `/api/students/${S}/promote`, { kind: 'grau', date: '2025-06-03', override: true }, { cookie: admin });
  await w.call('PUT', `/api/students/${S}/skills`, { technique_id: tech, level: 3 }, { cookie: admin });
  ok(HIST.every(t => w.row(`SELECT count(*) n FROM ${t} WHERE student_id = ?`, S).n > 0), 'aluna com histórico nas quatro tabelas');
  // Mesmo pedido que a interface monta (web/app.js, inactivateStudent): cadastro completo lido do servidor + a situação nova.
  const FIELDS = JSON.parse(readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').match(/const STUDENT_PUT_FIELDS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  const uiPut = async (status, ck = admin) => { const cur = (await w.call('GET', '/api/students/' + S, undefined, { cookie: ck })).body.student; return w.call('PUT', '/api/students/' + S, { ...Object.fromEntries(FIELDS.map(k => [k, cur[k] ?? null])), status }, { cookie: ck }); };
  const strip = r => { const { status, updated_at, ...rest } = r; return JSON.stringify(rest); };
  const row0 = w.row('SELECT * FROM students WHERE id = ?', S), hist0 = JSON.stringify(HIST.map(t => w.rows(`SELECT * FROM ${t} WHERE student_id = ? ORDER BY rowid`, S)));
  const lessonAtt = () => w.row('SELECT count(*) n FROM attendance WHERE lesson_id = ?', L).n;
  const att0 = lessonAtt(), dash0 = (await w.call('GET', '/api/state', undefined, { cookie: admin })).body.dashboard.weekly.map(x => x.attendance).join();
  const a0 = w.rows('SELECT event FROM audit_log').length;
  const r1 = await uiPut('inativo');
  const row1 = w.row('SELECT * FROM students WHERE id = ?', S);
  ok(r1.status === 200 && row1.status === 'inativo' && strip(row1) === strip(row0), 'inativar (pedido igual ao da interface): só status muda; nome, apelido, contato, datas, faixa, graus, aulas anteriores e observações idênticos');
  ok(JSON.stringify(HIST.map(t => w.rows(`SELECT * FROM ${t} WHERE student_id = ? ORDER BY rowid`, S))) === hist0 && lessonAtt() === att0
    && (await w.call('GET', '/api/state', undefined, { cookie: admin })).body.dashboard.weekly.map(x => x.attendance).join() === dash0, 'inativar preserva presenças, graduações e avaliações; contagem da aula e presença semanal do painel inalteradas');
  const evs = w.rows('SELECT event, detail FROM audit_log').slice(a0);
  ok(evs.length === 1 && evs[0].event === 'student_status_changed' && evs[0].detail === '{"de":"ativo","para":"inativo"}', 'auditoria: um student_status_changed (ativo → inativo) e nenhum student_updated (nenhum outro campo mudou)');
  const s0 = w.snap(S);
  ok((await del(w, admin, S)).status === 409 && w.snap(S) === s0, 'inativa e com histórico: continua sem poder ser excluída');
  const r2 = await uiPut('ativo');
  const row2 = w.row('SELECT * FROM students WHERE id = ?', S);
  ok(r2.status === 200 && row2.status === 'ativo' && strip(row2) === strip(row0) && JSON.stringify(HIST.map(t => w.rows(`SELECT * FROM ${t} WHERE student_id = ? ORDER BY rowid`, S))) === hist0, 'reativar: volta a ativo com todos os demais dados e o histórico idênticos ao original');
  ok((await uiPut('inativo', prof)).status === 200 && w.row('SELECT status FROM students WHERE id = ?', S).status === 'inativo', 'professor continua podendo mudar a situação (permissões inalteradas)'); }

ok(errs.filter(e => !/falha simulada/.test(e)).length === 0, 'nenhum erro inesperado no console do Worker');
console.log('\nEXCLUSÃO DE ALUNOS (V12) OK');
