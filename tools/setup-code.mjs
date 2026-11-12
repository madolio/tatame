#!/usr/bin/env node
// Prepara o primeiro acesso de uma instalação NOVA: gera o código de ativação, grava só o hash e a validade no banco e
// mostra o código uma única vez, para o operador entregar ao responsável pela academia. Procedimento completo:
// docs/nova-instalacao.md.
//
//   node tools/setup-code.mjs --db <nome do banco D1> --remote [--hours 72] [--replace]
//   node tools/setup-code.mjs --db <nome do banco D1> --local  [--hours 72] [--replace]   (banco local do wrangler)
//
// Recusa: banco com equipe cadastrada (instalação já configurada: o setup está fechado para sempre); o banco de produção
// de db/environments.json; código já configurado sem --replace; terminal não interativo; validade fora de 1–168 horas.
// Pede para digitar de novo o nome do banco. O código não é gravado em arquivo nem em log.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { runWrangler } from './db/wrangler.mjs';
import { workspace } from './backup/tempspace.mjs';
import { generateCode, setupHash, buildSetupSql, SETUP_HOURS, SETUP_HASH_KEY, SETUP_EXP_KEY } from './setup-token.mjs';

const ENV_FILE = new URL('../db/environments.json', import.meta.url);
export class SetupToolError extends Error { constructor(m) { super(m); this.name = 'SetupToolError'; } }
const refuse = m => { throw new SetupToolError(m); };

export function parse(argv) {
  const o = { replace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local' || a === '--remote') { if (o.target && o.target !== a) refuse('Use --local ou --remote, não os dois.'); o.target = a; }
    else if (a === '--replace') o.replace = true;
    else if (a === '--db' || a === '--hours') o[a.slice(2)] = argv[++i];
    else refuse(`Opção desconhecida: ${a}`);
  }
  if (!o.db || !o.target) refuse('Uso: node tools/setup-code.mjs --db <nome do banco D1> (--local | --remote) [--hours 72] [--replace]');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.db)) refuse('Nome de banco inválido.');
  o.hours = o.hours === undefined ? SETUP_HOURS : Number(o.hours);
  if (!Number.isInteger(o.hours) || o.hours < 1 || o.hours > 168) refuse('--hours deve ser um número inteiro entre 1 e 168.');
  return o;
}

const productionName = () => { try { return JSON.parse(readFileSync(ENV_FILE, 'utf8')).production?.database_name || null; } catch { return null; } };

// `deps` só muda nos testes: exec(args) -> { status, stdout, stderr }, ask(pergunta), isTTY(), out(texto), productionName().
export async function run(argv, deps) {
  const o = parse(argv);
  const prod = deps.productionName();
  if (prod && !/PENDENTE/i.test(prod) && o.db === prod) refuse('Este é o banco de PRODUÇÃO (db/environments.json). O código de ativação é só para instalações novas.');
  if (!deps.isTTY()) refuse('Exige terminal interativo (o código é mostrado uma única vez, na tela).');
  const ws = workspace();
  try {
    const exec = args => { const r = deps.exec(args); if (r.status !== 0) refuse('O wrangler falhou ao acessar o banco; confira e rode de novo. Se foi na gravação, verifique o banco antes de repetir.'); return r; };
    // Leitura por --command (devolve as linhas em JSON). Gravação por --file: no remoto o --file passa pela API de
    // importação do D1, que não devolve linhas de SELECT; por isso a conferência é uma leitura separada, depois.
    const read = sql => { try { return JSON.parse(exec(['d1', 'execute', o.db, o.target, '--json', '--command', sql]).stdout).flatMap(x => x.results || []); } catch (e) { if (e instanceof SetupToolError) throw e; return []; } };
    const write = sql => { const f = ws.write('import', sql); try { exec(['d1', 'execute', o.db, o.target, '--file', f]); } finally { ws.discard(f); } };
    const state = () => read(`SELECT (SELECT count(*) FROM staff) AS staff, (SELECT value FROM settings WHERE key = '${SETUP_HASH_KEY}') AS h, (SELECT value FROM settings WHERE key = '${SETUP_EXP_KEY}') AS e;`)[0];
    const s = state();
    if (!s) refuse('Não foi possível ler o banco (schema aplicado?). Nada foi gerado.');
    if (s.staff > 0) refuse('Esta instalação já tem equipe cadastrada: o setup está fechado e não pode ser reaberto. Nada foi gerado.');
    if (s.h && !o.replace) refuse(`Já existe um código de ativação configurado (vale até ${s.e}). Para trocá-lo, rode de novo com --replace: o código anterior deixa de valer.`);
    deps.out(`\nBanco:    ${o.db} (${o.target === '--remote' ? 'REMOTO' : 'local'})\nSituação: sem equipe cadastrada${s.h ? '; o código atual será SUBSTITUÍDO' : ''}\nValidade: ${o.hours} hora(s)`);
    const typed = String(await deps.ask('Para confirmar, digite o nome do banco: ') || '').trim();
    if (typed !== o.db) refuse('Nome diferente. Cancelado, nada foi gerado.');
    const code = generateCode();
    write(buildSetupSql(code, { hours: o.hours, replace: o.replace }));
    const after = state();
    // Só mostra o código se o banco ficou EXATAMENTE com o hash dele (prova de que foi gravado e não houve corrida).
    if (!after || after.staff > 0 || after.h !== setupHash(code)) refuse('O código não ficou gravado como esperado (outra pessoa configurou o banco ao mesmo tempo?). Ele NÃO foi mostrado; confira o banco e rode de novo.');
    deps.out(`\nCódigo de ativação (válido até ${after.e}, uso único):\n\n    ${code}\n\nEntregue-o por um canal humano diretamente ao responsável pela academia. Ele não fica gravado em lugar nenhum: só o hash está no banco.`);
    return 0;
  } finally { ws.cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = {
    exec: args => runWrangler(args), productionName, isTTY: () => !!(process.stdin.isTTY && process.stdout.isTTY), out: m => console.log(m),
    ask: async q => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } }
  };
  run(process.argv.slice(2), deps).then(c => { process.exitCode = c; }, e => { console.error(`[setup-code] RECUSADO: ${e.message}`); process.exitCode = e instanceof SetupToolError ? 3 : 1; });
}
