// Etapa 6.2 (V3): edição e exclusão de chamada. Professor: só a própria e com menos de 7 dias. Admin: qualquer uma.
// Toda alteração autorizada fica em audit_log com o estado anterior; operação negada não muda nada no banco.
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
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);
const createdAgo = (id, ms) => DB.raw.prepare('UPDATE lessons SET created_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), id);
const DAY = 864e5;
// Estado completo de uma chamada direto do banco (para provar que negações não mudam nada).
const state = id => JSON.stringify({ l: DB.raw.prepare('SELECT * FROM lessons WHERE id = ?').get(id), a: DB.raw.prepare('SELECT student_id FROM attendance WHERE lesson_id = ? ORDER BY student_id').all(id), t: DB.raw.prepare('SELECT technique_id FROM lesson_techniques WHERE lesson_id = ? ORDER BY technique_id').all(id) });
const audits = ev => DB.raw.prepare('SELECT * FROM audit_log WHERE event = ? ORDER BY id').all(ev);

const code = generateCode(); DB.raw.exec(buildSetupSql(code));
const admin = (await call('', 'POST', '/api/setup', { academy_name: 'Academia', name: 'Admin', email: 'admin@x.test', password: 'cordafina-71', setup_code: code })).cookie;
await call(admin, 'POST', '/api/staff', { name: 'Prof Um', email: 'p1@x.test', password: 'senhaprof1', role: 'professor' });
await call(admin, 'POST', '/api/staff', { name: 'Prof Dois', email: 'p2@x.test', password: 'senhaprof2', role: 'professor' });
const p1 = (await call('', 'POST', '/api/login', { email: 'p1@x.test', password: 'senhaprof1' })).cookie;
const p2 = (await call('', 'POST', '/api/login', { email: 'p2@x.test', password: 'senhaprof2' })).cookie;
const id = e => DB.raw.prepare('SELECT id FROM staff WHERE email = ?').get(e).id;
const ADMIN = id('admin@x.test'), P1 = id('p1@x.test'), P2 = id('p2@x.test');
const a = (await call(admin, 'POST', '/api/students', { name: 'Aluno A', start_date: ago(200) })).body.student.id;
const b = (await call(admin, 'POST', '/api/students', { name: 'Aluno B', start_date: ago(200) })).body.student.id;
const tech = DB.raw.prepare('SELECT id FROM techniques LIMIT 1').get().id;
const lesson = async (ck, days) => (await call(ck, 'POST', '/api/lessons', { date: ago(days), start_time: '19:00', end_time: '20:00', student_ids: [a, b], technique_ids: [tech], title: 'Original' })).body.id;
const edit = (ck, lid, extra = {}) => call(ck, 'PUT', '/api/lessons/' + lid, { date: ago(1), start_time: '19:00', end_time: '20:00', student_ids: [a], technique_ids: [], title: 'Editada', ...extra });
const denied = async (ck, lid, payload, label) => {
  // 6.4-C (V6): a negação passa a deixar um action_denied (no máximo um por ator e ação a cada 15 min); nenhum outro evento.
  const others = () => DB.raw.prepare("SELECT count(*) n FROM audit_log WHERE event <> 'action_denied'").get().n;
  const s0 = state(lid), n0 = others();
  const r = await edit(ck, lid, payload);
  const den = DB.raw.prepare("SELECT * FROM audit_log WHERE event = 'action_denied' ORDER BY id DESC").get();
  ok(r.status === 403 && state(lid) === s0 && others() === n0 && den && den.outcome === 'denied' && JSON.parse(den.detail).acao === 'lesson_update' && JSON.parse(den.detail).motivo === 'autoria_ou_prazo',
    `${label}: 403, chamada idêntica no banco, nenhuma alteração auditada como feita (só a negação, action_denied)`);
};

// ---------- professor ----------
{ const l = await lesson(p1, 1);
  const r = await edit(p1, l);
  ok(r.status === 200 && r.body.student_ids.length === 1 && r.body.title === 'Editada', 'professor edita a própria chamada com menos de 7 dias: permitido');
  createdAgo(l, 7 * DAY - 60e3);
  ok((await edit(p1, l, { title: 'Quase 7 dias' })).status === 200, 'professor edita a própria chamada com 6 dias e 23h59: permitido'); }
{ const l = await lesson(p1, 1); createdAgo(l, 7 * DAY); await denied(p1, l, {}, 'professor edita a própria chamada com exatamente 7 dias'); }
{ const l = await lesson(p1, 1); createdAgo(l, 30 * DAY); await denied(p1, l, {}, 'professor edita a própria chamada com 30 dias'); }
const other = await lesson(p2, 1);
await denied(p1, other, {}, 'professor edita chamada de outro professor');
await denied(p1, other, { student_ids: [], roll_called: false }, 'professor substitui a lista de chamada alheia por lista vazia');
await denied(p1, other, { student_ids: [], roll_called: true }, 'professor marca chamada alheia como "ninguém veio" (remove todas as presenças)');
await denied(p1, other, { created_by: P1, instructor_id: P1, staff_id: P1, author_id: P1 }, 'professor manipula autor/instrutor no payload para se passar por dono');
const adminLesson = await lesson(admin, 2);
await denied(p1, adminLesson, { created_by: P1 }, 'professor edita chamada do administrador (mesmo informando created_by)');
{ const s0 = state(other); const r = await call(p1, 'DELETE', '/api/lessons/' + other);
  ok(r.status === 403 && state(other) === s0, 'professor exclui chamada alheia: 403, nada muda (regra existente preservada)'); }
{ const mine = await lesson(p1, 1);
  const r = await edit(p1, mine, { created_by: P2, created_at: '2000-01-01T00:00:00.000Z' });
  const row = DB.raw.prepare('SELECT created_by, created_at FROM lessons WHERE id = ?').get(mine);
  ok(r.status === 200 && row.created_by === P1 && row.created_at > '2020', 'created_by/created_at no payload da própria chamada são ignorados (autoria vem do banco)');
  const r2 = await call(p1, 'PUT', '/api/lessons/00000000-0000-4000-8000-000000000000', { date: ago(1), start_time: '19:00', end_time: '20:00' });
  ok(r2.status === 404, 'chamada inexistente: 404'); }

// ---------- administrador ----------
{ const l = await lesson(admin, 1);
  ok((await edit(admin, l)).status === 200, 'administrador edita a própria chamada: permitido');
  ok((await edit(admin, other, { student_ids: [b] })).status === 200 && DB.raw.prepare('SELECT student_id FROM attendance WHERE lesson_id = ?').all(other).map(r => r.student_id).join() === b, 'administrador edita chamada de outro professor: permitido');
  ok(DB.raw.prepare('SELECT instructor_id FROM lessons WHERE id = ?').get(other).instructor_id === P2, 'corrigir chamada de outra pessoa não troca o instrutor registrado');
  const old = await lesson(p1, 40); createdAgo(old, 40 * DAY);
  ok((await edit(admin, old, { date: ago(40) })).status === 200, 'administrador corrige chamada antiga (40 dias): permitido');
  ok((await edit(admin, old, { date: 'ontem' })).status === 400, 'administrador continua sujeito à validação (data inválida: 400)'); }

// ---------- auditoria ----------
{ const before = audits('lesson_updated').length;
  const l = await lesson(p1, 1);
  const s0 = JSON.parse(state(l));
  await edit(p1, l, { student_ids: [b], title: 'Nova' });
  const ev = audits('lesson_updated');
  const last = JSON.parse(ev[ev.length - 1].detail);
  ok(ev.length === before + 1 && ev[ev.length - 1].staff_id === P1 && last.lesson_id === l, 'edição autorizada gera 1 registro lesson_updated com quem alterou e qual chamada');
  // 6.4-C (ajuste): tema e observações da aula (texto livre) não vão mais para a auditoria; presenças e técnicas, sim.
  ok(last.before.student_ids.join() === s0.a.map(r => r.student_id).join() && last.after.student_ids.join() === b && !('title' in last.before) && !('title' in last.after) && !/Original|Nova/.test(ev[ev.length - 1].detail), 'o registro guarda o estado anterior e o novo (presenças), sem o tema da aula');
  ok(/^\d{4}-\d\d-\d\dT/.test(ev[ev.length - 1].at), 'o registro tem data e hora');
  ok(!/pass|token|salt|session/i.test(ev[ev.length - 1].detail), 'o registro não contém senha, token ou sessão');
  const del = await lesson(p1, 1);
  ok((await call(p1, 'DELETE', '/api/lessons/' + del)).status === 200, 'professor exclui a própria chamada recente: permitido');
  const d = audits('lesson_deleted').pop();
  ok(d && d.staff_id === P1 && JSON.parse(d.detail).before.student_ids.length === 2 && !DB.raw.prepare('SELECT 1 FROM lessons WHERE id = ?').get(del), 'exclusão gera lesson_deleted com a chamada inteira (inclui presenças) e a chamada sai do banco'); }
console.log('\nCHAMADAS (V3) OK');
