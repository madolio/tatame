#!/usr/bin/env node
// Gera um código de recuperação de senha (uso único, 30 minutos) para uma conta do Tatame.
// Só o HASH do código vai para o banco; o código aparece uma única vez, na tela do operador.
//
//   node tools/reset-code.mjs --email admin@academia.com --env staging
//   node tools/reset-code.mjs --email admin@academia.com --env restore-test
//   node tools/reset-code.mjs --email admin@academia.com --env local --sqlite <arquivo.db>     (teste com SQLite local)
//
// Desde a Etapa 6.5-A a ferramenta é a operação reset-code do wrapper (tools/db/ops-codes.mjs): o banco vem só de --env
// (db/environments.json), com a identidade conferida na Cloudflare e registro de evidências; --db/--remote/--local são
// recusados e a PRODUÇÃO também (ver docs/recuperacao-de-senha.md: o caminho de produção depende de autorização própria).
//
// Procedimento humano antes de rodar: confirme que quem pede é mesmo o administrador (ligue para um número já
// conhecido, não para o que veio na mensagem). Entregue o código por um canal diferente do que pediu a ajuda.
import { createHash, randomBytes } from 'node:crypto';
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { main, realDeps } = await import('./db/ops.mjs');
  process.exitCode = await main(['reset-code', ...process.argv.slice(2)], realDeps());
}
