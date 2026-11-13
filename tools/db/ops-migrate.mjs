// Operação migrate: verificação prévia, aplicação SÓ das pendentes, verificação posterior e integridade.
// Remoto: delega a aplicação ao `wrangler d1 migrations apply` (registro nativo em d1_migrations), com a
// configuração isolada db/wrangler.migrations.jsonc. Local: mesmo algoritmo do wrangler 4.155.0 (cada migração +
// INSERT no registro, numa transação). Nunca reverte sozinho: em falha, para e mostra o caminho de recuperação.
import { readFileSync } from 'node:fs';
import { registerOp, GuardError, MIGRATIONS_CONFIG } from './cli.mjs';
import { openSource, remoteArgs } from './source.mjs';
import { readState, readIntegrity, checkReport } from './ops-schema.mjs';
import { MIGRATIONS_DIR, MIGRATIONS_TABLE, MIGRATIONS_TABLE_DDL, migrationFiles, describeDiff } from './schema.mjs';

const stripJsonc = t => t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// A configuração isolada precisa espelhar db/environments.json e não pode ser configuração de Pages.
export function checkMigrationsConfig(envs, text = readFileSync(MIGRATIONS_CONFIG, 'utf8')) {
  const cfg = JSON.parse(stripJsonc(text));
  const problems = [];
  const walk = (o, path) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'pages_build_output_dir') problems.push(`chave proibida ${path}${k}`); walk(v, `${path}${k}.`); } };
  walk(cfg, '');
  if (cfg.d1_databases) problems.push('d1_databases no nível de cima (sem --env apontaria para um banco)');
  for (const [name, env] of Object.entries(envs)) {
    if (name.startsWith('_') || env.kind !== 'remote') continue;
    const db = cfg.env?.[name]?.d1_databases;
    if (!Array.isArray(db) || db.length !== 1) { problems.push(`ambiente ${name}: falta exatamente um d1_databases`); continue; }
    const d = db[0];
    if (d.database_name !== env.database_name || d.database_id !== env.database_id) problems.push(`ambiente ${name}: nome/ID diferentes de db/environments.json`);
    if (d.migrations_dir !== 'migrations' || (d.migrations_table ?? MIGRATIONS_TABLE) !== MIGRATIONS_TABLE || d.migrations_pattern) problems.push(`ambiente ${name}: migrations_dir deve ser "migrations" (db/migrations), tabela ${MIGRATIONS_TABLE}, sem migrations_pattern`);
  }
  return problems;
}

// Aplicação local, equivalente ao wrangler: CREATE do registro e, para cada pendente, arquivo + INSERT numa transação.
export function applyLocal(src, pending, out) {
  src.exec(MIGRATIONS_TABLE_DDL);
  for (const name of pending) {
    const sql = readFileSync(MIGRATIONS_DIR + name, 'utf8');
    src.exec('BEGIN');
    try {
      src.exec(`${sql}\nINSERT INTO "${MIGRATIONS_TABLE}" (name) values ('${name.replace(/'/g, "''")}');`);
      src.exec('COMMIT');
      out(`[migrate] aplicada: ${name}`);
    } catch (e) {
      try { src.exec('ROLLBACK'); } catch { /* já revertida */ }
      throw new Error(`Migração ${name} falhou e foi revertida (as anteriores continuam aplicadas): ${e.message}`);
    }
  }
}

function precheck(state, integrity) {
  const files = migrationFiles();
  if (!state.applied.length && state.userTables) throw new GuardError('Banco com tabelas e sem registro de migrações: rode `baseline` e, se idêntico, `baseline-register` antes de migrar. Nada foi aplicado.');
  if (!state.applied.length) return { pending: files, report: null }; // banco vazio: aplica todas, desde a 000
  const rep = checkReport(state, integrity);
  if (!rep.ok) throw new GuardError(`Verificação prévia falhou, nada foi aplicado: ${rep.problems.join('; ')}${rep.differences.length ? '\n' + rep.differences.map(d => '  - ' + describeDiff(d)).join('\n') : ''}`);
  return { pending: rep.pending, report: rep };
}

registerOp('migrate', async ctx => {
  const { target, deps } = ctx, out = deps.out;
  if (target.kind === 'remote') {
    const problems = checkMigrationsConfig(deps.environments(), deps.migrationsConfigText ? deps.migrationsConfigText() : undefined);
    if (problems.length) throw new GuardError('db/wrangler.migrations.jsonc inconsistente: ' + problems.join('; '));
  }
  const src = openSource(ctx, { mustExist: false });
  try {
    if (src.dryRun) {
      out('[migrate] simulação: consultaria o schema e o registro, o bookmark do Time Travel e aplicaria as pendentes com:');
      ctx.wrangler(['d1', 'migrations', 'apply', target.database_name, ...remoteArgs(target)]);
      return 0;
    }
    const before = readState(src);
    const { pending } = precheck(before, readIntegrity(src));
    if (!pending.length) { out('[migrate] nenhuma migração pendente.'); return 0; }
    out(`[migrate] pendentes: ${pending.join(', ')}`);
    if (target.kind === 'remote') {
      const tt = ctx.wrangler(['d1', 'time-travel', 'info', target.database_name, '--json']);
      let bookmark = null; try { bookmark = JSON.parse(tt.stdout).bookmark ?? null; } catch { /* formato inesperado */ }
      out(`[migrate] bookmark do Time Travel ANTES da migração: ${bookmark || '(não obtido — veja a saída acima)'} — anote-o; é o ponto de recuperação.`);
      ctx.wrangler(['d1', 'migrations', 'apply', target.database_name, ...remoteArgs(target)]);
    } else applyLocal(src, pending, out);
    // Verificação posterior: código 0 do comando não basta.
    const after = checkReport(readState(src), readIntegrity(src));
    const expectedApplied = before.applied.concat(pending);
    if (after.applied.join() !== expectedApplied.join() || !after.ok) {
      throw new Error(`Verificação POSTERIOR falhou: registradas=${after.applied.join(', ')}; ${after.problems.join('; ') || 'registro incompleto'}. ` +
        'Não houve reversão automática. Siga docs/operacao-banco.md (incidente de migração): reversão por db/rollbacks/ se a migração tiver uma testada, ou Time Travel até o bookmark anotado.');
    }
    out(`[migrate] OK: registradas ${after.applied.join(', ')} | integrity_check ok | FKs ok | schema ${after.schema_hash.slice(0, 16)}…`);
    return 0;
  } finally { src.close(); }
});
