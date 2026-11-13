// Agenda V1: consulta por período (grade semanal + aulas gravadas), programação de aulas futuras, conflito de professor,
// presença sem duplicidade, correção com histórico e auditoria. As regras de acesso são as já existentes (nada novo de autorização).
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const DB = makeD1();
DB.load(fileURLToPath(new URL('../db/schema.sql', import.meta.url))); DB.load(fileURLToPath(new URL('../db/seed_tecnicas.sql', import.meta.url)));
const env = { DB, ASSETS: { fetch: () => new Response('') } };
const call = async (ck, method, path, body) => {
  const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie: ck || '' }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const plus = d => new Date(Date.parse(today) + d * 864e5).toISOString().slice(0, 10);
const wd = s => new Date(s + 'T00:00:00Z').getUTCDay();
const audits = ev => DB.raw.prepare('SELECT * FROM audit_log WHERE event = ? ORDER BY id').all(ev);
const attOf = id => DB.raw.prepare('SELECT student_id FROM attendance WHERE lesson_id = ? ORDER BY student_id').all(id).map(r => r.student_id);
const ag = (ck, from, to) => call(ck, 'GET', `/api/agenda?from=${from}&to=${to}`);

const code = generateCode(); DB.raw.exec(buildSetupSql(code));
const admin = (await call('', 'POST', '/api/setup', { academy_name: 'Academia', name: 'Admin', email: 'admin@x.test', password: 'cordafina-71', setup_code: code })).cookie;
await call(admin, 'POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'senhaprof1', role: 'professor' });
await call(admin, 'POST', '/api/staff', { name: 'Prof Dois', email: 'p2@x.test', password: 'senhaprof2', role: 'professor' });
const p1 = (await call('', 'POST', '/api/login', { email: 'p1@x.test', password: 'senhaprof1' })).cookie;
const p2 = (await call('', 'POST', '/api/login', { email: 'p2@x.test', password: 'senhaprof2' })).cookie;
const sid = e => DB.raw.prepare('SELECT id FROM staff WHERE email = ?').get(e).id;
const ADMIN = sid('admin@x.test'), P1 = sid('p1@x.test'), P2 = sid('p2@x.test');
const stu = async n => (await call(admin, 'POST', '/api/students', { name: n, start_date: plus(-300) })).body.student.id;
const [a, b, c] = [await stu('Aluno A'), await stu('Aluno B'), await stu('Aluno C')];
const lesson = (ck, body) => call(ck, 'POST', '/api/lessons', { start_time: '10:00', end_time: '11:00', student_ids: [], ...body });

// ---------- consulta por período ----------
{
  ok((await call('', 'GET', `/api/agenda?from=${today}&to=${today}`)).status === 401, 'agenda: anônimo recebe 401');
  const bad = [['', ''], [`from=${today}`, ''], ['from=2026-02-30&to=2026-03-01', ''], [`from=${plus(5)}&to=${plus(1)}`, ''], [`from=${plus(-100)}&to=${plus(0)}`, '']];
  for (const [q] of bad) ok((await call(p1, 'GET', '/api/agenda' + (q ? '?' + q : ''))).status === 400, `agenda: período inválido recusado (${q || 'sem parâmetros'})`);
  ok((await ag(p1, plus(-41), today)).status === 200, 'agenda: 42 dias é o máximo aceito');
  ok((await ag(p1, plus(-42), today)).status === 400, 'agenda: 43 dias é recusado');
}
const base = plus(-14);                        // uma segunda-feira qualquer entre -14 e -8: usa o dia da semana de base
const WD = wd(base);
const cls = (await call(admin, 'POST', '/api/classes', { name: 'Fundamentos', weekday: WD, start_time: '19:00', end_time: '20:00', instructor_id: P1, modality: 'gi' })).body;
const clsOff = (await call(admin, 'POST', '/api/classes', { name: 'Desativada', weekday: WD, start_time: '08:00', end_time: '09:00' })).body;
await call(admin, 'PUT', `/api/classes/${clsOff.id}`, { name: 'Desativada', weekday: WD, start_time: '08:00', end_time: '09:00', active: false });
DB.raw.prepare('UPDATE classes SET created_at = ?').run(plus(-60) + 'T12:00:00.000Z');
{
  const r = (await ag(p1, plus(-14), plus(-14 + 6))).body;
  const planned = r.items.filter(i => i.kind === 'planned');
  ok(r.today === today && planned.length === 1 && planned[0].date === base && planned[0].name === 'Fundamentos' && planned[0].instructor_name === 'Prof Um' && planned[0].start_time === '19:00',
    'agenda: a grade semanal aparece como ocorrência prevista, com turma, horário e professor');
  ok(!r.items.some(i => i.name === 'Desativada'), 'agenda: turma desativada não gera ocorrência');
  const two = (await ag(p1, plus(-14), plus(-14 + 13))).body.items.filter(i => i.kind === 'planned');
  ok(two.length === 2 && two[1].date === plus(-7), 'agenda: duas semanas = duas ocorrências (recorrência semanal sem gravar nada)');
  ok(DB.raw.prepare('SELECT count(*) n FROM lessons').get().n === 0, 'agenda: consultar não grava aula nenhuma');
  DB.raw.prepare('UPDATE classes SET created_at = ?').run(plus(-10) + 'T12:00:00.000Z');
  ok((await ag(p1, plus(-14), plus(-14))).body.items.length === 0, 'agenda: a grade de hoje não reescreve o passado (antes do cadastro da turma não há ocorrência)');
  DB.raw.prepare('UPDATE classes SET created_at = ?').run(plus(-60) + 'T12:00:00.000Z');
}

// ---------- aula gravada substitui a prevista; avulsa aparece ----------
const L1 = (await lesson(p1, { class_id: cls.id, date: base, start_time: '19:00', end_time: '20:00', student_ids: [a, b] })).body;
const avulsa = (await lesson(p2, { date: plus(-13), start_time: '09:00', end_time: '10:00', title: 'Seminário de passagem', instructor_id: P2 })).body;
{
  const r = (await ag(p1, plus(-14), plus(-8))).body;
  const mine = r.items.filter(i => i.class_id === cls.id && i.date === base);
  ok(mine.length === 1 && mine[0].kind === 'lesson' && mine[0].id === L1.id && mine[0].attendees === 2 && mine[0].roll_called === 1, 'agenda: aula gravada substitui a ocorrência prevista (sem duplicar) e traz a contagem de presentes');
  const av = r.items.find(i => i.id === avulsa.id);
  ok(av && av.kind === 'lesson' && av.name === 'Seminário de passagem' && av.instructor_name === 'Prof Dois' && av.class_id === null, 'agenda: aula avulsa aparece com o título e o professor');
  ok(JSON.stringify(r.items.map(i => i.date + i.start_time)) === JSON.stringify(r.items.map(i => i.date + i.start_time).sort()), 'agenda: itens ordenados por data e horário');
  ok(!('notes' in av) && !('student_ids' in av), 'agenda: não expõe observações nem a lista de alunos');
}

// ---------- aula programada (futura) ----------
{
  const f = await lesson(p1, { date: plus(3), start_time: '18:00', end_time: '19:30', title: 'Aulão', instructor_id: P1 });
  ok(f.status === 201 && f.body.roll_called === 0 && f.body.date === plus(3), 'programar: aula futura é aceita, sem chamada');
  ok((await lesson(p1, { date: plus(4), student_ids: [a] })).status === 400, 'programar: aula futura com alunos presentes é recusada');
  ok((await lesson(p1, { date: plus(4), roll_called: true })).status === 400, 'programar: aula futura marcada como chamada feita é recusada');
  ok((await lesson(p1, { date: plus(400) })).status === 400, 'programar: além de um ano à frente é recusado');
  ok((await lesson(p1, { date: plus(5), start_time: '11:00', end_time: '10:00' })).status === 400, 'programar: fim antes do início é recusado');
  const before = (await call(p1, 'GET', '/api/state')).body.dashboard;
  const r = (await ag(p1, plus(3), plus(3))).body;
  ok(r.items.some(i => i.id === f.body.id && i.kind === 'lesson'), 'programar: a aula futura aparece na agenda');
  const after = (await call(p1, 'GET', '/api/state')).body.dashboard;
  ok(JSON.stringify(before.weekly) === JSON.stringify(after.weekly) && before.kpis.lessons_30d === after.kpis.lessons_30d, 'programar: aula futura não entra nos indicadores do painel');
  const up = await call(p1, 'PUT', `/api/lessons/${f.body.id}`, { date: plus(3), start_time: '18:30', end_time: '20:00', title: 'Aulão', instructor_id: P1, student_ids: [], technique_ids: [] });
  ok(up.status === 200 && up.body.start_time === '18:30', 'editar: o autor reprograma o horário da própria aula');
  ok((await call(p2, 'PUT', `/api/lessons/${f.body.id}`, { date: plus(3), start_time: '18:30', end_time: '20:00', student_ids: [] })).status === 403, 'editar: outro professor não altera a aula (regra já existente)');
  ok(audits('lesson_updated').some(e => JSON.parse(e.detail).lesson_id === f.body.id), 'editar: a reprogramação fica auditada');
  const del = await call(p1, 'DELETE', `/api/lessons/${f.body.id}`);
  ok(del.status === 200 && !DB.raw.prepare('SELECT 1 FROM lessons WHERE id = ?').get(f.body.id) && audits('lesson_deleted').some(e => JSON.parse(e.detail).lesson_id === f.body.id), 'remover: aula programada sai da agenda e a remoção fica auditada');
}

// ---------- conflito de professor ----------
{
  const day = plus(10);
  const A = await lesson(p1, { date: day, start_time: '10:00', end_time: '11:00', instructor_id: P2 });
  ok(A.status === 201, 'conflito: primeira aula do professor no horário');
  const dup = await lesson(p1, { date: day, start_time: '10:30', end_time: '11:30', instructor_id: P2 });
  ok(dup.status === 409 && /já tem aula/.test(dup.body.error) && /10:00/.test(dup.body.error), 'conflito: mesmo professor em horário sobreposto → 409 com o horário em conflito');
  ok(DB.raw.prepare('SELECT count(*) n FROM lessons WHERE date = ?').get(day).n === 1, 'conflito: a recusa não grava nada');
  ok((await lesson(p1, { date: day, start_time: '11:00', end_time: '12:00', instructor_id: P2 })).status === 201, 'conflito: aula logo depois (11:00 = fim da anterior) não conflita');
  ok((await lesson(p1, { date: day, start_time: '09:00', end_time: '10:00', instructor_id: P2 })).status === 201, 'conflito: aula logo antes não conflita');
  ok((await lesson(p1, { date: day, start_time: '10:00', end_time: '11:00', instructor_id: P1 })).status === 201, 'conflito: professor diferente no mesmo horário é permitido (outro tatame)');
  ok((await lesson(p1, { date: plus(11), start_time: '10:00', end_time: '11:00', instructor_id: P2 })).status === 201, 'conflito: mesmo professor em outro dia é permitido');
  const E = (await lesson(p1, { date: day, start_time: '15:00', end_time: '16:00', instructor_id: P2 })).body;
  const mv = await call(p1, 'PUT', `/api/lessons/${E.id}`, { date: day, start_time: '10:30', end_time: '11:30', instructor_id: P2, student_ids: [] });
  ok(mv.status === 409, 'conflito: mover uma aula para cima de outra do mesmo professor → 409');
  ok(DB.raw.prepare('SELECT start_time FROM lessons WHERE id = ?').get(E.id).start_time === '15:00', 'conflito: a edição recusada não altera a aula');
  const t = await call(p1, 'PUT', `/api/lessons/${E.id}`, { date: day, start_time: '10:30', end_time: '11:30', instructor_id: P1, student_ids: [] });
  ok(t.status === 409 && DB.raw.prepare('SELECT instructor_id FROM lessons WHERE id = ?').get(E.id).instructor_id === P2, 'conflito: trocar o professor para alguém já ocupado naquele horário → 409 e nada muda');
  ok((await call(p1, 'PUT', `/api/lessons/${E.id}`, { date: day, start_time: '15:00', end_time: '16:00', instructor_id: P1, student_ids: [] })).status === 200, 'conflito: trocar o professor para alguém livre é permitido');
  // Aula sem professor escolhido: o responsável é quem registrou (não é escala), então não conflita.
  ok((await lesson(p1, { date: plus(12), start_time: '10:00', end_time: '11:00' })).status === 201 && (await lesson(p1, { date: plus(12), start_time: '10:00', end_time: '11:00' })).status === 201,
    'conflito: sem professor escolhido, o registro duplicado de quem salvou não é bloqueado (comportamento anterior preservado)');
  // Conflito herdado: duas aulas já sobrepostas no banco continuam editáveis (corrigir presença não depende de um conflito antigo).
  DB.raw.prepare("INSERT INTO lessons (id, date, start_time, end_time, instructor_id, created_by, roll_called) VALUES ('11111111-1111-4111-8111-111111111111', ?, '10:00', '11:00', ?, ?, 1)").run(plus(-20), P1, P1);
  DB.raw.prepare("INSERT INTO lessons (id, date, start_time, end_time, instructor_id, created_by, roll_called) VALUES ('22222222-2222-4222-8222-222222222222', ?, '10:30', '11:30', ?, ?, 1)").run(plus(-20), P1, P1);
  const old = await call(admin, 'PUT', '/api/lessons/22222222-2222-4222-8222-222222222222', { date: plus(-20), start_time: '10:30', end_time: '11:30', instructor_id: P1, student_ids: [a], notes: 'corrigida' });
  ok(old.status === 200, 'conflito: corrigir a presença de uma aula com conflito antigo não é bloqueado');
  const r = (await ag(p1, plus(-20), plus(-20))).body.items.filter(i => i.instructor_id === P1 && i.kind === 'lesson');
  ok(r.length >= 2 && r.every(i => i.conflict === true), 'agenda: aulas sobrepostas do mesmo professor vêm marcadas como conflito');
  const ok1 = (await ag(p1, day, day)).body.items.filter(i => i.instructor_id === P2);
  ok(ok1.every(i => !i.conflict), 'agenda: aulas adjacentes não são marcadas como conflito');
}

// ---------- presença: sem duplicidade, correção, histórico ----------
{
  const day = plus(-5);
  const L = (await lesson(p1, { date: day, start_time: '07:00', end_time: '08:00', student_ids: [a, a, b, b, b], title: 'Manhã' })).body;
  ok(JSON.stringify(attOf(L.id)) === JSON.stringify([a, b].sort()) && DB.raw.prepare('SELECT count(*) n FROM attendance WHERE lesson_id = ?').get(L.id).n === 2, 'presença: aluno repetido na lista vira uma única presença');
  const other = (await lesson(p1, { date: plus(-4), start_time: '07:00', end_time: '08:00', student_ids: [a, c] })).body;
  const snapOther = JSON.stringify(attOf(other.id));
  const fix = await call(p1, 'PUT', `/api/lessons/${L.id}`, { date: day, start_time: '07:00', end_time: '08:00', title: 'Manhã', student_ids: [b, c], technique_ids: [] });
  ok(fix.status === 200 && JSON.stringify(attOf(L.id)) === JSON.stringify([b, c].sort()), 'presença: o autor corrige a chamada (troca A por C)');
  ok(JSON.stringify(attOf(other.id)) === snapOther, 'presença: corrigir uma aula não mexe na frequência das outras aulas (histórico preservado)');
  const ev = audits('lesson_updated').map(e => JSON.parse(e.detail)).find(d => d.lesson_id === L.id);
  ok(ev && JSON.stringify(ev.before.student_ids) === JSON.stringify([a, b].sort()) && JSON.stringify(ev.after.student_ids) === JSON.stringify([b, c].sort()), 'presença: a correção guarda a lista de antes e a de depois na auditoria');
  ok((await call(p2, 'PUT', `/api/lessons/${L.id}`, { date: day, start_time: '07:00', end_time: '08:00', student_ids: [] })).status === 403 && JSON.stringify(attOf(L.id)) === JSON.stringify([b, c].sort()), 'presença: outro professor não corrige a chamada alheia (403, nada muda)');
  ok((await call(admin, 'PUT', `/api/lessons/${L.id}`, { date: day, start_time: '07:00', end_time: '08:00', title: 'Manhã', student_ids: [a, b, c], technique_ids: [] })).status === 200 && attOf(L.id).length === 3, 'presença: o administrador corrige qualquer chamada');
  ok((await lesson(p1, { date: day, start_time: '07:30', end_time: '08:30', student_ids: ['nao-e-uuid'] })).status === 400, 'presença: identificador inválido é recusado');
  ok((await lesson(p1, { date: day, start_time: '07:30', end_time: '08:30', student_ids: ['33333333-3333-4333-8333-333333333333'] })).status === 400, 'presença: aluno inexistente é recusado');
  const dupe = await lesson(p1, { class_id: cls.id, date: base });
  ok(dupe.status === 409, 'turma: duas aulas da mesma turma no mesmo dia continuam impedidas');
  const hist = await call(admin, 'GET', `/api/students/${a}`);
  ok(hist.status === 200 && hist.body.student.id === a, 'histórico: a ficha do aluno continua consultável após as correções');
}

// ---------- "costumam vir" ----------
{
  const cl = (await call(admin, 'POST', '/api/classes', { name: 'Noite', weekday: wd(plus(-1)), start_time: '20:00', end_time: '21:00' })).body;
  DB.raw.prepare('UPDATE classes SET created_at = ? WHERE id = ?').run(plus(-90) + 'T12:00:00.000Z', cl.id);
  for (const d of [-21, -14, -7]) await lesson(admin, { class_id: cl.id, date: plus(d - ((wd(plus(d)) - wd(plus(-1)) + 7) % 7)), start_time: '20:00', end_time: '21:00', student_ids: [a, b], });
  await lesson(admin, { class_id: cl.id, date: plus(-2 - ((wd(plus(-2)) - wd(plus(-1)) + 7) % 7) - 14), start_time: '20:00', end_time: '21:00', student_ids: [c] });
  const reg = (await ag(p1, plus(0), plus(6))).body.regulars[cl.id];
  ok(reg && reg.includes(a) && reg.includes(b) && !reg.includes(c), 'regulares: quem tem 2+ presenças na turma nas últimas 8 semanas aparece; quem veio uma vez, não');
  await call(admin, 'PUT', `/api/students/${b}`, { name: 'Aluno B', start_date: plus(-300), status: 'inativo' });
  ok(!(await ag(p1, plus(0), plus(6))).body.regulars[cl.id].includes(b), 'regulares: aluno inativo não aparece');
}

console.log('\nAGENDA V1 OK');
