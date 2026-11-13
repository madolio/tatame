#!/usr/bin/env node
// Prepara o primeiro acesso de uma instalação: gera o código de ativação, grava só o hash e a validade no banco e
// mostra o código uma única vez, para o operador entregar ao responsável pela academia. Procedimento completo:
// docs/nova-instalacao.md.
//
//   node tools/setup-code.mjs --env staging [--hours 72] [--replace]
//   node tools/setup-code.mjs --env local --sqlite <arquivo.db> [--hours 72] [--replace]
//
// Desde a Etapa 6.5-A é a operação setup-code do wrapper (tools/db/ops-codes.mjs): o banco vem só de --env
// (db/environments.json; staging, restore-test ou local), com a identidade conferida na Cloudflare e registro de
// evidências. Recusa: --db/--remote/--local (nome livre de banco), produção, banco com equipe cadastrada (o setup está
// fechado para sempre), código já configurado sem --replace, terminal não interativo, validade fora de 1–168 horas.
// Pede para digitar de novo o nome do banco. O código não é gravado em arquivo nem em log.
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { main, realDeps } = await import('./db/ops.mjs');
  process.exitCode = await main(['setup-code', ...process.argv.slice(2)], realDeps());
}
