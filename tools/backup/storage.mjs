// Armazenamento de backups, independente de fornecedor.
// Interface de um adaptador:
//   put(boxFile, manifest) -> id       grava o backup CRIPTOGRAFADO (.tbk, ver crypto.mjs) e uma cópia do manifesto
//                                      para listagem; nunca sobrescreve. Texto puro nunca chega ao armazenamento.
//   list() -> [manifest]               manifestos (com .id e .status), do mais novo ao mais antigo
//   get(id) -> { boxPath, manifest }   caminho local do .tbk e o manifest.json EXTERNO (não autenticado: quem
//                                      decide é o manifesto de dentro do .tbk, comparado na abertura)
//   updateStatus(id, patch)            resultados operacionais (ex.: restore-test) em status.json, fora do manifesto
//   remove(id)                         apaga um backup (usado só pela retenção)
// Hoje só existe o adaptador `dir` (diretório local). Um adaptador R2 (ou outro) implementa a mesma interface
// e é escolhido em createStorage sem mudar export/verify/import.
//
// Backups contêm dados pessoais (alunos, equipe) e hashes de senha/sessão: o diretório precisa ser escolhido de
// propósito (TATAME_BACKUP_DIR), fora do repositório e fora do OneDrive (sincronização para a nuvem pessoal).
import { existsSync, statSync, realpathSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, accessSync, constants, chmodSync } from 'node:fs';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export class StorageError extends Error { constructor(m) { super(m); this.name = 'StorageError'; } }
const fail = m => { throw new StorageError(m); };
const ID_RE = /^[a-z0-9-]+-\d{8}T\d{6}Z(-[a-z0-9]+)?$/;

const within = (child, parent) => { const c = child.toLowerCase(), p = parent.toLowerCase().replace(/[\\/]+$/, ''); return c === p || c.startsWith(p + sep.toLowerCase()) || c.startsWith(p + '/'); };

// Valida o diretório. `envVars` permite testar sem mexer no ambiente real.
export function validateDir(raw, envVars = process.env) {
  if (!raw || !String(raw).trim()) fail('TATAME_BACKUP_DIR não está definido. Nenhum backup é gravado sem um diretório escolhido de propósito (ver docs/operacao-banco.md).');
  const dir = String(raw).trim();
  if (!isAbsolute(dir)) fail('TATAME_BACKUP_DIR precisa ser um caminho absoluto.');
  if (/[\0]/.test(dir)) fail('TATAME_BACKUP_DIR inválido.');
  if (!existsSync(dir)) fail('TATAME_BACKUP_DIR não existe. Crie o diretório antes (o wrapper não cria diretórios de backup por conta própria).');
  if (!statSync(dir).isDirectory()) fail('TATAME_BACKUP_DIR não é um diretório.');
  const real = realpathSync(dir);
  if (within(real, REPO) || within(resolve(dir), REPO)) fail('TATAME_BACKUP_DIR está dentro do repositório. Backups nunca ficam no repositório.');
  const oneDriveRoots = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map(k => envVars[k]).filter(Boolean);
  if (/onedrive/i.test(real) || /onedrive/i.test(dir) || oneDriveRoots.some(r => within(real, r))) fail('TATAME_BACKUP_DIR está no OneDrive. Backups com dados pessoais não podem ir para a sincronização do OneDrive.');
  try { accessSync(real, constants.W_OK); const probe = join(real, `.tatame-probe-${process.pid}`); writeFileSync(probe, ''); rmSync(probe); }
  catch { fail('Sem permissão de escrita em TATAME_BACKUP_DIR.'); }
  return real;
}

export function dirAdapter(raw, envVars = process.env) {
  const root = validateDir(raw, envVars);
  const base = id => { if (!ID_RE.test(id)) fail(`Identificador de backup inválido: ${id}`); return join(root, id); };
  const readManifest = id => JSON.parse(readFileSync(join(base(id), 'manifest.json'), 'utf8'));
  const privateFile = f => { try { chmodSync(f, 0o600); } catch { /* Windows: ACL do diretório escolhido */ } };
  return {
    kind: 'dir', root,
    put(boxFile, manifest) {
      const stamp = manifest.created_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      let id = `${manifest.source_env}-${stamp}${manifest.anonymized ? '-anon' : ''}`;
      if (existsSync(join(root, id))) fail(`Já existe um backup com o identificador ${id}; nada foi sobrescrito.`);
      const d = join(root, id); mkdirSync(d);
      copyFileSync(boxFile, join(d, 'backup.tbk')); privateFile(join(d, 'backup.tbk'));
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...manifest, id }, null, 2)); privateFile(join(d, 'manifest.json'));
      return id;
    },
    list() {
      return readdirSync(root).filter(n => ID_RE.test(n) && existsSync(join(root, n, 'manifest.json')))
        .map(n => ({ ...readManifest(n), id: n, status: existsSync(join(root, n, 'status.json')) ? JSON.parse(readFileSync(join(root, n, 'status.json'), 'utf8')) : null })).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
    },
    get(id) { const d = base(id); if (!existsSync(join(d, 'backup.tbk'))) fail(`Backup não encontrado: ${id}`); return { boxPath: join(d, 'backup.tbk'), manifest: { ...readManifest(id), id } }; },
    status(id) { const f = join(base(id), 'status.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; },
    updateStatus(id, patch) { const f = join(base(id), 'status.json'); const cur = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; writeFileSync(f, JSON.stringify({ ...cur, ...patch }, null, 2)); privateFile(f); },
    remove(id) { rmSync(base(id), { recursive: true, force: true }); }
  };
}

// Escolha do adaptador. Sem configuração explícita, falha (não existe destino padrão).
export function createStorage(envVars = process.env) {
  const kind = envVars.TATAME_BACKUP_STORAGE || 'dir';
  if (kind === 'dir') return dirAdapter(envVars.TATAME_BACKUP_DIR, envVars);
  fail(`Armazenamento de backup desconhecido: ${kind}. Disponível: dir.`);
}

// ---------- retenção: 4 semanais + 3 mensais (por ambiente de origem e tipo) ----------
const isoWeek = iso => { const d = new Date(iso.slice(0, 10) + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); return `${y}-W${String(1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; };
// Mantém o backup mais recente de cada uma das 4 semanas mais recentes e de cada um dos 3 meses mais recentes.
export function retentionPlan(manifests, { weekly = 4, monthly = 3 } = {}) {
  const groups = new Map();
  for (const m of manifests) { const k = `${m.source_env}|${m.anonymized ? 'anon' : 'integral'}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const keep = new Set();
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => a.created_at < b.created_at ? 1 : -1);
    const pick = (keyOf, n) => { const seen = new Set(); for (const m of sorted) { const k = keyOf(m.created_at); if (seen.has(k)) continue; if (seen.size >= n) break; seen.add(k); keep.add(m.id); } };
    pick(isoWeek, weekly); pick(c => c.slice(0, 7), monthly);
  }
  return { keep: manifests.filter(m => keep.has(m.id)).map(m => m.id), remove: manifests.filter(m => !keep.has(m.id)).map(m => m.id) };
}
