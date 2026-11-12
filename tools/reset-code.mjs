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
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local' || a === '--remote') o.target = a;
    else if (a === '--email' || a === '--db') o[a.slice(2)] = argv[++i];
  }
  return o;
}

function d1(db, target, sql, dir) {
  const f = join(dir, 'q' + Math.random().toString(36).slice(2) + '.sql');
  writeFileSync(f, sql);
  const r = runWrangler(['d1', 'execute', db, target, '--json', '--file', f]); // wrangler fixado no projeto, sem shell
  if (r.status !== 0) throw new Error('wrangler falhou:\n' + (r.stderr || r.stdout || '').slice(0, 1500));
  try { return JSON.parse(r.stdout); } catch { return []; }
}

async function main() {
  const { email: raw, db, target } = args(process.argv.slice(2));
  if (!raw || !db || !target) { console.error('Uso: node tools/reset-code.mjs --email <e-mail> --db <nome do banco D1> (--local | --remote)'); process.exit(2); }
  const email = raw.trim().toLowerCase();
  if (!validEmail(email)) { console.error('E-mail inválido.'); process.exit(2); }
  if (!/^[A-Za-z0-9_.-]+$/.test(db)) { console.error('Nome de banco inválido.'); process.exit(2); }
  const dir = mkdtempSync(join(tmpdir(), 'tatame-reset-'));
  try {
    const found = d1(db, target, `SELECT id, name, role FROM staff WHERE email = ${q(email)} AND active = 1;`, dir)?.[0]?.results || [];
    if (!found.length) { console.error('Nenhuma conta ativa com esse e-mail neste banco. Nada foi gerado.'); process.exit(1); }
    const s = found[0];
    console.log(`\nBanco:   ${db} (${target === '--remote' ? 'PRODUÇÃO' : 'local'})\nConta:   ${s.name} <${email}> — ${s.role === 'admin' ? 'administrador' : 'professor'}`);
    console.log('Isto invalida qualquer código anterior desta conta e, quando usado, encerra todas as sessões dela.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question('Para confirmar, digite o e-mail da conta: ')).trim().toLowerCase(); rl.close();
    if (typed !== email) { console.error('E-mail diferente. Cancelado, nada foi gerado.'); process.exit(1); }
    const code = generateCode();
    d1(db, target, buildSql(s.id, code), dir);
    console.log(`\nCódigo de recuperação (válido por ${RESET_MINUTES} minutos, uso único):\n\n    ${code}\n\nEntregue-o por um canal humano e não o guarde. Ele não pode ser consultado depois: só o hash foi gravado.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
