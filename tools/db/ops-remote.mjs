// Operações remotas protegidas da Etapa 6.5-A: identify, sql e timetravel-restore.
// Todas passam pelo portão de cli.mjs (configuração isolada, ambiente, identidade na Cloudflare, registro de evidências).
// sql e timetravel-restore só aceitam staging e restore-test e exigem --confirm-destination=<nome exato> (cli.mjs).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { registerOp, GuardError, configArgs, remoteArgs, rowsFromWranglerJson } from './cli.mjs';
import { identityCommands, short } from './identity.mjs';
import { describeCommand } from './evidence.mjs';

const refuse = m => { throw new GuardError(m); };
const MAX_SQL_FILE = 20 * 1024 * 1024;
const given = v => v !== undefined && v !== true && v !== '';

registerOp('identify', async ctx => {
  const { target, deps, opts } = ctx;
  if (opts['dry-run']) {
    const c = identityCommands(target, configArgs(target)[1]);
    deps.out('[identify] simulação: consultaria a Cloudflare com');
    for (const a of [c.byConfig, c.byName]) deps.out('  wrangler ' + describeCommand(a).join(' '));
    return 0;
  }
  const id = ctx.ensureIdentity();
  deps.out(`[identify] ${target.name}: nome ${id.name} | UUID ${short(id.uuid)} | igual aos dois arquivos de configuração${target.isProd ? '' : ' | diferente da produção'}`);
  return 0;
});

// SQL em staging ou restore-test. Exatamente um: --file <arquivo.sql> ou --command "<sql>" (ou --command=<sql>).
// --command devolve as linhas (dados sintéticos/pseudonimizados: staging só recebe backup anonimizado); --file passa
// pela importação do D1 e não devolve linhas.
registerOp('sql', async ctx => {
  const { target, opts, deps } = ctx;
  const hasFile = given(opts.file), hasCmd = given(opts.command);
  if (hasFile === hasCmd) refuse('Informe exatamente um: --file <arquivo.sql> ou --command "<sql>".');
  if (hasFile) {
    const f = String(opts.file);
    if (!existsSync(f) || !statSync(f).isFile()) refuse('Arquivo SQL não encontrado.');
    if (statSync(f).size > MAX_SQL_FILE) refuse('Arquivo SQL grande demais para esta operação (máximo 20 MB).');
    if (!readFileSync(f, 'utf8').trim()) refuse('Arquivo SQL vazio.');
    const r = ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--yes', '--file', f]);
    if (r.dryRun) return 0;
    deps.out('[sql] arquivo executado sem erro informado pelo D1. Confira o resultado com consultas (--command) e com check.');
    return 0;
  }
  const r = ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--json', '--yes', '--command', String(opts.command)]);
  if (r.dryRun) return 0;
  const rows = rowsFromWranglerJson(r.stdout);
  deps.out(`[sql] ${rows.length} linha(s) devolvida(s)`);
  for (const row of rows.slice(0, 200)) deps.out(JSON.stringify(row));
  if (rows.length > 200) deps.out('[sql] (só as 200 primeiras linhas foram mostradas)');
  return 0;
});

const BOOKMARK = /^[0-9a-f]{8}(-[0-9a-f]{8}){2}-[0-9a-f]{32}$/i;
const validTimestamp = t => /^\d{9,11}$/.test(t) || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(t) && !Number.isNaN(Date.parse(t)));

// Time Travel: sobrescreve o banco inteiro. Além do destino confirmado e da identidade, exige terminal e o nome redigitado.
registerOp('timetravel-restore', async ctx => {
  const { target, opts, deps } = ctx;
  const hasB = given(opts.bookmark), hasT = given(opts.timestamp);
  if (hasB === hasT) refuse('Informe exatamente um: --bookmark=<bookmark> ou --timestamp=<RFC 3339 ou Unix>.');
  if (hasB && !BOOKMARK.test(String(opts.bookmark))) refuse('Bookmark em formato inválido (copie-o da saída de timetravel-info ou do migrate).');
  if (hasT && !validTimestamp(String(opts.timestamp))) refuse('Timestamp inválido (use RFC 3339 com fuso, ex. 2026-11-13T10:00:00Z, ou segundos Unix).');
  const point = hasB ? ['--bookmark', String(opts.bookmark)] : ['--timestamp', String(opts.timestamp)];
  if (opts['dry-run']) {
    ctx.wrangler(['d1', 'time-travel', 'info', target.database_name, ...configArgs(target), '--json']);
    ctx.wrangler(['d1', 'time-travel', 'restore', target.database_name, ...configArgs(target), ...point, '--json']);
    return 0;
  }
  if (!deps.isTTY()) refuse('timetravel-restore sobrescreve o banco inteiro: exige terminal interativo.');
  // identidade conferida ANTES da pergunta, para o operador confirmar o banco que a Cloudflare reconheceu
  const id = ctx.ensureIdentity();
  const now = ctx.wrangler(['d1', 'time-travel', 'info', target.database_name, ...configArgs(target), '--json']);
  let current = null; try { current = JSON.parse(now.stdout.slice(now.stdout.indexOf('{'))).bookmark ?? null; } catch { /* formato inesperado */ }
  ctx.evidence.record('time_travel', { momento: 'antes', bookmark_atual: current, destino: hasB ? { bookmark: String(opts.bookmark) } : { timestamp: String(opts.timestamp) } });
  deps.out(`[timetravel-restore] ${id.name} (${short(id.uuid)}) será SOBRESCRITO pelo estado de ${point.join(' ')}. Bookmark atual (para desfazer): ${current || '(não obtido)'}`);
  const typed = String(await deps.ask(`Digite o nome do banco para restaurar (${target.database_name}): `) || '').trim();
  if (typed !== target.database_name) refuse('Nome digitado não confere. Nada foi restaurado.');
  const r = ctx.wrangler(['d1', 'time-travel', 'restore', target.database_name, ...configArgs(target), ...point, '--json']);
  let res = null; try { res = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* formato inesperado */ }
  ctx.evidence.record('time_travel', { momento: 'depois', bookmark: res?.bookmark ?? null, bookmark_anterior: res?.previous_bookmark ?? null });
  deps.out(`[timetravel-restore] restaurado para ${res?.bookmark || '(bookmark não informado)'}; para desfazer: --bookmark=${res?.previous_bookmark || current || '(desconhecido)'}. Rode check em seguida.`);
  return 0;
});
