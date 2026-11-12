// Anonimização de uma cópia do banco para uso em staging. Regra FECHADA: toda tabela e toda coluna precisam de uma
// regra explícita abaixo; coluna ou tabela sem regra faz a operação falhar (uma coluna nova nunca vaza por omissão).
//
// O que se preserva: IDs (UUIDs aleatórios, sem informação pessoal), relações, quantidades, datas de aula/início/
// graduação, faixas, graus, presenças, avaliações, critérios e estados. Isso mantém o comportamento dos cálculos.
// O que sai: nomes, e-mails, telefones, apelidos, peso, objetivos, observações, títulos de aula, detalhes de eventos,
// hashes de senha, sessões, tentativas de login (IPs), códigos de recuperação e o código de configuração inicial.
// Data de nascimento é GENERALIZADA para 1º de julho do mesmo ano: mantém a faixa etária (infantil/adulto) com erro
// de no máximo 1 ano e mantém "sem data" como sem data. Nomes viram "Aluno N"/"Equipe N" pela ordem do ID (UUID
// aleatório), então não há como voltar ao nome real a partir do anonimizado.
export class AnonymizationError extends Error { constructor(m) { super(m); this.name = 'AnonymizationError'; } }

const ord = (table) => `(SELECT n FROM (SELECT id, row_number() OVER (ORDER BY id) n FROM ${table}) x WHERE x.id = ${table}.id)`;
const ifSet = (col, v) => `CASE WHEN ${col} IS NULL OR ${col} = '' THEN ${col} ELSE ${v} END`;
const REDACTED = "'[anonimizado]'";

// table -> { drop: true } | { columns: { col: 'keep' | SQL-expression } , rows?: SQL-filter-to-delete }
export const RULES = {
  staff: { columns: {
    id: 'keep', name: `'Equipe ' || ${ord('staff')}`, email: `'equipe-' || ${ord('staff')} || '@exemplo.invalid'`,
    pass_hash: "'anonimizado'", pass_salt: "'anonimizado'", role: 'keep', belt: 'keep', active: 'keep', created_at: 'keep' } },
  auth_sessions: { drop: true },
  login_attempts: { drop: true },
  password_resets: { drop: true },
  audit_log: { columns: { id: 'keep', at: 'keep', event: 'keep', staff_id: 'keep', detail: 'NULL' } },
  settings: { columns: { key: 'keep', value: "CASE key WHEN 'academy_name' THEN 'Academia de Teste (anonimizada)' ELSE value END" },
    deleteWhere: "key = 'setup_token'", allowedKeys: ['academy_name', 'setup_done', 'setup_token'] },
  students: { columns: {
    id: 'keep', name: `'Aluno ' || ${ord('students')}`, nickname: 'NULL', birth_date: "CASE WHEN birth_date IS NULL THEN NULL ELSE substr(birth_date, 1, 4) || '-07-01' END",
    sex: 'keep', phone: 'NULL', email: 'NULL', start_date: 'keep', prior_months: 'keep', belt: 'keep', degrees: 'keep', belt_since: 'keep', degree_since: 'keep',
    imported_classes_belt: 'keep', imported_classes_degree: 'keep', weight_kg: 'NULL', status: 'keep', goals: 'NULL', notes: ifSet('notes', REDACTED), created_at: 'keep', updated_at: 'keep' } },
  classes: { columns: { id: 'keep', name: 'keep', weekday: 'keep', start_time: 'keep', end_time: 'keep', level: 'keep', modality: 'keep', instructor_id: 'keep', active: 'keep', created_at: 'keep' } },
  lessons: { columns: { id: 'keep', class_id: 'keep', date: 'keep', start_time: 'keep', end_time: 'keep', modality: 'keep', title: ifSet('title', "'Aula'"), notes: ifSet('notes', REDACTED),
    instructor_id: 'keep', created_by: 'keep', created_at: 'keep', roll_called: 'keep' } },
  attendance: { columns: { lesson_id: 'keep', student_id: 'keep' } },
  techniques: { columns: { id: 'keep', name: 'keep', category: 'keep', min_belt: 'keep', difficulty: 'keep', description: 'keep', active: 'keep' } },
  lesson_techniques: { columns: { lesson_id: 'keep', technique_id: 'keep' } },
  skills: { columns: { student_id: 'keep', technique_id: 'keep', level: 'keep', note: ifSet('note', REDACTED), updated_at: 'keep', updated_by: 'keep' } },
  skill_history: { columns: { id: 'keep', student_id: 'keep', technique_id: 'keep', level: 'keep', at: 'keep', staff_id: 'keep' } },
  promotions: { columns: { id: 'keep', student_id: 'keep', kind: 'keep', from_belt: 'keep', from_degrees: 'keep', to_belt: 'keep', to_degrees: 'keep', from_belt_since: 'keep',
    from_degree_since: 'keep', from_imported_belt: 'keep', from_imported_degree: 'keep', date: 'keep', criteria_met: 'keep', notes: ifSet('notes', REDACTED), staff_id: 'keep', created_at: 'keep' } },
  rules: { columns: { belt: 'keep', degree_months: 'keep', degree_classes: 'keep', belt_months: 'keep', belt_classes: 'keep', curriculum_pct: 'keep', next_min_age: 'keep' } },
  d1_migrations: { columns: { id: 'keep', name: 'keep', applied_at: 'keep' } }
};

// Valores pessoais originais (para provar depois que nenhum sobrou). Ficam só em memória.
function sensitiveValues(db, tables) {
  const vals = new Set();
  const grab = (t, cols) => { if (!tables.includes(t)) return; for (const r of db.prepare(`SELECT ${cols.join(',')} FROM ${t}`).all()) for (const c of cols) { const v = r[c]; if (typeof v === 'string' && v.trim().length >= 4) vals.add(v.trim()); } };
  grab('staff', ['name', 'email', 'pass_hash', 'pass_salt']);
  grab('students', ['name', 'nickname', 'phone', 'email', 'goals', 'notes']);
  grab('lessons', ['title', 'notes']); grab('promotions', ['notes']); grab('skills', ['note']); grab('audit_log', ['detail']);
  grab('auth_sessions', ['token_hash']); grab('password_resets', ['code_hash']); grab('login_attempts', ['key']);
  if (tables.includes('settings')) for (const r of db.prepare("SELECT value FROM settings WHERE key IN ('academy_name', 'setup_token')").all()) if (r.value && r.value.length >= 4) vals.add(r.value);
  return vals;
}

// Anonimiza o banco aberto (cópia temporária) no lugar. Devolve um resumo sem valores.
export function anonymize(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all().map(r => r.name);
  const problems = [];
  for (const t of tables) {
    const rule = RULES[t];
    if (!rule) { problems.push(`tabela sem regra de anonimização: ${t}`); continue; }
    if (rule.drop) continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    for (const c of cols) if (!(c in rule.columns)) problems.push(`coluna sem regra de anonimização: ${t}.${c}`);
    if (rule.allowedKeys) { const extra = db.prepare(`SELECT key FROM ${t}`).all().map(r => r.key).filter(k => !rule.allowedKeys.includes(k)); if (extra.length) problems.push(`chaves de ${t} sem regra: ${extra.length}`); }
  }
  if (problems.length) throw new AnonymizationError('Anonimização recusada (regra fechada): ' + problems.join('; '));
  const before = sensitiveValues(db, tables);
  const summary = {};
  db.exec('BEGIN');
  try {
    for (const t of tables) {
      const rule = RULES[t];
      if (rule.drop) { summary[t] = 'linhas removidas'; db.exec(`DELETE FROM "${t}"`); continue; }
      if (rule.deleteWhere) db.exec(`DELETE FROM "${t}" WHERE ${rule.deleteWhere}`);
      const sets = Object.entries(rule.columns).filter(([, e]) => e !== 'keep').map(([c, e]) => `"${c}" = ${e}`);
      if (sets.length) db.exec(`UPDATE "${t}" SET ${sets.join(', ')}`);
      summary[t] = sets.length ? `colunas tratadas: ${Object.entries(rule.columns).filter(([, e]) => e !== 'keep').map(([c]) => c).join(', ')}` : 'mantida';
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { summary, sensitive: before };
}

// Prova de que nenhum valor pessoal original aparece no SQL anonimizado. Devolve só a quantidade de vazamentos.
export function leakCount(sqlText, sensitive) {
  let n = 0;
  for (const v of sensitive) if (sqlText.includes(v) || sqlText.includes(v.replace(/'/g, "''"))) n++;
  return n;
}

// Relatório de vazamento: quantidade e onde (sem os valores).
export function leakReport(sqlText, sensitive) { const n = leakCount(sqlText, sensitive); return { count: n, where: n ? ['conteúdo'] : [] }; }
