// Dados de teste da paridade: cenários manuais (cada aluno ilustra um caso), um conjunto gerado com semente fixa e um banco vazio.
// Tudo é inserido direto no banco (permite dados inválidos que a API recusaria); graduações passam pela API real.
import { addDays, weekday, addMonths, firstOfMonth } from './dates.mjs';

let seq = 0;
const nid = p => `${p}-${String(++seq).padStart(5, '0')}`;
const RANK = { branca: 0, azul: 1, roxa: 2, marrom: 3, preta: 4 };

function addStudent(DB, o) {
  const s = { id: crypto.randomUUID(), nickname: null, birth_date: null, prior_months: 0, belt: 'branca', degrees: 0, imported_classes_belt: 0, imported_classes_degree: 0, status: 'ativo', ...o };
  s.belt_since = s.belt_since || s.start_date; s.degree_since = s.degree_since || s.belt_since;
  DB.raw.prepare(`INSERT INTO students (id, name, birth_date, start_date, prior_months, belt, degrees, belt_since, degree_since, imported_classes_belt, imported_classes_degree, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, s.name, s.birth_date, s.start_date, s.prior_months, s.belt, s.degrees, s.belt_since, s.degree_since, s.imported_classes_belt, s.imported_classes_degree, s.status);
  return s.id;
}
const addClass = (DB, o) => { const id = nid('cl'); DB.raw.prepare('INSERT INTO classes (id, name, weekday, start_time, end_time, active) VALUES (?,?,?,?,?,?)').run(id, o.name, o.weekday, o.start, o.end, o.active === 0 ? 0 : 1); return id; };
function addLesson(DB, o) {
  const id = nid('ls');
  DB.raw.prepare('INSERT INTO lessons (id, class_id, date, start_time, end_time) VALUES (?,?,?,?,?)').run(id, o.class_id || null, o.date, o.start || '19:00', o.end || '20:00');
  for (const s of o.students || []) DB.raw.prepare('INSERT INTO attendance (lesson_id, student_id) VALUES (?,?)').run(id, s);
  for (const t of o.techs || []) DB.raw.prepare('INSERT INTO lesson_techniques (lesson_id, technique_id) VALUES (?,?)').run(id, t);
  return id;
}
const setSkill = (DB, sid, tid, level) => DB.raw.prepare('INSERT OR REPLACE INTO skills (student_id, technique_id, level) VALUES (?,?,?)').run(sid, tid, level);
const masterAll = (DB, sid, maxBelt, level) => { for (const t of DB.raw.prepare('SELECT id, min_belt FROM techniques').all()) if (RANK[t.min_belt] <= RANK[maxBelt]) setSkill(DB, sid, t.id, level); };
const birthYearsAgo = (today, years, extraDays = 0) => addDays(addMonths(today, -12 * years), -extraDays);

// ---------------------------------------------------------------------------------------------
export async function buildManual(world) {
  const { DB, api, today: T } = world;
  const d = n => addDays(T, n);
  const S = {}; // nome -> id
  const mk = (name, o) => (S[name] = addStudent(DB, { name, ...o }));
  const adult = '1990-03-10';
  const monthStart = firstOfMonth(T);

  // frequência e ausência
  mk('Frequente', { start_date: d(-400), degrees: 2, degree_since: d(-120), birth_date: adult });
  mk('Regular', { start_date: d(-300), birth_date: adult });
  mk('Veterano', { start_date: d(-5000), belt: 'preta', degrees: 2, belt_since: d(-3000), degree_since: d(-1200), birth_date: '1975-01-01' });
  mk('NuncaVeio20', { start_date: d(-20), birth_date: adult });
  mk('Recem3', { start_date: d(-3), birth_date: adult });
  mk('NuncaVeio200', { start_date: d(-200), birth_date: adult });
  mk('InicioFuturo', { start_date: d(10), birth_date: adult });
  mk('InicioFuturoComPresenca', { start_date: d(5), birth_date: adult });
  mk('Ausente14', { start_date: d(-300), birth_date: adult });
  mk('Ausente13', { start_date: d(-300), birth_date: adult });
  mk('JanelaBorda', { start_date: d(-400), birth_date: adult });
  mk('Trancado', { start_date: d(-300), status: 'trancado', birth_date: adult });
  mk('Inativo', { start_date: d(-300), status: 'inativo', birth_date: adult });
  mk('AulaAntesInicio', { start_date: d(-10), birth_date: adult });
  mk('AulaAntesFaixa', { start_date: d(-400), belt_since: d(-100), degree_since: d(-100), birth_date: adult });
  mk('Entrou14Dias', { start_date: d(-14), birth_date: adult });
  // novos no mês
  mk('NovoMesAtivo', { start_date: monthStart, birth_date: adult });
  mk('NovoMesInativo', { start_date: monthStart, status: 'inativo', birth_date: adult });
  mk('NovoMesPassado', { start_date: addDays(monthStart, -1), birth_date: adult });
  // nascimento ausente e idades
  mk('SemNascBrancaPronto', { start_date: d(-900), degrees: 4, degree_since: d(-100), imported_classes_belt: 200, imported_classes_degree: 40 });
  mk('SemNascAmarelaPronto', { start_date: d(-900), belt: 'amarela', degrees: 4, degree_since: d(-100), imported_classes_belt: 200, imported_classes_degree: 40 });
  mk('SemNascAzulPronto', { start_date: d(-900), belt: 'azul', degrees: 4, degree_since: d(-100), imported_classes_belt: 300, imported_classes_degree: 60 });
  mk('SemNascVerde', { start_date: d(-900), belt: 'verde', degrees: 4, imported_classes_belt: 200 });
  mk('ProntoFaixaAdulto', { start_date: d(-900), degrees: 4, degree_since: d(-100), imported_classes_belt: 200, imported_classes_degree: 40, birth_date: adult });
  mk('Kid12Branca', { start_date: d(-900), degrees: 4, imported_classes_belt: 200, birth_date: birthYearsAgo(T, 12, 40) });
  mk('Kid15Verde', { start_date: d(-900), belt: 'verde', degrees: 4, imported_classes_belt: 200, birth_date: birthYearsAgo(T, 15, 40) });
  mk('Teen16Amarela', { start_date: d(-900), belt: 'amarela', degrees: 4, imported_classes_belt: 200, birth_date: birthYearsAgo(T, 16, 5) });
  mk('Preta6', { start_date: d(-6000), belt: 'preta', degrees: 6, birth_date: '1970-01-01' });
  // graduações pela API (evolução de faixa e grau)
  mk('ImportadoPromovido', { start_date: d(-400), belt: 'azul', degrees: 4, degree_since: d(-50), imported_classes_belt: 300, imported_classes_degree: 40, birth_date: adult });
  mk('FaixaDepoisDeGrau', { start_date: d(-400), belt: 'azul', degrees: 3, degree_since: d(-60), imported_classes_belt: 50, imported_classes_degree: 10, birth_date: adult });
  mk('GrauPromovido', { start_date: d(-500), degrees: 1, degree_since: d(-200), imported_classes_belt: 80, imported_classes_degree: 30, birth_date: adult });
  mk('PromovidoDesfeito', { start_date: d(-500), degrees: 0, imported_classes_belt: 20, imported_classes_degree: 20, birth_date: adult });
  mk('DuasGraduacoes', { start_date: d(-500), belt: 'azul', degrees: 0, belt_since: d(-300), degree_since: d(-300), birth_date: adult });
  // limite de mês (item 8)
  mk('FimDeMes', { start_date: '2026-01-31', degrees: 0, belt_since: '2026-01-31', degree_since: '2026-01-31', imported_classes_belt: 30, imported_classes_degree: 30, birth_date: adult });
  mk('SemChamadaTecnicaSo', { start_date: d(-100), birth_date: adult });

  // currículo dominado onde a prontidão depende dele
  for (const n of ['SemNascBrancaPronto', 'SemNascAmarelaPronto', 'ProntoFaixaAdulto', 'Kid12Branca', 'Kid15Verde', 'Teen16Amarela', 'SemNascVerde']) masterAll(DB, S[n], 'branca', 4);
  masterAll(DB, S.SemNascAzulPronto, 'azul', 4); masterAll(DB, S.ImportadoPromovido, 'azul', 4);
  for (let t = 1; t <= 12; t++) { setSkill(DB, S.Frequente, t, t % 6); if (t % 2) setSkill(DB, S.Regular, t, 1 + (t % 3)); }

  // turmas e aulas regulares nos últimos 120 dias
  const c1 = addClass(DB, { name: 'Segunda', weekday: 1, start: '19:00', end: '20:30' });
  const c2 = addClass(DB, { name: 'Quarta', weekday: 3, start: '19:00', end: '20:30' });
  const c3 = addClass(DB, { name: 'Sábado', weekday: 6, start: '10:00', end: '11:30' });
  addClass(DB, { name: 'Turma antiga', weekday: 5, start: '18:00', end: '19:00', active: 0 });
  const roster = { [c1]: ['Frequente', 'Regular', 'Veterano'], [c2]: ['Frequente', 'Regular'], [c3]: ['Frequente'] };
  const byWd = { 1: [c1, '19:00', '20:30'], 3: [c2, '19:00', '20:30'], 6: [c3, '10:00', '11:30'] };
  for (let o = -120; o <= 0; o++) {
    const w = byWd[weekday(d(o))]; if (!w) continue;
    const empty = o % 11 === 0 && o !== 0;           // aula dada, sem chamada registrada
    addLesson(DB, { class_id: w[0], date: d(o), start: w[1], end: w[2], students: empty ? [] : roster[w[0]].map(n => S[n]), techs: [((-o) % 10) + 1, ((-o + 3) % 10) + 1] });
  }
  // aulas avulsas: nome -> deslocamentos em dias
  const extra = {
    JanelaBorda: [-29, -30, -83, -84, -89, -90], Ausente14: [-14, -60], Ausente13: [-13], Trancado: [-40], Inativo: [-50],
    InicioFuturoComPresenca: [-1], AulaAntesInicio: [-20, -5], AulaAntesFaixa: [-150, -50], Entrou14Dias: [-1, -3, -5, -8, -10, -12],
    ImportadoPromovido: [-100, -1], GrauPromovido: [-300, -100, -2], SemNascBrancaPronto: [-10, -20, -30], Kid12Branca: [-5], Preta6: [-9],
    NovoMesAtivo: [0], FimDeMes: [-3, -2], FaixaDepoisDeGrau: [-8], DuasGraduacoes: [-40]
  };
  const bucket = {};
  for (const [n, offs] of Object.entries(extra)) for (const o of offs) (bucket[o] = bucket[o] || []).push(S[n]);
  for (const [o, ids] of Object.entries(bucket)) addLesson(DB, { date: d(+o), start: '18:00', end: '19:00', students: ids, techs: +o % 2 ? [20, 21] : [20] });
  // aula só com técnica e sem presentes, e aulas sem turma e sem nada
  addLesson(DB, { date: d(-2), start: '07:00', end: '08:00', students: [], techs: [30] });
  addLesson(DB, { date: d(-95), start: '07:00', end: '08:00', students: [], techs: [31] });
  addLesson(DB, { date: d(-4), start: '12:00', end: '12:45', students: [], techs: [] });

  // graduações pela API, na ordem
  const promote = async (name, body) => { const r = await api('POST', `/api/students/${S[name]}/promote`, body); if (r.status >= 300) throw new Error(`promover ${name}: ${JSON.stringify(r.body)}`); };
  await promote('ImportadoPromovido', { kind: 'faixa', to_belt: 'roxa', override: true, date: d(-1) });
  await promote('GrauPromovido', { kind: 'grau', override: true, date: d(-2) });
  await promote('PromovidoDesfeito', { kind: 'grau', override: true, date: d(-3) });
  const last = DB.raw.prepare('SELECT id FROM promotions WHERE student_id = ? ORDER BY rowid DESC LIMIT 1').get(S.PromovidoDesfeito);
  const un = await api('DELETE', `/api/promotions/${last.id}`); if (un.status >= 300) throw new Error('desfazer: ' + JSON.stringify(un.body));
  await promote('DuasGraduacoes', { kind: 'grau', override: true, date: d(-30) });
  await promote('DuasGraduacoes', { kind: 'grau', override: true, date: d(-10) });
  await promote('FaixaDepoisDeGrau', { kind: 'grau', override: true, date: d(-20) });
  await promote('FaixaDepoisDeGrau', { kind: 'faixa', to_belt: 'roxa', override: true, date: d(-5) });
  return S;
}

// ---------------------------------------------------------------------------------------------
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function buildGenerated(world, seed = 20260617) {
  const { DB, today: T } = world;
  const d = n => addDays(T, n);
  const rnd = mulberry32(seed), ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[Math.floor(rnd() * a.length)];
  const BELT_POOL = ['branca', 'branca', 'branca', 'branca', 'cinza', 'amarela', 'laranja', 'verde', 'azul', 'azul', 'azul', 'roxa', 'roxa', 'marrom', 'preta'];
  const cls = [[1, '07:00', '08:00'], [1, '19:00', '20:00'], [2, '19:00', '20:30'], [3, '19:00', '20:00'], [4, '07:00', '08:00'], [6, '10:00', '11:30']].map(([wd, s, e], i) => addClass(DB, { name: `Turma ${i + 1}`, weekday: wd, start: s, end: e, active: i === 4 ? 0 : 1 }));
  const students = [];
  for (let i = 1; i <= 45; i++) {
    let belt = pick(BELT_POOL), age;
    if (['cinza', 'amarela', 'laranja', 'verde'].includes(belt)) age = ri(5, 15); else if (belt === 'branca' && rnd() < 0.3) age = ri(6, 15); else age = ri(16, 60);
    if (belt !== 'branca' && belt !== 'cinza' && belt !== 'amarela' && belt !== 'laranja' && belt !== 'verde' && age < 18) age = 18 + ri(0, 10);
    const future = i <= 2;
    const start = future ? d(ri(1, 20)) : d(-ri(1, 1500));
    const sinceStart = Math.max(0, Math.round((Date.parse(T) - Date.parse(start)) / 864e5));
    const beltSince = future ? start : addDays(start, ri(0, sinceStart));
    const sinceBelt = Math.max(0, Math.round((Date.parse(T) - Date.parse(beltSince)) / 864e5));
    const degreeSince = future ? start : addDays(beltSince, ri(0, sinceBelt));
    const impBelt = rnd() < 0.35 ? ri(10, 400) : 0;
    const st = {
      name: `G${String(i).padStart(2, '0')}`, start_date: start, belt, degrees: belt === 'preta' ? ri(0, 6) : ri(0, 4), belt_since: beltSince, degree_since: degreeSince,
      imported_classes_belt: impBelt, imported_classes_degree: impBelt ? ri(0, impBelt) : 0, prior_months: rnd() < 0.3 ? ri(1, 60) : 0,
      birth_date: rnd() < 0.88 ? birthYearsAgo(T, age, ri(0, 360)) : null,
      status: (r => r < 0.85 ? 'ativo' : r < 0.95 ? 'trancado' : 'inativo')(rnd())
    };
    const id = addStudent(DB, st);
    students.push({ id, start, p: rnd() * 0.9, quitAt: rnd() < 0.25 ? d(-ri(1, 120)) : null });
    if (rnd() < 0.8) { const n = ri(5, 40); for (let k = 0; k < n; k++) setSkill(DB, id, ri(1, 70), pick([0, 1, 1, 2, 2, 3, 3, 4, 5])); }
  }
  for (let o = -210; o <= 0; o++) {
    for (let ci = 0; ci < cls.length; ci++) {
      const [wd, s, e] = [[1, '07:00', '08:00'], [1, '19:00', '20:00'], [2, '19:00', '20:30'], [3, '19:00', '20:00'], [4, '07:00', '08:00'], [6, '10:00', '11:30']][ci];
      if (weekday(d(o)) !== wd) continue;
      const empty = rnd() < 0.06;
      const att = empty ? [] : students.filter(s2 => (s2.start <= d(o) || rnd() < 0.02) && (!s2.quitAt || d(o) < s2.quitAt) && rnd() < s2.p * (ci === 1 ? 1 : 0.5)).map(s2 => s2.id);
      const techs = [...new Set([...Array(ri(0, 3))].map(() => ri(1, 70)))];
      addLesson(DB, { class_id: cls[ci], date: d(o), start: s, end: e, students: att, techs });
    }
  }
}

export const buildEmpty = async () => {};
