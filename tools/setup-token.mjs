// Código de ativação de uma instalação nova (primeiro acesso). Biblioteca usada por tools/setup-code.mjs e pelos testes.
// Reaproveita o gerador e a normalização do código de recuperação (Crockford, 26 caracteres = 130 bits), mas com hash
// e chaves próprias: os dois processos não se misturam.
//
// No banco ficam só:   settings.setup_token_hash     = SHA-256('tatame-setup:' || código normalizado), em hex
//                      settings.setup_token_expires  = validade (ISO 8601 UTC)
// O código em si nunca é gravado. O Worker (web/_worker.js, setupCodeHash) calcula o mesmo hash; um teste confere.
import { createHash } from 'node:crypto';
import { generateCode, normalizeCode } from './reset-code.mjs';

export const SETUP_HOURS = 72;
export const SETUP_HASH_KEY = 'setup_token_hash', SETUP_EXP_KEY = 'setup_token_expires';
export { generateCode };
export const setupHash = code => createHash('sha256').update('tatame-setup:' + normalizeCode(code)).digest('hex');
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

// SQL que configura o código. Só grava se a instalação ainda não tem equipe (nunca reabre uma academia configurada).
// Sem `replace`, também não sobrescreve um código já configurado (a ferramenta confere antes e o SQL garante).
export function buildSetupSql(code, { now = new Date(), hours = SETUP_HOURS, replace = false } = {}) {
  const expires = new Date(now.getTime() + hours * 3600e3).toISOString();
  const noStaff = 'NOT EXISTS (SELECT 1 FROM staff)';
  const free = replace ? '' : ` AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ${q(SETUP_HASH_KEY)})`;
  return [
    `DELETE FROM settings WHERE key IN ('setup_token'${replace ? `, ${q(SETUP_HASH_KEY)}, ${q(SETUP_EXP_KEY)}` : ''}) AND ${noStaff};`,
    `INSERT INTO settings (key, value) SELECT ${q(SETUP_EXP_KEY)}, ${q(expires)} WHERE ${noStaff}${free};`,
    `INSERT INTO settings (key, value) SELECT ${q(SETUP_HASH_KEY)}, ${q(setupHash(code))} WHERE ${noStaff}${free};`
  ].join('\n') + '\n';
}
