// Identidade do banco remoto (Etapa 6.5-A). Nome de ambiente e nome de banco NÃO identificam um banco: o que identifica é
// o UUID real que a Cloudflare devolve. Antes do primeiro comando remoto de cada execução, o wrapper confere:
//
//   1. Arquivos coerentes (sem rede): db/environments.json e db/wrangler.migrations.jsonc com o mesmo nome e UUID por
//      ambiente; db/wrangler.identity.jsonc sem nenhum banco; IDs e nomes distintos entre ambientes; o UUID e o nome da
//      produção CONHECIDOS (sem eles não há como provar que o destino não é a produção) e diferentes do destino.
//   2. Consulta A, pelo UUID do arquivo:  d1 info <nome> -c db/wrangler.migrations.jsonc --env <amb> --json
//      O wrangler 4.155.0 (getDatabaseByNameOrBinding) usa o database_id do arquivo SEM verificar a conta; depois pede
//      à API /d1/database/<uuid> e devolve o nome REAL daquele UUID. Se o UUID do arquivo for o da produção, o nome
//      devolvido é o da produção.
//   3. Consulta B, pelo nome:  d1 info <nome> -c db/wrangler.identity.jsonc --json
//      Sem banco na configuração, o wrangler procura o nome na conta (/d1/database/<nome>) e devolve o UUID real.
//   4. A e B precisam devolver exatamente o nome e o UUID esperados, e nenhum dos dois pode ser o da produção (salvo se
//      o próprio destino é a produção, já confirmada pelas travas de cli.mjs).
//
// Qualquer falha (autenticação, API indisponível, banco inexistente, saída ilegível, divergência) recusa a operação.
// O texto de erro do wrangler NÃO é repassado: só a classificação (pode conter caminhos, contas ou trechos de SQL).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const IDENTITY_CONFIG = ROOT + 'db/wrangler.identity.jsonc';

export class IdentityError extends Error { constructor(m) { super(m); this.name = 'GuardError'; } }
const refuse = m => { throw new IdentityError(m); };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PENDING = v => !v || /PENDENTE/i.test(String(v));
export const short = id => String(id || '').slice(0, 8) + '…';
const stripJsonc = t => t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const MIGRATIONS_TABLE = 'd1_migrations';

// Configuração isolada das migrações: tem de espelhar db/environments.json e não pode ser configuração de Pages.
export function checkMigrationsConfig(envs, text = readFileSync(ROOT + 'db/wrangler.migrations.jsonc', 'utf8')) {
  let cfg; try { cfg = JSON.parse(stripJsonc(text)); } catch { return ['db/wrangler.migrations.jsonc ilegível']; }
  const problems = [];
  const walk = (o, path) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'pages_build_output_dir') problems.push(`chave proibida ${path}${k}`); walk(v, `${path}${k}.`); } };
  walk(cfg, '');
  if (cfg.d1_databases) problems.push('d1_databases no nível de cima (sem --env apontaria para um banco)');
  for (const [name, env] of Object.entries(envs)) {
    if (name.startsWith('_') || env.kind !== 'remote') continue;
    const db = cfg.env?.[name]?.d1_databases;
    if (!Array.isArray(db) || db.length !== 1) { problems.push(`ambiente ${name}: falta exatamente um d1_databases`); continue; }
    const d = db[0];
    if (d.database_name !== env.database_name || d.database_id !== env.database_id) problems.push(`ambiente ${name}: nome/ID diferentes de db/environments.json`);
    if (d.migrations_dir !== 'migrations' || (d.migrations_table ?? MIGRATIONS_TABLE) !== MIGRATIONS_TABLE || d.migrations_pattern) problems.push(`ambiente ${name}: migrations_dir deve ser "migrations" (db/migrations), tabela ${MIGRATIONS_TABLE}, sem migrations_pattern`);
  }
  for (const name of Object.keys(cfg.env || {})) if (!envs[name] || envs[name].kind !== 'remote') problems.push(`ambiente ${name} existe só em db/wrangler.migrations.jsonc`);
  return problems;
}

// Configuração da consulta por nome: não pode ter banco nenhum (senão o wrangler devolveria o UUID do arquivo, não o real).
export function checkIdentityConfig(text) {
  let cfg; try { cfg = JSON.parse(stripJsonc(text)); } catch { return ['db/wrangler.identity.jsonc ilegível']; }
  const s = JSON.stringify(cfg);
  const problems = [];
  if (/d1_databases|database_id|pages_build_output_dir/.test(s)) problems.push('db/wrangler.identity.jsonc não pode declarar bancos nem ser configuração de Pages');
  if (cfg.env) problems.push('db/wrangler.identity.jsonc não pode ter ambientes');
  return problems;
}

// Checagens sem rede, antes de qualquer comando remoto. Devolve { prodId, prodName } da produção conhecida.
export function staticIdentityChecks(target, envs, { migrationsText, identityText }) {
  const problems = [...checkMigrationsConfig(envs, migrationsText), ...checkIdentityConfig(identityText)];
  if (problems.length) refuse('Configuração inconsistente; nada foi executado: ' + problems.join('; '));
  const prod = envs.production;
  if (!prod || prod.kind !== 'remote' || PENDING(prod.database_id) || !UUID.test(prod.database_id) || PENDING(prod.database_name) || !NAME.test(prod.database_name))
    refuse('O nome e o UUID reais da produção não estão em db/environments.json. Sem eles não há como provar que o destino não é a produção; nenhuma operação remota é liberada. Preencha com os valores copiados do painel (só leitura).');
  if (target.name !== 'production') {
    if (String(target.database_id).toLowerCase() === String(prod.database_id).toLowerCase()) refuse(`O UUID configurado para ${target.name} é o da PRODUÇÃO. Nada foi executado.`);
    if (target.database_name === prod.database_name) refuse(`O nome de banco configurado para ${target.name} é o da PRODUÇÃO. Nada foi executado.`);
  }
  const remotes = Object.entries(envs).filter(([k, e]) => !k.startsWith('_') && e.kind === 'remote' && !PENDING(e.database_id));
  const ids = remotes.map(([, e]) => String(e.database_id).toLowerCase()), names = remotes.map(([, e]) => e.database_name);
  if (new Set(ids).size !== ids.length) refuse('Dois ambientes com o mesmo database_id em db/environments.json. Nada foi executado.');
  if (new Set(names).size !== names.length) refuse('Dois ambientes com o mesmo nome de banco em db/environments.json. Nada foi executado.');
  return { prodId: String(prod.database_id).toLowerCase(), prodName: prod.database_name };
}

// Classificação da falha do wrangler. Só a categoria sai daqui; o texto bruto fica descartado.
export function classifyFailure(r) {
  const t = `${r?.stderr || ''}\n${r?.stdout || ''}`;
  if (/not logged in|wrangler login|authenticat|CLOUDFLARE_API_TOKEN|access token|\[code: (10000|10001|9106|9109)\]|unauthori[sz]ed|\b401\b|\b403\b|permission/i.test(t)) return 'falha de autenticação na Cloudflare';
  if (/Couldn't find|not found|\[code: 7404\]|\b404\b/i.test(t)) return 'banco não encontrado na conta';
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|timed? ?out|\b5\d\d\b|unavailable|Internal Server Error/i.test(t)) return 'API da Cloudflare indisponível';
  return 'erro do wrangler';
}

// JSON de `d1 info --json` (só o objeto; avisos que porventura apareçam antes/depois são ignorados).
export function parseInfo(stdout) {
  const s = String(stdout || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { const j = JSON.parse(s.slice(a, b + 1)); return j && typeof j === 'object' ? { uuid: typeof j.uuid === 'string' ? j.uuid.toLowerCase() : null, name: typeof j.name === 'string' ? j.name : null } : null; } catch { return null; }
}

export const identityCommands = (target, migrationsConfig) => ({
  byConfig: ['d1', 'info', target.database_name, '-c', migrationsConfig, '--env', target.name, '--json'],
  byName: ['d1', 'info', target.database_name, '-c', IDENTITY_CONFIG, '--json']
});

// Consulta e compara. `run(args)` executa o wrangler (sem o portão de --dry-run) e devolve { status, stdout, stderr }.
// Devolve { uuid, name, checks } ou lança IdentityError.
export function verifyIdentity(target, envs, { run, migrationsConfig, prodId, prodName }) {
  const cmds = identityCommands(target, migrationsConfig);
  const ask = (args, what) => {
    let r;
    try { r = run(args); } catch { refuse(`Conferência de identidade (${what}) não pôde ser concluída: falha ao executar o wrangler. Nada foi executado.`); }
    if (!r || r.status !== 0) refuse(`Conferência de identidade (${what}) não pôde ser concluída: ${classifyFailure(r)}. Nada foi executado.`);
    const info = parseInfo(r.stdout);
    if (!info || !info.uuid || !info.name || !UUID.test(info.uuid)) refuse(`Conferência de identidade (${what}): resposta da Cloudflare ilegível. Nada foi executado.`);
    return info;
  };
  const want = { uuid: String(target.database_id).toLowerCase(), name: target.database_name };
  const isProdTarget = target.name === 'production';
  const a = ask(cmds.byConfig, 'pelo UUID do arquivo');
  // produção reconhecida já na primeira resposta: para aqui, sem mais nenhuma consulta
  if (!isProdTarget && (a.uuid === prodId || a.name === prodName)) refuse(`A Cloudflare identificou o destino ${target.name} como o banco de PRODUÇÃO (${a.name}, UUID ${short(a.uuid)}). Nada foi executado.`);
  const b = ask(cmds.byName, 'pelo nome na conta');
  if (!isProdTarget && [a.uuid, b.uuid].includes(prodId)) refuse(`A Cloudflare identificou o destino ${target.name} como o banco de PRODUÇÃO (UUID ${short(prodId)}). Nada foi executado.`);
  if (!isProdTarget && [a.name, b.name].includes(prodName)) refuse(`A Cloudflare devolveu o nome do banco de PRODUÇÃO para o destino ${target.name}. Nada foi executado.`);
  if (a.uuid !== want.uuid) refuse(`O wrangler não usou o UUID configurado (${short(want.uuid)}; usou ${short(a.uuid)}). Nada foi executado.`);
  if (a.name !== want.name) refuse(`O UUID configurado para ${target.name} (${short(want.uuid)}) pertence a outro banco na conta. Nada foi executado.`);
  if (b.uuid !== want.uuid) refuse(`O banco chamado ${want.name} na conta tem outro UUID (${short(b.uuid)}), diferente do configurado (${short(want.uuid)}). Nada foi executado.`);
  if (b.name !== want.name) refuse(`A consulta pelo nome devolveu outro banco. Nada foi executado.`);
  if (isProdTarget && a.uuid !== prodId) refuse('O UUID real não confere com o da produção configurada. Nada foi executado.');
  return { uuid: a.uuid, name: a.name, commands: cmds };
}

export const readText = f => readFileSync(f, 'utf8');
