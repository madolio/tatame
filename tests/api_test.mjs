import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';
const W = (await import('../web/_worker.js')).default;
const DB = makeD1();
DB.load(fileURLToPath(new URL('../db/schema.sql', import.meta.url))); DB.load(fileURLToPath(new URL('../db/seed_tecnicas.sql', import.meta.url)));
const env = { DB, ASSETS: { fetch: () => new Response('static') } };
let cookie = '';
const call = async (method, path, body, { csrf = true, ck = cookie, ip } = {}) => {
  const h = { 'content-type': 'application/json' }; if (csrf) h['x-tatame'] = '1'; if (ck) h.cookie = ck; if (ip) h['cf-connecting-ip'] = ip;
  const r = await W.fetch(new Request('https://t.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
};
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);

const SETUP = generateCode(); DB.raw.exec(buildSetupSql(SETUP));
ok((await call('GET', '/api/status')).body.setup_code_required, 'precisa configurar com código');
ok((await call('POST', '/api/setup', { academy_name: 'Invasor', name: 'Invasor', email: 'x@x.com', password: 'cordafina-71', setup_code: 'errado' })).status === 403, 'sem o código: bloqueado');
ok((await call('GET', '/api/state')).status === 401, 'sem login: 401');
ok((await call('POST', '/api/setup', { academy_name: 'X', name: 'Prof', email: 'p@x.com', password: 'curta', setup_code: SETUP })).status === 400, 'senha curta recusada');
ok((await call('POST', '/api/setup', { academy_name: 'Academia Teste', name: 'Professor', email: 'prof@x.com', password: 'cordafina-71' }, { csrf: false })).status === 403, 'CSRF bloqueado');
ok((await call('POST', '/api/setup', { academy_name: 'Academia Teste', name: 'Professor', email: 'prof@x.com', password: 'cordafina-71', setup_code: SETUP.toLowerCase().replace(/-/g, ' ') })).status === 201, 'setup cria admin (código aceito sem diferenciar maiúsculas e separadores)');
let adminCookie = cookie;

// sessão: renova quando faltam menos de 15 dias; não renova antes; teto de 90 dias desde o login
const iso = d => new Date(Date.now() + d * 864e5).toISOString();
const sess = (col, v) => DB.raw.prepare(`UPDATE auth_sessions SET ${col} = ?`).run(v);
const rawCall = async (p) => W.fetch(new Request('https://t.test' + p, { headers: { cookie: adminCookie } }), env);
sess('expires_at', iso(20));
ok(!(await rawCall('/api/me')).headers.get('set-cookie'), 'sessão com 20 dias restantes não é renovada');
sess('expires_at', iso(10));
let r = await rawCall('/api/me');
const exp = DB.raw.prepare('SELECT expires_at e FROM auth_sessions').get().e;
ok(r.status === 200 && /tatame_sid=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+/.test(r.headers.get('set-cookie')) && exp > iso(29) && exp < iso(31), 'sessão com 10 dias restantes renova por mais 30 e reenvia o cookie seguro');
sess('created_at', iso(-91));
ok((await rawCall('/api/me')).status === 401 && DB.raw.prepare('SELECT count(*) n FROM auth_sessions').get().n === 0, 'sessão com mais de 90 dias desde o login é encerrada');
cookie = ''; ok((await call('POST', '/api/login', { email: 'prof@x.com', password: 'cordafina-71' })).status === 200, 'admin entra de novo');
adminCookie = cookie;
ok((await call('POST', '/api/setup', { academy_name: 'Outra', name: 'Hacker', email: 'h@x.com', password: 'cordafina-71' })).status === 409, 'setup não roda 2x');

// aluno branca 4 graus, faixa há 13 meses → candidato a azul
const s1 = (await call('POST', '/api/students', { name: 'Ana Souza', birth_date: '1998-03-02', start_date: ago(400), belt: 'branca', degrees: 4, belt_since: ago(400), degree_since: ago(100) })).body.student;
ok(s1.metrics.next.kind === 'faixa' && s1.metrics.next.to_belt === 'azul', 'próxima graduação de branca 4 graus adulta = azul');
const s2 = (await call('POST', '/api/students', { name: 'Pedro Kids', birth_date: ago(365 * 9), start_date: ago(200), belt: 'branca', degrees: 4 })).body.student;
ok(s2.metrics.next.to_belt === 'cinza', 'criança branca → cinza');
const s3 = (await call('POST', '/api/students', { name: 'Bruno', birth_date: '2000-01-01', start_date: ago(10), belt: 'azul', degrees: 1, belt_since: ago(200), degree_since: ago(30) })).body.student;
ok(s3.metrics.next.kind === 'grau' && s3.metrics.next.to_degrees === 2, 'azul 1 grau → 2º grau');
ok((await call('POST', '/api/students', { name: 'X', start_date: ago(1) })).status === 400, 'nome curto recusado');
ok((await call('POST', '/api/students', { name: 'Futuro', start_date: ago(-5) })).status === 400, 'data futura recusada');

// turma e chamada
const cls = (await call('POST', '/api/classes', { name: 'Fundamentos noite', weekday: 1, start_time: '19:00', end_time: '20:30', level: 'todos' })).body;
ok(cls.id, 'turma criada');
ok((await call('POST', '/api/classes', { name: 'Ruim', weekday: 1, start_time: '20:00', end_time: '19:00' })).status === 400, 'horário invertido recusado');
const tech = (await call('GET', '/api/state')).body.techniques;
const mata = tech.find(t => t.name === 'Mata-leão'), arm = tech.find(t => t.name === 'Armlock da guarda');
// 130 aulas para Ana na faixa → critério de aulas
const lessonIds = [];
for (let i = 0; i < 130; i++) {
  const r = await call('POST', '/api/lessons', { date: ago(i * 3 + 1), start_time: '19:00', end_time: '20:30', title: 'Aula ' + i, student_ids: i < 60 ? [s1.id, s3.id] : [s1.id], technique_ids: i % 10 === 0 ? [mata.id, arm.id] : [] });
  if (r.status !== 201) { console.log(r); process.exit(1); }
  lessonIds.push(r.body.id);
}
ok(true, '130 aulas lançadas');
const dup1 = await call('POST', '/api/lessons', { class_id: cls.id, date: ago(0), student_ids: [s1.id] });
const dup2 = await call('POST', '/api/lessons', { class_id: cls.id, date: ago(0), student_ids: [s1.id] });
ok(dup1.status === 201 && dup2.status === 409, 'chamada duplicada da mesma turma no mesmo dia bloqueada');
let d = (await call('GET', '/api/students/' + s1.id)).body;
ok(d.student.metrics.classes_total === 131, 'total de aulas = 131');
ok(d.skills.find(x => x.technique_id === mata.id).level === 1, 'técnica passada em aula vira "vista em aula"');
ok(d.student.metrics.difficulties.some(x => x.technique_id === mata.id), 'mata-leão visto 13x e nível 1 = dificuldade');
const crit = Object.fromEntries(d.student.metrics.criteria.map(c => [c.key, c]));
ok(crit.months.met && crit.classes.met && !crit.curriculum.met && crit.age.met, 'critérios: tempo/aulas/idade ok, currículo não');
ok(!d.student.metrics.ready, 'ainda não apta');
// avalia todo o currículo branca com nível 3
const curr = tech.filter(t => t.min_belt === 'branca');
d = (await call('PUT', `/api/students/${s1.id}/skills`, { items: curr.map(t => ({ technique_id: t.id, level: 3 })) })).body;
ok(d.student.metrics.ready, 'depois de avaliar o currículo: apta para azul');
ok(d.student.metrics.learning.pct === 60 && d.student.metrics.learning.label === 'Avançado', 'aprendizado 60% (nível 3/5)');
ok(d.student.metrics.experience.label === 'Intermediário', 'experiência: 131 aulas = Intermediário');
// graduação sem critério exige confirmação
const g1 = await call('POST', `/api/students/${s3.id}/promote`, { kind: 'grau' });
ok(g1.status === 409, 'grau sem critérios exige confirmação');
ok((await call('POST', `/api/students/${s3.id}/promote`, { kind: 'grau', override: true })).body.student.degrees === 2, 'grau forçado aplicado');
d = (await call('POST', `/api/students/${s1.id}/promote`, { kind: 'faixa', to_belt: 'azul', notes: 'Exame aprovado' })).body;
ok(d.student.belt === 'azul' && d.student.degrees === 0 && d.promotions[0].criteria_met === 1, 'Ana graduada faixa azul, critérios cumpridos');
ok(d.student.metrics.classes_since_belt <= 1, 'contagem de aulas na faixa reiniciou');
ok((await call('POST', `/api/students/${s1.id}/promote`, { kind: 'faixa', to_belt: 'branca', override: true })).status === 400, 'não volta faixa');
d = (await call('DELETE', '/api/promotions/' + d.promotions[0].id)).body;
ok(d.student.belt === 'branca' && d.student.degrees === 4, 'desfazer graduação restaura faixa e graus');
// D3: a experiência total acompanha toda a trajetória; a promoção não a apaga
{
  const im = (await call('POST', '/api/students', { name: 'Veterano Importado', birth_date: '1990-05-05', start_date: ago(20), belt: 'azul', degrees: 4, belt_since: ago(300), degree_since: ago(100), imported_classes_belt: 300 })).body.student;
  const exp = async () => (await call('GET', '/api/students/' + im.id)).body.student.metrics.experience;
  let e = await exp();
  ok(e.score === 300 && e.level === 4, 'D3: 300 aulas importadas = experiência 300 (Avançado)');
  const pr = await call('POST', `/api/students/${im.id}/promote`, { kind: 'faixa', to_belt: 'roxa', override: true });
  const after = pr.body.student.metrics;
  ok(after.experience.score === 300 && after.experience.level === 4, 'D3: promover de faixa não apaga a experiência total');
  ok(after.classes_since_belt === 0 && after.experience.in_belt === 0, 'D3: a experiência na faixa atual é um indicador separado e reinicia');
  const edit = await call('PUT', '/api/students/' + im.id, { name: 'Veterano Importado', imported_classes_belt: 40 });
  e = (edit.body.student || (await call('GET', '/api/students/' + im.id)).body.student).metrics.experience;
  ok(e.score === 340 && e.in_belt === 40, 'D3: editar as aulas importadas muda só a faixa atual; o histórico (300) fica');
  const undo = await call('DELETE', '/api/promotions/' + pr.body.promotions[0].id);
  ok(undo.body.student.metrics.experience.score === 300, 'D3: desfazer a graduação não duplica as aulas importadas');
  await call('DELETE', '/api/students/' + im.id);
}
// D4/D4b: início no futuro é dado inválido; aluno recém-cadastrado tem 14 dias de carência
{
  ok((await call('POST', '/api/students', { name: 'Futuro API', start_date: ago(-5) })).status === 400, 'D4: a API recusa início no futuro');
  const mkS = async (name, start) => (await call('POST', '/api/students', { name, start_date: start })).body.student;
  const met = async s => (await call('GET', '/api/students/' + s.id)).body.student.metrics;
  const fut = await mkS('Futuro Banco', ago(0));
  DB.raw.prepare('UPDATE students SET start_date = ? WHERE id = ?').run(ago(-10), fut.id);
  let m = await met(fut);
  ok(m.days_absent === null && m.at_risk === false && m.data_issues.includes('inicio_futuro'), 'D4: início no futuro (vindo do banco) não gera ausência negativa nem risco, e é sinalizado');
  const n13 = await mkS('Novo 13', ago(13)), n14 = await mkS('Novo 14', ago(14)), n0 = await mkS('Novo hoje', ago(0));
  ok((await met(n0)).days_absent === 0 && !(await met(n0)).at_risk, 'D4b: aluno que começa hoje não está em risco');
  ok(!(await met(n13)).at_risk && (await met(n13)).days_absent === 13, 'D4b: 13 dias sem presença ainda é carência');
  ok((await met(n14)).at_risk && (await met(n14)).days_absent === 14, 'D4b: com 14 dias sem presença entra em risco');
  for (const s of [fut, n13, n14, n0]) await call('DELETE', '/api/students/' + s.id);
}
// D5: novos no mês = só alunos ativos, início entre o dia 1 do mês e hoje
{
  const novos = async () => (await call('GET', '/api/state')).body.dashboard.kpis.new_this_month;
  const base = await novos();
  const a = (await call('POST', '/api/students', { name: 'Novo Ativo', start_date: ago(0) })).body.student;
  ok(await novos() === base + 1, 'D5: aluno ativo que começa hoje conta como novo no mês');
  const b = (await call('POST', '/api/students', { name: 'Novo Inativo', start_date: ago(0), status: 'inativo' })).body.student;
  ok(await novos() === base + 1, 'D5: aluno inativo não conta');
  const c = (await call('POST', '/api/students', { name: 'Novo Futuro', start_date: ago(0) })).body.student;
  DB.raw.prepare('UPDATE students SET start_date = ? WHERE id = ?').run(ago(-3), c.id);
  ok(await novos() === base + 1, 'D5: início no futuro não conta');
  const e = (await call('POST', '/api/students', { name: 'Veio Mês Passado', start_date: ago(0) })).body.student;
  DB.raw.prepare('UPDATE students SET start_date = ? WHERE id = ?').run(`${new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 7)}-01`, e.id);
  ok(await novos() === base + 1, 'D5: início em outro mês não conta');
  for (const s of [a, b, c, e]) await call('DELETE', '/api/students/' + s.id);
}
// D6: marcador de chamada (lessons.roll_called): sem chamada ≠ chamada com zero presentes
{
  const kpi = async () => (await call('GET', '/api/state')).body.dashboard.kpis;
  const mk = async b => (await call('POST', '/api/lessons', { date: ago(1), start_time: '06:00', end_time: '07:00', ...b }));
  const row = id => DB.raw.prepare('SELECT roll_called r FROM lessons WHERE id = ?').get(id).r;
  const k0 = await kpi();
  const semChamada = await mk({});
  ok(semChamada.status === 201 && row(semChamada.body.id) === 0, 'D6: aula nova sem presentes e sem aviso começa como "sem chamada" (0)');
  const k1 = await kpi();
  ok(k1.avg_per_lesson_30d === k0.avg_per_lesson_30d && k1.lessons_30d === k0.lessons_30d + 1, 'D6: aula sem chamada conta como aula dada, mas não entra na média de presença');
  const zero = await mk({ roll_called: true });
  ok(zero.status === 201 && row(zero.body.id) === 1, 'D6: é possível registrar chamada feita com zero presentes');
  const k2 = await kpi();
  ok(k2.avg_per_lesson_30d < k1.avg_per_lesson_30d, 'D6: chamada com zero presentes entra na média como aula de presença zero');
  const comAluno = await mk({ student_ids: [s1.id] });
  ok(row(comAluno.body.id) === 1, 'D6: aula com presentes é sempre chamada feita');
  ok((await mk({ student_ids: [s1.id], roll_called: false })).status === 400, 'D6: não aceita "sem chamada" com alunos presentes');
  ok((await mk({ roll_called: 'talvez' })).status === 400, 'D6: valor inválido do marcador é recusado');
  // histórico desconhecido (NULL) permanece desconhecido ao editar sem informar o marcador
  DB.raw.prepare('UPDATE lessons SET roll_called = NULL WHERE id = ?').run(semChamada.body.id);
  const ed = await call('PUT', '/api/lessons/' + semChamada.body.id, { date: ago(1), start_time: '06:00', end_time: '07:00', title: 'Ajuste de tema' });
  ok(ed.status === 200 && row(semChamada.body.id) === null, 'D6: editar uma aula de histórico desconhecido não a classifica sozinho');
  const ed2 = await call('PUT', '/api/lessons/' + semChamada.body.id, { date: ago(1), start_time: '06:00', end_time: '07:00', roll_called: true });
  ok(ed2.status === 200 && row(semChamada.body.id) === 1, 'D6: o instrutor pode registrar a chamada depois');
  ok((await call('GET', '/api/lessons/' + zero.body.id)).body.roll_called === 1, 'D6: a API devolve o marcador');
  for (const l of [semChamada, zero, comAluno]) await call('DELETE', '/api/lessons/' + l.body.id);
}
// D7: média semanal = presenças em 84 dias ÷ semanas desde o início (mínimo 1, máximo 12)
{
  const wa = async s => (await call('GET', '/api/students/' + s.id)).body.student.metrics.weekly_avg;
  const lesson = async (day, ids) => (await call('POST', '/api/lessons', { date: ago(day), start_time: '05:00', end_time: '05:30', student_ids: ids })).body.id;
  const n14 = (await call('POST', '/api/students', { name: 'Semanal 14d', start_date: ago(14) })).body.student;
  const hoje = (await call('POST', '/api/students', { name: 'Semanal hoje', start_date: ago(0) })).body.student;
  const ids = [];
  for (const d of [1, 3, 5, 8, 10, 12]) ids.push(await lesson(d, [n14.id]));
  ids.push(await lesson(0, [hoje.id]));
  ok(await wa(n14) === 2, 'D7: 6 aulas em 15 dias de cadastro (3 semanas) = 2,0 por semana (antes dividia por 12: 0,5)');
  ok(await wa(hoje) === 1, 'D7: aluno que começou hoje usa 1 semana (sem divisão por zero)');
  for (const l of ids) await call('DELETE', '/api/lessons/' + l);
  for (const s of [n14, hoje]) await call('DELETE', '/api/students/' + s.id);
}
// D1: sem data de nascimento não se presume idade nem trilha (infantil/adulta)
{
  const sn = (await call('POST', '/api/students', { name: 'Sem Nascimento', start_date: ago(900), belt: 'branca', degrees: 4, belt_since: ago(800), degree_since: ago(300), imported_classes_belt: 200 })).body.student;
  let m = (await call('GET', '/api/students/' + sn.id)).body.student.metrics;
  ok(m.needs_profile === true && m.data_issues.includes('sem_nascimento'), 'D1: cadastro sem nascimento é sinalizado');
  ok(m.next.kind === 'faixa' && m.next.to_belt === null && m.next.choice_needed === true, 'D1: próxima faixa fica a definir (sem presumir adulto)');
  ok(!m.criteria.some(c => c.key === 'age'), 'D1: critério de idade não é avaliado sem nascimento');
  ok(m.age === null && (await call('GET', '/api/students/' + s3.id)).body.student.metrics.needs_profile === false, 'D1: aluno com nascimento não é sinalizado');
  const kid = (await call('POST', '/api/students', { name: 'Sem Nasc Amarela', start_date: ago(900), belt: 'amarela', degrees: 4, belt_since: ago(800), degree_since: ago(300) })).body.student;
  m = (await call('GET', '/api/students/' + kid.id)).body.student.metrics;
  ok(m.next.to_belt === 'laranja' && !m.next.choice_needed, 'D1: faixa infantil sem nascimento segue a trilha infantil (laranja, não azul)');
  const p = await call('POST', `/api/students/${sn.id}/promote`, { kind: 'faixa', override: true });
  ok(p.status === 400, 'D1: graduar faixa exige escolher a nova faixa');
  const p2 = await call('POST', `/api/students/${sn.id}/promote`, { kind: 'faixa', to_belt: 'cinza', override: true });
  ok(p2.status === 200 || p2.status === 201, 'D1: instrutor pode escolher explicitamente a faixa quando falta o nascimento');
}

// professor (não admin)
ok((await call('POST', '/api/staff', { name: 'Prof Dois', email: 'p2@x.com', password: 'outrasenha2', role: 'professor' })).status === 201, 'admin cria professor');
cookie = '';
ok((await call('POST', '/api/login', { email: 'p2@x.com', password: 'errada000' })).status === 401, 'senha errada 401');
ok((await call('POST', '/api/login', { email: 'p2@x.com', password: 'outrasenha2' })).status === 200, 'professor entra');
ok((await call('DELETE', '/api/students/' + s2.id)).status === 403, 'professor não exclui aluno');
ok((await call('PUT', '/api/rules', { rules: [] })).status === 403, 'professor não altera critérios');
ok((await call('GET', '/api/state')).body.staff.every(s => !s.email), 'professor não vê e-mails da equipe');
// limite de tentativas: por (e-mail, IP). Um estranho errando de outro IP não bloqueia o dono da conta.
const profCookie = cookie;
for (let i = 0; i < 9; i++) await call('POST', '/api/login', { email: 'p2@x.com', password: 'chute' + i }, { ip: '203.0.113.9' });
ok((await call('POST', '/api/login', { email: 'p2@x.com', password: 'outrasenha2' }, { ip: '203.0.113.9' })).status === 429, 'limite de tentativas: 8 erros do mesmo IP bloqueiam esse IP');
ok((await call('POST', '/api/login', { email: 'p2@x.com', password: 'outrasenha2' }, { ip: '198.51.100.7' })).status === 200, 'dono da conta entra de outro IP mesmo com o e-mail sob ataque');
ok(DB.raw.prepare("SELECT count(*) n FROM login_attempts WHERE key = 'email:p2@x.com|ip:198.51.100.7'").get().n === 0, 'login certo limpa as tentativas do par e-mail+IP');
// enumeração por tempo: e-mail inexistente tem de custar o mesmo que senha errada em conta existente
const med = async (email) => { const a = []; for (let i = 0; i < 12; i++) { const t = performance.now(); await call('POST', '/api/login', { email, password: 'senhaerrada' + i }, { ip: '192.0.2.' + i }); a.push(performance.now() - t); } a.sort((x, y) => x - y); return a[6]; };
const tExiste = await med('p2@x.com'), tNao = await med('ninguem@x.com');
ok(tNao > tExiste * 0.5 && tNao < tExiste * 2, `tempo de login não revela se o e-mail existe (existe ${tExiste.toFixed(1)} ms, não existe ${tNao.toFixed(1)} ms)`);
ok(DB.raw.prepare("SELECT count(*) n FROM login_attempts WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')").get().n === 0, 'tentativas antigas são apagadas');
cookie = profCookie;
await call('POST', '/api/logout'); ok((await call('GET', '/api/state')).status === 401, 'logout encerra sessão');
cookie = adminCookie;
const st = (await call('GET', '/api/state')).body;
ok(st.dashboard.kpis.active_students === 5 && st.dashboard.weekly.length === 12, 'painel calculado');
ok(st.techniques.find(t => t.id === mata.id).times_taught === 13, 'técnica: vezes ensinada');
ok(st.techniques.find(t => t.id === mata.id).last_taught === ago(1), 'técnica: última aula com presentes');
// aula sem presentes também conta como técnica ensinada, com data
const tri = tech.find(t => t.name === 'Triângulo');
ok((await call('POST', '/api/lessons', { date: ago(2), start_time: '07:00', end_time: '08:00', title: 'Só técnica', student_ids: [], technique_ids: [tri.id] })).status === 201, 'aula sem presentes registrada');
const tri2 = (await call('GET', '/api/state')).body.techniques.find(t => t.id === tri.id);
ok(tri2.times_taught === 1 && tri2.last_taught === ago(2) && tri2.taught_90d === 1, 'técnica de aula sem presentes: vezes, última aula e 90 dias contam');
const csvBefore = (await call('GET', '/api/export/alunos.csv')).body;
ok((await call('POST', '/api/students', { name: '=1+1', nickname: '@cmd', start_date: ago(1) })).status === 201, 'aluno com nome que parece fórmula');
const csv = await call('GET', '/api/export/alunos.csv');
ok(typeof csv.body === 'string' && csv.body.includes('Ana Souza'), 'exporta CSV');
ok(csv.body.includes('"\'=1+1";"\'@cmd"'), 'CSV neutraliza fórmulas (= e @ ganham apóstrofo)');
ok(csvBefore.split('\r\n').slice(0, 2).every(l => csv.body.includes(l)), 'CSV sem valores especiais continua igual (cabeçalho e linha da Ana)');
// ---------- recuperação de senha por código (tools/reset-code.mjs gera; o Worker valida) ----------
{
  const RC = await import('../tools/reset-code.mjs');
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const mk = async (name, email) => { const s = (await call('POST', '/api/staff', { name, email, password: 'senhaantiga1', role: 'professor' }, { ck: adminCookie })); assert.equal(s.status, 201); return DB.raw.prepare('SELECT id FROM staff WHERE email = ?').get(email).id; };
  const issue = (id, agoMs = 0) => { const code = RC.generateCode(); DB.raw.exec(RC.buildSql(id, code, new Date(Date.now() - agoMs))); return code; };
  const reset = (email, code, password = 'senhanova123', ip = '203.0.113.10') => call('POST', '/api/reset', { email, code, password, password_confirm: password }, { ck: '', ip });
  const A = await mk('Prof Rec A', 'reca@x.com'), B = await mk('Prof Rec B', 'recb@x.com');
  const lg = await call('POST', '/api/login', { email: 'reca@x.com', password: 'senhaantiga1' }, { ck: '' }); const oldCk = cookie;
  ok(lg.status === 200 && (await call('GET', '/api/me', null, { ck: oldCk })).status === 200, 'recuperação: sessão antiga da conta funciona antes do reset');

  const code = issue(A);
  ok(code.replace(/-/g, '').length === 26 && /^[0-9A-HJKMNP-TV-Z-]+$/.test(code), 'recuperação: código com 26 caracteres (130 bits) sem letras ambíguas');
  const row = DB.raw.prepare('SELECT * FROM password_resets WHERE staff_id = ?').get(A);
  ok(row.code_hash.length === 64 && !JSON.stringify(row).includes(code.replace(/-/g, '')), 'recuperação: o banco guarda só o hash do código');
  const exp = Date.parse(row.expires_at) - Date.now();
  ok(exp > 29 * 60000 && exp <= 30 * 60000, 'recuperação: validade de 30 minutos');

  ok((await reset('reca@x.com', code, 'curta')).status === 400 && DB.raw.prepare('SELECT used_at FROM password_resets WHERE staff_id = ?').get(A).used_at === null, 'recuperação: senha curta é recusada sem gastar o código');
  ok((await call('POST', '/api/reset', { email: 'reca@x.com', code, password: 'senhanova123', password_confirm: 'outra12345' }, { ck: '' })).status === 400 && DB.raw.prepare('SELECT used_at FROM password_resets WHERE staff_id = ?').get(A).used_at === null, 'recuperação: confirmação diferente é recusada sem gastar o código');

  const wrong = await reset('reca@x.com', RC.generateCode(), 'senhanova123', '203.0.113.11');
  const ghost = await reset('ninguem@x.com', RC.generateCode(), 'senhanova123', '203.0.113.12');
  const nocode = await reset('recb@x.com', RC.generateCode(), 'senhanova123', '203.0.113.13');
  ok(wrong.status === 400 && wrong.body.error === ghost.body.error && wrong.body.error === nocode.body.error, 'recuperação: código errado, e-mail inexistente e conta sem código recebem a mesma resposta');
  const other = await reset('recb@x.com', code, 'senhanova123', '203.0.113.14');
  ok(other.status === 400 && other.body.error === wrong.body.error, 'recuperação: código de outra conta não funciona');
  ok((await call('POST', '/api/login', { email: 'recb@x.com', password: 'senhanova123' }, { ck: '' })).status === 401, 'recuperação: a outra conta não teve a senha trocada');

  const typed = ' ' + code.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/-/g, ' ') + ' ';
  const good = await reset('RecA@x.com', typed, 'senhanova123', '203.0.113.15');
  ok(good.status === 200 && good.body.ok === true && !good.body.token, 'recuperação: código válido redefine a senha (aceita minúsculas, espaços e letras trocadas)');
  ok((await call('GET', '/api/me', null, { ck: oldCk })).status === 401, 'recuperação: sessões antigas foram encerradas');
  ok((await call('POST', '/api/login', { email: 'reca@x.com', password: 'senhaantiga1' }, { ck: '', ip: '203.0.113.16' })).status === 401, 'recuperação: a senha anterior deixou de funcionar');
  ok((await call('POST', '/api/login', { email: 'reca@x.com', password: 'senhanova123' }, { ck: '', ip: '203.0.113.16' })).status === 200, 'recuperação: a senha nova funciona no login');
  const reuse = await reset('reca@x.com', code, 'outrasenha123', '203.0.113.17');
  ok(reuse.status === 400 && /já foi utilizado/.test(reuse.body.error), 'recuperação: código já usado é recusado com mensagem clara');
  ok((await call('POST', '/api/login', { email: 'reca@x.com', password: 'outrasenha123' }, { ck: '', ip: '203.0.113.18' })).status === 401, 'recuperação: código reutilizado não troca a senha');

  const old = issue(B, 31 * 60000);
  const late = await reset('recb@x.com', old, 'senhanova123', '203.0.113.19');
  ok(late.status === 400 && /expirou/.test(late.body.error), 'recuperação: código com mais de 30 minutos expirou');
  ok((await call('POST', '/api/login', { email: 'recb@x.com', password: 'senhaantiga1' }, { ck: '', ip: '203.0.113.20' })).status === 200, 'recuperação: código expirado não altera a senha');

  const c2 = issue(B);
  for (let i = 0; i < 5; i++) await reset('recb@x.com', RC.generateCode(), 'senhanova123', '198.51.100.' + (20 + i));
  // V11 (6.3-C): erros de terceiros não mexem no código; antes, 5 erros o invalidavam e o dono perdia o código.
  ok(DB.raw.prepare('SELECT attempts, used_at FROM password_resets WHERE staff_id = ?').get(B).attempts === 0, 'recuperação: erros de terceiros não alteram o código pendente');
  ok((await reset('recb@x.com', c2, 'senhanova123', '198.51.100.40')).status === 200, 'recuperação: depois de 5 erros de terceiros, o dono usa o código certo normalmente');
  const c3 = issue(B);
  ok((await reset('recb@x.com', c3, 'senhanova124', '198.51.100.41')).status === 200, 'recuperação: um código novo funciona');
  let st429 = 0; for (let i = 0; i < 9; i++) st429 = (await reset('alvo@x.com', RC.generateCode(), 'senhanova123', '192.0.2.99')).status;
  ok(st429 === 429, 'recuperação: muitas tentativas do mesmo IP recebem 429');

  const ev = DB.raw.prepare('SELECT event, count(*) n FROM audit_log GROUP BY event').all().reduce((o, r) => (o[r.event] = r.n, o), {});
  ok(ev.reset_issued >= 4 && ev.reset_used === 3 && ev.reset_failed >= 1, `recuperação: eventos registrados (${JSON.stringify(ev)})`);
  const dump = JSON.stringify(['password_resets', 'audit_log', 'login_attempts', 'staff', 'auth_sessions', 'settings'].map(t => DB.raw.prepare(`SELECT * FROM ${t}`).all()));
  const secrets = [code, c2, c3, old].flatMap(c => [c, c.replace(/-/g, '')]);
  ok(secrets.every(s => !dump.includes(s)), 'recuperação: nenhum código aparece em texto puro no banco');
  ok(!dump.includes('senhanova123') && !dump.includes('senhaantiga1'), 'recuperação: nenhuma senha aparece em texto puro no banco');
  const cap = []; for (const k of ['log', 'warn', 'error']) console[k] = (...a) => cap.push(a.join(' '));
  const c4 = issue(A); await reset('reca@x.com', c4, 'senhanova123', '203.0.113.50'); await reset('reca@x.com', RC.generateCode(), 'x12345678', '203.0.113.51');
  Object.assign(console, orig);
  ok(cap.every(l => !l.includes(c4) && !l.includes(c4.replace(/-/g, ''))), 'recuperação: nenhum código vai para os logs');
  ok(!RC.validEmail("a'b@x.com") && RC.validEmail('a@x.com'), 'script: e-mail com aspas é recusado');
  ok(!RC.buildSql(A, c4).includes(c4.replace(/-/g, '')) && !RC.buildSql(A, c4).includes(c4), 'script: o SQL gerado não contém o código');
}

// Agenda V1: roda junto da suíte da API (package.json não é alterado nesta branch; ver docs/agenda.md).
await import('./agenda.mjs');

console.log('\nTODOS OS TESTES DA API PASSARAM');
