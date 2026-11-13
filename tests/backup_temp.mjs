// Área temporária de texto puro (tools/backup/tempspace.mjs): permissões, limpeza, resíduos de processos mortos,
// limpeza que não toca em nada de fora e mensagens sem conteúdo. Tudo num diretório-base de teste (nunca o
// temporário real do sistema para as remoções).
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspace, scanResidue, cleanResidue, redact, TempError, MARKER, WORK_PREFIX, activeCount } from '../tools/backup/tempspace.mjs';
import { loadSql } from '../tools/db/dump.mjs';
import { main } from '../tools/db/ops.mjs';
import { simDeps, infoReply } from './cf_sim.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const POSIX = process.platform !== 'win32';
const MOD = fileURLToPath(new URL('../tools/backup/tempspace.mjs', import.meta.url));
const SECRET = 'Maria Sigilosa da Silva';
const base = mkdtempSync(join(tmpdir(), 'tatame-temp-test-'));
const own = () => readdirSync(base).filter(n => n.startsWith(WORK_PREFIX));

try {
  // ---------- criação ----------
  const w = workspace({ base });
  const f = w.write('import', `INSERT INTO students VALUES ('${SECRET}');`);
  const g = w.path('export'), h = w.path('export');
  ok(w.dir.startsWith(base) && /^tatame-bkp-work-[0-9a-f]{16}-[A-Za-z0-9]{6}$/.test(w.dir.slice(base.length + 1)), 'área criada com nome aleatório (64 bits + sufixo do mkdtemp) no diretório-base');
  ok(/import-[0-9a-f]{16}\.sql$/.test(f) && g !== h, 'arquivos com nome imprevisível; dois pedidos nunca repetem o nome');
  const mk = JSON.parse(readFileSync(join(w.dir, MARKER), 'utf8'));
  ok(mk.tool === 'tatame-backup-workspace' && mk.pid === process.pid && mk.host === hostname() && !JSON.stringify(mk).includes(SECRET), 'marcador identifica a área (ferramenta, pid, host) sem conteúdo');
  if (POSIX) ok((statSync(w.dir).mode & 0o777) === 0o700 && (statSync(f).mode & 0o777) === 0o600, 'POSIX: diretório 0700 e arquivo 0600');
  else ok(true, 'Windows: modo POSIX não se aplica; o diretório herda a ACL do %TEMP% do usuário (documentado)');
  assert.throws(() => w.write('../fora', 'x'), TempError); ok(true, 'papel de arquivo fora da lista: recusado (sem caminho arbitrário)');
  w.discard(f); ok(!existsSync(f), 'discard apaga o texto puro assim que deixa de ser necessário');
  w.cleanup(); ok(!existsSync(w.dir) && activeCount() === 0, 'limpeza em sucesso: área removida');

  // ---------- falha no meio ----------
  let dirOnFail;
  try { const w2 = workspace({ base }); dirOnFail = w2.dir; try { w2.write('import', SECRET); throw new Error('falha simulada na validação'); } finally { w2.cleanup(); } } catch (e) { assert.match(e.message, /simulada/); }
  ok(!existsSync(dirOnFail), 'limpeza em falha (finally): área removida');

  // ---------- encerramento pelo próprio processo (process.exit no meio da operação) ----------
  const child1 = spawnSync(process.execPath, ['--input-type=module', '-e', `import { workspace } from ${JSON.stringify('file:///' + MOD.replace(/\\/g, '/'))}; const w = workspace({ base: ${JSON.stringify(base)} }); w.write('import', 'x'); process.exit(7);`], { encoding: 'utf8' });
  ok(child1.status === 7 && own().length === 0, "processo que sai no meio da operação (process.exit): o gancho de 'exit' remove a área");

  if (POSIX) {
    const c = spawn(process.execPath, ['--input-type=module', '-e', `import { workspace } from ${JSON.stringify('file://' + MOD)}; const w = workspace({ base: ${JSON.stringify(base)} }); w.write('import', 'x'); console.log('pronto'); setInterval(() => {}, 1000);`]);
    await new Promise(r => c.stdout.once('data', r)); c.kill('SIGTERM'); await new Promise(r => c.once('exit', r));
    ok(own().length === 0, 'POSIX: SIGTERM no meio da operação remove a área (gancho de sinal)');
  }

  // ---------- kill abrupto: resíduo de verdade ----------
  const killed = spawn(process.execPath, ['--input-type=module', '-e', `import { workspace } from ${JSON.stringify('file:///' + MOD.replace(/\\/g, '/'))}; const w = workspace({ base: ${JSON.stringify(base)} }); w.write('import', ${JSON.stringify(`INSERT INTO students VALUES ('${SECRET}');`)}); console.log('pronto'); setInterval(() => {}, 1000);`]);
  await new Promise(r => killed.stdout.once('data', r));
  killed.kill('SIGKILL'); await new Promise(r => killed.once('exit', r));
  const residue = own();
  ok(residue.length === 1, 'kill abrupto (SIGKILL, sem finally nem ganchos): sobra 1 área — é o caso que a limpeza manual trata');

  // ---------- vizinhança que NÃO pode ser tocada ----------
  const legacy = join(base, 'tatame-bkp-work-AbC123'); mkdirSync(legacy); writeFileSync(join(legacy, 'backup.sql'), 'x');   // formato da 5.1, sem marcador
  const foreignHost = join(base, `${WORK_PREFIX}${'a'.repeat(16)}-Zz0000`); mkdirSync(foreignHost); writeFileSync(join(foreignHost, MARKER), JSON.stringify({ tool: 'tatame-backup-workspace', v: 1, pid: 999999, host: 'outra-maquina' }));
  const extra = join(base, `${WORK_PREFIX}${'b'.repeat(16)}-Yy1111`); mkdirSync(extra); writeFileSync(join(extra, MARKER), JSON.stringify({ tool: 'tatame-backup-workspace', v: 1, pid: 999999, host: hostname() })); writeFileSync(join(extra, 'anotacoes.txt'), 'do usuário');
  const alive = join(base, `${WORK_PREFIX}${'c'.repeat(16)}-Xx2222`); mkdirSync(alive); writeFileSync(join(alive, MARKER), JSON.stringify({ tool: 'tatame-backup-workspace', v: 1, pid: process.pid, host: hostname() })); writeFileSync(join(alive, `import-${'1'.repeat(16)}.sql`), 'x');
  const fake = join(base, `${WORK_PREFIX}${'d'.repeat(16)}-Ww3333`); mkdirSync(fake); writeFileSync(join(fake, MARKER), '{"tool":"outra-coisa","pid":999999}');
  writeFileSync(join(base, 'arquivo-de-outro-programa.txt'), 'não mexer'); mkdirSync(join(base, 'outro-dir'));
  const scan = scanResidue({ base });   // verificação REAL de pid (process.kill(pid, 0))
  const st = n => scan.find(r => r.name === n)?.status;
  ok(st(residue[0]) === 'abandonado', 'área do processo morto: identificada como abandonada (marcador válido, mesmo host, pid inexistente, só arquivos esperados)');
  ok(st('tatame-bkp-work-AbC123') === 'desconhecido' && st(foreignHost.slice(base.length + 1)) === 'desconhecido' && st(extra.slice(base.length + 1)) === 'desconhecido' && st(fake.slice(base.length + 1)) === 'desconhecido', 'sem marcador (5.1), outra máquina, arquivo inesperado e marcador alheio: só relatados, nunca removíveis');
  ok(st(alive.slice(base.length + 1)) === 'ativo', 'área de processo vivo: ativa (não removível)');
  ok(!scan.some(r => r.name === 'arquivo-de-outro-programa.txt' || r.name === 'outro-dir'), 'itens sem o prefixo do Tatame nem entram na varredura');
  ok(!JSON.stringify(scan).includes(SECRET), 'a varredura não lê nem devolve conteúdo');
  const rep = cleanResidue({ base });
  ok(rep.removed.length === 1 && !existsSync(join(base, residue[0])), 'limpeza remove só a área abandonada');
  ok([legacy, foreignHost, extra, alive, fake].every(existsSync) && existsSync(join(extra, 'anotacoes.txt')) && existsSync(join(base, 'arquivo-de-outro-programa.txt')) && existsSync(join(base, 'outro-dir')), 'nada de fora foi tocado: áreas desconhecidas/ativas, arquivo e diretório de outros programas intactos');

  // ---------- diretório-base sem permissão / inválido ----------
  assert.throws(() => workspace({ base: join(base, 'nao-existe') }), TempError);
  writeFileSync(join(base, 'sou-arquivo'), ''); assert.throws(() => workspace({ base: join(base, 'sou-arquivo') }), TempError);
  ok(true, 'diretório-base inexistente ou que não é diretório: recusado com TempError (vira RECUSADO, código 3)');
  if (POSIX && process.getuid?.() !== 0) { const ro = join(base, 'ro'); mkdirSync(ro); chmodSync(ro, 0o500); assert.throws(() => workspace({ base: ro }), TempError); chmodSync(ro, 0o700); ok(true, 'POSIX: diretório-base sem escrita: recusado'); }
  else ok(true, 'diretório sem escrita: no Windows o bit de modo não remove escrita; coberto pelo accessSync + tratamento do mkdtemp (documentado)');

  // ---------- mensagens sem conteúdo ----------
  ok(!redact(`near "${SECRET}": syntax error; VALUES ('${SECRET}', X'00ff')`).includes('Sigilosa'), 'redact omite literais entre aspas simples, duplas e hexadecimais');
  let msg = ''; try { loadSql(`INSERT INTO nada VALUES ('${SECRET}'); CREATE TABEL x;`); } catch (e) { msg = e.message; }
  ok(msg.includes('não é SQL importável') && !msg.includes('Sigilosa'), 'erro de SQL inválido não reproduz dados');
  const outs = [];
  // identidade conferida (Cloudflare simulada, tests/cf_sim.mjs); o comando da operação falha ecoando SQL
  const exec = a => infoReply(a) || { status: 1, stdout: '', stderr: `✘ ERROR: near "x": syntax error at offset 9: SQLITE_ERROR\nINSERT INTO students VALUES('${SECRET}')` };
  const code = await main(['timetravel-info', '--env', 'staging'], simDeps({ exec, out: outs, err: outs }));
  ok(code === 1 && outs.some(o => o.includes('wrangler falhou')) && !outs.join('\n').includes('Sigilosa'), 'saída de erro do wrangler que ecoa SQL: literais omitidos na mensagem');
  const outs2 = [];
  const c2 = await main(['temp-clean'], { environments: () => ({}), wranglerVersion: () => '', exec: () => { throw new Error('não deveria executar'); }, isTTY: () => false, ask: async () => '', out: m => outs2.push(m), err: m => outs2.push(m), env: {} });
  ok(c2 === 0 && outs2.some(o => o.startsWith('[temp-clean]')), 'operação temp-clean (offline, só lista sem --remove) roda sem tocar no wrangler');
  const signed = 'You can also download your export from the following URL manually. This link will be valid for one hour: https://d1-export.example.r2.cloudflarestorage.com/abc.sql?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
  ok(!redact(signed).includes('X-Amz-Signature') && redact(signed).includes('‹url omitida›'), 'redact omite URLs (a URL assinada do d1 export baixa o banco em claro)');
  const { wranglerEnv } = await import('../tools/db/wrangler.mjs');
  const we = wranglerEnv({ PATH: 'x', WRANGLER_WRITE_LOGS: 'true' });
  ok(we.WRANGLER_WRITE_LOGS === 'false' && we.WRANGLER_SEND_METRICS === 'false' && we.PATH === 'x', 'wrangler roda sem arquivo de log em disco (onde iria a URL assinada) e sem telemetria, mesmo se o ambiente pedir o contrário');
  console.log('\nTEMPORÁRIOS OK');
} finally {
  try { chmodSync(join(base, 'ro'), 0o700); } catch {}
  rmSync(base, { recursive: true, force: true });
}
