// Compatibilidade de um banco restaurado com o Worker REAL (web/_worker.js), numa cópia em memória.
// 1. carrega o SQL num SQLite em memória (emulador de D1 de tests/d1shim.mjs);
// 2. se faltarem migrações, aplica as pendentes NA CÓPIA (prova que o backup é compatível com o Worker atual);
// 3. cria um acesso temporário de verificação (só na cópia) e chama GET /api/state;
// 4. confere contagens, indicadores do painel e dos alunos contra a referência independente da Etapa 4
//    (tests/ref/reference.mjs). Só números e contagens são relatados; nenhum dado pessoal é impresso.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { makeD1 } from '../../tests/d1shim.mjs';
import { computeReference } from '../../tests/ref/reference.mjs';
import { applyLocal } from './ops-migrate.mjs';
import { migrationFiles, expectedAfter, fingerprint, schemaRows, diffSchemas, MIGRATIONS_TABLE_DDL } from './schema.mjs';
import { analyze } from './dump.mjs';

const REF_TABLES = ['students', 'classes', 'lessons', 'attendance', 'lesson_techniques', 'techniques', 'skills', 'rules', 'promotions'];

export async function workerCheck(sqlText) {
  const DB = makeD1(':memory:');
  const problems = [], notes = [];
  try {
    DB.raw.exec('PRAGMA foreign_keys = OFF'); DB.raw.exec(sqlText); DB.raw.exec('PRAGMA foreign_keys = ON');
    let info = analyze(DB.raw);
    if (!info.migrations.length) {
      if (diffSchemas(expectedAfter(['000_base.sql']), fingerprint(schemaRows(DB.raw))).length) { problems.push('backup sem registro de migrações e com schema diferente de 000_base: não é possível prepará-lo para o Worker atual'); return { ok: false, problems, notes }; }
      DB.raw.exec(MIGRATIONS_TABLE_DDL + "\nINSERT INTO d1_migrations (name) values ('000_base.sql');");
      notes.push('backup sem registro de migrações, idêntico a 000_base: linha de base registrada só na cópia');
      info = analyze(DB.raw);
    }
    const pending = migrationFiles().filter(f => !info.migrations.includes(f));
    if (pending.length) { applyLocal({ exec: s => DB.raw.exec(s) }, pending, () => {}); notes.push(`migrações pendentes aplicadas na cópia: ${pending.join(', ')}`); }
    const W = (await import('../../web/_worker.js')).default;
    const env = { DB, ASSETS: { fetch: () => new Response('') } };
    const token = randomBytes(32).toString('hex'), staffId = randomUUID(); // mesmo formato dos tokens do Worker (64 hex)
    DB.raw.prepare("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES (?, 'Verificação de restauração', ?, 'x', 'x', 'admin')").run(staffId, `verificacao-${staffId}@exemplo.invalid`);
    DB.raw.prepare("INSERT INTO auth_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, '2999-01-01T00:00:00.000Z')").run(createHash('sha256').update(token).digest('hex'), staffId);
    const r = await W.fetch(new Request('https://restore-check.local/api/state', { headers: { cookie: `tatame_sid=${token}` } }), env);
    if (r.status !== 200) { problems.push(`GET /api/state respondeu ${r.status}`); return { ok: false, problems, notes }; }
    const st = await r.json();
    const count = sql => DB.raw.prepare(sql).get().n;
    const nStudents = count('SELECT count(*) n FROM students'), nActive = count("SELECT count(*) n FROM students WHERE status = 'ativo'");
    if (st.students.length !== nStudents) problems.push(`alunos na API (${st.students.length}) ≠ alunos no banco (${nStudents})`);
    if (st.dashboard.kpis.active_students !== nActive) problems.push(`painel: ativos ${st.dashboard.kpis.active_students} ≠ banco ${nActive}`);
    if (st.techniques.length !== count('SELECT count(*) n FROM techniques')) problems.push('técnicas na API ≠ banco');
    const bad = st.students.filter(s => !Number.isInteger(s.metrics.classes_total) || typeof s.metrics.ready !== 'boolean' || !(s.metrics.days_absent === null || Number.isInteger(s.metrics.days_absent)));
    if (bad.length) problems.push(`${bad.length} aluno(s) com indicadores inválidos`);
    // referência independente (Etapa 4) sobre os mesmos dados
    const data = Object.fromEntries(REF_TABLES.map(t => [t, DB.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(x => ({ ...x }))]));
    const ref = computeReference(data, st.today);
    let compared = 0, diverge = 0;
    const fields = ['classes_total', 'classes_last_30d', 'days_absent', 'at_risk', 'weekly_avg', 'ready', 'progress', 'classes_since_belt'];
    for (const s of st.students) {
      const rs = ref.students[s.id]; if (!rs) { diverge++; continue; }
      for (const f of fields) { compared++; if (JSON.stringify(s.metrics[f]) !== JSON.stringify(rs[f])) diverge++; }
      compared++; if (s.metrics.experience.score !== rs.experience.score) diverge++;
      compared++; if ((s.metrics.next?.to_belt ?? null) !== (rs.next?.to_belt ?? null)) diverge++;
    }
    for (const k of ['active_students', 'at_risk', 'ready', 'new_this_month', 'lessons_30d', 'avg_per_lesson_30d']) { compared++; if (st.dashboard.kpis[k] !== ref.dashboard.kpis[k]) diverge++; }
    if (diverge) problems.push(`${diverge} divergência(s) entre o Worker e a referência independente em ${compared} campos`);
    return { ok: problems.length === 0, problems, notes, stats: { students: nStudents, active: nActive, lessons: count('SELECT count(*) n FROM lessons'), compared_fields: compared, divergences: diverge } };
  } catch (e) {
    problems.push('erro ao validar com o Worker: ' + e.message);
    return { ok: false, problems, notes };
  } finally { DB.raw.close(); }
}
