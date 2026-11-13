#!/usr/bin/env node
// Verificação do app de staging por HTTP (cenários B, C e D de docs/validacao-d1.md), pelo wrapper de banco:
//   node tools/staging-check.mjs --env staging --confirm-destination=tatame-staging [--dry-run]
// Ver tools/db/ops-staging.mjs (travas, credenciais por variável de ambiente, restauração ao final).
import { main, realDeps } from './db/ops.mjs';
process.exitCode = await main(['staging-check', ...process.argv.slice(2)], realDeps());
