// Acesso uniforme ao banco alvo: SQLite local (node:sqlite) ou D1 remoto (pelo wrangler fixado, via ctx.wrangler,
// que já passou pelas travas). Só leitura (`query`) e escrita explícita (`exec`); nada aqui escolhe o ambiente.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { MIGRATIONS_CONFIG } from './cli.mjs';

// Saída de `wrangler d1 execute --json`: [{ results: [...], success, meta }, ...]. Junta os results.
export function rowsFromWranglerJson(stdout) {
  const j = JSON.parse(stdout);
  const arr = Array.isArray(j) ? j : [j];
  if (arr.some(x => x && x.success === false)) throw new Error('O D1 informou falha na consulta.');
  return arr.flatMap(x => (x && Array.isArray(x.results)) ? x.results : []);
}

// Argumentos comuns do wrangler para o alvo remoto: configuração isolada (-c) e o ambiente dela (--env).
export const remoteArgs = target => ['--remote', '-c', MIGRATIONS_CONFIG, '--env', target.name];

export function openSource(ctx, { mustExist = true } = {}) {
  const { target } = ctx;
  if (target.kind === 'local') {
    if (mustExist && !existsSync(target.sqlite)) throw new Error(`Arquivo SQLite não encontrado: ${target.sqlite}`);
    const db = new DatabaseSync(target.sqlite);
    db.exec('PRAGMA foreign_keys = ON');
    return {
      kind: 'local', dryRun: false,
      query: sql => db.prepare(sql).all(),
      exec: sql => { db.exec(sql); },
      close: () => db.close()
    };
  }
  const run = (sql, write) => {
    const r = ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--json', '--yes', '--command', sql], { write });
    return r.dryRun ? [] : rowsFromWranglerJson(r.stdout);
  };
  return {
    kind: 'remote', dryRun: !!ctx.opts['dry-run'],
    query: sql => run(sql, false),
    exec: sql => { run(sql, true); },
    close: () => {}
  };
}
