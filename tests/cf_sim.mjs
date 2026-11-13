// Cloudflare simulada para os testes do wrapper (Etapa 6.5-A). Nenhuma rede: a "conta" é um mapa nome -> UUID e a
// resposta de `d1 info` segue o comportamento do wrangler 4.155.0 (identity.mjs): com o UUID no arquivo de configuração,
// devolve o nome REAL daquele UUID na conta; com a configuração sem banco, procura o nome e devolve o UUID real.
// Os IDs abaixo são fictícios e existem só nos testes.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_CONFIG, IDENTITY_CONFIG } from '../tools/db/ops.mjs';

export const IDS = { staging: '11111111-1111-4111-8111-111111111111', rt: '22222222-2222-4222-8222-222222222222', prod: '33333333-3333-4333-8333-333333333333', other: '44444444-4444-4444-8444-444444444444' };
export const PROD = { kind: 'remote', database_name: 'tatame-prod-ficticio', database_id: IDS.prod, protected: true, app_url: 'https://prod.example.test' };
export const ENVS = {
  local: { kind: 'local' },
  staging: { kind: 'remote', database_name: 'tatame-staging', database_id: IDS.staging, app_url: 'https://staging.example.test' },
  'restore-test': { kind: 'remote', database_name: 'tatame-restore-test', database_id: IDS.rt, disposable: true },
  production: PROD
};
// Conta simulada: os três bancos existem com os UUIDs corretos.
export const ACCOUNT = { 'tatame-staging': IDS.staging, 'tatame-restore-test': IDS.rt, 'tatame-prod-ficticio': IDS.prod };

// Configuração isolada coerente com `envs` (o que db/wrangler.migrations.jsonc teria depois de preenchido).
export const migrationsCfg = envs => JSON.stringify({ name: 'x', env: Object.fromEntries(Object.entries(envs).filter(([k, e]) => !k.startsWith('_') && e.kind === 'remote').map(([k, e]) => [k, { d1_databases: [{ binding: 'DB', database_name: e.database_name, database_id: e.database_id, migrations_dir: 'migrations', migrations_table: 'd1_migrations' }] }])) });
export const identityCfg = () => readFileSync(IDENTITY_CONFIG, 'utf8');

// Resposta de `d1 info`, ou null se o comando não é d1 info. `cfgEnvs`: o que o ARQUIVO de configuração diz (pode
// divergir da conta, que é a verdade). `fail`: { status, stderr } para simular autenticação/API indisponível.
export function infoReply(args, { account = ACCOUNT, cfgEnvs = ENVS, fail = null } = {}) {
  if (args[0] !== 'd1' || args[1] !== 'info') return null;
  if (fail) return { status: fail.status ?? 1, stdout: '', stderr: fail.stderr };
  const c = args[args.indexOf('-c') + 1];
  const byUuid = Object.fromEntries(Object.entries(account).map(([n, u]) => [u, n]));
  let uuid, name;
  if (c === MIGRATIONS_CONFIG) { uuid = cfgEnvs[args[args.indexOf('--env') + 1]]?.database_id; name = byUuid[uuid]; }
  else if (c === IDENTITY_CONFIG) { name = args[2]; uuid = account[name]; }
  if (!uuid || !name) return { status: 1, stdout: '', stderr: "✘ [ERROR] Couldn't find DB with name or binding" };
  return { status: 0, stdout: JSON.stringify({ uuid, name, created_at: '2026-11-13T00:00:00Z', version: 'production', num_tables: 0 }, null, 2), stderr: '' };
}

// Diretórios de evidência criados pelos testes: apagados ao fim do processo (só os criados aqui).
const made = [];
process.on('exit', () => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch { /* em uso */ } });
export const evidenceDir = () => { const d = mkdtempSync(join(tmpdir(), 'tatame-evid-')); made.push(d); return d; };
export const readEvidence = dir => readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));

// deps completos para main(): wrangler simulado, evidências num diretório temporário.
export function simDeps({ envs = ENVS, exec, evDir = evidenceDir(), env = {}, tty = false, answer = '', out = [], err = [], cfg = null, fetch } = {}) {
  return { environments: () => envs, migrationsConfigText: () => cfg ?? migrationsCfg(envs), identityConfigText: identityCfg, wranglerVersion: () => '4.155.0', exec, isTTY: () => tty, ask: async () => answer, out: m => out.push(m), err: m => err.push(m), env: { TATAME_EVIDENCE_DIR: evDir, ...env }, fetch };
}

// D1 remoto simulado sobre um arquivo SQLite: --command (consulta devolve linhas; o resto executa) e --file (tudo ou nada,
// como a importação do D1). `calls` recebe cada comando (texto), `files` o conteúdo de cada --file.
export function sqliteRemote(file, { account = ACCOUNT, cfgEnvs = ENVS, calls = [], files = [], hook = null } = {}) {
  return args => {
    const info = infoReply(args, { account, cfgEnvs }); if (info) return info;
    calls.push(args.join(' '));
    if (hook) { const h = hook(args); if (h) return h; }
    const db = new DatabaseSync(file);
    try {
      if (args.includes('--file')) {
        const sql = readFileSync(args[args.indexOf('--file') + 1], 'utf8'); files.push(sql);
        db.exec('BEGIN'); try { db.exec(sql); db.exec('COMMIT'); } catch { db.exec('ROLLBACK'); return { status: 1, stdout: '', stderr: 'falha na importação' }; }
        return { status: 0, stdout: '[]' };
      }
      const sql = args[args.indexOf('--command') + 1];
      const single = !/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''));
      const isQuery = single && /^\s*(SELECT|PRAGMA (integrity_check|foreign_key_check))/i.test(sql);
      return { status: 0, stdout: JSON.stringify([{ results: isQuery ? db.prepare(sql).all() : (db.exec(sql), []), success: true }]) };
    } catch (e) { return { status: 1, stdout: '', stderr: String(e.message) }; }
    finally { db.close(); }
  };
}
