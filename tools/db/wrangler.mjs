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

// Executor real: devolve { status, stdout, stderr }. Os testes injetam outro executor no lugar deste.
export function runWrangler(args, { input } = {}) {
  wranglerVersion();
  const r = spawnSync(process.execPath, [WRANGLER_JS, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}
