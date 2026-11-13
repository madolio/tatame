// Wrangler fixado no projeto (devDependencies, versão exata). Nunca usa `npx wrangler`, cuja versão varia.
// Executa o binário JS com o próprio Node, sem shell: argumentos vão como lista, sem interpolação.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WRANGLER_JS = ROOT + 'node_modules/wrangler/bin/wrangler.js';
const PKG = ROOT + 'node_modules/wrangler/package.json';
const PINNED = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8')).devDependencies?.wrangler;

// Versão instalada; falha se não estiver instalada ou não for a fixada em package.json.
export function wranglerVersion() {
  if (!existsSync(PKG)) throw new Error('Wrangler não instalado. Rode `npm install` na raiz do projeto.');
  const v = JSON.parse(readFileSync(PKG, 'utf8')).version;
  if (v !== PINNED) throw new Error(`Wrangler instalado (${v}) difere do fixado em package.json (${PINNED}). Rode \`npm install\`.`);
  return v;
}

// Ambiente do processo do wrangler (conferido no código do 4.155.0, wrangler-dist/cli.js):
//   - WRANGLER_WRITE_LOGS=false: por padrão o wrangler grava TODA linha do logger em arquivo de depuração
//     (pasta de configuração global, logs/), inclusive a URL assinada do `d1 export` ("valid for one hour"),
//     que baixa o banco inteiro em claro. Com isso desligado, nada vai para esses arquivos.
//   - WRANGLER_SEND_METRICS=false: sem telemetria de uso.
//   - WRANGLER_LOG_SANITIZE não é tocado (padrão: sanitiza).
export const wranglerEnv = (base = process.env) => ({ ...base, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' });

// Última barreira (Etapa 6.5-A), além do portão de cli.mjs: o executor real só roda comandos d1 com UMA das duas
// configurações do projeto em db/ (a isolada das migrações ou a da consulta de identidade por nome), nunca --local,
// --persist-to ou --account-id, e nunca create/delete. Sem -c, o wrangler procuraria um wrangler.toml/json por perto e
// resolveria o banco pelo nome; isso não acontece por este caminho.
const CONFIGS = [ROOT + 'db/wrangler.migrations.jsonc', ROOT + 'db/wrangler.identity.jsonc'];
export function assertAllowedCommand(args) {
  const a = args.map(String);
  const no = m => { const e = new Error(`Comando bloqueado pelo executor do wrangler: ${m}`); e.name = 'GuardError'; throw e; };
  if (a[0] !== 'd1') no('só comandos d1.');
  if (['create', 'delete', 'list'].includes(a[1]) || (a[1] === 'migrations' && a[2] !== 'apply')) no(`d1 ${a[1]} não é executado por esta ferramenta.`);
  const ci = a.indexOf('-c');
  if (ci < 0 || !CONFIGS.includes(a[ci + 1]) || a.filter(x => x === '-c' || x === '--config' || x.startsWith('--config=')).length !== 1) no('sem a configuração do projeto (db/wrangler.migrations.jsonc ou db/wrangler.identity.jsonc).');
  if (a.some(x => ['--local', '--persist-to', '--account-id', '--preview'].includes(x.split('=')[0]))) no('opção não permitida.');
}

// Executor real: devolve { status, stdout, stderr }. Os testes injetam outro executor no lugar deste.
// stdout/stderr ficam só em memória: o wrapper não os imprime (exceto mensagens de erro, com literais e URLs omitidos).
export function runWrangler(args, { input } = {}) {
  assertAllowedCommand(args);
  wranglerVersion();
  const r = spawnSync(process.execPath, [WRANGLER_JS, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, env: wranglerEnv() });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}
