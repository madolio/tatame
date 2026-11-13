// Etapa 6.5-A: tools/staging-check.mjs SEM rede. O "app de staging" é o Worker real em processo sobre um arquivo SQLite;
// o "D1 remoto" é o mesmo arquivo, lido pelo portão do wrapper (identidade simulada em tests/cf_sim.mjs). Prova:
//   1. as travas recusam antes de qualquer requisição (URL de produção, http, PENDENTE, URL por argumento, sem credenciais,
//      sem confirmação, produção como destino) e o fetch global nunca é usado;
//   2. contra o Worker correto, todos os cenários B, C e D passam e a conta de verificação termina administradora;
//   3. contra um app defeituoso (exclusão que apaga histórico), a verificação FALHA (não é só "verde sempre").
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeD1 } from './d1shim.mjs';
import { generateCode, buildSetupSql } from '../tools/setup-token.mjs';
import { main } from '../tools/db/ops.mjs';
import { ENVS, simDeps, sqliteRemote, readEvidence, evidenceDir } from './cf_sim.mjs';

const W = (await import('../web/_worker.js')).default;
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const clone = o => JSON.parse(JSON.stringify(o));
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' '));
const realFetch = globalThis.fetch; let globalFetchUsed = 0;
globalThis.fetch = async () => { globalFetchUsed++; throw new Error('rede proibida neste teste'); };

const tmp = mkdtempSync(join(tmpdir(), 'tatame-stgchk-'));
const EMAIL = 'verificacao@x.test', PASS = 'conta-de-verif-93';
async function app(name) {
  const file = join(tmp, name + '.db');
  const DB = makeD1(file); DB.load(SCHEMA);
  const env = { DB, ASSETS: { fetch: () => new Response('') } };
  let reqs = 0;
  const fetch = async (url, init) => { reqs++; assert.ok(String(url).startsWith('https://staging.example.test/'), 'só a URL de staging configurada'); return W.fetch(new Request(url, init), env); };
  const code = generateCode(); DB.raw.exec(buildSetupSql(code));
  const r = await fetch('https://staging.example.test/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tatame': '1' }, body: JSON.stringify({ academy_name: 'Academia Staging', name: 'Conta Verificacao', email: EMAIL, password: PASS, setup_code: code }) });
  assert.equal(r.status, 201);
  return { file, DB, fetch, reqs: () => reqs };
}
const ARGS = ['staging-check', '--env', 'staging', '--confirm-destination=tatame-staging'];
const CREDS = { TATAME_CHECK_EMAIL: EMAIL, TATAME_CHECK_PASSWORD: PASS };

try {
  // ================= travas: nada de HTTP nem de banco =================
  { const a = await app('travas'); const r0 = a.reqs();
    const calls = [];
    const exec = sqliteRemote(a.file, { calls });
    const refused = async (argv, why, { envs = ENVS, env = CREDS, re = /RECUSADO/ } = {}) => {
      const err = []; const code = await main(argv, simDeps({ envs, exec, env, err, fetch: a.fetch }));
      const pass = code === 3 && re.test(err.join('\n')) && a.reqs() === r0 && calls.length === 0;
      if (!pass) console.log(code, err);
      ok(pass, `recusa sem requisição HTTP nem comando ao banco: ${why}`);
    };
    const e1 = clone(ENVS); e1.staging.app_url = 'https://prod.example.test';
    await refused(ARGS, 'URL do app de staging igual à da produção', { envs: e1, re: /PRODUÇÃO/ });
    const e2 = clone(ENVS); e2.staging.app_url = 'http://staging.example.test';
    await refused(ARGS, 'URL sem https', { envs: e2, re: /https/ });
    const e3 = clone(ENVS); e3.staging.app_url = 'PENDENTE';
    await refused(ARGS, 'URL ainda PENDENTE', { envs: e3, re: /app_url de staging não configurado/ });
    const e4 = clone(ENVS); e4.production.app_url = 'PENDENTE';
    await refused(ARGS, 'URL da produção desconhecida (sem como provar que não é ela)', { envs: e4, re: /production\.app_url/ });
    const e5 = clone(ENVS); e5.staging.app_url = 'https://staging.example.test/caminho?x=1';
    await refused(ARGS, 'URL com caminho ou parâmetros', { envs: e5, re: /só a origem/ });
    await refused([...ARGS, '--url', 'https://outro.example.test'], 'URL por argumento (só a de db/environments.json vale)', { re: /--url/ });
    await refused(ARGS, 'sem credenciais da conta de verificação', { env: {}, re: /TATAME_CHECK_EMAIL/ });
    await refused(['staging-check', '--env', 'staging'], 'sem --confirm-destination', { re: /confirm-destination/ });
    await refused(['staging-check', '--env', 'restore-test', '--confirm-destination=tatame-restore-test'], 'restore-test (só staging)', { re: /só aceita como destino: staging/ });
    await refused(['staging-check', '--env', 'production', '--confirm-production=tatame-prod-ficticio', '--confirm-destination=tatame-prod-ficticio'], 'produção', { re: /só aceita como destino/ });
    const e6 = clone(ENVS); e6.staging.database_id = e6.production.database_id;
    await refused(ARGS, 'banco de staging com o UUID da produção', { envs: e6, re: /PRODUÇÃO/ });
    { const err = []; const ex2 = sqliteRemote(a.file, { calls, account: { 'tatame-staging': '99999999-9999-4999-8999-999999999999' } });
      const code = await main(ARGS, simDeps({ exec: ex2, env: CREDS, err, fetch: a.fetch }));
      ok(code === 3 && a.reqs() === r0 && calls.length === 0, 'identidade do banco reprovada: nenhuma requisição HTTP (o banco é conferido antes do app)'); }
    { const out = []; const code = await main([...ARGS, '--dry-run'], simDeps({ exec, env: CREDS, out, fetch: a.fetch }));
      ok(code === 0 && a.reqs() === r0 && calls.length === 0 && /Nenhuma requisição feita/.test(out.join('\n')), '--dry-run: nenhuma requisição e nenhum comando'); }
    a.DB.raw.close(); }

  // ================= Worker correto: todos os cenários passam =================
  { const a = await app('correto'); const calls = [], out = [], err = [], evDir = evidenceDir();
    const code = await main(ARGS, simDeps({ exec: sqliteRemote(a.file, { calls }), env: CREDS, out, err, evDir, fetch: a.fetch }));
    const txt = out.join('\n');
    if (code !== 0) console.log(txt, err);
    const ids = [...txt.matchAll(/^\s+(ok|FALHOU)\s+(\S+)/gm)].map(m => m[2]);
    ok(code === 0 && !/FALHOU/.test(txt), `contra o Worker correto: todas as ${ids.length} verificações passam`);
    ok(['C1', 'C2', 'C3', 'C4', 'C5', 'C7', 'C8', 'C9', 'D1a', 'D1b', 'D1c', 'D2a', 'D2b', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'B1', 'B2', 'FIM1', 'FIM2'].every(i => ids.includes(i)), 'cobre B (último admin, concorrência), C (auditoria) e D (exclusão de alunos)');
    const raw = new DatabaseSync(a.file);
    const acct = raw.prepare("SELECT role, active FROM staff WHERE email = ?").get(EMAIL);
    const testers = raw.prepare("SELECT count(*) n FROM staff WHERE email LIKE '%@staging-check.test' AND active = 1").get().n;
    raw.close();
    ok(acct.role === 'admin' && acct.active === 1 && testers === 0, 'ao final: conta de verificação administradora e contas de teste desativadas');
    ok(calls.every(c => /--env staging/.test(c) && /--command/.test(c) && !/--file/.test(c)) && calls.every(c => /SELECT|PRAGMA/i.test(c)), 'banco: só consultas de leitura pelo portão, no ambiente conferido');
    const ev = readEvidence(evDir);
    ok(ev.some(e => e.event === 'identidade') && ev.filter(e => e.event === 'cenario').length === ids.length && ev.at(-1).resultado === 'ok', 'evidências: identidade, cada cenário (só id e ok) e resultado');
    const evs = JSON.stringify(ev);
    ok(!evs.includes(PASS) && !evs.includes(EMAIL) && !out.join('\n').includes(PASS), 'credenciais fora da tela e das evidências');
    a.DB.raw.close(); }

  // ================= app defeituoso: a verificação acusa =================
  { const a = await app('defeituoso'); const out = [];
    // defeito simulado: DELETE de aluno apaga o histórico e o aluno direto no banco e responde 200
    const broken = async (url, init) => {
      const m = String(url).match(/\/api\/students\/([0-9a-f-]{36})$/);
      if (m && init?.method === 'DELETE' && !/prof/.test(init.headers?.cookie || '')) {
        for (const t of ['attendance', 'promotions', 'skills', 'skill_history']) a.DB.raw.prepare(`DELETE FROM ${t} WHERE student_id = ?`).run(m[1]);
        a.DB.raw.prepare('DELETE FROM students WHERE id = ?').run(m[1]);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return a.fetch(url, init);
    };
    const code = await main(ARGS, simDeps({ exec: sqliteRemote(a.file), env: CREDS, out, fetch: broken }));
    const txt = out.join('\n');
    ok(code === 4 && /FALHOU\s+D3/.test(txt) && /FALHOU\s+D4/.test(txt) && /\[staging-check\] FALHOU/.test(txt), 'app que apaga histórico: D3/D4 reprovados e código de saída 4');
    a.DB.raw.close(); }

  ok(globalFetchUsed === 0, 'o fetch global (rede) nunca foi chamado');
  console.log('\nSTAGING-CHECK OK');
} finally {
  globalThis.fetch = realFetch; console.error = oe;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: SQLite ainda aberto após falha */ }
}
