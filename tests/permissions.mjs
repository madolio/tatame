// Matriz de acesso: para cada rota da API e cada perfil (anônimo, professor, administrador), o resultado esperado.
// Também confere que toda rota declarada no Worker aparece aqui, para uma rota nova não entrar sem regra.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
const W = (await import('../web/_worker.js')).default;
const DB = makeD1();
DB.load(fileURLToPath(new URL('../db/schema.sql', import.meta.url))); DB.load(fileURLToPath(new URL('../db/seed_tecnicas.sql', import.meta.url)));
const env = { DB, ASSETS: { fetch: () => new Response('static') } };
const call = async (ck, method, path, body) => {
  const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie: ck || '' }, body: body ? JSON.stringify(body) : undefined }), env);
  const sc = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null), cookie: sc };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);
let fails = 0;
const ok = (c, m) => { if (c) console.log('ok ', m); else { fails++; console.log('FAIL', m); } };

// ---------- cenário ----------
const admin = (await call('', 'POST', '/api/setup', { academy_name: 'Academia Matriz', name: 'Admin', email: 'admin@x.com', password: 'senhaforte1' })).cookie;
await call(admin, 'POST', '/api/staff', { name: 'Professor', email: 'prof@x.com', password: 'senhaprof1', role: 'professor' });
await call(admin, 'POST', '/api/staff', { name: 'Professora Dois', email: 'prof2@x.com', password: 'senhaprof2', role: 'professor' });
const prof = (await call('', 'POST', '/api/login', { email: 'prof@x.com', password: 'senhaprof1' })).cookie;
const prof2 = (await call('', 'POST', '/api/login', { email: 'prof2@x.com', password: 'senhaprof2' })).cookie;
const staffId = (await call(admin, 'GET', '/api/state')).body.staff.find(s => s.email === 'prof2@x.com').id;
const stu = (await call(admin, 'POST', '/api/students', { name: 'Aluno Base', belt: 'azul', degrees: 1, start_date: ago(400), belt_since: ago(400), degree_since: ago(200) })).body.student;
const stuProf = (await call(prof, 'POST', '/api/students', { name: 'Aluno Do Prof', start_date: ago(30) })).body.student;
const cls = (await call(admin, 'POST', '/api/classes', { name: 'Turma', weekday: 1, start_time: '19:00', end_time: '20:00' })).body;
const lessonAdmin = (await call(admin, 'POST', '/api/lessons', { date: ago(3), start_time: '19:00', end_time: '20:00', student_ids: [stu.id] })).body;
const lessonProf = (await call(prof, 'POST', '/api/lessons', { date: ago(2), start_time: '19:00', end_time: '20:00', student_ids: [stu.id] })).body;
const lessonProfOld = (await call(prof, 'POST', '/api/lessons', { date: ago(20), start_time: '19:00', end_time: '20:00', student_ids: [stu.id] })).body;
DB.raw.prepare("UPDATE lessons SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 10 * 864e5).toISOString(), lessonProfOld.id);
const promoByAdmin = (await call(admin, 'POST', `/api/students/${stu.id}/promote`, { kind: 'grau', override: true })).body.promotions[0];
const promoByProf = (await call(prof, 'POST', `/api/students/${stuProf.id}/promote`, { kind: 'grau', override: true })).body.promotions[0];
const tech = (await call(admin, 'POST', '/api/techniques', { name: 'Técnica da matriz', category: 'Guarda' })).body;

// ---------- tabela ----------
// esperado: 'ok' = 2xx; número = status exato. Ordem: anônimo, professor, administrador.
// Linhas marcadas com "efeito" alteram dados; são executadas só pelo perfil que pode, por último, para não quebrar as outras.
const T = [
  ['GET', '/api/health', null, ['ok', 'ok', 'ok']],
  ['GET', '/api/status', null, ['ok', 'ok', 'ok']],
  ['POST', '/api/setup', { academy_name: 'X', name: 'Y', email: 'z@x.com', password: 'senhaforte1' }, [409, 409, 409]],
  ['POST', '/api/login', { email: 'nao@x.com', password: 'senhaerrada' }, [401, 401, 401]],
  ['POST', '/api/reset', { email: 'nao@x.com', code: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-A', password: 'senhanova123' }, [400, 400, 400]],
  ['POST', '/api/logout', null, ['ok', 'skip', 'skip']],
  ['GET', '/api/me', null, [401, 'ok', 'ok']],
  ['PUT', '/api/me/password', { current: 'x', password: 'senhanova123' }, [401, 400, 400]],
  ['GET', '/api/state', null, [401, 'ok', 'ok']],
  ['GET', `/api/students/${stu.id}`, null, [401, 'ok', 'ok']],
  ['POST', '/api/students', { name: 'Novo Aluno', start_date: ago(1), belt: 'roxa', belt_since: ago(100), imported_classes_belt: 10 }, [401, 'ok', 'ok']],
  ['PUT', `/api/students/${stu.id}`, { name: 'Aluno Base', start_date: ago(400), phone: '11 99999-0000' }, [401, 'ok', 'ok']],
  ['PUT', `/api/students/${stu.id}`, { name: 'Aluno Base', start_date: ago(400), belt_since: ago(300) }, [401, 403, 'ok']],
  ['PUT', `/api/students/${stu.id}`, { name: 'Aluno Base', start_date: ago(400), imported_classes_belt: 50, imported_classes_degree: 5 }, [401, 403, 'ok']],
  ['PUT', `/api/students/${stu.id}/skills`, { technique_id: tech.id, level: 2 }, [401, 'ok', 'ok']],
  ['POST', `/api/students/${stu.id}/promote`, { kind: 'grau', override: true }, [401, 'ok', 'ok']],
  ['DELETE', `/api/promotions/${promoByProf.id}`, null, [401, 'ok', 'skip']],
  ['DELETE', `/api/promotions/${promoByAdmin.id}`, null, [401, 403, 'skip']],
  ['POST', '/api/classes', { name: 'Outra', weekday: 2, start_time: '07:00', end_time: '08:00' }, [401, 'ok', 'ok']],
  ['PUT', `/api/classes/${cls.id}`, { name: 'Turma', weekday: 1, start_time: '19:00', end_time: '20:00' }, [401, 'ok', 'ok']],
  ['DELETE', `/api/classes/${cls.id}`, null, [401, 403, 'ok']],
  ['GET', '/api/lessons', null, [401, 'ok', 'ok']],
  ['POST', '/api/lessons', { date: ago(1), start_time: '10:00', end_time: '11:00', student_ids: [] }, [401, 'ok', 'ok']],
  ['GET', `/api/lessons/${lessonAdmin.id}`, null, [401, 'ok', 'ok']],
  ['PUT', `/api/lessons/${lessonAdmin.id}`, { date: ago(3), start_time: '19:00', end_time: '20:00', student_ids: [stu.id] }, [401, 'ok', 'ok']],
  ['DELETE', `/api/lessons/${lessonProf.id}`, null, [401, 'ok', 'skip']],
  ['DELETE', `/api/lessons/${lessonProfOld.id}`, null, [401, 403, 'ok']],
  ['DELETE', `/api/lessons/${lessonAdmin.id}`, null, [401, 403, 'ok']],
  ['POST', '/api/techniques', { name: 'Técnica nova', category: 'Guarda' }, [401, 403, 'ok']],
  ['PUT', `/api/techniques/${tech.id}`, { name: 'Técnica da matriz', category: 'Guarda' }, [401, 403, 'ok']],
  ['DELETE', `/api/techniques/${tech.id}`, null, [401, 403, 'skip']],
  ['PUT', '/api/rules', { rules: [{ belt: 'branca', degree_months: 3, degree_classes: 24, belt_months: 12, belt_classes: 120, curriculum_pct: 70, next_min_age: 16 }] }, [401, 403, 'ok']],
  ['PUT', '/api/settings', { academy_name: 'Academia Matriz' }, [401, 403, 'ok']],
  ['POST', '/api/staff', { name: 'Mais Um', email: 'm@x.com', password: 'senhaforte1' }, [401, 403, 'ok']],
  ['PUT', `/api/staff/${staffId}`, { name: 'Professora Dois' }, [401, 403, 'ok']],
  ['GET', '/api/export/alunos.csv', null, [401, 403, 'ok']],
  ['GET', '/api/nao-existe', null, [401, 404, 404]]
];
const who = [['anônimo', ''], ['professor', prof], ['administrador', admin]];
for (const [method, path, body, exp] of T) for (const [i, [label, ck]] of who.entries()) {
  if (exp[i] === 'skip') continue;
  const r = await call(ck, method, path, body);
  const pass = exp[i] === 'ok' ? r.status < 300 : r.status === exp[i];
  ok(pass, `${label.padEnd(13)} ${method.padEnd(6)} ${path.replace(/[0-9a-f-]{36}/g, ':id').padEnd(32)} → ${r.status}${pass ? '' : ' (esperado ' + exp[i] + ')'}`);
}
ok((await call(prof2, 'DELETE', `/api/lessons/${lessonProf.id}`)).status === 404, 'chamada do professor já apagada por ele mesmo (não por outra pessoa)');

// ---------- cobertura: toda rota do Worker está na tabela ----------
const src = fs.readFileSync(fileURLToPath(new URL('../web/_worker.js', import.meta.url)), 'utf8');
const literals = [...src.matchAll(/path === '(\/api\/[^']+)'/g)].map(m => m[1]);
const regexes = [...src.matchAll(/path\.match\(\/\^(\\\/api\\\/[^/]+)\$\/\)/g)].map(m => new RegExp('^' + m[1] + '$'));
const covered = p => T.some(([, tp]) => tp === p) ;
const coveredRx = rx => T.some(([, tp]) => rx.test(tp));
const missing = [...literals.filter(p => !covered(p)), ...regexes.filter(rx => !coveredRx(rx)).map(String)];
ok(missing.length === 0, 'toda rota do Worker tem linha na matriz' + (missing.length ? ': faltam ' + missing.join(', ') : ''));

console.log(fails ? `\n${fails} FALHA(S) NA MATRIZ DE ACESSO` : '\nMATRIZ DE ACESSO OK');
process.exit(fails ? 1 : 0);
