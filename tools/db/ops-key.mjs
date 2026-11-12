// Gestão da chave de backup (offline; nada aqui acessa banco ou rede). Procedimento completo: docs/operacao-banco.md, 7.0.
//   key-generate     --out <caminho absoluto>   gera 32 bytes aleatórios num arquivo novo (0600), fora do repositório e
//                                               do OneDrive; mostra só o id da chave, nunca a chave
//   key-check        [--backup <id> | --file <backup.tbk> | --all]
//                    confere a chave de TATAME_BACKUP_KEY_FILE/TATAME_BACKUP_KEY; com backup, prova que ela o abre
//                    (autenticação completa); com --all, diz quais backups do armazenamento foram feitos com ela
//   key-verify-copy  --copy <caminho absoluto>  confere se a cópia de segurança é idêntica à chave configurada
//
// O "id da chave" (16 hex) é o que já vai no cabeçalho autenticado de cada backup: 8 bytes de SHA-256 com prefixo
// fixo. Identifica a chave sem permitir reconstruí-la. Não é segredo e pode ser anotado junto à cópia da chave.
import { writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { registerOp, GuardError } from './cli.mjs';
import { loadKey, keyId, generateKey, inspect, decrypt, BackupCryptoError } from '../backup/crypto.mjs';
import { createStorage, forbiddenLocation } from '../backup/storage.mjs';

const idHex = key => keyId(key).toString('hex');
const envOf = ctx => ctx.deps.env || process.env;
const pathOpt = (ctx, name) => { const p = ctx.opts[name]; if (!p || p === true || !isAbsolute(String(p))) throw new GuardError(`Informe --${name} <caminho absoluto>.`); return String(p); };

registerOp('key-generate', async ctx => {
  const out = pathOpt(ctx, 'out');
  const where = forbiddenLocation(out, envOf(ctx));
  if (where) throw new GuardError(`A chave não pode ficar ${where}. Escolha um local fora do repositório e do OneDrive.`);
  if (!existsSync(dirname(out)) || !statSync(dirname(out)).isDirectory()) throw new GuardError('O diretório de destino da chave não existe. Crie-o antes.');
  if (existsSync(out)) throw new GuardError('Já existe um arquivo nesse caminho; nada foi sobrescrito (sobrescrever uma chave pode tornar backups irrecuperáveis).');
  writeFileSync(out, generateKey(), { mode: 0o600, flag: 'wx' });
  try { chmodSync(out, 0o600); } catch { /* Windows */ }
  const key = loadKey({ TATAME_BACKUP_KEY_FILE: out });   // relê pelo mesmo caminho das operações
  ctx.deps.out(`[key-generate] chave nova gravada (id ${idHex(key)}). A chave não foi exibida.`);
  ctx.deps.out('[key-generate] Agora: (1) faça a cópia de segurança em local independente dos backups; (2) confira com key-verify-copy; (3) anote o id junto à cópia.');
  if (process.platform === 'win32') ctx.deps.out('[key-generate] Windows: restrinja o acesso ao arquivo (docs/operacao-banco.md, 7.0: icacls).');
  return 0;
});

registerOp('key-check', async ctx => {
  const key = loadKey(envOf(ctx));
  const id = idHex(key);
  const src = envOf(ctx).TATAME_BACKUP_KEY_FILE ? 'TATAME_BACKUP_KEY_FILE' : 'TATAME_BACKUP_KEY';
  ctx.deps.out(`[key-check] chave válida (32 bytes) lida de ${src}; id ${id}.`);
  const { opts } = ctx;
  if (opts.all) {
    const list = createStorage(envOf(ctx)).list();
    let mine = 0;
    for (const m of list) {
      let kid = '?';
      try { kid = inspect(readFileSync(createStorage(envOf(ctx)).get(m.id).boxPath)).keyId.toString('hex'); } catch { kid = 'ilegível'; }
      if (kid === id) mine++;
      ctx.deps.out(`[key-check] ${m.id}: ${kid === id ? 'esta chave' : kid === 'ilegível' ? 'arquivo ilegível' : `outra chave (id ${kid})`}`);
    }
    ctx.deps.out(`[key-check] ${mine} de ${list.length} backup(s) foram feitos com esta chave. Os demais exigem a chave antiga correspondente.`);
    return 0;
  }
  let box = null, label = null;
  if (opts.backup && opts.backup !== true) { box = readFileSync(createStorage(envOf(ctx)).get(String(opts.backup)).boxPath); label = String(opts.backup); }
  else if (opts.file && opts.file !== true) { box = readFileSync(String(opts.file)); label = 'arquivo informado'; }
  if (!box) return 0;
  try { decrypt(box, key); }               // autenticação completa (tag GCM); o conteúdo é descartado
  catch (e) { if (e instanceof BackupCryptoError) throw new GuardError(e.message); throw e; }
  ctx.deps.out(`[key-check] esta chave abre ${label}: autenticação completa ok. Nenhum conteúdo foi gravado ou exibido.`);
  return 0;
});

registerOp('key-verify-copy', async ctx => {
  const key = loadKey(envOf(ctx));
  const copyPath = pathOpt(ctx, 'copy');
  let copy;
  try { copy = loadKey({ TATAME_BACKUP_KEY_FILE: copyPath }); }
  catch (e) { if (e instanceof BackupCryptoError) throw new GuardError(`Cópia da chave: ${e.message}`); throw e; }
  if (!timingSafeEqual(copy, key)) throw new GuardError(`A cópia NÃO é a chave configurada (id da cópia ${idHex(copy)}, id da chave ${idHex(key)}). Não apague nenhuma das duas antes de entender a diferença.`);
  ctx.deps.out(`[key-verify-copy] cópia idêntica à chave configurada (id ${idHex(key)}).`);
  return 0;
});
