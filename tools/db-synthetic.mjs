#!/usr/bin/env node
// Gera um backup SINTÉTICO criptografado (cenário da Etapa 4 criado pela API real, sem nenhum dado de pessoa real) no
// armazenamento TATAME_BACKUP_DIR, com a chave de TATAME_BACKUP_KEY_FILE. Serve ao ensaio de docs/validacao-d1.md:
// é o que se importa nos bancos descartáveis. Offline: não acessa rede nem banco remoto.
//   node tools/db-synthetic.mjs                 schema completo (000 a 003)
//   node tools/db-synthetic.mjs --sem-002       só 000 e 001: sem a 002 nem a 003 (para ensaiar `migrate` no restore-test)
import { openWorld, unfreezeClock } from '../tests/ref/harness.mjs';
import { buildManual } from '../tests/ref/scenarios.mjs';
import { buildManifest, sealBackup, openVerified, workspace } from './db/backup.mjs';
import { dumpSql, loadSql } from './db/dump.mjs';
import { loadKey } from './backup/crypto.mjs';
import { createStorage } from './backup/storage.mjs';

const sem002 = process.argv.includes('--sem-002');
try {
  const key = loadKey();                 // falha fechada antes de qualquer trabalho
  const storage = createStorage();       // recusa diretório no repositório/OneDrive
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const world = await openWorld(today); await buildManual(world); unfreezeClock();
  const raw = world.DB.raw;
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('000_base.sql'), ('001_recuperacao_senha.sql'), ('002_marcador_de_chamada.sql'), ('003_auditoria_e_ultimo_admin.sql')");
  let text = dumpSql(raw);
  if (sem002) { const db = loadSql(text); db.exec((await import('node:fs')).readFileSync(new URL('../db/rollbacks/003_auditoria_e_ultimo_admin.down.sql', import.meta.url), 'utf8')); db.exec("ALTER TABLE lessons DROP COLUMN roll_called; DELETE FROM d1_migrations WHERE name IN ('002_marcador_de_chamada.sql', '003_auditoria_e_ultimo_admin.sql')"); text = dumpSql(db); db.close(); }
  const manifest = buildManifest(text, { source_env: sem002 ? 'sintetico-sem002' : 'sintetico', source_database: 'cenario-sintetico-etapa4', wrangler: 'n/a', anonymized: true });
  const ws = workspace();
  try {
    const box = ws.write('backup', sealBackup(text, manifest, key), 'tbk');
    const { verification } = openVerified((await import('node:fs')).readFileSync(box), key);
    if (!verification.ok) throw new Error('backup sintético não passou na verificação: ' + verification.problems.join('; '));
    const id = storage.put(box, manifest);
    console.log(`[sintetico] backup ${id} gravado (criptografado; dados sintéticos; migrações: ${manifest.migrations.join(', ')}).`);
  } finally { ws.cleanup(); }
} catch (e) {
  console.error(`[sintetico] RECUSADO: ${e.message}`);
  process.exitCode = 3;
}
