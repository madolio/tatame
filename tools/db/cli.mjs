// Núcleo do wrapper de banco: seleção de ambiente, travas contra produção e despacho das operações.
// Tudo que toca o mundo externo (executar o wrangler, ler o terminal, imprimir) vem em `deps`, para os testes
// provarem que nenhuma trava deixa passar um comando. Princípio: na dúvida, recusar (falha segura).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runWrangler, wranglerVersion } from './wrangler.mjs';
import { redact } from '../backup/tempspace.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ENV_FILE = ROOT + 'db/environments.json';
export const MIGRATIONS_CONFIG = ROOT + 'db/wrangler.migrations.jsonc';

export class GuardError extends Error { constructor(msg) { super(msg); this.name = 'GuardError'; } }
const refuse = msg => { throw new GuardError(msg); };

// Operações e o que cada uma pode fazer.
//   remote: 'read' | 'write' (acessa um D1 remoto); local: aceita --env local (arquivo SQLite); offline: não usa banco.
//   dest: ambientes aceitos como destino (import/restore-test nunca aceitam produção).
export const OPS = {
  'timetravel-info': { remote: 'read', desc: 'mostra o bookmark atual do Time Travel (somente leitura)' },
  check: { remote: 'read', local: true, desc: 'compara o schema real com o esperado e roda integrity_check/foreign_key_check' },
  baseline: { remote: 'read', local: true, desc: 'compara o schema real com o de 17f1fbd (linha de base), sem registrar nada' },
  'baseline-register': { remote: 'write', local: true, desc: 'registra 000_base como aplicada, somente se a linha de base for idêntica' },
  migrate: { remote: 'write', local: true, desc: 'aplica as migrações pendentes, com verificação antes e depois' },
  export: { remote: 'read', desc: 'exporta o banco para o armazenamento de backups, com manifesto' },
  verify: { offline: true, desc: 'verifica um backup: hash, import em SQLite temporário, integridade, contagens e schema' },
  anonymize: { offline: true, desc: 'gera uma cópia anonimizada de um backup (para staging)' },
  import: { remote: 'write', dest: ['staging', 'restore-test'], desc: 'importa um backup verificado em staging ou restore-test' },
  'restore-test': { remote: 'write', dest: ['restore-test'], desc: 'importa no restore-test e valida o banco restaurado com o Worker' },
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
    else if (['dry-run', 'replace', 'remove'].includes(k)) o[k] = true;
    else o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

export function loadEnvironments(file = ENV_FILE) { return JSON.parse(readFileSync(file, 'utf8')); }

// Resolve e valida o ambiente para a operação. Lança GuardError em qualquer dúvida; não chama nada externo.
export function resolveTarget(op, opts, envs) {
  const meta = OPS[op];
  if (!meta) refuse(`Operação desconhecida: ${op || '(nenhuma)'}. Operações: ${Object.keys(OPS).join(', ')}.`);
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
  if (PENDING(env.database_name) || !NAME.test(env.database_name)) refuse(`Ambiente ${name} sem nome de banco válido em db/environments.json (está "${env.database_name}"). Preencha depois de criar o banco.`);
  if (PENDING(env.database_id) || !UUID.test(env.database_id)) refuse(`Ambiente ${name} sem database_id válido em db/environments.json. Preencha com o ID real (wrangler d1 info ${env.database_name}).`);
  if (meta.dest && !meta.dest.includes(name)) refuse(`${op} só aceita como destino: ${meta.dest.join(', ')}. ${name === 'production' ? 'Produção nunca é destino de importação ou restauração por este wrapper.' : ''}`.trim());
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

export async function main(argv, deps) {
  const opts = parseArgs(argv);
  const op = opts._[0];
  try {
    const target = resolveTarget(op, opts, deps.environments());
    const version = target.offline || target.kind === 'local' ? null : deps.wranglerVersion();
    deps.out(banner(op, target, version, opts['dry-run'] ? ' | SIMULAÇÃO (--dry-run)' : ''));
    if (target.isProd) await confirmProduction(target, deps);
    const handler = handlers[op];
    if (!handler) refuse(`A operação ${op} ainda não está disponível nesta versão.`);
    // Único caminho até o wrangler: registra o comando e respeita --dry-run.
    const wrangler = (args, o = {}) => {
      if (target.kind !== 'remote') refuse('Comando remoto bloqueado: o ambiente selecionado não é remoto.');
      const full = [...args];
      deps.out(`[tatame-db] wrangler ${full.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
      if (opts['dry-run']) return { status: 0, stdout: '', stderr: '', dryRun: true };
      const r = deps.exec(full, o);
      // a saída do wrangler pode ecoar trechos de SQL com dados: literais são omitidos
      if (r.status !== 0) throw new Error(`wrangler falhou (código ${r.status}): ${redact(r.stderr || r.stdout || '', 800)}`);
      return r;
    };
    const code = await handler({ op, opts, target, deps, wrangler, version });
    return code ?? 0;
  } catch (e) {
    // Recusas de segurança: travas, chave de backup ausente/incorreta/conteúdo não autêntico, armazenamento inválido.
    const refused = e instanceof GuardError || ['BackupCryptoError', 'StorageError', 'TempError'].includes(e?.name);
    deps.err(`[tatame-db] ${refused ? 'RECUSADO' : 'ERRO'}: ${e.message}`);
    return refused ? 3 : 1;
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
    env: process.env
  };
}

// ---------- operação disponível desde já ----------
registerOp('timetravel-info', async ({ target, wrangler, deps }) => {
  const r = wrangler(['d1', 'time-travel', 'info', target.database_name, '--json']);
  if (r.dryRun) return 0;
  deps.out(r.stdout.trim());
  return 0;
});
