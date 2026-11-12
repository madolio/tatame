// =====================================================================
// TATAME — API da academia (Cloudflare Pages, modo avançado) + banco D1 (binding "DB")
// Toda regra de negócio fica aqui: autenticação, permissões, validação, prontidão para
// graduação, nível de experiência, nível de aprendizado, frequência e indicadores.
// =====================================================================

const BELTS = ['branca', 'cinza', 'amarela', 'laranja', 'verde', 'azul', 'roxa', 'marrom', 'preta'];
const KIDS = ['branca', 'cinza', 'amarela', 'laranja', 'verde'];
const ADULT = ['branca', 'azul', 'roxa', 'marrom', 'preta'];
const CATEGORIES = ['Fundamentos', 'Quedas', 'Guarda', 'Raspagens', 'Passagens', 'Controle', 'Costas', 'Finalizações', 'Defesas e saídas'];
const KID_MIN_AGE = { cinza: 4, amarela: 7, laranja: 10, verde: 13 }; // IBJJF
// Sessão: vale 30 dias e renova sozinha quando faltam menos de 15, até o teto de 90 dias desde o login.
const SESSION_DAYS = 30, SESSION_RENEW_DAYS = 15, SESSION_MAX_DAYS = 90;
const COOKIE = 'tatame_sid';

// Nível de experiência: aulas registradas + experiência anterior (≈ 8 aulas por mês).
const EXPERIENCE = [[0, 'Novato'], [30, 'Iniciante'], [100, 'Intermediário'], [250, 'Avançado'], [500, 'Experiente']];
// Nível de aprendizado: média dos níveis (0–5) no currículo até a faixa atual.
const LEARNING = [[0, 'Inicial'], [20, 'Básico'], [40, 'Intermediário'], [60, 'Avançado'], [80, 'Domínio']];
const SKILL_LABELS = ['Não visto', 'Visto em aula', 'Executa com ajuda', 'Executa sozinho', 'Aplica no rola', 'Domina e ensina'];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
});
const bad = m => { throw new HttpError(400, m); };

// ---------- utilidades de data (no fuso da academia) ----------
const TZ = 'America/Sao_Paulo';
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dnum = s => Date.parse(s + 'T00:00:00Z') / 864e5;
const daysBetween = (a, b) => Math.round(dnum(b) - dnum(a));
const monthsBetween = (a, b) => {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + (d2 - d1) / 30.44;
};
const ageOn = (birth, on) => {
  if (!birth) return null;
  const [y, m, d] = birth.split('-').map(Number), [Y, M, D] = on.split('-').map(Number);
  return Y - y - (M < m || (M === m && D < d) ? 1 : 0);
};
const addDays = (s, n) => new Date((dnum(s) + n) * 864e5).toISOString().slice(0, 10);
const weekStart = s => { const wd = (new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7; return addDays(s, -wd); };
const minutes = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);

// ---------- validação ----------
const str = (v, { min = 0, max = 200, field = 'campo', required = false } = {}) => {
  if (v === undefined || v === null || String(v).trim() === '') { if (required) bad(`${field} é obrigatório.`); return null; }
  const s = String(v).trim();
  if (s.length < min || s.length > max) bad(`${field} deve ter entre ${min} e ${max} caracteres.`);
  return s;
};
const int = (v, min, max, field, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${field} é obrigatório.`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) bad(`${field} deve ser um número inteiro entre ${min} e ${max}.`);
  return n;
};
const real = (v, min, max, field) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) bad(`${field} deve estar entre ${min} e ${max}.`);
  return n;
};
const date = (v, field, required = false, { future = false } = {}) => {
  if (!v) { if (required) bad(`${field} é obrigatória.`); return null; }
  if (!isDate(v)) bad(`${field} inválida.`);
  if (!future && v > todayStr()) bad(`${field} não pode estar no futuro.`);
  return v;
};
const oneOf = (v, list, field, def) => { if (v === undefined || v === null || v === '') return def; if (!list.includes(v)) bad(`${field} inválido.`); return v; };

// ---------- criptografia ----------
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: b64(bits), salt: b64(salt) };
}
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const safeEqual = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const uuid = () => crypto.randomUUID();
const checkPassword = p => { if (typeof p !== 'string' || p.length < 8 || p.length > 128) bad('A senha deve ter entre 8 e 128 caracteres.'); return p; };
const checkEmail = e => { const s = str(e, { max: 120, field: 'E-mail', required: true }).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) bad('E-mail inválido.'); return s; };

// ---------- banco ----------
const all = (db, sql, ...p) => db.prepare(sql).bind(...p).all().then(r => r.results || []);
const first = (db, sql, ...p) => db.prepare(sql).bind(...p).first();
const run = (db, sql, ...p) => db.prepare(sql).bind(...p).run();

async function getSettings(db) {
  const rows = await all(db, "SELECT key, value FROM settings WHERE key <> 'setup_token'");
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ---------- sessão ----------
function cookieOf(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function createSession(db, staffId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await run(db, 'INSERT INTO auth_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)', await sha256(token), staffId, exp);
  await run(db, "DELETE FROM auth_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  return sessionCookie(token, SESSION_DAYS * 86400);
}

// Devolve a pessoa logada e, quando a sessão está perto de vencer, o cookie renovado (ctx.cookie).
async function currentStaff(req, db, ctx = {}) {
  const token = cookieOf(req, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const th = await sha256(token);
  const row = await first(db, `SELECT s.id, s.name, s.email, s.role, s.belt, a.expires_at, a.created_at FROM auth_sessions a JOIN staff s ON s.id = a.staff_id
    WHERE a.token_hash = ? AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND s.active = 1`, th);
  if (!row) return null;
  const { expires_at, created_at, ...me } = row;
  const now = Date.now(), cap = Date.parse(created_at) + SESSION_MAX_DAYS * 864e5;
  if (now >= cap) { await run(db, 'DELETE FROM auth_sessions WHERE token_hash = ?', th); return null; }
  if (Date.parse(expires_at) - now < SESSION_RENEW_DAYS * 864e5) {
    const exp = Math.min(now + SESSION_DAYS * 864e5, cap);
    await run(db, 'UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?', new Date(exp).toISOString(), th);
    ctx.cookie = sessionCookie(token, Math.floor((exp - now) / 1000));
  }
  return me;
}

// Limite de tentativas: por (e-mail, IP) para quem erra a própria senha, e por IP para quem varre vários e-mails.
// A chave não é só o e-mail de propósito: senão um estranho bloquearia o dono da conta a partir de outro lugar.
const LOGIN_LIMITS = { pair: 8, ip: 30 };
async function rateLimited(db, pairs) {
  for (const [k, max] of pairs) {
    const r = await first(db, "SELECT count(*) n FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')", k);
    if (r.n >= max) return true;
  }
  return false;
}
// Sal fixo para conferir uma senha contra uma conta que não existe: o tempo de resposta fica igual ao de uma conta real.
const GHOST_SALT = 'dGF0YW1lLWdob3N0LXNhbHQ=';
// ---------- recuperação de senha por código ----------
// Duas responsabilidades separadas: (1) VALIDAR um código de uso único (aqui) e (2) ENTREGÁ-LO. Hoje a entrega é manual
// (tools/reset-code.mjs gera o código, grava só o hash e o operador o repassa). Um envio por e-mail futuro troca apenas a entrega.
const RESET_MAX_ATTEMPTS = 5;
const normalizeResetCode = c => String(c || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
const resetCodeHash = (staffId, code) => sha256('tatame-reset:' + staffId + ':' + normalizeResetCode(code));
const audit = (db, event, staffId, detail) => db.prepare('INSERT INTO audit_log (event, staff_id, detail) VALUES (?, ?, ?)').bind(event, staffId || null, detail || null);
const RESET_BAD = 'Código inválido. Confira o código e o e-mail; se o erro continuar, peça um novo código.';

// =====================================================================
// Cálculo dos indicadores
// =====================================================================
async function loadCore(db) {
  const [students, att, skills, techniques, rules, classes] = await Promise.all([
    all(db, 'SELECT * FROM students ORDER BY name COLLATE NOCASE'),
    all(db, `SELECT a.student_id, l.id lesson_id, l.date, l.start_time, l.end_time, l.class_id FROM attendance a JOIN lessons l ON l.id = a.lesson_id`),
    all(db, 'SELECT student_id, technique_id, level, updated_at FROM skills'),
    all(db, 'SELECT * FROM techniques ORDER BY category, name'),
    all(db, 'SELECT * FROM rules'),
    all(db, 'SELECT * FROM classes ORDER BY weekday, start_time')
  ]);
  return { students, att, skills, techniques, rules: Object.fromEntries(rules.map(r => [r.belt, r])), classes };
}

const adultEquivalent = belt => KIDS.includes(belt) ? 'branca' : belt;
const curriculumFor = (belt, techniques) => {
  const rank = ADULT.indexOf(adultEquivalent(belt));
  return techniques.filter(t => t.active && ADULT.indexOf(t.min_belt) <= rank);
};

function nextBelt(st, age) {
  if (st.belt === 'preta') return null;
  const kid = age != null && age < 16;
  if (st.belt === 'branca') return kid ? 'cinza' : 'azul';
  if (KIDS.includes(st.belt)) return kid && st.belt !== 'verde' ? KIDS[KIDS.indexOf(st.belt) + 1] : 'azul';
  return ADULT[ADULT.indexOf(st.belt) + 1];
}

function studentMetrics(st, core, today, attByStudent, skillsByStudent, lessonTechs) {
  const att = (attByStudent.get(st.id) || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const r = core.rules[st.belt] || core.rules.branca;
  const age = ageOn(st.birth_date, today);
  const total = att.length;
  const last = total ? att[total - 1].date : null;
  // Aulas registradas no sistema + aulas informadas de antes do sistema (ex.: aluno antigo cadastrado agora).
  const sinceDegree = att.filter(a => a.date >= st.degree_since).length + (st.imported_classes_degree || 0);
  const sinceBelt = att.filter(a => a.date >= st.belt_since).length + (st.imported_classes_belt || 0);
  const d30 = addDays(today, -30), d84 = addDays(today, -84);
  const last30 = att.filter(a => a.date > d30).length;
  const weekly = att.filter(a => a.date > d84).length / 12;
  const hours = att.reduce((t, a) => t + Math.max(0, minutes(a.end_time) - minutes(a.start_time)), 0) / 60;
  const trainingMonths = Math.max(0, monthsBetween(st.start_date, today)) + (st.prior_months || 0);
  const expScore = total + (st.imported_classes_belt || 0) + (st.prior_months || 0) * 8;
  let expIdx = 0; EXPERIENCE.forEach(([min], i) => { if (expScore >= min) expIdx = i; });

  const sk = skillsByStudent.get(st.id) || new Map();
  const curr = curriculumFor(st.belt, core.techniques);
  const avgLevel = curr.length ? curr.reduce((t, x) => t + (sk.get(x.id)?.level || 0), 0) / curr.length : 0;
  const learningPct = Math.round((avgLevel / 5) * 100);
  let learnIdx = 0; LEARNING.forEach(([min], i) => { if (learningPct >= min) learnIdx = i; });
  const mastered = curr.filter(x => (sk.get(x.id)?.level || 0) >= 3).length;
  const curriculumPct = curr.length ? Math.round((mastered / curr.length) * 100) : 0;

  // Técnicas vistas em aula (por presença) e dificuldades: vistas 2+ vezes e ainda com nível <= 2.
  const seen = new Map();
  for (const a of att) for (const t of lessonTechs.get(a.lesson_id) || []) seen.set(t, (seen.get(t) || 0) + 1);
  const difficulties = [...seen.entries()].filter(([t, n]) => n >= 2 && (sk.get(t)?.level || 0) <= 2)
    .map(([t, n]) => ({ technique_id: t, times_seen: n, level: sk.get(t)?.level || 0 }))
    .sort((a, b) => b.times_seen - a.times_seen);

  // Próxima graduação
  const maxDeg = st.belt === 'preta' ? 6 : 4;
  let next = null;
  const crit = [];
  const add = (key, label, current, target, unit) => crit.push({ key, label, current: Math.round(current * 10) / 10, target, unit, met: current >= target });
  if (st.degrees < maxDeg) {
    next = { kind: 'grau', to_belt: st.belt, to_degrees: st.degrees + 1 };
    add('months', 'Tempo desde o último grau', monthsBetween(st.degree_since, today), r.degree_months, 'meses');
    if (r.degree_classes > 0) add('classes', 'Aulas desde o último grau', sinceDegree, r.degree_classes, 'aulas');
  } else {
    const nb = nextBelt(st, age);
    if (nb) {
      next = { kind: 'faixa', to_belt: nb, to_degrees: 0 };
      if (r.belt_months != null) add('months', 'Tempo na faixa', monthsBetween(st.belt_since, today), r.belt_months, 'meses');
      if (r.belt_classes != null) add('classes', 'Aulas na faixa', sinceBelt, r.belt_classes, 'aulas');
      if (r.curriculum_pct != null) add('curriculum', 'Currículo dominado (nível ≥ 3)', curriculumPct, r.curriculum_pct, '%');
      const minAge = st.belt === 'branca' && nb === 'cinza' ? KID_MIN_AGE.cinza : nb === 'azul' && KIDS.includes(st.belt) ? 16 : r.next_min_age;
      if (minAge != null) add('age', 'Idade mínima (IBJJF)', age ?? 0, minAge, 'anos');
    }
  }
  const progress = crit.length ? Math.round(crit.reduce((t, c) => t + Math.min(1, c.target > 0 ? c.current / c.target : 1), 0) / crit.length * 100) : 0;
  const ready = !!next && crit.length > 0 && crit.every(c => c.met);
  const daysAbsent = last ? daysBetween(last, today) : daysBetween(st.start_date, today);
  return {
    age, classes_total: total, last_attendance: last, days_absent: daysAbsent,
    at_risk: st.status === 'ativo' && daysAbsent >= 14,
    classes_last_30d: last30, weekly_avg: Math.round(weekly * 10) / 10, mat_hours: Math.round(hours * 10) / 10,
    classes_since_degree: sinceDegree, classes_since_belt: sinceBelt,
    months_in_belt: Math.round(monthsBetween(st.belt_since, today) * 10) / 10,
    training_months: Math.round(trainingMonths * 10) / 10,
    experience: { score: expScore, level: expIdx + 1, label: EXPERIENCE[expIdx][1], next_at: EXPERIENCE[expIdx + 1]?.[0] ?? null },
    learning: { pct: learningPct, level: learnIdx + 1, label: LEARNING[learnIdx][1], curriculum_size: curr.length, mastered, curriculum_pct: curriculumPct },
    difficulties: difficulties.slice(0, 10),
    techniques_seen: seen.size,
    next, criteria: crit, progress, ready
  };
}

async function computeAll(db) {
  const core = await loadCore(db);
  const today = todayStr();
  const attByStudent = new Map();
  for (const a of core.att) { if (!attByStudent.has(a.student_id)) attByStudent.set(a.student_id, []); attByStudent.get(a.student_id).push(a); }
  const skillsByStudent = new Map();
  for (const s of core.skills) { if (!skillsByStudent.has(s.student_id)) skillsByStudent.set(s.student_id, new Map()); skillsByStudent.get(s.student_id).set(s.technique_id, s); }
  // Data de cada aula vem da própria tabela de aulas: uma aula sem presentes também conta como "técnica ensinada".
  const [lt, lessonRows] = await Promise.all([all(db, 'SELECT lesson_id, technique_id FROM lesson_techniques'), all(db, 'SELECT id, date FROM lessons')]);
  const lessonDate = new Map(lessonRows.map(l => [l.id, l.date]));
  const lessonTechs = new Map();
  for (const x of lt) { if (!lessonTechs.has(x.lesson_id)) lessonTechs.set(x.lesson_id, []); lessonTechs.get(x.lesson_id).push(x.technique_id); }
  const students = core.students.map(st => ({ ...st, metrics: studentMetrics(st, core, today, attByStudent, skillsByStudent, lessonTechs) }));
  return { core, today, students, attByStudent, skillsByStudent, lessonTechs, lt, lessonDate };
}

async function dashboard(db, C) {
  const { core, today, students } = C;
  const active = students.filter(s => s.status === 'ativo');
  const lessons = await all(db, `SELECT l.*, (SELECT count(*) FROM attendance a WHERE a.lesson_id = l.id) n FROM lessons l WHERE l.date > ? ORDER BY l.date`, addDays(today, -7 * 13));
  const ws = weekStart(today);
  const weeks = [...Array(12)].map((_, i) => addDays(ws, -7 * (11 - i)));
  const weekly = weeks.map(w => {
    const ls = lessons.filter(l => l.date >= w && l.date < addDays(w, 7));
    const ids = new Set(core.att.filter(a => a.date >= w && a.date < addDays(w, 7)).map(a => a.student_id));
    return { week: w, lessons: ls.length, attendance: ls.reduce((t, l) => t + l.n, 0), unique_students: ids.size };
  });
  const d30 = addDays(today, -30);
  const l30 = lessons.filter(l => l.date > d30);
  const belts = BELTS.map(b => ({ belt: b, count: active.filter(s => s.belt === b).length })).filter(x => x.count);
  // Ocupação por horário fixo (últimas 8 semanas)
  const d56 = addDays(today, -56);
  const occupancy = core.classes.filter(c => c.active).map(c => {
    const ls = lessons.filter(l => l.class_id === c.id && l.date > d56);
    return { class_id: c.id, lessons: ls.length, avg: ls.length ? Math.round(ls.reduce((t, l) => t + l.n, 0) / ls.length * 10) / 10 : 0 };
  });
  // Presença média por dia da semana e hora
  const heat = {};
  for (const l of lessons.filter(l => l.date > d56)) {
    const wd = new Date(l.date + 'T00:00:00Z').getUTCDay(), h = l.start_time.slice(0, 2);
    const k = `${wd}-${h}`; heat[k] = heat[k] || { weekday: wd, hour: +h, lessons: 0, attendance: 0 };
    heat[k].lessons++; heat[k].attendance += l.n;
  }
  const todayWd = new Date(today + 'T00:00:00Z').getUTCDay();
  const todays = core.classes.filter(c => c.active && c.weekday === todayWd).map(c => ({ ...c, lesson: lessons.find(l => l.class_id === c.id && l.date === today) || null }));
  const startMonth = today.slice(0, 8) + '01';
  return {
    today,
    kpis: {
      active_students: active.length,
      new_this_month: students.filter(s => s.start_date >= startMonth).length,
      at_risk: active.filter(s => s.metrics.at_risk).length,
      ready: active.filter(s => s.metrics.ready).length,
      lessons_30d: l30.length,
      avg_per_lesson_30d: l30.length ? Math.round(l30.reduce((t, l) => t + l.n, 0) / l30.length * 10) / 10 : 0,
      attendance_this_week: weekly[weekly.length - 1].attendance,
      attendance_last_week: weekly[weekly.length - 2].attendance,
      attendance_last_week_same_period: core.att.filter(a => a.date >= addDays(ws, -7) && a.date <= addDays(today, -7)).length
    },
    weekly, belts, occupancy, heat: Object.values(heat).map(h => ({ ...h, avg: Math.round(h.attendance / h.lessons * 10) / 10 })), todays,
    ready_list: active.filter(s => s.metrics.ready).map(s => s.id),
    near_list: active.filter(s => !s.metrics.ready && s.metrics.progress >= 75).sort((a, b) => b.metrics.progress - a.metrics.progress).slice(0, 8).map(s => s.id),
    risk_list: active.filter(s => s.metrics.at_risk).sort((a, b) => b.metrics.days_absent - a.metrics.days_absent).map(s => s.id)
  };
}

function techniqueStats(C) {
  const { core, lt, skillsByStudent, today, lessonDate: lessonsById } = C;
  return core.techniques.map(t => {
    const taught = lt.filter(x => x.technique_id === t.id);
    const levels = [];
    for (const [, m] of skillsByStudent) { const s = m.get(t.id); if (s) levels.push(s.level); }
    const dates = taught.map(x => lessonsById.get(x.lesson_id)).filter(Boolean).sort();
    return {
      ...t, times_taught: taught.length, last_taught: dates.length ? dates[dates.length - 1] : null,
      taught_90d: dates.filter(d => d > addDays(today, -90)).length,
      assessed: levels.length, avg_level: levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length * 10) / 10 : null,
      proficient: levels.filter(l => l >= 3).length
    };
  });
}

// =====================================================================
// Rotas
// =====================================================================
// Campos que mudam a contagem para graduação: depois do cadastro, só o administrador corrige.
const GRADUATION_FIELDS = ['belt_since', 'degree_since', 'imported_classes_belt', 'imported_classes_degree'];
const STUDENT_FIELDS = async (b, existing, canFixGraduation = true) => {
  if (existing && !canFixGraduation) {
    for (const k of GRADUATION_FIELDS) if (b[k] !== undefined && b[k] !== '' && String(b[k]) !== String(existing[k])) throw new HttpError(403, 'Só o administrador corrige datas de graduação e aulas anteriores ao sistema.');
  }
  const today = todayStr();
  const o = {
    name: str(b.name, { min: 2, max: 80, field: 'Nome', required: true }),
    nickname: str(b.nickname, { max: 40, field: 'Apelido' }),
    birth_date: date(b.birth_date, 'Data de nascimento'),
    sex: oneOf(b.sex || null, ['m', 'f', 'x', null], 'Sexo', null),
    phone: str(b.phone, { max: 30, field: 'Telefone' }),
    email: b.email ? checkEmail(b.email) : null,
    start_date: date(b.start_date || (existing ? existing.start_date : today), 'Data de início', true),
    prior_months: int(b.prior_months ?? 0, 0, 600, 'Experiência anterior (meses)') ?? 0,
    weight_kg: real(b.weight_kg, 10, 250, 'Peso'),
    status: oneOf(b.status, ['ativo', 'trancado', 'inativo'], 'Situação', 'ativo'),
    goals: str(b.goals, { max: 500, field: 'Objetivos' }),
    notes: str(b.notes, { max: 2000, field: 'Observações' })
  };
  if (o.birth_date && (ageOn(o.birth_date, today) < 3 || ageOn(o.birth_date, today) > 100)) bad('Confira a data de nascimento.');
  if (!existing) {
    o.belt = oneOf(b.belt, BELTS, 'Faixa', 'branca');
    o.degrees = int(b.degrees ?? 0, 0, o.belt === 'preta' ? 6 : 4, 'Graus') ?? 0;
    o.belt_since = date(b.belt_since || o.start_date, 'Data da faixa atual', true);
    o.degree_since = date(b.degree_since || o.belt_since, 'Data do último grau', true);
    if (o.degree_since < o.belt_since) bad('O último grau não pode ser anterior à faixa atual.');
  }
  if (b.imported_classes_belt !== undefined || !existing) {
    o.imported_classes_belt = int(b.imported_classes_belt || 0, 0, 5000, 'Aulas na faixa antes do sistema');
    o.imported_classes_degree = int(b.imported_classes_degree || 0, 0, 5000, 'Aulas desde o último grau antes do sistema');
    if (o.imported_classes_degree > o.imported_classes_belt) bad('As aulas desde o último grau não podem ser mais que as aulas na faixa.');
  }
  if (existing && (b.belt_since !== undefined || b.degree_since !== undefined)) {
    // Correção de datas de graduação (ex.: aluno importado)
    o.belt_since = date(b.belt_since || existing.belt_since, 'Data da faixa atual', true);
    o.degree_since = date(b.degree_since || existing.degree_since, 'Data do último grau', true);
    if (o.degree_since < o.belt_since) bad('O último grau não pode ser anterior à faixa atual.');
  }
  return o;
};

const CLASS_FIELDS = b => {
  const o = {
    name: str(b.name, { min: 2, max: 60, field: 'Nome da turma', required: true }),
    weekday: int(b.weekday, 0, 6, 'Dia da semana', true),
    start_time: b.start_time, end_time: b.end_time,
    level: oneOf(b.level, ['todos', 'iniciante', 'intermediario', 'avancado', 'kids', 'competicao'], 'Nível', 'todos'),
    modality: oneOf(b.modality, ['gi', 'nogi', 'livre'], 'Modalidade', 'gi'),
    instructor_id: b.instructor_id || null,
    active: b.active === false || b.active === 0 ? 0 : 1
  };
  if (!isTime(o.start_time) || !isTime(o.end_time)) bad('Informe os horários no formato HH:MM.');
  if (o.end_time <= o.start_time) bad('O horário de término deve ser depois do início.');
  return o;
};

async function saveLesson(db, staff, b, id) {
  const cls = b.class_id ? await first(db, 'SELECT * FROM classes WHERE id = ?', b.class_id) : null;
  if (b.class_id && !cls) bad('Turma não encontrada.');
  const o = {
    class_id: cls ? cls.id : null,
    date: date(b.date, 'Data da aula', true),
    start_time: b.start_time || (cls && cls.start_time), end_time: b.end_time || (cls && cls.end_time),
    modality: oneOf(b.modality, ['gi', 'nogi', 'livre'], 'Modalidade', cls ? cls.modality : 'gi'),
    title: str(b.title, { max: 120, field: 'Tema da aula' }),
    notes: str(b.notes, { max: 2000, field: 'Observações' }),
    instructor_id: b.instructor_id || (cls && cls.instructor_id) || staff.id
  };
  if (!isTime(o.start_time) || !isTime(o.end_time) || o.end_time <= o.start_time) bad('Horário da aula inválido.');
  const studentIds = [...new Set(Array.isArray(b.student_ids) ? b.student_ids : [])];
  const techIds = [...new Set((Array.isArray(b.technique_ids) ? b.technique_ids : []).map(Number))];
  if (studentIds.length > 300 || techIds.length > 40) bad('Lista grande demais.');
  if (studentIds.length) {
    const found = await all(db, `SELECT id FROM students WHERE id IN (${studentIds.map(() => '?').join(',')})`, ...studentIds);
    if (found.length !== studentIds.length) bad('Algum aluno da chamada não existe.');
  }
  if (techIds.length) {
    const found = await all(db, `SELECT id FROM techniques WHERE id IN (${techIds.map(() => '?').join(',')})`, ...techIds);
    if (found.length !== techIds.length) bad('Alguma técnica não existe.');
  }
  if (o.class_id) {
    const dup = await first(db, 'SELECT id FROM lessons WHERE class_id = ? AND date = ? AND id <> ?', o.class_id, o.date, id || '');
    if (dup) throw new HttpError(409, 'Já existe uma chamada desta turma neste dia.');
  }
  const stmts = [];
  if (id) {
    stmts.push(db.prepare('UPDATE lessons SET class_id=?, date=?, start_time=?, end_time=?, modality=?, title=?, notes=?, instructor_id=? WHERE id=?')
      .bind(o.class_id, o.date, o.start_time, o.end_time, o.modality, o.title, o.notes, o.instructor_id, id));
    stmts.push(db.prepare('DELETE FROM attendance WHERE lesson_id = ?').bind(id));
    stmts.push(db.prepare('DELETE FROM lesson_techniques WHERE lesson_id = ?').bind(id));
  } else {
    id = uuid();
    stmts.push(db.prepare('INSERT INTO lessons (id, class_id, date, start_time, end_time, modality, title, notes, instructor_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, o.class_id, o.date, o.start_time, o.end_time, o.modality, o.title, o.notes, o.instructor_id, staff.id));
  }
  for (const s of studentIds) stmts.push(db.prepare('INSERT INTO attendance (lesson_id, student_id) VALUES (?, ?)').bind(id, s));
  for (const t of techIds) stmts.push(db.prepare('INSERT INTO lesson_techniques (lesson_id, technique_id) VALUES (?, ?)').bind(id, t));
  // Quem estava na aula passa a ter a técnica como "vista em aula" (nível 1), sem rebaixar ninguém.
  for (const s of studentIds) for (const t of techIds) {
    stmts.push(db.prepare(`INSERT INTO skills (student_id, technique_id, level, updated_by) VALUES (?, ?, 1, ?)
      ON CONFLICT (student_id, technique_id) DO UPDATE SET level = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = excluded.updated_by WHERE skills.level < 1`).bind(s, t, staff.id));
  }
  await db.batch(stmts);
  return id;
}

async function lessonOut(db, id) {
  const l = await first(db, 'SELECT * FROM lessons WHERE id = ?', id);
  if (!l) throw new HttpError(404, 'Aula não encontrada.');
  l.student_ids = (await all(db, 'SELECT student_id FROM attendance WHERE lesson_id = ?', id)).map(r => r.student_id);
  l.technique_ids = (await all(db, 'SELECT technique_id FROM lesson_techniques WHERE lesson_id = ?', id)).map(r => r.technique_id);
  return l;
}

async function studentDetail(db, id) {
  const C = await computeAll(db);
  const st = C.students.find(s => s.id === id);
  if (!st) throw new HttpError(404, 'Aluno não encontrado.');
  const lessons = await all(db, `SELECT l.id, l.date, l.start_time, l.end_time, l.title, l.modality, c.name class_name
    FROM attendance a JOIN lessons l ON l.id = a.lesson_id LEFT JOIN classes c ON c.id = l.class_id WHERE a.student_id = ? ORDER BY l.date DESC, l.start_time DESC`, id);
  const promotions = await all(db, `SELECT p.*, s.name staff_name FROM promotions p LEFT JOIN staff s ON s.id = p.staff_id WHERE p.student_id = ? ORDER BY p.date DESC, p.created_at DESC`, id);
  const skills = await all(db, 'SELECT technique_id, level, note, updated_at FROM skills WHERE student_id = ?', id);
  const history = await all(db, 'SELECT technique_id, level, at FROM skill_history WHERE student_id = ? ORDER BY at DESC LIMIT 60', id);
  const ws = weekStart(C.today);
  const weeks = [...Array(26)].map((_, i) => addDays(ws, -7 * (25 - i)));
  const weekly = weeks.map(w => ({ week: w, count: lessons.filter(l => l.date >= w && l.date < addDays(w, 7)).length }));
  // Horário preferido
  const byClass = {};
  for (const l of lessons) { const k = l.class_name || 'Aula avulsa'; byClass[k] = (byClass[k] || 0) + 1; }
  const seenCount = {};
  for (const l of lessons) for (const t of C.lessonTechs.get(l.id) || []) seenCount[t] = (seenCount[t] || 0) + 1;
  return { student: st, lessons: lessons.slice(0, 120), promotions, skills, history, weekly, by_class: byClass, seen: seenCount };
}

async function promote(db, staff, id, b) {
  const C = await computeAll(db);
  const st = C.students.find(s => s.id === id);
  if (!st) throw new HttpError(404, 'Aluno não encontrado.');
  const kind = oneOf(b.kind, ['grau', 'faixa'], 'Tipo de graduação');
  if (!kind) bad('Informe se é grau ou faixa.');
  const when = date(b.date || C.today, 'Data da graduação', true);
  if (when < st.degree_since) bad('A data não pode ser anterior à última graduação.');
  let toBelt = st.belt, toDeg = st.degrees;
  if (kind === 'grau') {
    const max = st.belt === 'preta' ? 6 : 4;
    if (st.degrees >= max) bad(`O aluno já tem o máximo de graus da faixa ${st.belt}.`);
    toDeg = st.degrees + 1;
  } else {
    toBelt = oneOf(b.to_belt, BELTS, 'Nova faixa');
    if (!toBelt) bad('Escolha a nova faixa.');
    if (BELTS.indexOf(toBelt) <= BELTS.indexOf(st.belt)) bad('A nova faixa precisa ser acima da atual.');
    if (KIDS.includes(toBelt) && toBelt !== 'branca' && (st.metrics.age == null || st.metrics.age >= 16)) bad('Faixas infantis são para alunos com até 15 anos (informe a data de nascimento).');
    toDeg = 0;
  }
  const m = st.metrics;
  const criteriaMet = m.next && m.next.kind === kind && m.next.to_belt === toBelt && m.ready ? 1 : 0;
  if (!criteriaMet && !b.override) throw new HttpError(409, 'O aluno ainda não cumpre todos os critérios. Confirme para graduar mesmo assim.');
  const pid = uuid();
  await db.batch([
    db.prepare(`INSERT INTO promotions (id, student_id, kind, from_belt, from_degrees, to_belt, to_degrees, from_belt_since, from_degree_since, from_imported_belt, from_imported_degree, date, criteria_met, notes, staff_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(pid, id, kind, st.belt, st.degrees, toBelt, toDeg, st.belt_since, st.degree_since, st.imported_classes_belt || 0, st.imported_classes_degree || 0, when, criteriaMet, str(b.notes, { max: 500, field: 'Observação' }), staff.id),
    kind === 'grau'
      ? db.prepare(`UPDATE students SET degrees = ?, degree_since = ?, imported_classes_degree = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(toDeg, when, id)
      : db.prepare(`UPDATE students SET belt = ?, degrees = 0, belt_since = ?, degree_since = ?, imported_classes_belt = 0, imported_classes_degree = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(toBelt, when, when, id)
  ]);
  return pid;
}

async function route(req, env, url, ctx) {
  const db = env.DB;
  if (!db) throw new HttpError(500, 'Banco de dados não configurado (binding DB).');
  const method = req.method, path = url.pathname.replace(/\/+$/, '');
  const body = async () => { try { return await req.json(); } catch { bad('Corpo da requisição inválido.'); } };

  // CSRF: toda escrita precisa do cabeçalho do app (navegadores não o enviam em formulários de outros sites).
  if (method !== 'GET' && req.headers.get('x-tatame') !== '1') throw new HttpError(403, 'Requisição bloqueada.');

  if (path === '/api/health') return json({ ok: true });

  if (path === '/api/status' && method === 'GET') {
    const s = await getSettings(db);
    s.setup_token = (await first(db, "SELECT value FROM settings WHERE key = 'setup_token'"))?.value;
    const n = await first(db, 'SELECT count(*) n FROM staff');
    return json({ setup_needed: n.n === 0, setup_code_required: n.n === 0 && !!s.setup_token, academy_name: s.academy_name || null });
  }

  if (path === '/api/setup' && method === 'POST') {
    const n = await first(db, 'SELECT count(*) n FROM staff');
    if (n.n > 0) throw new HttpError(409, 'A academia já foi configurada.');
    const b = await body();
    // Código de ativação: impede que um estranho que abra o site antes do dono vire administrador.
    const tok = await first(db, "SELECT value FROM settings WHERE key = 'setup_token'");
    if (tok && tok.value && !safeEqual(String(b.setup_code || '').trim().toUpperCase(), tok.value)) throw new HttpError(403, 'Código de ativação incorreto.');
    const academy = str(b.academy_name, { min: 2, max: 80, field: 'Nome da academia', required: true });
    const name = str(b.name, { min: 2, max: 80, field: 'Seu nome', required: true });
    const email = checkEmail(b.email), pw = checkPassword(b.password);
    const { hash, salt } = await hashPassword(pw);
    const id = uuid();
    await db.batch([
      db.prepare('INSERT INTO staff (id, name, email, pass_hash, pass_salt, role, belt) VALUES (?,?,?,?,?,?,?)').bind(id, name, email, hash, salt, 'admin', oneOf(b.belt, BELTS, 'Faixa', null)),
      db.prepare("INSERT INTO settings (key, value) VALUES ('academy_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(academy),
      db.prepare("INSERT INTO settings (key, value) VALUES ('setup_done', '1') ON CONFLICT (key) DO UPDATE SET value = '1'"),
      db.prepare("DELETE FROM settings WHERE key = 'setup_token'")
    ]);
    return json({ ok: true }, 201, { 'set-cookie': await createSession(db, id) });
  }

  if (path === '/api/login' && method === 'POST') {
    const b = await body();
    const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    const pairKey = 'email:' + email + '|ip:' + ip, ipKey = 'ip:' + ip;
    if (await rateLimited(db, [[pairKey, LOGIN_LIMITS.pair], [ipKey, LOGIN_LIMITS.ip]])) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
    const s = await first(db, 'SELECT * FROM staff WHERE email = ? AND active = 1', email);
    // Sempre calcula o hash (contra o sal real ou o fantasma), para a resposta não revelar se o e-mail existe.
    const computed = (await hashPassword(pw, s ? s.pass_salt : GHOST_SALT)).hash;
    const ok = !!s && safeEqual(computed, s.pass_hash);
    if (!ok) {
      await db.batch([
        db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(pairKey), db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(ipKey),
        db.prepare("DELETE FROM login_attempts WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')")
      ]);
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    await run(db, 'DELETE FROM login_attempts WHERE key = ?', pairKey);
    return json({ ok: true }, 200, { 'set-cookie': await createSession(db, s.id) });
  }

  if (path === '/api/reset' && method === 'POST') {
    const b = await body();
    const email = String(b.email || '').trim().toLowerCase(), code = normalizeResetCode(b.code);
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    const pairKey = 'reset:email:' + email + '|ip:' + ip, ipKey = 'reset:ip:' + ip;
    if (await rateLimited(db, [[pairKey, LOGIN_LIMITS.pair], [ipKey, LOGIN_LIMITS.ip]])) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
    const newPw = checkPassword(b.password);
    if (b.password_confirm !== undefined && b.password_confirm !== newPw) bad('As senhas não conferem.');
    const fail = async (staffId, why) => {
      const st = [db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(pairKey), db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(ipKey),
        db.prepare("DELETE FROM login_attempts WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')")];
      if (staffId) st.push(db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE staff_id = ? AND used_at IS NULL').bind(staffId), audit(db, 'reset_failed', staffId, why));
      await db.batch(st);
    };
    const s = await first(db, 'SELECT id FROM staff WHERE email = ? AND active = 1', email);
    const pr = s ? await first(db, 'SELECT * FROM password_resets WHERE staff_id = ?', s.id) : null;
    const given = await resetCodeHash(s ? s.id : 'none', code);
    const match = !!pr && code.length >= 20 && safeEqual(given, pr.code_hash);
    // Mensagem genérica enquanto o código não confere: não revela se o e-mail existe nem se há código pendente.
    if (!match || pr.attempts >= RESET_MAX_ATTEMPTS) { await fail(s && pr ? s.id : null, match ? 'bloqueado por tentativas' : 'código incorreto'); throw new HttpError(400, RESET_BAD); }
    if (pr.used_at) throw new HttpError(400, 'Este código já foi utilizado. Peça um novo código.');
    if (Date.parse(pr.expires_at) <= Date.now()) throw new HttpError(400, 'Este código expirou. Peça um novo código.');
    // Consumo atômico: só uma requisição consegue marcar o código como usado.
    const claim = await run(db, "UPDATE password_resets SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE staff_id = ? AND used_at IS NULL", s.id);
    if (!claim.meta || claim.meta.changes !== 1) throw new HttpError(400, 'Este código já foi utilizado. Peça um novo código.');
    const { hash, salt } = await hashPassword(newPw);
    await db.batch([db.prepare('UPDATE staff SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, s.id),
      db.prepare('DELETE FROM auth_sessions WHERE staff_id = ?').bind(s.id),
      db.prepare('DELETE FROM login_attempts WHERE key = ? OR key = ?').bind(pairKey, 'email:' + email + '|ip:' + ip),
      audit(db, 'reset_used', s.id, 'senha redefinida; sessões encerradas')]);
    return json({ ok: true });
  }

  if (path === '/api/logout' && method === 'POST') {
    const t = cookieOf(req, COOKIE);
    if (t) await run(db, 'DELETE FROM auth_sessions WHERE token_hash = ?', await sha256(t));
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  // ---------- daqui em diante: só equipe logada ----------
  const me = await currentStaff(req, db, ctx);
  if (!me) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  // Matriz de acesso (ver README, "Perfis"). Professor faz o dia a dia; o que está marcado com admin() é só do administrador.
  // Excluir chamada e desfazer graduação: o professor só mexe no que ele mesmo registrou nos últimos OWN_DAYS dias.
  const admin = () => { if (me.role !== 'admin') throw new HttpError(403, 'Apenas o administrador pode fazer isso.'); };
  const OWN_DAYS = 7;
  const ownRecent = (staffId, createdAt, what) => {
    if (me.role === 'admin') return;
    if (staffId !== me.id || Date.now() - Date.parse(createdAt) > OWN_DAYS * 864e5) throw new HttpError(403, `Só o administrador exclui ${what} de outra pessoa ou com mais de ${OWN_DAYS} dias.`);
  };
  let m;

  if (path === '/api/me' && method === 'GET') return json({ me, settings: await getSettings(db) });
  if (path === '/api/me/password' && method === 'PUT') {
    const b = await body();
    const s = await first(db, 'SELECT * FROM staff WHERE id = ?', me.id);
    if (!safeEqual((await hashPassword(String(b.current || ''), s.pass_salt)).hash, s.pass_hash)) bad('Senha atual incorreta.');
    const { hash, salt } = await hashPassword(checkPassword(b.password));
    await db.batch([db.prepare('UPDATE staff SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, me.id),
      db.prepare('DELETE FROM auth_sessions WHERE staff_id = ?').bind(me.id)]);
    return json({ ok: true }, 200, { 'set-cookie': await createSession(db, me.id) });
  }

  // Estado completo para o app
  if (path === '/api/state' && method === 'GET') {
    const C = await computeAll(db);
    const [staff, settings] = await Promise.all([all(db, 'SELECT id, name, email, role, belt, active FROM staff ORDER BY name'), getSettings(db)]);
    return json({
      me, settings, today: C.today, students: C.students, classes: C.core.classes, techniques: techniqueStats(C),
      rules: Object.values(C.core.rules), staff: me.role === 'admin' ? staff : staff.map(({ email, ...s }) => s),
      dashboard: await dashboard(db, C), labels: { skills: SKILL_LABELS, experience: EXPERIENCE, learning: LEARNING }
    });
  }

  // ---------- alunos ----------
  if (path === '/api/students' && method === 'POST') {
    const o = await STUDENT_FIELDS(await body(), null);
    const id = uuid();
    const cols = Object.keys(o);
    await run(db, `INSERT INTO students (id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`, id, ...cols.map(c => o[c]));
    return json(await studentDetail(db, id), 201);
  }
  if ((m = path.match(/^\/api\/students\/([0-9a-f-]{36})$/))) {
    const id = m[1];
    if (method === 'GET') return json(await studentDetail(db, id));
    const ex = await first(db, 'SELECT * FROM students WHERE id = ?', id);
    if (!ex) throw new HttpError(404, 'Aluno não encontrado.');
    if (method === 'PUT') {
      const o = await STUDENT_FIELDS(await body(), ex, me.role === 'admin');
      const cols = Object.keys(o);
      await run(db, `UPDATE students SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, ...cols.map(c => o[c]), id);
      return json(await studentDetail(db, id));
    }
    if (method === 'DELETE') { admin(); await run(db, 'DELETE FROM students WHERE id = ?', id); return json({ ok: true }); }
  }
  if ((m = path.match(/^\/api\/students\/([0-9a-f-]{36})\/promote$/)) && method === 'POST') {
    await promote(db, me, m[1], await body());
    return json(await studentDetail(db, m[1]), 201);
  }
  if ((m = path.match(/^\/api\/students\/([0-9a-f-]{36})\/skills$/)) && method === 'PUT') {
    const b = await body();
    const st = await first(db, 'SELECT id FROM students WHERE id = ?', m[1]);
    if (!st) throw new HttpError(404, 'Aluno não encontrado.');
    const items = Array.isArray(b.items) ? b.items : [b];
    if (!items.length || items.length > 100) bad('Nenhuma avaliação enviada.');
    const stmts = [];
    for (const it of items) {
      const tid = int(it.technique_id, 1, 1e9, 'Técnica', true), level = int(it.level, 0, 5, 'Nível', true);
      const t = await first(db, 'SELECT id FROM techniques WHERE id = ?', tid);
      if (!t) bad('Técnica não encontrada.');
      const note = str(it.note, { max: 300, field: 'Observação' });
      stmts.push(db.prepare(`INSERT INTO skills (student_id, technique_id, level, note, updated_by) VALUES (?,?,?,?,?)
        ON CONFLICT (student_id, technique_id) DO UPDATE SET level = excluded.level, note = excluded.note, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(m[1], tid, level, note, me.id));
      stmts.push(db.prepare('INSERT INTO skill_history (student_id, technique_id, level, staff_id) VALUES (?,?,?,?)').bind(m[1], tid, level, me.id));
    }
    await db.batch(stmts);
    return json(await studentDetail(db, m[1]));
  }
  if ((m = path.match(/^\/api\/promotions\/([0-9a-f-]{36})$/)) && method === 'DELETE') {
    const p = await first(db, 'SELECT * FROM promotions WHERE id = ?', m[1]);
    if (!p) throw new HttpError(404, 'Graduação não encontrada.');
    ownRecent(p.staff_id, p.created_at, 'graduações');
    const latest = await first(db, 'SELECT id FROM promotions WHERE student_id = ? ORDER BY date DESC, created_at DESC LIMIT 1', p.student_id);
    if (latest.id !== p.id) bad('Só é possível desfazer a graduação mais recente do aluno.');
    await db.batch([
      db.prepare(`UPDATE students SET belt = ?, degrees = ?, belt_since = ?, degree_since = ?, imported_classes_belt = ?, imported_classes_degree = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .bind(p.from_belt, p.from_degrees, p.from_belt_since, p.from_degree_since, p.from_imported_belt, p.from_imported_degree, p.student_id),
      db.prepare('DELETE FROM promotions WHERE id = ?').bind(p.id)
    ]);
    return json(await studentDetail(db, p.student_id));
  }

  // ---------- turmas / horários ----------
  if (path === '/api/classes' && method === 'POST') {
    const o = CLASS_FIELDS(await body()); const id = uuid();
    await run(db, 'INSERT INTO classes (id, name, weekday, start_time, end_time, level, modality, instructor_id, active) VALUES (?,?,?,?,?,?,?,?,?)', id, o.name, o.weekday, o.start_time, o.end_time, o.level, o.modality, o.instructor_id, o.active);
    return json(await first(db, 'SELECT * FROM classes WHERE id = ?', id), 201);
  }
  if ((m = path.match(/^\/api\/classes\/([0-9a-f-]{36})$/))) {
    const ex = await first(db, 'SELECT * FROM classes WHERE id = ?', m[1]);
    if (!ex) throw new HttpError(404, 'Turma não encontrada.');
    if (method === 'PUT') {
      const o = CLASS_FIELDS(await body());
      await run(db, 'UPDATE classes SET name=?, weekday=?, start_time=?, end_time=?, level=?, modality=?, instructor_id=?, active=? WHERE id=?', o.name, o.weekday, o.start_time, o.end_time, o.level, o.modality, o.instructor_id, o.active, m[1]);
      return json(await first(db, 'SELECT * FROM classes WHERE id = ?', m[1]));
    }
    if (method === 'DELETE') { admin(); await run(db, 'DELETE FROM classes WHERE id = ?', m[1]); return json({ ok: true }); }
  }

  // ---------- aulas e chamada ----------
  if (path === '/api/lessons' && method === 'GET') {
    const from = url.searchParams.get('from') || addDays(todayStr(), -60), to = url.searchParams.get('to') || todayStr();
    if (!isDate(from) || !isDate(to)) bad('Período inválido.');
    const rows = await all(db, `SELECT l.*, c.name class_name, s.name instructor_name, (SELECT count(*) FROM attendance a WHERE a.lesson_id = l.id) attendees,
      (SELECT group_concat(technique_id) FROM lesson_techniques t WHERE t.lesson_id = l.id) techs
      FROM lessons l LEFT JOIN classes c ON c.id = l.class_id LEFT JOIN staff s ON s.id = l.instructor_id WHERE l.date BETWEEN ? AND ? ORDER BY l.date DESC, l.start_time DESC LIMIT 500`, from, to);
    return json(rows.map(r => ({ ...r, technique_ids: r.techs ? String(r.techs).split(',').map(Number) : [], techs: undefined })));
  }
  if (path === '/api/lessons' && method === 'POST') { const id = await saveLesson(db, me, await body(), null); return json(await lessonOut(db, id), 201); }
  if ((m = path.match(/^\/api\/lessons\/([0-9a-f-]{36})$/))) {
    if (method === 'GET') return json(await lessonOut(db, m[1]));
    const ex = await first(db, 'SELECT id, created_by, created_at FROM lessons WHERE id = ?', m[1]);
    if (!ex) throw new HttpError(404, 'Aula não encontrada.');
    if (method === 'PUT') { await saveLesson(db, me, await body(), m[1]); return json(await lessonOut(db, m[1])); }
    if (method === 'DELETE') { ownRecent(ex.created_by, ex.created_at, 'chamadas'); await run(db, 'DELETE FROM lessons WHERE id = ?', m[1]); return json({ ok: true }); }
  }

  // ---------- técnicas ----------
  const TECH = b => ({
    name: str(b.name, { min: 2, max: 80, field: 'Nome da técnica', required: true }),
    category: oneOf(b.category, CATEGORIES, 'Categoria', null) || bad('Escolha a categoria.'),
    min_belt: oneOf(b.min_belt, ADULT, 'Faixa', 'branca'),
    difficulty: int(b.difficulty ?? 2, 1, 5, 'Dificuldade'),
    description: str(b.description, { max: 500, field: 'Descrição' }),
    active: b.active === false || b.active === 0 ? 0 : 1
  });
  if (path === '/api/techniques' && method === 'POST') {
    admin();
    const o = TECH(await body());
    if (await first(db, 'SELECT id FROM techniques WHERE name = ? COLLATE NOCASE', o.name)) throw new HttpError(409, 'Já existe uma técnica com esse nome.');
    const r = await run(db, 'INSERT INTO techniques (name, category, min_belt, difficulty, description, active) VALUES (?,?,?,?,?,?)', o.name, o.category, o.min_belt, o.difficulty, o.description, o.active);
    return json(await first(db, 'SELECT * FROM techniques WHERE id = ?', r.meta.last_row_id), 201);
  }
  if ((m = path.match(/^\/api\/techniques\/(\d+)$/))) {
    admin();
    const ex = await first(db, 'SELECT * FROM techniques WHERE id = ?', +m[1]);
    if (!ex) throw new HttpError(404, 'Técnica não encontrada.');
    if (method === 'PUT') {
      const o = TECH(await body());
      if (await first(db, 'SELECT id FROM techniques WHERE name = ? COLLATE NOCASE AND id <> ?', o.name, ex.id)) throw new HttpError(409, 'Já existe uma técnica com esse nome.');
      await run(db, 'UPDATE techniques SET name=?, category=?, min_belt=?, difficulty=?, description=?, active=? WHERE id=?', o.name, o.category, o.min_belt, o.difficulty, o.description, o.active, ex.id);
      return json(await first(db, 'SELECT * FROM techniques WHERE id = ?', ex.id));
    }
    if (method === 'DELETE') {
      const used = await first(db, 'SELECT (SELECT count(*) FROM lesson_techniques WHERE technique_id = ?) + (SELECT count(*) FROM skills WHERE technique_id = ?) n', ex.id, ex.id);
      if (used.n) bad('Essa técnica já tem aulas ou avaliações. Desative em vez de excluir.');
      await run(db, 'DELETE FROM techniques WHERE id = ?', ex.id); return json({ ok: true });
    }
  }

  // ---------- critérios, ajustes e equipe (administrador) ----------
  if (path === '/api/rules' && method === 'PUT') {
    admin();
    const b = await body();
    const stmts = [];
    for (const r of (Array.isArray(b.rules) ? b.rules : [])) {
      const belt = oneOf(r.belt, BELTS, 'Faixa'); if (!belt) bad('Faixa inválida.');
      const isBlack = belt === 'preta';
      stmts.push(db.prepare('UPDATE rules SET degree_months=?, degree_classes=?, belt_months=?, belt_classes=?, curriculum_pct=?, next_min_age=? WHERE belt=?').bind(
        real(r.degree_months, 0, 120, `Meses entre graus (${belt})`) ?? bad(`Meses entre graus (${belt}) é obrigatório.`),
        int(r.degree_classes ?? 0, 0, 1000, `Aulas entre graus (${belt})`),
        isBlack ? null : real(r.belt_months, 0, 240, `Meses na faixa (${belt})`),
        isBlack ? null : int(r.belt_classes, 0, 5000, `Aulas na faixa (${belt})`),
        isBlack ? null : int(r.curriculum_pct, 0, 100, `Currículo % (${belt})`),
        isBlack ? null : int(r.next_min_age, 0, 100, `Idade mínima (${belt})`), belt));
    }
    if (!stmts.length) bad('Nada para salvar.');
    await db.batch(stmts);
    return json({ ok: true });
  }
  if (path === '/api/settings' && method === 'PUT') {
    admin();
    const b = await body();
    await run(db, "INSERT INTO settings (key, value) VALUES ('academy_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", str(b.academy_name, { min: 2, max: 80, field: 'Nome da academia', required: true }));
    return json({ ok: true });
  }
  if (path === '/api/staff' && method === 'POST') {
    admin();
    const b = await body();
    const email = checkEmail(b.email);
    if (await first(db, 'SELECT id FROM staff WHERE email = ?', email)) throw new HttpError(409, 'Já existe alguém da equipe com esse e-mail.');
    const { hash, salt } = await hashPassword(checkPassword(b.password));
    const id = uuid();
    await run(db, 'INSERT INTO staff (id, name, email, pass_hash, pass_salt, role, belt) VALUES (?,?,?,?,?,?,?)', id, str(b.name, { min: 2, max: 80, field: 'Nome', required: true }), email, hash, salt, oneOf(b.role, ['admin', 'professor'], 'Função', 'professor'), oneOf(b.belt, BELTS, 'Faixa', null));
    return json(await first(db, 'SELECT id, name, email, role, belt, active FROM staff WHERE id = ?', id), 201);
  }
  if ((m = path.match(/^\/api\/staff\/([0-9a-f-]{36})$/)) && method === 'PUT') {
    admin();
    const b = await body();
    const ex = await first(db, 'SELECT * FROM staff WHERE id = ?', m[1]);
    if (!ex) throw new HttpError(404, 'Pessoa não encontrada.');
    const role = oneOf(b.role, ['admin', 'professor'], 'Função', ex.role), active = b.active === false || b.active === 0 ? 0 : 1;
    if (ex.id === me.id && (role !== 'admin' || !active)) bad('Você não pode remover seu próprio acesso de administrador.');
    const stmts = [db.prepare('UPDATE staff SET name=?, role=?, belt=?, active=? WHERE id=?').bind(str(b.name ?? ex.name, { min: 2, max: 80, field: 'Nome', required: true }), role, oneOf(b.belt, BELTS, 'Faixa', null), active, ex.id)];
    if (b.password) { const { hash, salt } = await hashPassword(checkPassword(b.password)); stmts.push(db.prepare('UPDATE staff SET pass_hash=?, pass_salt=? WHERE id=?').bind(hash, salt, ex.id), db.prepare('DELETE FROM auth_sessions WHERE staff_id = ?').bind(ex.id)); }
    if (!active) stmts.push(db.prepare('DELETE FROM auth_sessions WHERE staff_id = ?').bind(ex.id));
    await db.batch(stmts);
    return json(await first(db, 'SELECT id, name, email, role, belt, active FROM staff WHERE id = ?', ex.id));
  }

  // ---------- exportação ----------
  if (path === '/api/export/alunos.csv' && method === 'GET') {
    admin();
    const C = await computeAll(db);
    // Aspas duplicadas; apóstrofo na frente de = + - @ e tabulação, para a planilha não interpretar o campo como fórmula; sem caracteres de controle.
    const q = v => { let s = String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const head = ['Nome', 'Apelido', 'Situação', 'Faixa', 'Graus', 'Na faixa desde', 'Último grau', 'Início', 'Idade', 'Aulas (total)', 'Aulas 30 dias', 'Média semanal', 'Última presença', 'Experiência', 'Aprendizado %', 'Próxima graduação', 'Apto'];
    const rows = C.students.map(s => [s.name, s.nickname, s.status, s.belt, s.degrees, s.belt_since, s.degree_since, s.start_date, s.metrics.age, s.metrics.classes_total, s.metrics.classes_last_30d,
      String(s.metrics.weekly_avg).replace('.', ','), s.metrics.last_attendance, s.metrics.experience.label, s.metrics.learning.pct,
      s.metrics.next ? (s.metrics.next.kind === 'grau' ? `${s.metrics.next.to_degrees}º grau` : `faixa ${s.metrics.next.to_belt}`) : '', s.metrics.ready ? 'sim' : 'não']);
    const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="alunos.csv"', 'cache-control': 'no-store' } });
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    try {
      const ctx = {};
      const res = await route(req, env, url, ctx);
      if (!ctx.cookie || res.headers.has('set-cookie')) return res;
      const h = new Headers(res.headers); h.append('set-cookie', ctx.cookie);
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const msg = String(e && e.message || e);
      if (/UNIQUE constraint/i.test(msg)) return json({ error: 'Esse registro já existe.' }, 409);
      if (/CHECK constraint|FOREIGN KEY/i.test(msg)) return json({ error: 'Algum valor está fora do permitido.' }, 400);
      console.error(e);
      return json({ error: 'Erro interno. Tente de novo.' }, 500);
    }
  }
};
