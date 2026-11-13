// Acesso uniforme ao banco alvo: SQLite local (node:sqlite) ou D1 remoto (pelo wrangler fixado, via ctx.wrangler,
// que já passou pelas travas e confere a identidade). Leitura (`query`), escrita por comando (`exec`) e escrita por
// arquivo (`execFile`: no remoto, `d1 execute --file`, que não põe o SQL nos argumentos do processo). Nada aqui escolhe
// o ambiente.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { remoteArgs, rowsFromWranglerJson } from './cli.mjs';
import { workspace } from '../backup/tempspace.mjs';

export { remoteArgs, rowsFromWranglerJson };

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
      // como o import do D1: o arquivo inteiro ou nada
      execFile: sql => { db.exec('BEGIN'); try { db.exec(sql); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* já revertida */ } throw e; } },
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
    execFile: sql => {
      const ws = workspace();
      try { const f = ws.write('import', sql); ctx.wrangler(['d1', 'execute', target.database_name, ...remoteArgs(target), '--yes', '--file', f], { write: true }); }
      finally { ws.cleanup(); }
    },
    close: () => {}
  };
}
