// Etapa 6.3-A (V2): limites por par, por rede (IPv4 inteiro / IPv6 /64) e por conta; cookie de aparelho conhecido;
// política de senha nova; auditoria (login_ok, login_locked) sem segredos; nada parcial em falha. Confere o BANCO.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));

function world() {
  const DB = makeD1(); DB.load(SCHEMA);
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  const call = async (method, path, body, { ip = '198.51.100.1', cookie = '', noIp = false } = {}) => {
    const h = { 'content-type': 'application/json', 'x-tatame': '1', cookie }; if (!noIp) h['cf-connecting-ip'] = ip;
    const r = await W.fetch(new Request('https://t.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    return { status: r.status, body: await r.json().catch(() => null), set, session: (set.find(c => c.startsWith('tatame_sid=')) || '').split(';')[0], device: (set.find(c => c.startsWith('tatame_dev_')) || '').split(';')[0], deviceFull: set.find(c => c.startsWith('tatame_dev_')) || '' };
  };
  const n = (sql, ...p) => DB.raw.prepare(sql).get(...p).n;
  return { DB, call, n };
}
async function boot(w, { email = 'dono@x.test', password = 'cordafina-71' } = {}) {
  const code = generateCode(); w.DB.raw.exec(buildSetupSql(code));
  const r = await w.call('POST', '/api/setup', { academy_name: 'Academia', name: 'Dono Da Silva', email, password, setup_code: code });
  assert.strictEqual(r.status, 201);
  return { admin: r.session, id: w.DB.raw.prepare('SELECT id FROM staff WHERE email = ?').get(email).id };
}
const login = (w, email, password, opts) => w.call('POST', '/api/login', { email, password }, opts);
// Assinatura recalculada fora do Worker (mesma especificação): HKDF(ikm = hash, salt = id, info) -> HMAC("v1|id|emitido").
async function forge(DB, id, issued) {
  const s = DB.raw.prepare('SELECT id, pass_hash FROM staff WHERE id = ?').get(id);
  const ikm = await crypto.subtle.importKey('raw', Buffer.from(s.pass_hash, 'base64'), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(s.id), info: enc.encode('tatame:aparelho-conhecido:v1') }, ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`v1|${s.id}|${issued}`)));
  return `tatame_dev_${(await sha('tatame-dev-name:' + s.id)).slice(0, 12)}=v1.${s.id}.${issued}.${mac}`;
}
const LOCK = 'Muitas tentativas. Aguarde 15 minutos e tente de novo.';

// ================= 1. IPv4: 30 por rede =================
{ const w = world(); await boot(w);
  for (let i = 0; i < 30; i++) assert.strictEqual((await login(w, `x${i}@x.test`, 'errada-123', { ip: '192.0.2.10' })).status, 401);
  const r = await login(w, 'dono@x.test', 'cordafina-71', { ip: '192.0.2.10' });
  ok(r.status === 429 && w.n("SELECT count(*) n FROM login_attempts WHERE key = 'ip:192.0.2.10'") === 30, 'IPv4: 30 erros (30 contas) bloqueiam a 31ª tentativa do mesmo endereço, inclusive com a senha certa; 30 linhas no contador');
  ok((await login(w, 'dono@x.test', 'cordafina-71', { ip: '192.0.2.11' })).status === 200, 'IPv4: o endereço vizinho (outro IP) não é afetado');
  ok(w.n("SELECT count(*) n FROM audit_log WHERE event = 'login_locked'") === 1 && JSON.parse(w.DB.raw.prepare("SELECT detail FROM audit_log WHERE event = 'login_locked'").get().detail).limites.includes('rede'), 'IPv4: um único login_locked (limite "rede") quando o limite foi atingido, não um por tentativa'); }

// ================= 2. IPv6: mesma /64 compartilha o contador =================
{ const w = world(); await boot(w);
  for (let i = 0; i < 30; i++) await login(w, `y${i}@x.test`, 'errada-123', { ip: `2001:db8:a:b:${(i + 1).toString(16)}::${i + 7}` });
  const same = await login(w, 'dono@x.test', 'cordafina-71', { ip: '2001:0DB8:000A:000B:ffff:ffff:ffff:ffff' });
  const other = await login(w, 'dono@x.test', 'cordafina-71', { ip: '2001:db8:a:c::1' });
  ok(same.status === 429 && other.status === 200 && w.n("SELECT count(*) n FROM login_attempts WHERE key = 'ip:2001:db8:a:b::/64'") === 30, 'IPv6: 30 endereços diferentes da mesma /64 (formas compactas e por extenso) somam no mesmo contador; outra /64 passa');
  const w2 = world(); await boot(w2);
  await login(w2, 'z@x.test', 'errada-123', { ip: '::ffff:192.0.2.55' }); await login(w2, 'z@x.test', 'errada-123', { ip: '192.0.2.55' });
  await login(w2, 'z@x.test', 'errada-123', { ip: 'nao-e-ip' }); await login(w2, 'z@x.test', 'errada-123', { noIp: true }); await login(w2, 'z@x.test', 'errada-123', { ip: '1:2:3:4:5:6:7:8:9' });
  ok(w2.n("SELECT count(*) n FROM login_attempts WHERE key = 'ip:192.0.2.55'") === 2 && w2.n("SELECT count(*) n FROM login_attempts WHERE key = 'ip:desconhecido'") === 3, 'IPv4 mapeado (::ffff:a.b.c.d) conta como o IPv4; cabeçalho ausente, inválido ou IPv6 malformado caem numa chave única compartilhada (não ficam sem limite)'); }

// ================= 3–5. conta: distribuído, aparelho desconhecido bloqueado, conhecido entra =================
{ const w = world(); const { id } = await boot(w);
  const ownerDev = (await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9' })).device;
  ok(/^tatame_dev_[0-9a-f]{12}=v1\.[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/.test(ownerDev), 'login com sucesso entrega o cookie de aparelho conhecido');
  for (let i = 0; i < 19; i++) assert.strictEqual((await login(w, 'dono@x.test', 'chute-' + i, { ip: `203.0.113.${i}` })).status, 401);
  ok((await login(w, 'dono@x.test', 'chute-x', { ip: '203.0.113.200' })).status === 401 && w.n("SELECT count(*) n FROM audit_log WHERE event = 'login_locked'") === 1, '20 erros distribuídos em 20 IPs: o 20º registra login_locked (limite "conta")');
  const stranger = await login(w, 'dono@x.test', 'cordafina-71', { ip: '203.0.113.250' });
  ok(stranger.status === 429 && stranger.body.error === LOCK && stranger.session === '', 'aparelho desconhecido, mesmo com a senha CERTA e de um IP novo: 429, nenhuma sessão');
  const sess0 = w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', id);
  const owner = await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9', cookie: ownerDev });
  ok(owner.status === 200 && owner.session && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', id) === sess0 + 1, 'dono no aparelho conhecido continua entrando durante o ataque');
  const ownerWrong = await login(w, 'dono@x.test', 'errada-123', { ip: '198.51.100.9', cookie: ownerDev });
  ok(ownerWrong.status === 401, 'aparelho conhecido com senha errada: 401 normal (o cookie não autentica nada)');
  ok(w.n("SELECT count(*) n FROM audit_log WHERE event = 'login_locked'") === 1, 'tentativas bloqueadas (429) não geram mais linhas de auditoria');
  w.DB.raw.exec("UPDATE login_attempts SET at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-16 minutes')");
  ok((await login(w, 'dono@x.test', 'cordafina-71', { ip: '203.0.113.251' })).status === 200, 'passada a janela de 15 min, o aparelho desconhecido volta a entrar (bloqueio não é permanente)');
  // sem enumeração: conta inexistente bloqueia igual
  for (let i = 0; i < 20; i++) await login(w, 'fantasma@x.test', 'chute-' + i, { ip: `203.0.114.${i}` });
  const g = await login(w, 'fantasma@x.test', 'qualquer-1', { ip: '203.0.114.250' });
  ok(g.status === 429 && g.body.error === LOCK && JSON.parse(w.DB.raw.prepare("SELECT detail FROM audit_log WHERE event = 'login_locked' ORDER BY id DESC").get().detail).conta_existe === false, 'conta inexistente bloqueia com a mesma resposta (sem revelar se o e-mail existe)'); }

// ================= 6–10. cookie: inválido, adulterado, vencido, após troca de senha, troca entre contas =================
{ const w = world(); const { admin, id } = await boot(w);
  await w.call('POST', '/api/staff', { name: 'Outra Pessoa', email: 'outra@x.test', password: 'pedra-lisa-42', role: 'professor' }, { cookie: admin });
  const other = w.DB.raw.prepare("SELECT id FROM staff WHERE email = 'outra@x.test'").get().id;
  const dev = (await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9' })).device;
  const otherDev = (await login(w, 'outra@x.test', 'pedra-lisa-42', { ip: '198.51.100.9' })).device;
  const lockOwner = async () => { w.DB.raw.exec('DELETE FROM login_attempts'); for (let i = 0; i < 20; i++) await login(w, 'dono@x.test', 'chute-' + i, { ip: `203.0.113.${i}` }); };
  const tryWith = cookie => login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9', cookie });
  await lockOwner();
  const [name, value] = dev.split('=');
  const parts = value.split('.');
  ok((await tryWith(`${name}=lixo`)).status === 429 && (await tryWith(`${name}=v1.${id}.abc.${'0'.repeat(64)}`)).status === 429 && (await tryWith(`${name}=`)).status === 429, 'cookie malformado (lixo, campos fora do formato, vazio): ignorado, bloqueado');
  const flip = parts[3].slice(0, -1) + (parts[3].endsWith('0') ? '1' : '0');
  ok((await tryWith(`${name}=${parts.slice(0, 3).join('.')}.${flip}`)).status === 429, 'cookie adulterado (1 caractere da assinatura): bloqueado');
  ok((await tryWith(`${name}=v1.${id}.${Number(parts[2]) + 3600}.${parts[3]}`)).status === 429, 'cookie adulterado (data de emissão trocada, mesma assinatura): bloqueado');
  const now = Math.floor(Date.now() / 1000);
  ok((await tryWith(await forge(w.DB, id, now - 89 * 86400))).status === 200, 'cookie com assinatura correta e 89 dias: aceito (confirma a derivação HKDF/HMAC documentada)');
  await lockOwner();
  ok((await tryWith(await forge(w.DB, id, now - 90 * 86400 - 5))).status === 429, 'cookie vencido (90 dias): bloqueado');
  ok((await tryWith(await forge(w.DB, id, now + 3600))).status === 429, 'cookie "do futuro" (emitido daqui a 1 h): bloqueado');
  const oname = otherDev.split('=')[0];
  ok((await tryWith(otherDev)).status === 429 && (await tryWith(`${name}=${otherDev.split('=')[1]}`)).status === 429 && (await tryWith(`${oname}=${value}`)).status === 429, 'cookie de outra conta: não vale para o dono (nem com o nome do cookie trocado)');
  ok((await tryWith(dev)).status === 200, 'o cookie verdadeiro do dono, sem alteração: aceito');
  // troca de senha (pelo admin, rota existente) invalida o cookie emitido antes
  await lockOwner();
  const admin2 = (await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9', cookie: dev })).session;
  await w.call('PUT', '/api/staff/' + other, { name: 'Outra Pessoa', password: 'pedra-nova-43' }, { cookie: admin2 });
  for (let i = 0; i < 20; i++) await login(w, 'outra@x.test', 'chute-' + i, { ip: `203.0.115.${i}` });
  ok((await login(w, 'outra@x.test', 'pedra-nova-43', { ip: '198.51.100.9', cookie: otherDev })).status === 429, 'cookie emitido ANTES de a senha mudar deixa de valer (chave derivada do hash da senha)');
  const fresh = await login(w, 'outra@x.test', 'pedra-nova-43', { ip: '198.51.100.9', cookie: await forge(w.DB, other, now) });
  ok(fresh.status === 200, 'cookie emitido DEPOIS da troca: aceito');
  ok(/; Path=\/api\/login; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000$/.test(fresh.deviceFull) && !fresh.deviceFull.includes(w.DB.raw.prepare('SELECT pass_hash FROM staff WHERE id = ?').get(other).pass_hash), 'atributos do cookie: Path=/api/login, HttpOnly, Secure, SameSite=Strict, 90 dias; não contém o hash'); }

// ================= 11. concorrência =================
{ const w = world(); const { id } = await boot(w);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => login(w, 'dono@x.test', 'cordafina-71', { ip: `198.51.100.${30 + i}` })));
  const devs = rs.map(r => r.device);
  ok(rs.every(r => r.status === 200 && r.session) && new Set(rs.map(r => r.session)).size === 6 && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', id) === 7, '6 logins simultâneos: 6 sessões novas e distintas (+1 do setup)');
  ok(w.n("SELECT count(*) n FROM audit_log WHERE event = 'login_ok'") === 6, 'um login_ok por login com sucesso (o setup não gera login_ok)');
  for (let i = 0; i < 20; i++) await login(w, 'dono@x.test', 'chute-' + i, { ip: `203.0.113.${i}` });
  let valid = 0; for (const d of devs) if ((await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.99', cookie: d })).status === 200) valid++;
  ok(valid === 6, 'os 6 cookies emitidos ao mesmo tempo continuam válidos (sem estado no banco para disputar)');
  const par = await Promise.all(Array.from({ length: 12 }, (_, i) => login(w, 'dono@x.test', 'chute-p' + i, { ip: '203.0.113.240' })));
  ok(par.filter(r => r.status === 401).length + par.filter(r => r.status === 429).length === 12 && w.n("SELECT count(*) n FROM login_attempts WHERE key = 'email:dono@x.test|ip:203.0.113.240'") <= 12, '12 senhas erradas simultâneas do mesmo IP: só 401/429, contador coerente (PENDENTE: no D1 real a checagem e o registro não são uma única transação)'); }

// ================= 12–17. política de senha =================
{ const w = world(); const { admin } = await boot(w);
  const make = (password, extra = {}) => w.call('POST', '/api/staff', { name: 'Pessoa Teste', email: `p${Math.random().toString(36).slice(2, 8)}@x.test`, password, role: 'professor', ...extra }, { cookie: admin });
  ok((await make('nove-car9')).status === 400 && (await make('dez-carac1')).status === 201, 'tamanho: 9 caracteres recusado, 10 aceito');
  ok((await make('x'.repeat(64) + 'y'.repeat(64))).status === 201 && (await make('x'.repeat(65) + 'y'.repeat(64))).status === 400, 'tamanho: 128 aceito, 129 recusado');
  const common = ['1234567890', 'QWERTYUIOP', 'Senha12345', 'jiujitsu123', 'tatame2026', 'palmeiras1', 'administrador'];
  let rej = 0; for (const p of common) if ((await make(p)).status === 400) rej++;
  ok(rej === common.length, `senhas comuns (inclusive com maiúsculas): ${rej}/${common.length} recusadas`);
  ok((await w.call('POST', '/api/staff', { name: 'Igual Mail', email: 'mesma.senha@x.test', password: 'MESMA.SENHA@x.test', role: 'professor' }, { cookie: admin })).status === 400, 'senha igual ao e-mail (sem diferenciar maiúsculas): recusada');
  ok((await w.call('POST', '/api/staff', { name: 'Joana Pereira', email: 'jp@x.test', password: '  joana pereira ', role: 'professor' }, { cookie: admin })).status === 400, 'senha igual ao nome (espaços e maiúsculas ignorados): recusada');
  ok((await make('aaaaaaaaaaaa')).status === 400 && (await make('🥋🥋🥋🥋🥋🥋🥋🥋🥋🥋')).status === 400 && (await make('aaaaaaaaab')).status === 201, 'um único caractere repetido (inclusive emoji): recusado; quase repetido é aceito');
  ok((await make('Tr0ub4dor&3', {})).status === 201 && (await make('guarda aberta no tatame')).status === 201, 'sem exigência artificial: frase simples só com letras minúsculas e espaços é aceita');
  // a mesma política nos outros pontos que gravam senha nova (centralizada)
  const prof = w.DB.raw.prepare("SELECT id FROM staff WHERE role = 'professor' LIMIT 1").get().id;
  ok((await w.call('PUT', '/api/staff/' + prof, { name: 'Pessoa Teste', password: '1234567890' }, { cookie: admin })).status === 400, 'admin trocando senha de outra pessoa: mesma política');
  ok((await w.call('PUT', '/api/me/password', { current: 'cordafina-71', password: 'curta-9ch' }, { cookie: admin })).status === 400 && (await w.call('PUT', '/api/me/password', { current: 'cordafina-71', password: 'dono@x.test' }, { cookie: admin })).status === 400, 'troca da própria senha: mesma política (tamanho e igual ao e-mail)');
  const w2 = world(); const code = generateCode(); w2.DB.raw.exec(buildSetupSql(code));
  ok((await w2.call('POST', '/api/setup', { academy_name: 'Academia', name: 'Dono', email: 'd@x.test', password: 'senha12345', setup_code: code })).status === 400 && w2.n('SELECT count(*) n FROM staff') === 0, 'setup: mesma política; recusa não cria ninguém nem consome o código');
  // senha antiga curta continua funcionando no login
  const pbkdf2 = async (pw, saltB64) => { const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']); return Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(saltB64, 'base64'), iterations: 100000 }, k, 256)).toString('base64'); };
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  w.DB.raw.prepare("INSERT INTO staff (id, name, email, pass_hash, pass_salt, role) VALUES (?, 'Antigo', 'antigo@x.test', ?, ?, 'professor')").run(crypto.randomUUID(), await pbkdf2('oito8888', salt), salt);
  ok((await login(w, 'antigo@x.test', 'oito8888', { ip: '198.51.100.70' })).status === 200, 'conta existente com senha antiga de 8 caracteres (e "comum"): continua entrando; ninguém é forçado a trocar'); }

// ================= 18. auditoria sem segredos =================
{ const w = world(); const { id } = await boot(w);
  const r = await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9' });
  for (let i = 0; i < 20; i++) await login(w, 'dono@x.test', 'chute-secreto-' + i, { ip: `203.0.113.${i}` });
  const rows = w.DB.raw.prepare("SELECT * FROM audit_log WHERE event IN ('login_ok', 'login_locked')").all();
  const okRow = rows.find(x => x.event === 'login_ok'), d = JSON.parse(okRow.detail);
  ok(okRow.staff_id === id && d.rede === '198.51.100.9' && d.aparelho_conhecido === false, 'login_ok: quem, de qual rede e se era aparelho conhecido');
  ok(w.n("SELECT count(*) n FROM audit_log WHERE event NOT IN ('login_ok', 'login_locked')") === 0 && rows.length === 2, 'nenhuma linha por senha errada: 20 erros geraram só 1 login_locked');
  const all = JSON.stringify(w.DB.raw.prepare('SELECT * FROM audit_log').all());
  const ph = w.DB.raw.prepare('SELECT pass_hash, pass_salt FROM staff WHERE id = ?').get(id);
  ok(!all.includes('cordafina') && !all.includes('chute-secreto') && !all.includes(ph.pass_hash) && !all.includes(ph.pass_salt) && !all.includes(r.device.split('=')[1]) && !all.includes(r.session.split('=')[1]) && !/tatame_dev_|tatame_sid/.test(all), 'auditoria sem senha, hash, sal, cookie de aparelho ou de sessão'); }

// ================= 19. nada parcial em falha =================
{ const w = world(); const { id } = await boot(w);
  w.DB.raw.exec("CREATE TRIGGER falha_ok BEFORE INSERT ON audit_log WHEN NEW.event = 'login_ok' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  await login(w, 'dono@x.test', 'errada-123', { ip: '198.51.100.9' });
  const pair0 = w.n("SELECT count(*) n FROM login_attempts WHERE key = 'email:dono@x.test|ip:198.51.100.9'");
  const r = await login(w, 'dono@x.test', 'cordafina-71', { ip: '198.51.100.9' });
  ok(r.status === 500 && r.session === '' && w.n('SELECT count(*) n FROM auth_sessions WHERE staff_id = ?', id) === 1 && w.n("SELECT count(*) n FROM login_attempts WHERE key = 'email:dono@x.test|ip:198.51.100.9'") === pair0 && r.device === '', 'falha na auditoria do login: nenhuma sessão nova, contador intacto, nenhum cookie entregue');
  w.DB.raw.exec('DROP TRIGGER falha_ok');
  w.DB.raw.exec("CREATE TRIGGER falha_lock BEFORE INSERT ON audit_log WHEN NEW.event = 'login_locked' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;");
  w.DB.raw.exec('DELETE FROM login_attempts');
  for (let i = 0; i < 19; i++) await login(w, 'dono@x.test', 'chute-' + i, { ip: `203.0.113.${i}` });
  const before = w.n('SELECT count(*) n FROM login_attempts');
  const r2 = await login(w, 'dono@x.test', 'chute-20', { ip: '203.0.113.99' });
  ok(r2.status === 500 && w.n('SELECT count(*) n FROM login_attempts') === before, 'falha ao gravar login_locked: as linhas de tentativa do mesmo batch também não ficam'); }

console.error = oe;
ok(errs.every(e => /falha simulada/.test(e)), 'nenhum erro inesperado no log do Worker (só os das falhas simuladas)');
console.log('\nFORÇA BRUTA (V2) OK');
