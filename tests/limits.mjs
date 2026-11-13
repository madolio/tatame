// Etapa 6.2 (V4): limites operacionais e gravação em conjunto (json_each). Prova: limites exatos (máximo aceito, máximo+1),
// corpo grande, listas vazias/repetidas/inexistentes, nada gravado pela metade, número de comandos constante e
// resultado idêntico ao método antigo (1 comando por item).
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const DB = makeD1();
DB.load(fileURLToPath(new URL('../db/schema.sql', import.meta.url))); DB.load(fileURLToPath(new URL('../db/seed_tecnicas.sql', import.meta.url)));
let q = 0, batches = 0; const p0 = DB.prepare, b0 = DB.batch;
DB.prepare = sql => { q++; return p0(sql); };
DB.batch = s => { batches++; return b0.call(DB, s); };
const env = { DB, ASSETS: { fetch: () => new Response('') } };
const call = async (ck, method, path, body, { raw } = {}) => {
  const r = await W.fetch(new Request('https://t.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie: ck || '' }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);
const n = sql => DB.raw.prepare(sql).get().n;
// conta só o que a ROTA faz: zera depois da autenticação não dá para separar, então mede a requisição inteira
const measure = async (...a) => { q = 0; batches = 0; const r = await call(...a); return { ...r, q, batches }; };

const code = generateCode(); DB.raw.exec(buildSetupSql(code));
const setup = await W.fetch(new Request('https://t.test/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tatame': '1' }, body: JSON.stringify({ academy_name: 'Academia', name: 'Admin', email: 'a@x.test', password: 'cordafina-71', setup_code: code }) }), env);
const admin = setup.headers.get('set-cookie').split(';')[0];
for (let i = 0; i < 301; i++) DB.raw.prepare('INSERT INTO students (id, name, start_date, belt_since, degree_since) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), 'Aluno ' + i, ago(100), ago(100), ago(100));
const S = DB.raw.prepare('SELECT id FROM students ORDER BY rowid').all().map(r => r.id);
const T = DB.raw.prepare('SELECT id FROM techniques ORDER BY id').all().map(r => r.id);
for (let i = 0; T.length < 101; i++) { DB.raw.prepare("INSERT INTO techniques (name, category, min_belt) VALUES (?, 'Guarda', 'branca')").run('Técnica extra ' + i); T.push(Number(DB.raw.prepare('SELECT max(id) n FROM techniques').get().n)); }
const lessonBody = (s, t, d = 2) => ({ date: ago(d), start_time: '06:00', end_time: '07:00', student_ids: s, technique_ids: t });

// ---------- chamada ----------
{ const before = n('SELECT count(*) n FROM lessons');
  const r = await measure(admin, 'POST', '/api/lessons', lessonBody(S.slice(0, 300), T.slice(0, 40)));
  ok(r.status === 201 && n(`SELECT count(*) n FROM attendance WHERE lesson_id = '${r.body.id}'`) === 300 && n(`SELECT count(*) n FROM lesson_techniques WHERE lesson_id = '${r.body.id}'`) === 40, 'chamada no limite (300 alunos x 40 técnicas): aceita, 300 presenças e 40 técnicas gravadas');
  ok(n(`SELECT count(*) n FROM skills WHERE technique_id IN (${T.slice(0, 40).join(',')}) AND level >= 1`) === 12000, 'as 12.000 combinações aluno x técnica ficaram "vistas em aula"');
  ok(r.batches === 1 && r.q <= 15, `chamada no limite: ${r.q} prepare() no total e 1 batch (antes: 12.347)`);
  const r1 = await measure(admin, 'POST', '/api/lessons', lessonBody(S.slice(0, 301), [], 3));
  const r2 = await measure(admin, 'POST', '/api/lessons', lessonBody([], T.slice(0, 41), 3));
  ok(r1.status === 400 && r2.status === 400 && r1.batches === 0 && r2.batches === 0 && n('SELECT count(*) n FROM lessons') === before + 1, 'limite + 1 (301 alunos, 41 técnicas): 400 sem nenhum batch');
  const fake = '00000000-0000-4000-8000-000000000000';
  const r3 = await measure(admin, 'POST', '/api/lessons', lessonBody([S[0], fake], [], 4));
  const r4 = await measure(admin, 'POST', '/api/lessons', lessonBody([S[0]], [T[0], 999999], 4));
  ok(r3.status === 400 && r4.status === 400 && r3.batches + r4.batches === 0 && n('SELECT count(*) n FROM lessons') === before + 1, 'aluno ou técnica inexistente na lista: 400, nada gravado');
  const r5 = await call(admin, 'POST', '/api/lessons', lessonBody([S[1], S[1], S[2]], [T[1], T[1]], 5));
  ok(r5.status === 201 && r5.body.student_ids.length === 2 && r5.body.technique_ids.length === 1, 'itens repetidos na chamada: contados uma vez (comportamento anterior preservado)'); }

// ---------- resultado idêntico ao método antigo ----------
{ const st = S.slice(10, 14), te = T.slice(50, 53);
  DB.raw.prepare('INSERT INTO skills (student_id, technique_id, level) VALUES (?, ?, 3)').run(st[0], te[0]);  // já sabe: não pode cair
  DB.raw.prepare('INSERT INTO skills (student_id, technique_id, level) VALUES (?, ?, 0)').run(st[1], te[1]);  // nível 0: sobe para 1
  const r = await call(admin, 'POST', '/api/lessons', lessonBody(st, te, 6));
  const lvl = (s, t) => DB.raw.prepare('SELECT level FROM skills WHERE student_id = ? AND technique_id = ?').get(s, t)?.level;
  ok(r.status === 201 && lvl(st[0], te[0]) === 3 && lvl(st[1], te[1]) === 1 && st.every(s => te.every(t => lvl(s, t) >= 1)), 'mesmo resultado do método antigo: todos "vistos em aula", ninguém rebaixado (nível 3 fica 3; nível 0 sobe para 1)');
  const upd = await measure(admin, 'PUT', '/api/lessons/' + r.body.id, lessonBody(st.slice(0, 2), te.slice(0, 1), 6));
  ok(upd.status === 200 && upd.body.student_ids.length === 2 && upd.body.technique_ids.length === 1 && upd.batches === 1, 'edição troca as listas inteiras num único batch'); }

// ---------- skills ----------
{ const sid = S[20], items = k => T.slice(0, k).map((t, i) => ({ technique_id: t, level: i % 6, note: i % 2 ? 'obs ' + i : null }));
  const r = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { items: items(100) });
  ok(r.status === 200 && n(`SELECT count(*) n FROM skills WHERE student_id = '${sid}'`) === 100 && n(`SELECT count(*) n FROM skill_history WHERE student_id = '${sid}'`) === 100, 'skills no limite (100 itens): aceito, 100 avaliações e 100 entradas no histórico');
  ok(DB.raw.prepare('SELECT level, note FROM skills WHERE student_id = ? AND technique_id = ?').get(sid, T[7]).level === 1 && DB.raw.prepare('SELECT note FROM skills WHERE student_id = ? AND technique_id = ?').get(sid, T[7]).note === 'obs 7' && DB.raw.prepare('SELECT note FROM skills WHERE student_id = ? AND technique_id = ?').get(sid, T[8]).note === null, 'nível e observação de cada item gravados exatamente (inclusive observação nula)');
  ok(r.batches === 1 && r.q <= 20, `skills com 100 itens: ${r.q} prepare() no total (antes: 225 para 70 itens), 1 batch de 2 comandos`);
  const one = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { technique_id: T[0], level: 5 });
  ok(one.status === 200 && DB.raw.prepare('SELECT level FROM skills WHERE student_id = ? AND technique_id = ?').get(sid, T[0]).level === 5, 'formato de 1 item (o que a tela usa) continua funcionando');
  const h0 = n(`SELECT count(*) n FROM skill_history WHERE student_id = '${sid}'`);
  const over = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { items: items(101) });
  const empty = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { items: [] });
  const dup = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { items: [{ technique_id: T[0], level: 1 }, { technique_id: T[0], level: 2 }] });
  const ghost = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { items: [{ technique_id: T[1], level: 4 }, { technique_id: 999999, level: 4 }] });
  const badLevel = await measure(admin, 'PUT', `/api/students/${sid}/skills`, { items: [{ technique_id: T[1], level: 4 }, { technique_id: T[2], level: 9 }] });
  ok(over.status === 400 && empty.status === 400 && dup.status === 400 && ghost.status === 400 && badLevel.status === 400, 'skills: 101 itens, lista vazia, técnica repetida, técnica inexistente e nível inválido no meio do lote: 400');
  ok([over, empty, dup, ghost, badLevel].every(x => x.batches === 0) && n(`SELECT count(*) n FROM skill_history WHERE student_id = '${sid}'`) === h0 && DB.raw.prepare('SELECT level FROM skills WHERE student_id = ? AND technique_id = ?').get(sid, T[1]).level === 1, 'lote com um item inválido: nada gravado (nenhum batch; o item válido do mesmo lote também não)'); }

// ---------- rules ----------
{ const belts = ['branca', 'cinza', 'amarela', 'laranja', 'verde', 'azul', 'roxa', 'marrom', 'preta'];
  const rule = b => ({ belt: b, degree_months: 4, degree_classes: 0, belt_months: 24, belt_classes: 200, curriculum_pct: 50, next_min_age: 16 });
  const r = await measure(admin, 'PUT', '/api/rules', { rules: belts.map(rule) });
  ok(r.status === 200 && r.batches === 1, 'rules no limite (9 faixas): aceito em 1 batch de 9 comandos');
  const snap = JSON.stringify(DB.raw.prepare('SELECT * FROM rules ORDER BY belt').all());
  const ten = await measure(admin, 'PUT', '/api/rules', { rules: [...belts, 'azul'].map(rule) });
  const dupl = await measure(admin, 'PUT', '/api/rules', { rules: [rule('azul'), { ...rule('azul'), degree_months: 99 }] });
  const none = await measure(admin, 'PUT', '/api/rules', { rules: [] });
  const notArr = await measure(admin, 'PUT', '/api/rules', { rules: { belt: 'azul' } });
  const badMid = await measure(admin, 'PUT', '/api/rules', { rules: [{ ...rule('azul'), degree_months: 1 }, { ...rule('roxa'), degree_months: -5 }] });
  ok([ten, dupl, none, notArr, badMid].every(x => x.status === 400 && x.batches === 0), 'rules: 10 itens, faixa repetida, lista vazia, objeto no lugar de lista e valor inválido no meio: 400 sem batch');
  ok(JSON.stringify(DB.raw.prepare('SELECT * FROM rules ORDER BY belt').all()) === snap, 'regras recusadas não alteram nada'); }

// ---------- corpo grande ----------
{ const big = JSON.stringify({ name: 'Aluno', notes: 'x'.repeat(300 * 1024) });
  const r = await measure(admin, 'POST', '/api/students', undefined, { raw: big });
  ok(r.status === 413 && r.batches === 0 && !JSON.stringify(r.body).includes('xxx'), 'corpo acima de 256 KB: 413, nada executado, resposta sem eco do conteúdo');
  const near = JSON.stringify({ items: T.slice(0, 100).map(t => ({ technique_id: t, level: 2, note: '𝄞'.repeat(150) })) });
  ok(new TextEncoder().encode(near).length < 256 * 1024 && (await call(admin, 'PUT', `/api/students/${S[30]}/skills`, undefined, { raw: near })).status === 200, `maior pedido legítimo (100 avaliações com observação longa multibyte, ${Math.round(new TextEncoder().encode(near).length / 1024)} KB): aceito`); }
console.log('\nLIMITES (V4) OK');
