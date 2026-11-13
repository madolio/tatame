// Núcleo do wrapper de banco: seleção de ambiente, travas contra produção e despacho das operações.
// Tudo que toca o mundo externo (executar o wrangler, ler o terminal, imprimir) vem em `deps`, para os testes
// provarem que nenhuma trava deixa passar um comando. Princípio: na dúvida, recusar (falha segura).
//
// Etapa 6.5-A: antes do PRIMEIRO comando remoto de cada execução, a identidade do banco é conferida na Cloudflare
// (tools/db/identity.mjs: nome e UUID reais, pelo UUID do arquivo e pelo nome na conta, nunca o da produção quando o
// destino não é a produção). Toda operação remota real é registrada em TATAME_EVIDENCE_DIR (tools/db/evidence.mjs).
// Todo comando passa pelo portão `wrangler()`, que só aceita comandos d1 com a configuração isolada e o ambiente conferido.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runWrangler, wranglerVersion } from './wrangler.mjs';
import { redact } from '../backup/tempspace.mjs';
import { staticIdentityChecks, verifyIdentity, IDENTITY_CONFIG, classifyFailure, short } from './identity.mjs';
import { openEvidence, scrubber, describeCommand } from './evidence.mjs';
import { SCHEMA_QUERY, MIGRATIONS_TABLE, fingerprint, fingerprintHash } from './schema.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ENV_FILE = ROOT + 'db/environments.json';
export const MIGRATIONS_CONFIG = ROOT + 'db/wrangler.migrations.jsonc';
export { IDENTITY_CONFIG };

export class GuardError extends Error { constructor(msg) { super(msg); this.name = 'GuardError'; } }
const refuse = msg => { throw new GuardError(msg); };

// Operações e o que cada uma pode fazer.
//   remote: 'read' | 'write' (acessa um D1 remoto); local: aceita --env local (arquivo SQLite); offline: não usa banco.
//   dest: ambientes aceitos como destino (nenhuma operação de destino aceita produção).
//   confirmDestination: exige --confirm-destination=<nome exato do banco> antes de qualquer coisa.
export const OPS = {
  identify: { remote: 'read', desc: 'confere na Cloudflare o nome e o UUID reais do banco do ambiente (somente leitura)' },
  'timetravel-info': { remote: 'read', desc: 'mostra o bookmark atual do Time Travel (somente leitura)' },
  check: { remote: 'read', local: true, desc: 'compara o schema real com o esperado e roda integrity_check/foreign_key_check' },
  baseline: { remote: 'read', local: true, desc: 'compara o schema real com o de 17f1fbd (linha de base), sem registrar nada' },
  'baseline-register': { remote: 'write', local: true, desc: 'registra 000_base como aplicada, somente se a linha de base for idêntica' },
  migrate: { remote: 'write', local: true, desc: 'aplica as migrações pendentes, com verificação antes e depois' },
  export: { remote: 'read', desc: 'exporta o banco para o armazenamento de backups, com manifesto' },
  verify: { offline: true, desc: 'verifica um backup: hash, import em SQLite temporário, integridade, contagens e schema' },
  anonymize: { offline: true, desc: 'gera uma cópia anonimizada de um backup (para staging)' },
  import: { remote: 'write', dest: ['staging', 'restore-test'], confirmDestination: true, desc: 'importa um backup verificado em staging ou restore-test' },
  'restore-test': { remote: 'write', dest: ['restore-test'], confirmDestination: true, desc: 'importa no restore-test e valida o banco restaurado com o Worker' },
  sql: { remote: 'write', dest: ['staging', 'restore-test'], confirmDestination: true, desc: 'executa SQL (--file ou --command) em staging ou restore-test, com identidade conferida e registro' },
  'timetravel-restore': { remote: 'write', dest: ['staging', 'restore-test'], confirmDestination: true, desc: 'restaura staging ou restore-test por Time Travel (--bookmark ou --timestamp), com terminal interativo' },
  'setup-code': { remote: 'write', local: true, dest: ['staging', 'restore-test'], desc: 'gera o código de ativação (primeiro acesso) de staging/restore-test ou de um SQLite local' },
  'reset-code': { remote: 'write', local: true, dest: ['staging', 'restore-test'], desc: 'gera um código de recuperação de senha em staging/restore-test ou num SQLite local' },
  'staging-check': { remote: 'write', dest: ['staging'], confirmDestination: true, desc: 'cenários de integridade administrativa, auditoria e exclusão de alunos por HTTP contra o app de staging' },
  'key-generate': { offline: true, desc: 'gera uma chave de backup nova num arquivo (fora do repositório e do OneDrive), sem exibi-la' },
  'key-check': { offline: true, desc: 'confere a chave configurada (id) e se ela abre um backup (--backup/--file) ou quais abre (--all)' },
  'key-verify-copy': { offline: true, desc: 'confere se a cópia de segurança da chave (--copy) é idêntica à chave configurada' },
  'temp-clean': { offline: true, desc: 'lista (ou, com --remove, apaga) áreas temporárias abandonadas por operações interrompidas' }
};
const handlers = {};
export const registerOp = (name, fn) => { handlers[name] = fn; };

const PENDING = v => !v || /PENDENTE/i.test(String(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('=');
    const k = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    if (eq > 0) o[k] = a.slice(eq + 1);
    else if (['dry-run', 'replace', 'remove', 'all', 'remote', 'local'].includes(k)) o[k] = true;
    else o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

export function loadEnvironments(file = ENV_FILE) { return JSON.parse(readFileSync(file, 'utf8')); }

// Argumentos comuns do wrangler para o alvo remoto: configuração isolada (-c) e o ambiente dela (--env).
export const configArgs = target => ['-c', MIGRATIONS_CONFIG, '--env', target.name];
export const remoteArgs = target => ['--remote', ...configArgs(target)];

// Saída de `wrangler d1 execute --json`: [{ results: [...], success, meta }, ...]. Junta os results.
export function rowsFromWranglerJson(stdout) {
  const j = JSON.parse(stdout);
  const arr = Array.isArray(j) ? j : [j];
  if (arr.some(x => x && x.success === false)) throw new Error('O D1 informou falha na consulta.');
  return arr.flatMap(x => (x && Array.isArray(x.results)) ? x.results : []);
}

// Resolve e valida o ambiente para a operação. Lança GuardError em qualquer dúvida; não chama nada externo.
export function resolveTarget(op, opts, envs) {
  const meta = OPS[op];
  if (!meta) refuse(`Operação desconhecida: ${op || '(nenhuma)'}. Operações: ${Object.keys(OPS).join(', ')}.`);
  // Nome livre de banco nunca é alternativa ao ambiente: o banco vem só de db/environments.json.
  for (const k of ['db', 'database', 'remote', 'local', 'config', 'c', 'persist-to'])
    if (opts[k] !== undefined) refuse(`--${k} não é aceito: o banco é escolhido só por --env <ambiente> (db/environments.json), conferido pela identidade na Cloudflare.`);
  if (meta.offline) return { name: null, offline: true };
  if (opts.env === undefined || opts.env === true || opts.env === '') refuse('Informe o ambiente com --env <local|staging|restore-test|production>. Não existe ambiente padrão.');
  const name = String(opts.env);
  if (name.startsWith('_') || !Object.prototype.hasOwnProperty.call(envs, name)) refuse(`Ambiente desconhecido: ${name}.`);
  const env = envs[name];
  if (env.kind === 'local') {
    if (!meta.local) refuse(`A operação ${op} é remota e não pode usar o ambiente local.`);
    if (!opts.sqlite || opts.sqlite === true) refuse('Com --env local, informe o arquivo com --sqlite <arquivo>.');
    return { name, kind: 'local', sqlite: String(opts.sqlite), env };
  }
  if (env.kind !== 'remote') refuse(`Ambiente ${name} mal configurado (kind).`);
  if (meta.dest && !meta.dest.includes(name)) refuse(`${op} só aceita como destino: ${meta.dest.join(', ')}. ${name === 'production' ? 'Produção nunca é destino desta operação.' : ''}`.trim());
  if (PENDING(env.database_name) || !NAME.test(env.database_name)) refuse(`Ambiente ${name} sem nome de banco válido em db/environments.json (está "${env.database_name}"). Preencha depois de criar o banco.`);
  if (PENDING(env.database_id) || !UUID.test(env.database_id)) refuse(`Ambiente ${name} sem database_id válido em db/environments.json. Preencha com o ID real (wrangler d1 info ${env.database_name}).`);
  if (meta.confirmDestination && opts['confirm-destination'] !== env.database_name) refuse(`${op} exige --confirm-destination=${env.database_name} (nome exato do banco de destino). Nada foi executado.`);
  const isProd = name === 'production' || env.protected === true;
  if (isProd) {
    const c = opts['confirm-production'];
    if (c === undefined || c === true) refuse(`Produção exige --confirm-production=<nome exato do banco>.`);
    if (String(c) !== env.database_name) refuse('O nome informado em --confirm-production não confere com o banco de produção. Nada foi executado.');
  }
  return { name, kind: 'remote', env, isProd, database_name: env.database_name, database_id: env.database_id };
}

export function banner(op, target, version, extra = '') {
  if (target.offline) return `[tatame-db] operação: ${op} (offline, sem banco)${extra}`;
  if (target.kind === 'local') return `[tatame-db] ambiente: local | arquivo: ${target.sqlite} | operação: ${op}${extra}`;
  return `[tatame-db] ambiente: ${target.name}${target.isProd ? ' (PRODUÇÃO)' : ''} | banco: ${target.database_name} | id: ${target.database_id.slice(0, 8)}… | wrangler ${version} | operação: ${op}${extra}`;
}

// Confirmação interativa de produção: exige terminal e que o nome seja digitado de novo.
async function confirmProduction(target, deps) {
  if (!deps.isTTY()) refuse('Produção exige terminal interativo (TTY). Execução não interativa recusada.');
  const typed = (await deps.ask(`Digite o nome do banco de PRODUÇÃO para continuar (${target.database_name}): `) || '').trim();
  if (typed !== target.database_name) refuse('Nome digitado não confere. Nada foi executado.');
}

// Portão: só comandos d1 conhecidos, sempre com a configuração isolada, o ambiente do alvo e o nome do banco do alvo.
const ALLOWED = { execute: true, export: true, info: true, migrations: ['apply'], 'time-travel': ['info', 'restore'] };
export function assertGated(args, target) {
  const a = args.map(String);
  if (a[0] !== 'd1' || !ALLOWED[a[1]] || (Array.isArray(ALLOWED[a[1]]) && !ALLOWED[a[1]].includes(a[2]))) refuse(`Comando não permitido pelo wrapper: ${a.slice(0, 3).join(' ')}.`);
  const count = flags => a.filter(x => flags.includes(x) || flags.some(f => x.startsWith(f + '='))).length;
  if (count(['-c', '--config']) !== 1 || a[a.indexOf('-c') + 1] !== MIGRATIONS_CONFIG) refuse('Comando sem a configuração isolada (db/wrangler.migrations.jsonc): bloqueado.');
  if (count(['--env', '-e']) !== 1 || a[a.indexOf('--env') + 1] !== target.name) refuse('Comando sem o ambiente conferido (--env): bloqueado.');
  if (!a.includes(target.database_name)) refuse('Comando sem o nome do banco conferido: bloqueado.');
  if (count(['--local', '--persist-to', '--preview', '--account-id']) > 0) refuse('Opções --local, --persist-to, --preview e --account-id não passam pelo wrapper.');
}

export async function main(argv, deps) {
  const opts = parseArgs(argv);
  const op = opts._[0];
  const envVars = deps.env || process.env;
  const scrub = scrubber(envVars);
  const D = { ...deps, out: m => deps.out(scrub(m)), err: m => deps.err(scrub(m)) };
  let ev = null;
  try {
    const envs = deps.environments();
    const target = resolveTarget(op, opts, envs);
    const meta = OPS[op];
    const remote = target.kind === 'remote', dry = !!opts['dry-run'];
    // Sem rede: arquivos coerentes, produção conhecida e diferente do destino (identity.mjs).
    const ids = remote ? staticIdentityChecks(target, envs, {
      migrationsText: deps.migrationsConfigText ? deps.migrationsConfigText() : readFileSync(MIGRATIONS_CONFIG, 'utf8'),
      identityText: deps.identityConfigText ? deps.identityConfigText() : readFileSync(IDENTITY_CONFIG, 'utf8')
    }) : null;
    const version = target.offline || target.kind === 'local' ? null : deps.wranglerVersion();
    D.out(banner(op, target, version, dry ? ' | SIMULAÇÃO (--dry-run)' : ''));
    if (target.isProd) await confirmProduction(target, D);
    const handler = handlers[op];
    if (!handler) refuse(`A operação ${op} ainda não está disponível nesta versão.`);
    // Registro de evidências: obrigatório para operação remota real; sem diretório válido, nada é executado.
    ev = openEvidence({ envVars, required: remote && !dry, base: remote ? { op, env: target.name, database_name: target.database_name, database_id: target.database_id, wrangler: version, dry_run: dry } : { op, env: target.name || 'offline', dry_run: dry } });
    ev.record('inicio', { opcoes: Object.keys(opts).filter(k => k !== '_').sort() });

    let identity = null, internal = false, schemaBefore = null;
    const execLogged = (args, o, tipo) => {
      const t0 = Date.now();
      let r; try { r = deps.exec(args, o); } catch { r = { status: -1, stdout: '', stderr: 'falha ao executar' }; }
      ev.record('comando', { tipo, comando: describeCommand(args), status: r.status, ms: Date.now() - t0, ...(r.status !== 0 ? { falha: classifyFailure(r) } : {}) });
      return r;
    };
    // Único caminho até o wrangler: portão, identidade antes do primeiro comando, registro e --dry-run.
    const wrangler = (args, o = {}) => {
      if (!remote) refuse('Comando remoto bloqueado: o ambiente selecionado não é remoto.');
      assertGated(args, target);
      if (!internal) D.out(`[tatame-db] wrangler ${describeCommand(args).map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
      if (dry) return { status: 0, stdout: '', stderr: '', dryRun: true };
      if (!internal) ensureIdentity();
      const r = execLogged(args, o, internal ? 'registro' : 'operacao');
      // a saída do wrangler pode ecoar trechos de SQL com dados: literais e URLs são omitidos; segredos conhecidos, removidos
      if (r.status !== 0) { const e = new Error(`wrangler falhou (código ${r.status}, ${classifyFailure(r)}): ${redact(r.stderr || r.stdout || '', 800)}`); e.wrangler = r.status; throw e; }
      return r;
    };
    const schemaState = () => {
      internal = true;
      try {
        const rows = rowsFromWranglerJson(wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--json', '--yes', '--command', SCHEMA_QUERY]).stdout);
        const migs = rows.some(r => r.type === 'table' && r.name === MIGRATIONS_TABLE)
          ? rowsFromWranglerJson(wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--json', '--yes', '--command', `SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`]).stdout).map(r => r.name) : [];
        return { schema: fingerprintHash(fingerprint(rows)), objetos: rows.length, migracoes: migs };
      } finally { internal = false; }
    };
    function ensureIdentity() {
      if (identity || !remote || dry) return identity;
      identity = verifyIdentity(target, envs, { run: a => execLogged(a, {}, 'identidade'), migrationsConfig: MIGRATIONS_CONFIG, ...ids });
      ev.record('identidade', { conferida: true, uuid: identity.uuid, nome: identity.name });
      D.out(`[tatame-db] identidade conferida na Cloudflare: ${identity.name} | ${short(identity.uuid)} (pelo UUID do arquivo e pelo nome na conta)${target.isProd ? '' : '; não é a produção'}`);
      if (meta.remote === 'write') { schemaBefore = schemaState(); ev.record('schema', { momento: 'antes', ...schemaBefore }); }
      return identity;
    }
    const ctx = { op, opts, target, deps: D, wrangler, version, evidence: ev, ensureIdentity };
    let code;
    try { code = (await handler(ctx)) ?? 0; }
    finally {
      // Depois de qualquer operação de escrita que chegou a executar, em sucesso ou falha: estado do schema e do registro.
      if (identity && meta.remote === 'write') {
        try { const after = schemaState(); ev.record('schema', { momento: 'depois', ...after, mudou: !schemaBefore || after.schema !== schemaBefore.schema || after.migracoes.join() !== schemaBefore.migracoes.join() }); D.out(`[tatame-db] schema antes ${schemaBefore?.schema.slice(0, 16)}… depois ${after.schema.slice(0, 16)}… (registro: ${after.migracoes.join(', ') || 'nenhuma migração'})`); }
        catch { try { ev.record('schema', { momento: 'depois', erro: 'não foi possível ler o schema depois da operação' }); } catch { /* registro já falhou */ } D.err('[tatame-db] AVISO: não foi possível ler o schema depois da operação. Confira com check.'); }
      }
    }
    ev.record('fim', { resultado: code === 0 ? 'ok' : 'falhou', codigo: code });
    return code;
  } catch (e) {
    // Recusas de segurança: travas, identidade, evidências, chave de backup ausente/incorreta, armazenamento inválido.
    const refused = e instanceof GuardError || ['GuardError', 'BackupCryptoError', 'StorageError', 'TempError'].includes(e?.name);
    const code = refused ? 3 : 1;
    try { ev?.record('fim', { resultado: refused ? 'recusado' : 'erro', codigo: code, mensagem: e.wrangler !== undefined ? String(e.message).split(':')[0] : redact(e.message, 600) }); } catch { /* registro indisponível */ }
    D.err(`[tatame-db] ${refused ? 'RECUSADO' : 'ERRO'}: ${e.message}`);
    return code;
  }
}

export function realDeps() {
  return {
    environments: () => loadEnvironments(),
    wranglerVersion,
    exec: (args, o) => runWrangler(args, o),
    isTTY: () => !!(process.stdin.isTTY && process.stdout.isTTY),
    ask: async q => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } },
    out: m => console.log(m),
    err: m => console.error(m),
    fetch: (...a) => globalThis.fetch(...a),
    env: process.env
  };
}

// ---------- operação disponível desde já ----------
registerOp('timetravel-info', async ({ target, wrangler, deps }) => {
  const r = wrangler(['d1', 'time-travel', 'info', target.database_name, ...configArgs(target), '--json']);
  if (r.dryRun) return 0;
  deps.out(r.stdout.trim());
  return 0;
});
