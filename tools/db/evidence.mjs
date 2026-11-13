// Registro de evidências das operações remotas (Etapa 6.5-A): JSON Lines, um arquivo por dia, FORA do repositório e do
// OneDrive (TATAME_EVIDENCE_DIR). Toda operação remota real (sem --dry-run) exige o diretório: sem registro, não executa.
//
// Cada linha: horário, execução, sequência, evento, operação, ambiente, nome e UUID do banco, versão do wrangler, commit,
// e conforme o evento: comando (com SQL e caminhos substituídos por tamanho + SHA-256), código de saída, impressão digital
// do schema (antes/depois), resultado. NUNCA: tokens, senhas, códigos, conteúdo de SQL, saída do wrangler, dados de linhas.
import { appendFileSync, existsSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { isAbsolute, join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forbiddenLocation } from '../backup/storage.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export class EvidenceError extends Error { constructor(m) { super(m); this.name = 'GuardError'; } }
const fail = m => { throw new EvidenceError(m); };
const sha = s => createHash('sha256').update(s).digest('hex');

// Segredos conhecidos do ambiente: qualquer valor de variável com nome de credencial é removido de tudo que é impresso
// ou registrado. Complementa (não substitui) a regra de nunca registrar saída do wrangler.
const SECRET_VAR = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH_KEY|CREDENTIAL|PRIVATE|_KEY$/i;
export function scrubber(envVars = process.env) {
  const values = Object.entries(envVars || {}).filter(([k, v]) => SECRET_VAR.test(k) && typeof v === 'string' && v.length >= 6).map(([, v]) => v).sort((a, b) => b.length - a.length);
  return text => {
    let s = String(text ?? '');
    for (const v of values) s = s.split(v).join('‹segredo omitido›');
    return s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ‹segredo omitido›')
      .replace(/\b(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY|X-Auth-Key|X-Auth-Email|TATAME_CHECK_PASSWORD)\s*[=:]\s*\S+/gi, '$1=‹segredo omitido›');
  };
}

// Comando para o registro: SQL vira tamanho + SHA-256; arquivos viram nome-base + SHA-256 do conteúdo (se legível).
export function describeCommand(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--command' && i + 1 < args.length) { const v = String(args[++i]); out.push(a, `‹sql ${v.length} caracteres, sha256 ${sha(v).slice(0, 16)}›`); continue; }
    if ((a === '--file' || a === '--output') && i + 1 < args.length) {
      const f = String(args[++i]); let h = 'ainda inexistente';
      try { if (existsSync(f) && statSync(f).isFile()) h = 'sha256 ' + sha(readFileSync(f)).slice(0, 16); } catch { h = 'ilegível'; }
      out.push(a, `‹arquivo ${a === '--output' ? 'temporário' : basename(f)}, ${h}›`); continue;
    }
    if (a === '-c' && i + 1 < args.length) { out.push(a, 'db/' + basename(String(args[++i]))); continue; }
    out.push(a);
  }
  return out;
}

function gitCommit() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    return dirty ? head + '+alterações-locais' : head;
  } catch { return 'desconhecido'; }
}

export function validateEvidenceDir(raw, envVars = process.env) {
  if (!raw || !String(raw).trim()) fail('TATAME_EVIDENCE_DIR não está definido. Toda operação remota é registrada; sem diretório de evidências escolhido de propósito (fora do repositório e do OneDrive), nada é executado.');
  const dir = String(raw).trim();
  if (!isAbsolute(dir)) fail('TATAME_EVIDENCE_DIR precisa ser um caminho absoluto.');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail('TATAME_EVIDENCE_DIR não existe ou não é um diretório (o wrapper não o cria sozinho).');
  const why = forbiddenLocation(dir, envVars);
  if (why) fail(`TATAME_EVIDENCE_DIR está ${why}. As evidências ficam fora do repositório e do OneDrive.`);
  return dir;
}

// Abre o registro. `required`: sem diretório válido, lança (falha fechada). Sem `required` e sem diretório: registro nulo.
export function openEvidence({ envVars = process.env, required, base = {}, now = () => new Date() }) {
  const raw = envVars?.TATAME_EVIDENCE_DIR;
  if (!required && !raw) return { enabled: false, record: () => {}, file: null, runId: null };
  const dir = validateEvidenceDir(raw, envVars);
  const scrub = scrubber(envVars);
  const runId = now().toISOString().replace(/[-:.]/g, '').slice(0, 15) + '-' + randomBytes(4).toString('hex');
  const file = join(dir, `evidencias-${now().toISOString().slice(0, 10)}.jsonl`);
  const commit = gitCommit();
  let seq = 0;
  const record = (event, data = {}) => {
    const line = JSON.stringify({ ts: now().toISOString(), run_id: runId, seq: ++seq, event, ...base, commit, ...data });
    try { appendFileSync(file, scrub(line) + '\n', { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* Windows */ } }
    catch { fail('Não foi possível gravar o registro de evidências; a operação foi interrompida.'); }
  };
  return { enabled: true, record, file, runId };
}
