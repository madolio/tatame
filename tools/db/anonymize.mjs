// Pseudonimização de uma cópia do banco para uso em staging. Regra FECHADA: toda tabela e toda coluna precisam de
// uma regra explícita abaixo; coluna ou tabela sem regra faz a operação falhar (uma coluna nova nunca vaza por omissão).
//
// NÃO é anonimização absoluta. Ficam quase-identificadores necessários ao comportamento dos cálculos: datas de início,
// de faixa/grau, de aulas e graduações, presenças (padrão de frequência), faixa/grau, ano de nascimento e status.
// Alguém que conheça a academia pode reconhecer uma pessoa por esses dados. Por isso a cópia continua criptografada,
// continua tratada como dado pessoal e serve só para ensaio técnico (ver docs/operacao-banco.md).
//
// Preservados: IDs (UUIDs aleatórios), relações, quantidades, faixas, graus, datas de início/aulas/graduações,
// presenças, avaliações, critérios, estados e o created_at de aulas e graduações (define a janela em que o professor
// pode editar/apagar o que registrou; mudá-lo alteraria o comportamento no staging).
// Removidos/substituídos: nomes, e-mails, telefones, apelidos, sexo, peso, objetivos, observações, títulos de aula,
// detalhes de eventos, hashes de senha, sessões, tentativas de login (IPs), códigos de recuperação, código de
// configuração e nome da academia. Generalizados: nascimento (1º de julho do mesmo ano; erro de até 1 ano na idade)
// e created_at/updated_at de alunos e equipe (só a data; não entram em cálculo nenhum).
// Nomes viram "Aluno N"/"Equipe N" pela ordem do ID (aleatório): não há como voltar ao nome real a partir deles.
export class AnonymizationError extends Error { constructor(m) { super(m); this.name = 'AnonymizationError'; } }

const ord = (table) => `(SELECT n FROM (SELECT id, row_number() OVER (ORDER BY id) n FROM ${table}) x WHERE x.id = ${table}.id)`;
const ifSet = (col, v) => `CASE WHEN ${col} IS NULL OR ${col} = '' THEN ${col} ELSE ${v} END`;
const dayOnly = col => `CASE WHEN ${col} IS NULL THEN NULL ELSE substr(${col}, 1, 10) || 'T00:00:00.000Z' END`;
const REDACTED = "'[anonimizado]'";

// table -> { drop: true } | { columns: { col: 'keep' | 'scan' | expressão SQL } }
//   keep = mantido sem texto livre pessoal esperado; scan = mantido, MAS é texto livre de configuração e passa pela
//   varredura de vazamento (nomes/apelidos/e-mails/telefones encontrados ali fazem a operação falhar).
export const RULES = {
  staff: { columns: {
    id: 'keep', name: `'Equipe ' || ${ord('staff')}`, email: `'equipe-' || ${ord('staff')} || '@exemplo.invalid'`,
    pass_hash: "'anonimizado'", pass_salt: "'anonimizado'", role: 'keep', belt: 'keep', active: 'keep', created_at: dayOnly('created_at') } },
  auth_sessions: { drop: true },
  login_attempts: { drop: true },
  password_resets: { drop: true },
  audit_log: { columns: { id: 'keep', at: 'keep', event: 'keep', staff_id: 'keep', detail: 'NULL' } },
  settings: { columns: { key: 'keep', value: "CASE key WHEN 'academy_name' THEN 'Academia de Teste (anonimizada)' ELSE value END" },
    deleteWhere: "key IN ('setup_token', 'setup_token_hash', 'setup_token_expires')", allowedKeys: ['academy_name', 'setup_done', 'setup_token', 'setup_token_hash', 'setup_token_expires'] },
  students: { columns: {
    id: 'keep', name: `'Aluno ' || ${ord('students')}`, nickname: 'NULL', birth_date: "CASE WHEN birth_date IS NULL THEN NULL ELSE substr(birth_date, 1, 4) || '-07-01' END",
    sex: 'NULL', phone: 'NULL', email: 'NULL', start_date: 'keep', prior_months: 'keep', belt: 'keep', degrees: 'keep', belt_since: 'keep', degree_since: 'keep',
    imported_classes_belt: 'keep', imported_classes_degree: 'keep', weight_kg: 'NULL', status: 'keep', goals: 'NULL', notes: ifSet('notes', REDACTED),
    created_at: dayOnly('created_at'), updated_at: dayOnly('updated_at') } },
  classes: { columns: { id: 'keep', name: 'scan', weekday: 'keep', start_time: 'keep', end_time: 'keep', level: 'keep', modality: 'keep', instructor_id: 'keep', active: 'keep', created_at: 'keep' } },
  lessons: { columns: { id: 'keep', class_id: 'keep', date: 'keep', start_time: 'keep', end_time: 'keep', modality: 'keep', title: ifSet('title', "'Aula'"), notes: ifSet('notes', REDACTED),
    instructor_id: 'keep', created_by: 'keep', created_at: 'keep', roll_called: 'keep' } },
  attendance: { columns: { lesson_id: 'keep', student_id: 'keep' } },
  techniques: { columns: { id: 'keep', name: 'scan', category: 'keep', min_belt: 'keep', difficulty: 'keep', description: 'scan', active: 'keep' } },
  lesson_techniques: { columns: { lesson_id: 'keep', technique_id: 'keep' } },
  skills: { columns: { student_id: 'keep', technique_id: 'keep', level: 'keep', note: ifSet('note', REDACTED), updated_at: 'keep', updated_by: 'keep' } },
  skill_history: { columns: { id: 'keep', student_id: 'keep', technique_id: 'keep', level: 'keep', at: 'keep', staff_id: 'keep' } },
  promotions: { columns: { id: 'keep', student_id: 'keep', kind: 'keep', from_belt: 'keep', from_degrees: 'keep', to_belt: 'keep', to_degrees: 'keep', from_belt_since: 'keep',
    from_degree_since: 'keep', from_imported_belt: 'keep', from_imported_degree: 'keep', date: 'keep', criteria_met: 'keep', notes: ifSet('notes', REDACTED), staff_id: 'keep', created_at: 'keep' } },
  rules: { columns: { belt: 'keep', degree_months: 'keep', degree_classes: 'keep', belt_months: 'keep', belt_classes: 'keep', curriculum_pct: 'keep', next_min_age: 'keep' } },
  d1_migrations: { columns: { id: 'keep', name: 'keep', applied_at: 'keep' } }
};

const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const tokens = s => norm(s).split(/[^a-z0-9@._+-]+/).filter(Boolean);

// Valores pessoais originais (só em memória, nunca impressos). long: 4+ caracteres (procurados como trecho);
// short: 2–3 caracteres de nomes/apelidos (procurados como palavra inteira, para "Ana" não casar com "Americana").
function sensitiveValues(db, tables) {
  const long = new Set(), short = new Set();
  const add = (v, nameLike) => {
    if (typeof v !== 'string') return;
    const n = norm(v); if (!n) return;
    if (n.length >= 4) long.add(n);
    if (nameLike) for (const t of tokens(v)) { if (t.length >= 4) long.add(t); else if (t.length >= 2 && !/^\d+$/.test(t)) short.add(t); }
  };
  const grab = (t, cols, nameCols = []) => { if (!tables.includes(t)) return; for (const r of db.prepare(`SELECT ${cols.join(',')} FROM ${t}`).all()) for (const c of cols) add(r[c], nameCols.includes(c)); };
  grab('staff', ['name', 'email', 'pass_hash', 'pass_salt'], ['name']);
  grab('students', ['name', 'nickname', 'phone', 'email', 'goals', 'notes'], ['name', 'nickname']);
  grab('lessons', ['title', 'notes']); grab('promotions', ['notes']); grab('skills', ['note']); grab('audit_log', ['detail']);
  grab('auth_sessions', ['token_hash']); grab('password_resets', ['code_hash']); grab('login_attempts', ['key']);
  if (tables.includes('settings')) for (const r of db.prepare("SELECT value FROM settings WHERE key IN ('academy_name', 'setup_token')").all()) add(r.value, false);
  // Partes de nomes muito comuns ("da", "de", "dos") não identificam ninguém e gerariam falso positivo.
  for (const w of ['da', 'de', 'do', 'das', 'dos', 'e']) short.delete(w);
  return { long, short };
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
    if (rule.allowedKeys) { const extra = db.prepare(`SELECT key FROM ${t}`).all().map(r => r.key).filter(k => !rule.allowedKeys.includes(k)); if (extra.length) problems.push(`${extra.length} chave(s) de ${t} sem regra`); }
  }
  if (problems.length) throw new AnonymizationError('Anonimização recusada (regra fechada): ' + problems.join('; '));
  const sensitive = sensitiveValues(db, tables);
  const summary = {};
  db.exec('BEGIN');
  try {
    for (const t of tables) {
      const rule = RULES[t];
      if (rule.drop) { summary[t] = 'linhas removidas'; db.exec(`DELETE FROM "${t}"`); continue; }
      if (rule.deleteWhere) db.exec(`DELETE FROM "${t}" WHERE ${rule.deleteWhere}`);
      const changed = Object.entries(rule.columns).filter(([, e]) => e !== 'keep' && e !== 'scan');
      if (changed.length) db.exec(`UPDATE "${t}" SET ${changed.map(([c, e]) => `"${c}" = ${e}`).join(', ')}`);
      const scanned = Object.entries(rule.columns).filter(([, e]) => e === 'scan').map(([c]) => c);
      summary[t] = [changed.length ? `tratadas: ${changed.map(([c]) => c).join(', ')}` : '', scanned.length ? `mantidas com varredura: ${scanned.join(', ')}` : ''].filter(Boolean).join('; ') || 'mantida';
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { summary, sensitive };
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?\d[\s().-]?){8,}/;
const ALLOWED_EMAIL = /@exemplo\.invalid$/i;

// Varredura do banco JÁ anonimizado, célula por célula, em toda coluna que NÃO é 'keep': as substituídas (prova de
// que a substituição funcionou) e as 'scan' (texto livre de configuração mantido). Colunas 'keep' são, por revisão
// coluna a coluna em RULES, IDs, datas, números ou enumerações com CHECK: não guardam texto livre, e varrê-las daria
// falso positivo (ex.: alguém chamado "Admin" × papel "admin"). Tabela/coluna sem regra nunca chega aqui (anonymize recusa).
// Devolve só a quantidade e onde (tabela.coluna), nunca o valor.
export function leakReport(db, sensitive) {
  const hits = new Map();
  const hit = (where, why) => hits.set(`${where} (${why})`, (hits.get(`${where} (${why})`) || 0) + 1);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all().map(r => r.name);
  for (const t of tables) {
    const rule = RULES[t] || {};
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    for (const c of cols) {
      if (!rule.columns || rule.columns[c] === 'keep') continue;
      const free = rule.columns[c] === 'scan';
      for (const { v } of db.prepare(`SELECT "${c}" AS v FROM "${t}" WHERE typeof("${c}") = 'text'`).all()) {
        const n = norm(v);
        if (!n) continue;
        for (const s of sensitive.long) if (n.includes(s)) { hit(`${t}.${c}`, 'valor pessoal original'); break; }
        const tk = new Set(tokens(v));
        for (const s of sensitive.short) if (tk.has(s)) { hit(`${t}.${c}`, 'nome/apelido curto original'); break; }
        if (free) {
          const e = n.match(EMAIL); if (e && !ALLOWED_EMAIL.test(e[0])) hit(`${t}.${c}`, 'e-mail em campo livre');
          if (PHONE.test(n)) hit(`${t}.${c}`, 'telefone em campo livre');
        }
      }
    }
  }
  return { count: [...hits.values()].reduce((a, b) => a + b, 0), where: [...hits.keys()] };
}
