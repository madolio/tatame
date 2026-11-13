// Códigos do operador pelo wrapper (Etapa 6.5-A): setup-code (primeiro acesso) e reset-code (recuperação de senha).
// Antes, tools/setup-code.mjs e tools/reset-code.mjs recebiam --db <nome> --remote e chamavam o wrangler direto, fora das
// travas: um nome digitado errado atingia qualquer banco da conta. Agora:
//   - o banco vem só de --env (staging, restore-test ou local com --sqlite); --db/--remote/--local são recusados (cli.mjs);
//   - produção é recusada (dest), e a identidade é conferida na Cloudflare antes do primeiro comando;
//   - toda execução remota fica no registro de evidências (sem e-mail, código, hash ou SQL).
// O código continua aparecendo uma única vez, na tela; não vai para argumento de processo, arquivo, SQL, log ou evidência.
import { basename } from 'node:path';
import { registerOp, GuardError } from './cli.mjs';
import { openSource } from './source.mjs';
import { generateCode, hashCode, buildSql, validEmail, RESET_MINUTES } from '../reset-code.mjs';
import { setupHash, buildSetupSql, SETUP_HOURS, SETUP_HASH_KEY, SETUP_EXP_KEY } from '../setup-token.mjs';

const refuse = m => { throw new GuardError(m); };
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

function onlyOptions(opts, allowed) {
  if (opts._.length > 1) refuse(`Argumento não reconhecido: ${opts._.slice(1).length} valor(es) solto(s). Códigos nunca são argumento.`);
  const extra = Object.keys(opts).filter(k => k !== '_' && !allowed.includes(k));
  if (extra.length) refuse(`Opção desconhecida: --${extra[0]}`);
  if (opts['dry-run']) refuse('Esta operação não tem simulação: ela só lê o banco e pede confirmação antes de gravar.');
}
// Falhas do banco/wrangler viram uma mensagem fixa: o texto bruto pode conter SQL com e-mail ou hash.
const db = (fn, what) => { try { return fn(); } catch (e) { if (e?.name === 'GuardError') throw e; refuse(`O acesso ao banco falhou (${what}); nada foi mostrado. Confira o banco antes de repetir.`); } };
const label = target => target.kind === 'remote' ? target.database_name : basename(target.sqlite);
const where = target => target.kind === 'remote' ? `${target.database_name} (${target.name}, REMOTO)` : `${target.sqlite} (local)`;

registerOp('setup-code', async ctx => {
  const { opts, target, deps } = ctx;
  onlyOptions(opts, ['env', 'sqlite', 'hours', 'replace', 'confirm-destination']);
  const hours = opts.hours === undefined ? SETUP_HOURS : Number(opts.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) refuse('--hours deve ser um número inteiro entre 1 e 168.');
  const replace = opts.replace === true;
  if (!deps.isTTY()) refuse('Exige terminal interativo (o código é mostrado uma única vez, na tela).');
  const src = openSource(ctx);
  try {
    const state = () => db(() => src.query(`SELECT (SELECT count(*) FROM staff) AS staff, (SELECT value FROM settings WHERE key = '${SETUP_HASH_KEY}') AS h, (SELECT value FROM settings WHERE key = '${SETUP_EXP_KEY}') AS e;`), 'leitura')[0];
    const s = state();
    if (!s) refuse('Não foi possível ler o banco (schema aplicado?). Nada foi gerado.');
    if (s.staff > 0) refuse('Esta instalação já tem equipe cadastrada: o setup está fechado e não pode ser reaberto. Nada foi gerado.');
    if (s.h && !replace) refuse(`Já existe um código de ativação configurado (vale até ${s.e}). Para trocá-lo, rode de novo com --replace: o código anterior deixa de valer.`);
    deps.out(`\nBanco:    ${where(target)}\nSituação: sem equipe cadastrada${s.h ? '; o código atual será SUBSTITUÍDO' : ''}\nValidade: ${hours} hora(s)`);
    const typed = String(await deps.ask(`Para confirmar, digite o nome do banco (${label(target)}): `) || '').trim();
    if (typed !== label(target)) refuse('Nome diferente. Cancelado, nada foi gerado.');
    const code = generateCode();
    db(() => src.execFile(buildSetupSql(code, { hours, replace })), 'gravação');
    const after = state();
    // Só mostra o código se o banco ficou EXATAMENTE com o hash dele (prova de que foi gravado e não houve corrida).
    if (!after || after.staff > 0 || after.h !== setupHash(code)) refuse('O código não ficou gravado como esperado (outra pessoa configurou o banco ao mesmo tempo?). Ele NÃO foi mostrado; confira o banco e rode de novo.');
    deps.out(`\nCódigo de ativação (válido até ${after.e}, uso único):\n\n    ${code}\n\nEntregue-o por um canal humano diretamente ao responsável pela academia. Ele não fica gravado em lugar nenhum: só o hash está no banco.`);
    return 0;
  } finally { src.close(); }
});

registerOp('reset-code', async ctx => {
  const { opts, target, deps } = ctx;
  onlyOptions(opts, ['env', 'sqlite', 'email', 'confirm-destination']);
  if (opts.email === undefined || opts.email === true) refuse('Uso: node tools/reset-code.mjs --email <e-mail> --env <staging|restore-test|local> [--sqlite <arquivo>]');
  const email = String(opts.email).trim().toLowerCase();
  if (!validEmail(email)) refuse('E-mail inválido.');
  // Terminal interativo obrigatório: o código aparece uma única vez, na tela; redirecionado para arquivo ou pipe, ficaria gravado.
  if (!deps.isTTY()) refuse('Exige terminal interativo (o código é mostrado uma única vez, na tela). Não redirecione a saída.');
  const src = openSource(ctx);
  try {
    const found = db(() => src.query(`SELECT id, name, role FROM staff WHERE email = ${q(email)} AND active = 1;`), 'leitura');
    if (!found.length) refuse('Nenhuma conta ativa com esse e-mail neste banco. Nada foi gerado.');
    const s = found[0];
    deps.out(`\nBanco:   ${where(target)}\nConta:   ${s.name} <${email}> — ${s.role === 'admin' ? 'administrador' : 'professor'}`);
    deps.out('Isto invalida qualquer código anterior desta conta e, quando usado, encerra todas as sessões dela.');
    const typed = String(await deps.ask('Para confirmar, digite o e-mail da conta: ') || '').trim().toLowerCase();
    if (typed !== email) refuse('E-mail diferente. Cancelado, nada foi gerado.');
    const code = generateCode();
    db(() => src.execFile(buildSql(s.id, code)), 'gravação');
    // Só mostra o código se o banco ficou com o hash DELE (prova de que foi gravado; outra emissão simultânea não confunde).
    const after = db(() => src.query(`SELECT code_hash FROM password_resets WHERE staff_id = ${q(s.id)} AND used_at IS NULL;`), 'conferência')[0];
    if (!after || after.code_hash !== hashCode(s.id, code)) refuse('O código não ficou gravado como esperado (outra emissão ao mesmo tempo?). Ele NÃO foi mostrado; rode de novo.');
    deps.out(`\nCódigo de recuperação (válido por ${RESET_MINUTES} minutos, uso único):\n\n    ${code}\n\nEntregue-o por um canal humano e não o guarde. Ele não pode ser consultado depois: só o hash foi gravado.`);
    return 0;
  } finally { src.close(); }
});
