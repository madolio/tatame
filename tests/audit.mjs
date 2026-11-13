// Etapa 6.4-C (V6): auditoria das ações administrativas e operações sensíveis. Confere o que fica GRAVADO em audit_log
// (evento, ator, alvo, resultado, detail exato, staff_id legado), não só a existência de uma linha: um evento por operação
// bem-sucedida, nenhum evento quando a escrita não acontece (condição, falha de batch), negações com identidade, ausência
// de dados pessoais e segredos e a allowlist do helper. Banco em memória (sem arquivos temporários).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';
import { generateCode as newResetCode, buildSql as resetSql } from '../tools/reset-code.mjs';

const WORKER = fileURLToPath(new URL('../web/_worker.js', import.meta.url));
const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const errs = []; console.error = (...a) => errs.push(a.join(' '));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function world() {
  const DB = makeD1(); DB.load(SCHEMA);
  const ctl = { beforeBatch: null };
  const ob = DB.batch.bind(DB);
  DB.batch = async s => { if (ctl.beforeBatch) { const f = ctl.beforeBatch; ctl.beforeBatch = null; await f(s); } return ob(s); };
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  let ipn = 1;
  const call = async (method, path, body, { cookie = '', ip } = {}) => {
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie, 'cf-connecting-ip': ip || '198.51.100.' + (ipn++ % 200 + 1) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, text, session: ((r.headers.getSetCookie?.() || []).find(c => c.startsWith('tatame_sid=')) || '').split(';')[0] };
  };
  const row = (sql, ...p) => DB.raw.prepare(sql).get(...p);
  const rows = (sql, ...p) => DB.raw.prepare(sql).all(...p);
  const ev = e => rows('SELECT * FROM audit_log WHERE event = ? ORDER BY id', e);
  const last = () => row('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1');
  const count = () => row('SELECT count(*) n FROM audit_log').n;
  // Linha no formato comparável: colunas estruturadas + detail parseado.
  const shape = r => r && ({ event: r.event, staff_id: r.staff_id, actor_id: r.actor_id, target_type: r.target_type, target_id: r.target_id, outcome: r.outcome, detail: r.detail && r.detail.startsWith('{') ? JSON.parse(r.detail) : r.detail });
  return { DB, env, ctl, call, row, rows, ev, last, count, shape };
}
const SETUP = { academy_name: 'Academia Sigilosa', name: 'Dono Da Silva', email: 'dono@x.test', password: 'cordafina-71' };
async function boot(w) {
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  const r = await w.call('POST', '/api/setup', { ...SETUP, setup_code: code });
  assert.strictEqual(r.status, 201);
  return { admin: r.session, A1: w.row('SELECT id FROM staff WHERE email = ?', SETUP.email).id, code };
}
const mkTech = async (w, cookie, name = 'Técnica ' + crypto.randomUUID().slice(0, 8)) => (await w.call('POST', '/api/techniques', { name, category: 'Guarda' }, { cookie })).body.id;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Evento esperado (campos estruturados + detail exato). staff_id: NULL nos eventos novos.
const is = (got, exp) => eq(got, exp) || (console.log('   obtido  :', JSON.stringify(got), '\n   esperado:', JSON.stringify(exp)), false);
const E = (event, actor, tt, tid, extra = {}) => ({ event, staff_id: null, actor_id: actor, target_type: tt, target_id: tid, outcome: 'ok', detail: null, ...extra });

// ================= setup inicial =================
{ const w = world();
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  ok((await w.call('POST', '/api/setup', { ...SETUP, setup_code: generateCode() })).status === 403 && w.count() === 0, 'setup com código errado: 403 e nenhum evento');
  const r = await w.call('POST', '/api/setup', { ...SETUP, setup_code: code });
  const A1 = w.row('SELECT id FROM staff').id;
  ok(r.status === 201 && w.count() === 1 && is(w.shape(w.last()), E('setup_completed', A1, 'staff', A1, { detail: { papel: 'admin' } })), 'setup: exatamente um setup_completed — ator e alvo = o primeiro administrador, resultado ok, staff_id NULL, detail {papel: admin}');
  ok((await w.call('POST', '/api/setup', { ...SETUP, email: 'outro@x.test', setup_code: code })).status === 409 && w.count() === 1, 'segundo setup (recusado, 409): nenhum evento novo');
  const w4 = world(); const c4 = generateCode(); w4.DB.raw.exec(buildSetupSql(c4));
  w4.ctl.beforeBatch = () => w4.DB.raw.exec("DELETE FROM settings WHERE key = 'setup_token_hash'");   // código consumido/trocado entre a conferência e o batch
  ok((await w4.call('POST', '/api/setup', { ...SETUP, setup_code: c4 })).status === 403 && w4.count() === 0 && w4.row('SELECT count(*) n FROM staff').n === 0, 'código invalidado entre a conferência e o batch: nenhum administrador e nenhum setup_completed (evento com a mesma condição do INSERT)');
  const w2 = world(); const c2 = generateCode(); w2.DB.raw.exec(buildSetupSql(c2));
  w2.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON settings WHEN NEW.key = 'setup_done' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  ok((await w2.call('POST', '/api/setup', { ...SETUP, setup_code: c2 })).status === 500 && w2.count() === 0 && w2.row('SELECT count(*) n FROM staff').n === 0, 'falha no meio do batch do setup: nem administrador nem setup_completed');
  const w3 = world(); const c3 = generateCode(); w3.DB.raw.exec(buildSetupSql(c3));
  w3.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON audit_log WHEN NEW.event = 'setup_completed' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  ok((await w3.call('POST', '/api/setup', { ...SETUP, setup_code: c3 })).status === 500 && w3.row('SELECT count(*) n FROM staff').n === 0 && w3.row("SELECT count(*) n FROM settings WHERE key = 'setup_token_hash'").n === 1, 'falha ao gravar o evento do setup: nenhum administrador criado e o código continua valendo'); }

// ================= equipe =================
{ const w = world(); const { admin, A1 } = await boot(w);
  const n0 = w.count();
  const cp = await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor', belt: 'roxa' }, { cookie: admin });
  const P = cp.body.id;
  ok(cp.status === 201 && w.count() === n0 + 1 && is(w.shape(w.last()), E('staff_created', A1, 'staff', P, { detail: { papel: 'professor' } })), 'criação de professor: staff_created com ator (admin), alvo (a conta nova) e papel');
  const ca = await w.call('POST', '/api/staff', { name: 'Admin Dois', email: 'a2@x.test', password: 'kimono-azul-26', role: 'admin' }, { cookie: admin });
  const A2 = ca.body.id;
  ok(ca.status === 201 && is(w.shape(w.last()), E('staff_created', A1, 'staff', A2, { detail: { papel: 'admin' } })), 'criação de ADMINISTRADOR: staff_created com papel "admin"');
  ok((await w.call('POST', '/api/staff', { name: 'Repetido', email: 'p1@x.test', password: 'pedra-lisa-43', role: 'professor' }, { cookie: admin })).status === 409 && w.ev('staff_created').length === 2, 'criação recusada (e-mail repetido): nenhum evento');

  let n = w.count();
  ok((await w.call('PUT', '/api/staff/' + P, { name: 'Prof Um', role: 'admin' }, { cookie: admin })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('staff_role_changed', A1, 'staff', P, { detail: { de: 'professor', para: 'admin' } })), 'mudança de papel: um staff_role_changed com de/para');
  n = w.count();
  ok((await w.call('PUT', '/api/staff/' + P, { name: 'Prof Um', role: 'professor', active: false }, { cookie: admin })).status === 200 && w.count() === n + 2
    && eq(w.rows('SELECT * FROM audit_log ORDER BY id DESC LIMIT 2').reverse().map(w.shape), [E('staff_role_changed', A1, 'staff', P, { detail: { de: 'admin', para: 'professor' } }), E('staff_deactivated', A1, 'staff', P, { detail: { sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } })]),
    'rebaixar e desativar na mesma requisição: dois eventos (papel e desativação), cada um com seu conteúdo');
  n = w.count();
  ok((await w.call('PUT', '/api/staff/' + P, { active: true }, { cookie: admin })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('staff_reactivated', A1, 'staff', P)), 'reativação: um staff_reactivated');
  n = w.count();
  ok((await w.call('PUT', '/api/staff/' + P, { name: 'Prof Renomeado', belt: 'marrom' }, { cookie: admin })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('staff_updated', A1, 'staff', P, { detail: { campos: ['name', 'belt'] } })), 'nome e faixa: staff_updated só com os NOMES dos campos');
  n = w.count();
  ok((await w.call('PUT', '/api/staff/' + P, { name: 'Prof Renomeado', belt: 'marrom', role: 'professor', active: true }, { cookie: admin })).status === 200 && w.count() === n, 'PUT sem nenhuma mudança: nenhum evento');
  n = w.count();
  ok((await w.call('PUT', '/api/staff/' + P, { name: 'Prof Renomeado', password: 'senha-nova-do-prof' }, { cookie: admin })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('staff_password_reset', A1, 'staff', P, { staff_id: A1, detail: { conta: P, sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } })),
    'redefinição administrativa de senha: staff_password_reset com o formato anterior (staff_id = quem fez, detail.conta = alvo) + ator/alvo estruturados');
  // autorização vencida no meio da requisição (V8): nada aplicado, nenhum evento de alteração, e a negação registrada
  const a2 = (await w.call('POST', '/api/login', { email: 'a2@x.test', password: 'kimono-azul-26' })).session;
  n = w.count();
  w.ctl.beforeBatch = () => w.DB.raw.prepare("UPDATE staff SET role = 'professor' WHERE id = ?").run(A2);
  const st = await w.call('PUT', '/api/staff/' + P, { name: 'Prof Renomeado', role: 'admin', active: false }, { cookie: a2 });
  ok(st.status === 403 && w.count() === n + 1 && is(w.shape(w.last()), E('action_denied', A2, 'staff', P, { outcome: 'denied', detail: { acao: 'staff_update', motivo: 'requer_admin' } })), 'admin rebaixado entre a leitura e o batch: 403, NENHUM evento de papel/desativação, só action_denied (requer_admin)');
  ok(w.row('SELECT role, active FROM staff WHERE id = ?', P).role === 'professor' && w.row('SELECT active FROM staff WHERE id = ?', P).active === 1, 'e a conta-alvo ficou intacta (operação condicional sem registro indevido)'); }

// ================= alunos =================
{ const w = world(); const { admin, A1 } = await boot(w);
  await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: admin });
  const prof = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session, P = w.row("SELECT id FROM staff WHERE email = 'p1@x.test'").id;
  const PII = { name: 'Joana Pessoal Exemplo', nickname: 'Jojo Secreta', phone: '+55 11 98888-7777', email: 'joana.pessoal@exemplo.test', notes: 'alergia a látex (observação pessoal)', goals: 'objetivo particular' };
  const cs = await w.call('POST', '/api/students', { ...PII, birth_date: '2000-05-05', start_date: '2025-01-10', belt: 'azul', degrees: 2 }, { cookie: prof });
  const S = cs.body.student.id;
  ok(cs.status === 201 && is(w.shape(w.last()), E('student_created', P, 'student', S, { detail: { situacao: 'ativo', faixa: 'azul', graus: 2 } })), 'criação de aluno (professor): student_created com ator, alvo e só faixa/graus/situação');
  let n = w.count();
  ok((await w.call('PUT', '/api/students/' + S, { ...PII, birth_date: '2000-05-05', start_date: '2025-01-10', nickname: 'Outro Apelido', phone: '+55 11 90000-0000' }, { cookie: prof })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('student_updated', P, 'student', S, { detail: { campos: ['nickname', 'phone'] } })), 'alteração de aluno: student_updated com os NOMES dos campos alterados, sem os valores');
  n = w.count();
  ok((await w.call('PUT', '/api/students/' + S, { ...PII, birth_date: '2000-05-05', start_date: '2025-01-10', nickname: 'Outro Apelido', phone: '+55 11 90000-0000', status: 'inativo' }, { cookie: prof })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('student_status_changed', P, 'student', S, { detail: { de: 'ativo', para: 'inativo' } })), 'desativação de aluno: student_status_changed ativo → inativo (sem student_updated)');
  ok((await w.call('PUT', '/api/students/' + S, { ...PII, birth_date: '2000-05-05', start_date: '2025-01-10', nickname: 'Outro Apelido', phone: '+55 11 90000-0000', status: 'ativo' }, { cookie: admin })).status === 200
    && is(w.shape(w.last()), E('student_status_changed', A1, 'student', S, { detail: { de: 'inativo', para: 'ativo' } })), 'reativação de aluno: student_status_changed inativo → ativo, ator = quem reativou');
  const base = { ...PII, birth_date: '2000-05-05', start_date: '2025-01-10', nickname: 'Outro Apelido', phone: '+55 11 90000-0000' };
  n = w.count();
  const den = await w.call('PUT', '/api/students/' + S, { ...base, belt_since: '2025-02-01' }, { cookie: prof });
  ok(den.status === 403 && w.count() === n + 1 && is(w.shape(w.last()), E('action_denied', P, 'student', S, { outcome: 'denied', detail: { acao: 'student_graduation_fix', motivo: 'requer_admin' } })), 'professor tenta corrigir graduação: 403 e só action_denied (nada alterado registrado)');
  const g0 = w.row('SELECT belt_since, degree_since, imported_classes_belt, imported_classes_degree FROM students WHERE id = ?', S);
  n = w.count();
  ok((await w.call('PUT', '/api/students/' + S, { ...base, belt_since: '2025-02-01', degree_since: '2025-03-01', imported_classes_belt: 40, imported_classes_degree: 10 }, { cookie: admin })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('student_graduation_corrected', A1, 'student', S, { detail: { antes: g0, depois: { belt_since: '2025-02-01', degree_since: '2025-03-01', imported_classes_belt: 40, imported_classes_degree: 10 } } })),
    'correção administrativa de graduação: student_graduation_corrected com antes/depois (datas e contagens)');
  // aluno excluído entre a leitura e o batch: a alteração não acontece e não há evento
  const tmp = (await w.call('POST', '/api/students', { name: 'Temporário', start_date: '2025-01-10' }, { cookie: admin })).body.student.id;
  n = w.count();
  w.ctl.beforeBatch = () => w.DB.raw.prepare('DELETE FROM students WHERE id = ?').run(tmp);
  const gone = await w.call('PUT', '/api/students/' + tmp, { name: 'Outro Nome', start_date: '2025-01-10' }, { cookie: admin });
  ok(gone.status === 404 && w.count() === n, 'aluno excluído no meio da edição: nenhum student_updated (operação condicional sem registro indevido)');
  // exclusão: o tamanho do histórico, sem dados
  const L = (await w.call('POST', '/api/lessons', { date: '2025-06-02', start_time: '19:00', end_time: '20:00', student_ids: [S] }, { cookie: admin })).body.id;
  await w.call('POST', `/api/students/${S}/promote`, { kind: 'grau', date: '2025-06-03', override: true }, { cookie: admin });
  await w.call('PUT', `/api/students/${S}/skills`, { technique_id: await mkTech(w, admin), level: 2 }, { cookie: admin });
  n = w.count();
  ok((await w.call('DELETE', '/api/students/' + S, undefined, { cookie: prof })).status === 403 && is(w.shape(w.last()), E('action_denied', P, 'student', S, { outcome: 'denied', detail: { acao: 'student_delete', motivo: 'requer_admin' } })), 'professor tenta excluir aluno: 403 e action_denied');
  // 6.4-D (V12): aluno com histórico não é mais excluído (409, nada apagado, nenhum student_deleted); detalhes em tests/student_delete.mjs
  n = w.count();
  ok((await w.call('DELETE', '/api/students/' + S, undefined, { cookie: admin })).status === 409 && w.count() === n && !w.ev('student_deleted').length && w.row('SELECT count(*) n FROM students WHERE id = ?', S).n === 1,
    'exclusão de aluno COM histórico (6.4-D): 409, cadastro mantido e nenhum student_deleted');
  ok(L && w.row('SELECT count(*) n FROM attendance WHERE lesson_id = ?', L).n === 1, 'presença preservada (sem cascata)');
  const S0 = (await w.call('POST', '/api/students', { name: 'Cadastro Por Engano', start_date: '2025-01-10' }, { cookie: admin })).body.student.id;
  n = w.count();
  ok((await w.call('DELETE', '/api/students/' + S0, undefined, { cookie: admin })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('student_deleted', A1, 'student', S0, { detail: { presencas: 0, graduacoes: 0, avaliacoes: 0 } })),
    'exclusão de aluno SEM histórico: um student_deleted no formato da 6.4-C (contagens 0), sem dados do aluno');
  const dump = JSON.stringify(w.rows('SELECT * FROM audit_log'));
  ok(Object.values(PII).every(v => !dump.includes(v)) && !dump.includes('Outro Apelido') && !dump.includes('90000-0000') && !dump.includes('2000-05-05') && !dump.includes('Temporário'), 'nenhum nome, apelido, telefone, e-mail, nascimento, objetivo ou observação de aluno na auditoria'); }

// ================= graduações =================
{ const w = world(); const { admin, A1 } = await boot(w);
  const S = (await w.call('POST', '/api/students', { name: 'Aluno Grad', start_date: '2024-01-10', belt: 'branca' }, { cookie: admin })).body.student.id;
  let n = w.count();
  const pr = await w.call('POST', `/api/students/${S}/promote`, { kind: 'faixa', to_belt: 'azul', date: '2025-06-01', override: true, notes: 'nota livre que não vai para a auditoria' }, { cookie: admin });
  const PID = w.row('SELECT id FROM promotions WHERE student_id = ?', S).id;
  ok(pr.status === 201 && w.count() === n + 1 && is(w.shape(w.last()), E('promotion_created', A1, 'promotion', PID, { detail: { aluno: S, tipo: 'faixa', de_faixa: 'branca', de_graus: 0, para_faixa: 'azul', para_graus: 0, data: '2025-06-01', criterios_cumpridos: false } })),
    'registro de graduação: promotion_created (alvo = a graduação; aluno, de/para, data, critérios cumpridos ou confirmação manual)');
  n = w.count();
  ok((await w.call('DELETE', '/api/promotions/' + PID, undefined, { cookie: admin })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('promotion_undone', A1, 'promotion', PID, { detail: { aluno: S, tipo: 'faixa', de_faixa: 'branca', de_graus: 0, para_faixa: 'azul', para_graus: 0 } })),
    'desfazer graduação: promotion_undone com o de/para da graduação desfeita');
  await w.call('POST', `/api/students/${S}/promote`, { kind: 'grau', date: '2025-06-02', override: true }, { cookie: admin });
  const P2 = w.row('SELECT id FROM promotions WHERE student_id = ?', S).id;
  n = w.count();
  w.ctl.beforeBatch = () => w.DB.raw.prepare('DELETE FROM promotions WHERE id = ?').run(P2);
  await w.call('DELETE', '/api/promotions/' + P2, undefined, { cookie: admin });
  ok(w.count() === n, 'graduação já desfeita por outra requisição no meio do caminho: nenhum promotion_undone extra');
  ok(!JSON.stringify(w.rows('SELECT * FROM audit_log')).includes('nota livre'), 'observação da graduação não vai para a auditoria'); }

// ================= aulas =================
// Textos livres com cara de dado pessoal: não podem aparecer na auditoria.
const TXT = { t1: 'Guarda da Maria Exemplo', n1: 'Maria Exemplo machucou o joelho, tel 11 97777-6666', t2: 'Revisão do João Exemplo', n2: 'João Exemplo faltou por doença' };
const BEFORE_KEYS = 'id,class_id,date,start_time,end_time,modality,instructor_id,created_by,created_at,roll_called,student_ids,technique_ids';
const AFTER_KEYS = 'class_id,date,start_time,end_time,modality,instructor_id,roll_called,student_ids,technique_ids';
{ const w = world(); const { admin, A1 } = await boot(w);
  const S = (await w.call('POST', '/api/students', { name: 'Aluno Aula', start_date: '2024-01-10' }, { cookie: admin })).body.student.id;
  const C = (await w.call('POST', '/api/classes', { name: 'Turma Noite', weekday: 1, start_time: '19:00', end_time: '20:30' }, { cookie: admin })).body.id;
  const T = await mkTech(w, admin);
  // registro histórico (formato de antes do ajuste: tema e observações no retrato): deve continuar intacto e legível
  w.DB.raw.prepare("INSERT INTO audit_log (at, event, staff_id, detail) VALUES ('2026-01-01T00:00:00.000Z', 'lesson_deleted', ?, ?)").run(A1, JSON.stringify({ lesson_id: crypto.randomUUID(), before: { id: 'x', title: 'Tema antigo', notes: 'Observação antiga', student_ids: [] } }));
  const HIST = "SELECT * FROM audit_log WHERE at = '2026-01-01T00:00:00.000Z'", hist = JSON.stringify(w.row(HIST));
  let n = w.count();
  const cl = await w.call('POST', '/api/lessons', { class_id: C, date: '2025-06-02', student_ids: [S], technique_ids: [T], title: TXT.t1, notes: TXT.n1 }, { cookie: admin });
  const L = cl.body.id;
  ok(cl.status === 201 && w.count() === n + 1 && is(w.shape(w.last()), E('lesson_created', A1, 'lesson', L, { detail: { turma: C, data: '2025-06-02', alunos: 1, tecnicas: 1, chamada: 1 } })), 'criação de aula: lesson_created com turma, data, quantidades e marcador de chamada');
  n = w.count();
  ok((await w.call('PUT', '/api/lessons/' + L, { class_id: C, date: '2025-06-02', student_ids: [], roll_called: true, technique_ids: [T], title: TXT.t2, notes: TXT.n2 }, { cookie: admin })).status === 200 && w.count() === n + 1, 'edição de aula: um evento');
  const up = w.shape(w.last());
  ok(up.event === 'lesson_updated' && up.staff_id === A1 && up.actor_id === A1 && up.target_type === 'lesson' && up.target_id === L && up.outcome === 'ok' && Object.keys(up.detail).join() === 'lesson_id,before,after'
    && up.detail.before.student_ids.join() === S && up.detail.after.student_ids.length === 0 && up.detail.after.roll_called === 1, 'lesson_updated: staff_id = quem editou, lesson_id/before/after + ator/alvo/resultado');
  const rawUp = w.last().detail;
  ok(Object.keys(up.detail.before).join() === BEFORE_KEYS && Object.keys(up.detail.after).join() === AFTER_KEYS, 'lesson_updated: before e after só com ids, data, horários, modalidade, marcador e listas');
  ok(!/title|notes/.test(rawUp) && !Object.values(TXT).some(t => rawUp.includes(t)), 'lesson_updated NÃO armazena tema nem observações (nem os anteriores, nem os novos)');
  // aula de histórico desconhecido (roll_called NULL): editar continua possível e auditado
  w.DB.raw.prepare('UPDATE lessons SET roll_called = NULL WHERE id = ?').run(L); w.DB.raw.exec(`DELETE FROM attendance WHERE lesson_id = '${L}'`);
  ok((await w.call('PUT', '/api/lessons/' + L, { class_id: C, date: '2025-06-02', technique_ids: [T], title: 'Tema' }, { cookie: admin })).status === 200 && w.shape(w.last()).detail.after.roll_called === null, 'aula com marcador desconhecido (NULL): edição permitida e auditada com o valor mantido');
  n = w.count();
  ok((await w.call('DELETE', '/api/lessons/' + L, undefined, { cookie: admin })).status === 200 && w.count() === n + 1, 'exclusão de aula: um evento');
  const del = w.shape(w.last());
  ok(del.event === 'lesson_deleted' && del.staff_id === A1 && del.actor_id === A1 && del.target_id === L && del.detail.lesson_id === L && del.detail.before.id === L, 'lesson_deleted: staff_id, lesson_id, before + ator/alvo');
  const rawDel = w.last().detail;
  ok(Object.keys(del.detail.before).join() === BEFORE_KEYS && !/title|notes/.test(rawDel) && !Object.values(TXT).some(t => rawDel.includes(t)), 'lesson_deleted NÃO armazena tema nem observações');
  ok(JSON.stringify(w.row(HIST)) === hist && JSON.parse(JSON.parse(hist).detail).before.title === 'Tema antigo', 'registro histórico com tema/observações: intacto e legível (nada reescrito, sem migração)');
  const allLesson = JSON.stringify(w.rows("SELECT * FROM audit_log WHERE event LIKE 'lesson_%' AND at <> '2026-01-01T00:00:00.000Z'"));
  ok(!Object.values(TXT).some(t => allLesson.includes(t)), 'nenhum evento de aula novo guarda conteúdo livre da aula');
  // aula excluída por outra requisição entre a leitura e o batch: nem edição, nem evento
  const L2 = (await w.call('POST', '/api/lessons', { date: '2025-06-03', start_time: '19:00', end_time: '20:00' }, { cookie: admin })).body.id;
  n = w.count();
  w.ctl.beforeBatch = () => w.DB.raw.prepare('DELETE FROM lessons WHERE id = ?').run(L2);
  await w.call('PUT', '/api/lessons/' + L2, { date: '2025-06-03', start_time: '19:00', end_time: '20:00', title: 'X' }, { cookie: admin });
  ok(w.count() === n, 'aula excluída no meio da edição: nenhum lesson_updated');
  // falha no batch da chamada: sem aula e sem evento
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON attendance BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  n = w.count(); const nl = w.row('SELECT count(*) n FROM lessons').n;
  ok((await w.call('POST', '/api/lessons', { date: '2025-06-04', start_time: '19:00', end_time: '20:00', student_ids: [S] }, { cookie: admin })).status === 500 && w.count() === n && w.row('SELECT count(*) n FROM lessons').n === nl, 'falha no meio do batch da aula: nem aula nem lesson_created');
  w.DB.raw.exec('DROP TRIGGER falha'); }

// ================= turmas, técnicas, critérios e ajustes =================
{ const w = world(); const { admin, A1 } = await boot(w);
  let n = w.count();
  const cc = await w.call('POST', '/api/classes', { name: 'Turma Kids', weekday: 2, start_time: '17:00', end_time: '18:00', level: 'kids', modality: 'gi', instructor_id: A1 }, { cookie: admin });
  const C = cc.body.id;
  ok(cc.status === 201 && w.count() === n + 1 && is(w.shape(w.last()), E('class_created', A1, 'class', C, { detail: { dia: 2, inicio: '17:00', fim: '18:00', nivel: 'kids', modalidade: 'gi', ativa: 1, instrutor: A1 } })), 'criação de turma: class_created');
  n = w.count();
  ok((await w.call('PUT', '/api/classes/' + C, { name: 'Turma Kids', weekday: 3, start_time: '17:00', end_time: '18:30', level: 'kids', modality: 'gi', instructor_id: A1 }, { cookie: admin })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('class_updated', A1, 'class', C, { detail: { campos: ['weekday', 'end_time'] } })), 'alteração de turma: class_updated com os campos alterados');
  n = w.count();
  ok((await w.call('PUT', '/api/classes/' + C, { name: 'Turma Kids', weekday: 3, start_time: '17:00', end_time: '18:30', level: 'kids', modality: 'gi', instructor_id: A1 }, { cookie: admin })).status === 200 && w.count() === n, 'turma salva sem mudança: nenhum evento');
  ok((await w.call('DELETE', '/api/classes/' + C, undefined, { cookie: admin })).status === 200 && is(w.shape(w.last()), E('class_deleted', A1, 'class', C)), 'exclusão de turma: class_deleted');

  n = w.count();
  const ct = await w.call('POST', '/api/techniques', { name: 'Técnica Auditada', category: 'Guarda', min_belt: 'azul', difficulty: 3, description: 'descrição livre' }, { cookie: admin });
  const TID = String(ct.body.id);
  ok(ct.status === 201 && w.count() === n + 1 && is(w.shape(w.last()), E('technique_created', A1, 'technique', TID, { detail: { categoria: 'Guarda', faixa_minima: 'azul', ativa: 1 } })), 'criação de técnica: technique_created com o id real da técnica (calculado no mesmo batch)');
  n = w.count();
  ok((await w.call('PUT', '/api/techniques/' + TID, { name: 'Técnica Auditada', category: 'Guarda', min_belt: 'azul', difficulty: 4, description: 'outra', active: false }, { cookie: admin })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('technique_updated', A1, 'technique', TID, { detail: { campos: ['difficulty', 'description', 'active'] } })), 'alteração de técnica: technique_updated com os campos');
  ok((await w.call('DELETE', '/api/techniques/' + TID, undefined, { cookie: admin })).status === 200 && is(w.shape(w.last()), E('technique_deleted', A1, 'technique', TID)), 'exclusão de técnica: technique_deleted');
  const used = await mkTech(w, admin); const S = (await w.call('POST', '/api/students', { name: 'Aluno Tec', start_date: '2024-01-10' }, { cookie: admin })).body.student.id;
  await w.call('PUT', `/api/students/${S}/skills`, { technique_id: used, level: 2 }, { cookie: admin });
  n = w.count();
  ok((await w.call('DELETE', '/api/techniques/' + used, undefined, { cookie: admin })).status === 400 && w.count() === n, 'exclusão recusada (técnica em uso): nenhum evento');

  const rules = w.rows('SELECT * FROM rules ORDER BY belt');
  const azul = rules.find(r => r.belt === 'azul');
  n = w.count();
  ok((await w.call('PUT', '/api/rules', { rules: [{ ...azul, degree_months: azul.degree_months + 1 }, rules.find(r => r.belt === 'roxa')] }, { cookie: admin })).status === 200 && w.count() === n + 1
    && is(w.shape(w.last()), E('rules_updated', A1, 'rules', null, { detail: { faixas: ['azul'] } })), 'alteração de critérios: rules_updated com as faixas que mudaram de fato (roxa enviada igual não entra)');
  n = w.count();
  ok((await w.call('PUT', '/api/rules', { rules: [{ ...azul, degree_months: azul.degree_months + 1 }] }, { cookie: admin })).status === 200 && w.count() === n, 'critérios regravados sem mudança: nenhum evento');

  n = w.count();
  ok((await w.call('PUT', '/api/settings', { academy_name: 'Nome Novo Da Academia' }, { cookie: admin })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('settings_updated', A1, 'settings', 'academy_name')), 'alteração de settings: settings_updated (chave como alvo, sem o valor)');
  n = w.count();
  ok((await w.call('PUT', '/api/settings', { academy_name: 'Nome Novo Da Academia' }, { cookie: admin })).status === 200 && w.count() === n, 'settings salvo com o mesmo valor: nenhum evento');
  ok(!JSON.stringify(w.rows('SELECT * FROM audit_log')).match(/Nome Novo Da Academia|Academia Sigilosa|Turma Kids|Técnica Auditada|descrição livre/), 'nomes de turma, técnica e academia e textos livres fora da auditoria'); }

// ================= exportação, logout, negações =================
{ const w = world(); const { admin, A1 } = await boot(w);
  await w.call('POST', '/api/students', { name: 'Aluno Exportado', start_date: '2024-01-10' }, { cookie: admin });
  await w.call('POST', '/api/students', { name: 'Outro Exportado', start_date: '2024-01-10' }, { cookie: admin });
  let n = w.count();
  const ex = await w.call('GET', '/api/export/alunos.csv', undefined, { cookie: admin });
  ok(ex.status === 200 && ex.text.includes('Aluno Exportado') && w.count() === n + 1 && is(w.shape(w.last()), E('students_exported', A1, 'export', 'alunos.csv', { detail: { linhas: 2 } })), 'exportação de alunos.csv: students_exported com o número de linhas, sem o conteúdo');
  // Semântica: o evento existe assim que a resposta com o arquivo é preparada, ANTES de o cliente ler qualquer byte, e continua
  // lá se o cliente abandona o download. Portanto NÃO confirma download nem recebimento.
  n = w.count();
  const raw = await W.fetch(new Request('https://t.test/api/export/alunos.csv', { headers: { cookie: admin } }), w.env);
  const atPrep = w.count();
  await raw.body.cancel();
  ok(raw.status === 200 && atPrep === n + 1 && w.count() === n + 1 && w.last().event === 'students_exported', 'exportação: o evento é gravado ao preparar a resposta, antes de o corpo ser lido, e não muda se o download é abandonado (não é confirmação de download)');
  const doc = readFileSync(fileURLToPath(new URL('../docs/auditoria.md', import.meta.url)), 'utf8');
  ok(/preparado para a resposta/.test(doc) && /não confirma/.test(doc) && !/gerada e liberada/.test(doc), 'docs/auditoria.md: students_exported = exportação processada e arquivo preparado para a resposta; não confirma download');
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON audit_log WHEN NEW.event = 'students_exported' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  const ex2 = await w.call('GET', '/api/export/alunos.csv', undefined, { cookie: admin });
  ok(ex2.status === 500 && !ex2.text.includes('Aluno Exportado'), 'se o registro da exportação falhar, o arquivo NÃO é entregue (sem exportação sem registro)');
  w.DB.raw.exec('DROP TRIGGER falha');

  await w.call('POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: admin });
  const prof = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session, P = w.row("SELECT id FROM staff WHERE email = 'p1@x.test'").id;
  n = w.count();
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push((await w.call('GET', '/api/export/alunos.csv', undefined, { cookie: prof })).status);
  ok(tries.every(s => s === 403) && w.count() === n + 1 && is(w.shape(w.last()), E('action_denied', P, 'export', 'alunos.csv', { outcome: 'denied', detail: { acao: 'students_export', motivo: 'requer_admin' } })),
    '5 tentativas de exportar como professor: todas 403 e UM action_denied (limite por ator e ação em 15 min: a tabela não enche)');
  ok((await w.call('PUT', '/api/settings', { academy_name: 'Tentativa' }, { cookie: prof })).status === 403 && w.count() === n + 2 && is(w.shape(w.last()), E('action_denied', P, 'settings', 'academy_name', { outcome: 'denied', detail: { acao: 'settings_update', motivo: 'requer_admin' } })), 'outra ação negada: um action_denied próprio');
  ok((await w.call('POST', '/api/staff', { name: 'X', email: 'x@x.test', password: 'pedra-lisa-99', role: 'admin' }, { cookie: prof })).status === 403 && is(w.shape(w.last()), E('action_denied', P, null, null, { outcome: 'denied', detail: { acao: 'staff_create', motivo: 'requer_admin' } })), 'professor tenta criar administrador: action_denied sem alvo (a conta não existe)');
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON audit_log WHEN NEW.event = 'action_denied' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  const r403 = await w.call('DELETE', '/api/classes/' + crypto.randomUUID(), undefined, { cookie: prof });
  const C = (await w.call('POST', '/api/classes', { name: 'Turma', weekday: 1, start_time: '19:00', end_time: '20:00' }, { cookie: admin })).body.id;
  const r403b = await w.call('DELETE', '/api/classes/' + C, undefined, { cookie: prof });
  ok(r403.status === 404 && r403b.status === 403 && r403b.body.error === 'Apenas o administrador pode fazer isso.' && w.row('SELECT count(*) n FROM classes WHERE id = ?', C).n === 1, 'se a gravação da negação falhar, a resposta continua a mesma 403 (a auditoria não muda a segurança da operação)');
  w.DB.raw.exec('DROP TRIGGER falha');
  ok((await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'senha-errada-1' })).status === 401 && w.ev('action_denied').every(r => r.actor_id === P) && !w.ev('login_failed').length, 'senha errada anônima continua sem evento por tentativa');

  n = w.count();
  ok((await w.call('POST', '/api/logout', {}, { cookie: prof })).status === 200 && w.count() === n + 1 && is(w.shape(w.last()), E('logout', P, 'staff', P)), 'logout: um evento, ator e alvo = a conta da sessão');
  ok((await w.call('POST', '/api/logout', {}, { cookie: prof })).status === 200 && w.count() === n + 1, 'logout repetido com a mesma sessão (já encerrada): nenhum evento');
  ok((await w.call('POST', '/api/logout', {})).status === 200 && (await w.call('POST', '/api/logout', {}, { cookie: 'tatame_sid=' + 'f'.repeat(64) })).status === 200 && w.count() === n + 1, 'logout sem sessão ou com sessão forjada: nenhum evento (não é auditoria anônima)');
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON audit_log WHEN NEW.event = 'logout' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  const s2 = (await w.call('POST', '/api/login', { email: 'p1@x.test', password: 'pedra-lisa-42' })).session;
  n = w.count();
  const lo = await w.call('POST', '/api/logout', {}, { cookie: s2 });
  ok(lo.status === 200 && w.row('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', P).n === 0 && w.count() === n, 'falha ao gravar o logout: a sessão é encerrada mesmo assim (sair nunca depende da auditoria) e nenhum evento parcial');
  w.DB.raw.exec('DROP TRIGGER falha'); }

// ================= falha de batch: nada parcial =================
{ const w = world(); const { admin } = await boot(w);
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON audit_log WHEN NEW.event = 'student_created' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  let n = w.count();
  ok((await w.call('POST', '/api/students', { name: 'Não Deve Existir', start_date: '2024-01-10' }, { cookie: admin })).status === 500 && w.row("SELECT count(*) n FROM students WHERE name = 'Não Deve Existir'").n === 0 && w.count() === n, 'evento falha: o aluno também não é criado');
  w.DB.raw.exec('DROP TRIGGER falha');
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE INSERT ON staff BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  ok((await w.call('POST', '/api/staff', { name: 'Prof X', email: 'px@x.test', password: 'pedra-lisa-77', role: 'admin' }, { cookie: admin })).status === 500 && w.count() === n, 'escrita principal falha: nenhum staff_created');
  w.DB.raw.exec('DROP TRIGGER falha');
  const S = (await w.call('POST', '/api/students', { name: 'Aluno Z', start_date: '2024-01-10' }, { cookie: admin })).body.student.id;
  w.DB.raw.exec("CREATE TRIGGER falha BEFORE DELETE ON students BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  n = w.count();
  ok((await w.call('DELETE', '/api/students/' + S, undefined, { cookie: admin })).status === 500 && w.count() === n && w.row('SELECT count(*) n FROM students WHERE id = ?', S).n === 1, 'exclusão falha: nenhum student_deleted e o aluno continua');
  w.DB.raw.exec('DROP TRIGGER falha'); }

// ================= compatibilidade com os eventos anteriores =================
{ const w = world();
  // registro antigo (antes da 003): sem as colunas novas; continua igual depois de toda a atividade
  w.DB.raw.exec("INSERT INTO audit_log (at, event, staff_id, detail) VALUES ('2026-01-01T00:00:00.000Z', 'reset_issued', NULL, 'código emitido pelo operador (tools/reset-code.mjs)')");
  const old = JSON.stringify(w.row('SELECT * FROM audit_log WHERE id = 1'));
  const { A1 } = await boot(w);
  const lg = await w.call('POST', '/api/login', { email: SETUP.email, password: SETUP.password }, { ip: '198.51.100.77' });
  ok(lg.status === 200 && is(w.shape(w.last()), E('login_ok', A1, 'staff', A1, { staff_id: A1, detail: { rede: '198.51.100.77', aparelho_conhecido: false } })), 'login_ok: mesmo staff_id e mesmo detail de antes, agora com ator/alvo/resultado');
  for (let i = 0; i < 8; i++) await w.call('POST', '/api/login', { email: SETUP.email, password: 'errada-' + i }, { ip: '203.0.113.5' });
  ok(is(w.shape(w.ev('login_locked')[0]), E('login_locked', null, 'staff', A1, { staff_id: A1, outcome: 'limit', detail: { limites: ['par'], rede: '203.0.113.5', conta_existe: true } })), 'login_locked: staff_id = conta visada (como antes), ator nulo (anônimo), resultado limit');
  for (let i = 0; i < 8; i++) await w.call('POST', '/api/login', { email: 'ninguem@x.test', password: 'errada-' + i }, { ip: '203.0.113.6' });
  ok(is(w.shape(w.ev('login_locked')[1]), E('login_locked', null, null, null, { outcome: 'limit', detail: { limites: ['par'], rede: '203.0.113.6', conta_existe: false } })), 'login_locked de conta inexistente: sem alvo e sem staff_id');
  const s = (await w.call('POST', '/api/login', { email: SETUP.email, password: SETUP.password }, { ip: '198.51.100.78' })).session;
  ok((await w.call('PUT', '/api/me/password', { current: SETUP.password, password: 'senha-nova-do-dono' }, { cookie: s })).status === 200
    && is(w.shape(w.last()), E('password_changed', A1, 'staff', A1, { staff_id: A1, detail: { por: 'propria_conta', sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } })), 'password_changed: formato anterior + ator/alvo');
  const c = newResetCode(); w.DB.raw.exec(resetSql(A1, c, new Date()));
  ok((await w.call('POST', '/api/reset', { email: SETUP.email, code: c, password: 'outra-senha-nova', password_confirm: 'outra-senha-nova' })).status === 200
    && is(w.shape(w.last()), E('reset_used', A1, 'staff', A1, { staff_id: A1, detail: 'senha redefinida; sessões encerradas' })), 'reset_used: mesmo texto fixo de antes em detail, staff_id = conta, ator/alvo estruturados');
  ok(JSON.stringify(w.row('SELECT * FROM audit_log WHERE id = 1')) === old, 'registro antigo (sem colunas estruturadas) intacto');
  // reset_issued é gravado pela ferramenta do operador (tools/reset-code.mjs), fora da API e fora do escopo (recuperação de senha
  // não muda nesta etapa): continua no formato anterior, sem ator (o operador não é uma conta da equipe).
  const ri = w.ev('reset_issued').pop();
  ok(ri.staff_id === A1 && ri.actor_id === null && ri.outcome === null && /operador/.test(ri.detail), 'reset_issued (ferramenta do operador): formato anterior preservado, sem colunas estruturadas');
  ok(w.rows("SELECT * FROM audit_log WHERE id > 1 AND event <> 'reset_issued'").every(r => ['ok', 'denied', 'limit'].includes(r.outcome) && (r.actor_id === null ? ['login_locked', 'reset_failed'].includes(r.event) : UUID.test(r.actor_id))), 'todo evento novo tem resultado válido e ator (exceto limites anônimos)');
  const all = JSON.stringify(w.rows('SELECT * FROM audit_log'));
  ok(![SETUP.password, 'senha-nova-do-dono', 'outra-senha-nova', c, c.replace(/-/g, ''), lg.session.split('=')[1], s.split('=')[1]].some(x => all.includes(x)) && !/pass_hash|pass_salt|tatame_sid|tatame_dev_|dono@x\.test|Dono Da Silva|Academia Sigilosa/.test(all)
    && !w.rows('SELECT pass_hash, pass_salt FROM staff').some(r => all.includes(r.pass_hash) || all.includes(r.pass_salt)), 'auditoria sem senha, hash, sal, código, token/cookie de sessão, e-mail ou nome da equipe'); }

// ================= allowlist do helper =================
{ // O helper não é exportado pelo Worker (o arquivo de produção não muda para o teste): o teste carrega a MESMA fonte
  // acrescentando uma exportação só para si, num módulo em memória.
  const src = readFileSync(WORKER, 'utf8') + '\nexport { auditValues as __auditValues, AUDIT_EVENTS as __EVENTS };\n';
  const H = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const V = H.__auditValues, id = crypto.randomUUID(), id2 = crypto.randomUUID();
  const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
  ok(eq(V('staff_created', { actor: id, target: ['staff', id2], detail: { papel: 'admin' } }), ['staff_created', null, '{"papel":"admin"}', id, 'staff', id2, 'ok']), 'evento novo válido: staff_id NULL, detail JSON exato');
  ok(eq(V('staff_password_reset', { actor: id, target: ['staff', id2], detail: { conta: id2, sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } }).slice(0, 2), ['staff_password_reset', id]), 'evento anterior: staff_id com o significado histórico (quem fez)');
  ok(throws(() => V('qualquer_coisa', { actor: id }), /fora do catálogo/), 'evento fora do catálogo: recusado');
  ok(throws(() => V('staff_created', { actor: id, target: ['staff', id2], detail: { papel: 'admin', email: 'a@b.c' } }), /email/), 'chave fora da allowlist (email): recusada');
  ok(throws(() => V('student_updated', { actor: id, target: ['student', id2], detail: { campos: ['name'], valores: { name: 'Fulano' } } }), /valores/), 'payload/valores arbitrários: recusados');
  ok(throws(() => V('student_updated', { actor: id, target: ['student', id2], detail: { campos: ['senha'] } }), /campos/), 'campo fora da lista fechada: recusado');
  ok(throws(() => V('staff_created', { actor: id, target: ['staff', id2], detail: { papel: 'root' } }), /papel/), 'valor fora do domínio: recusado');
  ok(throws(() => V('staff_role_changed', { actor: id, target: ['staff', id2], detail: { de: 'admin', para: { $gt: '' } } }), /para/), 'objeto no lugar de valor: recusado');
  ok(throws(() => V('staff_created', { actor: id, target: ['staff', id2], outcome: 'talvez', detail: { papel: 'admin' } }), /resultado/), 'resultado fora de ok/denied/limit (ou não previsto para o evento): recusado');
  ok(throws(() => V('staff_created', { actor: id, target: ['student', id2], detail: { papel: 'admin' } }), /tipo de alvo/), 'tipo de alvo errado: recusado');
  ok(throws(() => V('staff_created', { actor: id, target: ['staff', 'Fulano'], detail: { papel: 'admin' } }), /id do alvo/), 'id de alvo que não é um id: recusado');
  ok(throws(() => V('staff_created', { actor: null, target: ['staff', id2], detail: { papel: 'admin' } }), /ator/) && throws(() => V('logout', { actor: 'dono@x.test', target: ['staff', id2] }), /ator/), 'ator ausente ou que não é um id: recusado');
  ok(throws(() => V('reset_used', { actor: id, target: ['staff', id], detail: { codigo: 'X' } }), /detail/) && throws(() => V('logout', { actor: id, target: ['staff', id], detail: { a: 1 } }), /detail/), 'evento sem detail previsto: qualquer detail é recusado');
  ok(throws(() => V('lesson_updated', { actor: id, target: ['lesson', id2], detail: { lesson_id: id2, before: { id: id2, created_at: 'x'.repeat(31) } } }), /before/), 'texto acima do limite: recusado');
  const okSnap = { id: id2, date: '2025-06-02', student_ids: [], technique_ids: [] }, okAfter = { date: '2025-06-02', start_time: '19:00', end_time: '20:00', modality: 'gi', roll_called: 1, student_ids: [], technique_ids: [] };
  ok(!throws(() => V('lesson_updated', { actor: id, target: ['lesson', id2], detail: { lesson_id: id2, before: okSnap, after: okAfter } }), /./), 'retrato de aula sem texto livre: aceito');
  ok(['title', 'notes'].every(k => throws(() => V('lesson_updated', { actor: id, target: ['lesson', id2], detail: { lesson_id: id2, before: { ...okSnap, [k]: 'x' }, after: okAfter } }), /before/)
    && throws(() => V('lesson_updated', { actor: id, target: ['lesson', id2], detail: { lesson_id: id2, before: okSnap, after: { ...okAfter, [k]: 'x' } } }), /after/)
    && throws(() => V('lesson_deleted', { actor: id, target: ['lesson', id2], detail: { lesson_id: id2, before: { ...okSnap, [k]: null } } }), /before/)), 'catálogo recusa title e notes em lesson_updated (before e after) e lesson_deleted, mesmo vazios');
  ok(throws(() => V('students_exported', { actor: id, target: ['export', 'alunos.csv'], detail: { linhas: 1, baixado: true } }), /baixado/), 'students_exported só aceita linhas (nenhuma chave que afirme download)');
  ok(throws(() => V('action_denied', { actor: id, outcome: 'denied', detail: { acao: 'apagar_tudo', motivo: 'requer_admin' } }), /acao/), 'action_denied só com ações da lista');
  const used = [...readFileSync(WORKER, 'utf8').matchAll(/audit\(db, '([a-z_]+)'/g)].map(m => m[1]);
  ok(used.length >= 30 && used.every(e => e in H.__EVENTS), `todo evento gravado pelo Worker está no catálogo (${new Set(used).size} eventos distintos nas chamadas)`);
  ok(!/INSERT INTO audit_log/.test(readFileSync(WORKER, 'utf8').replace(/const cols = 'INSERT INTO audit_log[^']*'/, '')), 'nenhum INSERT em audit_log fora do helper'); }

ok(errs.filter(e => !/falha simulada/.test(e)).length === 0, 'nenhum erro inesperado no console do Worker');
console.log('\nAUDITORIA OK');
