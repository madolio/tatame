import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
const require = createRequire(import.meta.url);
// Navegador: TATAME_CHROME aponta para um Chrome/Chromium local (usa playwright-core); sem ele, usa o pacote playwright.
const { chromium } = require(process.env.TATAME_CHROME ? 'playwright-core' : 'playwright');
const launch = () => chromium.launch(process.env.TATAME_CHROME ? { executablePath: process.env.TATAME_CHROME } : {});
const W = (await import('../web/_worker.js')).default;
const ROOT = fileURLToPath(new URL('..', import.meta.url)), WEB = path.join(ROOT, 'web'), SHOTS = path.join(os.tmpdir(), 'tatame-shots');
fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
const DB = makeD1(); DB.load(path.join(ROOT, 'db/schema.sql')); DB.load(path.join(ROOT, 'db/seed_tecnicas.sql')); DB.raw.exec("INSERT INTO settings (key, value) VALUES ('setup_token', 'K7Q2-TATAME')");
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const env = { DB, ASSETS: { fetch: async req => { const u = new URL(req.url); const f = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname); return fs.existsSync(f) && !f.endsWith('_worker.js') ? new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'text/plain' } }) : new Response('nf', { status: 404 }); } } };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ago = d => new Date(Date.parse(today) - d * 864e5).toISOString().slice(0, 10);

// chamada direta à API (para popular dados realistas), com o cookie do navegador
let apiCookie = '';
const api = async (method, p, body) => {
  const r = await W.fetch(new Request('https://tatame.test' + p, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie: apiCookie }, body: body ? JSON.stringify(body) : undefined }), env);
  const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + JSON.stringify(j)); return j;
};

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
await ctx.route('**/*', async route => {
  const req = route.request(), u = new URL(req.url());
  if (u.host !== 'tatame.test') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  const headers = await req.allHeaders();
  const r = await W.fetch(new Request(req.url(), { method: req.method(), headers, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() }), env);
  const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
  await route.fulfill({ status: r.status, headers: h, body: Buffer.from(await r.arrayBuffer()) });
});
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|fonts|status of 40[01]/.test(m.text())) errors.push('console: ' + m.text()); });
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const clear = () => page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
const toastText = async () => (await page.locator('.toast').last().textContent({ timeout: 5000 })).trim();
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n    ', e.message.split('\n').slice(0, 3).join(' | ')); await shot('fail-' + name.replace(/\W+/g, '_')); await browser.close(); process.exit(1); } };

await step('configuração inicial', async () => {
  await page.goto('https://tatame.test/');
  await page.waitForSelector('text=Primeiro acesso');
  await page.fill('[name=setup_code]', 'k7q2-tatame'); await page.fill('[name=academy_name]', 'Academia Exemplo BJJ'); await page.fill('[name=name]', 'Prof. Carlos'); await page.fill('[name=email]', 'carlos@exemplo.com'); await page.fill('[name=password]', 'curta');
  await page.click('button[type=submit]'); await page.waitForSelector('text=pelo menos 8 caracteres');
  await page.fill('[name=password]', 'tatame2026');
  await page.click('button[type=submit]');
  await page.waitForSelector('#main h1:has-text("Academia Exemplo BJJ")');
  await page.waitForSelector('text=Nenhum horário fixo hoje');
  await shot('01-painel-vazio');
  apiCookie = (await ctx.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  assert.ok(apiCookie.includes('tatame_sid='), 'cookie de sessão');
  const ck = (await ctx.cookies())[0]; assert.ok(ck.httpOnly && ck.secure && ck.sameSite === 'Strict', 'cookie seguro');
});

await step('popular academia (grade, alunos, 12 semanas de aulas)', async () => {
  const wdToday = new Date(today + 'T12:00:00Z').getUTCDay();
  const classes = [];
  for (const [name, wd, st, en, level] of [['Fundamentos', 1, '19:00', '20:00', 'iniciante'], ['Avançada', 1, '20:00', '21:30', 'avancado'], ['Fundamentos', 3, '19:00', '20:00', 'iniciante'], ['Avançada', 3, '20:00', '21:30', 'avancado'], ['Todos os níveis', 5, '19:00', '20:30', 'todos'], ['Open mat', 6, '10:00', '12:00', 'todos'], ['Todos os níveis', wdToday, '07:00', '08:00', 'todos']])
    classes.push(await api('POST', '/api/classes', { name, weekday: wd, start_time: st, end_time: en, level }));
  const people = [
    ['Ana Lima', 'branca', 4, 400, 120, '1997-04-10', 0.9], ['Bruno Costa', 'branca', 2, 150, 60, '2001-08-21', 0.8], ['Caio Mendes', 'branca', 0, 30, 30, '2003-01-02', 0.6],
    ['Daniela Rocha', 'azul', 3, 760, 190, '1995-11-30', 0.7], ['Eduardo Pires', 'azul', 1, 300, 200, '1992-06-15', 0.5], ['Fernanda Alves', 'roxa', 2, 500, 140, '1990-02-03', 0.85],
    ['Gabriel Nunes', 'marrom', 1, 250, 250, '1988-09-09', 0.4], ['Helena Dias', 'branca', 1, 90, 90, '2000-12-12', 0.15], ['Igor Teixeira', 'azul', 0, 60, 60, '1999-03-03', 0.75],
    ['João Pedro', 'cinza', 2, 200, 120, ago(365 * 10), 0.7], ['Lucas Martins', 'branca', 3, 220, 110, '1998-07-07', 0.0]
  ];
  const ids = [];
  for (const [name, belt, degrees, beltDays, degDays, birth] of people) {
    const r = await api('POST', '/api/students', { name, belt, degrees, imported_classes_belt: name === 'Ana Lima' ? 100 : 0, imported_classes_degree: name === 'Ana Lima' ? 30 : 0, birth_date: birth, start_date: ago(Math.max(beltDays, 30) + 20), belt_since: ago(beltDays), degree_since: ago(Math.min(degDays, beltDays)), phone: '11 9' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0') });
    ids.push(r.student.id);
  }
  const techs = (await api('GET', '/api/state')).techniques;
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  // 12 semanas de aulas na grade fixa (exceto hoje)
  for (let d = 84; d >= 1; d--) {
    const date = ago(d), wd = new Date(date + 'T12:00:00Z').getUTCDay();
    for (const c of classes.filter(c => c.weekday === wd && !(c.start_time === '07:00'))) {
      const present = ids.filter((id, i) => rnd() < people[i][6] * (i === 10 && d < 20 ? 0 : 1) * (c.level === 'avancado' && ['branca', 'cinza'].includes(people[i][1]) ? 0.2 : 0.6));
      const tset = techs.filter(t => t.min_belt === (c.level === 'avancado' ? 'azul' : 'branca')).sort(() => rnd() - 0.5).slice(0, 2).map(t => t.id);
      await api('POST', '/api/lessons', { class_id: c.id, date, student_ids: present, technique_ids: tset, title: techs.find(t => t.id === tset[0]).category });
    }
  }
  // avaliações: Ana domina o currículo branca; Daniela parcialmente
  const branca = techs.filter(t => t.min_belt === 'branca');
  await api('PUT', `/api/students/${ids[0]}/skills`, { items: branca.map((t, i) => ({ technique_id: t.id, level: i % 5 === 0 ? 4 : 3 })) });
  await api('PUT', `/api/students/${ids[3]}/skills`, { items: techs.filter(t => ['branca', 'azul'].includes(t.min_belt)).map((t, i) => ({ technique_id: t.id, level: [2, 3, 3, 4][i % 4] })) });
  globalThis.IDS = ids;
});

await step('painel com dados', async () => {
  await page.reload();
  await page.waitForSelector('#ch-week svg');
  const txt = await page.textContent('#main');
  assert.match(txt, /Ana Lima/); // apta (branca 4 graus, currículo)
  assert.match(txt, /Lucas Martins/); // sumiu há 20 dias
  await page.waitForSelector('.heat .c');
  await shot('02-painel');
});

await step('chamada da aula de hoje', async () => {
  await page.click('text=Fazer chamada');
  await page.waitForSelector('#lesson-screen');
  for (const n of ['Ana Lima', 'Bruno Costa', 'Daniela Rocha']) await page.click(`#att-list >> text=${n}`);
  await page.fill('#ls-tq', 'triân'); await page.click('#lesson-screen .att:has-text("Triângulo")');
  await page.fill('#ls-title', 'Triângulo da guarda fechada');
  await page.waitForSelector('text=Salvar chamada (3)');
  await shot('03-chamada');
  await clear(); await page.click('[data-act=lesson-save]'); assert.match(await toastText(), /Chamada salva/);
  await page.waitForSelector('text=3 presentes');
  // a mesma turma no mesmo dia não duplica
  await page.click('.nav a[data-tab=aulas]'); await page.click('text=Nova chamada');
  await page.selectOption('#ls-class', { index: 1 });
  const opt = await page.$eval('#ls-class', s => s.options[s.selectedIndex].text);
  if (/07:00/.test(opt)) { await page.click(`#att-list .att >> nth=0`); await clear(); await page.click('[data-act=lesson-save]'); assert.match(await toastText(), /Já existe uma chamada/); }
  await page.click('[data-act=lesson-close]');
  // D6: chamada feita sem presentes (marcador roll_called) — a caixa só aparece enquanto ninguém está marcado
  await page.click('text=Nova chamada'); await page.waitForSelector('#lesson-screen');
  assert.ok(await page.isVisible('#ls-roll-row'), 'caixa de chamada sem presentes visível com ninguém marcado');
  await shot('03b-chamada-sem-presentes');
  await page.click('#att-list .att >> nth=0'); assert.ok(!(await page.isVisible('#ls-roll-row')), 'caixa some quando há presentes');
  await page.click('#att-list .att >> nth=0'); assert.ok(await page.isVisible('#ls-roll-row'));
  await page.check('#ls-roll'); await clear(); await page.click('[data-act=lesson-save]'); assert.match(await toastText(), /Chamada salva/);
});

await step('ficha do aluno e avaliação de técnicas', async () => {
  await page.click('.nav a[data-tab=alunos]');
  await page.fill('#stu-q', 'bruno');
  await page.click('#stu-list >> text=Bruno Costa');
  await page.waitForSelector('text=Próxima graduação');
  assert.match(await page.textContent('#main'), /3º grau/);
  await shot('04-aluno-graduacao');
  await page.click('[data-act=detail-tab][data-id=tecnicas]');
  await page.waitForSelector('.tech-row');
  const row = page.locator('.tech-row:has(b:text-is("Triângulo"))');
  await row.locator('[data-l="3"]').click();
  await page.waitForFunction(() => document.querySelector('.tech-row[data-tid] .lvl [data-l="3"].on'));
  await page.waitForTimeout(400);
  await shot('05-aluno-tecnicas');
  await page.click('[data-act=detail-tab][data-id=presencas]'); await page.waitForSelector('#ch-stu svg');
  await shot('06-aluno-presencas');
});

await step('graduação: grau antes do critério exige confirmação; faixa com critérios', async () => {
  await page.click('[data-act=detail-tab][data-id=graduacao]');
  await page.click('[data-act=promote][data-kind=grau]');
  await page.waitForSelector('text=Critérios ainda não cumpridos');
  await clear(); await page.click('#promo button'); assert.match(await toastText(), /Grau registrado/);
  await page.waitForSelector('text=antes dos critérios');
  await page.click('[data-act=promo-undo]'); await page.click('#sheet [data-x=ok]');
  await page.waitForSelector('text=Sem graduações registradas');
  // Ana: apta para azul
  await page.click('.nav a[data-tab=painel]');
  await page.click('#main >> text=Ana Lima');
  await page.waitForSelector('.card .tag.good');
  await shot('07-ana-apta');
  await page.click('[data-act=promote][data-kind=faixa]');
  await page.fill('#promo [name=notes]', 'Exame de faixa de novembro');
  await clear(); await page.click('#promo button'); assert.match(await toastText(), /Nova faixa registrada/);
  await page.waitForSelector('text=Faixa azul');
  await page.waitForSelector('text=Exame de faixa de novembro');
  await shot('08-ana-azul');
});

await step('horários, técnicas e ajustes', async () => {
  await page.click('.nav a[data-tab=aulas]'); await page.click('[data-act=aulas-tab][data-id=horarios]');
  await page.waitForSelector('text=alunos/aula');
  await page.click('text=Novo horário'); await page.fill('#cls [name=name]', 'Kids'); await page.fill('#cls [name=start_time]', '18:00'); await page.fill('#cls [name=end_time]', '17:00');
  await page.click('#cls button:not([type=button])'); await page.waitForSelector('text=O fim precisa ser depois do início');
  await page.fill('#cls [name=end_time]', '18:50'); await page.selectOption('#cls [name=level]', 'kids');
  await clear(); await page.click('#cls button:not([type=button])'); assert.match(await toastText(), /Horário salvo/);
  await shot('09-horarios');
  await page.click('.nav a[data-tab=tecnicas]'); await page.waitForSelector('text=Currículo branca');
  await shot('10-tecnicas');
  await page.click('[data-act=tech-edit]:not([data-id])'); await page.fill('#tf [name=name]', 'Raspagem de balão'); await page.selectOption('#tf [name=category]', 'Raspagens');
  await clear(); await page.click('#tf button:not([type=button])'); assert.match(await toastText(), /Técnica salva/);
  await page.click('.nav a[data-tab=ajustes]'); await page.waitForSelector('table.rules');
  await page.fill('[name="branca.degree_months"]', '2');
  await clear(); await page.click('#rules button'); assert.match(await toastText(), /Critérios salvos/);
  await page.click('[data-act=staff-edit]:not([data-id])');
  await page.fill('#sf [name=name]', 'Prof. Rafael'); await page.fill('#sf [name=email]', 'rafael@exemplo.com'); await page.fill('#sf [name=password]', 'rafael2026');
  await clear(); await page.click('#sf button'); assert.match(await toastText(), /Acesso salvo/);
  await shot('11-ajustes');
});

await step('professor sem permissão de admin e logout', async () => {
  await page.click('.top [data-act=logout]'); await page.click('#sheet [data-x=ok]');
  await page.fill('[name=email]', 'rafael@exemplo.com'); await page.fill('[name=password]', 'errada123'); await page.click('button[type=submit]');
  await page.waitForSelector('text=E-mail ou senha incorretos');
  await page.fill('[name=password]', 'rafael2026'); await page.click('button[type=submit]');
  await page.waitForSelector('#main h1:has-text("Academia Exemplo BJJ")');
  await page.click('.nav a[data-tab=ajustes]'); await page.waitForSelector('text=só o administrador edita');
  assert.equal(await page.locator('#acad').count(), 0);
  assert.ok(await page.locator('[name="branca.degree_months"]').isDisabled());
  assert.equal(await page.locator('a[href="/api/export/alunos.csv"]').count(), 0, 'professor não vê exportar CSV');
  // técnicas: só consulta
  await page.click('.nav a[data-tab=tecnicas]'); await page.waitForSelector('text=Currículo branca');
  assert.equal(await page.locator('text=Nova técnica').count(), 0, 'professor não vê Nova técnica');
  await page.click('.tlib >> nth=0'); await page.waitForSelector('#tf');
  assert.ok(await page.locator('#tf [name=name]').isDisabled(), 'campos da técnica travados');
  assert.equal(await page.locator('#tf button:not([type=button])').count(), 0, 'sem botão salvar');
  await page.click('[data-act=close-sheet]');
  // horário: sem excluir; aluno: datas de graduação travadas; mas o dia a dia continua
  await page.click('.nav a[data-tab=aulas]'); await page.click('[data-act=aulas-tab][data-id=horarios]'); await page.click('.cls >> nth=0'); await page.waitForSelector('#cls');
  assert.equal(await page.locator('#cls-del').count(), 0, 'professor não exclui horário');
  await page.click('[data-act=close-sheet]');
  await page.click('.nav a[data-tab=alunos]'); await page.click('#stu-list >> text=Bruno Costa'); await page.click('[data-act=detail-tab][data-id=dados]');
  assert.ok(await page.locator('#stu-form [name=belt_since]').isDisabled(), 'datas de graduação travadas para o professor');
  await page.fill('#stu-form [name=phone]', '11 98888-7777'); await clear(); await page.click('#stu-form [type=submit]'); assert.match(await toastText(), /Dados salvos/);
  await page.click('.nav a[data-tab=aulas]'); await page.click('[data-act=aulas-tab][data-id=chamadas]'); await page.click('text=Nova chamada'); await page.waitForSelector('#lesson-screen');
  await page.click('#att-list .att >> nth=0'); await clear(); await page.click('[data-act=lesson-save]'); assert.match(await toastText(), /Chamada salva/);
});

await step('recuperação de senha por código', async () => {
  const RC = await import('../tools/reset-code.mjs');
  await page.evaluate(() => { location.hash = '#ajustes'; }); await page.waitForSelector('.top [data-act=logout]'); await page.click('.top [data-act=logout]'); await page.click('#sheet [data-x=ok]');
  await page.click('#to-reset'); await page.waitForSelector('#reset');
  await shot('11-recuperar');
  await page.fill('#reset [name=email]', 'rafael@exemplo.com'); await page.fill('#reset [name=code]', RC.generateCode());
  await page.fill('#reset [name=password]', 'rafael-nova-2026'); await page.fill('#reset [name=password_confirm]', 'rafael-nova-2026'); await page.click('#reset [type=submit]');
  await page.waitForSelector('#reset-err:has-text("Código inválido")');
  const id = DB.raw.prepare("SELECT id FROM staff WHERE email = 'rafael@exemplo.com'").get().id;
  const code = RC.generateCode(); DB.raw.exec(RC.buildSql(id, code));
  await page.fill('#reset [name=code]', code); await page.fill('#reset [name=password_confirm]', 'diferente-123'); await page.click('#reset [type=submit]');
  await page.waitForSelector('#reset-err:has-text("não conferem")');
  await page.fill('#reset [name=password_confirm]', 'rafael-nova-2026'); await page.click('#reset [type=submit]');
  await page.waitForSelector('#auth-err:has-text("Senha redefinida")');
  await page.fill('[name=email]', 'rafael@exemplo.com'); await page.fill('[name=password]', 'rafael2026'); await page.click('button[type=submit]');
  await page.waitForSelector('text=E-mail ou senha incorretos');
  await page.fill('[name=password]', 'rafael-nova-2026'); await page.click('button[type=submit]');
  await page.waitForSelector('#main h1:has-text("Academia Exemplo BJJ")');
  // código já usado
  await page.evaluate(() => { location.hash = '#ajustes'; }); await page.waitForSelector('.top [data-act=logout]'); await page.click('.top [data-act=logout]'); await page.click('#sheet [data-x=ok]'); await page.click('#to-reset');
  await page.fill('#reset [name=email]', 'rafael@exemplo.com'); await page.fill('#reset [name=code]', code);
  await page.fill('#reset [name=password]', 'outra-senha-123'); await page.fill('#reset [name=password_confirm]', 'outra-senha-123'); await page.click('#reset [type=submit]');
  await page.waitForSelector('#reset-err:has-text("já foi utilizado")');
  await page.click('#to-login'); await page.fill('[name=email]', 'rafael@exemplo.com'); await page.fill('[name=password]', 'rafael-nova-2026'); await page.click('button[type=submit]');
  await page.waitForSelector('#main h1:has-text("Academia Exemplo BJJ")');
});

await step('desktop', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('.nav a[data-tab=painel]'); await page.waitForSelector('#ch-week svg');
  await shot('12-desktop');
});
console.log(errors.length ? 'ERROS:\n' + errors.join('\n') : 'sem erros no console');
await browser.close();
process.exit(errors.length ? 1 : 0);
