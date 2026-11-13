// staging-check (Etapa 6.5-A): cenários de integridade administrativa (B), auditoria (C) e exclusão de alunos (D) por
// HTTP contra o app de STAGING, conferindo o banco por consultas de leitura pelo portão do wrapper.
//
//   node tools/staging-check.mjs --env staging --confirm-destination=tatame-staging
//
// Travas (todas antes de qualquer requisição):
//   - só --env staging (dest), com --confirm-destination; identidade do banco conferida na Cloudflare ANTES do HTTP;
//   - a URL vem só de db/environments.json (staging.app_url), nunca de argumento: https, não PENDENTE, host diferente do
//     app de produção (production.app_url) e de qualquer outro ambiente; sem redirecionamento (redirect: manual);
//   - credenciais do administrador de staging só por variável de ambiente (TATAME_CHECK_EMAIL, TATAME_CHECK_PASSWORD),
//     nunca impressas nem registradas; as contas e senhas criadas pela verificação são aleatórias e ficam só na memória.
// O cenário B rebaixa TEMPORARIAMENTE a conta de verificação (para dois administradores de teste ficarem sozinhos e se
// rebaixarem ao mesmo tempo) e a promove de volta no fim; ao terminar, as contas de teste são desativadas.
// Os resultados vão para a tela e para o registro de evidências (identificador do cenário e ok/falhou, sem dados).
import { randomBytes } from 'node:crypto';
import { registerOp, GuardError } from './cli.mjs';
import { openSource } from './source.mjs';

const refuse = m => { throw new GuardError(m); };
const UUIDRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lit = v => { const s = String(v); if (!UUIDRE.test(s) && !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error('valor inesperado em consulta'); return `'${s}'`; };
const HIST = ['attendance', 'promotions', 'skills', 'skill_history'];
const STUDENT_PUT_FIELDS = ['name', 'nickname', 'birth_date', 'sex', 'phone', 'email', 'start_date', 'prior_months', 'weight_kg', 'goals', 'notes'];
const PENDING = v => !v || /PENDENTE/i.test(String(v));

// URL do app: só a configurada, https e longe da produção. Devolve a origem.
export function stagingOrigin(envs, name = 'staging') {
  const raw = envs[name]?.app_url;
  if (PENDING(raw)) refuse(`app_url de ${name} não configurado em db/environments.json. Preencha com a URL do projeto Pages de staging (exige autorização própria).`);
  let u; try { u = new URL(String(raw)); } catch { refuse(`app_url de ${name} inválido.`); }
  if (u.protocol !== 'https:') refuse(`app_url de ${name} precisa ser https.`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) refuse(`app_url de ${name} deve ser só a origem (https://host).`);
  for (const [k, e] of Object.entries(envs)) {
    if (k === name || k.startsWith('_') || PENDING(e?.app_url)) continue;
    let h; try { h = new URL(String(e.app_url)).hostname.toLowerCase(); } catch { continue; }
    if (h === u.hostname.toLowerCase()) refuse(`app_url de ${name} é o mesmo host de ${k}${k === 'production' ? ' (PRODUÇÃO)' : ''}. Nada foi executado.`);
  }
  if (PENDING(envs.production?.app_url)) refuse('production.app_url não está em db/environments.json: sem ele não há como provar que a URL não é a da produção.');
  return u.origin;
}

function httpClient(origin, fetchFn) {
  return async (method, path, body, cookie = '') => {
    const r = await fetchFn(origin + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-tatame': '1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* CSV ou vazio */ }
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : String(r.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/);
    return { status: r.status, body: json, text, session: (set.find(c => /^\s*tatame_sid=/.test(c)) || '').split(';')[0].trim() };
  };
}

export async function runScenarios({ call, q, out = () => {}, email, password, rand = n => randomBytes(n).toString('hex') }) {
  const results = [];
  const check = (id, ok, desc) => { results.push({ id, ok: !!ok }); out(`  ${ok ? 'ok    ' : 'FALHOU'} ${id} ${desc}`); return !!ok; };
  const one = sql => q(sql)[0] || {};
  const n = sql => Number(Object.values(one(sql))[0] ?? NaN);
  const tag = 'SC' + rand(4).toUpperCase(), MARK = 'MARCA' + rand(6).toUpperCase();
  const pw = () => 'verif-' + rand(10) + '-x';
  const login = async (e, p) => (await call('POST', '/api/login', { email: e, password: p })).session;

  const A = await login(email, password);
  const me = A ? (await call('GET', '/api/me', undefined, A)).body?.me : null;
  if (!me || me.role !== 'admin') refuse('A conta de verificação (TATAME_CHECK_EMAIL) não entrou ou não é administradora ativa no staging. Nada foi alterado.');
  const AID = me.id;
  const mark = n('SELECT coalesce(max(id), 0) AS m FROM audit_log');
  const evs = (event, extra = '') => q(`SELECT * FROM audit_log WHERE id > ${mark} AND event = ${lit(event)}${extra}`);
  const by = (actor, target) => ` AND actor_id = ${lit(actor)}${target ? ` AND target_id = ${lit(target)}` : ''}`;
  const created = {};
  let demotedA = false, R = null;

  const mkStaff = async (role, key) => {
    const e = `${tag.toLowerCase()}.${key}@staging-check.test`, p = pw();
    const r = await call('POST', '/api/staff', { name: `Verif ${tag} ${key}`, email: e, password: p, role }, A);
    if (r.status !== 201) return null;
    created[key] = { id: r.body.id, session: await login(e, p) };
    return created[key];
  };
  try {
    out(`[staging-check] execução ${tag}`);
    // ---------- C: criação de equipe auditada ----------
    const P = await mkStaff('professor', 'prof'), X = await mkStaff('admin', 'x'), Y = await mkStaff('admin', 'y');
    check('C1', P && X && Y && P.session && X.session && Y.session, 'contas de teste criadas (professor e dois administradores) e com login');
    if (!(P && X && Y)) return results;
    check('C2', [P, X, Y].every(s => evs('staff_created', by(AID, s.id)).length === 1) && evs('staff_created').length === 3, 'staff_created: exatamente um evento por conta, com ator e alvo');
    check('C3', evs('staff_created', by(AID, X.id))[0]?.detail?.includes('"admin"') && !/@/.test(JSON.stringify(evs('staff_created'))), 'staff_created: papel no detalhe, sem e-mail');
    const d1 = await call('POST', '/api/staff', { name: 'Negado', email: `${tag.toLowerCase()}.n@staging-check.test`, password: pw(), role: 'admin' }, P.session);
    const d2 = await call('POST', '/api/staff', { name: 'Negado', email: `${tag.toLowerCase()}.m@staging-check.test`, password: pw(), role: 'admin' }, P.session);
    check('C4', d1.status === 403 && d2.status === 403 && evs('action_denied', by(P.id)).length === 1, 'professor criando equipe: 403 duas vezes, um único action_denied (limite)');

    // ---------- D: exclusão de alunos ----------
    const mkStudent = async k => { const r = await call('POST', '/api/students', { name: `Aluno ${tag} ${k}` }, A); return r.status === 201 ? r.body.student.id : null; };
    const snap = id => JSON.stringify([q(`SELECT * FROM students WHERE id = ${lit(id)}`), ...HIST.map(t => q(`SELECT * FROM ${t} WHERE student_id = ${lit(id)} ORDER BY rowid`))]);
    const S1 = await mkStudent('S1');
    check('D1a', S1 && evs('student_created', by(AID, S1)).length === 1, 'aluno criado com um student_created');
    const r1 = await call('DELETE', '/api/students/' + S1, undefined, A);
    const ev1 = evs('student_deleted', by(AID, S1));
    check('D1b', r1.status === 200 && n(`SELECT count(*) FROM students WHERE id = ${lit(S1)}`) === 0 && ev1.length === 1, 'aluno sem histórico: 200, removido, exatamente um student_deleted');
    check('D1c', ev1.length === 1 && /"presencas":0/.test(ev1[0].detail) && /"graduacoes":0/.test(ev1[0].detail) && /"avaliacoes":0/.test(ev1[0].detail), 'student_deleted com contagens zero');

    const S2 = await mkStudent('S2'), S3 = await mkStudent('S3'), S4 = await mkStudent('S4');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const L = await call('POST', '/api/lessons', { date: today, start_time: '19:00', end_time: '20:30', student_ids: [S2], technique_ids: [], title: 'Tema ' + MARK, notes: 'Obs ' + MARK }, A);
    const LID = L.body?.id || L.body?.lesson?.id;
    check('D2a', L.status === 201 && LID && evs('lesson_created', by(AID, LID)).length === 1, 'chamada com o aluno S2 registrada e auditada');
    const LU = await call('PUT', '/api/lessons/' + LID, { date: today, start_time: '19:00', end_time: '20:30', student_ids: [S2], technique_ids: [], title: 'Tema 2 ' + MARK, notes: 'Obs 2 ' + MARK }, A);
    check('C5', LU.status === 200 && evs('lesson_updated', by(AID, LID)).length === 1 && !JSON.stringify(evs('lesson_updated')).includes(MARK), 'lesson_updated sem título nem observações no detalhe');
    const pr = await call('POST', `/api/students/${S3}/promote`, { kind: 'grau', override: 1 }, A);
    let tech = one('SELECT id FROM techniques ORDER BY id LIMIT 1').id;
    if (!tech) { const t = await call('POST', '/api/techniques', { name: `Técnica ${tag}`, category: 'Guarda' }, A); tech = t.body?.id; check('C6', t.status === 201 && evs('technique_created', ` AND target_id = '${Number(tech)}'`).length === 1, 'technique_created com o id real'); }
    const sk = await call('PUT', `/api/students/${S4}/skills`, { items: [{ technique_id: tech, level: 2 }] }, A);
    check('D2b', pr.status === 201 && sk.status === 200, 'graduação de S3 e avaliação de S4 registradas');
    const before = { S2: snap(S2), S3: snap(S3), S4: snap(S4) }, total = () => ['students', ...HIST].map(t => n(`SELECT count(*) FROM ${t}`)).join();
    const t0 = total();
    const del = await Promise.all([S2, S3, S4].map(s => call('DELETE', '/api/students/' + s, undefined, A)));
    check('D3', del.every(r => r.status === 409 && /histórico/.test(r.body?.error || '')), 'alunos com presença, graduação ou avaliação: 409 com orientação de inativar');
    check('D4', snap(S2) === before.S2 && snap(S3) === before.S3 && snap(S4) === before.S4 && total() === t0, 'nada apagado: linhas idênticas nas 5 tabelas e totais iguais');
    check('D5', [S2, S3, S4].every(s => evs('student_deleted', ` AND target_id = ${lit(s)}`).length === 0), 'nenhum student_deleted nas recusas');
    const pd = await call('DELETE', '/api/students/' + S4, undefined, P.session);
    check('D6', pd.status === 403 && snap(S4) === before.S4, 'professor não exclui aluno (403)');
    const row = q(`SELECT * FROM students WHERE id = ${lit(S2)}`)[0];
    const put = status => call('PUT', '/api/students/' + S2, { ...Object.fromEntries(STUDENT_PUT_FIELDS.map(k => [k, row[k]])), status }, A);
    const strip = r => JSON.stringify({ ...r, status: null, updated_at: null });
    const i1 = await put('inativo'), after1 = q(`SELECT * FROM students WHERE id = ${lit(S2)}`)[0];
    const i2 = await put('ativo'), after2 = q(`SELECT * FROM students WHERE id = ${lit(S2)}`)[0];
    check('D7', i1.status === 200 && i2.status === 200 && after1.status === 'inativo' && after2.status === 'ativo' && strip(after1) === strip(row) && strip(after2) === strip(row) && snap(S2).length === before.S2.length,
      'inativar e reativar mudam só a situação; histórico preservado');
    check('D8', evs('student_status_changed', by(AID, S2)).length === 2 && evs('student_updated', by(AID, S2)).length === 0, 'inativar/reativar: dois student_status_changed e nenhum student_updated');

    // ---------- C: exportação, logout, ausência de dados pessoais ----------
    const ex = await call('GET', '/api/export/alunos.csv', undefined, A), exP = await call('GET', '/api/export/alunos.csv', undefined, P.session);
    check('C7', ex.status === 200 && exP.status === 403 && evs('students_exported', by(AID)).length === 1, 'exportação: 200 com um students_exported; professor 403');
    const lo = await call('POST', '/api/logout', undefined, P.session), meP = await call('GET', '/api/me', undefined, P.session);
    check('C8', lo.status === 200 && meP.status === 401 && evs('logout', by(P.id, P.id)).length === 1, 'logout: sessão encerrada e um evento');

    // ---------- B: último administrador, com dois administradores de teste sozinhos ----------
    const dA = await call('PUT', '/api/staff/' + AID, { role: 'professor' }, X.session); demotedA = dA.status === 200;
    const admins = () => n("SELECT count(*) FROM staff WHERE role = 'admin' AND active = 1");
    if (!demotedA || admins() !== 2) { check('B0', false, `cenário exige que só X e Y fiquem administradores (há ${admins()} ativos); B não executado`); }
    else {
      const [rx, ry] = await Promise.all([call('PUT', '/api/staff/' + Y.id, { role: 'professor' }, X.session), call('PUT', '/api/staff/' + X.id, { role: 'professor' }, Y.session)]);
      const okCount = [rx, ry].filter(r => r.status === 200).length;
      check('B1', admins() === 1 && okCount === 1 && [rx, ry].some(r => [403, 409].includes(r.status)), `rebaixamento mútuo simultâneo: um passa, o outro é recusado (${rx.status}/${ry.status}); resta 1 admin`);
      R = rx.status === 200 ? X : Y;
      const s1 = await call('PUT', '/api/staff/' + R.id, { role: 'professor' }, R.session), s2 = await call('PUT', '/api/staff/' + R.id, { active: 0 }, R.session);
      check('B2', s1.status === 400 && s2.status === 400 && admins() === 1, 'último admin não se rebaixa nem se desativa');
    }
  } catch (e) {
    if (e?.name === 'GuardError') throw e;
    check('ERRO', false, 'exceção durante os cenários: ' + String(e?.message || e).slice(0, 120));
  } finally {
    // Restauração: a conta de verificação volta a ser administradora; contas de teste desativadas.
    if (demotedA) {
      const by2 = R || created.x || created.y;
      const r = by2 ? await call('PUT', '/api/staff/' + AID, { role: 'admin' }, by2.session) : { status: 0 };
      check('FIM1', r.status === 200 && n(`SELECT count(*) FROM staff WHERE id = ${lit(AID)} AND role = 'admin' AND active = 1`) === 1, 'conta de verificação restaurada como administradora');
    }
    for (const k of ['prof', 'x', 'y']) if (created[k]) await call('PUT', '/api/staff/' + created[k].id, { active: 0 }, A);
    if (Object.keys(created).length) check('FIM2', Object.values(created).every(c => n(`SELECT active FROM staff WHERE id = ${lit(c.id)}`) === 0), 'contas de teste desativadas');
    const leak = JSON.stringify(q(`SELECT * FROM audit_log WHERE id > ${mark}`));
    check('C9', !leak.includes(MARK) && !leak.toLowerCase().includes(tag.toLowerCase()) && !/@staging-check\.test/.test(leak), 'auditoria da execução sem nomes, e-mails ou textos livres');
  }
  return results;
}

registerOp('staging-check', async ctx => {
  const { opts, target, deps } = ctx;
  const extra = Object.keys(opts).filter(k => !['_', 'env', 'confirm-destination', 'dry-run'].includes(k));
  if (extra.length || opts._.length > 1) refuse(`Opção não aceita: ${extra[0] ? '--' + extra[0] : opts._[1]}. A URL vem só de db/environments.json.`);
  const origin = stagingOrigin(deps.environments(), target.name);
  const envVars = deps.env || process.env;
  const email = envVars.TATAME_CHECK_EMAIL, password = envVars.TATAME_CHECK_PASSWORD;
  if (!email || !password) refuse('Defina TATAME_CHECK_EMAIL e TATAME_CHECK_PASSWORD (administrador do staging) só nesta sessão do terminal. Nada foi executado.');
  if (typeof deps.fetch !== 'function') refuse('Sem cliente HTTP.');
  deps.out(`[staging-check] app: ${origin} | banco: ${target.database_name}`);
  if (opts['dry-run']) { deps.out('[staging-check] simulação: conferiria a identidade do banco e executaria os cenários B, C e D. Nenhuma requisição feita.'); return 0; }
  ctx.ensureIdentity();                       // banco conferido ANTES de qualquer requisição HTTP
  const src = openSource(ctx);
  const results = await runScenarios({ call: httpClient(origin, deps.fetch), q: sql => src.query(sql), out: deps.out, email, password });
  for (const r of results) ctx.evidence.record('cenario', r);
  const failed = results.filter(r => !r.ok);
  deps.out(failed.length ? `[staging-check] FALHOU: ${failed.map(r => r.id).join(', ')}` : `[staging-check] OK: ${results.length} verificações`);
  return failed.length ? 4 : 0;
});
