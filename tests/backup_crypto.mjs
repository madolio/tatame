// Contêiner criptografado de backup (tools/backup/crypto.mjs): AES-256-GCM, manifesto autenticado, falha fechada.
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, decrypt, inspect, loadKey, keyId, generateKey, assertSameManifest, BackupCryptoError, MAGIC } from '../tools/backup/crypto.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const kindOf = fn => { try { fn(); return null; } catch (e) { assert.ok(e instanceof BackupCryptoError, 'erro esperado do tipo BackupCryptoError: ' + e.message); return e.kind; } };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-crypto-'));
try {
  const hex = generateKey(), key = Buffer.from(hex, 'hex'), other = Buffer.from(generateKey(), 'hex');
  const plain = Buffer.from("CREATE TABLE t (x);\nINSERT INTO t VALUES ('dado sensível');\n".repeat(50));
  const manifest = { manifest_version: 2, source_env: 'production', counts: { t: 50 }, sha256: 'x' };
  const box = encrypt(plain, manifest, key);

  // ida e volta
  const r = decrypt(box, key);
  ok(r.plain.equals(plain) && JSON.stringify(r.manifest) === JSON.stringify(manifest), 'criptografa e descriptografa: conteúdo e manifesto idênticos');
  ok(!box.includes(Buffer.from('dado sensível')) && box.subarray(0, 8).equals(MAGIC), 'o arquivo não contém o conteúdo em claro; começa com a assinatura TATAMEBK');
  ok(!box.includes(key) && !box.includes(Buffer.from(hex)) && !JSON.stringify(inspect(box).manifest).includes(hex), 'a chave não aparece no arquivo nem no manifesto');
  const box2 = encrypt(plain, manifest, key);
  ok(!inspect(box).iv.equals(inspect(box2).iv) && !box.equals(box2), 'IV/nonce novo a cada criptografia (mesmo conteúdo gera arquivos diferentes)');
  ok(inspect(box).keyId.equals(keyId(key)) && keyId(key).length === 8, 'cabeçalho traz só o id da chave (8 bytes de um SHA-256), não a chave');

  // chave
  ok(kindOf(() => decrypt(box, other)) === 'chave_incorreta', 'chave incorreta: recusada sem abrir nada');
  ok(kindOf(() => loadKey({})) === 'chave_ausente', 'chave ausente: falha fechada');
  ok(kindOf(() => loadKey({ TATAME_BACKUP_KEY: 'curta' })) === 'chave_invalida', 'chave com tamanho errado: recusada');
  ok(kindOf(() => loadKey({ TATAME_BACKUP_KEY_FILE: 'relativo/chave.txt' })) === 'chave_ausente', 'arquivo de chave com caminho relativo: recusado');
  const kf = join(tmp, 'chave.txt'); writeFileSync(kf, hex + '\n', { mode: 0o600 });
  ok(loadKey({ TATAME_BACKUP_KEY_FILE: kf }).equals(key) && loadKey({ TATAME_BACKUP_KEY: Buffer.from(key).toString('base64') }).equals(key), 'chave lida de arquivo (hex) ou de variável (base64)');
  try { loadKey({ TATAME_BACKUP_KEY: 'x'.repeat(64) }); } catch (e) { ok(!e.message.includes('x'.repeat(10)), 'mensagens de erro não repetem a chave'); }

  // estrutura
  ok(kindOf(() => decrypt(box.subarray(0, 20), key)) === 'formato', 'arquivo truncado no cabeçalho: erro de formato');
  ok(kindOf(() => decrypt(box.subarray(0, box.length - 5), key)) === 'autenticacao', 'arquivo truncado no fim (tag cortada): autenticação falha');
  ok(kindOf(() => decrypt(box.subarray(0, 40), key)) === 'formato', 'arquivo truncado no manifesto: erro de formato');
  ok(kindOf(() => decrypt(Buffer.concat([Buffer.from('XXXXXXXX'), box.subarray(8)]), key)) === 'formato', 'sem assinatura: recusado');
  { const b = Buffer.from(box); b[8] = 9; ok(kindOf(() => decrypt(b, key)) === 'formato', 'versão de formato desconhecida: recusada'); }

  // adulterações (cada byte relevante)
  const flip = (pos) => { const b = Buffer.from(box); b[pos] ^= 0x01; return b; };
  const h = inspect(box), manStart = 34, bodyStart = 34 + h.manifestLen;
  ok(kindOf(() => decrypt(flip(20), key)) === 'autenticacao', 'IV/nonce alterado: autenticação falha');
  ok(kindOf(() => decrypt(flip(box.length - 1), key)) === 'autenticacao', 'tag de autenticação alterada: falha');
  ok(kindOf(() => decrypt(flip(bodyStart + 10), key)) === 'autenticacao', 'conteúdo criptografado alterado: falha');
  { const b = Buffer.from(box); const s = b.subarray(manStart, bodyStart).toString(); const t = s.replace('"t":50', '"t":51'); assert.strictEqual(t.length, s.length); b.write(t, manStart);
    ok(kindOf(() => decrypt(b, key)) === 'autenticacao', 'manifesto embutido alterado (mesmo tamanho): autenticação falha'); }
  { const fake = encrypt(Buffer.from('outro conteúdo'), { ...manifest, counts: { t: 1 } }, other);
    ok(kindOf(() => decrypt(fake, key)) === 'chave_incorreta', 'backup + manifesto trocados juntos por quem não tem a chave: recusado'); }
  // manifesto externo
  assertSameManifest({ ...manifest, id: 'x' }, manifest); ok(true, 'manifesto externo igual ao autenticado (ignorando o id): aceito');
  ok(kindOf(() => assertSameManifest({ ...manifest, counts: { t: 49 } }, manifest)) === 'manifesto_externo', 'manifest.json externo alterado: detectado');
  console.log('\nCRIPTOGRAFIA DE BACKUP OK');
} finally { rmSync(tmp, { recursive: true, force: true }); }
