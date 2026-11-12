/* TATAME — painel do professor de jiu-jitsu.
   Os indicadores (prontidão para graduar, experiência, aprendizado, frequência) são calculados
   pela API no servidor; a interface só exibe e envia ações. */
'use strict';

// =====================================================================
// Utilidades
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const n0 = v => v == null || isNaN(v) ? '–' : Math.round(v).toLocaleString('pt-BR');
const n1 = v => v == null || isNaN(v) ? '–' : nf1.format(v);
const pct = (a, b) => b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const WDS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const sd = s => s ? `${pd(s).getDate()} ${MONTHS[pd(s).getMonth()]}` : '–';
const ld = s => s ? `${pd(s).getDate()} de ${MONTHS[pd(s).getMonth()]} de ${pd(s).getFullYear()}` : '–';
const dayDiff = s => s ? Math.round((pd(S.today) - pd(s)) / 864e5) : null;
const ago = s => { const d = dayDiff(s); return d == null ? 'nunca' : d === 0 ? 'hoje' : d === 1 ? 'ontem' : `há ${d} dias`; };
const months = m => m < 1 ? `${Math.round(m * 30)} dias` : m < 12 ? `${n1(m)} ${m >= 2 ? 'meses' : 'mês'}` : `${n1(m / 12)} ${m >= 24 ? 'anos' : 'ano'}`;
const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const BELTS = ['branca', 'cinza', 'amarela', 'laranja', 'verde', 'azul', 'roxa', 'marrom', 'preta'];
const ADULT = ['branca', 'azul', 'roxa', 'marrom', 'preta'];
const BELT_HEX = { branca: '#EDEDED', cinza: '#8C8F96', amarela: '#E6C229', laranja: '#E07B28', verde: '#2E9E5B', azul: '#2563EB', roxa: '#7C3AED', marrom: '#7B4B2A', preta: '#3A3D44' };
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const CATS = ['Fundamentos', 'Quedas', 'Guarda', 'Raspagens', 'Passagens', 'Controle', 'Costas', 'Finalizações', 'Defesas e saídas'];
const LEVEL = { todos: 'Todos os níveis', iniciante: 'Iniciante', intermediario: 'Intermediário', avancado: 'Avançado', kids: 'Kids', competicao: 'Competição' };
const MOD = { gi: 'Kimono', nogi: 'Sem kimono', livre: 'Treino livre' };
const STATUS = { ativo: 'Ativo', trancado: 'Trancado', inativo: 'Inativo' };

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', medal: '<circle cx="12" cy="15" r="6"/><path d="M8.5 10 6 3h4l2 4 2-4h4l-2.5 7"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4M12 17v.5"/>', logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'
};
const I = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;
const belt = (b, deg = 0, lg = false) => {
  const w = lg ? 4 : 2, tabR = lg ? 14 : 8, tabW = lg ? 40 : 22, pad = lg ? 5 : 3;
  const step = Math.min(w + (lg ? 4 : 3), (tabW - pad * 2) / Math.max(deg, 1));
  return `<span class="belt ${lg ? 'lg' : ''}" data-b="${b}" role="img" aria-label="Faixa ${b}${deg ? `, ${deg} grau${deg > 1 ? 's' : ''}` : ''}">${[...Array(deg)].map((_, i) => `<i style="right:${(tabR + tabW - pad - w - i * step).toFixed(1)}px"></i>`).join('')}</span>`;
};
const beltName = (b, d) => `Faixa ${b}${d ? ` · ${d}º grau` : ''}`;
const nextLabel = n => !n ? 'Faixa preta máxima' : n.kind === 'grau' ? `${n.to_degrees}º grau` : n.to_belt ? `Faixa ${n.to_belt}` : 'Faixa a definir';

function toast(msg, type = 'info') {
  $$('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.innerHTML = `<span class="dot"></span><span>${esc(msg)}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 5200 : 2800);
}

// ---------- API ----------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-tatame': '1' }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Sem conexão com o servidor. Verifique sua internet.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { S.loaded = false; renderLogin('Sua sessão expirou. Entre novamente.'); throw new ApiError(401, data.error || 'Sessão expirada.'); }
  if (!r.ok) throw new ApiError(r.status, data.error || 'Algo deu errado. Tente de novo.');
  return data;
}
async function busy(btn, fn, okMsg) {
  if (btn) btn.classList.add('loading');
  try { const r = await fn(); if (okMsg) toast(okMsg, 'success'); return r; }
  catch (e) { if (e.status !== 401) toast(e.message || 'Erro inesperado.', 'error'); console.error(e); return undefined; }
  finally { if (btn) btn.classList.remove('loading'); }
}

// ---------- Sheets ----------
function sheet(html, { onClose } = {}) {
  closeSheet();
  const w = document.createElement('div');
  w.className = 'sheet-wrap'; w.id = 'sheet';
  w.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  w.addEventListener('click', e => { if (e.target === w) closeSheet(); });
  w._onClose = onClose;
  document.body.appendChild(w);
  // Só foca o primeiro campo se a pessoa ainda não começou a digitar em outro.
  const f = w.querySelector('[autofocus]'); if (f) setTimeout(() => { if (!w.contains(document.activeElement)) f.focus(); }, 60);
  return w;
}
function closeSheet() { const w = $('#sheet'); if (w) { w.remove(); if (w._onClose) w._onClose(); } }
const sheetHead = t => `<div class="sheet-head"><h2>${t}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Fechar">${I('x', 18)}</button></div>`;
function confirmBox(title, text, okLabel = 'Confirmar', danger = true) {
  return new Promise(res => {
    const w = sheet(`${sheetHead(esc(title))}<p class="muted" style="margin:0 0 18px">${esc(text)}</p>
      <div class="row"><button class="btn ghost grow" data-x="no">Cancelar</button><button class="btn ${danger ? 'danger' : ''} grow" data-x="ok">${esc(okLabel)}</button></div>`, { onClose: () => res(false) });
    w.querySelector('[data-x=no]').onclick = () => { w._onClose = null; closeSheet(); res(false); };
    w.querySelector('[data-x=ok]').onclick = () => { w._onClose = null; closeSheet(); res(true); };
  });
}
const formObj = f => Object.fromEntries(new FormData(f).entries());

// =====================================================================
// Estado
// =====================================================================
const S = { loaded: false, ui: { stuFilter: 'ativos', stuBelt: '', q: '', aulasTab: 'chamadas', techCat: '', techQ: '', techSt: '', detailTab: 'graduacao', skillFilter: 'curriculo' } };
const stuById = id => S.students.find(s => s.id === id);
const techById = id => S.techniques.find(t => t.id === id);
const clsById = id => S.classes.find(c => c.id === id);
const isAdmin = () => S.me && S.me.role === 'admin';
// Espelho da regra do servidor: professor só exclui chamada ou desfaz graduação que ele mesmo registrou nos últimos 7 dias.
const canUndo = (staffId, createdAt) => isAdmin() || (staffId === S.me.id && Date.now() - Date.parse(createdAt) < 7 * 864e5);

async function refresh() {
  const st = await api('GET', '/api/state');
  Object.assign(S, st, { loaded: true });
}

// =====================================================================
// Login e configuração inicial
// =====================================================================
function renderLogin(msg = '', setup = false) {
  $('#root').innerHTML = `<div class="auth"><div class="auth-box">
    <div class="brand">${belt('preta', 4, true)}<div><h1>Tatame</h1><div class="muted small">${setup ? 'Configuração da academia' : esc(S.academy || 'Gestão da academia de jiu-jitsu')}</div></div></div>
    <form id="auth" class="stack" novalidate>
      ${setup ? `<p class="muted small" style="margin:0 0 4px">Primeiro acesso: crie a conta do administrador.</p>
        ${S.setupCode ? '<label class="field"><span>Código de ativação</span><input class="input" name="setup_code" autocomplete="off" required style="text-transform:uppercase;letter-spacing:.08em"></label>' : ''}
        <label class="field"><span>Nome da academia</span><input class="input" name="academy_name" maxlength="80" required autofocus></label>
        <label class="field"><span>Seu nome</span><input class="input" name="name" autocomplete="name" maxlength="80" required></label>` : ''}
      <label class="field"><span>E-mail</span><input class="input" name="email" type="email" autocomplete="email" required ${setup ? '' : 'autofocus'}></label>
      <label class="field"><span>Senha</span><input class="input" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required></label>
      <div class="err" id="auth-err" role="alert">${esc(msg)}</div>
      <button class="btn block" type="submit">${setup ? 'Criar academia' : 'Entrar'}</button>
    </form>
    ${setup ? '' : '<p class="muted xs" style="text-align:center;margin-top:16px">Esqueceu a senha? Peça ao administrador da academia para redefinir.</p><button type="button" class="btn ghost sm block" id="to-reset">Tenho um código de recuperação</button>'}
  </div></div>`;
  if (!setup) $('#to-reset').onclick = () => renderReset();
  $('#auth').onsubmit = async e => {
    e.preventDefault();
    const b = formObj(e.target), err = $('#auth-err'); err.textContent = '';
    if (setup && String(b.academy_name).trim().length < 2) return err.textContent = 'Informe o nome da academia.';
    if (setup && String(b.name).trim().length < 2) return err.textContent = 'Informe seu nome.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim())) return err.textContent = 'Informe um e-mail válido.';
    if (String(b.password).length < 8) return err.textContent = 'A senha precisa ter pelo menos 8 caracteres.';
    const btn = e.target.querySelector('button'); btn.classList.add('loading');
    try {
      await api('POST', setup ? '/api/setup' : '/api/login', b);
      await start();
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.classList.remove('loading'); }
  };
}

// Recuperação de senha com código entregue pelo operador (ver tools/reset-code.mjs). A validação é toda do servidor.
function renderReset(msg = '') {
  $('#root').innerHTML = `<div class="auth"><div class="auth-box">
    <div class="brand">${belt('preta', 4, true)}<div><h1>Tatame</h1><div class="muted small">Recuperar acesso</div></div></div>
    <form id="reset" class="stack" novalidate>
      <p class="muted small" style="margin:0 0 4px">Digite o e-mail da conta, o código que você recebeu e escolha uma nova senha. O código vale por 30 minutos e só pode ser usado uma vez.</p>
      <label class="field"><span>E-mail</span><input class="input" name="email" type="email" autocomplete="email" required autofocus></label>
      <label class="field"><span>Código de recuperação</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required style="text-transform:uppercase;letter-spacing:.08em"></label>
      <label class="field"><span>Nova senha</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field"><span>Repita a nova senha</span><input class="input" name="password_confirm" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="err" id="reset-err" role="alert">${esc(msg)}</div>
      <button class="btn block" type="submit">Redefinir senha</button>
    </form>
    <button type="button" class="btn ghost sm block" id="to-login" style="margin-top:16px">Voltar para o login</button>
  </div></div>`;
  $('#to-login').onclick = () => renderLogin();
  $('#reset').onsubmit = async e => {
    e.preventDefault();
    const b = formObj(e.target), err = $('#reset-err'); err.textContent = '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim())) return err.textContent = 'Informe um e-mail válido.';
    if (!String(b.code).trim()) return err.textContent = 'Informe o código de recuperação.';
    if (String(b.password).length < 8) return err.textContent = 'A senha precisa ter pelo menos 8 caracteres.';
    if (b.password !== b.password_confirm) return err.textContent = 'As senhas não conferem.';
    const btn = e.target.querySelector('button'); btn.classList.add('loading');
    try {
      await api('POST', '/api/reset', b);
      renderLogin('Senha redefinida. Entre com a nova senha.');
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.classList.remove('loading'); }
  };
}

// =====================================================================
// Shell
// =====================================================================
const TABS = [['painel', 'Painel', 'home'], ['alunos', 'Alunos', 'users'], ['aulas', 'Aulas', 'calendar'], ['tecnicas', 'Técnicas', 'book'], ['ajustes', 'Ajustes', 'gear']];
const route = () => (location.hash.replace('#', '') || 'painel').split('/');
// Desktop: sidebar com marca, navegação e conta. Mobile: só a navegação, como barra inferior.
function renderShell() {
  $('#root').innerHTML = `<div class="shell"><aside class="side">
      <a class="side-brand" href="#painel">${belt('preta', 4)}<span class="grow"><b>Tatame</b><span class="side-acad ellipsis"></span></span></a>
      <nav class="nav" aria-label="Navegação principal">${TABS.map(([k, l, i]) => `<a href="#${k}" data-tab="${k}">${I(i, 20)}<span>${l}</span><em class="nav-count" data-count="${k}"></em></a>`).join('')}</nav>
      <div class="side-foot"><div class="side-date"></div><a class="side-me" href="#ajustes"></a></div>
    </aside><main class="app" id="main" aria-live="polite"></main></div><div id="overlay"></div>`;
}
let lastRoute = '';
function renderSide(r) {
  $$('.nav a').forEach(a => { const on = a.dataset.tab === r || (r === 'aluno' && a.dataset.tab === 'alunos'); a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const due = S.dashboard.todays.filter(c => !c.lesson).length;
  $('[data-count=alunos]').textContent = S.students.filter(s => s.status === 'ativo').length;
  const dc = $('[data-count=aulas]'); dc.textContent = due || ''; dc.classList.toggle('due', due > 0); dc.title = due ? `${due} chamada${due > 1 ? 's' : ''} pendente${due > 1 ? 's' : ''} hoje` : '';
  $('.side-acad').textContent = S.settings.academy_name || 'Academia';
  $('.side-date').textContent = `${WDS[pd(S.today).getDay()]} · ${pd(S.today).getDate()} ${MONTHS[pd(S.today).getMonth()]}`;
  $('.side-me').innerHTML = `<span class="avatar">${esc(initials(S.me.name))}</span><span class="grow"><b class="ellipsis">${esc(S.me.name)}</b><small>${S.me.role === 'admin' ? 'Administrador' : 'Professor'}</small></span>`;
}
function render() {
  if (!S.loaded) return;
  const [r, id] = route();
  renderSide(r);
  const v = (VIEWS[r] || VIEWS.painel)(id);
  const main = $('#main');
  // Animação de entrada só ao trocar de tela; filtros e busca re-renderizam sem animar.
  const key = r + '/' + (id || '');
  main.classList.remove('enter');
  if (key !== lastRoute) { lastRoute = key; void main.offsetWidth; main.classList.add('enter'); }
  main.innerHTML = v.html;
  if (v.after) v.after(main);
}
const VIEWS = {};

// =====================================================================
// PAINEL
// =====================================================================
// ---------- Relógio da academia ----------
// O servidor define "hoje" no fuso fixo da academia (TZ em _worker.js). A hora atual é lida no mesmo
// fuso, para o estado das aulas não depender do relógio ou do fuso do aparelho.
const TZ = 'America/Sao_Paulo';
const TZ_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hm = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const dur = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
function nowMin() {
  const p = Object.fromEntries(TZ_FMT.formatToParts(new Date()).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  // Se a tela ficou aberta além da meia-noite, as aulas do "hoje" carregado já passaram.
  return date > S.today ? 24 * 60 : date < S.today ? -1 : +p.hour * 60 + +p.minute;
}
function classState(c) {
  const now = nowMin(), s = hm(c.start_time), e = hm(c.end_time);
  if (c.lesson) return { k: 'done', t: `chamada feita` };
  if (now < s) return { k: 'next', t: `começa em ${dur(s - now)}` };
  if (now < e) return { k: 'live', t: 'em andamento' };
  return { k: 'past', t: `terminou às ${c.end_time} · chamada pendente` };
}
const todaysSorted = () => [...S.dashboard.todays].sort((a, b) => a.start_time.localeCompare(b.start_time));
// Próxima chamada pendente: a aula em andamento; senão a última que terminou sem chamada; senão a próxima do dia.
function nextPending() {
  const pend = todaysSorted().filter(c => !c.lesson).map(c => ({ c, k: classState(c).k }));
  const pick = pend.find(x => x.k === 'live') || pend.filter(x => x.k === 'past').pop() || pend.find(x => x.k === 'next');
  return pick ? pick.c : null;
}
// Nível só aparece quando não repete o nome da turma.
const classMeta = c => { const prof = c.instructor_id && S.staff.find(x => x.id === c.instructor_id); return [c.name !== LEVEL[c.level] && LEVEL[c.level], MOD[c.modality], prof && esc(prof.name)].filter(Boolean).join(' · '); };
// Atualiza só os textos de estado a cada 30 s, sem re-renderizar a tela.
setInterval(() => { if (S.loaded) $$('[data-clock]').forEach(el => { const c = S.dashboard.todays.find(x => x.id === el.dataset.clock); if (c) el.textContent = classState(c).t; }); }, 30000);

// ---------- Progressão da graduação ----------
// Componente só visual: desenha o que o servidor calculou (degrees, next, progress, ready).
// As casas da ponteira seguem o mesmo limite que o servidor valida: 6 graus na preta, 4 nas demais.
const degSlots = b => b === 'preta' ? 6 : 4;
function rankLabel(s) {
  const m = s.metrics, n = m.next, st = m.ready ? 'critérios cumpridos' : `${m.progress}% dos critérios`;
  return `Faixa ${s.belt}, ${s.degrees} de ${degSlots(s.belt)} graus. ${!n ? 'Graduação máxima.' : n.kind === 'grau' ? `Próximo: ${n.to_degrees}º grau, ${st}.` : `Próximo: ${n.to_belt ? `faixa ${n.to_belt}` : 'faixa a definir'}, ${st}.`}`;
}
function rank(s, lg = false) {
  const m = s.metrics, n = m.next, f = m.ready ? 1 : Math.max(0, Math.min(100, m.progress)) / 100;
  const slots = [...Array(degSlots(s.belt))].map((_, i) => {
    const d = i + 1;
    if (d <= s.degrees) return `<i class="on" data-n="${d}º"></i>`;
    if (n && n.kind === 'grau' && n.to_degrees === d) return `<i class="pend${m.ready ? ' ready' : ''}" style="--f:${f}" data-n="${d}º"></i>`;
    return `<i data-n="${d}º"></i>`;
  }).join('');
  return `<span class="rank${lg ? ' lg' : ''}" data-b="${s.belt}" role="img" aria-label="${rankLabel(s)}"><span class="rk-belt"><span class="rk-tab">${slots}</span></span>${n && n.kind === 'faixa' && n.to_belt ? `<span class="rk-next${m.ready ? ' ready' : ''}" data-b="${n.to_belt}" style="--f:${f}"></span>` : ''}${!n && lg ? '<span class="rk-max">graduação máxima</span>' : ''}</span>`;
}

function stuRow(s, extra = '') {
  return `<a class="item" href="#aluno/${s.id}"><div class="avatar">${esc(initials(s.name))}</div>
    <div class="grow"><b class="sname ellipsis">${esc(s.name)}${s.nickname ? ` <span class="muted small">“${esc(s.nickname)}”</span>` : ''}</b>
    <div class="stu"><div class="meta">${rank(s)}<span class="muted xs">${extra}</span></div></div></div></a>`;
}
// Aula de hoje em linha: hora, turma, estado. Só a próxima chamada pendente recebe o botão sólido.
const slotRow = (c, primary = false) => `<div class="item slot ${c.lesson ? 'done' : ''}"><div class="slot-time"><b>${c.start_time}</b><span>${c.end_time}</span></div>
  <div class="grow"><b>${esc(c.name)}</b><div class="muted small">${classMeta(c)}${c.lesson ? '' : ` · <span data-clock="${c.id}">${classState(c).t}</span>`}</div></div>
  ${c.lesson ? `<button class="btn ghost sm" data-act="lesson-open" data-id="${c.lesson.id}">${I('check', 14)} ${c.lesson.n} presentes</button>` : `<button class="btn ${primary ? '' : 'ghost '}sm" data-act="lesson-new" data-class="${c.id}" data-date="${S.today}">Fazer chamada</button>`}</div>`;

VIEWS.painel = () => {
  const D = S.dashboard, K = D.kpis;
  const base = K.attendance_last_week_same_period;
  const dWeek = base ? Math.round((K.attendance_this_week - base) / base * 100) : null;
  const ready = D.ready_list.map(stuById).filter(Boolean), near = D.near_list.map(stuById).filter(Boolean), risk = D.risk_list.map(stuById).filter(Boolean);
  const hard = S.techniques.filter(t => t.assessed >= 2 && t.avg_level != null && t.times_taught > 0).sort((a, b) => a.avg_level - b.avg_level).slice(0, 5);
  const hours = [...new Set(D.heat.map(h => h.hour))].sort((a, b) => a - b);
  const wds = [1, 2, 3, 4, 5, 6, 0].filter(w => D.heat.some(h => h.weekday === w));
  const maxAvg = Math.max(1, ...D.heat.map(h => h.avg));
  const beltTotal = D.belts.reduce((a, b) => a + b.count, 0);
  const todays = todaysSorted(), nx = nextPending(), others = todays.filter(c => c !== nx);
  const occ = nx && D.occupancy.find(o => o.class_id === nx.id);
  const done = todays.filter(c => c.lesson), presentToday = done.reduce((a, c) => a + c.lesson.n, 0);
  const hero = !todays.length
    ? `<section class="today quiet"><div class="today-k">Hoje no tatame</div><div class="row"><p class="grow">Nenhum horário fixo hoje.</p><button class="btn ghost sm" data-act="lesson-new" data-date="${S.today}">${I('plus', 14)} Aula avulsa</button></div></section>`
    : nx ? `<section class="today" aria-label="Próxima chamada"><div class="today-k">Hoje no tatame · <span data-clock="${nx.id}">${classState(nx).t}</span></div>
        <div class="today-row"><div class="today-time"><b>${nx.start_time}</b><span>até ${nx.end_time}</span></div>
          <div class="today-info"><h2>${esc(nx.name)}</h2><div class="muted">${classMeta(nx)}${occ && occ.avg > 0 ? ` · ${n1(occ.avg)} alunos por aula` : ''}</div></div>
          <button class="btn today-cta" data-act="lesson-new" data-class="${nx.id}" data-date="${S.today}">${I('check', 16)} Fazer chamada</button></div></section>`
    : `<section class="today quiet"><div class="today-k">Hoje no tatame</div><h2>Chamadas de hoje feitas</h2><p class="muted">${presentToday} presença${presentToday === 1 ? '' : 's'} em ${done.length} aula${done.length === 1 ? '' : 's'}.</p></section>`;
  const html = `
  <div class="top"><div><h1>${esc(S.settings.academy_name || 'Academia')}</h1><div class="sub">${cap(WD[pd(S.today).getDay()])}, ${ld(S.today)}</div></div></div>
  ${hero}
  <p class="context">
    <span><b>${K.active_students}</b> alunos ativos, ${K.new_this_month} novo${K.new_this_month === 1 ? '' : 's'} no mês</span>
    <span><b>${K.attendance_this_week}</b> presenças na semana, <span class="${dWeek > 0 ? 'up' : dWeek < 0 ? 'down' : ''}">${dWeek == null ? `${K.attendance_last_week} na semana passada` : dWeek === 0 ? 'igual ao mesmo período da semana passada' : `${dWeek > 0 ? '+' : ''}${dWeek}% vs mesmo período da semana passada`}</span></span>
    <span><b>${n1(K.avg_per_lesson_30d)}</b> alunos por aula em 30 dias, ${K.lessons_30d} aulas</span>
    <span class="br" aria-hidden="true"></span>
    <a href="#alunos" data-act="filter-ready"><b${K.ready ? ' class="good"' : ''}>${K.ready}</b> aptos a graduar</a>
    <a href="#alunos" data-act="filter-risk"><b${K.at_risk ? ' class="warn"' : ''}>${K.at_risk}</b> sem treinar há 14+ dias</a>
  </p>
  <div class="dash">
    <div class="dash-col">
      ${others.length ? `<section style="--o:1"><div class="section-title"><h2>${nx ? 'Outras aulas de hoje' : 'Aulas de hoje'}</h2><a class="link" href="#aulas">Horários</a></div><div class="list">${others.map(c => slotRow(c)).join('')}</div></section>` : ''}
      <section style="--o:3"><div class="section-title"><h2>Presenças por semana</h2><span class="muted xs">12 semanas</span></div><div id="ch-week"></div></section>
      <section style="--o:5"><div class="section-title"><h2>Horários mais cheios</h2><span class="muted xs">média de alunos · 8 semanas</span></div>
        ${D.heat.length ? `<div class="heat" style="grid-template-columns:40px repeat(${wds.length},1fr)"><div></div>${wds.map(w => `<div class="h">${WDS[w]}</div>`).join('')}
          ${hours.map(h => `<div class="h">${String(h).padStart(2, '0')}h</div>${wds.map(w => { const c = D.heat.find(x => x.weekday === w && x.hour === h); return c ? `<div class="c" title="${WD[w]} ${h}h: ${n1(c.avg)} alunos em média (${c.lessons} aulas)" style="background:rgba(74,132,245,${(0.1 + 0.7 * c.avg / maxAvg).toFixed(2)})">${n1(c.avg)}</div>` : '<div class="c" style="background:var(--surface-2)"></div>'; }).join('')}`).join('')}</div>`
          : '<div class="chart-empty">Faça chamadas para ver os horários com mais alunos</div>'}</section>
      <section style="--o:6"><div class="section-title"><h2>Técnicas com mais dificuldade</h2><span class="muted xs">menor nível médio</span></div>
        ${hard.length ? hard.map(t => `<div class="macro"><span class="small">${esc(t.name)}</span><span class="small num">${n1(t.avg_level)}<span class="muted">/5</span></span><div class="bar thin"><i style="width:${pct(t.avg_level, 5)}%;background:var(--warn)"></i></div></div>`).join('')
          : '<div class="chart-empty">Avalie os alunos nas técnicas ensinadas para identificar dificuldades</div>'}</section>
    </div>
    <div class="dash-col">
      <section style="--o:2"><div class="section-title"><h2>Aptos para graduar</h2><span class="muted xs num">${ready.length}</span></div>
        <div class="list">${ready.map(s => stuRow(s, `pronto para <b style="color:var(--good)">${nextLabel(s.metrics.next)}</b>`)).join('') || '<div class="empty">Ninguém cumpre todos os critérios ainda.</div>'}</div>
        ${near.length ? `<div class="section-title sub"><h2>Quase lá</h2><span class="muted xs">75%+ dos critérios</span></div><div class="list">${near.map(s => stuRow(s, `${s.metrics.progress}% para ${nextLabel(s.metrics.next)}`)).join('')}</div>` : ''}
        <div class="section-title sub"><h2>Sem treinar há 14+ dias</h2><span class="muted xs num">${risk.length}</span></div>
        <div class="list">${risk.slice(0, 10).map(s => stuRow(s, `<span style="color:var(--warn)">${s.metrics.last_attendance ? `última aula ${ago(s.metrics.last_attendance)}` : 'ainda não treinou'}</span>`)).join('') || '<div class="empty">Todos os ativos treinaram nas últimas duas semanas.</div>'}</div></section>
      <section style="--o:4"><div class="section-title"><h2>Alunos por faixa</h2><span class="muted xs">ativos</span></div>
        ${D.belts.length ? `<div class="belt-dist" role="img" aria-label="Distribuição de alunos ativos por faixa">${D.belts.map(b => `<i style="flex:${b.count};background:${BELT_HEX[b.belt]}" title="${cap(b.belt)}: ${b.count}"></i>`).join('')}</div>
          <div class="belt-legend">${D.belts.map(b => `<div class="row">${belt(b.belt)}<span class="grow small">${cap(b.belt)}</span><span class="num small">${b.count}</span><span class="num xs muted">${Math.round(pct(b.count, beltTotal))}%</span></div>`).join('')}</div>`
          : '<div class="chart-empty">Cadastre alunos para ver a distribuição</div>'}</section>
    </div>
  </div>`;
  return {
    html, after() {
      Charts.bars($('#ch-week'), D.weekly.map(w => ({ label: sd(w.week), value: w.attendance, tip: `<b>${w.attendance} presenças</b> · ${w.unique_students} alunos · ${w.lessons} aulas<br>semana de ${sd(w.week)}` })), { empty: 'Faça a primeira chamada para ver a frequência' });
    }
  };
};

// =====================================================================
// ALUNOS
// =====================================================================
// Linha da tabela de alunos. No desktop vira colunas; no mobile, nome em cima e metadados embaixo.
function stuTableRow(s) {
  const m = s.metrics;
  return `<a class="item trow" href="#aluno/${s.id}">
    <span class="t-name"><span class="avatar">${esc(initials(s.name))}</span><span class="grow"><b class="ellipsis">${esc(s.name)}</b>${s.nickname ? `<span class="muted xs ellipsis">“${esc(s.nickname)}”</span>` : ''}</span>${s.status !== 'ativo' ? `<span class="tag">${STATUS[s.status]}</span>` : ''}</span>
    <span class="t-belt">${rank(s)}<span class="small">${cap(s.belt)}${s.degrees ? ` · ${s.degrees}º` : ''}</span></span>
    <span class="t-freq"><span class="num">${n1(m.weekly_avg)}</span><span class="muted xs">/sem</span></span>
    <span class="t-last xs" ${m.at_risk ? 'style="color:var(--warn)"' : ''}>${m.last_attendance ? ago(m.last_attendance) : 'ainda não treinou'}</span>
    <span class="t-next">${!m.next ? '<span class="muted xs">graduação máxima</span>' : m.ready ? `<span class="tag good">${I('check', 12)} ${nextLabel(m.next)}</span>`
      : `<span class="num small">${m.progress}%</span><span class="muted xs t-next-l">para ${nextLabel(m.next)}</span>`}</span></a>`;
}
VIEWS.alunos = () => {
  const f = S.ui.stuFilter, q = S.ui.q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let list = S.students.filter(s => {
    if (f === 'ativos' && s.status !== 'ativo') return false;
    if (f === 'aptos' && !(s.status === 'ativo' && s.metrics.ready)) return false;
    if (f === 'risco' && !s.metrics.at_risk) return false;
    if (f === 'inativos' && s.status === 'ativo') return false;
    if (S.ui.stuBelt && s.belt !== S.ui.stuBelt) return false;
    return !q || norm(s.name).includes(q) || norm(s.nickname).includes(q);
  });
  if (f === 'risco') list.sort((a, b) => b.metrics.days_absent - a.metrics.days_absent);
  if (f === 'aptos') list.sort((a, b) => BELTS.indexOf(b.belt) - BELTS.indexOf(a.belt));
  const counts = { todos: S.students.length, ativos: S.students.filter(s => s.status === 'ativo').length, aptos: S.dashboard.ready_list.length, risco: S.dashboard.risk_list.length, inativos: S.students.filter(s => s.status !== 'ativo').length };
  return {
    html: `<div class="top"><div><h1>Alunos</h1><div class="sub">${counts.ativos} ativos · ${counts.todos} cadastrados</div></div>
      <div class="row">${isAdmin() ? `<a class="icon-btn" href="/api/export/alunos.csv" download aria-label="Exportar planilha" title="Exportar CSV">${I('download', 18)}</a>` : ''}<button class="btn ghost sm" data-act="student-new">${I('plus', 15)} Novo aluno</button></div></div>
    <div class="toolbar">
      <div class="chips">${[['ativos', 'Ativos'], ['aptos', 'Aptos a graduar'], ['risco', 'Sem treinar 14+ dias'], ['inativos', 'Trancados/inativos'], ['todos', 'Todos']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="stu-filter" data-id="${k}">${l} <span class="muted">${counts[k]}</span></button>`).join('')}</div>
      <div class="toolbar-r"><label class="search">${I('search', 15)}<input class="input" id="stu-q" placeholder="Buscar por nome ou apelido" value="${esc(S.ui.q)}" aria-label="Buscar aluno"></label>
        <select class="input" id="stu-belt" aria-label="Filtrar por faixa"><option value="">Todas as faixas</option>${BELTS.map(b => `<option value="${b}" ${S.ui.stuBelt === b ? 'selected' : ''}>${cap(b)}</option>`).join('')}</select></div>
    </div>
    <div class="thead"><span>Aluno</span><span>Faixa</span><span>Frequência</span><span>Última aula</span><span>Próxima graduação</span></div>
    <div class="list" id="stu-list">${list.map(stuTableRow).join('') || `<div class="empty"><b>${S.students.length ? 'Nenhum aluno nesse filtro' : 'Nenhum aluno cadastrado'}</b>${S.students.length ? '' : 'Cadastre os alunos com faixa, graus e data da última graduação.'}</div>`}</div>`,
    after() {
      const qi = $('#stu-q');
      qi.oninput = () => { S.ui.q = qi.value; const pos = qi.selectionStart; render(); const n = $('#stu-q'); n.focus(); n.setSelectionRange(pos, pos); };
      $('#stu-belt').onchange = e => { S.ui.stuBelt = e.target.value; render(); };
    }
  };
};

// ---------- Ficha do aluno ----------
let detail = null;
VIEWS.aluno = id => {
  if (!detail || detail.student.id !== id) {
    api('GET', '/api/students/' + id).then(d => { detail = d; if (route()[1] === id) render(); }).catch(e => { toast(e.message, 'error'); location.hash = 'alunos'; });
    return { html: `<div class="skeleton" style="height:120px;margin-top:20px"></div><div class="skeleton"></div><div class="skeleton"></div>` };
  }
  const { student: s, promotions, skills, lessons, weekly, by_class, seen } = detail;
  const m = s.metrics, tab = S.ui.detailTab;
  const skillMap = Object.fromEntries(skills.map(x => [x.technique_id, x]));
  let body = '';
  if (tab === 'graduacao') {
    const lastP = promotions[0];
    body = `<div class="card"><div class="row between"><div><div class="muted xs">Próxima graduação</div><h2 style="font-size:18px;margin:2px 0 4px;font-weight:600">${nextLabel(m.next)}</h2></div>
        ${m.next ? `<span class="tag ${m.ready ? 'good' : ''}">${m.ready ? 'Critérios cumpridos' : `${m.progress}% dos critérios`}</span>` : ''}</div>
      ${m.criteria.map(c => `<div class="crit"><span class="small">${c.met ? `<span class="ok">${I('check', 14)}</span>` : `<span class="no">○</span>`} ${c.label}</span>
        <span class="small num"><b>${c.key === 'months' ? n1(c.current) : n0(c.current)}</b><span class="muted"> / ${c.key === 'months' ? n1(c.target) : c.target} ${c.unit}</span></span>
        <div class="bar thin"><i style="width:${pct(c.current, c.target || 1)}%;background:${c.met ? 'var(--good)' : 'var(--accent)'}"></i></div></div>`).join('')}
      ${m.needs_profile ? `<p class="muted xs">Cadastro incompleto: informe a data de nascimento${m.next && m.next.choice_needed ? ' (ou escolha a faixa ao graduar)' : ' para conferir a idade mínima'}.</p>` : ''}
      ${m.next ? `<div class="row" style="margin-top:14px;flex-wrap:wrap">
        ${m.next.kind === 'grau' ? `<button class="btn grow" data-act="promote" data-kind="grau">${I('medal', 16)} Dar ${m.next.to_degrees}º grau</button>` : ''}
        <button class="btn ${m.next.kind === 'faixa' ? '' : 'ghost'} grow" data-act="promote" data-kind="faixa">${I('bolt', 16)} ${m.next.kind === 'faixa' ? (m.next.to_belt ? `Graduar faixa ${m.next.to_belt}` : 'Graduar faixa') : 'Trocar de faixa'}</button></div>` : ''}
      <p class="muted xs" style="margin-bottom:0">Critérios da faixa ${s.belt} definidos em Ajustes. Tempos mínimos de faixa e idades seguem o sistema de graduação da IBJJF.</p></div>
    <div class="section-title"><h2>Histórico de graduações</h2></div>
    <div class="list">${promotions.map(p => `<div class="item">${belt(p.to_belt, p.to_degrees)}<div class="grow"><b class="small">${p.kind === 'grau' ? `${p.to_degrees}º grau na faixa ${p.to_belt}` : `Faixa ${p.to_belt}`}</b>
        <div class="muted xs">${ld(p.date)}${p.staff_name ? ` · ${esc(p.staff_name)}` : ''}${p.criteria_met ? '' : ' · <span style="color:var(--warn)">antes dos critérios</span>'}${p.notes ? ` · “${esc(p.notes)}”` : ''}</div></div>
        ${p === lastP && canUndo(p.staff_id, p.created_at) ? `<button class="icon-btn plain" data-act="promo-undo" data-id="${p.id}" aria-label="Desfazer graduação" title="Desfazer">${I('undo', 16)}</button>` : ''}</div>`).join('') || `<div class="empty">Sem graduações registradas no app. Faixa atual desde ${ld(s.belt_since)}.</div>`}</div>`;
  } else if (tab === 'tecnicas') {
    const sf = S.ui.skillFilter;
    const rank = ADULT.indexOf(['cinza', 'amarela', 'laranja', 'verde'].includes(s.belt) ? 'branca' : s.belt);
    const diffIds = new Set(m.difficulties.map(d => d.technique_id));
    let techs = S.techniques.filter(t => t.active);
    if (sf === 'curriculo') techs = techs.filter(t => ADULT.indexOf(t.min_belt) <= rank);
    if (sf === 'dificuldades') techs = techs.filter(t => diffIds.has(t.id));
    if (sf === 'vistas') techs = techs.filter(t => seen[t.id]);
    const groups = CATS.map(c => [c, techs.filter(t => t.category === c)]).filter(([, a]) => a.length);
    body = `<div class="card tight row between"><div><div class="small"><b>${m.learning.pct}%</b> · ${m.learning.label}</div><div class="muted xs">${m.learning.mastered} de ${m.learning.curriculum_size} técnicas do currículo com nível 3+</div></div>
        <div class="mini-ring" style="--p:${m.learning.pct};width:46px;height:46px"><span style="width:38px;height:38px">${m.learning.pct}%</span></div></div>
      <div class="chips" style="margin:12px 0">${[['curriculo', 'Currículo da faixa'], ['dificuldades', `Dificuldades (${m.difficulties.length})`], ['vistas', 'Vistas em aula'], ['todas', 'Todas']].map(([k, l]) => `<button class="chip ${sf === k ? 'on' : ''}" data-act="skill-filter" data-id="${k}">${l}</button>`).join('')}</div>
      <div class="muted xs" style="margin-bottom:10px">${S.labels.skills.map((l, i) => `<b>${i}</b> ${l}`).join(' · ')}</div>
      ${groups.map(([c, arr]) => `<div class="section-title" style="margin-top:14px"><h2 style="font-size:14px">${c}</h2></div><div class="list">${arr.map(t => {
        const lv = skillMap[t.id]?.level ?? 0;
        return `<div class="tech-row" data-tid="${t.id}"><div><div class="small"><b>${esc(t.name)}</b>${diffIds.has(t.id) ? ' <span class="tag warn">dificuldade</span>' : ''}</div>
          <div class="muted xs">${cap(t.min_belt)} · <span class="diff" title="Dificuldade ${t.difficulty}/5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= t.difficulty ? 'on' : ''}"></i>`).join('')}</span>${seen[t.id] ? ` · vista em ${seen[t.id]} aula${seen[t.id] > 1 ? 's' : ''}` : ''}</div></div>
          <div class="lvl" role="radiogroup" aria-label="Nível em ${esc(t.name)}">${[0, 1, 2, 3, 4, 5].map(l => `<button data-act="skill-set" data-l="${l}" data-tid="${t.id}" class="${l === lv ? 'on' : ''}" role="radio" aria-checked="${l === lv}" title="${S.labels.skills[l]}">${l}</button>`).join('')}</div></div>`;
      }).join('')}</div>`).join('') || '<div class="card empty">Nenhuma técnica neste filtro.</div>'}`;
  } else if (tab === 'presencas') {
    const fav = Object.entries(by_class).sort((a, b) => b[1] - a[1]);
    body = `<div class="card"><div class="row between"><h3>Frequência semanal</h3><span class="muted xs">26 semanas</span></div><div id="ch-stu" style="margin-top:10px"></div></div>
      ${fav.length ? `<div class="card"><h3>Horários que mais frequenta</h3>${fav.slice(0, 4).map(([k, v]) => `<div class="macro"><span class="small">${esc(k)}</span><span class="small num">${v}</span><div class="bar thin"><i style="width:${pct(v, fav[0][1])}%"></i></div></div>`).join('')}</div>` : ''}
      <div class="section-title"><h2>Aulas</h2><span class="muted xs">${m.classes_total} no total</span></div>
      <div class="list">${lessons.map(l => `<button class="item" data-act="lesson-open" data-id="${l.id}"><div class="grow"><b class="small">${sd(l.date)} · ${l.start_time}</b><div class="muted xs">${esc(l.class_name || 'Aula avulsa')}${l.title ? ` · ${esc(l.title)}` : ''}</div></div>${I('right', 15)}</button>`).join('') || '<div class="empty">Nenhuma presença registrada.</div>'}</div>`;
  } else {
    body = studentForm(s);
  }
  return {
    html: `<div class="top crumbs"><a class="back" href="#alunos">${I('left', 16)} Alunos</a>
      ${s.phone ? `<a class="btn ghost sm" href="https://wa.me/${esc(s.phone.replace(/\D/g, '').replace(/^(?!55)/, '55'))}" target="_blank" rel="noopener">${I('phone', 15)} WhatsApp</a>` : ''}</div>
    <div class="hero"><div class="hero-id"><div class="avatar">${esc(initials(s.name))}</div>
      <div class="grow"><h1>${esc(s.name)}</h1><div class="sub">${s.nickname ? `“${esc(s.nickname)}” · ` : ''}${m.age != null ? `${m.age} anos · ` : ''}${STATUS[s.status]}</div></div></div>
      <div class="hero-belt">${rank(s, true)}<div><b>${beltName(cap(s.belt), s.degrees)}</b><div class="muted xs">há ${months(m.months_in_belt)} · desde ${ld(s.belt_since)}</div></div></div></div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Experiência</div><div class="stat-value">${m.experience.label}</div><div class="delta">nível ${m.experience.level}/5 · ${months(m.training_months)} de treino</div></div>
      <div class="stat"><div class="stat-label">Aprendizado</div><div class="stat-value">${m.learning.pct}%<small>${m.learning.label}</small></div><div class="delta">${m.techniques_seen} técnicas vistas em aula</div></div>
      <div class="stat"><div class="stat-label">Frequência</div><div class="stat-value">${n1(m.weekly_avg)}<small>aulas/sem</small></div><div class="delta ${m.at_risk ? 'down' : ''}">${m.classes_last_30d} em 30 dias · última ${ago(m.last_attendance)}</div></div>
      <div class="stat"><div class="stat-label">No sistema</div><div class="stat-value">${m.classes_total}<small>aulas</small></div><div class="delta">${n1(m.mat_hours)} h de tatame${s.imported_classes_belt ? ` · +${s.imported_classes_belt} antes` : ''}</div></div>
    </div>
    <div class="tabs" role="tablist">${[['graduacao', 'Graduação'], ['tecnicas', 'Técnicas'], ['presencas', 'Presenças'], ['dados', 'Dados']].map(([k, l]) => `<button data-act="detail-tab" data-id="${k}" class="${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
    <div class="tab-body">${body}</div>`,
    after() {
      if (tab === 'presencas') Charts.bars($('#ch-stu'), weekly.map(w => ({ label: sd(w.week), value: w.count, tip: `<b>${w.count} aula${w.count === 1 ? '' : 's'}</b> · semana de ${sd(w.week)}` })), { empty: 'Ainda sem presenças' });
      if (tab === 'dados') bindStudentForm(s);
    }
  };
};

function studentForm(s) {
  const n = !s; s = s || {};
  // Campos que mudam a contagem para graduação: depois do cadastro, só o administrador corrige (o servidor também confere).
  const lock = !n && !isAdmin() ? 'disabled' : '';
  return `<form id="stu-form" class="card form-grid" novalidate>
    <label class="field full"><span>Nome completo *</span><input class="input" name="name" maxlength="80" value="${esc(s.name || '')}" required ${n ? 'autofocus' : ''}></label>
    <label class="field"><span>Apelido</span><input class="input" name="nickname" maxlength="40" value="${esc(s.nickname || '')}"></label>
    <label class="field"><span>Nascimento</span><input class="input" type="date" name="birth_date" value="${s.birth_date || ''}" max="${S.today}"></label>
    <label class="field"><span>Telefone (WhatsApp)</span><input class="input" name="phone" inputmode="tel" maxlength="30" value="${esc(s.phone || '')}"></label>
    <label class="field"><span>E-mail</span><input class="input" type="email" name="email" maxlength="120" value="${esc(s.email || '')}"></label>
    <label class="field"><span>Início na academia *</span><input class="input" type="date" name="start_date" value="${s.start_date || S.today}" max="${S.today}" required></label>
    <label class="field"><span>Experiência anterior (meses)</span><input class="input" name="prior_months" inputmode="numeric" value="${s.prior_months ?? 0}"></label>
    ${n ? `<label class="field"><span>Faixa atual</span><select class="input" name="belt">${BELTS.map(b => `<option value="${b}">${cap(b)}</option>`).join('')}</select></label>
      <label class="field"><span>Graus</span><select class="input" name="degrees">${[0, 1, 2, 3, 4, 5, 6].map(d => `<option>${d}</option>`).join('')}</select></label>` : ''}
    <label class="field"><span>Na faixa atual desde</span><input class="input" type="date" name="belt_since" value="${s.belt_since || ''}" max="${S.today}" placeholder="início" ${lock}></label>
    <label class="field"><span>Data do último grau</span><input class="input" type="date" name="degree_since" value="${s.degree_since || ''}" max="${S.today}" ${lock}></label>
    <label class="field"><span>Aulas na faixa atual antes do sistema</span><input class="input" name="imported_classes_belt" inputmode="numeric" value="${s.imported_classes_belt ?? 0}" ${lock}></label>
    <label class="field"><span>Aulas desde o último grau antes do sistema</span><input class="input" name="imported_classes_degree" inputmode="numeric" value="${s.imported_classes_degree ?? 0}" ${lock}></label>
    <p class="full muted xs" style="margin:-4px 0 0">Para alunos antigos: estimativa das aulas feitas antes de usar o Tatame. Entram na contagem para grau e faixa e zeram na próxima graduação.${lock ? ' Depois do cadastro, só o administrador altera as datas de graduação e essas aulas.' : ''}</p>
    <label class="field"><span>Peso (kg)</span><input class="input" name="weight_kg" inputmode="decimal" value="${s.weight_kg ?? ''}"></label>
    <label class="field"><span>Situação</span><select class="input" name="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${(s.status || 'ativo') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Sexo</span><select class="input" name="sex"><option value="">–</option>${[['m', 'Masculino'], ['f', 'Feminino'], ['x', 'Outro / não informar']].map(([k, l]) => `<option value="${k}" ${s.sex === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field full"><span>Objetivos</span><input class="input" name="goals" maxlength="500" value="${esc(s.goals || '')}" placeholder="Ex.: competir, defesa pessoal, condicionamento"></label>
    <label class="field full"><span>Observações do professor</span><textarea class="input" name="notes" maxlength="2000">${esc(s.notes || '')}</textarea></label>
    <div class="err full" id="stu-err"></div>
    ${!n && isAdmin() ? `<button type="button" class="btn danger" data-act="student-delete" data-id="${s.id}">${I('trash', 15)} Excluir</button>` : ''}
    <button class="btn ${!n && isAdmin() ? '' : 'full'}" type="submit">${n ? 'Cadastrar aluno' : 'Salvar dados'}</button>
  </form>`;
}

function bindStudentForm(s) {
  $('#stu-form').onsubmit = async e => {
    e.preventDefault();
    const b = formObj(e.target), err = $('#stu-err'); err.textContent = '';
    if (String(b.name).trim().length < 2) return err.textContent = 'Informe o nome do aluno.';
    if (!b.start_date) return err.textContent = 'Informe a data de início.';
    if (b.belt_since && b.degree_since && b.degree_since < b.belt_since) return err.textContent = 'O último grau não pode ser anterior à faixa atual.';
    if (+b.imported_classes_degree > +b.imported_classes_belt) return err.textContent = 'As aulas desde o último grau não podem ser mais que as aulas na faixa.';
    if (!b.belt_since) delete b.belt_since; if (!b.degree_since) delete b.degree_since;
    const btn = e.target.querySelector('[type=submit]');
    const d = await busy(btn, () => s ? api('PUT', '/api/students/' + s.id, b) : api('POST', '/api/students', b), s ? 'Dados salvos.' : 'Aluno cadastrado.');
    if (!d) return;
    detail = d; await refresh(); closeSheet();
    if (!s) { S.ui.detailTab = 'graduacao'; location.hash = 'aluno/' + d.student.id; } else render();
  };
}

function openPromote(kind) {
  const s = detail.student, m = s.metrics;
  const proposed = kind === 'grau' ? { belt: s.belt, deg: s.degrees + 1 } : { belt: m.next && m.next.kind === 'faixa' ? m.next.to_belt : m.next && m.next.choice_needed ? null : BELTS[BELTS.indexOf(s.belt) + 1], deg: 0 };
  const ok = m.ready && m.next && m.next.kind === kind;
  const w = sheet(`${sheetHead(kind === 'grau' ? 'Dar grau' : 'Graduar faixa')}
    <div class="row" style="gap:12px;margin-bottom:14px">${belt(s.belt, s.degrees, true)} ${I('right', 18)} <span id="pv-belt">${proposed.belt ? belt(proposed.belt, proposed.deg, true) : '<span class="muted small">faixa a definir</span>'}</span></div>
    ${ok ? '<div class="card tight" style="border-color:rgba(61,190,139,.4)"><span class="small" style="color:var(--good)">Critérios cumpridos.</span></div>'
      : `<div class="card tight" style="border-color:rgba(227,179,65,.4)"><div class="small" style="color:var(--warn)">Critérios ainda não cumpridos:</div><div class="muted xs" style="margin-top:4px">${m.next && m.next.kind === kind ? m.criteria.filter(c => !c.met).map(c => `${c.label}: ${c.key === 'months' ? n1(c.current) : n0(c.current)} de ${c.target} ${c.unit}`).join(' · ') : 'Esta graduação é diferente da próxima prevista.'}</div><div class="muted xs" style="margin-top:4px">Você pode graduar mesmo assim; fica registrado.</div></div>`}
    <form id="promo" class="form-grid" style="margin-top:12px" novalidate>
      ${kind === 'faixa' ? `<label class="field full"><span>Nova faixa</span><select class="input" name="to_belt" ${proposed.belt ? '' : 'required'}>${proposed.belt ? '' : '<option value="">Escolha a faixa…</option>'}${BELTS.slice(BELTS.indexOf(s.belt) + 1).map(b => `<option value="${b}" ${b === proposed.belt ? 'selected' : ''}>${cap(b)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>Data</span><input class="input" type="date" name="date" value="${S.today}" max="${S.today}" min="${s.degree_since}" required></label>
      <label class="field full"><span>Observação</span><input class="input" name="notes" maxlength="500" placeholder="Ex.: exame de faixa, cerimônia de fim de ano"></label>
      <button class="btn full ${ok ? '' : ''}">${ok ? 'Confirmar graduação' : 'Graduar mesmo assim'}</button></form>`);
  const sel = $('[name=to_belt]', w);
  if (sel) sel.onchange = () => { $('#pv-belt', w).innerHTML = sel.value ? belt(sel.value, 0, true) : '<span class="muted small">faixa a definir</span>'; };
  $('#promo', w).onsubmit = async e => {
    e.preventDefault();
    const b = { ...formObj(e.target), kind, override: !ok };
    const d = await busy(e.target.querySelector('button'), () => api('POST', `/api/students/${s.id}/promote`, b), kind === 'grau' ? 'Grau registrado. Oss!' : 'Nova faixa registrada. Oss!');
    if (!d) return;
    detail = d; closeSheet(); await refresh(); render();
  };
}

// =====================================================================
// AULAS: chamadas e horários
// =====================================================================
let lessonsCache = null;
VIEWS.aulas = () => {
  const tab = S.ui.aulasTab;
  if (tab === 'chamadas' && !lessonsCache) {
    api('GET', '/api/lessons').then(r => { lessonsCache = r; if (route()[0] === 'aulas') render(); }).catch(e => toast(e.message, 'error'));
  }
  let body = '';
  if (tab === 'chamadas') {
    const todays = S.dashboard.todays;
    // Agenda: as aulas registradas agrupadas por dia, com a data numa coluna à esquerda.
    const days = [];
    for (const l of lessonsCache || []) { const d = days[days.length - 1]; if (d && d[0] === l.date) d[1].push(l); else days.push([l.date, [l]]); }
    body = `${todays.length ? `<div class="section-title"><h2>Hoje</h2></div><div class="list">${todaysSorted().map(c => slotRow(c, c === nextPending())).join('')}</div>` : ''}
      <div class="section-title"><h2>Últimas aulas</h2><span class="muted xs">60 dias</span></div>
      ${!lessonsCache ? '<div class="skeleton"></div>' : lessonsCache.length ? `<div class="agenda">${days.map(([d, arr]) => `<div class="agenda-day"><div class="agenda-date"><b>${pd(d).getDate()}</b><span>${WDS[pd(d).getDay()]}</span><span>${MONTHS[pd(d).getMonth()]}</span></div>
        <div class="list">${arr.map(l => `<button class="item lrow" data-act="lesson-open" data-id="${l.id}"><span class="slot-time"><b>${l.start_time}</b></span>
          <div class="grow"><b class="ellipsis" style="display:block">${esc(l.class_name || 'Aula avulsa')}${l.title ? `<span class="muted"> · ${esc(l.title)}</span>` : ''}</b><div class="muted xs">${l.technique_ids.length} técnica${l.technique_ids.length === 1 ? '' : 's'}${l.instructor_name ? ` · ${esc(l.instructor_name)}` : ''}</div></div>
          <span class="l-count"><b class="num">${l.attendees}</b><span class="muted xs">${!l.attendees && l.roll_called === 0 ? 'sem chamada' : `aluno${l.attendees === 1 ? '' : 's'}`}</span></span></button>`).join('')}</div></div>`).join('')}</div>`
        : '<div class="card empty"><b>Nenhuma aula registrada</b>Faça a chamada de cada aula: quem veio e quais técnicas foram passadas. Isso alimenta frequência, graduação e aprendizado.</div>'}`;
  } else {
    // Grade semanal: uma coluna por dia no desktop; no mobile, só os dias com aula, empilhados.
    // Só a aula de hoje em andamento (ou a próxima) ganha destaque, pelo relógio da academia.
    const occ = Object.fromEntries(S.dashboard.occupancy.map(o => [o.class_id, o]));
    const wdToday = pd(S.today).getDay(), now = nowMin();
    const todayCls = S.classes.filter(c => c.active && c.weekday === wdToday).sort((a, b) => a.start_time.localeCompare(b.start_time));
    const live = todayCls.find(c => now >= hm(c.start_time) && now < hm(c.end_time)), soon = !live && todayCls.find(c => now < hm(c.start_time));
    body = S.classes.length ? `<div class="week">${[1, 2, 3, 4, 5, 6, 0].map(w => {
      const arr = S.classes.filter(c => c.weekday === w).sort((a, b) => a.start_time.localeCompare(b.start_time));
      return `<div class="wcol ${arr.length ? '' : 'none'} ${w === wdToday ? 'today' : ''}"><div class="wcol-h">${cap(WD[w])}${w === wdToday ? '<span class="tag accent">hoje</span>' : ''}</div>
        ${arr.map(c => { const hl = c === live ? 'agora' : c === soon ? 'próxima' : ''; return `<button class="cls ${c.active ? '' : 'off'} ${hl ? 'now' : ''}" data-act="class-edit" data-id="${c.id}"><span class="cls-t num">${c.start_time}–${c.end_time}${hl ? ` <em>${hl}</em>` : ''}</span><b>${esc(c.name)}</b>
          <span class="muted xs">${classMeta(c)}${c.active ? '' : ' · desativado'}</span>
          <span class="cls-occ"><b class="num">${occ[c.id] ? n1(occ[c.id].avg) : '–'}</b> <span class="muted xs">alunos/aula</span></span></button>`; }).join('') || '<span class="wcol-none">Sem aula</span>'}</div>`;
    }).join('')}</div>`
      : '<div class="card empty"><b>Nenhum horário cadastrado</b>Cadastre a grade da academia (dia, horário, nível). A chamada já vem preenchida com a turma certa.</div>';
  }
  return {
    html: `<div class="top"><div><h1>Aulas</h1><div class="sub">Chamada, técnicas passadas e horários</div></div>
      ${tab === 'chamadas' ? `<button class="btn ghost sm" data-act="lesson-new" data-date="${S.today}">${I('plus', 15)} Nova chamada</button>` : `<button class="btn ghost sm" data-act="class-edit">${I('plus', 15)} Novo horário</button>`}</div>
    <div class="tabs" role="tablist"><button data-act="aulas-tab" data-id="chamadas" class="${tab === 'chamadas' ? 'on' : ''}" role="tab" aria-selected="${tab === 'chamadas'}">Chamadas</button><button data-act="aulas-tab" data-id="horarios" class="${tab === 'horarios' ? 'on' : ''}" role="tab" aria-selected="${tab === 'horarios'}">Horários <span class="muted num">${S.classes.length}</span></button></div>
    <div class="tab-body">${body}</div>`
  };
};

// ---------- Editor de chamada ----------
async function openLesson({ id, classId, date }) {
  let L;
  if (id) { L = await busy(null, () => api('GET', '/api/lessons/' + id)); if (!L) return; }
  else {
    const c = classId ? clsById(classId) : null;
    L = { id: null, class_id: c ? c.id : null, date: date || S.today, start_time: c ? c.start_time : '19:00', end_time: c ? c.end_time : '20:30', modality: c ? c.modality : 'gi', title: '', notes: '', roll_called: null, student_ids: [], technique_ids: [] };
  }
  S.ui.lesson = { ...L, student_ids: new Set(L.student_ids), technique_ids: new Set(L.technique_ids), q: '', tq: '' };
  renderLesson();
}

function renderLesson() {
  const L = S.ui.lesson, o = $('#overlay');
  const scroll = $('#lesson-screen') ? $('#lesson-screen').scrollTop : 0;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Quem costuma vir nesse horário aparece primeiro.
  const freq = {};
  if (L.class_id && lessonsCache) for (const l of lessonsCache.filter(x => x.class_id === L.class_id)) freq[l.id] = 1;
  const pool = S.students.filter(s => s.status === 'ativo' || L.student_ids.has(s.id))
    .filter(s => !L.q || norm(s.name).includes(norm(L.q)) || norm(s.nickname).includes(norm(L.q)))
    .sort((a, b) => (L.student_ids.has(b.id) - L.student_ids.has(a.id)) || (b.metrics.weekly_avg - a.metrics.weekly_avg) || a.name.localeCompare(b.name));
  const techs = S.techniques.filter(t => t.active && (!L.tq || norm(t.name).includes(norm(L.tq)) || norm(t.category).includes(norm(L.tq))));
  o.innerHTML = `<div class="full-screen" id="lesson-screen"><div class="app">
    <div class="top"><button class="icon-btn" data-act="lesson-close" aria-label="Fechar">${I('left', 18)}</button><h1 style="font-size:20px">${L.id ? 'Editar chamada' : 'Chamada'}</h1>
      ${L.id && canUndo(L.created_by, L.created_at) ? `<button class="icon-btn" data-act="lesson-delete" aria-label="Excluir aula">${I('trash', 17)}</button>` : '<span style="width:38px"></span>'}</div>
    <div class="card form-grid">
      <label class="field full"><span>Horário</span><select class="input" id="ls-class"><option value="">Aula avulsa</option>${S.classes.filter(c => c.active || c.id === L.class_id).map(c => `<option value="${c.id}" ${c.id === L.class_id ? 'selected' : ''}>${WDS[c.weekday]} ${c.start_time} · ${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Data</span><input class="input" type="date" id="ls-date" value="${L.date}" max="${S.today}"></label>
      <label class="field"><span>Modalidade</span><select class="input" id="ls-mod">${Object.entries(MOD).map(([k, l]) => `<option value="${k}" ${L.modality === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Início</span><input class="input" type="time" id="ls-start" value="${L.start_time}"></label>
      <label class="field"><span>Fim</span><input class="input" type="time" id="ls-end" value="${L.end_time}"></label>
      <label class="field full"><span>Tema da aula</span><input class="input" id="ls-title" maxlength="120" value="${esc(L.title || '')}" placeholder="Ex.: passagem de guarda aberta"></label>
    </div>
    <div class="section-title"><h2>Presença</h2><span class="tag accent" id="att-count">${L.student_ids.size} presente${L.student_ids.size === 1 ? '' : 's'}</span></div>
    <label class="field full row" id="ls-roll-row" style="gap:8px;margin-bottom:8px;${L.student_ids.size ? 'display:none' : ''}"><input type="checkbox" id="ls-roll" ${L.roll_called === 1 ? 'checked' : ''}> <span style="margin:0">Chamada feita: ninguém compareceu${L.id && L.roll_called == null ? ' <span class="muted xs">(chamada ainda não registrada)</span>' : ''}</span></label>
    <input class="input" id="ls-q" placeholder="Buscar aluno" value="${esc(L.q)}" style="margin-bottom:8px">
    <div class="list" id="att-list">${pool.map(s => `<button class="att ${L.student_ids.has(s.id) ? 'on' : ''}" data-act="att-toggle" data-id="${s.id}" aria-pressed="${L.student_ids.has(s.id)}">
      <span class="box">${I('check', 15)}</span><div class="grow"><b class="small">${esc(s.name)}</b><div class="row" style="gap:6px;margin-top:3px">${belt(s.belt, s.degrees)}<span class="muted xs">${n1(s.metrics.weekly_avg)}/sem</span></div></div></button>`).join('') || '<div class="empty">Nenhum aluno ativo encontrado. Cadastre alunos primeiro.</div>'}</div>
    <div class="section-title"><h2>Técnicas passadas</h2><span class="tag">${L.technique_ids.size}</span></div>
    ${L.technique_ids.size ? `<div class="chips" style="flex-wrap:wrap;margin-bottom:10px">${[...L.technique_ids].map(id => techById(id)).filter(Boolean).map(t => `<button class="chip on" data-act="tech-toggle" data-id="${t.id}">${esc(t.name)} ${I('x', 12)}</button>`).join('')}</div>` : ''}
    <input class="input" id="ls-tq" placeholder="Buscar técnica ou categoria" value="${esc(L.tq)}" style="margin-bottom:8px">
    <div class="list" style="max-height:320px;overflow:auto">${techs.map(t => `<button class="att ${L.technique_ids.has(t.id) ? 'on' : ''}" data-act="tech-toggle" data-id="${t.id}"><span class="box">${I('check', 15)}</span><div class="grow"><b class="small">${esc(t.name)}</b><div class="muted xs">${t.category} · ${cap(t.min_belt)}</div></div></button>`).join('')}</div>
    <label class="field" style="margin-top:12px"><span>Observações</span><textarea class="input" id="ls-notes" maxlength="2000" placeholder="Como foi a aula, quem precisa de atenção">${esc(L.notes || '')}</textarea></label>
    <p class="muted xs">Ao salvar, os alunos presentes passam a ter as técnicas da aula como “vistas em aula” (nível 1), sem rebaixar quem já tem nível maior.</p>
    <div class="sticky-bar"><button class="btn block" data-act="lesson-save">${I('check', 16)} Salvar chamada (${L.student_ids.size})</button></div>
  </div></div>`;
  $('#lesson-screen').scrollTop = scroll;
  const bind = (sel, key) => { const el = $(sel); el.oninput = el.onchange = () => { L[key] = el.value; }; };
  $('#ls-roll').onchange = e => { L.roll_called = e.target.checked ? 1 : 0; };
  bind('#ls-date', 'date'); bind('#ls-mod', 'modality'); bind('#ls-start', 'start_time'); bind('#ls-end', 'end_time'); bind('#ls-title', 'title'); bind('#ls-notes', 'notes');
  $('#ls-class').onchange = e => { L.class_id = e.target.value || null; const c = clsById(L.class_id); if (c) { L.start_time = c.start_time; L.end_time = c.end_time; L.modality = c.modality; } renderLesson(); };
  const live = (sel, key) => { const el = $(sel); el.oninput = () => { L[key] = el.value; const pos = el.selectionStart; renderLesson(); const n = $(sel); n.focus(); n.setSelectionRange(pos, pos); }; };
  live('#ls-q', 'q'); live('#ls-tq', 'tq');
}

async function saveLesson(btn) {
  const L = S.ui.lesson;
  if (!L.date) return toast('Informe a data.', 'error');
  if (!L.start_time || !L.end_time || L.end_time <= L.start_time) return toast('Confira o horário de início e fim.', 'error');
  if (!L.student_ids.size && L.roll_called !== 1 && !(await confirmBox('Salvar sem chamada?', 'Nenhum aluno foi marcado como presente, então a aula fica sem chamada e não entra na média de presença. Se a chamada foi feita e ninguém veio, marque "Chamada feita: ninguém compareceu".', 'Salvar', false))) return;
  const b = { class_id: L.class_id, date: L.date, start_time: L.start_time, end_time: L.end_time, modality: L.modality, title: L.title, notes: L.notes, roll_called: L.student_ids.size ? true : L.roll_called == null ? null : L.roll_called === 1, student_ids: [...L.student_ids], technique_ids: [...L.technique_ids] };
  const r = await busy(btn, () => L.id ? api('PUT', '/api/lessons/' + L.id, b) : api('POST', '/api/lessons', b), 'Chamada salva.');
  if (!r) return;
  $('#overlay').innerHTML = ''; S.ui.lesson = null; lessonsCache = null; detail = null;
  await refresh(); render();
}

function openClass(id) {
  const c = id ? clsById(id) : { weekday: 1, start_time: '19:00', end_time: '20:30', level: 'todos', modality: 'gi', active: 1 };
  const w = sheet(`${sheetHead(id ? 'Editar horário' : 'Novo horário')}<form id="cls" class="form-grid" novalidate>
    <label class="field full"><span>Nome da turma</span><input class="input" name="name" maxlength="60" value="${esc(c.name || '')}" placeholder="Ex.: Fundamentos, Avançada, Kids" autofocus required></label>
    <label class="field"><span>Dia da semana</span><select class="input" name="weekday">${[1, 2, 3, 4, 5, 6, 0].map(d => `<option value="${d}" ${+c.weekday === d ? 'selected' : ''}>${cap(WD[d])}</option>`).join('')}</select></label>
    <label class="field"><span>Nível</span><select class="input" name="level">${Object.entries(LEVEL).map(([k, l]) => `<option value="${k}" ${c.level === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Início</span><input class="input" type="time" name="start_time" value="${c.start_time}" required></label>
    <label class="field"><span>Fim</span><input class="input" type="time" name="end_time" value="${c.end_time}" required></label>
    <label class="field"><span>Modalidade</span><select class="input" name="modality">${Object.entries(MOD).map(([k, l]) => `<option value="${k}" ${c.modality === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field"><span>Professor</span><select class="input" name="instructor_id"><option value="">–</option>${S.staff.filter(s => s.active).map(s => `<option value="${s.id}" ${c.instructor_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    ${id ? `<label class="field full row" style="gap:8px"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> <span style="margin:0">Horário ativo</span></label>` : ''}
    <div class="err full" id="cls-err"></div>
    ${id && isAdmin() ? `<button type="button" class="btn danger" id="cls-del">${I('trash', 15)} Excluir</button>` : ''}<button class="btn ${id && isAdmin() ? '' : 'full'}">Salvar</button></form>`);
  $('#cls', w).onsubmit = async e => {
    e.preventDefault();
    const b = formObj(e.target); b.weekday = +b.weekday; b.active = id ? !!e.target.active.checked : true;
    if (String(b.name).trim().length < 2) return $('#cls-err', w).textContent = 'Informe o nome da turma.';
    if (!b.start_time || !b.end_time || b.end_time <= b.start_time) return $('#cls-err', w).textContent = 'O fim precisa ser depois do início.';
    const r = await busy(e.target.querySelector('button:not([type=button])'), () => id ? api('PUT', '/api/classes/' + id, b) : api('POST', '/api/classes', b), 'Horário salvo.');
    if (!r) return; closeSheet(); await refresh(); render();
  };
  if (id && isAdmin()) $('#cls-del', w).onclick = async () => {
    w._onClose = null;
    if (!(await confirmBox('Excluir horário?', 'As aulas já registradas continuam no histórico como aulas avulsas. Para só pausar, desative.', 'Excluir'))) return;
    await busy(null, async () => { await api('DELETE', '/api/classes/' + id); await refresh(); render(); }, 'Horário excluído.');
  };
}

// =====================================================================
// TÉCNICAS
// =====================================================================
VIEWS.tecnicas = () => {
  const cat = S.ui.techCat, st = S.ui.techSt;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = norm(S.ui.techQ);
  const list = S.techniques.filter(t => (!cat || t.category === cat)
    && (!st || (st === 'nunca' && t.active && !t.times_taught) || (st === 'avaliadas' && t.avg_level != null) || (st === 'off' && !t.active))
    && (!q || norm(t.name).includes(q) || norm(t.category).includes(q) || norm(t.description).includes(q)));
  const never = S.techniques.filter(t => t.active && !t.times_taught);
  const dots = d => `<span class="diff" title="Dificuldade ${d}/5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= d ? 'on' : ''}"></i>`).join('')}</span>`;
  return {
    html: `<div class="top"><div><h1>Técnicas</h1><div class="sub">${S.techniques.filter(t => t.active).length} no currículo · ${never.length} nunca ensinadas</div></div>${isAdmin() ? `<button class="btn ghost sm" data-act="tech-edit">${I('plus', 15)} Nova técnica</button>` : ''}</div>
    <div class="lib">
      <div class="chips lib-cats" role="group" aria-label="Categorias"><button class="chip ${!cat ? 'on' : ''}" data-act="tech-cat" data-id="">Todas <span class="muted">${S.techniques.length}</span></button>${CATS.map(c => `<button class="chip ${cat === c ? 'on' : ''}" data-act="tech-cat" data-id="${c}">${c} <span class="muted">${S.techniques.filter(t => t.category === c).length}</span></button>`).join('')}</div>
      <div class="lib-main">
        <div class="toolbar-r lib-tools"><label class="search">${I('search', 15)}<input class="input" id="tech-q" placeholder="Buscar técnica" value="${esc(S.ui.techQ)}" aria-label="Buscar técnica"></label>
          <select class="input" id="tech-st" aria-label="Filtrar por situação">${[['', 'Todas as situações'], ['nunca', 'Nunca ensinadas'], ['avaliadas', 'Com avaliação'], ['off', 'Desativadas']].map(([k, l]) => `<option value="${k}" ${st === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${ADULT.map(b => { const arr = list.filter(t => t.min_belt === b); return arr.length ? `<div class="section-title"><h2>${belt(b)} Currículo ${b}</h2><span class="muted xs num">${arr.length}</span></div>
          <div class="list">${arr.map(t => `<button class="item tlib ${t.active ? '' : 'off'}" data-act="tech-edit" data-id="${t.id}">
            <span class="tl-name"><b>${esc(t.name)}</b><span class="muted xs">${t.category}${t.active ? '' : ' · desativada'}</span></span>
            <span class="tl-diff">${dots(t.difficulty)}</span>
            <span class="tl-use xs">${t.times_taught ? `<span class="num">${t.times_taught}×</span> <span class="muted">· última ${sd(t.last_taught)}</span>` : '<span style="color:var(--warn)">nunca ensinada</span>'}</span>
            <span class="tl-lvl">${t.avg_level != null ? `<span class="bar thin"><i style="width:${pct(t.avg_level, 5)}%"></i></span><span class="num small">${n1(t.avg_level)}</span>` : '<span class="muted xs">sem avaliação</span>'}</span></button>`).join('')}</div>` : ''; }).join('') || '<div class="empty"><b>Nenhuma técnica encontrada</b>Mude a busca ou os filtros.</div>'}
      </div>
    </div>`,
    after() {
      const qi = $('#tech-q');
      qi.oninput = () => { S.ui.techQ = qi.value; const pos = qi.selectionStart; render(); const n = $('#tech-q'); n.focus(); n.setSelectionRange(pos, pos); };
      $('#tech-st').onchange = e => { S.ui.techSt = e.target.value; render(); };
    }
  };
};

function openTech(id) {
  const t = id ? techById(id) : { category: S.ui.techCat || 'Fundamentos', min_belt: 'branca', difficulty: 2, active: 1 };
  // Professor só consulta o catálogo: mesma folha, campos travados, sem botões de salvar e excluir.
  const ro = !isAdmin(), dis = ro ? 'disabled' : '';
  const w = sheet(`${sheetHead(ro ? 'Técnica' : id ? 'Editar técnica' : 'Nova técnica')}<form id="tf" class="form-grid" novalidate>
    <label class="field full"><span>Nome</span><input class="input" name="name" maxlength="80" value="${esc(t.name || '')}" ${ro ? '' : 'autofocus'} required ${dis}></label>
    <label class="field"><span>Categoria</span><select class="input" name="category" ${dis}>${CATS.map(c => `<option ${t.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label class="field"><span>Currículo da faixa</span><select class="input" name="min_belt" ${dis}>${ADULT.map(b => `<option value="${b}" ${t.min_belt === b ? 'selected' : ''}>${cap(b)}</option>`).join('')}</select></label>
    <label class="field full"><span>Dificuldade (1 a 5)</span><div class="seg" id="tf-diff">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-d="${i}" class="${+t.difficulty === i ? 'on' : ''}" ${dis}>${i}</button>`).join('')}</div></label>
    <label class="field full"><span>Descrição</span><textarea class="input" name="description" maxlength="500" ${dis}>${esc(t.description || '')}</textarea></label>
    ${id ? `<label class="field full row" style="gap:8px"><input type="checkbox" name="active" ${t.active ? 'checked' : ''} ${dis}> <span style="margin:0">Faz parte do currículo (ativa)</span></label>
      <div class="full muted xs">${t.times_taught ? `Ensinada ${t.times_taught} vezes · ${t.assessed} aluno(s) avaliado(s) · ${t.proficient} com nível 3+` : 'Ainda não foi ensinada.'}</div>` : ''}
    <div class="err full" id="tf-err"></div>
    ${ro ? '<p class="full muted xs" style="margin:0">Só o administrador edita o catálogo de técnicas.</p>'
      : `${id && !t.times_taught && !t.assessed ? `<button type="button" class="btn danger" id="tf-del">${I('trash', 15)} Excluir</button>` : ''}<button class="btn ${id && !t.times_taught && !t.assessed ? '' : 'full'}">Salvar</button>`}</form>`);
  let diff = +t.difficulty;
  if (!ro) $$('#tf-diff button', w).forEach(b => b.onclick = () => { diff = +b.dataset.d; $$('#tf-diff button', w).forEach(x => x.classList.toggle('on', x === b)); });
  $('#tf', w).onsubmit = async e => {
    e.preventDefault();
    const b = { ...formObj(e.target), difficulty: diff, active: id ? !!e.target.active.checked : true };
    if (String(b.name).trim().length < 2) return $('#tf-err', w).textContent = 'Informe o nome da técnica.';
    const r = await busy(e.target.querySelector('button:not([type=button])'), () => id ? api('PUT', '/api/techniques/' + id, b) : api('POST', '/api/techniques', b), 'Técnica salva.');
    if (!r) return; closeSheet(); await refresh(); render();
  };
  const del = $('#tf-del', w);
  if (del) del.onclick = async () => { w._onClose = null; if (!(await confirmBox('Excluir técnica?', 'Ela sai do catálogo.', 'Excluir'))) return; await busy(null, async () => { await api('DELETE', '/api/techniques/' + id); await refresh(); render(); }, 'Técnica excluída.'); };
}

// =====================================================================
// AJUSTES
// =====================================================================
VIEWS.ajustes = () => {
  const adm = isAdmin();
  return {
    html: `<div class="top"><div><h1>Ajustes</h1><div class="sub">${esc(S.me.name)} · ${S.me.role === 'admin' ? 'Administrador' : 'Professor'}</div></div><button class="icon-btn" data-act="logout" aria-label="Sair">${I('logout', 18)}</button></div>
    ${adm ? `<form id="acad" class="card row" novalidate><label class="field grow"><span>Nome da academia</span><input class="input" name="academy_name" maxlength="80" value="${esc(S.settings.academy_name || '')}"></label><button class="btn" style="align-self:flex-end">Salvar</button></form>` : ''}
    <div class="section-title"><h2>Critérios de graduação</h2>${adm ? '' : '<span class="muted xs">só o administrador edita</span>'}</div>
    <form id="rules" class="card" novalidate><div class="table-wrap"><table class="rules"><thead><tr><th>Faixa</th><th>Meses entre graus</th><th>Aulas entre graus</th><th>Meses na faixa</th><th>Aulas na faixa</th><th>Currículo %</th><th>Idade p/ próxima</th></tr></thead>
      <tbody>${BELTS.map(b => { const r = S.rules.find(x => x.belt === b); const black = b === 'preta'; const inp = (k, v) => `<td><input class="input" name="${b}.${k}" inputmode="decimal" value="${v ?? ''}" ${adm && !(black && k !== 'degree_months' && k !== 'degree_classes') ? '' : 'disabled'} aria-label="${k} ${b}"></td>`;
        return `<tr><td><span class="row" style="gap:8px">${belt(b)} ${cap(b)}</span></td>${inp('degree_months', r.degree_months)}${inp('degree_classes', r.degree_classes)}${inp('belt_months', r.belt_months)}${inp('belt_classes', r.belt_classes)}${inp('curriculum_pct', r.curriculum_pct)}${inp('next_min_age', r.next_min_age)}</tr>`; }).join('')}</tbody></table></div>
      <p class="muted xs">Padrões: tempo mínimo na faixa azul (24 meses), roxa (18) e marrom (12) e idades mínimas (azul/roxa 16, marrom 18, preta 19; amarela 7, laranja 10, verde 13) seguem o Sistema Geral de Graduação da IBJJF. Meses e aulas entre graus e o % de currículo são escolha da academia. “Currículo %” é a parcela das técnicas até a faixa atual com nível 3 (executa sozinho) ou mais.</p>
      ${adm ? '<button class="btn">Salvar critérios</button>' : ''}</form>
    <div class="section-title"><h2>Níveis calculados</h2></div>
    <div class="card small"><b>Experiência</b> (aulas registradas + meses de experiência anterior × 8): ${S.labels.experience.map(([n, l]) => `${l} ${n}+`).join(' · ')}<hr class="sep">
      <b>Aprendizado</b> (média do nível 0–5 nas técnicas do currículo até a faixa do aluno): ${S.labels.learning.map(([n, l]) => `${l} ${n}%+`).join(' · ')}<hr class="sep">
      <b>Dificuldade do aluno</b>: técnica vista em 2 ou mais aulas e ainda com nível 2 ou menos. <b>Sem treinar</b>: aluno ativo sem presença há 14 dias ou mais.</div>
    ${adm ? `<div class="section-title"><h2>Equipe</h2><button class="link" data-act="staff-edit">+ Adicionar</button></div>
      <div class="list">${S.staff.map(p => `<button class="item" data-act="staff-edit" data-id="${p.id}" style="${p.active ? '' : 'opacity:.5'}"><div class="avatar">${esc(initials(p.name))}</div><div class="grow"><b class="small">${esc(p.name)}</b><div class="muted xs">${esc(p.email || '')} · ${p.role === 'admin' ? 'Administrador' : 'Professor'}${p.active ? '' : ' · sem acesso'}</div></div>${p.belt ? belt(p.belt) : ''}</button>`).join('')}</div>` : ''}
    <div class="section-title"><h2>Minha conta</h2></div>
    <form id="pw" class="card form-grid" novalidate><label class="field"><span>Senha atual</span><input class="input" type="password" name="current" autocomplete="current-password"></label>
      <label class="field"><span>Nova senha</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="8"></label><button class="btn ghost full">Trocar senha</button></form>
    <div class="row">${adm ? `<a class="btn ghost grow" href="/api/export/alunos.csv" download>${I('download', 16)} Exportar alunos (CSV)</a>` : ''}<button class="btn ghost grow" data-act="logout">${I('logout', 16)} Sair</button></div>`,
    after() {
      if (adm) {
        $('#acad').onsubmit = async e => { e.preventDefault(); const r = await busy(e.target.querySelector('button'), () => api('PUT', '/api/settings', formObj(e.target)), 'Nome salvo.'); if (r) { await refresh(); render(); } };
        $('#rules').onsubmit = async e => {
          e.preventDefault();
          const rules = BELTS.map(b => { const o = { belt: b }; for (const k of ['degree_months', 'degree_classes', 'belt_months', 'belt_classes', 'curriculum_pct', 'next_min_age']) { const el = e.target.elements[`${b}.${k}`]; o[k] = el && !el.disabled && el.value !== '' ? Number(el.value.replace(',', '.')) : null; } return o; });
          const r = await busy(e.target.querySelector('button'), () => api('PUT', '/api/rules', { rules }), 'Critérios salvos. Os alunos foram recalculados.');
          if (r) { await refresh(); render(); }
        };
      }
      $('#pw').onsubmit = async e => {
        e.preventDefault(); const b = formObj(e.target);
        if (String(b.password).length < 8) return toast('A nova senha precisa ter pelo menos 8 caracteres.', 'error');
        if (await busy(e.target.querySelector('button'), () => api('PUT', '/api/me/password', b), 'Senha alterada.')) e.target.reset();
      };
    }
  };
};

function openStaff(id) {
  const p = id ? S.staff.find(x => x.id === id) : { role: 'professor', active: 1 };
  const w = sheet(`${sheetHead(id ? 'Editar acesso' : 'Novo professor')}<form id="sf" class="form-grid" novalidate>
    <label class="field full"><span>Nome</span><input class="input" name="name" maxlength="80" value="${esc(p.name || '')}" autofocus required></label>
    ${id ? '' : '<label class="field full"><span>E-mail (login)</span><input class="input" type="email" name="email" required></label>'}
    <label class="field"><span>Função</span><select class="input" name="role"><option value="professor" ${p.role === 'professor' ? 'selected' : ''}>Professor</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Administrador</option></select></label>
    <label class="field"><span>Faixa</span><select class="input" name="belt"><option value="">–</option>${BELTS.map(b => `<option value="${b}" ${p.belt === b ? 'selected' : ''}>${cap(b)}</option>`).join('')}</select></label>
    <label class="field full"><span>${id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial (mín. 8)'}</span><input class="input" type="text" name="password" autocomplete="new-password"></label>
    ${id ? `<label class="field full row" style="gap:8px"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> <span style="margin:0">Pode acessar o sistema</span></label>` : ''}
    <div class="err full" id="sf-err"></div><button class="btn full">Salvar</button></form>`);
  $('#sf', w).onsubmit = async e => {
    e.preventDefault();
    const b = formObj(e.target); if (id) b.active = !!e.target.active.checked; if (!b.password) delete b.password;
    if (!id && String(b.password || '').length < 8) return $('#sf-err', w).textContent = 'Defina uma senha inicial com pelo menos 8 caracteres.';
    const r = await busy(e.target.querySelector('button'), () => id ? api('PUT', '/api/staff/' + id, b) : api('POST', '/api/staff', b), 'Acesso salvo.');
    if (!r) return; closeSheet(); await refresh(); render();
  };
}

// =====================================================================
// Ações
// =====================================================================
const ACT = {
  'close-sheet': () => closeSheet(),
  reload: () => location.reload(),
  'filter-ready': () => { S.ui.stuFilter = 'aptos'; },
  'filter-risk': () => { S.ui.stuFilter = 'risco'; },
  'stu-filter': el => { S.ui.stuFilter = el.dataset.id; render(); },
  'student-new': () => { const w = sheet(`${sheetHead('Novo aluno')}${studentForm(null)}`); w.querySelector('#stu-form').classList.remove('card'); bindStudentForm(null); },
  'student-delete': async el => {
    if (!(await confirmBox('Excluir aluno?', 'Apaga o cadastro, presenças, avaliações e graduações deste aluno. Para manter o histórico, marque como inativo.', 'Excluir'))) return;
    await busy(null, async () => { await api('DELETE', '/api/students/' + el.dataset.id); detail = null; await refresh(); location.hash = 'alunos'; }, 'Aluno excluído.');
  },
  'detail-tab': el => { S.ui.detailTab = el.dataset.id; render(); },
  'skill-filter': el => { S.ui.skillFilter = el.dataset.id; render(); },
  'skill-set': async el => {
    const tid = +el.dataset.tid, level = +el.dataset.l, sid = detail.student.id;
    const row = el.closest('.lvl'); $$('button', row).forEach(b => { b.classList.toggle('on', b === el); b.setAttribute('aria-checked', b === el); });
    try { detail = await api('PUT', `/api/students/${sid}/skills`, { technique_id: tid, level }); refresh().then(() => { if (route()[1] === sid) render(); }); }
    catch (e) { toast(e.message, 'error'); render(); }
  },
  promote: el => openPromote(el.dataset.kind),
  'promo-undo': async el => {
    if (!(await confirmBox('Desfazer graduação?', 'O aluno volta para a faixa e os graus anteriores, com as datas anteriores.', 'Desfazer'))) return;
    const d = await busy(null, () => api('DELETE', '/api/promotions/' + el.dataset.id), 'Graduação desfeita.');
    if (d) { detail = d; await refresh(); render(); }
  },
  'aulas-tab': el => { S.ui.aulasTab = el.dataset.id; render(); },
  'lesson-new': el => openLesson({ classId: el.dataset.class, date: el.dataset.date }),
  'lesson-open': el => openLesson({ id: el.dataset.id }),
  'lesson-close': () => { $('#overlay').innerHTML = ''; S.ui.lesson = null; },
  'lesson-save': el => saveLesson(el),
  'lesson-delete': async () => {
    const L = S.ui.lesson;
    if (!(await confirmBox('Excluir aula?', 'A presença e as técnicas desta aula serão apagadas. Avaliações de técnicas dos alunos continuam.', 'Excluir'))) return;
    await busy(null, async () => { await api('DELETE', '/api/lessons/' + L.id); $('#overlay').innerHTML = ''; S.ui.lesson = null; lessonsCache = null; detail = null; await refresh(); render(); }, 'Aula excluída.');
  },
  'att-toggle': el => {
    const L = S.ui.lesson, id = el.dataset.id;
    if (L.student_ids.has(id)) L.student_ids.delete(id); else L.student_ids.add(id);
    const on = L.student_ids.has(id); el.classList.toggle('on', on); el.setAttribute('aria-pressed', on);
    const n = L.student_ids.size; $('#ls-roll-row').style.display = n ? 'none' : ''; $('#att-count').textContent = `${n} presente${n === 1 ? '' : 's'}`;
    $('[data-act=lesson-save]').innerHTML = `${I('check', 16)} Salvar chamada (${n})`;
  },
  'tech-toggle': el => { const L = S.ui.lesson, id = +el.dataset.id; if (L.technique_ids.has(id)) L.technique_ids.delete(id); else L.technique_ids.add(id); renderLesson(); },
  'class-edit': el => openClass(el.dataset.id),
  'tech-cat': el => { S.ui.techCat = el.dataset.id; render(); },
  'tech-edit': el => openTech(el.dataset.id ? +el.dataset.id : null),
  'staff-edit': el => openStaff(el.dataset.id),
  logout: async () => {
    if (!(await confirmBox('Sair?', 'Você precisará da senha para entrar de novo.', 'Sair', false))) return;
    await api('POST', '/api/logout').catch(() => {}); S.loaded = false; detail = null; lessonsCache = null; history.replaceState(null, '', location.pathname); renderLogin();
  }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (el.tagName !== 'A') e.preventDefault();
  fn(el, e);
});
window.addEventListener('hashchange', () => {
  closeSheet();
  const [r, id] = route();
  if (r === 'aluno' && (!detail || detail.student.id !== id)) { S.ui.detailTab = 'graduacao'; detail = null; }
  if (r === 'aulas') lessonsCache = null;
  render(); window.scrollTo(0, 0);
});

// =====================================================================
// Início
// =====================================================================
async function start() {
  renderShell();
  $('#main').innerHTML = '<div class="skeleton" style="height:60px"></div><div class="skeleton" style="height:150px"></div><div class="skeleton"></div>';
  try { await refresh(); render(); }
  catch (e) { if (e.status !== 401) $('#main').innerHTML = `<div class="card empty" style="margin-top:40px"><b>Não foi possível carregar</b>${esc(e.message)}<div style="margin-top:14px"><button class="btn" data-act="reload">Tentar de novo</button></div></div>`; }
}
(async function init() {
  try {
    const st = await fetch('/api/status').then(r => r.json());
    S.academy = st.academy_name; S.setupCode = st.setup_code_required;
    if (st.setup_needed) return renderLogin('', true);
    const me = await fetch('/api/me', { credentials: 'same-origin' });
    if (me.status === 401) return renderLogin();
    await start();
  } catch { $('#root').innerHTML = '<div class="auth"><div class="auth-box card"><h2 style="margin-top:0">Sem conexão</h2><p class="muted">Não foi possível falar com o servidor. Verifique sua internet e recarregue.</p></div></div>'; }
})();
