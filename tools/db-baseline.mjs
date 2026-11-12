#!/usr/bin/env node
// Relatório OFFLINE da linha de base: compara um schema salvo com o de 17f1fbd (db/migrations/000_base.sql).
// Não acessa banco nenhum. Entrada: o JSON de `wrangler d1 execute <banco> --remote --json --command "<SCHEMA_QUERY>"`
// (ou uma lista de { type, name, tbl_name, sql }). Opcionalmente, --migrations <json> com o conteúdo de d1_migrations.
//   node tools/db-baseline.mjs schema-producao.json [--migrations migracoes.json]
// Saída: veredito, diferenças e código 0 (idêntica, pode registrar) ou 4 (não registre).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rowsFromWranglerJson } from './db/source.mjs';
import { baselineReport } from './db/ops-schema.mjs';
import { describeDiff, MIGRATIONS_TABLE, SCHEMA_QUERY } from './db/schema.mjs';

export function rowsFromFile(text) {
  const j = JSON.parse(text);
  if (Array.isArray(j) && j.every(r => r && typeof r === 'object' && 'type' in r && 'name' in r)) return j;
  return rowsFromWranglerJson(text);
}

export function reportFromFiles(schemaText, migrationsText) {
  const rows = rowsFromFile(schemaText);
  const hasTable = rows.some(r => r.type === 'table' && r.name === MIGRATIONS_TABLE);
  const applied = migrationsText ? rowsFromFile(migrationsText).map(r => r.name) : [];
  if (hasTable && !migrationsText) throw new Error(`O banco tem a tabela ${MIGRATIONS_TABLE}: informe também --migrations com o conteúdo dela.`);
  const userTables = rows.filter(r => r.type === 'table' && !/^sqlite_|^_cf_/i.test(r.name) && r.name !== MIGRATIONS_TABLE).length;
  return baselineReport({ rows, hasMigrationsTable: hasTable, applied, userTables });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--')); const mi = args.indexOf('--migrations');
  if (!file) { console.error(`Uso: node tools/db-baseline.mjs <schema.json> [--migrations <d1_migrations.json>]\nConsulta de schema (somente leitura): ${SCHEMA_QUERY}`); process.exit(2); }
  try {
    const rep = reportFromFiles(readFileSync(file, 'utf8'), mi > 0 ? readFileSync(args[mi + 1], 'utf8') : null);
    console.log(`veredito: ${rep.verdict}\n${rep.message}`);
    for (const d of rep.differences) console.log('  - ' + describeDiff(d));
    process.exit(rep.can_register ? 0 : 4);
  } catch (e) { console.error('ERRO: ' + e.message); process.exit(1); }
}
