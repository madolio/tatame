// Travas do wrapper de banco (tools/db.mjs). Usa um executor falso: cada recusa precisa provar que NENHUM
// comando chegou ao wrangler. Os IDs abaixo são fictícios e existem só neste teste.
import assert from 'node:assert';
import { main, resolveTarget, loadEnvironments, OPS } from '../tools/db/ops.mjs';
import { infoReply, migrationsCfg, identityCfg, evidenceDir } from './cf_sim.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const ID = { staging: '11111111-1111-4111-8111-111111111111', rt: '22222222-2222-4222-8222-222222222222', prod: '33333333-3333-4333-8333-333333333333', other: '44444444-4444-4444-8444-444444444444' };
const ENVS = {
  local: { kind: 'local' },
  staging: { kind: 'remote', database_name: 'tatame-staging', database_id: ID.staging },
  'restore-test': { kind: 'remote', database_name: 'tatame-restore-test', database_id: ID.rt, disposable: true },
  production: { kind: 'remote', database_name: 'tatame-prod-ficticio', database_id: ID.prod, protected: true },
  semid: { kind: 'remote', database_name: 'tatame-x', database_id: 'PENDENTE' },
  semnome: { kind: 'remote', database_name: 'PENDENTE', database_id: ID.other }
};
const ACC = { 'tatame-staging': ID.staging, 'tatame-restore-test': ID.rt, 'tatame-prod-ficticio': ID.prod };
const EVD = evidenceDir();
function harness({ tty = true, answer = 'tatame-prod-ficticio', envs = ENVS } = {}) {
  const calls = [], out = [], err = [];
  const deps = {
    environments: () => envs, wranglerVersion: () => '4.155.0', migrationsConfigText: () => migrationsCfg(envs), identityConfigText: identityCfg,
    exec: (args) => { calls.push(args); return infoReply(args, { account: ACC, cfgEnvs: envs }) || { status: 0, stdout: '{"bookmark":"x"}', stderr: '' }; },
    isTTY: () => tty, ask: async () => answer,
    out: m => out.push(m), err: m => err.push(m), env: { TATAME_EVIDENCE_DIR: EVD }
  };
  return { deps, calls, out, err, run: async argv => main(argv, deps) };
}
const refused = async (argv, why, opt) => {
  const h = harness(opt); const code = await h.run(argv);
  ok(code === 3 && h.calls.length === 0 && /RECUSADO/.test(h.err.join('\n')), `recusa sem executar nada: ${why}`);
  return h;
};

await refused(['timetravel-info'], 'sem --env');
await refused(['timetravel-info', '--env'], '--env sem valor');
await refused(['timetravel-info', '--env', 'prod'], 'ambiente desconhecido');
await refused(['timetravel-info', '--env', '_leia'], 'chave interna usada como ambiente');
await refused(['nada', '--env', 'staging'], 'operação desconhecida');
await refused(['timetravel-info', '--env', 'local'], 'operação remota com ambiente local');
await refused(['export', '--env', 'local', '--sqlite', 'x.db'], 'export (remoto) com ambiente local');
await refused(['check', '--env', 'local'], 'local sem --sqlite');
await refused(['timetravel-info', '--env', 'semid'], 'ambiente sem database_id');
await refused(['timetravel-info', '--env', 'semnome'], 'ambiente sem nome de banco');
await refused(['timetravel-info', '--env', 'production'], 'produção sem --confirm-production');
await refused(['timetravel-info', '--env', 'production', '--confirm-production'], 'produção com confirmação vazia');
await refused(['timetravel-info', '--env', 'production', '--confirm-production=tatame-staging'], 'produção com nome errado');
await refused(['timetravel-info', '--env', 'production', '--confirm-production=tatame-prod-ficticio'], 'produção sem terminal interativo', { tty: false });
await refused(['timetravel-info', '--env', 'production', '--confirm-production=tatame-prod-ficticio'], 'produção com nome redigitado errado', { answer: 'tatame-prod' });
await refused(['import', '--env', 'production', '--confirm-production=tatame-prod-ficticio', '--file', 'b.sql'], 'import com produção como destino (mesmo confirmado)');
await refused(['restore-test', '--env', 'production', '--confirm-production=tatame-prod-ficticio'], 'restore-test com produção como destino');
await refused(['restore-test', '--env', 'staging'], 'restore-test com staging como destino');
// Arquivos reais do repositório (IDs preenchidos na 6.5-B, bloco A). A conta simulada não conhece esses UUIDs: o único
// comando que pode chegar ao executor é a consulta de identidade (d1 info); nada além disso é executado.
{ const h = harness({ envs: loadEnvironments() }); delete h.deps.migrationsConfigText; delete h.deps.identityConfigText;
  const code = await h.run(['timetravel-info', '--env', 'staging']);
  ok(code === 3 && h.calls.length > 0 && h.calls.every(a => a[0] === 'd1' && a[1] === 'info') && /RECUSADO/.test(h.err.join('\n')), 'arquivos reais: staging com identidade não conferida na conta é recusado; só d1 info chega ao executor'); }
await refused(['timetravel-info', '--env', 'production'], 'arquivos reais: produção sem --confirm-production', { envs: loadEnvironments() });
await refused(['timetravel-info', '--env', 'production', '--confirm-production=PENDENTE'], 'arquivos reais: produção não é liberada digitando PENDENTE', { envs: loadEnvironments() });
await refused(['timetravel-info', '--env', 'production', '--confirm-production=tatame-db'], 'arquivos reais: produção sem terminal interativo', { envs: loadEnvironments(), tty: false });
await refused(['import', '--env', 'production', '--confirm-production=tatame-db', '--file', 'b.sql'], 'arquivos reais: import com produção como destino', { envs: loadEnvironments(), answer: 'tatame-db' });

// nenhuma variável de ambiente libera produção: o resolvedor só olha argumentos e o arquivo de ambientes
{
  const saved = { ...process.env };
  Object.assign(process.env, { TATAME_ENV: 'production', TATAME_CONFIRM_PRODUCTION: 'tatame-prod-ficticio', CI: '1' });
  await refused(['timetravel-info'], 'variáveis de ambiente não selecionam nem confirmam produção');
  process.env = saved;
}
// caminhos permitidos: mostram ambiente, banco, ID abreviado, versão e operação antes de executar
{
  const h = harness(); const code = await h.run(['timetravel-info', '--env', 'staging', '--dry-run']);
  ok(code === 0 && h.calls.length === 0, '--dry-run não executa nada');
  ok(/ambiente: staging \| banco: tatame-staging \| id: 11111111… \| wrangler 4\.155\.0 \| operação: timetravel-info/.test(h.out[0]), 'cabeçalho mostra ambiente, banco, ID abreviado, versão e operação');
  ok(!h.out.join('\n').includes(ID.staging), 'o ID completo não é impresso');
}
{
  const h = harness(); const code = await h.run(['timetravel-info', '--env', 'staging']);
  const tt = h.calls.filter(a => a[1] !== 'info').map(a => a.join(' ').replace(/ -c \S+/, ' -c CFG'));
  ok(code === 0 && h.calls.length === 3 && h.calls.slice(0, 2).every(a => a[1] === 'info') && tt.length === 1 && tt[0] === 'd1 time-travel info tatame-staging -c CFG --env staging --json',
    'staging válido: identidade (2 consultas d1 info) e depois exatamente o comando esperado, com a configuração isolada e --env');
}
{
  const h = harness(); const code = await h.run(['timetravel-info', '--env', 'production', '--confirm-production=tatame-prod-ficticio']);
  ok(code === 0 && h.calls.length === 3 && /PRODUÇÃO/.test(h.out[0]), 'produção só passa com nome exato, TTY e redigitação; cabeçalho marca PRODUÇÃO');
}
ok(Object.entries(OPS).filter(([, m]) => m.dest).every(([, m]) => !m.dest.includes('production')), 'nenhuma operação de destino aceita produção');
assert.throws(() => resolveTarget('import', { env: 'production', 'confirm-production': 'tatame-prod-ficticio' }, ENVS));
console.log('\nTRAVAS DO WRAPPER OK');
