// Gera uma academia fictícia (via API real, sobre D1 local) e exporta como SQL para o D1 de produção.
// Tudo marcado com notes = '[teste]' para poder apagar depois.
import fs from 'node:fs';
import { makeD1 } from './d1shim.mjs';
const W = (await import('../web/_worker.js')).default;
const ROOT = new URL('..', import.meta.url).pathname;
const DB = makeD1(); DB.load(ROOT + 'db/schema.sql'); DB.load(ROOT + 'db/seed_tecnicas.sql');
const env = { DB, ASSETS: { fetch: () => new Response('') } };
let cookie = '';
const api = async (method, p, body) => {
  const r = await W.fetch(new Request('https://t.test' + p, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie }, body: body ? JSON.stringify(body) : undefined }), env);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + JSON.stringify(j)); return j;
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);
let seed = 42; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const phone = () => '11 9' + String(Math.floor(rnd() * 1e8)).padStart(8, '0');

await api('POST', '/api/setup', { academy_name: 'tmp', name: 'Gerador', email: 'gen@x.com', password: 'gerador123' });
const T = '[teste]';
const wdToday = new Date(today + 'T12:00:00Z').getUTCDay();
const grade = [
  ['Fundamentos', 1, '07:00', '08:00', 'iniciante', 'gi'], ['Fundamentos', 1, '19:00', '20:00', 'iniciante', 'gi'], ['Avançada', 1, '20:00', '21:30', 'avancado', 'gi'],
  ['No-gi', 2, '19:30', '21:00', 'todos', 'nogi'], ['Fundamentos', 3, '07:00', '08:00', 'iniciante', 'gi'], ['Fundamentos', 3, '19:00', '20:00', 'iniciante', 'gi'],
  ['Avançada', 3, '20:00', '21:30', 'avancado', 'gi'], ['Kids', 4, '18:00', '18:50', 'kids', 'gi'], ['No-gi', 4, '19:30', '21:00', 'todos', 'nogi'],
  ['Todos os níveis', 5, '19:00', '20:30', 'todos', 'gi'], ['Competição', 5, '20:30', '22:00', 'competicao', 'gi'], ['Open mat', 6, '10:00', '12:00', 'todos', 'livre'], ['Kids', 2, '18:00', '18:50', 'kids', 'gi']
];
const classes = [];
for (const [name, wd, st, en, level, modality] of grade) classes.push(await api('POST', '/api/classes', { name, weekday: wd, start_time: st, end_time: en, level, modality }));

// [nome, apelido, faixa, graus, dias na faixa, dias desde grau, nascimento, frequência(0-1), perfil, aulas antes do sistema (faixa, grau), situação]
const P = [
  ['Ana Clara Lima', 'Aninha', 'branca', 4, 420, 110, '1997-04-10', 0.85, 'adulto', 110, 35, 'ativo'],
  ['Bruno Costa', null, 'branca', 2, 160, 70, '2001-08-21', 0.7, 'adulto', 20, 10, 'ativo'],
  ['Caio Mendes', null, 'branca', 0, 35, 35, '2003-01-02', 0.6, 'adulto', 0, 0, 'ativo'],
  ['Daniela Rocha', 'Dani', 'azul', 3, 780, 190, '1995-11-30', 0.75, 'adulto', 140, 30, 'ativo'],
  ['Eduardo Pires', 'Dudu', 'azul', 1, 320, 200, '1992-06-15', 0.5, 'adulto', 40, 25, 'ativo'],
  ['Fernanda Alves', 'Fê', 'roxa', 2, 520, 150, '1990-02-03', 0.85, 'adulto', 60, 20, 'ativo'],
  ['Gabriel Nunes', null, 'marrom', 1, 260, 250, '1988-09-09', 0.45, 'adulto', 20, 20, 'ativo'],
  ['Helena Dias', null, 'branca', 1, 95, 95, '2000-12-12', 0.12, 'adulto', 0, 0, 'ativo'],
  ['Igor Teixeira', null, 'azul', 0, 70, 70, '1999-03-03', 0.75, 'adulto', 0, 0, 'ativo'],
  ['João Pedro Souza', 'JP', 'cinza', 2, 210, 120, ago(365 * 10 + 40), 0.7, 'kids', 30, 10, 'ativo'],
  ['Lucas Martins', null, 'branca', 3, 230, 115, '1998-07-07', 0.0, 'adulto', 40, 15, 'ativo'],
  ['Marina Couto', 'Mari', 'branca', 1, 60, 60, '2002-05-19', 0.8, 'adulto', 0, 0, 'ativo'],
  ['Nicolas Ferreira', null, 'amarela', 1, 150, 70, ago(365 * 8 + 100), 0.65, 'kids', 10, 5, 'ativo'],
  ['Otávio Ramos', 'Tavinho', 'preta', 2, 1500, 600, '1985-01-20', 0.6, 'adulto', 0, 0, 'ativo'],
  ['Paula Santos', null, 'azul', 2, 400, 160, '1996-10-08', 0.3, 'adulto', 30, 10, 'ativo'],
  ['Rafael Gomes', 'Rafa', 'roxa', 0, 90, 90, '1993-08-28', 0.8, 'adulto', 0, 0, 'ativo'],
  ['Sofia Barros', null, 'cinza', 0, 40, 40, ago(365 * 6 + 10), 0.55, 'kids', 0, 0, 'ativo'],
  ['Thiago Moreira', null, 'branca', 4, 380, 140, '1994-03-15', 0.65, 'adulto', 80, 30, 'ativo'],
  ['Vinícius Lopes', 'Vini', 'azul', 4, 760, 130, '1991-12-01', 0.55, 'adulto', 200, 45, 'ativo'],
  ['William Duarte', null, 'branca', 0, 20, 20, '2004-06-06', 0.9, 'adulto', 0, 0, 'ativo'],
  ['Yasmin Freitas', null, 'branca', 2, 200, 100, '1999-09-17', 0.0, 'adulto', 10, 5, 'trancado'],
  ['Zeca Almeida', null, 'azul', 1, 300, 180, '1987-02-27', 0.0, 'adulto', 20, 10, 'inativo']
];
const ids = [];
for (const [name, nick, belt, degrees, bd, dd, birth, , , ib, idg, status] of P) {
  const r = await api('POST', '/api/students', { name, nickname: nick, belt, degrees, birth_date: birth, start_date: ago(Math.max(bd, 20) + Math.round(rnd() * 400)), belt_since: ago(bd), degree_since: ago(Math.min(dd, bd)),
    phone: phone(), weight_kg: Math.round(55 + rnd() * 40), status, prior_months: belt === 'preta' ? 120 : 0, imported_classes_belt: ib, imported_classes_degree: idg, notes: T,
    goals: ['Competir', 'Defesa pessoal', 'Condicionamento', 'Hobby e saúde'][Math.floor(rnd() * 4)] });
  ids.push(r.student.id);
}
const techs = (await api('GET', '/api/state')).techniques;
const byBelt = b => techs.filter(t => t.min_belt === b);
const titles = { Fundamentos: 'Fundamentos e movimentação', Quedas: 'Quedas e projeções', Guarda: 'Trabalho de guarda', Raspagens: 'Raspagens', Passagens: 'Passagem de guarda', Controle: 'Controle e transições', Costas: 'Pegada das costas', 'Finalizações': 'Finalizações', 'Defesas e saídas': 'Defesas e saídas' };
// 12 semanas de aulas (hoje fica livre para você testar a chamada)
for (let d = 84; d >= 1; d--) {
  const date = ago(d), wd = new Date(date + 'T12:00:00Z').getUTCDay();
  for (const c of classes.filter(c => c.weekday === wd)) {
    const present = ids.filter((id, i) => {
      const p = P[i]; if (p[11] !== 'ativo' && d < 40) return false;
      const kid = p[8] === 'kids'; if ((c.level === 'kids') !== kid) return false;
      if (p[10] === 'Lucas Martins' && d < 25) return false;
      let f = p[7] * 0.55; if (p[0] === 'Lucas Martins') f = d > 25 ? 0.4 : 0;
      if (p[0] === 'Yasmin Freitas' || p[0] === 'Zeca Almeida') f = d > 45 ? 0.35 : 0;
      if (c.level === 'avancado' && ['branca', 'cinza'].includes(p[2])) f *= 0.15;
      if (c.level === 'competicao' && !['azul', 'roxa', 'marrom', 'preta'].includes(p[2])) f *= 0.1;
      if (c.start_time === '07:00') f *= 0.5;
      return rnd() < f;
    });
    if (!present.length) continue;
    const pool = c.level === 'avancado' || c.level === 'competicao' ? [...byBelt('azul'), ...byBelt('roxa')] : byBelt('branca');
    const tset = pool.sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 2)).map(t => t.id);
    await api('POST', '/api/lessons', { class_id: c.id, date, student_ids: present, technique_ids: tset, title: titles[techs.find(t => t.id === tset[0]).category], notes: T });
  }
}
// Avaliações de técnicas (nível 0–5) coerentes com a faixa
const rank = { branca: 0, cinza: 0, amarela: 0, laranja: 0, verde: 0, azul: 1, roxa: 2, marrom: 3, preta: 4 };
const R = ['branca', 'azul', 'roxa', 'marrom', 'preta'];
for (const [i, p] of P.entries()) {
  const r = rank[p[2]], items = [];
  for (const t of techs) {
    const tr = R.indexOf(t.min_belt); if (tr > r) continue;
    let base = (r - tr) * 1.2 + 1 + p[3] * 0.35 + (p[0] === 'Ana Clara Lima' ? 1.6 : 0) + (p[0] === 'Vinícius Lopes' ? 1.3 : 0) + (p[0] === 'Thiago Moreira' ? 0.4 : 0);
    let lv = Math.round(base + (rnd() - 0.5) * 1.6 - t.difficulty * 0.25);
    if (p[3] === 0 && r === 0 && rnd() < 0.5) continue; // iniciantes: só parte avaliada
    items.push({ technique_id: t.id, level: Math.max(0, Math.min(5, lv)) });
  }
  if (items.length) await api('PUT', `/api/students/${ids[i]}/skills`, { items });
}
// Histórico de graduações recentes (registrado no app)
const promo = async (name, kind, to_belt, days) => {
  const id = ids[P.findIndex(p => p[0] === name)];
  // volta o aluno ao estado anterior para registrar a graduação na data certa
  await api('POST', `/api/students/${id}/promote`, { kind, to_belt, date: ago(days), notes: kind === 'faixa' ? 'Exame de faixa' : 'Graduação de fim de mês', override: true });
};
for (const [name, kind, belt, days] of [['William Duarte', 'grau', null, 3], ['Igor Teixeira', 'grau', null, 10], ['Rafael Gomes', 'grau', null, 12]]) {
  try { await promo(name, kind, belt, days); } catch (e) { console.error('promo', name, e.message); }
}
// Exporta SQL (sem a equipe do gerador)
const q = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const dump = (table, nullCols = []) => {
  const rows = DB.raw.prepare(`SELECT * FROM ${table}`).all();
  return rows.map(r => { for (const c of nullCols) if (c in r) r[c] = null; const cols = Object.keys(r); return `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => q(r[c])).join(',')});`; });
};
const out = [
  ...dump('students'), ...dump('classes', ['instructor_id']), ...dump('lessons', ['instructor_id', 'created_by']), ...dump('attendance'), ...dump('lesson_techniques'),
  ...dump('skills', ['updated_by']), ...dump('skill_history', ['staff_id']).map(s => s.replace(/INSERT INTO skill_history \(id,/, 'INSERT INTO skill_history (').replace(/VALUES \(\d+,/, 'VALUES (')), ...dump('promotions', ['staff_id'])
];
fs.writeFileSync('/home/claude/tatame/fake_data.sql', out.join('\n') + '\n');
const st = (await api('GET', '/api/state')).dashboard;
console.log('linhas SQL:', out.length, '| bytes:', fs.statSync('/home/claude/tatame/fake_data.sql').size);
console.log('kpis:', JSON.stringify(st.kpis), '| aptos:', st.ready_list.length, '| quase:', st.near_list.length, '| risco:', st.risk_list.length);
for (const t of ['students', 'classes', 'lessons', 'attendance', 'skills', 'promotions']) console.log(t, DB.raw.prepare(`select count(*) n from ${t}`).get().n);
