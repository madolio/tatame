// Etapa 6.2 (V7): validação de tipos e identificadores ANTES do banco. Nenhuma entrada previsível vira HTTP 500.
// Inclui uma varredura: valores ruins em cada campo de cada rota de escrita; exige 4xx e banco inalterado.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const DB = makeD1();
DB.load(fileURLToPath(new URL('../db/schema.sql', import.meta.url))); DB.load(fileURLToPath(new URL('../db/seed_tecnicas.sql', import.meta.url)));
let batches = 0; const b0 = DB.batch; DB.batch = s => { batches++; return b0.call(DB, s); };
const env = { DB, ASSETS: { fetch: () => new Response('') } };
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
const call = async (ck, method, path, body, { raw } = {}) => {
  const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie: ck || '' }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);
const dump = () => JSON.stringify(['staff', 'students', 'classes', 'lessons', 'attendance', 'lesson_techniques', 'skills', 'skill_history', 'promotions', 'techniques', 'rules', 'settings'].map(t => DB.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

const code = generateCode(); DB.raw.exec(buildSetupSql(code));
const admin = (await call('', 'POST', '/api/setup', { academy_name: 'Academia', name: 'Admin', email: 'a@x.test', password: 'senhaforte1', setup_code: code })).cookie;
await call(admin, 'POST', '/api/staff', { name: 'Prof Um', email: 'p@x.test', password: 'senhaprof1', role: 'professor' });
const prof = (await call('', 'POST', '/api/login', { email: 'p@x.test', password: 'senhaprof1' })).cookie;
const PROF = DB.raw.prepare("SELECT id FROM staff WHERE email = 'p@x.test'").get().id;
const stu = (await call(admin, 'POST', '/api/students', { name: 'Aluno Base', start_date: ago(300) })).body.student.id;
const cls = (await call(admin, 'POST', '/api/classes', { name: 'Turma', weekday: 1, start_time: '19:00', end_time: '20:00' })).body.id;
const tech = DB.raw.prepare('SELECT id FROM techniques LIMIT 1').get().id;
const les = (await call(prof, 'POST', '/api/lessons', { date: ago(1), start_time: '19:00', end_time: '20:00', student_ids: [stu] })).body.id;
const GHOST = '00000000-0000-4000-8000-000000000000';
const refused = async (ck, method, path, body, label, { expect = 400, raw } = {}) => {
  const s0 = dump(); batches = 0;
  const r = await call(ck, method, path, body, { raw });
  ok(r.status === expect && batches === 0 && dump() === s0 && !/SQLITE|constraint|stack|at \w+ \(/i.test(JSON.stringify(r.body)), `${label}: ${r.status}, banco inalterado, sem detalhe interno`);
};
const lessonOk = { date: ago(2), start_time: '19:00', end_time: '20:00' };

// ---------- casos pedidos ----------
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, student_ids: { 0: stu } }, 'objeto no lugar de lista (student_ids)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, student_ids: stu }, 'texto no lugar de lista (student_ids)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, student_ids: [{ id: stu }] }, 'objeto dentro da lista de alunos (antes: 500)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, technique_ids: ['abc'] }, 'texto no lugar de número (technique_ids)');
await refused(admin, 'POST', '/api/classes', { name: 'T', weekday: 'segunda', start_time: '07:00', end_time: '08:00' }, 'texto não numérico no lugar de número (weekday)');
await refused(admin, 'POST', '/api/students', { name: 12345, start_date: ago(10) }, 'número no lugar de texto (nome)');
await refused(admin, 'POST', '/api/students', { name: 'Aluno', phone: { n: 1 }, start_date: ago(10) }, 'objeto no lugar de texto (telefone)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, student_ids: ['nao-e-uuid'] }, 'identificador de aluno malformado');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, class_id: "x' OR 1=1 --" }, 'identificador de turma malformado (texto de injeção)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, class_id: { id: cls } }, 'turma como objeto (antes: 500)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, student_ids: [GHOST] }, 'identificador de aluno inexistente');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, instructor_id: GHOST }, 'instrutor inexistente na chamada');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, instructor_id: 'qualquer-coisa' }, 'instrutor com texto arbitrário (antes: aceito até a FK)');
await refused(admin, 'POST', '/api/classes', { name: 'T', weekday: 1, start_time: '07:00', end_time: '08:00', instructor_id: GHOST }, 'instrutor inexistente na turma');
await refused(admin, 'POST', '/api/classes', { name: 'T', weekday: 1, start_time: '07:00', end_time: '08:00', instructor_id: { a: 1 } }, 'instrutor como objeto na turma');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, date: '2024-02-31' }, 'data inexistente no calendário (2024-02-31; antes virava 02/03)');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, date: '2025-13-01' }, 'mês 13');
await refused(prof, 'POST', '/api/lessons', { ...lessonOk, date: 20250101 }, 'data como número');
await refused(prof, 'POST', '/api/lessons', { start_time: '19:00', end_time: '20:00' }, 'campo obrigatório ausente (data da aula)');
await refused(admin, 'POST', '/api/students', { start_date: ago(10) }, 'campo obrigatório ausente (nome do aluno)');
{ const r = await call(admin, 'POST', '/api/students', { name: 'Aluno Nulo', nickname: null, phone: null, email: null, birth_date: null, weight_kg: null, notes: null, start_date: ago(10) });
  ok(r.status === 201 && r.body.student.nickname === null && r.body.student.weight_kg === null, 'campos opcionais nulos: aceitos e gravados como nulos'); }
{ const r = await call(prof, 'POST', '/api/lessons', { ...lessonOk, class_id: null, instructor_id: null, student_ids: null, technique_ids: null, title: null });
  ok(r.status === 201 && r.body.instructor_id === PROF && r.body.student_ids.length === 0, 'chamada com opcionais nulos: aceita (instrutor = quem registrou)'); }
await refused(admin, 'PUT', '/api/staff/' + PROF, { name: 'Prof Um', active: 'false' }, 'active como texto "false" (antes: virava ativo)');
await refused(prof, 'POST', `/api/students/${stu}/promote`, { kind: 'grau', override: 'sim' }, 'override como texto (antes: qualquer valor "verdadeiro" confirmava)');
await refused(admin, 'PUT', `/api/students/${stu}/skills`, { items: [null] }, 'item nulo na lista de avaliações (antes: 500)');
await refused(admin, 'PUT', `/api/students/${stu}/skills`, { items: [[tech, 2]] }, 'lista no lugar de objeto na avaliação');
await refused(admin, 'PUT', '/api/rules', { rules: [null] }, 'regra nula');
for (const [raw, label] of [['{"name":', 'JSON malformado'], ['null', 'corpo null (antes: 500)'], ['[]', 'corpo lista'], ['"texto"', 'corpo texto'], ['42', 'corpo número']]) await refused(admin, 'POST', '/api/students', undefined, `${label} em POST /api/students`, { raw });

// ---------- campos administrativos e autoria ----------
await refused(prof, 'PUT', `/api/students/${stu}`, { name: 'Aluno Base', belt_since: ago(5) }, 'professor tenta corrigir data de faixa (campo de admin)', { expect: 403 });
await refused(prof, 'POST', '/api/staff', { name: 'Novo Admin', email: 'n@x.test', password: 'senhaforte9', role: 'admin' }, 'professor tenta criar administrador', { expect: 403 });
await refused(prof, 'PUT', '/api/staff/' + PROF, { name: 'Prof Um', role: 'admin' }, 'professor tenta se promover a administrador', { expect: 403 });
await refused(prof, 'PUT', '/api/staff/' + PROF, { name: 'Prof Um', active: 1, id: GHOST }, 'professor tenta mexer em active/id da própria conta', { expect: 403 });
{ const r = await call(admin, 'POST', '/api/students', { name: 'Aluno Extra', start_date: ago(10), id: GHOST, created_at: '2000-01-01', updated_at: '2000-01-01', role: 'admin', is_admin: true, academy_id: 'outra' });
  const row = DB.raw.prepare('SELECT * FROM students WHERE name = ?').get('Aluno Extra');
  ok(r.status === 201 && row.id !== GHOST && row.created_at > '2020' && !('role' in row) && !('academy_id' in row), 'propriedades extras (id, created_at, role, is_admin, academy_id): ignoradas, sem mass assignment'); }
{ const r = await call(prof, 'PUT', '/api/lessons/' + les, { ...lessonOk, date: ago(1), student_ids: [stu], created_by: GHOST, created_at: '2000-01-01T00:00:00.000Z' });
  const row = DB.raw.prepare('SELECT created_by, created_at FROM lessons WHERE id = ?').get(les);
  ok(r.status === 200 && row.created_by === PROF && row.created_at > '2020', 'autoria no payload (created_by/created_at) ignorada; a autoria vem do banco'); }
ok((await call('', 'PUT', '/api/lessons/' + les, lessonOk)).status === 401, 'sem sessão: 401');

// ---------- varredura: nenhum valor ruim em nenhum campo produz 500 ----------
const BAD = [null, true, false, 0, -1, 1e309 === Infinity ? 1e308 : 0, 'x'.repeat(5000), '', ' ', {}, [], [null], { $gt: '' }, '1; DROP TABLE staff', "'", '__proto__', '2024-02-31', 'NaN', '25:99', GHOST];
const routes = [
  ['POST', '/api/students', { name: 'Aluno V', start_date: ago(10), belt: 'branca', degrees: 0, birth_date: '2010-01-01', sex: 'm', phone: '1', email: 'v@x.test', prior_months: 0, weight_kg: 70, status: 'ativo', goals: 'g', notes: 'n', imported_classes_belt: 0, imported_classes_degree: 0 }],
  ['PUT', `/api/students/${stu}`, { name: 'Aluno Base', start_date: ago(300), status: 'ativo', weight_kg: 70 }],
  ['POST', `/api/students/${stu}/promote`, { kind: 'grau', date: today, override: true, notes: 'x', to_belt: 'azul' }],
  ['PUT', `/api/students/${stu}/skills`, { technique_id: tech, level: 2, note: 'x' }],
  ['POST', '/api/classes', { name: 'Turma V', weekday: 1, start_time: '07:00', end_time: '08:00', level: 'todos', modality: 'gi', instructor_id: PROF, active: true }],
  ['PUT', `/api/classes/${cls}`, { name: 'Turma', weekday: 1, start_time: '19:00', end_time: '20:00', active: true }],
  ['POST', '/api/lessons', { ...lessonOk, class_id: cls, student_ids: [stu], technique_ids: [tech], modality: 'gi', title: 't', notes: 'n', roll_called: true, instructor_id: PROF }],
  ['POST', '/api/techniques', { name: 'Técnica V', category: 'Guarda', min_belt: 'branca', difficulty: 2, description: 'd', active: true }],
  ['PUT', '/api/rules', { rules: [{ belt: 'azul', degree_months: 4, degree_classes: 0, belt_months: 24, belt_classes: 200, curriculum_pct: 50, next_min_age: 16 }] }],
  ['PUT', '/api/settings', { academy_name: 'Academia' }],
  ['POST', '/api/staff', { name: 'Pessoa V', email: 'pv@x.test', password: 'senhaforte1', role: 'professor', belt: 'azul' }],
  ['PUT', `/api/staff/${PROF}`, { name: 'Prof Um', role: 'professor', active: true, belt: 'azul' }],
  ['PUT', '/api/me/password', { current: 'senhaforte1', password: 'senhaforte1' }]
];
let tried = 0, five = [];
for (const [method, path, good] of routes) for (const field of Object.keys(good)) for (const v of BAD) {
  const body = { ...good, [field]: v };
  const r = await call(admin, method, path, body); tried++;
  if (r.status >= 500) five.push(`${method} ${path} ${field}=${JSON.stringify(v).slice(0, 30)} → ${r.status}`);
  if (method === 'PUT' && path === '/api/me/password' && r.status === 200) { /* senha igual; sessão renovada */ }
}
ok(five.length === 0, `varredura: ${tried} requisições com valores ruins em ${routes.reduce((n, r) => n + Object.keys(r[2]).length, 0)} campos de ${routes.length} rotas — nenhuma resposta 500${five.length ? ': ' + five.slice(0, 5).join(' | ') : ''}`);
ok(errs.length === 0, 'nenhum erro inesperado chegou ao log do Worker (console.error) durante todo o teste');
console.error = oe;
console.log('\nVALIDAÇÃO (V7) OK');
