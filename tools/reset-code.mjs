#!/usr/bin/env node
// Gera um código de recuperação de senha (uso único, 30 minutos) para uma conta do Tatame.
// Só o HASH do código vai para o banco; o código aparece uma única vez, na tela do operador.
//
//   node tools/reset-code.mjs --email admin@academia.com --db NOME_DO_BANCO_D1 --remote
//   node tools/reset-code.mjs --email admin@academia.com --db NOME_DO_BANCO_D1 --local     (teste com o banco local)
//
// Procedimento humano antes de rodar: confirme que quem pede é mesmo o administrador (ligue para um número já
// conhecido, não para o que veio na mensagem). Entregue o código por um canal diferente do que pediu a ajuda.
import { createHash, randomBytes } from 'node:crypto';
import { runWrangler } from './db/wrangler.mjs';
import { createInterface } from 'node:readline/promises';
import { workspace } from './backup/tempspace.mjs';
import { pathToFileURL } from 'node:url';

export const RESET_MINUTES = 30;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: sem I, L, O, U (não se confundem ao ditar)

// 26 caracteres x 5 bits = 130 bits de aleatoriedade (256 é múltiplo de 32: sem viés).
export function generateCode() {
  const b = randomBytes(26); let c = '';
  for (const x of b) c += ALPHABET[x & 31];
  return c.match(/.{1,5}/g).join('-');
}
// Tem de ser idêntico a normalizeResetCode / resetCodeHash do web/_worker.js (um teste confere os dois lados).
export const normalizeCode = c => String(c || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
export const hashCode = (staffId, code) => createHash('sha256').update('tatame-reset:' + staffId + ':' + normalizeCode(code)).digest('hex');
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

// SQL que registra o código. Contém apenas o hash.
export function buildSql(staffId, code, now = new Date()) {
  const expires = new Date(now.getTime() + RESET_MINUTES * 60000).toISOString();
  return [
    `INSERT OR REPLACE INTO password_resets (staff_id, code_hash, expires_at, attempts, used_at) VALUES (${q(staffId)}, ${q(hashCode(staffId, code))}, ${q(expires)}, 0, NULL);`,
    `INSERT INTO audit_log (event, staff_id, detail) VALUES ('reset_issued', ${q(staffId)}, 'código emitido pelo operador (tools/reset-code.mjs)');`
  ].join('\n') + '\n';
}

export const validEmail = e => /^[^@\s'"\;]+@[^@\s'"\;]+\.[^@\s'"\;]+$/.test(e);

export class ResetToolError extends Error { constructor(m) { super(m); this.name = 'ResetToolError'; } }
const refuse = m => { throw new ResetToolError(m); };

export function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local' || a === '--remote') { if (o.target && o.target !== a) refuse('Use --local ou --remote, não os dois.'); o.target = a; }
    else if (a === '--email' || a === '--db') o[a.slice(2)] = argv[++i];
    else refuse(`Opção desconhecida: ${a}`);   // em especial, nunca um código: ele não é argumento de nada
  }
  return o;
}

// `deps` só muda nos testes: exec(args) -> { status, stdout, stderr }, ask(pergunta), isTTY(), out(texto).
// O código só existe na memória deste processo e na tela do operador: não vai em argumento de processo, arquivo, SQL ou log.
export async function run(argv, deps) {
  const { email: raw, db, target } = args(argv);
  if (!raw || !db || !target) refuse('Uso: node tools/reset-code.mjs --email <e-mail> --db <nome do banco D1> (--local | --remote)');
  const email = String(raw).trim().toLowerCase();
  if (!validEmail(email)) refuse('E-mail inválido.');
  if (!/^[A-Za-z0-9_.-]+$/.test(db)) refuse('Nome de banco inválido.');
  // Terminal interativo obrigatório: o código aparece uma única vez, na tela; redirecionado para arquivo ou pipe, ficaria
  // gravado em algum lugar. Também garante que alguém digitou a confirmação.
  if (!deps.isTTY()) refuse('Exige terminal interativo (o código é mostrado uma única vez, na tela). Não redirecione a saída.');
  const ws = workspace();
  try {
    const exec = a => { const r = deps.exec(a); if (r.status !== 0) refuse('O wrangler falhou ao acessar o banco; nada foi gerado (ou a gravação não foi concluída). Confira o login do wrangler e o nome do banco e rode de novo.'); return r; };
    // Leitura por --command (devolve linhas em JSON). Gravação por --file. No remoto, o --file passa pela API de importação
    // do D1, que não devolve linhas de SELECT (por isso a leitura não usa --file).
    const read = sql => { try { return JSON.parse(exec(['d1', 'execute', db, target, '--json', '--command', sql]).stdout).flatMap(x => x.results || []); } catch (e) { if (e instanceof ResetToolError) throw e; return []; } };
    const write = sql => { const f = ws.write('import', sql); try { exec(['d1', 'execute', db, target, '--file', f]); } finally { ws.discard(f); } };
    const found = read(`SELECT id, name, role FROM staff WHERE email = ${q(email)} AND active = 1;`);
    if (!found.length) refuse('Nenhuma conta ativa com esse e-mail neste banco. Nada foi gerado.');
    const s = found[0];
    deps.out(`\nBanco:   ${db} (${target === '--remote' ? 'REMOTO' : 'local'})\nConta:   ${s.name} <${email}> — ${s.role === 'admin' ? 'administrador' : 'professor'}`);
    deps.out('Isto invalida qualquer código anterior desta conta e, quando usado, encerra todas as sessões dela.');
    const typed = String(await deps.ask('Para confirmar, digite o e-mail da conta: ') || '').trim().toLowerCase();
    if (typed !== email) refuse('E-mail diferente. Cancelado, nada foi gerado.');
    const code = generateCode();
    write(buildSql(s.id, code));
    // Só mostra o código se o banco ficou com o hash DELE (prova de que foi gravado; outra emissão simultânea não confunde).
    const after = read(`SELECT code_hash FROM password_resets WHERE staff_id = ${q(s.id)} AND used_at IS NULL;`)[0];
    if (!after || after.code_hash !== hashCode(s.id, code)) refuse('O código não ficou gravado como esperado (outra emissão ao mesmo tempo?). Ele NÃO foi mostrado; rode de novo.');
    deps.out(`\nCódigo de recuperação (válido por ${RESET_MINUTES} minutos, uso único):\n\n    ${code}\n\nEntregue-o por um canal humano e não o guarde. Ele não pode ser consultado depois: só o hash foi gravado.`);
    return 0;
  } finally { ws.cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = {
    exec: a => runWrangler(a), isTTY: () => !!(process.stdin.isTTY && process.stdout.isTTY), out: m => console.log(m),
    ask: async qs => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(qs); } finally { rl.close(); } }
  };
  run(process.argv.slice(2), deps).then(c => { process.exitCode = c; }, e => { console.error(`[reset-code] RECUSADO: ${e instanceof ResetToolError ? e.message : 'erro inesperado; nada foi mostrado.'}`); process.exitCode = e instanceof ResetToolError ? 3 : 1; });
}
