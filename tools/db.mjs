#!/usr/bin/env node
// Operações de banco do Tatame (schema, migrações, backup, restauração). Ver docs/operacao-banco.md.
//   node tools/db.mjs <operação> --env <local|staging|restore-test|production> [opções]
// Nenhum ambiente é padrão. Produção exige --confirm-production=<nome exato> e terminal interativo.
import { main, realDeps } from './db/ops.mjs';
process.exitCode = await main(process.argv.slice(2), realDeps());
