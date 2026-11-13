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

// Limites operacionais (V4). Escolhidos acima do uso real, abaixo do que sobrecarrega o D1:
//   BODY_MAX     corpo JSON: o maior pedido legítimo medido (100 avaliações com observação longa multibyte) tem ~63 KB;
//                uma chamada com 300 alunos tem ~12 KB. 256 KB deixa folga de 4x.
//   LESSON_*     uma chamada com mais de 300 presentes ou 40 técnicas não existe na prática de uma academia.
//   SKILLS_MAX   a tela manda 1 avaliação por vez; o lote é só da API (o catálogo inicial tem 70 técnicas).
//   RULES_MAX    uma regra por faixa (9 faixas), sem repetir faixa.
// As listas vão ao banco como UM parâmetro JSON (json_each): o número de comandos e de parâmetros não cresce com a lista
// (o D1 limita parâmetros por consulta; IN (?, ?, …) com 300 itens passaria desse limite).
const AGENDA_MAX_DAYS = 42, AGENDA_AHEAD_DAYS = 366;   // Agenda V1: período máximo de uma consulta e até onde se pode programar uma aula
const BODY_MAX = 256 * 1024, LESSON_STUDENTS_MAX = 300, LESSON_TECHS_MAX = 40, SKILLS_MAX = 100, RULES_MAX = 9;

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
// Dia que existe no calendário: o Date.parse aceita 2024-02-31 (vira 02/03), por isso a ida e volta.
const isDate = s => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = Date.parse(s + 'T00:00:00Z'); return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dnum = s => Date.parse(s + 'T00:00:00Z') / 864e5;
const daysBetween = (a, b) => Math.round(dnum(b) - dnum(a));
// Meses-calendário: meses completos desde `a` (aniversário mensal; 31/01 + 1 mês = 28/02) + fração do mês parcial em dias.
// Ex.: 31/01 → 30/04 = 3,0 meses exatos (a aproximação por 30,44 dias dava 2,97 e reprovava o critério de 3 meses).
const addMonthsClamp = (s, n) => {
  const [y, m, d] = s.split('-').map(Number), t = y * 12 + (m - 1) + n, ny = Math.floor(t / 12), nm = t - ny * 12 + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const monthsBetween = (a, b) => {
  if (dnum(b) < dnum(a)) return -monthsBetween(b, a);
  const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number);
  let n = (y2 - y1) * 12 + (m2 - m1);
  while (dnum(addMonthsClamp(a, n)) > dnum(b)) n--;
  while (dnum(addMonthsClamp(a, n + 1)) <= dnum(b)) n++;
  const from = dnum(addMonthsClamp(a, n));
  return n + (dnum(b) - from) / (dnum(addMonthsClamp(a, n + 1)) - from);
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
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) { if (required) bad(`${field} é obrigatório.`); return null; }
  if (typeof v !== 'string') bad(`${field} deve ser texto.`);
  const s = v.trim();
  if (s.length < min || s.length > max) bad(`${field} deve ter entre ${min} e ${max} caracteres.`);
  return s;
};
const int = (v, min, max, field, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${field} é obrigatório.`); return null; }
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*-?\d+(\.0+)?\s*$/.test(v))) bad(`${field} deve ser um número inteiro entre ${min} e ${max}.`);
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) bad(`${field} deve ser um número inteiro entre ${min} e ${max}.`);
  return n;
};
const real = (v, min, max, field) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*-?\d+([.,]\d+)?\s*$/.test(v))) bad(`${field} deve estar entre ${min} e ${max}.`);
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
// Identificadores das tabelas com chave texto: sempre crypto.randomUUID() (formato UUID). Técnicas usam inteiro (int()).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOf = (v, field, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${field} é obrigatório.`); return null; }
  if (typeof v !== 'string' || !UUID_RE.test(v)) bad(`${field} inválido.`);
  return v;
};
// Sim/não: booleano (a tela) ou 0/1. Qualquer outra coisa é erro (antes, "false" em texto virava 1).
const flag = (v, field, def) => { if (v === undefined || v === null) return def; if (v === true || v === 1) return 1; if (v === false || v === 0) return 0; bad(`${field} inválido.`); };
// Lista opcional: ausente/nula = vazia; objeto ou texto no lugar de lista = erro.
const list = (v, field) => { if (v === undefined || v === null) return []; if (!Array.isArray(v)) bad(`${field} deve ser uma lista.`); return v; };
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
// Política para senhas NOVAS (criadas ou trocadas). O login não aplica a política: senhas antigas de 8–9 caracteres continuam
// valendo até o dono trocar. Sem exigência artificial de maiúscula/número/símbolo (NIST SP 800-63B): tamanho + recusa do óbvio.
const PASSWORD_MIN = 10, PASSWORD_MAX = 128;
// Senhas comuns (≥ 10 caracteres, as menores já caem pelo tamanho), comparadas em minúsculas. Lista curta e embutida: barra o
// que um ataque de dicionário tenta primeiro, inclusive variações óbvias em português e do contexto (academia, jiu-jitsu).
const COMMON_PASSWORDS = new Set(['1234567890', '12345678910', '0123456789', '0987654321', '9876543210', '1111111111', '1234512345', '1122334455', '1212121212', '1qaz2wsx3edc',
  '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5', 'qwertyuiop', 'qwerty1234', 'qwerty12345', 'asdfghjkl1', 'asdfghjklç', 'zxcvbnm123', 'abcdefghij', 'abc1234567', 'a123456789', '123456789a', 'abcd123456',
  'password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'iloveyou123', 'welcome123', 'letmein123', 'admin12345', 'admin123456', 'administrator', 'administrador', 'changeme123',
  'senha12345', 'senha123456', 'senhasenha', 'minhasenha', 'minhasenha1', 'minhasenha123', 'senhaforte', 'senhaforte1', 'senha@1234', 'mudar12345', 'mudarsenha', 'trocarsenha', 'novasenha1',
  'brasil1234', 'brasil12345', 'flamengo123', 'corinthians', 'corinthians1', 'palmeiras1', 'palmeiras123', 'saopaulo123', 'vasco12345', 'gremio1234', 'cruzeiro123', 'santos1234',
  'jiujitsu123', 'jiu-jitsu123', 'jiujitsu2024', 'jiujitsu2025', 'jiujitsu2026', 'bjj1234567', 'tatame1234', 'tatame12345', 'tatame2024', 'tatame2025', 'tatame2026', 'academia123', 'academia1234',
  'faixapreta', 'faixapreta1', 'faixapreta123', 'oss1234567', 'gracie1234', 'professor1', 'professor123', 'mestre1234']);
function checkPassword(p, { email = null, name = null } = {}) {
  if (typeof p !== 'string' || p.length < PASSWORD_MIN || p.length > PASSWORD_MAX) bad(`A senha deve ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`);
  const low = p.trim().toLowerCase();
  if (/^(.)\1*$/su.test(p)) bad('A senha não pode ser um único caractere repetido.');
  if (COMMON_PASSWORDS.has(low)) bad('Essa senha é muito comum. Escolha outra (uma frase curta funciona bem).');
  if (email && low === String(email).trim().toLowerCase()) bad('A senha não pode ser igual ao e-mail.');
  if (name && low === String(name).trim().toLowerCase()) bad('A senha não pode ser igual ao nome.');
  return p;
}
const checkEmail = e => { const s = str(e, { max: 120, field: 'E-mail', required: true }).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) bad('E-mail inválido.'); return s; };

// ---------- banco ----------
const all = (db, sql, ...p) => db.prepare(sql).bind(...p).all().then(r => r.results || []);
const first = (db, sql, ...p) => db.prepare(sql).bind(...p).first();
const run = (db, sql, ...p) => db.prepare(sql).bind(...p).run();

async function getSettings(db) {
  const rows = await all(db, "SELECT key, value FROM settings WHERE key NOT LIKE 'setup\\_token%' ESCAPE '\\'");
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

// Limite de tentativas (V2), três contadores na mesma tabela login_attempts (janela de 15 min):
//   pair     (e-mail, rede): quem erra a própria senha                         8
//   ip       (rede): quem varre vários e-mails a partir do mesmo lugar         30
//   account  (e-mail, de qualquer rede): força bruta distribuída               20 — vale SÓ para aparelho desconhecido
// O contador da conta é a soma das linhas "pair" do e-mail (sem linha extra por tentativa). Conta inexistente conta igual
// (a resposta não pode revelar se o e-mail existe). Para não deixar um estranho trancar o dono, quem apresenta o cookie de
// aparelho conhecido daquela conta não passa pelo limite da conta (os limites por par e por rede continuam valendo).
const LOGIN_LIMITS = { pair: 8, ip: 30, account: 20 };
const PW_CHANGE_MAX = 5;   // V9: conferências da senha atual em /api/me/password por conta em 15 min
// Rede da origem: IPv4 = endereço inteiro; IPv6 = prefixo /64 (um cliente costuma receber a /64 inteira e trocar de endereço
// à vontade dentro dela); IPv4 mapeado em IPv6 (::ffff:a.b.c.d) = IPv4. Sem cabeçalho ou com valor inválido: uma chave única
// compartilhada por todos nessa condição (falha fechada: não vira "sem limite"). O cf-connecting-ip é definido pela Cloudflare.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function networkOf(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (IPV4.test(s)) return s;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && IPV4.test(mapped[1])) return mapped[1];
  if (!/^[0-9a-f:]{2,39}$/.test(s) || (s.match(/::/g) || []).length > 1) return 'desconhecido';
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  if ([...h, ...t].some(x => !/^[0-9a-f]{1,4}$/.test(x))) return 'desconhecido';
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return 'desconhecido';
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

// Cookie de aparelho conhecido (só para a política de bloqueio; NÃO autentica nada). Um por conta no mesmo navegador:
//   nome  tatame_dev_<12 hex de SHA-256(id da conta)>      valor  v1.<id da conta>.<emitido em, segundos>.<HMAC, hex>
//   chave HKDF-SHA256(ikm = hash da senha guardado no banco, salt = id da conta, info = "tatame:aparelho-conhecido:v1")
//         -> chave HMAC-SHA256 só desta finalidade (separação de domínio). O cookie não contém senha nem hash.
// Trocar a senha muda o hash e, portanto, a chave: todo cookie anterior deixa de valer sozinho. 90 dias, renovado a cada login.
// Sem estado no banco: logins simultâneos emitem cookies independentes e igualmente válidos (não há o que disputar).
const DEVICE_DAYS = 90, DEVICE_PREFIX = 'tatame_dev_';
const deviceCookieName = async staffId => DEVICE_PREFIX + (await sha256('tatame-dev-name:' + staffId)).slice(0, 12);
async function deviceMac(staff, issued) {
  const ikm = await crypto.subtle.importKey('raw', Uint8Array.from(atob(staff.pass_hash), c => c.charCodeAt(0)), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(staff.id), info: enc.encode('tatame:aparelho-conhecido:v1') }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`v1|${staff.id}|${issued}`)));
}
async function deviceCookie(staff) {
  const issued = Math.floor(Date.now() / 1000);
  return `${await deviceCookieName(staff.id)}=v1.${staff.id}.${issued}.${await deviceMac(staff, issued)}; Path=/api/login; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_DAYS * 86400}`;
}
async function knownDevice(req, staff) {
  if (!staff) return false;
  const v = cookieOf(req, await deviceCookieName(staff.id));
  const m = v && /^v1\.([0-9a-f-]{36})\.(\d{9,11})\.([0-9a-f]{64})$/.exec(v);
  if (!m || m[1] !== staff.id) return false;
  const issued = Number(m[2]), now = Date.now() / 1000;
  if (issued > now + 300 || now - issued >= DEVICE_DAYS * 86400) return false;
  return safeEqual(await deviceMac(staff, issued), m[3]);
}
async function rateLimited(db, pairs) {
  for (const [k, max] of pairs) {
    const r = await first(db, "SELECT count(*) n FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')", k);
    if (r.n >= max) return true;
  }
  return false;
}
// Erros recentes de um e-mail somando todas as redes (faixa de chaves "email:<e-mail>|ip:", usa o índice (key, at)).
const accountFailures = async (db, email) => (await first(db, "SELECT count(*) n FROM login_attempts WHERE key >= ? AND key < ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')", `email:${email}|ip:`, `email:${email}|ip;`)).n;
// Sal fixo para conferir uma senha contra uma conta que não existe: o tempo de resposta fica igual ao de uma conta real.
const GHOST_SALT = 'dGF0YW1lLWdob3N0LXNhbHQ=';
// ---------- recuperação de senha por código ----------
// Duas responsabilidades separadas: (1) VALIDAR um código de uso único (aqui) e (2) ENTREGÁ-LO. Hoje a entrega é manual
// (tools/reset-code.mjs gera o código, grava só o hash e o operador o repassa). Um envio por e-mail futuro troca apenas a entrega.
// V11: erros de terceiros NÃO mexem no código (antes, 5 erros o invalidavam: quem só sabia o e-mail queimava o código do
// dono). Adivinhar 130 bits é inviável; quem limita tentativas são os contadores por (e-mail, rede) e por rede.
const normalizeResetCode = c => String(c || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
const resetCodeHash = (staffId, code) => sha256('tatame-reset:' + staffId + ':' + normalizeResetCode(code));
// ---------- auditoria (V6) ----------
// Catálogo FECHADO: só entra em audit_log evento listado aqui, com alvo do tipo previsto, resultado previsto e `detail` montado
// SÓ com as chaves listadas, cada valor conferido (ids, números, datas, listas fechadas). Nada de texto livre: nome, e-mail,
// telefone, observações, senha, hash, token, cookie ou código não têm chave que os aceite. Violação = erro de programação
// (exceção antes do batch: a operação não acontece), apanhado pelos testes.
// staff_id: só os eventos anteriores à 6.4-C o preenchem, com o significado histórico de cada um (`legacy`: 'actor' = quem fez,
// 'target' = a conta afetada). Eventos novos deixam staff_id NULL e usam só actor_id / target_type / target_id.
const AUD_ID = v => typeof v === 'string' && UUID_RE.test(v);
const AUD_INT = (lo, hi) => v => Number.isInteger(v) && v >= lo && v <= hi;
const AUD_BOOL = v => typeof v === 'boolean';
const AUD_ONE = (...vals) => v => vals.includes(v);
const AUD_NULL = f => v => v === null || f(v);
const AUD_LIST = (f, max) => v => Array.isArray(v) && v.length <= max && v.every(f);
const AUD_NET = v => typeof v === 'string' && v.length <= 45 && (v === 'desconhecido' || /^[0-9a-f.:/]+$/.test(v));
const AUD_OBJ = shape => v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => k in shape && shape[k](v[k]));
const AUD_TXT = max => v => typeof v === 'string' && v.length <= max;
const ROLES = ['admin', 'professor'], STATUSES = ['ativo', 'trancado', 'inativo'];
// Retrato de aula (lesson_updated/lesson_deleted): ids, data, horários, modalidade, marcador e as listas de presença e técnicas,
// para reconstruir a chamada. SEM texto livre: tema (title) e observações (notes) da aula NÃO entram (podem conter dados
// pessoais); não há chave para eles, então o helper recusa se voltarem. Registros gravados antes deste ajuste podem tê-los e
// continuam como estão (nada é reescrito). O "antes" vem do BANCO: conferido por chave e tipo/tamanho, sem exigir o formato
// atual da API (uma aula antiga fora do formato não pode ficar impossível de corrigir ou excluir).
const AUD_KEY = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
const AUD_LESSON = AUD_OBJ({ id: AUD_KEY, class_id: AUD_NULL(AUD_KEY), date: AUD_TXT(10), start_time: AUD_TXT(5), end_time: AUD_TXT(5), modality: AUD_NULL(AUD_TXT(10)),
  instructor_id: AUD_NULL(AUD_KEY), created_by: AUD_NULL(AUD_KEY), created_at: AUD_NULL(AUD_TXT(30)),
  roll_called: AUD_NULL(AUD_ONE(0, 1)), student_ids: AUD_LIST(AUD_KEY, 5000), technique_ids: AUD_LIST(AUD_INT(1, 1e9), 1000) });
const lessonForAudit = ({ title, notes, ...meta }) => meta;   // retira o texto livre da aula antes de auditar
const AUD_GRAD = AUD_OBJ({ belt_since: AUD_NULL(AUD_TXT(10)), degree_since: AUD_NULL(AUD_TXT(10)), imported_classes_belt: AUD_NULL(AUD_INT(0, 1e6)), imported_classes_degree: AUD_NULL(AUD_INT(0, 1e6)) });
const STUDENT_EDIT_FIELDS = ['name', 'nickname', 'birth_date', 'sex', 'phone', 'email', 'start_date', 'prior_months', 'weight_kg', 'goals', 'notes'];
const CLASS_EDIT_FIELDS = ['name', 'weekday', 'start_time', 'end_time', 'level', 'modality', 'instructor_id', 'active'];
const TECH_EDIT_FIELDS = ['name', 'category', 'min_belt', 'difficulty', 'description', 'active'];
const DENY_ACTIONS = ['student_delete', 'student_graduation_fix', 'promotion_undo', 'lesson_update', 'lesson_delete', 'class_delete',
  'technique_create', 'technique_update', 'technique_delete', 'rules_update', 'settings_update', 'staff_create', 'staff_update', 'students_export',
  'lesson_cancel', 'agenda_holiday'];
const TARGET_ID = { staff: AUD_ID, student: AUD_ID, lesson: AUD_ID, promotion: AUD_ID, class: AUD_ID, technique: v => typeof v === 'string' && /^\d{1,10}$/.test(v),
  rules: v => v === null, settings: AUD_ONE('academy_name'), export: AUD_ONE('alunos.csv') };
const PROMO = { aluno: AUD_ID, tipo: AUD_ONE('grau', 'faixa'), de_faixa: AUD_ONE(...BELTS), de_graus: AUD_INT(0, 6), para_faixa: AUD_ONE(...BELTS), para_graus: AUD_INT(0, 6) };
//  target: tipos de alvo aceitos (null = sem alvo); outcomes: resultados aceitos; anon: aceita ator nulo; detail: allowlist;
//  text: texto fixo do formato anterior (sem detail); max: tamanho máximo do JSON (padrão 1024 bytes).
const AUDIT_EVENTS = {
  // ----- anteriores à 6.4-C (mesmo event, mesmo staff_id, mesmo detail; agora também com as colunas estruturadas) -----
  login_ok: { target: ['staff'], outcomes: ['ok'], legacy: 'actor', detail: { rede: AUD_NET, aparelho_conhecido: AUD_BOOL } },
  login_locked: { target: ['staff', null], outcomes: ['limit'], anon: true, legacy: 'target', detail: { limites: AUD_LIST(AUD_ONE('par', 'rede', 'conta'), 3), rede: AUD_NET, conta_existe: AUD_BOOL } },
  reset_failed: { target: ['staff', null], outcomes: ['limit'], anon: true, legacy: 'target', detail: { limites: AUD_LIST(AUD_ONE('par', 'rede'), 2), rede: AUD_NET } },
  reset_used: { target: ['staff'], outcomes: ['ok'], legacy: 'actor', text: 'senha redefinida; sessões encerradas' },
  password_changed: { target: ['staff'], outcomes: ['ok'], legacy: 'actor', detail: { por: AUD_ONE('propria_conta'), sessoes_encerradas: AUD_BOOL, codigos_de_recuperacao_invalidados: AUD_BOOL } },
  password_change_failed: { target: ['staff'], outcomes: ['limit'], legacy: 'actor', detail: { tentativas: AUD_INT(0, 100), janela_min: AUD_INT(1, 1440) } },
  staff_password_reset: { target: ['staff'], outcomes: ['ok'], legacy: 'actor', detail: { conta: AUD_ID, sessoes_encerradas: AUD_BOOL, codigos_de_recuperacao_invalidados: AUD_BOOL } },
  lesson_updated: { target: ['lesson'], outcomes: ['ok'], legacy: 'actor', max: 400000, detail: { lesson_id: AUD_ID, before: AUD_LESSON, after: AUD_OBJ({ class_id: AUD_NULL(AUD_ID), date: isDate, start_time: isTime, end_time: isTime,
    modality: AUD_ONE('gi', 'nogi', 'livre'), instructor_id: AUD_NULL(AUD_ID), roll_called: AUD_NULL(AUD_ONE(0, 1)),
    student_ids: AUD_LIST(AUD_ID, LESSON_STUDENTS_MAX), technique_ids: AUD_LIST(AUD_INT(1, 1e9), LESSON_TECHS_MAX) }) } },
  lesson_deleted: { target: ['lesson'], outcomes: ['ok'], legacy: 'actor', max: 300000, detail: { lesson_id: AUD_ID, before: AUD_LESSON } },
  // ----- Agenda V1: cancelamento/feriado e restauração. SEM o motivo (texto livre fica só em agenda_exceptions). -----
  lesson_cancelled: { target: ['lesson', 'class', null], outcomes: ['ok'], detail: { excecao: AUD_ID, tipo: AUD_ONE('cancel', 'holiday'), data: isDate, turma: AUD_NULL(AUD_ID), aula: AUD_NULL(AUD_ID) } },
  lesson_restored: { target: ['lesson', 'class', null], outcomes: ['ok'], detail: { excecao: AUD_ID, tipo: AUD_ONE('cancel', 'holiday'), data: isDate, turma: AUD_NULL(AUD_ID), aula: AUD_NULL(AUD_ID) } },
  // ----- novos (6.4-C): staff_id NULL -----
  setup_completed: { target: ['staff'], outcomes: ['ok'], detail: { papel: AUD_ONE('admin') } },
  logout: { target: ['staff'], outcomes: ['ok'] },
  staff_created: { target: ['staff'], outcomes: ['ok'], detail: { papel: AUD_ONE(...ROLES) } },
  staff_updated: { target: ['staff'], outcomes: ['ok'], detail: { campos: AUD_LIST(AUD_ONE('name', 'belt'), 2) } },
  staff_role_changed: { target: ['staff'], outcomes: ['ok'], detail: { de: AUD_ONE(...ROLES), para: AUD_ONE(...ROLES) } },
  staff_deactivated: { target: ['staff'], outcomes: ['ok'], detail: { sessoes_encerradas: AUD_BOOL, codigos_de_recuperacao_invalidados: AUD_BOOL } },
  staff_reactivated: { target: ['staff'], outcomes: ['ok'] },
  student_created: { target: ['student'], outcomes: ['ok'], detail: { situacao: AUD_ONE(...STATUSES), faixa: AUD_ONE(...BELTS), graus: AUD_INT(0, 6) } },
  student_updated: { target: ['student'], outcomes: ['ok'], detail: { campos: AUD_LIST(AUD_ONE(...STUDENT_EDIT_FIELDS), STUDENT_EDIT_FIELDS.length) } },
  student_status_changed: { target: ['student'], outcomes: ['ok'], detail: { de: AUD_ONE(...STATUSES), para: AUD_ONE(...STATUSES) } },
  student_graduation_corrected: { target: ['student'], outcomes: ['ok'], detail: { antes: AUD_GRAD, depois: AUD_GRAD } },
  student_deleted: { target: ['student'], outcomes: ['ok'], detail: { presencas: AUD_INT(0, 1e7), graduacoes: AUD_INT(0, 1e5), avaliacoes: AUD_INT(0, 1e7) } },
  promotion_created: { target: ['promotion'], outcomes: ['ok'], detail: { ...PROMO, data: isDate, criterios_cumpridos: AUD_BOOL } },
  promotion_undone: { target: ['promotion'], outcomes: ['ok'], detail: PROMO },
  lesson_created: { target: ['lesson'], outcomes: ['ok'], detail: { turma: AUD_NULL(AUD_ID), data: isDate, alunos: AUD_INT(0, LESSON_STUDENTS_MAX), tecnicas: AUD_INT(0, LESSON_TECHS_MAX), chamada: AUD_ONE(0, 1) } },
  class_created: { target: ['class'], outcomes: ['ok'], detail: { dia: AUD_INT(0, 6), inicio: isTime, fim: isTime, nivel: AUD_ONE('todos', 'iniciante', 'intermediario', 'avancado', 'kids', 'competicao'),
    modalidade: AUD_ONE('gi', 'nogi', 'livre'), ativa: AUD_ONE(0, 1), instrutor: AUD_NULL(AUD_ID) } },
  class_updated: { target: ['class'], outcomes: ['ok'], detail: { campos: AUD_LIST(AUD_ONE(...CLASS_EDIT_FIELDS), CLASS_EDIT_FIELDS.length) } },
  class_deleted: { target: ['class'], outcomes: ['ok'] },
  technique_created: { target: ['technique'], outcomes: ['ok'], detail: { categoria: AUD_ONE(...CATEGORIES), faixa_minima: AUD_ONE(...ADULT), ativa: AUD_ONE(0, 1) } },
  technique_updated: { target: ['technique'], outcomes: ['ok'], detail: { campos: AUD_LIST(AUD_ONE(...TECH_EDIT_FIELDS), TECH_EDIT_FIELDS.length) } },
  technique_deleted: { target: ['technique'], outcomes: ['ok'] },
  rules_updated: { target: ['rules'], outcomes: ['ok'], detail: { faixas: AUD_LIST(AUD_ONE(...BELTS), BELTS.length) } },
  settings_updated: { target: ['settings'], outcomes: ['ok'] },
  students_exported: { target: ['export'], outcomes: ['ok'], detail: { linhas: AUD_INT(0, 1e6) } },
  action_denied: { target: [...Object.keys(TARGET_ID), null], outcomes: ['denied'], detail: { acao: AUD_ONE(...DENY_ACTIONS), motivo: AUD_ONE('requer_admin', 'autoria_ou_prazo', 'ultimo_admin') } }
};
// Valores da linha, já conferidos. target = [tipo, id] ou null. targetSql: id do alvo calculado no banco (técnica recém-criada).
function auditValues(event, { actor = null, target = null, outcome = 'ok', detail = null } = {}, targetSql = false) {
  const spec = Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, event) ? AUDIT_EVENTS[event] : null;
  const fail = why => { throw new Error(`auditoria: ${event}: ${why}`); };
  if (!spec) fail('evento fora do catálogo');
  if (!spec.outcomes.includes(outcome)) fail('resultado não previsto');
  if (actor === null ? !spec.anon : !AUD_ID(actor)) fail('ator inválido');
  if (target !== null && (!Array.isArray(target) || target.length !== 2)) fail('alvo inválido');
  const [tt, tid] = target || [null, null];
  if (!spec.target.includes(tt)) fail('tipo de alvo não previsto');
  if (tt === null ? tid !== null : targetSql ? tid !== null : !TARGET_ID[tt](tid)) fail('id do alvo inválido');
  let text = null;
  if (spec.text) { if (detail !== null) fail('detail não previsto'); text = spec.text; }
  else if (detail !== null) {
    if (!spec.detail || typeof detail !== 'object' || Array.isArray(detail)) fail('detail não previsto');
    for (const k of Object.keys(detail)) if (!Object.prototype.hasOwnProperty.call(spec.detail, k) || !spec.detail[k](detail[k])) fail('chave ou valor fora da lista: ' + k);
    text = JSON.stringify(detail);
    if (enc.encode(text).length > (spec.max || 1024)) fail('detail grande demais');
  }
  const staffId = spec.legacy === 'actor' ? actor : spec.legacy === 'target' ? tid : null;
  return [event, staffId, text, actor, tt, tid, outcome];
}
// Comando de auditoria para entrar NO MESMO batch da escrita. `cond.where`/`cond.params`: a mesma condição da escrita principal
// (o evento só é gravado se a escrita acontece). `cond.targetSql`/`cond.targetParams`: expressão SQL do id do alvo.
function audit(db, event, fields, cond = {}) {
  const [ev, staffId, text, actor, tt, tid, outcome] = auditValues(event, fields, !!cond.targetSql);
  const cols = 'INSERT INTO audit_log (event, staff_id, detail, actor_id, target_type, target_id, outcome)';
  if (!cond.where && !cond.targetSql) return db.prepare(`${cols} VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(ev, staffId, text, actor, tt, tid, outcome);
  const tExpr = cond.targetSql ? `(${cond.targetSql})` : '?', tParams = cond.targetSql ? (cond.targetParams || []) : [tid];
  return db.prepare(`${cols} SELECT ?, ?, ?, ?, ?, ${tExpr}, ? WHERE ${cond.where || '1'}`).bind(ev, staffId, text, actor, tt, ...tParams, outcome, ...(cond.params || []));
}
// Negação com identidade (V6): no máximo UM action_denied por (ator, ação) a cada 15 min (uma conta logada não enche a tabela
// repetindo a mesma tentativa). Melhor esforço: se a gravação falhar, a resposta de negação é a mesma (a auditoria não muda
// o comportamento de segurança da operação).
async function auditDenied(db, actor, acao, motivo, target) {
  try {
    await audit(db, 'action_denied', { actor, target, outcome: 'denied', detail: { acao, motivo } }, { where: `NOT EXISTS (SELECT 1 FROM audit_log WHERE event = 'action_denied'
      AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes') AND actor_id = ? AND json_extract(detail, '$.acao') = ?)`, params: [actor, acao] }).run();
  } catch { /* a negação continua valendo */ }
}
const RESET_BAD = 'Código inválido. Confira o código e o e-mail; se o erro continuar, peça um novo código.';
// ---------- código de ativação (primeiro acesso de uma instalação nova) ----------
// Gerado pelo operador (tools/setup-code.mjs): 26 caracteres Crockford (130 bits), validade limitada. No banco ficam só o
// hash (settings.setup_token_hash) e a validade (settings.setup_token_expires). Sem esses dois, o setup fica FECHADO.
// Mesmo prefixo/normalização do lado da ferramenta (um teste confere os dois lados). Processo separado da recuperação de senha.
const SETUP_HASH_KEY = 'setup_token_hash', SETUP_EXP_KEY = 'setup_token_expires';
const setupCodeHash = code => sha256('tatame-setup:' + normalizeResetCode(code));
const SETUP_DENIED = 'Código de ativação inválido ou expirado. Peça um código novo a quem preparou a instalação.';

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

// Sem data de nascimento, a faixa branca não diz se o aluno segue a trilha infantil ou a adulta: devolve undefined
// (próxima faixa "a definir", escolhida pelo instrutor). Faixas infantis já indicam a trilha infantil.
function nextBelt(st, age) {
  if (st.belt === 'preta') return null;
  if (st.belt === 'branca') return age == null ? undefined : age < 16 ? 'cinza' : 'azul';
  if (KIDS.includes(st.belt)) return st.belt !== 'verde' && (age == null || age < 16) ? KIDS[KIDS.indexOf(st.belt) + 1] : 'azul';
  return ADULT[ADULT.indexOf(st.belt) + 1];
}

function studentMetrics(st, core, today, attByStudent, skillsByStudent, lessonTechs, priorImported) {
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
  // D7: média por semana desde o início do aluno, com denominador limitado a 12 semanas (aluno novo não é diluído por semanas que não existiram).
  // Semanas = ceil((dias desde o início + 1) / 7), no mínimo 1 (sem divisão por zero; início futuro conta como 1).
  const weeksActive = Math.min(12, Math.max(1, Math.ceil((Math.max(0, daysBetween(st.start_date, today)) + 1) / 7)));
  const weekly = att.filter(a => a.date > d84).length / weeksActive;
  const hours = att.reduce((t, a) => t + Math.max(0, minutes(a.end_time) - minutes(a.start_time)), 0) / 60;
  const trainingMonths = Math.max(0, monthsBetween(st.start_date, today)) + (st.prior_months || 0);
  // Experiência total acompanha toda a trajetória: presenças no sistema + aulas importadas da faixa atual +
  // as importadas das faixas anteriores (guardadas em promotions.from_imported_belt, que a promoção zera no aluno) + experiência anterior.
  const expScore = total + (st.imported_classes_belt || 0) + (priorImported || 0) + (st.prior_months || 0) * 8;
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
  // `exact` guarda o valor sem arredondar: met e progress usam o exato; `current` (1 casa) é só para exibição.
  const add = (key, label, current, target, unit) => crit.push({ key, label, current: Math.round(current * 10) / 10, target, unit, met: current >= target, exact: current });
  if (st.degrees < maxDeg) {
    next = { kind: 'grau', to_belt: st.belt, to_degrees: st.degrees + 1 };
    add('months', 'Tempo desde o último grau', Math.max(0, monthsBetween(st.degree_since, today)), r.degree_months, 'meses');
    if (r.degree_classes > 0) add('classes', 'Aulas desde o último grau', sinceDegree, r.degree_classes, 'aulas');
  } else {
    const nb = nextBelt(st, age);
    if (nb !== null) {
      next = { kind: 'faixa', to_belt: nb || null, to_degrees: 0 };
      if (nb === undefined) next.choice_needed = true;
      if (r.belt_months != null) add('months', 'Tempo na faixa', Math.max(0, monthsBetween(st.belt_since, today)), r.belt_months, 'meses');
      if (r.belt_classes != null) add('classes', 'Aulas na faixa', sinceBelt, r.belt_classes, 'aulas');
      if (r.curriculum_pct != null) add('curriculum', 'Currículo dominado (nível ≥ 3)', curriculumPct, r.curriculum_pct, '%');
      // Sem data de nascimento o critério de idade não é avaliado (nem bloqueia): o cadastro fica sinalizado.
      const minAge = st.belt === 'branca' && nb === 'cinza' ? KID_MIN_AGE.cinza : nb === 'azul' && KIDS.includes(st.belt) ? 16 : r.next_min_age;
      if (minAge != null && age != null) add('age', 'Idade mínima (IBJJF)', age, minAge, 'anos');
    }
  }
  const progress = crit.length ? Math.round(crit.reduce((t, c) => t + Math.min(1, c.target > 0 ? c.exact / c.target : 1), 0) / crit.length * 100) : 0;
  const ready = !!next && crit.length > 0 && crit.every(c => c.met);
  // D4: início no futuro é dado inválido (a API recusa, mas o banco pode ter vindo de importação): sem ausência calculável, nunca negativa.
  // D4b: sem nenhuma presença a ausência conta desde o início do cadastro, então o aluno novo só entra em risco após 14 dias.
  const startFuture = st.start_date > today;
  const daysAbsent = last ? Math.max(0, daysBetween(last, today)) : startFuture ? null : daysBetween(st.start_date, today);
  return {
    age, needs_profile: !st.birth_date, data_issues: [...(st.birth_date ? [] : ['sem_nascimento']), ...(startFuture ? ['inicio_futuro'] : [])], classes_total: total, last_attendance: last, days_absent: daysAbsent,
    at_risk: st.status === 'ativo' && daysAbsent !== null && daysAbsent >= 14,
    classes_last_30d: last30, weekly_avg: Math.round(weekly * 10) / 10, mat_hours: Math.round(hours * 10) / 10,
    classes_since_degree: sinceDegree, classes_since_belt: sinceBelt,
    months_in_belt: Math.round(Math.max(0, monthsBetween(st.belt_since, today)) * 10) / 10,
    training_months: Math.round(trainingMonths * 10) / 10,
    experience: { score: expScore, in_belt: sinceBelt, level: expIdx + 1, label: EXPERIENCE[expIdx][1], next_at: EXPERIENCE[expIdx + 1]?.[0] ?? null },
    learning: { pct: learningPct, level: learnIdx + 1, label: LEARNING[learnIdx][1], curriculum_size: curr.length, mastered, curriculum_pct: curriculumPct },
    difficulties: difficulties.slice(0, 10),
    techniques_seen: seen.size,
    next, criteria: crit.map(({ exact, ...c }) => c), progress, ready
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
  // Aulas importadas de faixas anteriores: só graduações de faixa (a de grau não zera imported_classes_belt, contá-la duplicaria).
  const priorImported = new Map((await all(db, "SELECT student_id, SUM(from_imported_belt) n FROM promotions WHERE kind = 'faixa' GROUP BY student_id")).map(r => [r.student_id, r.n || 0]));
  const students = core.students.map(st => ({ ...st, metrics: studentMetrics(st, core, today, attByStudent, skillsByStudent, lessonTechs, priorImported.get(st.id)) }));
  return { core, today, students, attByStudent, skillsByStudent, lessonTechs, lt, lessonDate };
}

async function dashboard(db, C) {
  const { core, today, students } = C;
  const active = students.filter(s => s.status === 'ativo');
  // Só aulas até hoje: uma aula programada para o futuro (Agenda V1) ainda não aconteceu e não entra nas médias nem nos totais.
  const lessons = await all(db, `SELECT l.*, (SELECT count(*) FROM attendance a WHERE a.lesson_id = l.id) n FROM lessons l WHERE l.date > ? AND l.date <= ? ORDER BY l.date`, addDays(today, -7 * 13), today);
  const ws = weekStart(today);
  const weeks = [...Array(12)].map((_, i) => addDays(ws, -7 * (11 - i)));
  const weekly = weeks.map(w => {
    const ls = lessons.filter(l => l.date >= w && l.date < addDays(w, 7));
    const ids = new Set(core.att.filter(a => a.date >= w && a.date < addDays(w, 7)).map(a => a.student_id));
    return { week: w, lessons: ls.length, attendance: ls.reduce((t, l) => t + l.n, 0), unique_students: ids.size };
  });
  const d30 = addDays(today, -30);
  const l30 = lessons.filter(l => l.date > d30);
  // D6: só entra no denominador da média a aula com chamada realizada (marcador roll_called = 1, ou com presentes).
  // Chamada feita com zero presentes conta como aula de presença zero; aula sem chamada (0) e histórico desconhecido (NULL) sem presentes ficam de fora.
  const called = l => l.roll_called === 1 || l.n > 0;
  const avgOf = ls => { const c = ls.filter(called).length; return c ? Math.round(ls.reduce((t, l) => t + l.n, 0) / c * 10) / 10 : 0; };
  const belts = BELTS.map(b => ({ belt: b, count: active.filter(s => s.belt === b).length })).filter(x => x.count);
  // Ocupação por horário fixo (últimas 8 semanas)
  const d56 = addDays(today, -56);
  const occupancy = core.classes.filter(c => c.active).map(c => {
    const ls = lessons.filter(l => l.class_id === c.id && l.date > d56);
    return { class_id: c.id, lessons: ls.length, avg: avgOf(ls) };
  });
  // Presença média por dia da semana e hora
  const heat = {};
  for (const l of lessons.filter(l => l.date > d56)) {
    const wd = new Date(l.date + 'T00:00:00Z').getUTCDay(), h = l.start_time.slice(0, 2);
    const k = `${wd}-${h}`; heat[k] = heat[k] || { weekday: wd, hour: +h, lessons: 0, called: 0, attendance: 0 };
    heat[k].lessons++; heat[k].attendance += l.n; if (called(l)) heat[k].called++;
  }
  const todayWd = new Date(today + 'T00:00:00Z').getUTCDay();
  const todays = core.classes.filter(c => c.active && c.weekday === todayWd).map(c => ({ ...c, lesson: lessons.find(l => l.class_id === c.id && l.date === today) || null }));
  const startMonth = today.slice(0, 8) + '01';
  return {
    today,
    kpis: {
      active_students: active.length,
      new_this_month: active.filter(s => s.start_date >= startMonth && s.start_date <= today).length, // D5: ativos que começaram no mês de referência, sem início futuro
      at_risk: active.filter(s => s.metrics.at_risk).length,
      ready: active.filter(s => s.metrics.ready).length,
      lessons_30d: l30.length,
      avg_per_lesson_30d: avgOf(l30),
      attendance_this_week: weekly[weekly.length - 1].attendance,
      attendance_last_week: weekly[weekly.length - 2].attendance,
      attendance_last_week_same_period: core.att.filter(a => a.date >= addDays(ws, -7) && a.date <= addDays(today, -7)).length
    },
    weekly, belts, occupancy, heat: Object.values(heat).map(({ called: c, ...h }) => ({ ...h, avg: c ? Math.round(h.attendance / c * 10) / 10 : 0 })), todays,
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
    instructor_id: idOf(b.instructor_id, 'Instrutor'),
    active: flag(b.active, 'Ativo', 1)
  };
  if (!isTime(o.start_time) || !isTime(o.end_time)) bad('Informe os horários no formato HH:MM.');
  if (o.end_time <= o.start_time) bad('O horário de término deve ser depois do início.');
  return o;
};

// Estado de uma chamada (campos da aula e listas de presença e técnicas): usado na edição e, sem o texto livre (lessonForAudit), na auditoria.
async function lessonSnapshot(db, id) {
  const l = await first(db, 'SELECT id, class_id, date, start_time, end_time, modality, title, notes, instructor_id, created_by, created_at, roll_called FROM lessons WHERE id = ?', id);
  if (!l) return null;
  l.student_ids = (await all(db, 'SELECT student_id FROM attendance WHERE lesson_id = ? ORDER BY student_id', id)).map(r => r.student_id);
  l.technique_ids = (await all(db, 'SELECT technique_id FROM lesson_techniques WHERE lesson_id = ? ORDER BY technique_id', id)).map(r => r.technique_id);
  return l;
}

// Agenda V1: cancelamento, feriado e reposição vivem em agenda_exceptions (proposta de migração 004, docs/agenda-migracao-004/).
// Enquanto a tabela não existir o recurso fica desligado (rotas respondem 501, a agenda funciona como antes). Só o "sim" é lembrado.
const agExtSeen = new WeakSet();
async function hasAgendaExt(db) {
  if (agExtSeen.has(db)) return true;
  const r = await first(db, "SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'agenda_exceptions'");
  if (r) agExtSeen.add(db);
  return !!r;
}
const activeException = (db, lessonId, classId, date) => first(db, `SELECT * FROM agenda_exceptions WHERE restored_at IS NULL AND (
  (lesson_id IS NOT NULL AND lesson_id = ?) OR (lesson_id IS NULL AND class_id IS NOT NULL AND class_id = ? AND date = ?) OR (kind = 'holiday' AND date = ?)) LIMIT 1`, lessonId || '', classId || '', date, date);

const instructorExists = async (db, id) => { if (id && !(await first(db, 'SELECT id FROM staff WHERE id = ?', id))) bad('Instrutor não encontrado.'); };

async function saveLesson(db, staff, b, id) {
  // Tipos e formatos conferidos antes de qualquer consulta (V7).
  const classIn = idOf(b.class_id, 'Turma'), instructorIn = idOf(b.instructor_id, 'Instrutor');
  const studentIds = [...new Set(list(b.student_ids, 'Alunos da chamada').map(s => idOf(s, 'Aluno da chamada', true)))];
  const techIds = [...new Set(list(b.technique_ids, 'Técnicas da aula').map(t => int(t, 1, 1e9, 'Técnica da aula', true)))];
  // Edição: o estado anterior vem do banco (nunca do cliente) e vai para a auditoria no mesmo batch da alteração.
  const before = id ? await lessonSnapshot(db, id) : null;
  if (id && !before) throw new HttpError(404, 'Aula não encontrada.');
  const ext = await hasAgendaExt(db);
  const cls = classIn ? await first(db, 'SELECT * FROM classes WHERE id = ?', classIn) : null;
  if (classIn && !cls) bad('Turma não encontrada.');
  const o = {
    class_id: cls ? cls.id : null,
    // Agenda V1: a aula pode ser programada para uma data futura (sem chamada). Limite de um ano à frente.
    date: date(b.date, 'Data da aula', true, { future: true }),
    start_time: b.start_time || (cls && cls.start_time), end_time: b.end_time || (cls && cls.end_time),
    modality: oneOf(b.modality, ['gi', 'nogi', 'livre'], 'Modalidade', cls ? cls.modality : 'gi'),
    title: str(b.title, { max: 120, field: 'Tema da aula' }),
    notes: str(b.notes, { max: 2000, field: 'Observações' }),
    // Na edição, sem instrutor informado, o responsável registrado é mantido (corrigir a chamada de outra pessoa não troca o responsável).
    instructor_id: instructorIn || (before ? before.instructor_id : (cls && cls.instructor_id) || staff.id)
  };
  if (!isTime(o.start_time) || !isTime(o.end_time) || o.end_time <= o.start_time) bad('Horário da aula inválido.');
  if (studentIds.length > LESSON_STUDENTS_MAX) bad(`A chamada aceita no máximo ${LESSON_STUDENTS_MAX} alunos.`);
  if (techIds.length > LESSON_TECHS_MAX) bad(`A aula aceita no máximo ${LESSON_TECHS_MAX} técnicas.`);
  const sJson = JSON.stringify(studentIds), tJson = JSON.stringify(techIds);
  // Uma consulta confere alunos e técnicas de uma vez (antes: uma consulta com um parâmetro por item).
  if (studentIds.length || techIds.length) {
    const f = await first(db, 'SELECT (SELECT count(*) FROM students WHERE id IN (SELECT value FROM json_each(?))) s, (SELECT count(*) FROM techniques WHERE id IN (SELECT value FROM json_each(?))) t', sJson, tJson);
    if (f.s !== studentIds.length) bad('Algum aluno da chamada não existe.');
    if (f.t !== techIds.length) bad('Alguma técnica não existe.');
  }
  if (instructorIn && !(await first(db, 'SELECT id FROM staff WHERE id = ?', instructorIn))) bad('Instrutor não encontrado.');
  if (o.date > addDays(todayStr(), AGENDA_AHEAD_DAYS)) bad('A data da aula está longe demais no futuro.');
  if (o.class_id) {
    const dup = await first(db, 'SELECT id FROM lessons WHERE class_id = ? AND date = ? AND id <> ?', o.class_id, o.date, id || '');
    if (dup) throw new HttpError(409, 'Já existe uma chamada desta turma neste dia.');
  }
  // Agenda V1: o mesmo professor não dá duas aulas ao mesmo tempo. Aula nova: vale quando o professor foi escolhido (ou veio da turma).
  // Aula editada: vale quando data, horário ou professor mudaram (corrigir a chamada de uma aula antiga nunca é bloqueado por um conflito
  // que já existia). Quando ninguém foi escolhido o responsável é quem registrou, o que não é uma escala de trabalho e não conflita.
  const deliberate = !!(instructorIn || (cls && cls.instructor_id));
  const moved = !!before && (before.date !== o.date || before.start_time !== o.start_time || before.end_time !== o.end_time || before.instructor_id !== o.instructor_id);
  if (o.instructor_id && (before ? moved : deliberate)) {
    const live = ext ? ' AND NOT EXISTS (SELECT 1 FROM agenda_exceptions x WHERE x.lesson_id = lessons.id AND x.restored_at IS NULL)' : '';   // aula cancelada não ocupa o professor
    const clash = await first(db, 'SELECT start_time, end_time FROM lessons WHERE instructor_id = ? AND date = ? AND id <> ? AND start_time < ? AND end_time > ?' + live + ' ORDER BY start_time LIMIT 1', o.instructor_id, o.date, id || '', o.end_time, o.start_time);
    if (clash) throw new HttpError(409, `O professor já tem aula neste dia, das ${clash.start_time} às ${clash.end_time}.`);
  }
  // D6: marcador de chamada. Com presentes a chamada foi feita. Sem presentes: o valor informado (true = chamada feita, ninguém veio;
  // false = sem chamada); se não informado, aula nova começa "sem chamada" (0) e aula existente mantém o estado (inclusive desconhecido, NULL).
  const rollIn = b.roll_called === undefined || b.roll_called === null ? null : typeof b.roll_called === 'boolean' ? (b.roll_called ? 1 : 0) : bad('Chamada inválida.');
  if (rollIn === 0 && studentIds.length) bad('Há alunos presentes: a chamada não pode ser marcada como não realizada.');
  const roll = studentIds.length ? 1 : rollIn !== null ? rollIn : id ? before.roll_called : 0;
  // Presença é um fato que já aconteceu: aula futura não aceita chamada.
  if (o.date > todayStr() && (studentIds.length || roll === 1)) bad('Aula futura não pode ter chamada.');
  // Aula cancelada (ou dia de feriado) não recebe chamada: restaurar primeiro. Presença já registrada nunca é apagada por isso.
  const realized = !!before && (before.roll_called === 1 || before.student_ids.length > 0);   // aula já realizada: corrigir a chamada nunca é bloqueado
  if ((studentIds.length || roll === 1) && ext && !realized && await activeException(db, id, o.class_id, o.date)) throw new HttpError(409, 'Esta aula está cancelada. Restaure a aula antes de registrar a chamada.');
  const stmts = [];
  if (id) {
    stmts.push(db.prepare('UPDATE lessons SET class_id=?, date=?, start_time=?, end_time=?, modality=?, title=?, notes=?, instructor_id=?, roll_called=? WHERE id=?')
      .bind(o.class_id, o.date, o.start_time, o.end_time, o.modality, o.title, o.notes, o.instructor_id, roll, id));
    stmts.push(db.prepare('DELETE FROM attendance WHERE lesson_id = ?').bind(id));
    stmts.push(db.prepare('DELETE FROM lesson_techniques WHERE lesson_id = ?').bind(id));
    // Só registra se a aula ainda existe no momento do batch (excluída no meio do caminho: o UPDATE não muda nada e não há evento).
    stmts.push(audit(db, 'lesson_updated', { actor: staff.id, target: ['lesson', id], detail: { lesson_id: id, before: lessonForAudit(before),
      after: { ...lessonForAudit(o), roll_called: roll, student_ids: studentIds.slice().sort(), technique_ids: techIds.slice().sort((x, y) => x - y) } } },
      { where: 'EXISTS (SELECT 1 FROM lessons WHERE id = ?)', params: [id] }));
  } else {
    id = uuid();
    stmts.push(db.prepare('INSERT INTO lessons (id, class_id, date, start_time, end_time, modality, title, notes, instructor_id, created_by, roll_called) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, o.class_id, o.date, o.start_time, o.end_time, o.modality, o.title, o.notes, o.instructor_id, staff.id, roll));
    stmts.push(audit(db, 'lesson_created', { actor: staff.id, target: ['lesson', id], detail: { turma: o.class_id, data: o.date, alunos: studentIds.length, tecnicas: techIds.length, chamada: roll } }));
  }
  // Presenças, técnicas e "vista em aula" em 3 comandos fixos, qualquer que seja o tamanho das listas (antes: 1 comando
  // por aluno + 1 por técnica + 1 por aluno x técnica). Mesmo resultado: quem estava na aula passa a ter cada técnica
  // como "vista em aula" (nível 1), sem rebaixar ninguém.
  if (studentIds.length) stmts.push(db.prepare('INSERT INTO attendance (lesson_id, student_id) SELECT ?, value FROM json_each(?)').bind(id, sJson));
  if (techIds.length) stmts.push(db.prepare('INSERT INTO lesson_techniques (lesson_id, technique_id) SELECT ?, value FROM json_each(?)').bind(id, tJson));
  if (studentIds.length && techIds.length) stmts.push(db.prepare(`INSERT INTO skills (student_id, technique_id, level, updated_by)
      SELECT s.value, t.value, 1, ? FROM json_each(?) s, json_each(?) t WHERE true
      ON CONFLICT (student_id, technique_id) DO UPDATE SET level = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = excluded.updated_by WHERE skills.level < 1`).bind(staff.id, sJson, tJson));
  try { await db.batch(stmts); }
  catch (e) {
    // Trava do banco (migração 004): uma requisição simultânea ocupou o professor entre a conferência acima e a gravação.
    if (/conflito_professor/.test(String(e && e.message))) throw new HttpError(409, 'O professor já tem aula neste horário.');
    throw e;
  }
  return id;
}

// Agenda V1: aulas de um período. Mistura as aulas gravadas (lessons) com as ocorrências previstas pelos horários fixos (classes)
// que ainda não têm aula gravada. A recorrência semanal é a própria grade: nada é gerado nem gravado em massa.
async function agenda(db, from, to) {
  const today = todayStr();
  const [classes, lessons, regs] = await Promise.all([
    all(db, 'SELECT c.*, s.name instructor_name FROM classes c LEFT JOIN staff s ON s.id = c.instructor_id WHERE c.active = 1'),
    all(db, `SELECT l.id, l.class_id, l.date, l.start_time, l.end_time, l.modality, l.title, l.instructor_id, l.created_by, l.created_at, l.roll_called,
      c.name class_name, c.level class_level, s.name instructor_name, (SELECT count(*) FROM attendance a WHERE a.lesson_id = l.id) attendees
      FROM lessons l LEFT JOIN classes c ON c.id = l.class_id LEFT JOIN staff s ON s.id = l.instructor_id WHERE l.date BETWEEN ? AND ? ORDER BY l.date, l.start_time LIMIT 1000`, from, to),
    // "Costumam vir": alunos ativos com 2 ou mais presenças na turma nas últimas 8 semanas (para a chamada começar pelos prováveis).
    all(db, `SELECT l.class_id, a.student_id, count(*) n FROM attendance a JOIN lessons l ON l.id = a.lesson_id JOIN students st ON st.id = a.student_id
      WHERE l.class_id IS NOT NULL AND l.date > ? AND st.status = 'ativo' GROUP BY l.class_id, a.student_id HAVING count(*) >= 2 ORDER BY l.class_id, n DESC, a.student_id`, addDays(today, -56))
  ]);
  const items = lessons.map(l => ({ kind: 'lesson', ...l, name: l.class_name || l.title || 'Aula avulsa', class_name: undefined }));
  const have = new Set(lessons.filter(l => l.class_id).map(l => l.class_id + '|' + l.date));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    for (const c of classes) {
      // Só a partir do dia em que a turma foi cadastrada: a grade de hoje não reescreve o passado.
      if (c.weekday !== wd || have.has(c.id + '|' + d) || String(c.created_at).slice(0, 10) > d) continue;
      items.push({ kind: 'planned', class_id: c.id, date: d, start_time: c.start_time, end_time: c.end_time, modality: c.modality, level: c.level,
        instructor_id: c.instructor_id, instructor_name: c.instructor_name, name: c.name });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time) || a.end_time.localeCompare(b.end_time));
  // Cancelamentos, feriados e reposições (só com a migração 004). Aula que já tem chamada continua "realizada": a presença prevalece.
  const ext = await hasAgendaExt(db);
  if (ext) {
    const exc = await all(db, 'SELECT * FROM agenda_exceptions WHERE restored_at IS NULL AND date BETWEEN ? AND ?', from, to);
    const byLesson = new Map(exc.filter(x => x.lesson_id).map(x => [x.lesson_id, x])), byClass = new Map(exc.filter(x => !x.lesson_id && x.class_id).map(x => [x.class_id + '|' + x.date, x]));
    const holiday = new Map(exc.filter(x => x.kind === 'holiday').map(x => [x.date, x]));
    const makeups = new Map((await all(db, `SELECT makeup_lesson_id, date FROM agenda_exceptions WHERE makeup_lesson_id IS NOT NULL AND restored_at IS NULL
      AND makeup_lesson_id IN (SELECT id FROM lessons WHERE date BETWEEN ? AND ?)`, from, to)).map(x => [x.makeup_lesson_id, x.date]));
    for (const it of items) {
      const realized = it.kind === 'lesson' && (it.roll_called === 1 || it.attendees > 0);
      const x = !realized && ((it.id && byLesson.get(it.id)) || (!it.id && byClass.get(it.class_id + '|' + it.date)) || holiday.get(it.date));
      if (x) { it.status = 'cancelled'; it.cancel_kind = x.kind; it.cancel_reason = x.reason; it.exception_id = x.id; if (x.makeup_lesson_id) it.makeup_lesson_id = x.makeup_lesson_id; }
      if (it.id && makeups.has(it.id)) it.makeup_of_date = makeups.get(it.id);
    }
  }
  // Conflito: o mesmo professor em duas aulas que se sobrepõem no mesmo dia (aula cancelada não ocupa o professor).
  const byDay = new Map();
  for (const it of items) if (it.instructor_id && it.status !== 'cancelled') { const k = it.date + '|' + it.instructor_id; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(it); }
  for (const arr of byDay.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++)
    if (arr[i].start_time < arr[j].end_time && arr[j].start_time < arr[i].end_time) arr[i].conflict = arr[j].conflict = true;
  const regulars = {};
  for (const r of regs) { const a = regulars[r.class_id] || (regulars[r.class_id] = []); if (a.length < 40) a.push(r.student_id); }
  return { from, to, today, items, regulars, capabilities: { cancel: ext } };
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
    if (KIDS.includes(toBelt) && toBelt !== 'branca' && (st.metrics.age != null && st.metrics.age >= 16)) bad('Faixas infantis são para alunos com até 15 anos.');
    toDeg = 0;
  }
  const m = st.metrics;
  const criteriaMet = m.next && m.next.kind === kind && (m.next.to_belt === toBelt || (m.next.choice_needed && ['cinza', 'azul'].includes(toBelt))) && m.ready ? 1 : 0;
  if (!criteriaMet && !flag(b.override, 'Confirmação', 0)) throw new HttpError(409, 'O aluno ainda não cumpre todos os critérios. Confirme para graduar mesmo assim.');
  const pid = uuid();
  await db.batch([
    db.prepare(`INSERT INTO promotions (id, student_id, kind, from_belt, from_degrees, to_belt, to_degrees, from_belt_since, from_degree_since, from_imported_belt, from_imported_degree, date, criteria_met, notes, staff_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(pid, id, kind, st.belt, st.degrees, toBelt, toDeg, st.belt_since, st.degree_since, st.imported_classes_belt || 0, st.imported_classes_degree || 0, when, criteriaMet, str(b.notes, { max: 500, field: 'Observação' }), staff.id),
    kind === 'grau'
      ? db.prepare(`UPDATE students SET degrees = ?, degree_since = ?, imported_classes_degree = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(toDeg, when, id)
      : db.prepare(`UPDATE students SET belt = ?, degrees = 0, belt_since = ?, degree_since = ?, imported_classes_belt = 0, imported_classes_degree = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(toBelt, when, when, id),
    audit(db, 'promotion_created', { actor: staff.id, target: ['promotion', pid], detail: { aluno: id, tipo: kind, de_faixa: st.belt, de_graus: st.degrees, para_faixa: toBelt, para_graus: toDeg, data: when, criterios_cumpridos: !!criteriaMet } })
  ]);
  return pid;
}

async function route(req, env, url, ctx) {
  const db = env.DB;
  if (!db) throw new HttpError(500, 'Banco de dados não configurado (binding DB).');
  const method = req.method, path = url.pathname.replace(/\/+$/, '');
  // Corpo limitado ANTES de ler tudo (Content-Length) e depois de ler (corpo sem Content-Length / chunked): 413.
  const body = async () => {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > BODY_MAX) throw new HttpError(413, 'Requisição grande demais.');
    let text; try { text = await req.text(); } catch { bad('Corpo da requisição inválido.'); }
    if (enc.encode(text).length > BODY_MAX) throw new HttpError(413, 'Requisição grande demais.');
    let v; try { v = JSON.parse(text); } catch { bad('Corpo da requisição inválido.'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad('Corpo da requisição inválido.');
    return v;
  };

  // CSRF: toda escrita precisa do cabeçalho do app (navegadores não o enviam em formulários de outros sites).
  if (method !== 'GET' && req.headers.get('x-tatame') !== '1') throw new HttpError(403, 'Requisição bloqueada.');

  if (path === '/api/health') return json({ ok: true });

  if (path === '/api/status' && method === 'GET') {
    const s = await getSettings(db);
    const n = await first(db, 'SELECT count(*) n FROM staff');
    // O código de ativação é sempre exigido no primeiro acesso (nunca há setup sem código).
    return json({ setup_needed: n.n === 0, setup_code_required: n.n === 0, academy_name: s.academy_name || null });
  }

  if (path === '/api/setup' && method === 'POST') {
    const n = await first(db, 'SELECT count(*) n FROM staff');
    if (n.n > 0) throw new HttpError(409, 'A academia já foi configurada.');
    const b = await body();
    if (!b || typeof b !== 'object' || Array.isArray(b)) bad('Corpo da requisição inválido.');
    // Código de ativação OBRIGATÓRIO: sem hash configurado, código errado, curto ou vencido = recusado (falha fechada).
    // O código só é aceito no campo setup_code; o valor nunca é devolvido nem registrado.
    const code = typeof b.setup_code === 'string' ? normalizeResetCode(b.setup_code) : '';
    const given = await setupCodeHash(code);
    const tok = await first(db, 'SELECT (SELECT value FROM settings WHERE key = ?) h, (SELECT value FROM settings WHERE key = ?) e', SETUP_HASH_KEY, SETUP_EXP_KEY);
    const live = !!(tok && typeof tok.h === 'string' && /^[0-9a-f]{64}$/.test(tok.h) && tok.e && Date.parse(tok.e) > Date.now());
    if (!(code.length >= 26 && live && safeEqual(given, tok.h))) throw new HttpError(403, SETUP_DENIED);
    const academy = str(b.academy_name, { min: 2, max: 80, field: 'Nome da academia', required: true });
    const name = str(b.name, { min: 2, max: 80, field: 'Seu nome', required: true });
    const email = checkEmail(b.email), pw = checkPassword(b.password, { email, name });
    const { hash, salt } = await hashPassword(pw);
    const belt = oneOf(b.belt, BELTS, 'Faixa', null);
    const id = uuid();
    // Atomicidade: as verificações acima são só para responder cedo. A decisão vale DENTRO do batch (uma transação no D1):
    // o administrador só é inserido se, naquele instante, não há ninguém na equipe E o hash do código ainda está lá e não
    // venceu. Os demais comandos só agem se esse administrador existe. Duas requisições simultâneas: a segunda encontra a
    // equipe já criada (ou o código já consumido) e não insere nada. Se qualquer comando falhar, nada é gravado (rollback):
    // o código continua válido e não fica administrador sem academia.
    const nowIso = new Date().toISOString();
    const created = 'EXISTS (SELECT 1 FROM staff WHERE id = ?)';
    const res = await db.batch([
      db.prepare(`INSERT INTO staff (id, name, email, pass_hash, pass_salt, role, belt) SELECT ?, ?, ?, ?, ?, 'admin', ?
        WHERE NOT EXISTS (SELECT 1 FROM staff)
          AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)
          AND EXISTS (SELECT 1 FROM settings WHERE key = ? AND value > ?)`).bind(id, name, email, hash, salt, belt, SETUP_HASH_KEY, given, SETUP_EXP_KEY, nowIso),
      db.prepare(`INSERT INTO settings (key, value) SELECT 'academy_name', ? WHERE ${created} ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(academy, id),
      db.prepare(`INSERT INTO settings (key, value) SELECT 'setup_done', '1' WHERE ${created} ON CONFLICT (key) DO UPDATE SET value = '1'`).bind(id),
      db.prepare(`DELETE FROM settings WHERE key IN ('setup_token', ?, ?) AND ${created}`).bind(SETUP_HASH_KEY, SETUP_EXP_KEY, id),
      // Instalação concluída e primeiro administrador: só se ESTE batch criou o administrador (mesma condição dos demais).
      audit(db, 'setup_completed', { actor: id, target: ['staff', id], detail: { papel: 'admin' } }, { where: created, params: [id] })
    ]);
    if (res?.[0]?.meta?.changes !== 1) {
      // Outra requisição concluiu antes (ou o código foi trocado/consumido/venceu entre a conferência e o batch).
      const n2 = await first(db, 'SELECT count(*) n FROM staff');
      if (n2.n > 0) throw new HttpError(409, 'A academia já foi configurada.');
      throw new HttpError(403, SETUP_DENIED);
    }
    return json({ ok: true }, 201, { 'set-cookie': await createSession(db, id) });
  }

  if (path === '/api/login' && method === 'POST') {
    const b = await body();
    const email = String(b.email || '').trim().toLowerCase().slice(0, 120), pw = String(b.password || '');
    const net = networkOf(req.headers.get('cf-connecting-ip'));
    const pairKey = 'email:' + email + '|ip:' + net, ipKey = 'ip:' + net;
    const LOCKED = 'Muitas tentativas. Aguarde 15 minutos e tente de novo.';
    if (await rateLimited(db, [[pairKey, LOGIN_LIMITS.pair], [ipKey, LOGIN_LIMITS.ip]])) throw new HttpError(429, LOCKED);
    const s = await first(db, 'SELECT * FROM staff WHERE email = ? AND active = 1', email);
    const known = await knownDevice(req, s);
    const acct = await accountFailures(db, email);
    if (!known && acct >= LOGIN_LIMITS.account) throw new HttpError(429, LOCKED);
    // Sempre calcula o hash (contra o sal real ou o fantasma), para a resposta não revelar se o e-mail existe.
    const computed = (await hashPassword(pw, s ? s.pass_salt : GHOST_SALT)).hash;
    const ok = !!s && safeEqual(computed, s.pass_hash);
    if (!ok) {
      // Um registro login_locked só quando um limite é atingido por ESTE erro (não uma linha por senha errada).
      const reached = [];
      const counts = await first(db, "SELECT (SELECT count(*) FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')) p, (SELECT count(*) FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')) i", pairKey, ipKey);
      if (counts.p + 1 === LOGIN_LIMITS.pair) reached.push('par');
      if (counts.i + 1 === LOGIN_LIMITS.ip) reached.push('rede');
      if (acct + 1 === LOGIN_LIMITS.account) reached.push('conta');
      await db.batch([
        db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(pairKey), db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(ipKey),
        db.prepare("DELETE FROM login_attempts WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')"),
        ...(reached.length ? [audit(db, 'login_locked', { target: s ? ['staff', s.id] : null, outcome: 'limit', detail: { limites: reached, rede: net, conta_existe: !!s } })] : [])
      ]);
      throw new HttpError(401, 'E-mail ou senha incorretos.');
    }
    // Sucesso: sessão, limpeza do par, auditoria e cookie de aparelho num único batch (tudo ou nada).
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await db.batch([
      db.prepare('INSERT INTO auth_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), s.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString()),
      db.prepare("DELETE FROM auth_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
      db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(pairKey),
      audit(db, 'login_ok', { actor: s.id, target: ['staff', s.id], detail: { rede: net, aparelho_conhecido: known } })
    ]);
    const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    h.append('set-cookie', sessionCookie(token, SESSION_DAYS * 86400));
    h.append('set-cookie', await deviceCookie(s));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
  }

  if (path === '/api/reset' && method === 'POST') {
    const b = await body();
    const email = String(b.email || '').trim().toLowerCase().slice(0, 120), code = normalizeResetCode(b.code);
    const net = networkOf(req.headers.get('cf-connecting-ip'));   // mesma regra do login: IPv4 inteiro, IPv6 por /64
    const pairKey = 'reset:email:' + email + '|ip:' + net, ipKey = 'reset:ip:' + net;
    if (await rateLimited(db, [[pairKey, LOGIN_LIMITS.pair], [ipKey, LOGIN_LIMITS.ip]])) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
    const newPw = checkPassword(b.password, { email });
    if (b.password_confirm !== undefined && b.password_confirm !== newPw) bad('As senhas não conferem.');
    // Erro: só os contadores de tentativa. O código do dono NÃO muda. reset_failed é gravado uma vez, quando ESTE erro atinge
    // um limite (como login_locked), e não a cada tentativa (que deixaria qualquer um encher a auditoria).
    const fail = async staffId => {
      const c = await first(db, "SELECT (SELECT count(*) FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')) p, (SELECT count(*) FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')) i", pairKey, ipKey);
      const reached = [...(c.p + 1 === LOGIN_LIMITS.pair ? ['par'] : []), ...(c.i + 1 === LOGIN_LIMITS.ip ? ['rede'] : [])];
      await db.batch([db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(pairKey), db.prepare('INSERT INTO login_attempts (key) VALUES (?)').bind(ipKey),
        db.prepare("DELETE FROM login_attempts WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')"),
        ...(reached.length ? [audit(db, 'reset_failed', { target: staffId ? ['staff', staffId] : null, outcome: 'limit', detail: { limites: reached, rede: net } })] : [])]);
    };
    const s = await first(db, 'SELECT id FROM staff WHERE email = ? AND active = 1', email);
    const pr = s ? await first(db, 'SELECT * FROM password_resets WHERE staff_id = ?', s.id) : null;
    const given = await resetCodeHash(s ? s.id : 'none', code);
    const match = !!pr && code.length >= 20 && safeEqual(given, pr.code_hash);
    // Mensagem genérica enquanto o código não confere: não revela se o e-mail existe nem se há código pendente.
    if (!match) { await fail(s && pr ? s.id : null); throw new HttpError(400, RESET_BAD); }
    if (pr.used_at) throw new HttpError(400, 'Este código já foi utilizado. Peça um novo código.');
    if (Date.parse(pr.expires_at) <= Date.now()) throw new HttpError(400, 'Este código expirou. Peça um novo código.');
    // Consumo atômico e sem estado parcial (antes: o código era marcado como usado num comando separado, ANTES da senha; se a
    // gravação da senha falhasse, o dono perdia o código sem ter redefinido nada). Agora é um único batch: cada comando só age
    // se o código ainda está pendente, válido e com este hash, e o consumo é o ÚLTIMO comando. Uma segunda requisição
    // (simultânea ou repetida) encontra o código já usado e não muda nada. Falha em qualquer comando: rollback, código intacto.
    const { hash, salt } = await hashPassword(newPw);
    const nowIso = new Date().toISOString();
    const pending = 'EXISTS (SELECT 1 FROM password_resets WHERE staff_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?)';
    const P = [s.id, given, nowIso];
    const res = await db.batch([
      db.prepare(`UPDATE staff SET pass_hash = ?, pass_salt = ? WHERE id = ? AND active = 1 AND ${pending}`).bind(hash, salt, s.id, ...P),
      db.prepare(`DELETE FROM auth_sessions WHERE staff_id = ? AND ${pending}`).bind(s.id, ...P),
      db.prepare(`DELETE FROM login_attempts WHERE (key = ? OR key = ?) AND ${pending}`).bind(pairKey, 'email:' + email + '|ip:' + net, ...P),
      audit(db, 'reset_used', { actor: s.id, target: ['staff', s.id] }, { where: pending, params: P }),
      db.prepare("UPDATE password_resets SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE staff_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(...P)
    ]);
    if (res?.[4]?.meta?.changes !== 1) throw new HttpError(400, 'Este código já foi utilizado. Peça um novo código.');
    return json({ ok: true });
  }

  if (path === '/api/logout' && method === 'POST') {
    const t = cookieOf(req, COOKIE);
    if (t) {
      // Logout de uma sessão que existe: o evento e o fim da sessão no mesmo batch, e o evento só se a sessão ainda existe naquele
      // instante (dois logouts simultâneos: um evento). Sem sessão (cookie vencido, forjado ou ausente): nada a registrar.
      const th = await sha256(t);
      const sess = /^[0-9a-f]{64}$/.test(t) ? await first(db, 'SELECT staff_id FROM auth_sessions WHERE token_hash = ?', th) : null;
      // Sair SEMPRE encerra a sessão (é a operação que aumenta a segurança; a auditoria não pode impedi-la): se o evento não puder
      // ser montado ou gravado, a sessão é apagada sozinha. Única exceção ao "tudo ou nada"; a exportação, ao contrário, falha fechada.
      let ev = null;
      try { if (sess) ev = audit(db, 'logout', { actor: sess.staff_id, target: ['staff', sess.staff_id] }, { where: 'EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ? AND staff_id = ?)', params: [th, sess.staff_id] }); } catch { ev = null; }
      const end = () => db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(th);
      try { await db.batch([...(ev ? [ev] : []), end()]); } catch (e) { if (!ev) throw e; await end().run(); }
    }
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  // ---------- daqui em diante: só equipe logada ----------
  const me = await currentStaff(req, db, ctx);
  if (!me) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
  // Matriz de acesso (ver README, "Perfis"). Professor faz o dia a dia; o que está marcado com admin() é só do administrador.
  // Editar ou excluir chamada e desfazer graduação: o professor só mexe no que ele mesmo registrou há menos de OWN_DAYS dias.
  // V6: cada negação abaixo deixa um action_denied (ação tentada + motivo + alvo, sem dados), com o limite de auditDenied. A regra
  // de autorização e a resposta não mudam: a gravação acontece antes do throw e não pode trocá-lo.
  const admin = async (acao, target = null) => { if (me.role !== 'admin') { await auditDenied(db, me.id, acao, 'requer_admin', target); throw new HttpError(403, 'Apenas o administrador pode fazer isso.'); } };
  const OWN_DAYS = 7;
  const ownRecent = async (staffId, createdAt, what, acao, target) => {
    if (me.role === 'admin') return;
    // Autoria e idade vêm do registro no banco (created_by, created_at), nunca do corpo da requisição. Com OWN_DAYS dias ou mais: negado.
    if (staffId !== me.id || !(Date.now() - Date.parse(createdAt) < OWN_DAYS * 864e5)) {
      await auditDenied(db, me.id, acao, 'autoria_ou_prazo', target);
      throw new HttpError(403, `Só o administrador altera ou exclui ${what} de outra pessoa ou com ${OWN_DAYS} dias ou mais.`);
    }
  };
  let m;

  if (path === '/api/me' && method === 'GET') return json({ me, settings: await getSettings(db) });
  // V9: troca da própria senha. Limite de PW_CHANGE_MAX conferências da senha atual por conta em 15 min (vale de qualquer IP:
  // a chave é a conta). Cada tentativa RESERVA a vaga antes de calcular o hash, num único INSERT condicionado (atômico): mesmo
  // com requisições simultâneas, no máximo PW_CHANGE_MAX conferências acontecem na janela. Senha atual certa zera o contador.
  if (path === '/api/me/password' && method === 'PUT') {
    const b = await body();
    const s = await first(db, 'SELECT * FROM staff WHERE id = ?', me.id);
    const newPw = checkPassword(b.password, { email: s.email, name: s.name });   // política antes: não gasta vaga nem revela nada
    const pwKey = 'pwchange:' + me.id;
    const slot = await run(db, `INSERT INTO login_attempts (key) SELECT ? WHERE (SELECT count(*) FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')) < ?`, pwKey, pwKey, PW_CHANGE_MAX);
    if (slot.meta?.changes !== 1) throw new HttpError(429, 'Muitas tentativas de troca de senha. Aguarde 15 minutos e tente de novo.');
    if (!safeEqual((await hashPassword(typeof b.current === 'string' ? b.current : '', s.pass_salt)).hash, s.pass_hash)) {
      // Uma linha password_change_failed só quando ESTE erro esgota o limite (não uma por tentativa).
      const used = (await first(db, "SELECT count(*) n FROM login_attempts WHERE key = ? AND at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')", pwKey)).n;
      if (used === PW_CHANGE_MAX) await audit(db, 'password_change_failed', { actor: me.id, target: ['staff', me.id], outcome: 'limit', detail: { tentativas: used, janela_min: 15 } }).run();
      bad('Senha atual incorreta.');
    }
    await run(db, 'DELETE FROM login_attempts WHERE key = ?', pwKey);   // senha atual provada: o contador volta a zero
    // Só depois de provar a senha atual (senão viraria um oráculo para adivinhá-la): a nova precisa ser diferente.
    if (safeEqual((await hashPassword(newPw, s.pass_salt)).hash, s.pass_hash)) bad('A senha nova precisa ser diferente da atual.');
    const { hash, salt } = await hashPassword(newPw);
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    // Tudo ou nada: senha, fim das outras sessões, códigos de recuperação pendentes, contador, auditoria e a sessão nova.
    await db.batch([
      db.prepare('UPDATE staff SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, me.id),
      db.prepare('DELETE FROM auth_sessions WHERE staff_id = ?').bind(me.id),
      db.prepare('DELETE FROM password_resets WHERE staff_id = ?').bind(me.id),
      db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(pwKey),
      audit(db, 'password_changed', { actor: me.id, target: ['staff', me.id], detail: { por: 'propria_conta', sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } }),
      db.prepare('INSERT INTO auth_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), me.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString())
    ]);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
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
    await db.batch([
      db.prepare(`INSERT INTO students (id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`).bind(id, ...cols.map(c => o[c])),
      audit(db, 'student_created', { actor: me.id, target: ['student', id], detail: { situacao: o.status, faixa: o.belt, graus: o.degrees } })
    ]);
    return json(await studentDetail(db, id), 201);
  }
  if ((m = path.match(/^\/api\/students\/([0-9a-f-]{36})$/))) {
    const id = m[1];
    if (method === 'GET') return json(await studentDetail(db, id));
    const ex = await first(db, 'SELECT * FROM students WHERE id = ?', id);
    if (!ex) throw new HttpError(404, 'Aluno não encontrado.');
    const T = ['student', id], alive = { where: 'EXISTS (SELECT 1 FROM students WHERE id = ?)', params: [id] };
    if (method === 'PUT') {
      let o;
      try { o = await STUDENT_FIELDS(await body(), ex, me.role === 'admin'); }
      catch (e) { if (e instanceof HttpError && e.status === 403) await auditDenied(db, me.id, 'student_graduation_fix', 'requer_admin', T); throw e; }
      const cols = Object.keys(o);
      // Eventos (V6) no mesmo batch e ANTES do UPDATE (as condições olham o estado anterior): só nomes de campos, nunca valores
      // pessoais; situação com de/para; correção de graduação (só admin) com os valores de antes e depois (datas e contagens).
      const same = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));
      const campos = STUDENT_EDIT_FIELDS.filter(k => k in o && !same(o[k], ex[k]));
      const grad = GRADUATION_FIELDS.filter(k => k in o && !same(o[k], ex[k]));
      const evs = [];
      if (campos.length) evs.push(audit(db, 'student_updated', { actor: me.id, target: T, detail: { campos } }, alive));
      if (o.status !== ex.status) evs.push(audit(db, 'student_status_changed', { actor: me.id, target: T, detail: { de: ex.status, para: o.status } },
        { where: 'EXISTS (SELECT 1 FROM students WHERE id = ? AND status <> ?)', params: [id, o.status] }));
      if (grad.length) { const antes = Object.fromEntries(GRADUATION_FIELDS.map(k => [k, ex[k]])); evs.push(audit(db, 'student_graduation_corrected', { actor: me.id, target: T, detail: { antes, depois: { ...antes, ...Object.fromEntries(grad.map(k => [k, o[k]])) } } }, alive)); }
      await db.batch([...evs, db.prepare(`UPDATE students SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(...cols.map(c => o[c]), id)]);
      return json(await studentDetail(db, id));
    }
    if (method === 'DELETE') {
      await admin('student_delete', T);
      // V12 (6.4-D): exclusão definitiva só de aluno SEM histórico (nenhuma presença, graduação, avaliação ou registro de
      // avaliação). Com histórico: 409 e nada muda; o caminho é inativar (PUT com status). As cascatas do schema continuam lá,
      // mas a API nunca chega a usá-las. A condição vale DENTRO do batch (estado do banco naquele instante, não o lido antes):
      // o evento vem primeiro com a mesma condição e o DELETE é o último comando; o número de linhas apagadas decide a resposta.
      // Histórico criado em paralelo (chamada gravada ao mesmo tempo) ou outra exclusão simultânea: nada apagado, nenhum evento.
      const noHistory = `EXISTS (SELECT 1 FROM students WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM attendance WHERE student_id = ?)
        AND NOT EXISTS (SELECT 1 FROM promotions WHERE student_id = ?) AND NOT EXISTS (SELECT 1 FROM skills WHERE student_id = ?)
        AND NOT EXISTS (SELECT 1 FROM skill_history WHERE student_id = ?)`, NH = Array(5).fill(id);
      // Formato do evento aprovado na 6.4-C mantido: as contagens são 0 por construção (a mesma condição as garante).
      const res = await db.batch([
        audit(db, 'student_deleted', { actor: me.id, target: T, detail: { presencas: 0, graduacoes: 0, avaliacoes: 0 } }, { where: noHistory, params: NH }),
        db.prepare(`DELETE FROM students WHERE id = ? AND ${noHistory}`).bind(id, ...NH)
      ]);
      if (res?.[1]?.meta?.changes !== 1) {
        if (!(await first(db, 'SELECT 1 x FROM students WHERE id = ?', id))) throw new HttpError(404, 'Aluno não encontrado.');
        throw new HttpError(409, 'Este aluno tem histórico (presenças, graduações ou avaliações) e não pode ser excluído. Marque como inativo para preservar o histórico.');
      }
      return json({ ok: true });
    }
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
    if (!items.length) bad('Nenhuma avaliação enviada.');
    if (items.length > SKILLS_MAX) bad(`No máximo ${SKILLS_MAX} avaliações por vez.`);
    // Valida tudo em memória; depois UMA consulta confere as técnicas e 2 comandos gravam o lote inteiro (antes: 1 consulta
    // por item + 2 comandos por item). Técnica repetida no mesmo lote é recusada (antes: a última vencia, em silêncio).
    if (items.some(it => !it || typeof it !== 'object' || Array.isArray(it))) bad('Avaliação inválida.');
    const rows = items.map(it => ({ t: int(it.technique_id, 1, 1e9, 'Técnica', true), l: int(it.level, 0, 5, 'Nível', true), n: str(it.note, { max: 300, field: 'Observação' }) }));
    if (new Set(rows.map(r => r.t)).size !== rows.length) bad('A mesma técnica aparece mais de uma vez.');
    const rJson = JSON.stringify(rows);
    const found = await first(db, "SELECT count(*) n FROM techniques WHERE id IN (SELECT json_extract(value, '$.t') FROM json_each(?))", rJson);
    if (found.n !== rows.length) bad('Técnica não encontrada.');
    await db.batch([
      db.prepare(`INSERT INTO skills (student_id, technique_id, level, note, updated_by)
        SELECT ?, json_extract(value, '$.t'), json_extract(value, '$.l'), json_extract(value, '$.n'), ? FROM json_each(?) WHERE true
        ON CONFLICT (student_id, technique_id) DO UPDATE SET level = excluded.level, note = excluded.note, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(m[1], me.id, rJson),
      db.prepare("INSERT INTO skill_history (student_id, technique_id, level, staff_id) SELECT ?, json_extract(value, '$.t'), json_extract(value, '$.l'), ? FROM json_each(?) ORDER BY key").bind(m[1], me.id, rJson)
    ]);
    return json(await studentDetail(db, m[1]));
  }
  if ((m = path.match(/^\/api\/promotions\/([0-9a-f-]{36})$/)) && method === 'DELETE') {
    const p = await first(db, 'SELECT * FROM promotions WHERE id = ?', m[1]);
    if (!p) throw new HttpError(404, 'Graduação não encontrada.');
    await ownRecent(p.staff_id, p.created_at, 'graduações', 'promotion_undo', ['promotion', p.id]);
    const latest = await first(db, 'SELECT id FROM promotions WHERE student_id = ? ORDER BY date DESC, created_at DESC LIMIT 1', p.student_id);
    if (latest.id !== p.id) bad('Só é possível desfazer a graduação mais recente do aluno.');
    await db.batch([
      // A graduação desfeita (de/para dela). Só se ainda existe no batch: dois "desfazer" simultâneos geram um evento.
      audit(db, 'promotion_undone', { actor: me.id, target: ['promotion', p.id], detail: { aluno: p.student_id, tipo: p.kind, de_faixa: p.from_belt, de_graus: p.from_degrees, para_faixa: p.to_belt, para_graus: p.to_degrees } },
        { where: 'EXISTS (SELECT 1 FROM promotions WHERE id = ?)', params: [p.id] }),
      db.prepare(`UPDATE students SET belt = ?, degrees = ?, belt_since = ?, degree_since = ?, imported_classes_belt = ?, imported_classes_degree = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .bind(p.from_belt, p.from_degrees, p.from_belt_since, p.from_degree_since, p.from_imported_belt, p.from_imported_degree, p.student_id),
      db.prepare('DELETE FROM promotions WHERE id = ?').bind(p.id)
    ]);
    return json(await studentDetail(db, p.student_id));
  }

  // ---------- turmas / horários ----------
  if (path === '/api/classes' && method === 'POST') {
    const o = CLASS_FIELDS(await body()); await instructorExists(db, o.instructor_id); const id = uuid();
    await db.batch([
      db.prepare('INSERT INTO classes (id, name, weekday, start_time, end_time, level, modality, instructor_id, active) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, o.name, o.weekday, o.start_time, o.end_time, o.level, o.modality, o.instructor_id, o.active),
      audit(db, 'class_created', { actor: me.id, target: ['class', id], detail: { dia: o.weekday, inicio: o.start_time, fim: o.end_time, nivel: o.level, modalidade: o.modality, ativa: o.active, instrutor: o.instructor_id } })
    ]);
    return json(await first(db, 'SELECT * FROM classes WHERE id = ?', id), 201);
  }
  if ((m = path.match(/^\/api\/classes\/([0-9a-f-]{36})$/))) {
    const ex = await first(db, 'SELECT * FROM classes WHERE id = ?', m[1]);
    if (!ex) throw new HttpError(404, 'Turma não encontrada.');
    const T = ['class', ex.id], alive = { where: 'EXISTS (SELECT 1 FROM classes WHERE id = ?)', params: [ex.id] };
    if (method === 'PUT') {
      const o = CLASS_FIELDS(await body()); await instructorExists(db, o.instructor_id);
      const campos = CLASS_EDIT_FIELDS.filter(k => (o[k] ?? null) !== (ex[k] ?? null));
      await db.batch([
        db.prepare('UPDATE classes SET name=?, weekday=?, start_time=?, end_time=?, level=?, modality=?, instructor_id=?, active=? WHERE id=?').bind(o.name, o.weekday, o.start_time, o.end_time, o.level, o.modality, o.instructor_id, o.active, m[1]),
        ...(campos.length ? [audit(db, 'class_updated', { actor: me.id, target: T, detail: { campos } }, alive)] : [])
      ]);
      return json(await first(db, 'SELECT * FROM classes WHERE id = ?', m[1]));
    }
    if (method === 'DELETE') {
      await admin('class_delete', T);
      await db.batch([audit(db, 'class_deleted', { actor: me.id, target: T }, alive), db.prepare('DELETE FROM classes WHERE id = ?').bind(ex.id)]);
      return json({ ok: true });
    }
  }

  // ---------- aulas e chamada ----------
  // Agenda V1 (leitura): qualquer pessoa da equipe logada, como a lista de aulas.
  if (path === '/api/agenda' && method === 'GET') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!isDate(from) || !isDate(to) || to < from) bad('Período inválido.');
    if (dnum(to) - dnum(from) >= AGENDA_MAX_DAYS) bad(`A agenda mostra no máximo ${AGENDA_MAX_DAYS} dias por vez.`);
    return json(await agenda(db, from, to));
  }
  // Cancelamento, feriado e reposição (Agenda V1, depende da migração 004: sem a tabela, 501). Nada é apagado: cancelar grava uma exceção
  // à parte; restaurar a encerra (o registro fica). Regras de acesso REUSADAS: aula gravada = autor + prazo ou admin (como editar/excluir
  // chamada); turma da grade e feriado = só admin (como editar horários).
  if (path === '/api/agenda/exceptions' || /^\/api\/agenda\/exceptions\/[0-9a-f-]{36}\/(restore|makeup)$/.test(path)) {
    if (method !== 'POST') throw new HttpError(405, 'Método não permitido.');
    if (!(await hasAgendaExt(db))) throw new HttpError(501, 'Cancelamento de aulas ainda não está disponível nesta instalação.');
    const noDup = e => { if (/UNIQUE|FOREIGN KEY/.test(String(e && e.message))) throw new HttpError(409, 'Esta aula já está cancelada ou mudou. Atualize a agenda.'); if (/conflito_professor/.test(String(e && e.message))) throw new HttpError(409, 'O professor já tem aula neste horário.'); throw e; };
    const evFields = x => ({ excecao: x.id, tipo: x.kind, data: x.date, turma: x.class_id, aula: x.lesson_id });
    const evTarget = x => x.lesson_id ? ['lesson', x.lesson_id] : x.class_id ? ['class', x.class_id] : null;
    // Quem pode agir sobre uma exceção existente (restaurar, marcar reposição).
    const guard = async x => {
      if (x.kind === 'holiday') return admin('agenda_holiday');
      if (!x.lesson_id) return admin('lesson_cancel', ['class', x.class_id]);
      const l = await first(db, 'SELECT id, created_by, created_at FROM lessons WHERE id = ?', x.lesson_id);
      if (!l) throw new HttpError(404, 'Aula não encontrada.');
      return ownRecent(l.created_by, l.created_at, 'aulas', 'lesson_cancel', ['lesson', l.id]);
    };
    if (path === '/api/agenda/exceptions') {
      const b = await body();
      const kind = oneOf(b.kind, ['cancel', 'holiday'], 'Tipo', null) || bad('Escolha cancelar a aula ou marcar feriado.');
      // Aula gravada: a data vem da própria aula. Turma da grade e feriado: data obrigatória.
      let day = kind === 'cancel' && b.lesson_id ? null : date(b.date, 'Data', true, { future: true });
      if (day && day > addDays(todayStr(), AGENDA_AHEAD_DAYS)) bad('A data está longe demais no futuro.');
      const reason = str(b.reason, { min: 3, max: 200, field: 'Motivo', required: true });
      let classId = null, lessonId = null;
      if (kind === 'holiday') await admin('agenda_holiday');
      else if (b.lesson_id) {
        lessonId = idOf(b.lesson_id, 'Aula', true);
        const l = await first(db, 'SELECT id, class_id, date, created_by, created_at, roll_called, (SELECT count(*) FROM attendance a WHERE a.lesson_id = lessons.id) n FROM lessons WHERE id = ?', lessonId);
        if (!l) throw new HttpError(404, 'Aula não encontrada.');
        await ownRecent(l.created_by, l.created_at, 'aulas', 'lesson_cancel', ['lesson', l.id]);
        if (l.n > 0 || l.roll_called === 1) throw new HttpError(409, 'Esta aula já tem chamada. Corrija a chamada em vez de cancelar: a presença registrada é preservada.');
        classId = l.class_id; day = l.date;
      } else {
        classId = idOf(b.class_id, 'Turma', true);
        await admin('lesson_cancel', ['class', classId]);
        const c = await first(db, 'SELECT id, weekday FROM classes WHERE id = ? AND active = 1', classId);
        if (!c) throw new HttpError(404, 'Turma não encontrada.');
        if (c.weekday !== new Date(day + 'T00:00:00Z').getUTCDay()) bad('Esta turma não tem aula neste dia da semana.');
        if (await first(db, 'SELECT id FROM lessons WHERE class_id = ? AND date = ?', classId, day)) throw new HttpError(409, 'Esta aula já está gravada na agenda. Cancele-a pela própria aula.');
      }
      const x = { id: uuid(), kind, date: day, class_id: classId, lesson_id: lessonId };
      try {
        await db.batch([db.prepare('INSERT INTO agenda_exceptions (id, kind, date, class_id, lesson_id, reason, created_by) VALUES (?,?,?,?,?,?,?)').bind(x.id, kind, day, classId, lessonId, reason, me.id),
          audit(db, 'lesson_cancelled', { actor: me.id, target: evTarget(x), detail: evFields(x) })]);
      } catch (e) { noDup(e); }
      return json({ ...x, reason, status: 'cancelled' }, 201);
    }
    const [, xid, what] = path.match(/^\/api\/agenda\/exceptions\/([0-9a-f-]{36})\/(restore|makeup)$/);
    const x = await first(db, 'SELECT * FROM agenda_exceptions WHERE id = ?', xid);
    if (!x) throw new HttpError(404, 'Cancelamento não encontrado.');
    if (x.restored_at) throw new HttpError(409, 'Esta aula já foi restaurada.');
    await guard(x);
    if (what === 'restore') {
      try {
        await db.batch([audit(db, 'lesson_restored', { actor: me.id, target: evTarget(x), detail: evFields(x) }, { where: 'EXISTS (SELECT 1 FROM agenda_exceptions WHERE id = ? AND restored_at IS NULL)', params: [x.id] }),
          db.prepare("UPDATE agenda_exceptions SET restored_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), restored_by = ? WHERE id = ? AND restored_at IS NULL").bind(me.id, x.id)]);
      } catch (e) { noDup(e); }
      return json({ ok: true });
    }
    // Reposição: uma aula nova (sem chamada) ligada ao cancelamento. Um cancelamento tem no máximo uma reposição.
    if (x.kind !== 'cancel') bad('Reposição só vale para uma aula cancelada, não para feriado.');
    if (x.makeup_lesson_id) throw new HttpError(409, 'Este cancelamento já tem uma reposição marcada.');
    const b = await body();
    const src = x.lesson_id ? await first(db, 'SELECT class_id, start_time, end_time, modality, title, instructor_id FROM lessons WHERE id = ?', x.lesson_id) : null;
    const cls = x.class_id ? await first(db, 'SELECT id, name, weekday, start_time, end_time, modality, instructor_id FROM classes WHERE id = ?', x.class_id) : null;
    const base = src || cls || {};
    const day = date(b.date, 'Data da reposição', true, { future: true });
    if (day < todayStr()) bad('A reposição precisa ser hoje ou em uma data futura.');
    // Com a turma: ajuda "costumam vir"; mas no dia da semana da própria turma a aula já existe na grade, então vai sem turma.
    const keepClass = cls && cls.weekday !== new Date(day + 'T00:00:00Z').getUTCDay() ? cls.id : null;
    const id = await saveLesson(db, me, { class_id: keepClass, date: day, start_time: b.start_time || base.start_time, end_time: b.end_time || base.end_time,
      modality: b.modality || base.modality, instructor_id: b.instructor_id || base.instructor_id || null,
      title: b.title || `Reposição: ${(cls && cls.name) || (src && src.title) || 'aula'}`.slice(0, 120), student_ids: [], technique_ids: [] }, null);
    await run(db, 'UPDATE agenda_exceptions SET makeup_lesson_id = ? WHERE id = ? AND makeup_lesson_id IS NULL AND restored_at IS NULL', id, x.id);
    return json(await lessonOut(db, id), 201);
  }
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
    // V3: a edição substitui a lista de presença inteira, então segue a MESMA regra da exclusão (autor + menos de OWN_DAYS dias, ou admin).
    if (method === 'PUT') { await ownRecent(ex.created_by, ex.created_at, 'chamadas', 'lesson_update', ['lesson', ex.id]); await saveLesson(db, me, await body(), m[1]); return json(await lessonOut(db, m[1])); }
    if (method === 'DELETE') {
      await ownRecent(ex.created_by, ex.created_at, 'chamadas', 'lesson_delete', ['lesson', ex.id]);
      const before = await lessonSnapshot(db, m[1]);
      // Evento só se a aula ainda existe no batch (duas exclusões simultâneas: um evento, como uma exclusão).
      await db.batch([audit(db, 'lesson_deleted', { actor: me.id, target: ['lesson', m[1]], detail: { lesson_id: m[1], before: lessonForAudit(before) } }, { where: 'EXISTS (SELECT 1 FROM lessons WHERE id = ?)', params: [m[1]] }),
        db.prepare('DELETE FROM lessons WHERE id = ?').bind(m[1])]);
      return json({ ok: true });
    }
  }

  // ---------- técnicas ----------
  const TECH = b => ({
    name: str(b.name, { min: 2, max: 80, field: 'Nome da técnica', required: true }),
    category: oneOf(b.category, CATEGORIES, 'Categoria', null) || bad('Escolha a categoria.'),
    min_belt: oneOf(b.min_belt, ADULT, 'Faixa', 'branca'),
    difficulty: int(b.difficulty ?? 2, 1, 5, 'Dificuldade'),
    description: str(b.description, { max: 500, field: 'Descrição' }),
    active: flag(b.active, 'Ativa', 1)
  });
  if (path === '/api/techniques' && method === 'POST') {
    await admin('technique_create');
    const o = TECH(await body());
    if (await first(db, 'SELECT id FROM techniques WHERE name = ? COLLATE NOCASE', o.name)) throw new HttpError(409, 'Já existe uma técnica com esse nome.');
    // O id (autoincremento) só existe depois do INSERT: o evento, no mesmo batch, busca-o pelo nome (UNIQUE) logo em seguida.
    await db.batch([
      db.prepare('INSERT INTO techniques (name, category, min_belt, difficulty, description, active) VALUES (?,?,?,?,?,?)').bind(o.name, o.category, o.min_belt, o.difficulty, o.description, o.active),
      audit(db, 'technique_created', { actor: me.id, target: ['technique', null], detail: { categoria: o.category, faixa_minima: o.min_belt, ativa: o.active } },
        { targetSql: 'SELECT CAST(id AS TEXT) FROM techniques WHERE name = ?', targetParams: [o.name] })
    ]);
    return json(await first(db, 'SELECT * FROM techniques WHERE name = ?', o.name), 201);
  }
  if ((m = path.match(/^\/api\/techniques\/(\d+)$/))) {
    await admin(method === 'DELETE' ? 'technique_delete' : 'technique_update', /^\d{1,10}$/.test(m[1]) ? ['technique', m[1]] : null);
    const ex = await first(db, 'SELECT * FROM techniques WHERE id = ?', +m[1]);
    if (!ex) throw new HttpError(404, 'Técnica não encontrada.');
    const T = ['technique', String(ex.id)], alive = { where: 'EXISTS (SELECT 1 FROM techniques WHERE id = ?)', params: [ex.id] };
    if (method === 'PUT') {
      const o = TECH(await body());
      if (await first(db, 'SELECT id FROM techniques WHERE name = ? COLLATE NOCASE AND id <> ?', o.name, ex.id)) throw new HttpError(409, 'Já existe uma técnica com esse nome.');
      const campos = TECH_EDIT_FIELDS.filter(k => (o[k] ?? null) !== (ex[k] ?? null));
      await db.batch([
        db.prepare('UPDATE techniques SET name=?, category=?, min_belt=?, difficulty=?, description=?, active=? WHERE id=?').bind(o.name, o.category, o.min_belt, o.difficulty, o.description, o.active, ex.id),
        ...(campos.length ? [audit(db, 'technique_updated', { actor: me.id, target: T, detail: { campos } }, alive)] : [])
      ]);
      return json(await first(db, 'SELECT * FROM techniques WHERE id = ?', ex.id));
    }
    if (method === 'DELETE') {
      const used = await first(db, 'SELECT (SELECT count(*) FROM lesson_techniques WHERE technique_id = ?) + (SELECT count(*) FROM skills WHERE technique_id = ?) n', ex.id, ex.id);
      if (used.n) bad('Essa técnica já tem aulas ou avaliações. Desative em vez de excluir.');
      await db.batch([audit(db, 'technique_deleted', { actor: me.id, target: T }, alive), db.prepare('DELETE FROM techniques WHERE id = ?').bind(ex.id)]);
      return json({ ok: true });
    }
  }

  // ---------- critérios, ajustes e equipe (administrador) ----------
  if (path === '/api/rules' && method === 'PUT') {
    await admin('rules_update', ['rules', null]);
    const b = await body();
    if (!Array.isArray(b.rules) || !b.rules.length) bad('Nada para salvar.');
    if (b.rules.length > RULES_MAX) bad(`No máximo ${RULES_MAX} regras (uma por faixa).`);
    const stmts = [], seen = new Set(), RCOLS = ['degree_months', 'degree_classes', 'belt_months', 'belt_classes', 'curriculum_pct', 'next_min_age'];
    const current = new Map((await all(db, 'SELECT * FROM rules')).map(r => [r.belt, r])), changed = [];
    for (const r of b.rules) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) bad('Regra inválida.');
      const belt = oneOf(r.belt, BELTS, 'Faixa'); if (!belt) bad('Faixa inválida.');
      if (seen.has(belt)) bad(`A faixa ${belt} aparece mais de uma vez.`); seen.add(belt);
      const isBlack = belt === 'preta';
      const vals = [
        real(r.degree_months, 0, 120, `Meses entre graus (${belt})`) ?? bad(`Meses entre graus (${belt}) é obrigatório.`),
        int(r.degree_classes ?? 0, 0, 1000, `Aulas entre graus (${belt})`),
        isBlack ? null : real(r.belt_months, 0, 240, `Meses na faixa (${belt})`),
        isBlack ? null : int(r.belt_classes, 0, 5000, `Aulas na faixa (${belt})`),
        isBlack ? null : int(r.curriculum_pct, 0, 100, `Currículo % (${belt})`),
        isBlack ? null : int(r.next_min_age, 0, 100, `Idade mínima (${belt})`)];
      const cur = current.get(belt);
      if (!cur || RCOLS.some((c, i) => (cur[c] ?? null) !== vals[i])) changed.push(belt);
      stmts.push(db.prepare('UPDATE rules SET degree_months=?, degree_classes=?, belt_months=?, belt_classes=?, curriculum_pct=?, next_min_age=? WHERE belt=?').bind(...vals, belt));
    }
    if (!stmts.length) bad('Nada para salvar.');
    // Um evento por gravação de critérios, com as faixas cujos valores mudaram (comparadas com o que estava no banco ao ler).
    if (changed.length) stmts.push(audit(db, 'rules_updated', { actor: me.id, target: ['rules', null], detail: { faixas: changed } }));
    await db.batch(stmts);
    return json({ ok: true });
  }
  if (path === '/api/settings' && method === 'PUT') {
    await admin('settings_update', ['settings', 'academy_name']);
    const b = await body();
    const name = str(b.academy_name, { min: 2, max: 80, field: 'Nome da academia', required: true });
    // Evento só quando o valor muda de fato (condição avaliada no batch, antes da gravação). O nome em si não vai para a auditoria.
    await db.batch([
      audit(db, 'settings_updated', { actor: me.id, target: ['settings', 'academy_name'] }, { where: "NOT EXISTS (SELECT 1 FROM settings WHERE key = 'academy_name' AND value IS ?)", params: [name] }),
      db.prepare("INSERT INTO settings (key, value) VALUES ('academy_name', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(name)
    ]);
    return json({ ok: true });
  }
  if (path === '/api/staff' && method === 'POST') {
    await admin('staff_create');
    const b = await body();
    const email = checkEmail(b.email);
    if (await first(db, 'SELECT id FROM staff WHERE email = ?', email)) throw new HttpError(409, 'Já existe alguém da equipe com esse e-mail.');
    const { hash, salt } = await hashPassword(checkPassword(b.password, { email, name: b.name }));
    const id = uuid();
    const name = str(b.name, { min: 2, max: 80, field: 'Nome', required: true }), role = oneOf(b.role, ['admin', 'professor'], 'Função', 'professor'), belt = oneOf(b.belt, BELTS, 'Faixa', null);
    // Criação de membro da equipe (papel no detail: criação de administrador = papel "admin"). E-mail e nome não vão para a auditoria.
    await db.batch([
      db.prepare('INSERT INTO staff (id, name, email, pass_hash, pass_salt, role, belt) VALUES (?,?,?,?,?,?,?)').bind(id, name, email, hash, salt, role, belt),
      audit(db, 'staff_created', { actor: me.id, target: ['staff', id], detail: { papel: role } })
    ]);
    return json(await first(db, 'SELECT id, name, email, role, belt, active FROM staff WHERE id = ?', id), 201);
  }
  if ((m = path.match(/^\/api\/staff\/([0-9a-f-]{36})$/)) && method === 'PUT') {
    await admin('staff_update', UUID_RE.test(m[1]) ? ['staff', m[1]] : null);
    const b = await body();
    const ex = await first(db, 'SELECT * FROM staff WHERE id = ?', m[1]);
    if (!ex) throw new HttpError(404, 'Pessoa não encontrada.');
    // Campo ausente = mantém o valor atual (antes: sem `active` a conta era REATIVADA; sem `belt` a faixa era apagada).
    // `belt` presente e vazio/null continua limpando a faixa, como antes.
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    const role = oneOf(b.role, ['admin', 'professor'], 'Função', ex.role), active = has('active') ? flag(b.active, 'Ativo', ex.active) : ex.active;
    const belt = has('belt') ? oneOf(b.belt, BELTS, 'Faixa', null) : ex.belt;
    if (ex.id === me.id && (role !== 'admin' || !active)) bad('Você não pode remover seu próprio acesso de administrador.');
    // V8: a autorização e o "sempre um administrador ativo" são conferidos DENTRO de cada comando de escrita, no estado do
    // banco naquele instante (não no `me` lido no começo da requisição): (1) quem faz a ação ainda é admin ativo; (2) o alvo
    // existe; (3) se o alvo é admin ativo e vai deixar de ser, existe OUTRO admin ativo. Dois admins rebaixando um ao outro
    // ao mesmo tempo: o segundo comando já encontra o seu autor rebaixado e não muda nada.
    const guard = `EXISTS (SELECT 1 FROM staff WHERE id = ? AND role = 'admin' AND active = 1)
      AND EXISTS (SELECT 1 FROM staff WHERE id = ?)
      AND ((? = 'admin' AND ? = 1) OR NOT EXISTS (SELECT 1 FROM staff WHERE id = ? AND role = 'admin' AND active = 1)
        OR EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1 AND id <> ?))`;
    const G = [me.id, ex.id, role, active, ex.id, ex.id];
    const stmts = [];
    // Senha definida pelo administrador: no mesmo batch, fim das sessões da pessoa, códigos de recuperação pendentes e auditoria.
    // Todos os comandos levam a mesma condição e a alteração principal é o ÚLTIMO: os anteriores não mexem em papel/ativo,
    // então a condição dá o mesmo resultado em todos; se ela falhar, nada do batch muda.
    if (b.password) { const { hash, salt } = await hashPassword(checkPassword(b.password, { email: ex.email, name: b.name ?? ex.name })); stmts.push(db.prepare(`UPDATE staff SET pass_hash=?, pass_salt=? WHERE id=? AND ${guard}`).bind(hash, salt, ex.id, ...G), db.prepare(`DELETE FROM auth_sessions WHERE staff_id = ? AND ${guard}`).bind(ex.id, ...G), db.prepare(`DELETE FROM password_resets WHERE staff_id = ? AND ${guard}`).bind(ex.id, ...G), audit(db, 'staff_password_reset', { actor: me.id, target: ['staff', ex.id], detail: { conta: ex.id, sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } }, { where: guard, params: G })); }
    // Desativar: sessões caem e códigos de recuperação pendentes são apagados (senão voltariam a valer se a conta fosse
    // reativada dentro dos 30 minutos). Mesmo batch da desativação.
    if (!active) stmts.push(db.prepare(`DELETE FROM auth_sessions WHERE staff_id = ? AND ${guard}`).bind(ex.id, ...G), db.prepare(`DELETE FROM password_resets WHERE staff_id = ? AND ${guard}`).bind(ex.id, ...G));
    const name = str(b.name ?? ex.name, { min: 2, max: 80, field: 'Nome', required: true });
    // V6: eventos com a MESMA condição V8 (gravados se e somente se a alteração principal acontece) e antes dela, olhando o estado
    // anterior. Papel e ativo só têm dois valores: "mudou no banco" (role <> novo) equivale a "de = o outro valor", sem ambiguidade.
    const T = ['staff', ex.id], W = (extra = '', p = []) => ({ where: guard + extra, params: [...G, ...p] });
    if (role !== ex.role) stmts.push(audit(db, 'staff_role_changed', { actor: me.id, target: T, detail: { de: ex.role, para: role } }, W(' AND EXISTS (SELECT 1 FROM staff WHERE id = ? AND role <> ?)', [ex.id, role])));
    if (active !== ex.active) stmts.push(active
      ? audit(db, 'staff_reactivated', { actor: me.id, target: T }, W(' AND EXISTS (SELECT 1 FROM staff WHERE id = ? AND active <> ?)', [ex.id, active]))
      : audit(db, 'staff_deactivated', { actor: me.id, target: T, detail: { sessoes_encerradas: true, codigos_de_recuperacao_invalidados: true } }, W(' AND EXISTS (SELECT 1 FROM staff WHERE id = ? AND active <> ?)', [ex.id, active])));
    const campos = [...(name !== ex.name ? ['name'] : []), ...((belt ?? null) !== (ex.belt ?? null) ? ['belt'] : [])];
    if (campos.length) stmts.push(audit(db, 'staff_updated', { actor: me.id, target: T, detail: { campos } }, W()));
    stmts.push(db.prepare(`UPDATE staff SET name=?, role=?, belt=?, active=? WHERE id=? AND ${guard}`).bind(name, role, belt, active, ex.id, ...G));
    const res = await db.batch(stmts);
    if (res?.[stmts.length - 1]?.meta?.changes !== 1) {
      // Só classifica a recusa (a proteção já foi a condição acima): alvo sumiu, autor perdeu o acesso, ou último admin.
      if (!(await first(db, 'SELECT 1 x FROM staff WHERE id = ?', ex.id))) throw new HttpError(404, 'Pessoa não encontrada.');
      if (!(await first(db, "SELECT 1 x FROM staff WHERE id = ? AND role = 'admin' AND active = 1", me.id))) { await auditDenied(db, me.id, 'staff_update', 'requer_admin', T); throw new HttpError(403, 'Apenas o administrador pode fazer isso.'); }
      await auditDenied(db, me.id, 'staff_update', 'ultimo_admin', T);
      throw new HttpError(409, 'É preciso manter pelo menos um administrador ativo.');
    }
    return json(await first(db, 'SELECT id, name, email, role, belt, active FROM staff WHERE id = ?', ex.id));
  }

  // ---------- exportação ----------
  if (path === '/api/export/alunos.csv' && method === 'GET') {
    await admin('students_export', ['export', 'alunos.csv']);
    const C = await computeAll(db);
    // Aspas duplicadas; apóstrofo na frente de = + - @ e tabulação, para a planilha não interpretar o campo como fórmula; sem caracteres de controle.
    const q = v => { let s = String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const head = ['Nome', 'Apelido', 'Situação', 'Faixa', 'Graus', 'Na faixa desde', 'Último grau', 'Início', 'Idade', 'Aulas (total)', 'Aulas 30 dias', 'Média semanal', 'Última presença', 'Experiência', 'Aprendizado %', 'Próxima graduação', 'Apto'];
    const rows = C.students.map(s => [s.name, s.nickname, s.status, s.belt, s.degrees, s.belt_since, s.degree_since, s.start_date, s.metrics.age, s.metrics.classes_total, s.metrics.classes_last_30d,
      String(s.metrics.weekly_avg).replace('.', ','), s.metrics.last_attendance, s.metrics.experience.label, s.metrics.learning.pct,
      s.metrics.next ? (s.metrics.next.kind === 'grau' ? `${s.metrics.next.to_degrees}º grau` : `faixa ${s.metrics.next.to_belt || 'a definir'}`) : '', s.metrics.ready ? 'sim' : 'não']);
    const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
    // Sem escrita no banco: o evento é gravado ANTES de o arquivo sair. Se a gravação falhar, a exportação falha (500) e nenhum
    // dado é entregue. Garantia: não há resposta com o arquivo sem registro. O evento significa "exportação processada e arquivo
    // preparado para a resposta"; NÃO confirma que o download terminou nem que o navegador recebeu (o servidor não sabe disso).
    await audit(db, 'students_exported', { actor: me.id, target: ['export', 'alunos.csv'], detail: { linhas: rows.length } }).run();
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
