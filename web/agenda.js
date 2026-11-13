/* TATAME — Agenda V1.
   Carregado depois de app.js e usa o mesmo escopo (S, api, sheet, openLesson...). Só exibe e envia ações: toda regra de acesso,
   conflito de horário e presença é do servidor (GET /api/agenda, POST/PUT/DELETE /api/lessons). */
'use strict';

const AG = { view: 'dia', date: null, data: null, key: '', loading: '', error: '', stale: false, items: new Map() };
const agPad = n => String(n).padStart(2, '0');
const agAdd = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${agPad(d.getMonth() + 1)}-${agPad(d.getDate())}`; };
const agWeekStart = s => agAdd(s, -((pd(s).getDay() + 6) % 7));            // segunda-feira
const agClock = m => `${agPad(Math.floor(m / 60))}:${agPad(m % 60)}`;
const agKey = it => it.id || `${it.class_id}|${it.date}`;
const agIsPast = it => it.date < S.today;

// Carrega a semana da data em foco (sempre 7 dias: a faixa de dias e a vista de semana usam os mesmos dados).
async function agLoad(force) {
  if (!AG.date) AG.date = S.today;
  const from = agWeekStart(AG.date), to = agAdd(from, 6);
  if (!force && AG.key === from && (AG.data || AG.loading === from || AG.error)) return;
  if (AG.key !== from) AG.data = null;                                      // mesma semana: mantém a tela enquanto atualiza
  AG.key = from; AG.loading = from; AG.error = ''; AG.stale = false;
  let data = null, error = '';
  try { data = await api('GET', `/api/agenda?from=${from}&to=${to}`); } catch (e) { if (e.status === 401) return; error = e.message; }
  if (AG.key !== from) return;                                              // a pessoa já foi para outra semana
  AG.loading = ''; AG.data = data; AG.error = error;
  AG.items = new Map((data ? data.items : []).map(it => [agKey(it), it]));
  if (route()[0] === 'aulas' && S.ui.aulasTab === 'agenda') render();
}
async function agReload(focusDate) {
  if (focusDate) AG.date = focusDate;
  lessonsCache = null; detail = null;
  await refresh(); await agLoad(true); render();
}

// Estado visual da aula: programada, em andamento, chamada pendente ou realizada (cancelada depende de uma migração, ver docs/agenda.md).
function agState(it) {
  const done = it.kind === 'lesson' && (it.roll_called === 1 || it.attendees > 0);
  if (done) return { k: 'done', tag: 'Realizada', t: `${it.attendees} presente${it.attendees === 1 ? '' : 's'}` };
  if (it.date > S.today) return { k: 'sched', tag: 'Programada', t: '' };
  if (it.date < S.today) return { k: 'pending', tag: 'Sem chamada', t: 'não registrada' };
  const now = nowMin(), s = hm(it.start_time), e = hm(it.end_time);
  if (now < s) return { k: 'sched', tag: 'Programada', t: `começa em ${dur(s - now)}` };
  if (now < e) return { k: 'live', tag: 'Em andamento', t: `até ${it.end_time}` };
  return { k: 'pending', tag: 'Chamada pendente', t: `terminou às ${it.end_time}` };
}

function agCard(it) {
  const st = agState(it), len = hm(it.end_time) - hm(it.start_time);
  const meta = [MOD[it.modality], it.instructor_name && esc(it.instructor_name), dur(len)].filter(Boolean).join(' · ');
  const sub = it.kind === 'lesson' && it.title && it.class_id ? `<span class="ag-sub">${esc(it.title)}</span>` : '';
  return `<button class="ag-item" data-k="${st.k}" data-act="ag-open" data-key="${esc(agKey(it))}" aria-label="${esc(`${it.start_time}, ${it.name}, ${st.tag}`)}">
    <span class="ag-time"><b>${it.start_time}</b><span>${it.end_time}</span></span>
    <span class="ag-main"><b class="ag-name">${esc(it.name)}</b>${sub}<span class="ag-meta">${meta}</span>
      ${it.conflict ? `<span class="ag-warn">${I('alert', 13)} Professor com aula sobreposta</span>` : ''}</span>
    <span class="ag-state"><span class="ag-pill"><i></i>${st.tag}</span>${st.t ? `<em>${st.t}</em>` : ''}</span></button>`;
}

function agendaBody() {
  if (!AG.date) AG.date = S.today;
  agLoad(AG.stale);
  const from = agWeekStart(AG.date), days = [...Array(7)].map((_, i) => agAdd(from, i));
  const items = AG.data ? AG.data.items : [];
  const byDay = d => items.filter(it => it.date === d);
  const a = pd(days[0]), b = pd(days[6]);
  const range = a.getMonth() === b.getMonth() ? `${a.getDate()} a ${b.getDate()} ${MONTHS[b.getMonth()]}` : `${a.getDate()} ${MONTHS[a.getMonth()]} a ${b.getDate()} ${MONTHS[b.getMonth()]}`;
  const strip = days.map(d => {
    const n = byDay(d).length, sel = d === AG.date && AG.view === 'dia';
    return `<button class="ag-day${sel ? ' on' : ''}${d === S.today ? ' is-today' : ''}" data-act="ag-day" data-d="${d}" aria-pressed="${sel}" ${d === S.today ? 'aria-current="date"' : ''}
      aria-label="${esc(`${WD[pd(d).getDay()]}, ${ld(d)}, ${n} aula${n === 1 ? '' : 's'}`)}"><span>${WDS[pd(d).getDay()]}</span><b>${pd(d).getDate()}</b><i>${n ? n : ''}</i></button>`;
  }).join('');
  const empty = d => `<div class="ag-empty"><b>${d === S.today ? 'Nenhuma aula hoje' : 'Nenhuma aula neste dia'}</b><span>Os horários fixos aparecem sozinhos. Para uma aula extra, aulão ou seminário, programe uma aula.</span>
    <button class="btn ghost sm" data-act="ag-new" data-d="${d}">${I('plus', 14)} Nova aula</button></div>`;
  let content;
  if (AG.error) content = `<div class="ag-empty"><b>Não foi possível carregar a agenda</b><span>${esc(AG.error)}</span><button class="btn ghost sm" data-act="ag-retry">Tentar de novo</button></div>`;
  else if (!AG.data) content = '<div class="ag-skel"><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px"></div></div>';
  else if (AG.view === 'dia') {
    const arr = byDay(AG.date);
    content = `<div class="ag-dayhead"><h2>${cap(WD[pd(AG.date).getDay()])}, ${ld(AG.date)}</h2>${AG.date === S.today ? '<span class="ag-today">Hoje</span>' : ''}</div>
      ${arr.length ? `<div class="ag-list">${arr.map(agCard).join('')}</div>` : empty(AG.date)}`;
  } else {
    content = `<div class="ag-week">${days.map(d => { const arr = byDay(d);
      return `<section class="ag-col${d === S.today ? ' is-today' : ''}${arr.length ? '' : ' none'}"><h3><span>${WDS[pd(d).getDay()]}</span><b>${pd(d).getDate()}</b>${d === S.today ? '<em>hoje</em>' : ''}</h3>
        <div class="ag-list">${arr.map(agCard).join('') || '<span class="ag-none">Sem aula</span>'}</div></section>`; }).join('')}</div>`;
  }
  return `<div class="ag">
    <div class="ag-bar"><div class="ag-nav"><button class="icon-btn" data-act="ag-nav" data-n="-1" aria-label="Semana anterior">${I('left', 18)}</button>
      <div class="ag-range" aria-live="polite"><b>${range}</b><span>${a.getFullYear() === b.getFullYear() ? b.getFullYear() : `${a.getFullYear()}/${b.getFullYear()}`}</span></div>
      <button class="icon-btn" data-act="ag-nav" data-n="1" aria-label="Próxima semana">${I('right', 18)}</button>
      <button class="btn ghost sm" data-act="ag-today">Hoje</button></div>
      <div class="ag-seg" role="group" aria-label="Visualização"><button data-act="ag-view" data-v="dia" aria-pressed="${AG.view === 'dia'}">Dia</button><button data-act="ag-view" data-v="semana" aria-pressed="${AG.view === 'semana'}">Semana</button></div></div>
    <div class="ag-strip" role="group" aria-label="Dias da semana">${strip}</div>${content}</div>`;
}

// ---------- Detalhe da aula ----------
function agOpen(key) {
  const it = AG.items.get(key); if (!it) return;
  const st = agState(it), len = hm(it.end_time) - hm(it.start_time), lesson = it.kind === 'lesson';
  const own = lesson && canUndo(it.created_by, it.created_at);
  const reg = !lesson || !it.attendees ? (AG.data.regulars[it.class_id] || []).map(stuById).filter(Boolean) : [];
  const done = lesson && (it.roll_called === 1 || it.attendees > 0);
  const acts = [];
  if (it.date <= S.today) acts.push(lesson ? `<button class="btn" data-act="ag-roll" data-id="${it.id}">${I('check', 15)} ${done ? (own ? 'Corrigir chamada' : 'Ver chamada') : 'Fazer chamada'}</button>`
    : `<button class="btn" data-act="ag-roll" data-class="${it.class_id}" data-d="${it.date}">${I('check', 15)} Fazer chamada</button>`);
  else acts.push(`<p class="muted small" style="margin:0">A chamada abre no dia da aula.</p>`);
  if (own) acts.push(`<button class="btn ghost" data-act="ag-edit" data-id="${it.id}">${I('edit', 15)} Editar dados</button>`);
  if (own && !done) acts.push(`<button class="btn danger" data-act="ag-remove" data-id="${it.id}">${I('trash', 15)} Remover da agenda</button>`);
  if (!lesson) acts.push(`<button class="btn ghost" data-act="ag-class" data-id="${it.class_id}">${I('clock', 15)} Editar horário fixo</button>`);
  const w = sheet(`${sheetHead(esc(it.name))}
    <div class="ag-detail" data-k="${st.k}">
      <div class="ag-d-row"><span class="ag-pill"><i></i>${st.tag}</span><span class="muted small">${st.t}</span></div>
      <dl class="ag-d-list">
        <div><dt>Quando</dt><dd>${cap(WD[pd(it.date).getDay()])}, ${ld(it.date)}<br><b class="num">${it.start_time}–${it.end_time}</b> <span class="muted">(${dur(len)})</span></dd></div>
        <div><dt>Professor</dt><dd>${it.instructor_name ? esc(it.instructor_name) : '<span class="muted">Não definido</span>'}</dd></div>
        <div><dt>Tipo</dt><dd>${MOD[it.modality]}${it.level || it.class_level ? ` · ${LEVEL[it.level || it.class_level]}` : ''}${lesson && it.title ? `<br><span class="muted">${esc(it.title)}</span>` : ''}</dd></div>
        ${lesson ? `<div><dt>Presença</dt><dd><b class="num">${it.attendees}</b> aluno${it.attendees === 1 ? '' : 's'}${it.roll_called === 0 && !it.attendees ? ' <span class="muted">· sem chamada</span>' : ''}</dd></div>` : ''}
      </dl>
      ${it.conflict ? `<p class="ag-warn big">${I('alert', 15)} Este professor tem outra aula que se sobrepõe a esta no mesmo dia.</p>` : ''}
      ${reg.length ? `<div class="ag-reg"><span class="muted xs">Costumam vir (${reg.length})</span><div>${reg.slice(0, 8).map(s => `<span class="ag-chip">${esc(s.name.split(' ')[0])}</span>`).join('')}${reg.length > 8 ? `<span class="ag-chip more">+${reg.length - 8}</span>` : ''}</div></div>` : ''}
      ${!lesson && it.date > S.today ? '<p class="muted xs" style="margin:10px 0 0">Esta aula vem da grade semanal e se repete toda semana.</p>' : ''}
      <div class="ag-acts">${acts.join('')}</div>
    </div>`);
  return w;
}

// ---------- Formulário de aula (programar / editar) ----------
async function agForm({ id, date, classId } = {}) {
  let L = null;
  if (id) { L = await busy(null, () => api('GET', '/api/lessons/' + id)); if (!L) return; }
  const c0 = classId ? clsById(classId) : null;
  const v = L ? { class_id: L.class_id, title: L.title || '', date: L.date, start: L.start_time, len: hm(L.end_time) - hm(L.start_time), instr: L.instructor_id || '', mod: L.modality }
    : { class_id: c0 ? c0.id : '', title: '', date: date || AG.date || S.today, start: c0 ? c0.start_time : '19:00', len: c0 ? hm(c0.end_time) - hm(c0.start_time) : 60, instr: c0 ? c0.instructor_id || '' : '', mod: c0 ? c0.modality : 'gi' };
  const lens = [...new Set([30, 45, 60, 75, 90, 120, v.len])].filter(n => n > 0).sort((a, b) => a - b);
  const w = sheet(`${sheetHead(id ? 'Editar aula' : 'Nova aula')}<form id="ag-form" class="form-grid" novalidate>
    ${id ? '' : `<label class="field full"><span>Turma (opcional)</span><select class="input" name="class_id"><option value="">Aula avulsa ou especial</option>${S.classes.filter(c => c.active).map(c => `<option value="${c.id}" ${c.id === v.class_id ? 'selected' : ''}>${WDS[c.weekday]} ${c.start_time} · ${esc(c.name)}</option>`).join('')}</select></label>`}
    <label class="field full"><span>Nome ou tema</span><input class="input" name="title" maxlength="120" value="${esc(v.title)}" placeholder="Ex.: Aulão de passagem, Seminário, Treino aberto" autofocus></label>
    <label class="field"><span>Data</span><input class="input" type="date" name="date" value="${v.date}" required></label>
    <label class="field"><span>Início</span><input class="input" type="time" name="start" value="${v.start}" required></label>
    <label class="field"><span>Duração</span><select class="input" name="len">${lens.map(n => `<option value="${n}" ${n === v.len ? 'selected' : ''}>${dur(n)}</option>`).join('')}</select></label>
    <label class="field"><span>Modalidade</span><select class="input" name="mod">${Object.entries(MOD).map(([k, l]) => `<option value="${k}" ${v.mod === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field full"><span>Professor responsável</span><select class="input" name="instr"><option value="">Quem registrar</option>${S.staff.filter(s => s.active).map(s => `<option value="${s.id}" ${v.instr === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="err full" id="ag-err" role="alert"></div>
    <button class="btn full">${id ? 'Salvar alterações' : 'Programar aula'}</button></form>`);
  const f = $('#ag-form', w);
  if (!id) f.class_id.onchange = () => {
    const c = clsById(f.class_id.value); if (!c) return;
    f.start.value = c.start_time; f.mod.value = c.modality; f.instr.value = c.instructor_id || '';
    const n = hm(c.end_time) - hm(c.start_time); if (![...f.len.options].some(o => +o.value === n)) f.len.add(new Option(dur(n), n)); f.len.value = n;
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const x = formObj(f), err = $('#ag-err', w), end = hm(x.start) + +x.len;
    if (!x.date) return err.textContent = 'Informe a data.';
    if (!x.start) return err.textContent = 'Informe o horário de início.';
    if (end > 23 * 60 + 59) return err.textContent = 'A aula precisa terminar até 23:59.';
    const b = { class_id: id ? L.class_id : x.class_id || null, date: x.date, start_time: x.start, end_time: agClock(end), modality: x.mod, title: x.title, instructor_id: x.instr || null,
      student_ids: L ? L.student_ids : [], technique_ids: L ? L.technique_ids : [], ...(L ? { notes: L.notes, roll_called: L.roll_called === 1 ? true : L.roll_called === 0 ? false : null } : {}) };
    err.textContent = '';
    try {
      await api(id ? 'PUT' : 'POST', id ? '/api/lessons/' + id : '/api/lessons', b);
      toast(id ? 'Aula atualizada.' : 'Aula programada.', 'success'); closeSheet(); await agReload(x.date);
    } catch (er) { if (er.status !== 401) err.textContent = er.message; }   // 409 de conflito e 403 de permissão vêm do servidor, com o motivo
  };
}

Object.assign(ACT, {
  'ag-day': el => { AG.view = 'dia'; AG.date = el.dataset.d; render(); },
  'ag-nav': el => { AG.date = agAdd(AG.date || S.today, 7 * +el.dataset.n); render(); },
  'ag-today': () => { AG.date = S.today; render(); },
  'ag-view': el => { AG.view = el.dataset.v; render(); },
  'ag-retry': () => { agLoad(true).then(() => {}); render(); },
  'ag-open': el => { agOpen(el.dataset.key); },
  'ag-new': el => { closeSheet(); agForm({ date: el.dataset.d }); },
  'ag-edit': el => { closeSheet(); agForm({ id: el.dataset.id }); },
  'ag-class': el => { closeSheet(); openClass(el.dataset.id); },
  'ag-roll': el => { closeSheet(); openLesson(el.dataset.id ? { id: el.dataset.id } : { classId: el.dataset.class, date: el.dataset.d }); },
  'ag-remove': async el => {
    if (!(await confirmBox('Remover da agenda?', 'A aula programada sai da agenda. A remoção fica registrada na auditoria. Aulas com chamada não podem ser removidas por aqui.', 'Remover'))) return;
    await busy(null, async () => { await api('DELETE', '/api/lessons/' + el.dataset.id); await agReload(); }, 'Aula removida.');
  }
});
// Os estados "em andamento" e "chamada pendente" dependem da hora: atualiza a tela a cada minuto quando a agenda está aberta e livre.
setInterval(() => { if (S.loaded && route()[0] === 'aulas' && S.ui.aulasTab === 'agenda' && !$('#sheet') && !$('#lesson-screen') && AG.data) render(); }, 60000);
// Toda gravação do app termina em refresh(): a agenda carregada fica velha e é recarregada na próxima tela.
const agRefresh = refresh;
refresh = function () { AG.stale = true; return agRefresh.apply(this, arguments); };
