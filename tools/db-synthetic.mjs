#!/usr/bin/env node
// Gera um backup SINTÉTICO criptografado (cenário da Etapa 4 criado pela API real, sem nenhum dado de pessoa real) no
// armazenamento TATAME_BACKUP_DIR, com a chave de TATAME_BACKUP_KEY_FILE. Serve ao ensaio de docs/validacao-d1.md:
// é o que se importa nos bancos descartáveis. Offline: não acessa rede nem banco remoto.
//   node tools/db-synthetic.mjs                 schema completo (000 a 003), registro com as 4 migrações
//   node tools/db-synthetic.mjs --sem-002       só 000 e 001: sem a 002 nem a 003 (para ensaiar `migrate` no restore-test)
//   node tools/db-synthetic.mjs --base          formato de 17f1fbd (000_base), SEM d1_migrations: é o estado da produção
//                                               hoje; ensaia baseline -> baseline-register -> migrate (001, 002, 003)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openWorld, unfreezeClock } from '../tests/ref/harness.mjs';
import { buildManual } from '../tests/ref/scenarios.mjs';
import { buildManifest, sealBackup, openVerified, workspace } from './db/backup.mjs';
import { dumpSql, loadSql } from './db/dump.mjs';
import { loadKey } from './backup/crypto.mjs';
import { createStorage } from './backup/storage.mjs';

const down = n => readFileSync(new URL(`../db/rollbacks/${n}.down.sql`, import.meta.url), 'utf8');
export const VARIANTS = { completo: 'sintetico', 'sem-002': 'sintetico-sem002', base: 'sintetico-base' };

// SQL do cenário sintético na variante pedida. Usa as reversões testadas (db/rollbacks/) para voltar o schema.
export async function syntheticSql(variant = 'completo') {
  if (!VARIANTS[variant]) throw new Error(`variante desconhecida: ${variant}`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const world = await openWorld(today); await buildManual(world); unfreezeClock();
  const raw = world.DB.raw;
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('000_base.sql'), ('001_recuperacao_senha.sql'), ('002_marcador_de_chamada.sql'), ('003_auditoria_e_ultimo_admin.sql')");
  let text = dumpSql(raw);
  if (variant === 'completo') return text;
  const db = loadSql(text);
  try {
    db.exec(down('003_auditoria_e_ultimo_admin'));
    db.exec(down('002_marcador_de_chamada'));
    if (variant === 'sem-002') db.exec("DELETE FROM d1_migrations WHERE name IN ('002_marcador_de_chamada.sql', '003_auditoria_e_ultimo_admin.sql')");
    else { db.exec(down('001_recuperacao_senha')); db.exec('DROP TABLE d1_migrations'); }
    text = dumpSql(db);
  } finally { db.close(); }
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2);
  try {
    const unknown = flags.filter(f => !['--sem-002', '--base'].includes(f));
    if (unknown.length || flags.length > 1) throw new Error('Use no máximo uma opção: --sem-002 ou --base.');
    const variant = flags[0] ? flags[0].slice(2) : 'completo';
    const key = loadKey();                 // falha fechada antes de qualquer trabalho
    const storage = createStorage();       // recusa diretório no repositório/OneDrive
    const text = await syntheticSql(variant);
    const manifest = buildManifest(text, { source_env: VARIANTS[variant], source_database: 'cenario-sintetico-etapa4', wrangler: 'n/a', anonymized: true });
    const ws = workspace();
    try {
      const box = ws.write('backup', sealBackup(text, manifest, key), 'tbk');
      const { verification } = openVerified(readFileSync(box), key);
      if (!verification.ok) throw new Error('backup sintético não passou na verificação: ' + verification.problems.join('; '));
      const id = storage.put(box, manifest);
      console.log(`[sintetico] backup ${id} gravado (criptografado; dados sintéticos; migrações: ${manifest.migrations.join(', ') || 'nenhuma registrada — formato 17f1fbd'}).`);
    } finally { ws.cleanup(); }
  } catch (e) {
    console.error(`[sintetico] RECUSADO: ${e.message}`);
    process.exitCode = 3;
  }
}
