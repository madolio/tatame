// Agenda V1: cancelamento, feriado, reposição, eventos de auditoria e trava atômica de conflito de professor.
// Aplica a PROPOSTA de migração 004 (docs/agenda-migracao-004/) num banco de teste: a cadeia db/migrations não é tocada.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const DB = makeD1();
const P = p => fileURLToPath(new URL(p, import.meta.url));
const UP = P('../docs/agenda-migracao-004/004_agenda_cancelamento.sql'), DOWN = P('../docs/agenda-migracao-004/004_agenda_cancelamento.down.sql');
DB.load(P('../db/schema.sql')); DB.load(P('../db/seed_tecnicas.sql'));
const env = { DB, ASSETS: { fetch: () => new Response('') } };
const call = async (ck, method, path, body) => {
  const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie: ck || '' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const plus = d => new Date(Date.parse(today) + d * 864e5).toISOString().slice(0, 10);
const wd = s => new Date(s + 'T00:00:00Z').getUTCDay();
const audits = ev => DB.raw.prepare('SELECT * FROM audit_log WHERE event = ? ORDER BY id').all(ev);
const ag = (ck, from, to) => call(ck, 'GET', `/api/agenda?from=${from}&to=${to}`);
const item = async (ck, d, pred) => (await ag(ck, d, d)).body.items.find(pred);

const code = generateCode(); DB.raw.exec(buildSetupSql(code));
const admin = (await call('', 'POST', '/api/setup', { academy_name: 'Academia', name: 'Admin', email: 'admin@x.test', password: 'cordafina-71', setup_code: code })).cookie;
await call(admin, 'POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'senhaprof1', role: 'professor' });
await call(admin, 'POST', '/api/staff', { name: 'Prof Dois', email: 'p2@x.test', password: 'senhaprof2', role: 'professor' });
const p1 = (await call('', 'POST', '/api/login', { email: 'p1@x.test', password: 'senhaprof1' })).cookie;
const p2 = (await call('', 'POST', '/api/login', { email: 'p2@x.test', password: 'senhaprof2' })).cookie;
const sid = e => DB.raw.prepare('SELECT id FROM staff WHERE email = ?').get(e).id;
const ADMIN = sid('admin@x.test'), P1 = sid('p1@x.test'), P2 = sid('p2@x.test');
const stu = async n => (await call(admin, 'POST', '/api/students', { name: n, start_date: plus(-300) })).body.student.id;
const [sa, sb] = [await stu('Aluno A'), await stu('Aluno B')];
const lesson = (ck, body) => call(ck, 'POST', '/api/lessons', { start_time: '10:00', end_time: '11:00', student_ids: [], ...body });
const F = plus(7), FW = wd(F);
const cls = (await call(admin, 'POST', '/api/classes', { name: 'Fundamentos', weekday: FW, start_time: '19:00', end_time: '20:00', instructor_id: P1, modality: 'gi' })).body;
DB.raw.prepare('UPDATE classes SET created_at = ?').run(plus(-60) + 'T12:00:00.000Z');
const cancel = (ck, b) => call(ck, 'POST', '/api/agenda/exceptions', b);
const restore = (ck, id) => call(ck, 'POST', `/api/agenda/exceptions/${id}/restore`);
const makeup = (ck, id, b) => call(ck, 'POST', `/api/agenda/exceptions/${id}/makeup`, b);

// ---------- sem a migração: desligado ----------
{
  ok((await ag(p1, F, F)).body.capabilities.cancel === false, 'sem a tabela: a agenda informa cancelamento indisponível');
  ok((await cancel(admin, { kind: 'holiday', date: F, reason: 'Feriado' })).status === 501, 'sem a tabela: cancelar responde 501 e nada muda');
}
DB.load(UP);
ok((await ag(p1, F, F)).body.capabilities.cancel === true, 'com a tabela: cancelamento disponível');

// ---------- cancelar ocorrência da grade ----------
{
  const nLessons = DB.raw.prepare('SELECT count(*) n FROM lessons').get().n;
  const den = await cancel(p1, { kind: 'cancel', class_id: cls.id, date: F, reason: 'Professor viajando' });
  ok(den.status === 403 && audits('action_denied').some(e => JSON.parse(e.detail).acao === 'lesson_cancel'), 'professor não cancela a grade semanal (só admin): 403 e negação auditada');
  ok((await cancel(admin, { kind: 'cancel', class_id: cls.id, date: F, reason: 'x' })).status === 400, 'motivo curto é recusado');
  ok((await cancel(admin, { kind: 'cancel', class_id: cls.id, date: plus(8), reason: 'Motivo valido' })).status === 400, 'dia da semana diferente do da turma é recusado');
  const r = await cancel(admin, { kind: 'cancel', class_id: cls.id, date: F, reason: 'Professor viajando' });
  ok(r.status === 201, 'admin cancela a ocorrência da grade'); const X1 = r.body;
  const it = await item(p1, F, i => i.class_id === cls.id);
  ok(it && it.status === 'cancelled' && it.cancel_kind === 'cancel' && it.cancel_reason === 'Professor viajando' && it.exception_id === X1.id, 'agenda mostra a ocorrência como cancelada, com o motivo');
  ok(DB.raw.prepare('SELECT count(*) n FROM lessons').get().n === nLessons, 'cancelar a grade não grava nem apaga nenhuma aula');
  ok((await cancel(admin, { kind: 'cancel', class_id: cls.id, date: F, reason: 'Outra vez' })).status === 409, 'cancelar duas vezes a mesma aula: 409');
  const ev = audits('lesson_cancelled').pop(), d = JSON.parse(ev.detail);
  ok(ev.staff_id === null && ev.actor_id === ADMIN && ev.target_type === 'class' && ev.target_id === cls.id && d.excecao === X1.id && d.data === F && d.tipo === 'cancel' && !/viajando/i.test(ev.detail), 'lesson_cancelled: ator, alvo e dados, sem o texto livre do motivo');
  ok((await restore(p1, X1.id)).status === 403, 'professor não restaura a grade (só admin)');
  ok((await restore(admin, X1.id)).status === 200, 'admin restaura a ocorrência');
  ok((await item(p1, F, i => i.class_id === cls.id)).status === undefined, 'depois de restaurar a aula volta normal na agenda');
  const row = DB.raw.prepare('SELECT * FROM agenda_exceptions WHERE id = ?').get(X1.id);
  ok(row && row.restored_at && row.restored_by === ADMIN && audits('lesson_restored').length === 1, 'o registro do cancelamento é mantido (histórico) e a restauração é auditada uma vez');
  ok((await restore(admin, X1.id)).status === 409 && audits('lesson_restored').length === 1, 'restaurar de novo: 409, sem segundo evento');
  ok((await cancel(admin, { kind: 'cancel', class_id: cls.id, date: F, reason: 'Cancelada de novo' })).status === 201, 'depois de restaurada pode ser cancelada de novo');
}

// ---------- feriado ----------
{
  const den = await cancel(p2, { kind: 'holiday', date: F, reason: 'Feriado nacional' });
  ok(den.status === 403 && audits('action_denied').some(e => JSON.parse(e.detail).acao === 'agenda_holiday'), 'professor não marca feriado: 403 e negação auditada');
  const h = await cancel(admin, { kind: 'holiday', date: F, reason: 'Feriado nacional' });
  ok(h.status === 201, 'admin marca feriado');
  const day = (await ag(p1, F, F)).body.items;
  ok(day.length > 0 && day.every(i => i.status === 'cancelled'), 'feriado cancela todas as aulas do dia na agenda');
  ok((await cancel(admin, { kind: 'holiday', date: F, reason: 'Duplicado' })).status === 409, 'feriado duplicado no mesmo dia: 409');
  const ev = audits('lesson_cancelled').pop();
  ok(ev.target_type === null && JSON.parse(ev.detail).tipo === 'holiday', 'lesson_cancelled de feriado: sem alvo, tipo holiday');
  ok((await restore(admin, h.body.id)).status === 200, 'feriado pode ser desfeito');
}

// ---------- aula gravada: cancelar preserva a presença ----------
{
  const D = plus(-3);
  const done = (await lesson(p1, { date: D, start_time: '18:00', end_time: '19:00', student_ids: [sa, sb], instructor_id: P1 })).body;
  const snap = () => JSON.stringify(DB.raw.prepare('SELECT * FROM attendance WHERE lesson_id = ? ORDER BY student_id').all(done.id));
  const before = snap();
  ok((await cancel(p1, { kind: 'cancel', lesson_id: done.id, reason: 'Tentando cancelar' })).status === 409 && snap() === before, 'aula com chamada não é cancelada e a presença fica intacta');
  const h = await cancel(admin, { kind: 'holiday', date: D, reason: 'Feriado local' });
  ok((await item(p1, D, i => i.id === done.id)).status === undefined, 'feriado em dia com aula realizada: a presença prevalece (continua realizada)');
  ok((await call(p1, 'PUT', `/api/lessons/${done.id}`, { date: D, start_time: '18:00', end_time: '19:00', student_ids: [sa], instructor_id: P1 })).status === 200, 'corrigir a chamada de aula realizada em dia de feriado continua permitido');
  const fresh = await lesson(p1, { date: D, start_time: '07:00', end_time: '08:00', student_ids: [sa] });
  ok(fresh.status === 409 && /cancelada/.test(fresh.body.error || ''), 'chamada nova em dia de feriado é recusada até restaurar');
  await restore(admin, h.body.id);

  // aula programada: o autor cancela; outra pessoa não
  const sched = (await lesson(p1, { date: plus(3), start_time: '14:00', end_time: '15:00', title: 'Aulão', instructor_id: P1 })).body;
  ok((await cancel(p2, { kind: 'cancel', lesson_id: sched.id, reason: 'Não sou o autor' })).status === 403, 'outro professor não cancela aula que não é dele');
  const c = await cancel(p1, { kind: 'cancel', lesson_id: sched.id, reason: 'Imprevisto na academia' });
  ok(c.status === 201, 'o autor cancela a própria aula programada');
  const ev = audits('lesson_cancelled').pop();
  ok(ev.target_type === 'lesson' && ev.target_id === sched.id && JSON.parse(ev.detail).aula === sched.id, 'lesson_cancelled de aula gravada tem a aula como alvo');
  ok((await item(p1, plus(3), i => i.id === sched.id)).status === 'cancelled', 'aula programada aparece cancelada');
  ok(!!DB.raw.prepare('SELECT 1 FROM lessons WHERE id = ?').get(sched.id), 'a aula cancelada continua gravada (nada é destruído)');
  // cancelada não ocupa o professor; restaurar sobre outra aula é recusado
  ok((await lesson(p1, { date: plus(3), start_time: '14:30', end_time: '15:30', title: 'No lugar', instructor_id: P1 })).status === 201, 'aula cancelada não ocupa o professor: outra aula no mesmo horário é aceita');
  ok((await restore(p1, c.body.id)).status === 409, 'restaurar sobre outra aula do mesmo professor é recusado (trava do banco)');
  ok(DB.raw.prepare('SELECT restored_at FROM agenda_exceptions WHERE id = ?').get(c.body.id).restored_at === null && audits('lesson_restored').filter(e => e.target_id === sched.id).length === 0, 'restauração recusada não deixa evento nem altera o registro');

  // ---------- reposição ----------
  const mk = await makeup(p1, c.body.id, { date: plus(5), start_time: '16:00', end_time: '17:00' });
  ok(mk.status === 201 && mk.body.date === plus(5) && mk.body.student_ids.length === 0 && /Reposição/.test(mk.body.title), 'reposição cria uma aula nova, sem chamada');
  ok(DB.raw.prepare('SELECT makeup_lesson_id m FROM agenda_exceptions WHERE id = ?').get(c.body.id).m === mk.body.id, 'a reposição fica ligada ao cancelamento');
  const lst = (await ag(p1, plus(3), plus(5))).body.items;
  ok(lst.find(i => i.id === sched.id).makeup_lesson_id === mk.body.id && lst.find(i => i.id === mk.body.id).makeup_of_date === plus(3), 'agenda liga a aula cancelada e a reposição nos dois sentidos');
  ok((await makeup(p1, c.body.id, { date: plus(6) })).status === 409, 'um cancelamento tem no máximo uma reposição');
  const hol = await cancel(admin, { kind: 'holiday', date: plus(9), reason: 'Feriado municipal' });
  ok((await makeup(admin, hol.body.id, { date: plus(10) })).status === 400, 'feriado não tem reposição');
  const c2 = await cancel(admin, { kind: 'cancel', class_id: cls.id, date: plus(14), reason: 'Reunião da equipe' });
  ok(c2.status === 201 && (await makeup(admin, c2.body.id, { date: plus(-1) })).status === 400, 'reposição no passado é recusada');
  const mk2 = await makeup(admin, c2.body.id, { date: plus(16) });
  ok(mk2.status === 201 && mk2.body.instructor_id === P1 && mk2.body.start_time === '19:00', 'reposição da grade herda professor e horário da turma');
}

// ---------- trava atômica no banco (corrida entre duas requisições) ----------
{
  const D = plus(20), ins = (id, s, e, instr) => DB.raw.prepare('INSERT INTO lessons (id, date, start_time, end_time, instructor_id) VALUES (?,?,?,?,?)').run(id, D, s, e, instr);
  const A = n => `a0000000-0000-4000-8000-00000000000${n}`;
  ins(A(1), '09:00', '10:00', P2);
  assert.throws(() => ins(A(2), '09:30', '10:30', P2), /conflito_professor/); console.log('ok  o banco recusa a segunda aula sobreposta do mesmo professor, mesmo sem passar pela checagem do Worker');
  ins(A(3), '10:00', '11:00', P2); console.log('ok  aulas encostadas (fim = início) não conflitam');
  ins(A(4), '09:30', '10:30', P1); console.log('ok  outro professor no mesmo horário não conflita');
  assert.throws(() => DB.raw.prepare('UPDATE lessons SET start_time = ? WHERE id = ?').run('09:30', A(3)), /conflito_professor/); console.log('ok  mover aula para cima de outra do mesmo professor também é recusado pelo banco');
  // conflito antigo (gravado antes da trava) não impede mexer em campos que não são data, horário ou professor
  DB.raw.exec('DROP TRIGGER lessons_no_instructor_overlap_ins'); ins(A(5), '09:15', '09:45', P2);
  DB.raw.prepare('UPDATE lessons SET title = ?, roll_called = 1 WHERE id = ?').run('corrigida', A(5)); console.log('ok  conflito antigo não impede corrigir a aula (só mudar data, horário ou professor é checado)');
  const n = DB.raw.prepare('SELECT count(*) n FROM lessons').get().n;
  DB.load(DOWN);
  ok(!DB.raw.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('agenda_exceptions','lessons_no_instructor_overlap_upd','lessons_no_instructor_overlap_ins','agenda_exc_restore_no_overlap')").get() && DB.raw.prepare('SELECT count(*) n FROM lessons').get().n === n, 'rollback da proposta 004 remove tabela e travas sem apagar aulas');
}
console.log('\nAGENDA CANCELAMENTO OK');
