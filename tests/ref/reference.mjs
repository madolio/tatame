// Implementação de REFERÊNCIA dos indicadores do Tatame, escrita a partir de docs/regras-calculos.md.
// Independente do Worker: não importa nada de web/. Lê linhas cruas do banco e devolve os mesmos indicadores.
//
// opts.legacy liga, regra por regra, o comportamento ATUAL do Worker no lugar da regra de referência:
//   future (D4), newMonth (D5), avg (D6), weekly (D7).
// Com todos ligados, a referência deve reproduzir o Worker; é assim que se prova que ela o entendeu
// (passe A) antes de se ver onde a regra nova diverge (passe B).
import { toDay, addDays, weekday, calendarMonths, ageYears, firstOfMonth, fromDay } from './dates.mjs';

const BELTS = ['branca', 'cinza', 'amarela', 'laranja', 'verde', 'azul', 'roxa', 'marrom', 'preta'];
const KIDS = ['cinza', 'amarela', 'laranja', 'verde'];            // branca é compartilhada (tratada à parte)
const ADULT = ['branca', 'azul', 'roxa', 'marrom', 'preta'];
const RANK = { branca: 0, azul: 1, roxa: 2, marrom: 3, preta: 4 };
const EXPERIENCE = [[0, 'Novato'], [30, 'Iniciante'], [100, 'Intermediário'], [250, 'Avançado'], [500, 'Experiente']];
const LEARNING = [[0, 'Inicial'], [20, 'Básico'], [40, 'Intermediário'], [60, 'Avançado'], [80, 'Domínio']];
const isKidBelt = b => KIDS.includes(b);

const r1 = (num, den) => den > 0 ? Math.floor((num * 20 + den) / (2 * den)) / 10 : 0;   // num/den, 1 casa, meio para cima, só inteiros
const pct = (num, den) => den > 0 ? Math.floor((num * 200 + den) / (2 * den)) : 0;      // num/den em %, inteiro, meio para cima
const round1 = x => Math.round(x * 10) / 10;
const levelOf = (table, v) => { let i = 0; table.forEach(([min], k) => { if (v >= min) i = k; }); return i; };
const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

export function computeReference(data, today, opts = {}) {
  const L = opts.legacy === 'all' ? { future: 1, newMonth: 1, avg: 1, weekly: 1 } : (opts.legacy || {});
  const T = toDay(today);
  const rules = Object.fromEntries(data.rules.map(r => [r.belt, r]));
  const lessonById = new Map(data.lessons.map(l => [l.id, l]));
  const attByStudent = new Map(), present = new Map();
  for (const a of data.attendance) {
    const l = lessonById.get(a.lesson_id); if (!l) continue;
    const row = { lesson: l, day: toDay(l.date), date: l.date, mins: Math.max(0, hm(l.end_time) - hm(l.start_time)) };
    if (!attByStudent.has(a.student_id)) attByStudent.set(a.student_id, []);
    attByStudent.get(a.student_id).push(row);
    present.set(a.lesson_id, (present.get(a.lesson_id) || 0) + 1);
  }
  const techsOfLesson = by(data.lesson_techniques, 'lesson_id');
  const skillsOf = new Map(); for (const s of data.skills) { if (!skillsOf.has(s.student_id)) skillsOf.set(s.student_id, new Map()); skillsOf.get(s.student_id).set(s.technique_id, s.level); }
  const promosOf = by(data.promotions, 'student_id');

  // ---------- por aluno ----------
  const students = {}, history = {};
  for (const st of data.students) {
    const rows = attByStudent.get(st.id) || [], promos = promosOf.get(st.id) || [];
    const start = toDay(st.start_date), startFuture = start > T;
    const total = rows.length;
    const last = total ? fromDay(Math.max(...rows.map(r => r.day))) : null;
    const within = (n, r) => r.day > T - n && r.day <= T;
    const sinceDegree = rows.filter(r => r.day >= toDay(st.degree_since)).length + (st.imported_classes_degree || 0);
    const sinceBelt = rows.filter(r => r.day >= toDay(st.belt_since)).length + (st.imported_classes_belt || 0);
    // frequência semanal (D7)
    const num84 = rows.filter(r => within(84, r)).length;
    const weeks = L.weekly ? 12 : Math.min(12, Math.max(1, Math.ceil((Math.max(0, T - start) + 1) / 7)));
    // ausência (D4)
    let daysAbsent;
    if (last) daysAbsent = T - toDay(last);
    else if (startFuture && !L.future) daysAbsent = null;
    else daysAbsent = T - start;
    const atRisk = st.status === 'ativo' && daysAbsent !== null && daysAbsent >= 14;
    // experiência (D3)
    let imported = st.imported_classes_belt || 0;
    for (const p of promos) if (p.kind === 'faixa') imported += p.from_imported_belt || 0;
    const expScore = total + imported + (st.prior_months || 0) * 8;
    const expIdx = levelOf(EXPERIENCE, expScore);
    // aprendizado
    const sk = skillsOf.get(st.id) || new Map();
    const rank = isKidBelt(st.belt) ? 0 : RANK[st.belt];
    const curr = data.techniques.filter(t => t.active && RANK[t.min_belt] <= rank);
    const sum = curr.reduce((s, t) => s + (sk.get(t.id) || 0), 0);
    const learnPct = curr.length ? pct(sum, curr.length * 5) : 0;
    const mastered = curr.filter(t => (sk.get(t.id) || 0) >= 3).length;
    const currPct = curr.length ? pct(mastered, curr.length) : 0;
    const seen = new Map();
    for (const r of rows) for (const t of techsOfLesson.get(r.lesson.id) || []) seen.set(t.technique_id, (seen.get(t.technique_id) || 0) + 1);
    const difficulties = [...seen].filter(([t, n]) => n >= 2 && (sk.get(t) || 0) <= 2).map(([t, n]) => ({ technique_id: t, times_seen: n, level: sk.get(t) || 0 }))
      .sort((a, b) => b.times_seen - a.times_seen || a.technique_id - b.technique_id);
    // graduação
    const age = st.birth_date ? ageYears(st.birth_date, today) : null;
    const r = rules[st.belt] || rules.branca;
    const maxDeg = st.belt === 'preta' ? 6 : 4;
    const crit = [], add = (key, cur, target) => crit.push({ key, current: round1(cur), target, met: cur >= target, exact: cur });
    let next = null;
    if (st.degrees < maxDeg) {
      next = { kind: 'grau', to_belt: st.belt, to_degrees: st.degrees + 1 };
      add('months', calendarMonths(st.degree_since, today), r.degree_months);
      if (r.degree_classes > 0) add('classes', sinceDegree, r.degree_classes);
    } else if (st.belt !== 'preta') {
      let nb;
      if (st.belt === 'branca') nb = age === null ? null : age < 16 ? 'cinza' : 'azul';
      else if (isKidBelt(st.belt)) nb = age === null ? (st.belt === 'verde' ? 'azul' : KIDS[KIDS.indexOf(st.belt) + 1]) : (age < 16 && st.belt !== 'verde' ? KIDS[KIDS.indexOf(st.belt) + 1] : 'azul');
      else nb = ADULT[ADULT.indexOf(st.belt) + 1];
      next = { kind: 'faixa', to_belt: nb, to_degrees: 0 };
      if (r.belt_months != null) add('months', calendarMonths(st.belt_since, today), r.belt_months);
      if (r.belt_classes != null) add('classes', sinceBelt, r.belt_classes);
      if (r.curriculum_pct != null) add('curriculum', currPct, r.curriculum_pct);
      const minAge = nb === null ? null : (st.belt === 'branca' && nb === 'cinza') ? 4 : (nb === 'azul' && (st.belt === 'branca' || isKidBelt(st.belt))) ? 16 : r.next_min_age;
      if (minAge != null && age !== null) add('age', age, minAge);
    }
    const progress = crit.length ? Math.round(crit.reduce((t, c) => t + Math.min(1, c.target > 0 ? c.exact / c.target : 1), 0) / crit.length * 100) : 0;
    const ready = !!next && crit.length > 0 && crit.every(c => c.met);
    const issues = [];
    if (!st.birth_date) issues.push('sem_nascimento');
    if (startFuture && !L.future) issues.push('inicio_futuro');
    students[st.id] = {
      name: st.name, status: st.status, age, classes_total: total, last_attendance: last, days_absent: daysAbsent, at_risk: atRisk,
      classes_last_30d: rows.filter(r2 => within(30, r2)).length, weekly_avg: r1(num84, weeks), mat_hours: r1(rows.reduce((t, x) => t + x.mins, 0), 60),
      classes_since_degree: sinceDegree, classes_since_belt: sinceBelt,
      months_in_belt: round1(calendarMonths(st.belt_since, today)),
      training_months: round1(Math.max(0, calendarMonths(st.start_date, today)) + (st.prior_months || 0)),
      experience: { score: expScore, in_belt: sinceBelt, level: expIdx + 1, label: EXPERIENCE[expIdx][1] },
      learning: { pct: learnPct, level: levelOf(LEARNING, learnPct) + 1, label: LEARNING[levelOf(LEARNING, learnPct)][1], curriculum_size: curr.length, mastered, curriculum_pct: currPct },
      techniques_seen: seen.size, difficulties, next, criteria: crit, progress, ready,
      needs_profile: !st.birth_date, data_issues: issues
    };
    history[st.id] = replay(st, promos);
  }

  // ---------- painel ----------
  const active = data.students.filter(s => s.status === 'ativo');
  const ws = T - ((weekday(today) + 6) % 7);
  const lessonsIn = (from, to) => data.lessons.filter(l => { const d = toDay(l.date); return d >= from && d <= to; });
  const withCall = ls => ls.filter(l => (present.get(l.id) || 0) > 0);
  const presentSum = ls => ls.reduce((t, l) => t + (present.get(l.id) || 0), 0);
  const avgOf = ls => { const base = L.avg ? ls : withCall(ls); return base.length ? r1(presentSum(ls), base.length) : 0; };
  const weekly = [...Array(12)].map((_, i) => {
    const from = ws - 7 * (11 - i), ls = lessonsIn(from, from + 6);
    const ids = new Set(); for (const [sid, rows] of attByStudent) if (rows.some(x => x.day >= from && x.day <= from + 6)) ids.add(sid);
    return { week: fromDay(from), lessons: ls.length, attendance: presentSum(ls), unique_students: ids.size };
  });
  const l30 = lessonsIn(T - 29, T);
  const monthStart = toDay(firstOfMonth(today));
  const newMonth = L.newMonth ? data.students.filter(s => toDay(s.start_date) >= monthStart).length
    : active.filter(s => toDay(s.start_date) >= monthStart && toDay(s.start_date) <= T).length;
  const ids = x => active.filter(s => x(students[s.id])).map(s => s.id);
  const l56 = lessonsIn(T - 55, T);
  const heat = {};
  for (const l of l56) { const k = weekday(l.date) + '-' + l.start_time.slice(0, 2); (heat[k] = heat[k] || { weekday: weekday(l.date), hour: +l.start_time.slice(0, 2), ls: [] }).ls.push(l); }
  const dashboard = {
    kpis: {
      active_students: active.length, new_this_month: newMonth, at_risk: ids(s => s.at_risk).length, ready: ids(s => s.ready).length,
      lessons_30d: l30.length, avg_per_lesson_30d: avgOf(l30),
      attendance_this_week: weekly[11].attendance, attendance_last_week: weekly[10].attendance,
      attendance_last_week_same_period: data.attendance.filter(a => { const d = toDay(lessonById.get(a.lesson_id).date); return d >= ws - 7 && d <= T - 7; }).length
    },
    weekly,
    belts: BELTS.map(b => ({ belt: b, count: active.filter(s => s.belt === b).length })).filter(x => x.count),
    occupancy: data.classes.filter(c => c.active).map(c => { const ls = l56.filter(l => l.class_id === c.id); return { class_id: c.id, lessons: ls.length, avg: avgOf(ls) }; }),
    heat: Object.values(heat).map(h => ({ weekday: h.weekday, hour: h.hour, lessons: h.ls.length, attendance: presentSum(h.ls), avg: avgOf(h.ls) })),
    todays: data.classes.filter(c => c.active && c.weekday === weekday(today)).map(c => ({ class_id: c.id, has_lesson: data.lessons.some(l => l.class_id === c.id && l.date === today) })),
    ready_list: ids(s => s.ready), risk_list: ids(s => s.at_risk),
    near_list: active.filter(s => !students[s.id].ready && students[s.id].progress >= 75).sort((a, b) => students[b.id].progress - students[a.id].progress).slice(0, 8).map(s => s.id)
  };

  // ---------- técnicas ----------
  const techniques = {};
  for (const t of data.techniques) {
    const given = data.lesson_techniques.filter(x => x.technique_id === t.id).map(x => lessonById.get(x.lesson_id)).filter(Boolean);
    const levels = data.skills.filter(s => s.technique_id === t.id).map(s => s.level);
    const dates = given.map(l => l.date).sort();
    techniques[t.id] = {
      name: t.name, times_taught: given.length, last_taught: dates.length ? dates[dates.length - 1] : null,
      taught_90d: given.filter(l => { const d = toDay(l.date); return d > T - 90 && d <= T; }).length,
      assessed: levels.length, avg_level: levels.length ? r1(levels.reduce((a, b) => a + b, 0), levels.length) : null, proficient: levels.filter(v => v >= 3).length
    };
  }
  return { today, students, dashboard, techniques, history };
}

const hm = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);

// Evolução de faixa e grau: confere o estado atual do aluno contra a cadeia de graduações (docs/regras-calculos.md, "Evolução").
function replay(st, promos) {
  const problems = [];
  if (!promos.length) return { consistent: true, problems, promotions: 0 };
  promos.forEach((p, i) => {
    if (i && (p.from_belt !== promos[i - 1].to_belt || p.from_degrees !== promos[i - 1].to_degrees)) problems.push(`cadeia quebrada na graduação ${i + 1}`);
    if (p.kind === 'faixa' && p.to_degrees !== 0) problems.push(`faixa ${i + 1} com grau ${p.to_degrees}`);
    if (p.kind === 'grau' && (p.to_belt !== p.from_belt || p.to_degrees !== p.from_degrees + 1)) problems.push(`grau ${i + 1} inconsistente`);
  });
  const last = promos[promos.length - 1], lastBelt = [...promos].reverse().find(p => p.kind === 'faixa');
  if (st.belt !== last.to_belt || st.degrees !== last.to_degrees) problems.push(`faixa/grau atuais (${st.belt}/${st.degrees}) diferem da última graduação (${last.to_belt}/${last.to_degrees})`);
  if (st.degree_since !== last.date) problems.push(`degree_since ${st.degree_since} difere da data da última graduação ${last.date}`);
  if (lastBelt && st.belt_since !== lastBelt.date) problems.push(`belt_since ${st.belt_since} difere da última graduação de faixa ${lastBelt.date}`);
  if (st.imported_classes_degree !== 0) problems.push('aulas importadas do grau não foram zeradas');
  if (last.kind === 'faixa' && st.imported_classes_belt !== 0) problems.push('aulas importadas da faixa não foram zeradas');
  return { consistent: problems.length === 0, problems, promotions: promos.length };
}
