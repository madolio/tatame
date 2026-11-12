// Paridade: compara, campo a campo, os indicadores do Worker real com a implementação de referência (tests/ref/reference.mjs).
//
//   node tests/parity.mjs               confere o resultado contra o catálogo tests/ref/divergencias.json (falha se algo novo ou sumido)
//   node tests/parity.mjs --descobrir   lista as divergências observadas por passe/campo, sem conferir o catálogo
//
// Passe A ("fidelidade"): a referência com o comportamento ATUAL ligado. Qualquer divergência aqui é um defeito da
//   referência ou um comportamento do Worker que ninguém declarou. Só a fronteira de fim de mês (item 8) é esperada.
// Passe B ("regra nova"): a referência com as regras provisórias D1, D3, D4, D5, D6, D7. As divergências são o que
//   mudaria no Worker se as regras forem aprovadas; cada uma está catalogada com evidência e contagem exata.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeReference } from './ref/reference.mjs';
import { openWorld, unfreezeClock } from './ref/harness.mjs';
import { buildManual, buildGenerated, buildEmpty } from './ref/scenarios.mjs';

const DISCOVER = process.argv.includes('--descobrir');
const CATALOG = fileURLToPath(new URL('./ref/divergencias.json', import.meta.url));
const TOL = { meses: 0.15, progresso: 5 };           // documentados em docs/regras-calculos.md
const MONTH_FIELDS = new Set(['months_in_belt', 'training_months', 'criteria.months.current']);

// ---------- visões planas ----------
function flatWorkerStudent(s) {
  const m = s.metrics, f = {
    age: m.age, classes_total: m.classes_total, last_attendance: m.last_attendance, days_absent: m.days_absent, at_risk: m.at_risk,
    classes_last_30d: m.classes_last_30d, weekly_avg: m.weekly_avg, mat_hours: m.mat_hours, classes_since_degree: m.classes_since_degree, classes_since_belt: m.classes_since_belt,
    months_in_belt: m.months_in_belt, training_months: m.training_months,
    'experience.score': m.experience.score, 'experience.in_belt': m.experience.in_belt, 'experience.level': m.experience.level, 'experience.label': m.experience.label,
    'learning.pct': m.learning.pct, 'learning.level': m.learning.level, 'learning.label': m.learning.label, 'learning.curriculum_size': m.learning.curriculum_size,
    'learning.mastered': m.learning.mastered, 'learning.curriculum_pct': m.learning.curriculum_pct, techniques_seen: m.techniques_seen,
    'next.kind': m.next ? m.next.kind : null, 'next.to_belt': m.next ? m.next.to_belt : null, 'next.to_degrees': m.next ? m.next.to_degrees : null,
    progress: m.progress, ready: m.ready, difficulties: m.difficulties,
    needs_profile: m.needs_profile, data_issues: m.data_issues.join(',')
  };
  for (const c of m.criteria) { f[`criteria.${c.key}.target`] = c.target; f[`criteria.${c.key}.met`] = c.met; f[`criteria.${c.key}.current`] = c.current; }
  return f;
}
function flatRefStudent(s) {
  const f = {
    age: s.age, classes_total: s.classes_total, last_attendance: s.last_attendance, days_absent: s.days_absent, at_risk: s.at_risk,
    classes_last_30d: s.classes_last_30d, weekly_avg: s.weekly_avg, mat_hours: s.mat_hours, classes_since_degree: s.classes_since_degree, classes_since_belt: s.classes_since_belt,
    months_in_belt: s.months_in_belt, training_months: s.training_months,
    'experience.score': s.experience.score, 'experience.in_belt': s.experience.in_belt, 'experience.level': s.experience.level, 'experience.label': s.experience.label,
    'learning.pct': s.learning.pct, 'learning.level': s.learning.level, 'learning.label': s.learning.label, 'learning.curriculum_size': s.learning.curriculum_size,
    'learning.mastered': s.learning.mastered, 'learning.curriculum_pct': s.learning.curriculum_pct, techniques_seen: s.techniques_seen,
    'next.kind': s.next ? s.next.kind : null, 'next.to_belt': s.next ? s.next.to_belt : null, 'next.to_degrees': s.next ? s.next.to_degrees : null,
    progress: s.progress, ready: s.ready, difficulties: s.difficulties,
    needs_profile: s.needs_profile, data_issues: s.data_issues.join(',')
  };
  for (const c of s.criteria) { f[`criteria.${c.key}.target`] = c.target; f[`criteria.${c.key}.met`] = c.met; f[`criteria.${c.key}.current`] = c.current; }
  return f;
}

// Compara duas listas de dificuldades: mesmos tamanhos e mesma sequência de "vezes vista"; cada item do Worker existe na referência com os mesmos valores.
function diffDifficulties(w, r) {
  const seqW = w.map(x => x.times_seen).join(','), seqR = r.slice(0, 10).map(x => x.times_seen).join(',');
  if (seqW !== seqR) return `${seqW} x ${seqR}`;
  const key = x => `${x.technique_id}:${x.times_seen}:${x.level}`;
  const all = new Set(r.map(key));
  const missing = w.filter(x => !all.has(key(x)));
  return missing.length ? 'itens fora da referência: ' + missing.map(key).join(',') : null;
}

const same = (a, b) => a === b || (a == null && b == null);
function compareField(field, w, r) {
  if (field === 'difficulties') { const e = diffDifficulties(w, r); return e ? { w: JSON.stringify(w), r: e } : null; }
  if (MONTH_FIELDS.has(field)) return (w == null || r == null) ? (same(w, r) ? null : { w, r }) : Math.abs(w - r) <= TOL.meses ? null : { w, r };
  if (field === 'progress') return Math.abs(w - r) <= TOL.progresso ? null : { w, r };
  return same(w, r) ? null : { w, r };
}

// ---------- comparação de um conjunto ----------
function compare(state, ref, passe) {
  const out = []; let compared = 0;
  const div = (scope, entity, field, w, r) => out.push({ scope, entity, field, w, r });
  const wById = new Map(state.students.map(s => [s.id, s]));
  const nameOf = id => (wById.get(id) || {}).name || id;
  // alunos
  for (const [id, rs] of Object.entries(ref.students)) {
    const ws = wById.get(id); if (!ws) { div('aluno', rs.name, 'existe', null, true); continue; }
    const wf = flatWorkerStudent(ws), rf = flatRefStudent(rs);
    const reported = new Set();
    for (const field of new Set([...Object.keys(wf), ...Object.keys(rf)])) {
      compared++;
      if (!(field in wf) || !(field in rf)) {
        const crit = field.replace(/^criteria\.([a-z]+)\..*/, 'criteria.$1.presente');
        if (!reported.has(crit)) { reported.add(crit); div('aluno', rs.name, crit, field in wf ? 'presente' : 'ausente', field in rf ? 'presente' : 'ausente'); }
        continue;
      }
      const d = compareField(field, wf[field], rf[field]); if (d) div('aluno', rs.name, field, d.w, d.r);
    }
    const h = ref.history[id]; compared++;
    if (!h.consistent) div('historico', rs.name, 'evolucao_faixa_grau', 'inconsistente', h.problems.join('; '));
  }
  // painel
  const wd = state.dashboard, rd = ref.dashboard;
  for (const k of Object.keys(rd.kpis)) { compared++; const d = compareField('kpi', wd.kpis[k], rd.kpis[k]); if (d) div('painel', 'kpis', `kpis.${k}`, d.w, d.r); }
  rd.weekly.forEach((rw, i) => { for (const k of ['week', 'lessons', 'attendance', 'unique_students']) { compared++; const d = compareField(k, wd.weekly[i][k], rw[k]); if (d) div('painel', `semana ${rw.week}`, `weekly.${k}`, d.w, d.r); } });
  const mapBy = (rows, f) => new Map(rows.map(x => [f(x), x]));
  const cmpMap = (name, wRows, rRows, keyOf, fields) => {
    const wm = mapBy(wRows, keyOf), rm = mapBy(rRows, keyOf);
    for (const key of new Set([...wm.keys(), ...rm.keys()])) {
      const a = wm.get(key), b = rm.get(key);
      if (!a || !b) { compared++; div('painel', `${name} ${key}`, `${name}.presente`, a ? 'presente' : 'ausente', b ? 'presente' : 'ausente'); continue; }
      for (const f of fields) { compared++; const d = compareField(f, a[f], b[f]); if (d) div('painel', `${name} ${key}`, `${name}.${f}`, d.w, d.r); }
    }
  };
  cmpMap('belts', wd.belts, rd.belts, x => x.belt, ['count']);
  cmpMap('occupancy', wd.occupancy, rd.occupancy, x => x.class_id, ['lessons', 'avg']);
  cmpMap('heat', wd.heat, rd.heat, x => `${x.weekday}-${x.hour}`, ['lessons', 'attendance', 'avg']);
  cmpMap('todays', wd.todays.map(t => ({ class_id: t.id, has_lesson: !!t.lesson })), rd.todays, x => x.class_id, ['has_lesson']);
  for (const k of ['ready_list', 'risk_list', 'near_list']) {
    compared++;
    const a = wd[k].map(nameOf).sort().join(','), b = rd[k].map(nameOf).sort().join(',');
    if (a !== b) div('painel', k, k, a, b);
  }
  // técnicas
  const wt = new Map(state.techniques.map(t => [t.id, t]));
  for (const [id, rt] of Object.entries(ref.techniques)) {
    const t = wt.get(+id);
    for (const k of ['times_taught', 'last_taught', 'taught_90d', 'assessed', 'avg_level', 'proficient']) { compared++; const d = compareField(k, t[k], rt[k]); if (d) div('tecnica', rt.name, `tecnica.${k}`, d.w, d.r); }
  }
  return { out, compared };
}

// ---------- execução ----------
const DATASETS = [
  ['manual@2026-06-17', '2026-06-17', buildManual], ['manual@2026-04-30', '2026-04-30', buildManual],
  ['gerado@2026-06-17', '2026-06-17', buildGenerated], ['vazio@2026-06-17', '2026-06-17', buildEmpty]
];
const observed = []; // {passe, dataset, scope, entity, field, w, r}
let totalCompared = 0;
for (const [label, today, build] of DATASETS) {
  const world = await openWorld(today);
  await build(world);
  const data = world.dump(), state = await world.state();
  if (state.today !== today) throw new Error(`relógio não congelou: ${state.today} x ${today}`);
  for (const passe of ['A', 'B']) {
    const ref = computeReference(data, today, passe === 'A' ? { legacy: 'all' } : {});
    const { out, compared } = compare(state, ref, passe);
    totalCompared += compared;
    console.log(`${label.padEnd(20)} passe ${passe}: ${compared} campos comparados, ${out.length} divergências`);
    if (passe === 'B') {
      const v = Object.values(ref.students);
      console.log(`${''.padEnd(20)} cobertura: ${v.length} alunos, ${v.filter(x => x.status === 'ativo').length} ativos, ${v.filter(x => x.at_risk).length} em risco, ${v.filter(x => x.ready).length} prontos, ${v.filter(x => x.needs_profile).length} sem nascimento, ${Object.values(ref.history).filter(h => h.promotions).length} com graduações, ${data.lessons.length} aulas (${data.lessons.filter(l => !data.attendance.some(a => a.lesson_id === l.id)).length} sem presença), ${data.attendance.length} presenças`);
    }
    for (const x of out) observed.push({ passe, dataset: label, ...x });
  }
}
unfreezeClock();

const general = f => f.replace(/^weekly\./, 'weekly.');
const groupKey = x => `${x.passe}|${x.scope}:${general(x.field)}`;

if (process.argv.includes('--detalhe')) {
  for (const x of observed) console.log(`[${x.passe}] ${x.dataset} ${x.scope} ${x.entity} ${x.field}: atual=${JSON.stringify(x.w)} referência=${JSON.stringify(x.r)}`);
  process.exit(0);
}
if (DISCOVER) {
  const g = new Map();
  for (const x of observed) { const k = groupKey(x) + '|' + x.dataset; const e = g.get(k) || { n: 0, ex: x }; e.n++; g.set(k, e); }
  for (const [k, e] of [...g].sort()) console.log(k.padEnd(78), String(e.n).padStart(4), '  ex:', e.ex.entity, '| atual =', JSON.stringify(e.ex.w), '| referência =', JSON.stringify(e.ex.r));
  console.log(`\n${observed.length} divergências em ${totalCompared} campos.`);
  process.exit(0);
}

// ---------- confere o catálogo ----------
const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
let failures = 0;
const fail = m => { failures++; console.log('FALHA ' + m); };
const match = (entry, x) => entry.passe === x.passe && (!entry.entidades || entry.entidades.includes(x.entity)) && entry.campos.some(c => { const [scope, f] = c.split(':'); return scope === x.scope && (f.endsWith('*') ? x.field.startsWith(f.slice(0, -1)) : f === general(x.field)); });
const counts = new Map(catalog.entradas.map(e => [e.id, {}]));
const unmatched = [];
for (const x of observed) {
  const e = catalog.entradas.find(en => match(en, x));
  if (!e) { unmatched.push(x); continue; }
  counts.get(e.id)[x.dataset] = (counts.get(e.id)[x.dataset] || 0) + 1;
}
for (const x of unmatched.slice(0, 15)) fail(`divergência não catalogada [${x.passe}] ${x.dataset} ${x.scope} ${x.entity} ${x.field}: atual=${JSON.stringify(x.w)} referência=${JSON.stringify(x.r)}`);
if (unmatched.length > 15) fail(`... e mais ${unmatched.length - 15} divergências não catalogadas`);
for (const e of catalog.entradas) {
  const got = counts.get(e.id);
  for (const ds of new Set([...Object.keys(got), ...Object.keys(e.contagem)])) {
    if ((got[ds] || 0) !== (e.contagem[ds] || 0)) fail(`${e.id} em ${ds}: catálogo diz ${e.contagem[ds] || 0}, observado ${got[ds] || 0}`);
  }
}
if (!totalCompared) fail('nenhum campo foi comparado');
for (const e of catalog.entradas) console.log(`${e.passe} ${e.classe.padEnd(17)} ${e.id.padEnd(34)} ${Object.values(counts.get(e.id)).reduce((a, b) => a + b, 0)} casos  [${e.estado}]`);
console.log(failures ? `\n${failures} FALHA(S) NA PARIDADE` : `\nPARIDADE OK: ${totalCompared} campos comparados; todas as divergências estão catalogadas e confirmadas`);
process.exit(failures ? 1 : 0);
