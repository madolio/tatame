// Área de trabalho temporária para SQL EM CLARO (texto puro de backup). Ver docs/operacao-banco.md, seção 7.6.
//
// Onde existe texto puro em disco (e por quê): só nos pontos em que o wrangler exige arquivo:
//   export-*.sql / roundtrip-*.sql   saída de `wrangler d1 export --output`   (export, restore-test/ida e volta)
//   import-*.sql                     entrada de `wrangler d1 execute --file`   (import, restore-test)
// verify e anonymize trabalham em memória (SQLite :memory:) e não gravam texto puro.
//
// Proteções:
//   - diretório novo por operação, criado com mkdtemp no temporário do sistema (fora do repositório e do OneDrive),
//     nome com 64 bits aleatórios + sufixo aleatório do mkdtemp; permissão 0700 (POSIX). No Windows o diretório
//     herda a ACL do %TEMP% do usuário (por padrão: o próprio usuário, SYSTEM e administradores).
//   - arquivos com nome aleatório, criados com 'wx' (nunca sobrescreve) e 0600 (POSIX).
//   - marcador .tatame-work.json (pid, host, data) identifica a área como do Tatame e diz se o dono ainda vive.
//   - limpeza em finally, no 'exit' do processo e em SIGINT/SIGTERM/SIGHUP. Kill -9, queda de energia ou travamento
//     do sistema não passam por nada disso: sobra uma área "abandonada", tratada por scanResidue/cleanResidue.
//   - a limpeza de resíduos só apaga áreas com marcador válido, do mesmo host, cujo processo dono não existe mais e
//     que contenham SOMENTE arquivos comuns com nomes do padrão acima. Qualquer outra coisa é só relatada.
//
// Limite: apagar um arquivo remove a entrada do sistema de arquivos; NÃO garante apagamento físico. Em SSD (wear
// leveling, TRIM), em sistemas com journaling, cópias de sombra, antivírus ou indexadores, restos podem permanecer
// até serem sobrescritos. A defesa para isso é o disco cifrado (BitLocker/FileVault/LUKS).
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync, chmodSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const WORK_PREFIX = 'tatame-bkp-work-';
export const MARKER = '.tatame-work.json';
const MARKER_TOOL = 'tatame-backup-workspace';
const ROLES = /^(export|import|roundtrip|backup|anon)$/;
const DIR_RE = /^tatame-bkp-work-[0-9a-f]{16}-[A-Za-z0-9]{6}$/;
const FILE_RE = /^(export|import|roundtrip|backup|anon)-[0-9a-f]{16}\.(sql|tbk)$/;
export class TempError extends Error { constructor(m) { super(m); this.name = 'TempError'; } }

const active = new Set();
let hooked = false;
const cleanupAll = () => { for (const w of [...active]) w.cleanup(); };
function hook() {
  if (hooked) return; hooked = true;
  process.on('exit', cleanupAll);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    try { process.on(sig, () => { cleanupAll(); process.exit(code); }); } catch { /* sinal indisponível nesta plataforma */ }
  }
}
export const activeCount = () => active.size;

const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Cria a área. `base` só muda nos testes.
export function workspace({ base = tmpdir() } = {}) {
  if (!base || !existsSync(base) || !statSync(base).isDirectory()) throw new TempError('Diretório temporário do sistema inexistente ou inválido; nada foi feito.');
  try { accessSync(base, constants.W_OK); } catch { throw new TempError('Sem permissão de escrita no diretório temporário do sistema; nada foi feito.'); }
  let dir;
  try { dir = mkdtempSync(join(base, `${WORK_PREFIX}${randomBytes(8).toString('hex')}-`)); }
  catch { throw new TempError('Não foi possível criar a área temporária (permissão?); nada foi feito.'); }
  try { chmodSync(dir, 0o700); } catch { /* Windows: ACL herdada do %TEMP% */ }
  writeFileSync(join(dir, MARKER), JSON.stringify({ tool: MARKER_TOOL, v: 1, pid: process.pid, host: hostname(), started_at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  let done = false;
  const w = {
    dir,
    // caminho novo e imprevisível para um papel (o arquivo ainda não existe: o wrangler pode criá-lo)
    path(role, ext = 'sql') { if (!ROLES.test(role) || !/^(sql|tbk)$/.test(ext)) throw new TempError('papel de arquivo temporário desconhecido'); return join(dir, `${role}-${randomBytes(8).toString('hex')}.${ext}`); },
    write(role, data, ext = 'sql') { const f = w.path(role, ext); writeFileSync(f, data, { mode: 0o600, flag: 'wx' }); return f; },
    // lê um arquivo criado por outro programa (wrangler), restringindo a permissão antes
    read(f) { try { chmodSync(f, 0o600); } catch { /* Windows */ } return readFileSync(f, 'utf8'); },
    // apaga um arquivo assim que deixa de ser necessário (menos tempo de texto puro em disco)
    discard(f) { try { unlinkSync(f); } catch { /* já não existe */ } },
    cleanup() {
      if (done) return; done = true; active.delete(w);
      try { for (const n of readdirSync(dir)) { try { unlinkSync(join(dir, n)); } catch { /* segue */ } } rmdirSync(dir); } catch { /* já removido */ }
    }
  };
  active.add(w); hook();
  return w;
}

// Procura resíduos no temporário. Só lê o marcador; nunca lê nem devolve conteúdo de dados.
//   status: 'ativo' (dono vivo) | 'abandonado' (dono morto e só arquivos esperados: pode limpar)
//           | 'desconhecido' (sem marcador válido, outro host, arquivos inesperados, link...): só relatar
export function scanResidue({ base = tmpdir(), alive = isAlive, host = hostname() } = {}) {
  const out = [];
  let names = [];
  try { names = readdirSync(base); } catch { return out; }
  for (const name of names) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const dir = join(base, name);
    const r = { name, dir, status: 'desconhecido', reason: '' };
    out.push(r);
    let st; try { st = lstatSync(dir); } catch { r.reason = 'inacessível'; continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) { r.reason = 'não é diretório comum'; continue; }
    if (!DIR_RE.test(name)) { r.reason = 'nome fora do padrão atual (versão anterior?): confira e remova manualmente'; continue; }
    let m; try { m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')); } catch { r.reason = 'sem marcador válido'; continue; }
    if (m.tool !== MARKER_TOOL || !Number.isInteger(m.pid)) { r.reason = 'marcador inválido'; continue; }
    if (m.host !== host) { r.reason = 'criado em outra máquina'; continue; }
    let entries; try { entries = readdirSync(dir); } catch { r.reason = 'inacessível'; continue; }
    const regular = n => { try { const s = lstatSync(join(dir, n)); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
    const bad = entries.filter(n => n !== MARKER && !(FILE_RE.test(n) && regular(n)));
    r.files = entries.filter(n => n !== MARKER).length; r.pid = m.pid; r.started_at = m.started_at;
    if (alive(m.pid)) { r.status = 'ativo'; r.reason = 'processo dono ainda em execução'; continue; }
    if (bad.length) { r.reason = `${bad.length} entrada(s) inesperada(s)`; continue; }
    r.status = 'abandonado'; r.reason = 'processo dono não existe mais';
  }
  return out;
}

// Remove só áreas 'abandonado' (rechecadas na remoção), arquivo por arquivo, sem remoção recursiva cega.
export function cleanResidue(opts = {}) {
  const removed = [], kept = [];
  for (const r of scanResidue(opts)) {
    if (r.status !== 'abandonado') { kept.push(r); continue; }
    try {
      for (const n of readdirSync(r.dir)) { if (n !== MARKER && !FILE_RE.test(n)) throw new Error('mudou'); unlinkSync(join(r.dir, n)); }
      rmdirSync(r.dir); removed.push(r);
    } catch { r.status = 'desconhecido'; r.reason = 'mudou durante a limpeza; não removido'; kept.push(r); }
  }
  return { removed, kept };
}

// Mensagem de erro segura: tira URLs (o `d1 export` imprime uma URL assinada que baixa o banco em claro) e literais
// entre aspas (podem ser dados) e limita o tamanho.
export const redact = (s, max = 300) => String(s ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '‹url omitida›').replace(/'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"/g, '‹omitido›').replace(/X'[0-9a-fA-F]*'/g, '‹omitido›').slice(0, max);
