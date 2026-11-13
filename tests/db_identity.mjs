// Etapa 6.5-A: identidade do banco na Cloudflare, bloqueio da produção por UUID, operações protegidas (sql,
// timetravel-restore), registro de evidências e ausência de caminhos fora do wrapper. Tudo com a Cloudflare SIMULADA
// (tests/cf_sim.mjs): nenhum teste acessa rede. Cada recusa prova que nenhum comando de OPERAÇÃO chegou ao wrangler.
import assert from 'node:assert';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, OPS, ROOT, assertGated, registerOp, MIGRATIONS_CONFIG, IDENTITY_CONFIG } from '../tools/db/ops.mjs';
import { runWrangler, assertAllowedCommand } from '../tools/db/wrangler.mjs';
import { classifyFailure, verifyIdentity, checkMigrationsConfig } from '../tools/db/identity.mjs';
import { IDS, ENVS, PROD, ACCOUNT, infoReply, migrationsCfg, simDeps, evidenceDir, readEvidence } from './cf_sim.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const clone = o => JSON.parse(JSON.stringify(o));
const BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';

// Executor simulado: identidade pela conta simulada; o resto responde como um D1 vazio (ou como `reply`).
function harness({ envs = ENVS, cfgEnvs = envs, account = ACCOUNT, infoFail = null, reply = null, tty = false, answer = '', env = {}, evDir = evidenceDir(), cfg = null } = {}) {
  const calls = [], out = [], err = [];
  const exec = args => {
    calls.push(args.map(String));
    const i = infoReply(args, { account, cfgEnvs, fail: infoFail }); if (i) return i;
    if (reply) { const r = reply(args); if (r) return r; }
    if (args[1] === 'time-travel') return { status: 0, stdout: JSON.stringify(args[2] === 'restore' ? { bookmark: BOOKMARK, previous_bookmark: '00000085-0000024c-00004c6d-0000000000000000000000000000000a' } : { bookmark: BOOKMARK }) };
    return { status: 0, stdout: JSON.stringify([{ results: [], success: true }]) };
  };
  const deps = simDeps({ envs, exec, evDir, env, tty, answer, out, err, cfg: cfg ?? migrationsCfg(cfgEnvs) });
  const ops = () => calls.filter(a => a[1] !== 'info');
  return { calls, ops, out, err, evDir, run: argv => main(argv, deps) };
}
const refusal = async (argv, why, opt = {}, re = /RECUSADO/) => {
  const h = harness(opt); const code = await h.run(argv);
  const pass = code === 3 && h.ops().length === 0 && re.test(h.err.join('\n'));
  if (!pass) console.log(code, h.err, h.ops());
  ok(pass, `recusado sem nenhum comando de operação: ${why}`);
  return h;
};
const TT = ['timetravel-info'];

// ================= identidade correta =================
{ const h = harness(); const code = await h.run([...TT, '--env', 'staging']);
  const ev = readEvidence(h.evDir);
  ok(code === 0 && h.calls.length === 3 && h.calls[0][1] === 'info' && h.calls[1][1] === 'info' && h.calls[2].join(' ').startsWith('d1 time-travel info tatame-staging'), 'ID de staging correto: duas consultas de identidade e depois a operação');
  ok(h.calls[0].includes(MIGRATIONS_CONFIG) && h.calls[0].includes('staging') && h.calls[1].includes(IDENTITY_CONFIG) && !h.calls[1].includes('--env'), 'identidade: uma consulta pelo UUID do arquivo (-c migrations --env) e uma pelo nome (configuração sem banco)');
  ok(/identidade conferida na Cloudflare: tatame-staging \| 11111111…/.test(h.out.join('\n')), 'identidade conferida aparece na tela (UUID abreviado)');
  const idEv = ev.find(e => e.event === 'identidade');
  ok(idEv && idEv.uuid === IDS.staging && idEv.nome === 'tatame-staging' && ev.at(-1).event === 'fim' && ev.at(-1).resultado === 'ok', 'evidência: identidade com UUID completo e fim ok'); }
{ const h = harness(); const code = await h.run(['identify', '--env', 'restore-test']);
  ok(code === 0 && h.ops().length === 0 && /restore-test: nome tatame-restore-test \| UUID 22222222… \| igual aos dois arquivos de configuração \| diferente da produção/.test(h.out.join('\n')), 'ID de restore-test correto: identify confere e não executa nada além das consultas'); }

// ================= produção no lugar de staging/restore-test =================
{ const envs = clone(ENVS); envs.staging.database_id = IDS.prod;
  await refusal([...TT, '--env', 'staging'], 'UUID da produção configurado como staging (sem rede)', { envs }, /é o da PRODUÇÃO/);
  const envs2 = clone(ENVS); envs2['restore-test'].database_id = IDS.prod;
  const h = await refusal(['sql', '--env', 'restore-test', '--confirm-destination=tatame-restore-test', '--command', 'DELETE FROM students'], 'UUID da produção configurado como restore-test (sem rede)', { envs: envs2 }, /é o da PRODUÇÃO/);
  ok(h.calls.length === 0, 'recusa por UUID da produção acontece antes de qualquer consulta à Cloudflare'); }
{ // Produção configurada com UUID ERRADO em environments.json e o staging apontando para o UUID que, na conta, é a produção real:
  // a lista estática não pega; a Cloudflare devolve o nome da produção pelo UUID e a operação é recusada.
  const envs = clone(ENVS); envs.production.database_id = IDS.other; envs.staging.database_id = IDS.prod;
  const h = await refusal(['sql', '--env', 'staging', '--confirm-destination=tatame-staging', '--command', 'DELETE FROM students'], 'staging aponta para um UUID que a Cloudflare identifica como a produção', { envs }, /PRODUÇÃO/);
  ok(h.calls.length === 1 && h.calls[0][1] === 'info', 'parou na primeira consulta de identidade'); }
{ const envs = clone(ENVS); envs.production.database_id = IDS.other; envs['restore-test'].database_id = IDS.prod;
  await refusal(['timetravel-restore', '--env', 'restore-test', '--confirm-destination=tatame-restore-test', `--bookmark=${BOOKMARK}`], 'restore-test aponta para o UUID real da produção (Time Travel)', { envs, tty: true, answer: 'tatame-restore-test' }, /PRODUÇÃO/); }
{ const envs = clone(ENVS); envs.production.database_name = 'PENDENTE'; envs.production.database_id = 'PENDENTE';
  await refusal([...TT, '--env', 'staging'], 'produção ainda PENDENTE: sem UUID da produção, nenhuma operação remota', { envs }, /nome e o UUID reais da produção/); }
{ const envs = clone(ENVS); envs['restore-test'].database_id = IDS.staging;
  await refusal([...TT, '--env', 'staging'], 'dois ambientes com o mesmo UUID', { envs }, /mesmo database_id/); }

// ================= arquivos divergentes =================
{ const cfgEnvs = clone(ENVS); cfgEnvs.staging.database_id = IDS.other;
  await refusal([...TT, '--env', 'staging'], 'IDs divergentes entre db/environments.json e db/wrangler.migrations.jsonc', { cfgEnvs }, /nome\/ID diferentes/); }
{ const h = harness(); const deps = simDeps({ exec: () => { throw new Error('nada deveria rodar'); }, err: h.err, out: h.out });
  deps.identityConfigText = () => JSON.stringify({ name: 'x', d1_databases: [{ binding: 'DB', database_name: 'tatame-staging', database_id: IDS.staging }] });
  const code = await main([...TT, '--env', 'staging'], deps);
  ok(code === 3 && /identity\.jsonc não pode declarar bancos/.test(h.err.join('\n')), 'db/wrangler.identity.jsonc com banco declarado: recusado (a consulta por nome perderia o sentido)'); }

// ================= nome certo, UUID errado =================
{ const envs = clone(ENVS); envs.staging.database_id = IDS.other;
  await refusal([...TT, '--env', 'staging'], 'nome certo com UUID inexistente na conta', { envs }, /banco não encontrado/); }
{ const envs = clone(ENVS), account = { ...ACCOUNT, 'tatame-staging-velho': IDS.other }; envs.staging.database_id = IDS.other;
  await refusal([...TT, '--env', 'staging'], 'nome certo com UUID de OUTRO banco da conta', { envs, account }, /pertence a outro banco/); }
{ const account = { ...ACCOUNT, 'tatame-staging': IDS.other, 'tatame-staging-antigo': IDS.staging };
  await refusal([...TT, '--env', 'staging'], 'banco recriado: o UUID configurado agora é de outro banco e o nome tem outro UUID', { account }, /pertence a outro banco|tem outro UUID/); }

// ================= Cloudflare indisponível / autenticação =================
await refusal([...TT, '--env', 'staging'], 'API da Cloudflare indisponível', { infoFail: { status: 1, stderr: 'TypeError: fetch failed ENOTFOUND api.cloudflare.com' } }, /API da Cloudflare indisponível/);
await refusal([...TT, '--env', 'staging'], 'falha de autenticação', { infoFail: { status: 1, stderr: '✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]' } }, /falha de autenticação/);
await refusal([...TT, '--env', 'staging'], 'wrangler sem login', { infoFail: { status: 1, stderr: 'You are not logged in. Run wrangler login' } }, /falha de autenticação/);
await refusal([...TT, '--env', 'staging'], 'resposta ilegível da Cloudflare', { reply: null, infoFail: { status: 0, stderr: '' } }, /ilegível/);
ok(classifyFailure({ stderr: 'Internal Server Error 503' }) === 'API da Cloudflare indisponível' && classifyFailure({ stderr: 'Invalid access token [code: 9109]' }) === 'falha de autenticação na Cloudflare', 'classificação das falhas');

// ================= operações destrutivas sem confirmação =================
const SQLS = ['--command', 'DELETE FROM students'];
await refusal(['sql', '--env', 'staging', ...SQLS], 'sql sem --confirm-destination', {}, /--confirm-destination=tatame-staging/);
await refusal(['sql', '--env', 'staging', '--confirm-destination=tatame-restore-test', ...SQLS], 'sql com o nome de outro banco em --confirm-destination');
await refusal(['sql', '--env', 'production', '--confirm-production=tatame-prod-ficticio', '--confirm-destination=tatame-prod-ficticio', ...SQLS], 'sql na produção (mesmo com as duas confirmações)', { tty: true, answer: 'tatame-prod-ficticio' }, /só aceita como destino/);
await refusal(['sql', '--env', 'staging', '--confirm-destination=tatame-staging'], 'sql sem --file nem --command', {}, /exatamente um/);
await refusal(['import', '--env', 'restore-test', '--file', 'x.tbk'], 'import sem --confirm-destination', {}, /confirm-destination/);
await refusal(['timetravel-restore', '--env', 'restore-test', `--bookmark=${BOOKMARK}`], 'timetravel-restore sem --confirm-destination', { tty: true, answer: 'tatame-restore-test' }, /confirm-destination/);
await refusal(['timetravel-restore', '--env', 'restore-test', '--confirm-destination=tatame-restore-test'], 'timetravel-restore sem ponto de restauração', { tty: true }, /exatamente um/);
await refusal(['timetravel-restore', '--env', 'restore-test', '--confirm-destination=tatame-restore-test', '--bookmark=abc'], 'timetravel-restore com bookmark inválido', { tty: true }, /formato inválido/);
await refusal(['timetravel-restore', '--env', 'restore-test', '--confirm-destination=tatame-restore-test', `--bookmark=${BOOKMARK}`], 'timetravel-restore sem terminal interativo', { tty: false }, /terminal interativo/);
{ const h = harness({ tty: true, answer: 'tatame-staging' });
  const code = await h.run(['timetravel-restore', '--env', 'restore-test', '--confirm-destination=tatame-restore-test', `--bookmark=${BOOKMARK}`]);
  ok(code === 3 && !h.calls.some(a => a[2] === 'restore'), 'timetravel-restore com o nome redigitado errado: identidade e consulta do bookmark atual, mas NENHUMA restauração'); }

// ================= restauração em produção =================
await refusal(['timetravel-restore', '--env', 'production', '--confirm-production=tatame-prod-ficticio', '--confirm-destination=tatame-prod-ficticio', `--bookmark=${BOOKMARK}`], 'Time Travel na produção, mesmo com todas as confirmações', { tty: true, answer: 'tatame-prod-ficticio' }, /só aceita como destino/);
await refusal(['restore-test', '--env', 'production', '--confirm-production=tatame-prod-ficticio', '--confirm-destination=tatame-prod-ficticio'], 'restore-test com produção como destino', { tty: true, answer: 'tatame-prod-ficticio' }, /só aceita como destino/);
ok(['sql', 'timetravel-restore', 'import', 'restore-test', 'setup-code', 'reset-code', 'staging-check'].every(op => OPS[op].dest && !OPS[op].dest.includes('production')), 'nenhuma operação de escrita protegida aceita produção como destino');

// ================= caminhos permitidos (com registro) =================
{ const h = harness({ tty: true, answer: 'tatame-restore-test' });
  const code = await h.run(['timetravel-restore', '--env', 'restore-test', '--confirm-destination=tatame-restore-test', `--bookmark=${BOOKMARK}`]);
  const r = h.calls.find(a => a[2] === 'restore'), ev = readEvidence(h.evDir);
  ok(code === 0 && r && r.includes('--bookmark') && r.includes(BOOKMARK) && r.includes(MIGRATIONS_CONFIG) && r.includes('restore-test') && r.includes('--json'), 'timetravel-restore: com identidade, destino, TTY e nome redigitado, restaura pelo bookmark com a configuração isolada');
  ok(ev.filter(e => e.event === 'time_travel').length === 2 && ev.filter(e => e.event === 'schema').map(e => e.momento).join() === 'antes,depois', 'evidência: bookmark antes/depois e impressão digital do schema antes e depois'); }
{ const dir = mkdtempSync(join(tmpdir(), 'tatame-sql-')); const f = join(dir, 'teste.sql'); writeFileSync(f, 'CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  const h = harness(); const code = await h.run(['sql', '--env', 'staging', '--confirm-destination=tatame-staging', '--file', f]);
  const op = h.ops().find(a => a.includes('--file'));
  ok(code === 0 && op && op.includes('--remote') && op.includes('--yes') && op.includes('staging'), 'sql --file: executa no staging conferido');
  const ev = readEvidence(h.evDir), cmd = ev.find(e => e.event === 'comando' && e.tipo === 'operacao');
  ok(cmd && cmd.comando.some(x => /arquivo teste\.sql, sha256 [0-9a-f]{16}/.test(x)) && !JSON.stringify(ev).includes('CREATE TABLE t'), 'evidência: arquivo registrado por nome e SHA-256, sem o conteúdo SQL');
  rmSync(dir, { recursive: true, force: true }); }
{ const h = harness({ reply: a => a.includes('--command') && /students/.test(a.at(-1)) ? { status: 1, stdout: '', stderr: 'D1_ERROR: no such table: students' } : null });
  const code = await h.run(['sql', '--env', 'staging', '--confirm-destination=tatame-staging', '--command', "DELETE FROM students WHERE name = 'Fulana Secreta'"]);
  const ev = readEvidence(h.evDir);
  ok(code === 1 && ev.at(-1).event === 'fim' && ev.at(-1).resultado === 'erro' && ev.some(e => e.event === 'schema' && e.momento === 'depois'), 'sql que falha: erro registrado e schema lido depois mesmo assim');
  ok(!JSON.stringify(ev).includes('Fulana') && !JSON.stringify(ev).includes('no such table'), 'evidência sem o SQL e sem a saída do wrangler'); }
{ const h = harness(); const code = await h.run(['sql', '--env', 'staging', '--confirm-destination=tatame-staging', '--command', 'SELECT 1', '--dry-run']);
  ok(code === 0 && h.calls.length === 0, '--dry-run: nada executado, nem a identidade'); }

// ================= evidências obrigatórias =================
{ const h = harness({ evDir: '' }); const code = await h.run([...TT, '--env', 'staging']);
  ok(code === 3 && h.calls.length === 0 && /TATAME_EVIDENCE_DIR não está definido/.test(h.err.join('\n')), 'sem TATAME_EVIDENCE_DIR: operação remota recusada sem nenhuma consulta'); }
{ const h = harness({ evDir: join(ROOT, 'db') }); const code = await h.run([...TT, '--env', 'staging']);
  ok(code === 3 && h.calls.length === 0 && /dentro do repositório/.test(h.err.join('\n')), 'TATAME_EVIDENCE_DIR dentro do repositório: recusado'); }
{ const h = harness({ evDir: 'C:\\Users\\x\\OneDrive\\evid' }); const code = await h.run([...TT, '--env', 'staging']);
  ok(code === 3 && h.calls.length === 0, 'TATAME_EVIDENCE_DIR no OneDrive (ou inexistente): recusado'); }
{ const h = harness({ infoFail: { status: 1, stderr: 'Authentication error [code: 10000]' } }); await h.run([...TT, '--env', 'staging']);
  const ev = readEvidence(h.evDir);
  ok(ev.at(-1).event === 'fim' && ev.at(-1).resultado === 'recusado' && ev.filter(e => e.event === 'comando').every(e => e.tipo === 'identidade' && e.falha === 'falha de autenticação na Cloudflare'), 'recusa por identidade também fica registrada (com a classificação da falha)'); }

// ================= fora do wrapper =================
for (const [args, why] of [
  [['d1', 'execute', 'tatame-staging', '--remote', '--command', 'DELETE FROM students'], 'sem -c (resolveria o banco pelo nome ou por um wrangler.toml)'],
  [['d1', 'execute', 'tatame-staging', '--remote', '-c', join(ROOT, 'wrangler.toml'), '--command', 'SELECT 1'], 'com outra configuração'],
  [['d1', 'execute', 'tatame-staging', '--local', '-c', MIGRATIONS_CONFIG, '--env', 'staging', '--command', 'SELECT 1'], '--local'],
  [['d1', 'delete', 'tatame-staging', '-c', MIGRATIONS_CONFIG, '--env', 'staging'], 'd1 delete'],
  [['d1', 'create', 'tatame-x', '-c', MIGRATIONS_CONFIG], 'd1 create'],
  [['pages', 'deploy', 'web'], 'pages deploy'],
  [['d1', 'execute', 'tatame-staging', '-c', MIGRATIONS_CONFIG, '--config', IDENTITY_CONFIG, '--command', 'SELECT 1'], 'duas configurações']
]) { let e = null; try { runWrangler(args); } catch (x) { e = x; } ok(e && /bloqueado/.test(e.message), `executor real do wrangler recusa antes de iniciar o processo: ${why}`); }
assertAllowedCommand(['d1', 'info', 'tatame-staging', '-c', IDENTITY_CONFIG, '--json']); ok(true, 'executor real aceita a consulta de identidade');
{ const t = { name: 'staging', database_name: 'tatame-staging' }, bad = [];
  for (const a of [['d1', 'execute', 'tatame-restore-test', '--remote', '-c', MIGRATIONS_CONFIG, '--env', 'staging', '--command', 'x'], ['d1', 'execute', 'tatame-staging', '--remote', '-c', MIGRATIONS_CONFIG, '--env', 'restore-test', '--command', 'x'], ['d1', 'execute', 'tatame-staging', '--remote', '-c', MIGRATIONS_CONFIG, '--command', 'x'], ['d1', 'time-travel', 'restore', 'tatame-staging', '-c', MIGRATIONS_CONFIG, '--env', 'staging', '--account-id', 'x']])
    try { assertGated(a, t); bad.push(a); } catch { /* recusado */ }
  ok(bad.length === 0, 'portão do wrapper: outro banco, outro ambiente, sem --env e --account-id são recusados'); }
{ // integração: uma operação que tentasse um comando fora do padrão é barrada no portão de main (antes da identidade)
  OPS.__teste = { remote: 'read', desc: 'só no teste' };
  const tries = [['d1', 'execute', 'tatame-staging', '--remote', '--command', 'SELECT 1'], ['d1', 'execute', 'tatame-restore-test', '--remote', '-c', MIGRATIONS_CONFIG, '--env', 'staging', '--command', 'SELECT 1'], ['d1', 'delete', 'tatame-staging', '-c', MIGRATIONS_CONFIG, '--env', 'staging']];
  for (const args of tries) {
    registerOp('__teste', ctx => { ctx.wrangler(args); return 0; });
    const h = harness(); const code = await h.run(['__teste', '--env', 'staging']);
    ok(code === 3 && h.calls.length === 0 && /bloqueado|não permitido/.test(h.err.join('\n')), `portão de main recusa sem chamar nada: ${args.slice(0, 3).join(' ')}${args.includes('-c') ? '' : ' sem -c'}`);
  }
  delete OPS.__teste; }
{ // varredura estática: só o núcleo do wrapper executa o wrangler; nada usa npx wrangler; ferramentas não chamam o wrangler direto
  const files = []; const walk = d => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(mjs|js|json)$/.test(f.name)) files.push(p); } };
  walk(join(ROOT, 'tools')); walk(join(ROOT, 'tests')); files.push(join(ROOT, 'package.json'));
  const rel = p => p.slice(ROOT.length).replace(/\\/g, '/');
  const offenders = files.filter(p => !['tools/db/wrangler.mjs', 'tools/db/cli.mjs', 'tests/db_identity.mjs'].includes(rel(p))).filter(p => { const s = readFileSync(p, 'utf8'); return /runWrangler|WRANGLER_JS|wrangler\/bin\/wrangler|npx\s+wrangler|spawnSync\([^)]*wrangler|execFileSync\([^)]*wrangler/.test(s); });
  ok(offenders.length === 0, `nenhum arquivo além do núcleo do wrapper executa o wrangler (${offenders.map(rel).join(', ') || 'nenhum'})`);
  ok(!/wrangler/.test(JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts)), 'nenhum script do package.json chama o wrangler');
  ok(['tools/setup-code.mjs', 'tools/reset-code.mjs'].every(f => !/import .*wrangler/.test(readFileSync(join(ROOT, f), 'utf8'))), 'setup-code e reset-code não importam o executor do wrangler: passam pelo wrapper'); }

// ================= nenhum vazamento de credenciais =================
{ const SECRET = 'cfut_SEGREDO_abcdef0123456789', PASS = 'senha-do-staging-77';
  const h = harness({ env: { CLOUDFLARE_API_TOKEN: SECRET, TATAME_CHECK_PASSWORD: PASS },
    reply: a => a.includes('--command') && a.at(-1).includes('falhe') ? { status: 1, stdout: '', stderr: `erro com Authorization: Bearer ${SECRET} e CLOUDFLARE_API_TOKEN=${SECRET} ${PASS}` } : (a.includes('--command') && a.at(-1).includes('eco') ? { status: 0, stdout: JSON.stringify([{ results: [{ v: SECRET }], success: true }]) } : null) });
  await h.run(['sql', '--env', 'staging', '--confirm-destination=tatame-staging', '--command', "SELECT 'falhe'"]);
  await h.run(['sql', '--env', 'staging', '--confirm-destination=tatame-staging', '--command', "SELECT 'eco'"]);
  const all = h.out.concat(h.err).join('\n') + JSON.stringify(readEvidence(h.evDir));
  ok(!all.includes(SECRET) && !all.includes(PASS) && /segredo omitido/.test(all), 'token e senha do ambiente não aparecem na tela, nos erros nem nas evidências');
  ok(!readdirSync(h.evDir).some(f => readFileSync(join(h.evDir, f), 'utf8').includes('SELECT')), 'evidências sem texto de SQL'); }
ok(!existsSync(join(ROOT, 'wrangler.toml')) && !existsSync(join(ROOT, 'web', 'wrangler.toml')), 'nenhuma configuração do wrangler na raiz nem em web/');
{ // IDs reais informados pelo usuário a partir do painel (6.5-B, bloco A). Qualquer alteração acidental quebra este teste.
  const real = JSON.parse(readFileSync(join(ROOT, 'db/environments.json'), 'utf8'));
  const got = ['staging', 'restore-test', 'production'].map(e => `${real[e].database_name}=${real[e].database_id}`).join(' ');
  ok(got === 'tatame-staging=463bb48d-d3a8-4805-b188-8071b5d9079a tatame-restore-test=1f76de57-d036-4586-bcd6-c83ab70ad01e tatame-db=3b3cbeec-5eda-41c6-99e0-2b748e632dc5', 'db/environments.json do repositório tem exatamente os nomes e UUIDs reais informados (nenhum inventado)');
  ok(real.production.protected === true && real['restore-test'].disposable === true && real.staging.app_url === 'PENDENTE', 'produção continua protegida, restore-test descartável e app_url de staging ainda PENDENTE');
  ok(checkMigrationsConfig(real, readFileSync(MIGRATIONS_CONFIG, 'utf8')).length === 0, 'db/wrangler.migrations.jsonc do repositório coincide com db/environments.json'); }
{ // consulta pelo nome devolvendo outro UUID (conta inconsistente/corrida): a segunda conferência recusa
  const t = { name: 'staging', database_name: 'tatame-staging', database_id: IDS.staging };
  const mk = byName => a => ({ status: 0, stdout: JSON.stringify(a.includes(IDENTITY_CONFIG) ? byName : { uuid: IDS.staging, name: 'tatame-staging' }) });
  const base = { migrationsConfig: MIGRATIONS_CONFIG, prodId: IDS.prod, prodName: PROD.database_name };
  assert.throws(() => verifyIdentity(t, ENVS, { run: mk({ uuid: IDS.other, name: 'tatame-staging' }), ...base }), /tem outro UUID/);
  assert.throws(() => verifyIdentity(t, ENVS, { run: mk({ uuid: IDS.prod, name: 'tatame-staging' }), ...base }), /PRODUÇÃO/);
  assert.throws(() => verifyIdentity(t, ENVS, { run: () => { throw new Error('spawn falhou'); }, ...base }), /não pôde ser concluída/);
  ok(verifyIdentity(t, ENVS, { run: mk({ uuid: IDS.staging, name: 'tatame-staging' }), ...base }).uuid === IDS.staging, 'segunda conferência (pelo nome): UUID diferente do configurado ou da produção, ou wrangler que nem inicia, é recusado'); }
console.log('\nIDENTIDADE E EVIDÊNCIAS OK');
