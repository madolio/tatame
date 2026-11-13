/* TATAME — Agenda V1.
   Carregado depois de app.js e usa o mesmo escopo (S, api, sheet, openLesson...). Só exibe e envia ações: toda regra de acesso,
   conflito de horário e presença é do servidor (GET /api/agenda, POST/PUT/DELETE /api/lessons). */
'use strict';

// Cancelamento, feriado e reposição dependem da migração 004 (docs/agenda-migracao-004/). O servidor informa em
// capabilities.cancel se a tabela existe; sem ela nada disso aparece. Quem pode agir é decidido pelo servidor (a tela só esconde o que sabe que será negado).
const agCan = () => !!(AG.data && AG.data.capabilities && AG.data.capabilities.cancel);
const AG = { fprof: '', fmod: '', view: 'dia', date: null, data: null, key: '', loading: '', error: '', stale: false, items: new Map() };
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
  if (it.status === 'cancelled') return { k: 'cancelled', tag: it.cancel_kind === 'holiday' ? 'Feriado' : 'Cancelada', t: it.cancel_reason || '' };
  const done = it.kind === 'lesson' && (it.roll_called === 1 || it.attendees > 0);
  if (done) return { k: 'done', tag: 'Realizada', t: `${it.attendees} presente${it.attendees === 1 ? '' : 's'}` };
  if (it.date > S.today) return { k: 'sched', tag: 'Programada', t: '' };
  if (it.date < S.today) return { k: 'pending', tag: 'Sem chamada', t: 'não registrada' };
  const now = nowMin(), s = hm(it.start_time), e = hm(it.end_time);
  if (now < s) return { k: 'sched', tag: 'Programada', t: `começa em ${dur(s - now)}` };
  if (now < e) return { k: 'live', tag: 'Em andamento', t: `até ${it.end_time}` };
  return { k: 'pending', tag: 'Chamada pendente', t: `terminou às ${it.end_time}` };
}

function agNext(arr) {
  const live = arr.find(it => agState(it).k === 'live');
  if (live) return `<p class="ag-next"><b>Agora:</b> ${esc(live.name)} até ${live.end_time}</p>`;
  const nx = arr.filter(it => agState(it).k === 'sched').sort((a, b) => hm(a.start_time) - hm(b.start_time))[0];
  const late = arr.filter(it => agState(it).k === 'pending').length;
  const tail = late ? ` · ${late} sem chamada` : '';
  if (nx) return `<p class="ag-next"><b>Próxima:</b> ${esc(nx.name)} às ${nx.start_time} · em ${dur(hm(nx.start_time) - nowMin())}${tail}</p>`;
  return late ? `<p class="ag-next">${late} aula${late === 1 ? '' : 's'} de hoje sem chamada.</p>` : '';
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
  const profs = [...new Map(items.filter(it => it.instructor_id).map(it => [it.instructor_id, it.instructor_name])).entries()];
  const mods = [...new Set(items.map(it => it.modality))];
  if (AG.fprof && !profs.some(p => p[0] === AG.fprof)) AG.fprof = '';
  if (AG.fmod && !mods.includes(AG.fmod)) AG.fmod = '';
  const shown = items.filter(it => (!AG.fprof || it.instructor_id === AG.fprof) && (!AG.fmod || it.modality === AG.fmod));
  const byDay = d => shown.filter(it => it.date === d);
  const filters = profs.length > 1 || mods.length > 1 ? `<div class="ag-filters">
    ${profs.length > 1 ? `<select class="input" data-ag-filter="fprof" aria-label="Filtrar por professor"><option value="">Todos os professores</option>${profs.map(([id, n]) => `<option value="${esc(id)}" ${AG.fprof === id ? 'selected' : ''}>${esc(n || '—')}</option>`).join('')}</select>` : ''}
    ${mods.length > 1 ? `<select class="input" data-ag-filter="fmod" aria-label="Filtrar por modalidade"><option value="">Todas as modalidades</option>${mods.map(m => `<option value="${m}" ${AG.fmod === m ? 'selected' : ''}>${MOD[m]}</option>`).join('')}</select>` : ''}
    ${AG.fprof || AG.fmod ? '<button class="btn ghost sm" data-act="ag-clear-filter">Limpar filtros</button>' : ''}</div>` : '';
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
      ${AG.date === S.today ? agNext(arr) : ''}
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
    <div class="ag-strip" role="group" aria-label="Dias da semana">${strip}</div>${filters}${content}</div>`;
}

// ---------- Detalhe da aula ----------
function agOpen(key) {
  const it = AG.items.get(key); if (!it) return;
  const st = agState(it), len = hm(it.end_time) - hm(it.start_time), lesson = it.kind === 'lesson';
  const own = lesson && canUndo(it.created_by, it.created_at);
  const reg = !lesson || !it.attendees ? (AG.data.regulars[it.class_id] || []).map(stuById).filter(Boolean) : [];
  const done = lesson && (it.roll_called === 1 || it.attendees > 0);
  const acts = [];
  if (it.status === 'cancelled') acts.push(`<p class="muted small" style="margin:0">${esc(it.cancel_reason || 'Esta aula não acontece neste dia.')}</p>`);
  else if (it.date <= S.today) acts.push(lesson ? `<button class="btn" data-act="ag-roll" data-id="${it.id}">${I('check', 15)} ${done ? (own ? 'Corrigir chamada' : 'Ver chamada') : 'Fazer chamada'}</button>`
    : `<button class="btn" data-act="ag-roll" data-class="${it.class_id}" data-d="${it.date}">${I('check', 15)} Fazer chamada</button>`);
  else acts.push(`<p class="muted small" style="margin:0">A chamada abre no dia da aula.</p>`);
  if (lesson) acts.push(`<button class="btn ghost" data-act="ag-dup" data-id="${it.id}">${I('plus', 15)} Duplicar para outra data</button>`);
  // Aula gravada: o autor (ou admin). Turma da grade e feriado: só admin. O servidor confere de novo.
  const mayAct = it.kind === 'planned' ? isAdmin() : own;
  const holiday = it.status === 'cancelled' && it.cancel_kind === 'holiday';
  if (agCan() && it.status !== 'cancelled' && !done && mayAct) acts.push(`<button class="btn danger" data-act="ag-cancel" data-key="${esc(key)}">${I('x', 15)} Cancelar esta aula</button>`);
  if (agCan() && it.status !== 'cancelled' && isAdmin()) acts.push(`<button class="btn ghost" data-act="ag-holiday" data-d="${it.date}">${I('calendar', 15)} Marcar feriado neste dia</button>`);
  if (agCan() && it.status === 'cancelled' && (holiday ? isAdmin() : mayAct)) {
    acts.push(`<button class="btn" data-act="ag-restore" data-id="${it.exception_id}">${I('check', 15)} ${holiday ? 'Desfazer feriado' : 'Restaurar aula'}</button>`);
    if (!holiday && !it.makeup_lesson_id && it.date >= agAdd(S.today, -60)) acts.push(`<button class="btn ghost" data-act="ag-makeup" data-key="${esc(key)}">${I('plus', 15)} Marcar reposição</button>`);
  }
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
      ${it.makeup_lesson_id ? `<p class="muted small" style="margin:12px 0 0">Reposição já marcada.</p>` : ''}${it.makeup_of_date ? `<p class="muted small" style="margin:12px 0 0">Reposição da aula de ${ld(it.makeup_of_date)}.</p>` : ''}
      ${it.conflict ? `<p class="ag-warn big">${I('alert', 15)} Este professor tem outra aula que se sobrepõe a esta no mesmo dia.</p>` : ''}
      ${reg.length ? `<div class="ag-reg"><span class="muted xs">Costumam vir (${reg.length})</span><div>${reg.slice(0, 8).map(s => `<span class="ag-chip">${esc(s.name.split(' ')[0])}</span>`).join('')}${reg.length > 8 ? `<span class="ag-chip more">+${reg.length - 8}</span>` : ''}</div></div>` : ''}
      ${!lesson && it.date > S.today ? '<p class="muted xs" style="margin:10px 0 0">Esta aula vem da grade semanal e se repete toda semana.</p>' : ''}
      <div class="ag-acts">${acts.join('')}</div>
    </div>`);
  return w;
}

// ---------- Formulário de aula (programar / editar) ----------
async function agForm({ id, date, classId, dup } = {}) {
  let L = null, D = null;                                                    // L: aula em edição; D: aula usada de modelo ao duplicar (sem presença)
  if (id) { L = await busy(null, () => api('GET', '/api/lessons/' + id)); if (!L) return; }
  if (dup) { D = await busy(null, () => api('GET', '/api/lessons/' + dup)); if (!D) return; }
  const c0 = classId ? clsById(classId) : null;
  const v = D ? { class_id: D.class_id, title: D.title || '', date: agAdd(D.date > S.today ? D.date : S.today, 7), start: D.start_time, len: hm(D.end_time) - hm(D.start_time), instr: D.instructor_id || '', mod: D.modality }
    : L ? { class_id: L.class_id, title: L.title || '', date: L.date, start: L.start_time, len: hm(L.end_time) - hm(L.start_time), instr: L.instructor_id || '', mod: L.modality }
    : { class_id: c0 ? c0.id : '', title: '', date: date || AG.date || S.today, start: c0 ? c0.start_time : '19:00', len: c0 ? hm(c0.end_time) - hm(c0.start_time) : 60, instr: c0 ? c0.instructor_id || '' : '', mod: c0 ? c0.modality : 'gi' };
  const lens = [...new Set([30, 45, 60, 75, 90, 120, v.len])].filter(n => n > 0).sort((a, b) => a - b);
  const w = sheet(`${sheetHead(id ? 'Editar aula' : D ? 'Duplicar aula' : 'Nova aula')}<form id="ag-form" class="form-grid" novalidate>
    ${id || D ? '' : `<label class="field full"><span>Turma (opcional)</span><select class="input" name="class_id"><option value="">Aula avulsa ou especial</option>${S.classes.filter(c => c.active).map(c => `<option value="${c.id}" ${c.id === v.class_id ? 'selected' : ''}>${WDS[c.weekday]} ${c.start_time} · ${esc(c.name)}</option>`).join('')}</select></label>`}
    <label class="field full"><span>Nome ou tema</span><input class="input" name="title" maxlength="120" value="${esc(v.title)}" placeholder="Ex.: Aulão de passagem, Seminário, Treino aberto" autofocus></label>
    <label class="field"><span>Data</span><input class="input" type="date" name="date" value="${v.date}" required></label>
    <label class="field"><span>Início</span><input class="input" type="time" name="start" value="${v.start}" required></label>
    <label class="field"><span>Duração</span><select class="input" name="len">${lens.map(n => `<option value="${n}" ${n === v.len ? 'selected' : ''}>${dur(n)}</option>`).join('')}</select></label>
    <label class="field"><span>Modalidade</span><select class="input" name="mod">${Object.entries(MOD).map(([k, l]) => `<option value="${k}" ${v.mod === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="field full"><span>Professor responsável</span><select class="input" name="instr"><option value="">Quem registrar</option>${S.staff.filter(s => s.active).map(s => `<option value="${s.id}" ${v.instr === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <p class="ag-warn full" id="ag-pre" role="status" hidden></p>
    <div class="err full" id="ag-err" role="alert"></div>
    <button class="btn full">${id ? 'Salvar alterações' : 'Programar aula'}</button></form>`);
  const f = $('#ag-form', w);
  // Aviso antecipado (o servidor continua decidindo): consulta o dia escolhido e compara professor e horário.
  let preSeq = 0;
  const pre = async () => {
    const seq = ++preSeq, box = $('#ag-pre', w), start = hm(f.start.value), end = start + +f.len.value;
    box.hidden = true;
    if (!f.date.value || !f.start.value || !f.instr.value) return;
    let r; try { r = await api('GET', `/api/agenda?from=${f.date.value}&to=${f.date.value}`); } catch { return; }
    if (seq !== preSeq) return;
    const hit = r.items.find(it => it.id !== id && it.instructor_id === f.instr.value && hm(it.start_time) < end && hm(it.end_time) > start);
    if (hit) { box.innerHTML = `${I('alert', 14)} Este professor já tem ${esc(hit.name)} das ${hit.start_time} às ${hit.end_time}.`; box.hidden = false; }
  };
  ['date', 'start', 'len', 'instr'].forEach(n => f[n].addEventListener('change', pre)); pre();
  if (!id && !D) f.class_id.onchange = () => {
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
    const b = { class_id: id ? L.class_id : D ? D.class_id : x.class_id || null, date: x.date, start_time: x.start, end_time: agClock(end), modality: x.mod, title: x.title, instructor_id: x.instr || null,
      student_ids: L ? L.student_ids : [], technique_ids: L ? L.technique_ids : [], ...(L ? { notes: L.notes, roll_called: L.roll_called === 1 ? true : L.roll_called === 0 ? false : null } : {}) };
    err.textContent = '';
    try {
      await api(id ? 'PUT' : 'POST', id ? '/api/lessons/' + id : '/api/lessons', b);
      toast(id ? 'Aula atualizada.' : D ? 'Aula duplicada.' : 'Aula programada.', 'success'); closeSheet(); await agReload(x.date);
    } catch (er) { if (er.status !== 401) err.textContent = er.message; }   // 409 de conflito e 403 de permissão vêm do servidor, com o motivo
  };
}

// ---------- Cancelar aula / marcar feriado / reposição ----------
function agCancelForm(it, kind) {
  const holiday = kind === 'holiday';
  const w = sheet(`${sheetHead(holiday ? 'Marcar feriado' : 'Cancelar aula')}<form id="ag-cancel-form" class="form-grid" novalidate>
    <p class="full muted small" style="margin:0">${holiday ? `Todas as aulas de ${cap(WD[pd(it.date).getDay()])}, ${ld(it.date)} ficam canceladas.` : `${esc(it.name)} · ${cap(WD[pd(it.date).getDay()])}, ${ld(it.date)} às ${it.start_time}.`}
      Nada é apagado: a presença já registrada é preservada e você pode restaurar depois.</p>
    <label class="field full"><span>Motivo</span><input class="input" name="reason" maxlength="200" required placeholder="${holiday ? 'Ex.: Feriado nacional' : 'Ex.: Professor em campeonato'}" autofocus></label>
    <div class="err full" id="ag-cerr" role="alert"></div>
    <button class="btn danger full">${holiday ? 'Marcar feriado' : 'Cancelar aula'}</button></form>`);
  const f = $('#ag-cancel-form', w);
  f.onsubmit = async e => {
    e.preventDefault();
    const reason = f.reason.value.trim(), err = $('#ag-cerr', w);
    if (reason.length < 3) return err.textContent = 'Explique o motivo em poucas palavras.';
    const b = holiday ? { kind: 'holiday', date: it.date, reason } : { kind: 'cancel', reason, ...(it.kind === 'lesson' ? { lesson_id: it.id } : { class_id: it.class_id, date: it.date }) };
    try { await api('POST', '/api/agenda/exceptions', b); toast(holiday ? 'Feriado marcado.' : 'Aula cancelada.', 'success'); closeSheet(); await agReload(it.date); }
    catch (er) { if (er.status !== 401) err.textContent = er.message; }
  };
}
function agMakeupForm(it) {
  const len = hm(it.end_time) - hm(it.start_time), lens = [...new Set([30, 45, 60, 75, 90, 120, len])].filter(n => n > 0).sort((a, b) => a - b);
  const w = sheet(`${sheetHead('Marcar reposição')}<form id="ag-makeup-form" class="form-grid" novalidate>
    <p class="full muted small" style="margin:0">Repõe ${esc(it.name)} do dia ${ld(it.date)}. A reposição é uma aula nova, sem chamada, ligada ao cancelamento.</p>
    <label class="field"><span>Data</span><input class="input" type="date" name="date" value="${agAdd(S.today > it.date ? S.today : it.date, 1)}" required></label>
    <label class="field"><span>Início</span><input class="input" type="time" name="start" value="${it.start_time}" required></label>
    <label class="field full"><span>Duração</span><select class="input" name="len">${lens.map(n => `<option value="${n}" ${n === len ? 'selected' : ''}>${dur(n)}</option>`).join('')}</select></label>
    <div class="err full" id="ag-merr" role="alert"></div>
    <button class="btn full">Marcar reposição</button></form>`);
  const f = $('#ag-makeup-form', w);
  f.onsubmit = async e => {
    e.preventDefault();
    const err = $('#ag-merr', w), end = hm(f.start.value) + +f.len.value;
    if (!f.date.value || !f.start.value) return err.textContent = 'Informe a data e o horário.';
    if (end > 23 * 60 + 59) return err.textContent = 'A aula precisa terminar até 23:59.';
    try { await api('POST', `/api/agenda/exceptions/${it.exception_id}/makeup`, { date: f.date.value, start_time: f.start.value, end_time: agClock(end) }); toast('Reposição marcada.', 'success'); closeSheet(); await agReload(f.date.value); }
    catch (er) { if (er.status !== 401) err.textContent = er.message; }
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
  'ag-cancel': el => { const it = AG.items.get(el.dataset.key); if (it) { closeSheet(); agCancelForm(it, 'cancel'); } },
  'ag-holiday': el => { const it = { date: el.dataset.d, name: 'Todas as aulas do dia' }; closeSheet(); agCancelForm(it, 'holiday'); },
  'ag-makeup': el => { const it = AG.items.get(el.dataset.key); if (it) { closeSheet(); agMakeupForm(it); } },
  'ag-restore': async el => {
    if (!(await confirmBox('Restaurar a aula?', 'A aula volta para a agenda. O cancelamento fica no histórico.', 'Restaurar', false))) return;
    await busy(null, async () => { await api('POST', `/api/agenda/exceptions/${el.dataset.id}/restore`); await agReload(); }, 'Aula restaurada.');
  },
  'ag-dup': el => { closeSheet(); agForm({ dup: el.dataset.id }); },
  'ag-clear-filter': () => { AG.fprof = AG.fmod = ''; render(); },
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

// Filtros (selects não passam por data-act) e atalhos: ← → mudam de dia (semana na vista semanal), T volta para hoje.
document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.agFilter; if (!k) return;
  AG[k] = e.target.value; render();
  const again = document.querySelector(`[data-ag-filter=${k}]`); if (again) again.focus();
});
document.addEventListener('keydown', e => {
  if (!S.loaded || route()[0] !== 'aulas' || S.ui.aulasTab !== 'agenda' || $('#sheet') || $('#lesson-screen') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const step = AG.view === 'dia' ? 1 : 7;
  if (e.key === 'ArrowLeft') { AG.date = agAdd(AG.date || S.today, -step); render(); }
  else if (e.key === 'ArrowRight') { AG.date = agAdd(AG.date || S.today, step); render(); }
  else if (e.key === 't' || e.key === 'T') { AG.date = S.today; render(); }
});
