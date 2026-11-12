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

// Executor real: devolve { status, stdout, stderr }. Os testes injetam outro executor no lugar deste.
// stdout/stderr ficam só em memória: o wrapper não os imprime (exceto mensagens de erro, com literais e URLs omitidos).
export function runWrangler(args, { input } = {}) {
  wranglerVersion();
  const r = spawnSync(process.execPath, [WRANGLER_JS, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, env: wranglerEnv() });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}
