// Contêiner criptografado de backup (formato TATAMEBK v1): AES-256-GCM do node:crypto (nada de criptografia própria).
//
// Layout (bytes):
//   0  "TATAMEBK"                      magia (8)
//   8  versão do formato = 1           (1)
//   9  algoritmo = 1 (AES-256-GCM)     (1)
//  10  id da chave                     (8)  primeiros 8 bytes de SHA-256("tatame-backup-key-id:" || chave): identifica
//                                            a chave sem revelá-la, para distinguir "chave errada" de "arquivo alterado"
//  18  IV/nonce                        (12) aleatório, novo a cada criptografia
//  30  tamanho do manifesto (u32 BE)   (4)
//  34  manifesto (JSON UTF-8)          (n)  legível sem a chave (só metadados, sem dados pessoais) e AUTENTICADO
//  34+n conteúdo criptografado          (m)
//  fim tag de autenticação GCM         (16)
// AAD = bytes 0..34+n (cabeçalho inteiro + manifesto): qualquer alteração no manifesto, no IV ou no cabeçalho
// invalida a tag, assim como qualquer alteração no conteúdo.
//
// A chave (32 bytes) vem de fora: TATAME_BACKUP_KEY_FILE (arquivo com 64 hex ou 44 base64; preferido) ou
// TATAME_BACKUP_KEY. Nunca é gravada, impressa nem colocada no manifesto.
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const MAGIC = Buffer.from('TATAMEBK', 'ascii');
export const FORMAT_VERSION = 1;
const ALG_AES256GCM = 1;
const IV_LEN = 12, TAG_LEN = 16, KEYID_LEN = 8, HEADER_FIXED = 8 + 1 + 1 + KEYID_LEN + IV_LEN + 4; // 34
const MAX_MANIFEST = 1024 * 1024;

export class BackupCryptoError extends Error {
  // kind: chave_ausente | chave_invalida | chave_ilegivel | chave_permissao | formato | chave_incorreta | autenticacao
  //       | manifesto_externo
  constructor(kind, message) { super(message); this.name = 'BackupCryptoError'; this.kind = kind; }
}
const fail = (kind, m) => { throw new BackupCryptoError(kind, m); };

const parseKey = text => {
  const t = String(text).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(t)) { const b = Buffer.from(t, 'base64'); if (b.length === 32) return b; }
  return null;
};

// Lê a chave do ambiente. Falha fechada: sem chave válida, nenhum backup é criado nem aberto.
// Nenhuma mensagem contém o conteúdo da chave (nem trechos). `io` só muda nos testes.
export const KEY_FILE_MAX = 1024;
export function loadKey(envVars = process.env, io = { readFileSync, statSync, platform: process.platform }) {
  let src = null, raw = null;
  if (envVars.TATAME_BACKUP_KEY_FILE) {
    const f = envVars.TATAME_BACKUP_KEY_FILE;
    let st = null;
    if (isAbsolute(f)) { try { st = io.statSync(f); } catch { st = null; } }
    if (!st || !st.isFile()) fail('chave_ausente', 'TATAME_BACKUP_KEY_FILE não aponta para um arquivo existente (caminho absoluto).');
    if (st.size > KEY_FILE_MAX) fail('chave_invalida', 'O arquivo indicado em TATAME_BACKUP_KEY_FILE é grande demais para ser uma chave de backup (arquivo errado?).');
    // POSIX: chave legível por grupo/outros é recusada. Windows: o modo não reflete a ACL (ver docs, seção 7.0).
    if (io.platform !== 'win32' && (st.mode & 0o077)) fail('chave_permissao', `O arquivo da chave pode ser lido por outros usuários (permissão ${(st.mode & 0o777).toString(8)}). Rode: chmod 600 <arquivo>. Nada foi feito.`);
    try { raw = io.readFileSync(f, 'utf8'); } catch (e) { fail('chave_ilegivel', `Não foi possível ler o arquivo da chave (${e?.code || 'erro de leitura'}). Confira as permissões. Nada foi feito.`); }
    src = 'arquivo';
  } else if (envVars.TATAME_BACKUP_KEY) { raw = envVars.TATAME_BACKUP_KEY; src = 'variável'; }
  if (raw === null) fail('chave_ausente', 'Chave de backup ausente: defina TATAME_BACKUP_KEY_FILE (preferível) ou TATAME_BACKUP_KEY. Sem chave, nenhum backup é criado nem aberto.');
  const key = parseKey(raw);
  if (!key) fail('chave_invalida', `Chave de backup inválida (${src}): precisa ter 32 bytes, em 64 caracteres hexadecimais ou base64.`);
  return key;
}

export const keyId = key => createHash('sha256').update('tatame-backup-key-id:').update(key).digest().subarray(0, KEYID_LEN);
// Gera uma chave nova (para o operador guardar fora do projeto). Só devolve; quem chama decide onde gravar.
export const generateKey = () => randomBytes(32).toString('hex');

// Criptografa `plain` (Buffer) com o manifesto autenticado. Devolve o contêiner (Buffer).
export function encrypt(plain, manifest, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('chave_invalida', 'Chave de backup inválida.');
  const m = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (m.length > MAX_MANIFEST) fail('formato', 'Manifesto grande demais.');
  const iv = randomBytes(IV_LEN);
  const head = Buffer.alloc(HEADER_FIXED);
  MAGIC.copy(head, 0); head[8] = FORMAT_VERSION; head[9] = ALG_AES256GCM; keyId(key).copy(head, 10); iv.copy(head, 18); head.writeUInt32BE(m.length, 30);
  const aad = Buffer.concat([head, m]);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([aad, body, c.getAuthTag()]);
}

// Lê só o cabeçalho e o manifesto (sem a chave). O manifesto ainda NÃO está autenticado aqui.
export function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_FIXED + TAG_LEN) fail('formato', 'Arquivo de backup truncado ou vazio.');
  if (!buf.subarray(0, 8).equals(MAGIC)) fail('formato', 'Não é um backup criptografado do Tatame (assinatura ausente).');
  const version = buf[8], alg = buf[9];
  if (version !== FORMAT_VERSION) fail('formato', `Versão de formato desconhecida: ${version}.`);
  if (alg !== ALG_AES256GCM) fail('formato', `Algoritmo desconhecido: ${alg}.`);
  const n = buf.readUInt32BE(30);
  if (n > MAX_MANIFEST || HEADER_FIXED + n + TAG_LEN > buf.length) fail('formato', 'Arquivo de backup truncado ou com cabeçalho corrompido.');
  let manifest;
  try { manifest = JSON.parse(buf.subarray(HEADER_FIXED, HEADER_FIXED + n).toString('utf8')); } catch { manifest = null; }
  return { version, alg, keyId: buf.subarray(10, 18), iv: buf.subarray(18, 30), manifestLen: n, manifest };
}

// Autentica e descriptografa. O conteúdo só é devolvido depois que a tag foi validada (decipher.final()).
export function decrypt(buf, key) {
  const h = inspect(buf);
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('chave_invalida', 'Chave de backup inválida.');
  if (!timingSafeEqual(h.keyId, keyId(key))) fail('chave_incorreta', 'Chave incorreta: este backup foi criado com outra chave. Nada foi aberto.');
  const aadEnd = HEADER_FIXED + h.manifestLen;
  const aad = buf.subarray(0, aadEnd), body = buf.subarray(aadEnd, buf.length - TAG_LEN), tag = buf.subarray(buf.length - TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', key, h.iv, { authTagLength: TAG_LEN });
  d.setAAD(aad); d.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([d.update(body), d.final()]); }
  catch { fail('autenticacao', 'Autenticação falhou: o conteúdo, o manifesto ou o cabeçalho do backup foram alterados ou corrompidos. Nada foi aberto.'); }
  if (!h.manifest) fail('autenticacao', 'Manifesto autenticado ilegível.');
  return { plain, manifest: h.manifest };
}

// Compara o manifesto externo (manifest.json, cópia para listagem) com o autenticado dentro do contêiner.
export function assertSameManifest(external, authenticated) {
  const norm = o => JSON.stringify(Object.keys(o || {}).sort().reduce((a, k) => (k === 'id' ? a : (a[k] = o[k], a)), {}));
  if (norm(external) !== norm(authenticated)) fail('manifesto_externo', 'O manifest.json externo difere do manifesto autenticado dentro do backup (foi alterado). Vale o autenticado; investigue.');
}
