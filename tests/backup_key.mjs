// Gestão da chave (loadKey, key-generate, key-check, key-verify-copy) e compatibilidade com backups da Etapa 5.1:
// o contêiner é gerado pelo crypto.mjs REAL do commit 4adeeb5 (extraído do git) e aberto pelo código atual.
// Dados sintéticos; diretórios de teste no temporário do sistema; nada acessa a rede.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openWorld, unfreezeClock } from './ref/harness.mjs';
import { buildManual } from './ref/scenarios.mjs';
import { main, ROOT, MIGRATIONS_CONFIG } from '../tools/db/ops.mjs';
import { buildManifest, openVerified, restoreLocal } from '../tools/db/backup.mjs';
import { dumpSql } from '../tools/db/dump.mjs';
import { loadKey, keyId, generateKey, BackupCryptoError } from '../tools/backup/crypto.mjs';
import { dirAdapter } from '../tools/backup/storage.mjs';
import { PROD, ACCOUNT, infoReply, migrationsCfg, identityCfg, evidenceDir } from './cf_sim.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const kindOf = fn => { try { fn(); return null; } catch (e) { assert.ok(e instanceof BackupCryptoError, e.message); return e.kind; } };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-key-test-'));
assert.ok(!/onedrive/i.test(tmp));
const logs = [];
const EVD = evidenceDir();
const deps = (env, exec = () => { throw new Error('não deveria chamar o wrangler'); }, envs = {}) => ({ environments: () => envs, migrationsConfigText: () => migrationsCfg(envs), identityConfigText: identityCfg, wranglerVersion: () => '4.155.0', exec, isTTY: () => false, ask: async () => '', out: m => logs.push(m), err: m => logs.push(m), env: env && { TATAME_EVIDENCE_DIR: EVD, ...env } });
const run = (argv, env, exec, envs) => main(argv, deps(env, exec, envs));
const last = () => logs[logs.length - 1] || '';

try {
  // ================= chave: leitura =================
  const K1 = generateKey(), k1 = Buffer.from(K1, 'hex');
  const kf = join(tmp, 'chave1.key'); writeFileSync(kf, K1, { mode: 0o600 });
  ok(loadKey({ TATAME_BACKUP_KEY_FILE: kf }).equals(k1), 'chave válida (arquivo, 64 hex): aceita');
  ok(kindOf(() => loadKey({})) === 'chave_ausente', 'chave ausente: recusada');
  ok(kindOf(() => loadKey({ TATAME_BACKUP_KEY_FILE: join(tmp, 'nao-existe.key') })) === 'chave_ausente', 'arquivo de chave inexistente: recusado');
  const bad = join(tmp, 'ruim.key'); writeFileSync(bad, 'abc123', { mode: 0o600 });
  ok(kindOf(() => loadKey({ TATAME_BACKUP_KEY_FILE: bad })) === 'chave_invalida', 'chave em formato inválido: recusada');
  const big = join(tmp, 'grande.key'); writeFileSync(big, K1.repeat(40), { mode: 0o600 });
  ok(kindOf(() => loadKey({ TATAME_BACKUP_KEY_FILE: big })) === 'chave_invalida', 'arquivo grande demais (arquivo errado): recusado sem ler');
  const eacces = { statSync: () => ({ isFile: () => true, size: 64, mode: 0o100600 }), readFileSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }, platform: 'linux' };
  let e1; try { loadKey({ TATAME_BACKUP_KEY_FILE: kf }, eacces); } catch (e) { e1 = e; }
  ok(e1?.kind === 'chave_ilegivel' && /EACCES/.test(e1.message), 'arquivo sem permissão de leitura: recusado (chave_ilegivel), sem conteúdo na mensagem');
  const open = { statSync: () => ({ isFile: () => true, size: 64, mode: 0o100644 }), readFileSync: () => K1, platform: 'linux' };
  let e2; try { loadKey({ TATAME_BACKUP_KEY_FILE: kf }, open); } catch (e) { e2 = e; }
  ok(e2?.kind === 'chave_permissao' && /chmod 600/.test(e2.message) && !e2.message.includes(K1.slice(0, 12)), 'POSIX: chave legível por outros (644): recusada, com orientação chmod 600');
  ok(loadKey({ TATAME_BACKUP_KEY_FILE: kf }, { ...open, statSync: () => ({ isFile: () => true, size: 64, mode: 0o100600 }) }).equals(k1), 'POSIX: chave 600: aceita');
  ok(loadKey({ TATAME_BACKUP_KEY_FILE: kf }, { ...open, platform: 'win32' }).equals(k1), 'Windows: o modo não reflete a ACL; a proteção é a ACL (documentado, icacls)');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const nr = join(tmp, 'sem-leitura.key'); writeFileSync(nr, K1, { mode: 0o000 });
    ok(kindOf(() => loadKey({ TATAME_BACKUP_KEY_FILE: nr })) === 'chave_ilegivel', 'POSIX real: arquivo 000 recusado');
  }

  // ================= key-generate =================
  const keysDir = join(tmp, 'chaves'); mkdirSync(keysDir);
  const gen = join(keysDir, 'tatame-backup.key');
  ok(await run(['key-generate', '--out', join(ROOT, 'chave-no-repo.key')], {}) === 3 && !existsSync(join(ROOT, 'chave-no-repo.key')), 'key-generate dentro do repositório: recusado, nada criado');
  ok(await run(['key-generate', '--out', join(tmp, 'OneDrive', 'x.key')], {}) === 3, 'key-generate no OneDrive: recusado');
  ok(await run(['key-generate', '--out', 'relativo.key'], {}) === 3, 'key-generate com caminho relativo: recusado');
  ok(await run(['key-generate', '--out', gen], {}) === 0 && existsSync(gen), 'key-generate fora do repositório e do OneDrive: chave criada');
  const kgen = loadKey({ TATAME_BACKUP_KEY_FILE: gen });
  ok(logs.some(l => l.includes(`id ${keyId(kgen).toString('hex')}`)) && !logs.join('\n').includes(readFileSync(gen, 'utf8').trim()), 'key-generate mostra só o id da chave, nunca a chave');
  const before = readFileSync(gen, 'utf8');
  ok(await run(['key-generate', '--out', gen], {}) === 3 && readFileSync(gen, 'utf8') === before, 'key-generate num arquivo existente: recusado, chave anterior intacta');
  ok(generateKey() !== generateKey() && /^[0-9a-f]{64}$/.test(before), 'geração: 32 bytes aleatórios (crypto.randomBytes) em 64 hex');

  // ================= cópia de segurança e verificação =================
  const copyDir = join(tmp, 'pendrive'); mkdirSync(copyDir);
  const copy = join(copyDir, 'tatame-backup.key'); copyFileSync(gen, copy);
  const ENVG = { TATAME_BACKUP_KEY_FILE: gen };
  ok(await run(['key-verify-copy', '--copy', copy], ENVG) === 0 && /cópia idêntica/.test(last()), 'key-verify-copy: cópia idêntica confirmada');
  const wrong = join(copyDir, 'outra.key'); writeFileSync(wrong, generateKey(), { mode: 0o600 });
  ok(await run(['key-verify-copy', '--copy', wrong], ENVG) === 3 && /NÃO é a chave/.test(last()), 'key-verify-copy: cópia diferente recusada');
  const corrupt = join(copyDir, 'corrompida.key'); writeFileSync(corrupt, before.slice(0, 60), { mode: 0o600 });
  ok(await run(['key-verify-copy', '--copy', corrupt], ENVG) === 3, 'key-verify-copy: cópia truncada recusada');

  // ================= backup da 5.1 (código real de 4adeeb5) =================
  const legacyDir = join(tmp, 'legado'); mkdirSync(legacyDir);
  const legacyCrypto = join(legacyDir, 'crypto-4adeeb5.mjs');
  writeFileSync(legacyCrypto, execFileSync('git', ['show', '4adeeb5:tools/backup/crypto.mjs'], { cwd: ROOT }));
  const L = await import(pathToFileURL(legacyCrypto).href);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const world = await openWorld(today); await buildManual(world); unfreezeClock();
  const raw = world.DB.raw;
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('000_base.sql'), ('001_recuperacao_senha.sql'), ('002_marcador_de_chamada.sql'), ('003_auditoria_e_ultimo_admin.sql')");
  const text = dumpSql(raw);
  const manifest = buildManifest(text, { source_env: 'staging', source_database: 'tatame-staging', wrangler: '4.155.0', anonymized: true, created_at: '2026-11-11T09:00:00.000Z' });
  const legacyBox = L.encrypt(Buffer.from(text, 'utf8'), manifest, kgen);   // gravado pelo formato/código da 5.1
  const store = join(tmp, 'store'); mkdirSync(store);
  const lf = join(legacyDir, 'b.tbk'); writeFileSync(lf, legacyBox);
  const st = dirAdapter(store, {});
  const legacyId = st.put(lf, manifest);
  const ENV = { TATAME_BACKUP_DIR: store, TATAME_BACKUP_KEY_FILE: gen };
  ok(openVerified(legacyBox, kgen, st.get(legacyId).manifest).verification.ok, 'backup gravado pelo código da 5.1: autenticado e verificado pelo código atual (manifesto externo incluído)');
  ok(await run(['verify', '--backup', legacyId], ENV) === 0, 'operação verify aceita o backup da 5.1');
  const r = await restoreLocal(legacyBox, kgen, st.get(legacyId).manifest);
  ok(r.ok && r.authenticated && r.stats.compared_fields > 0, `restauração do backup da 5.1 com o Worker real: ok (${r.stats.compared_fields} campos, 0 divergências)`);
  ok(L.decrypt(legacyBox, kgen).plain.toString('utf8') === text, 'o código da 5.1 continua abrindo o próprio backup (formato inalterado)');

  // ================= recuperação da chave a partir da cópia =================
  unlinkSync(gen);   // perda da chave principal
  ok(await run(['verify', '--backup', legacyId], ENV) === 3, 'chave principal perdida: verify recusado (nada aberto)');
  const recovered = join(keysDir, 'tatame-backup-recuperada.key'); copyFileSync(copy, recovered);
  const ENVR = { TATAME_BACKUP_DIR: store, TATAME_BACKUP_KEY_FILE: recovered };
  ok(await run(['key-check', '--backup', legacyId], ENVR) === 0 && /autenticação completa ok/.test(last()), 'recuperação: a cópia restaurada abre o backup antigo (key-check com autenticação completa)');
  ok(await run(['verify', '--backup', legacyId], ENVR) === 0, 'recuperação: verify completo com a chave recuperada');

  // ================= troca de chave: backups antigos continuam com a chave antiga =================
  const k2file = join(keysDir, 'tatame-backup-2.key'); writeFileSync(k2file, generateKey(), { mode: 0o600 });
  const k2 = loadKey({ TATAME_BACKUP_KEY_FILE: k2file });
  const newBox = L.encrypt(Buffer.from(text, 'utf8'), { ...manifest, created_at: '2026-11-12T09:00:00.000Z' }, k2);
  const nf = join(legacyDir, 'n.tbk'); writeFileSync(nf, newBox); const newId = st.put(nf, { ...manifest, created_at: '2026-11-12T09:00:00.000Z' });
  const ENV2 = { TATAME_BACKUP_DIR: store, TATAME_BACKUP_KEY_FILE: k2file };
  ok(await run(['key-check', '--all'], ENV2) === 0 && /1 de 2 backup/.test(last()) && logs.some(l => l.includes(`${legacyId}: outra chave (id ${keyId(kgen).toString('hex')})`)), 'key-check --all: mostra quais backups usam a chave atual e o id da chave antiga dos demais');
  ok(await run(['verify', '--backup', legacyId], ENV2) === 3 && /Chave incorreta/.test(last()), 'backup antigo com a chave nova: "Chave incorreta" (não confunde com adulteração)');
  ok(await run(['verify', '--backup', legacyId], ENVR) === 0 && await run(['verify', '--backup', newId], ENV2) === 0, 'após a troca: backup antigo abre com a chave antiga e o novo com a nova');

  // ================= adulteração e falha de descriptografia não importam nada =================
  const IDS = { staging: '11111111-1111-4111-8111-111111111111' };
  const envs = { staging: { kind: 'remote', database_name: 'tatame-staging', database_id: IDS.staging }, production: PROD };
  const remote = join(tmp, 'remote-staging.db'); new DatabaseSync(remote).close();
  const calls = [];
  const sim = args => {
    const info = infoReply(args, { account: ACCOUNT, cfgEnvs: envs }); if (info) return info;
    calls.push(args.join(' '));
    assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === MIGRATIONS_CONFIG);
    const db = new DatabaseSync(remote);
    try {
      if (args[1] === 'export') { writeFileSync(args[args.indexOf('--output') + 1], dumpSql(db)); return { status: 0, stdout: '' }; }
      if (args.includes('--file')) { db.exec(readFileSync(args[args.indexOf('--file') + 1], 'utf8')); return { status: 0, stdout: '[]' }; }
      const sql = args[args.indexOf('--command') + 1];
      const single = !/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''));
      const isQuery = single && /^\s*(SELECT|PRAGMA (integrity_check|foreign_key_check))/i.test(sql);
      return { status: 0, stdout: JSON.stringify([{ results: isQuery ? db.prepare(sql).all() : (db.exec(sql), []), success: true }]) };
    } finally { db.close(); }
  };
  const tbk = st.get(legacyId).boxPath, orig = readFileSync(tbk);
  { const t = Buffer.from(orig); t[t.length - 40] ^= 1; writeFileSync(tbk, t); }
  ok(await run(['import', '--env', 'staging', '--backup', legacyId, '--confirm-destination=tatame-staging'], ENVR, sim, envs) === 3 && calls.length === 0, 'backup da 5.1 adulterado: import recusado sem nenhum comando ao banco');
  writeFileSync(tbk, orig);
  ok(await run(['import', '--env', 'staging', '--backup', legacyId, '--confirm-destination=tatame-staging'], ENV2, sim, envs) === 3 && calls.length === 0, 'chave errada (falha de descriptografia): import recusado sem nenhum comando ao banco');
  { const m = JSON.parse(readFileSync(join(store, legacyId, 'manifest.json'), 'utf8')); writeFileSync(join(store, legacyId, 'manifest.json'), JSON.stringify({ ...m, counts: { ...m.counts, students: 1 } })); }
  ok(await run(['import', '--env', 'staging', '--backup', legacyId, '--confirm-destination=tatame-staging'], ENVR, sim, envs) === 3 && calls.length === 0, 'manifest.json externo da 5.1 editado: import recusado sem nenhum comando');
  writeFileSync(join(store, legacyId, 'manifest.json'), JSON.stringify({ ...manifest, id: legacyId }, null, 2));
  ok(await run(['import', '--env', 'staging', '--backup', legacyId, '--confirm-destination=tatame-staging'], ENVR, sim, envs) === 0 && calls.some(c => c.includes('--file')), 'backup válido da 5.1: importado (simulado) com contagens iguais às do manifesto');

  // ================= gerador de backup sintético (ensaio D1) =================
  const synth = (args, env) => spawnSync(process.execPath, [join(ROOT, 'tools/db-synthetic.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, TATAME_BACKUP_DIR: '', TATAME_BACKUP_KEY_FILE: '', TATAME_BACKUP_KEY: '', ...env } });
  const s1 = synth(['--sem-002'], ENVR);
  const sid = /backup (\S+) gravado/.exec(s1.stdout)?.[1];
  logs.push(s1.stdout, s1.stderr);
  ok(s1.status === 0 && sid && /^sintetico-sem002-.*-anon$/.test(sid) && await run(['verify', '--backup', sid], ENVR) === 0, 'db-synthetic --sem-002: backup sintético criptografado, anonimizado e verificado (só 000 e 001)');
  ok(synth([], { TATAME_BACKUP_DIR: store }).status === 3 && synth([], { TATAME_BACKUP_KEY_FILE: recovered }).status === 3, 'db-synthetic sem chave ou sem diretório: recusado');

  // ================= a chave nunca aparece em saída =================
  const all = logs.join('\n');
  const secrets = [before.trim(), readFileSync(k2file, 'utf8').trim(), K1];
  ok(secrets.every(s => !all.includes(s) && !all.includes(s.slice(8, 24)) && !all.includes(Buffer.from(s, 'hex').toString('base64').slice(0, 16))), `nenhuma das ${logs.length} linhas de saída/erro contém a chave (hex, trecho ou base64)`);
  console.log('\nCHAVE E COMPATIBILIDADE OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
