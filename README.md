# Tatame — gestão de academia de jiu-jitsu

Sistema web para o professor acompanhar os alunos: frequência, chamada, técnicas ensinadas, nível de aprendizado, nível de experiência, dificuldades e prontidão para grau e faixa.

**Produção:** https://tatame-2rx.pages.dev (Cloudflare Pages + D1)

## Arquitetura
| Camada | Tecnologia | Papel |
|---|---|---|
| Interface | HTML, CSS e JavaScript puro (`web/app.js`, `web/charts.js`) | Telas do professor, gráficos SVG próprios, responsivo |
| API | Cloudflare Pages Functions (`web/_worker.js`) | Autenticação, autorização, validação, regras de negócio e indicadores |
| Banco | Cloudflare D1 (SQLite) | `db/schema.sql` + `db/seed_tecnicas.sql` (70 técnicas); migrações em `db/migrations/` (reversões em `db/rollbacks/`), operadas por `tools/db.mjs` conforme [docs/operacao-banco.md](docs/operacao-banco.md) |

## Segurança
- **Senhas:** PBKDF2-SHA256 com 100 mil iterações e sal aleatório.
- **Sessão:** token aleatório de 256 bits, guardado no banco só como hash SHA-256. Fica em cookie `HttpOnly; Secure; SameSite=Strict`, com validade de 30 dias.
- **CSRF:** toda escrita exige o cabeçalho `x-tatame`. **Força bruta:** 8 tentativas em 15 minutos por e-mail ou por IP.
- **Perfis:** o *administrador* gerencia a equipe, os critérios e as exclusões; o *professor* faz o dia a dia. A regra vale no servidor (`tests/permissions.mjs` confere toda rota):
  - Professor: chamada (criar), alunos (cadastrar, editar dados), avaliar técnicas, graduar, horários (criar, editar). Edita e exclui chamada e desfaz graduação só do que ele mesmo registrou há menos de 7 dias (autoria e data vêm do banco). Toda edição e exclusão de chamada fica em `audit_log` com o estado anterior; as demais ações administrativas também são auditadas (`docs/auditoria.md`).
  - Só administrador: excluir aluno (só cadastro sem presenças, graduações ou avaliações; com histórico, inativar) e horário; editar ou excluir chamadas de outros ou com 7 dias ou mais; corrigir datas de faixa/grau e aulas anteriores ao sistema; catálogo de técnicas; exportar CSV; critérios; nome da academia; equipe.
- **Força bruta:** 8 tentativas em 15 minutos por par (e-mail, IP) e 30 por IP. O tempo de resposta é o mesmo para e-mail inexistente.
- **Sessão:** renova sozinha quando faltam menos de 15 dias, até o teto de 90 dias desde o login.
- **Login (força bruta):** limites de 15 min por (e-mail, rede) = 8, por rede = 30 (IPv4 inteiro; IPv6 agrupado por /64) e por conta = 20 somando todas as redes. O limite da conta vale só para aparelho desconhecido: o navegador onde a pessoa já entrou guarda um cookie de aparelho conhecido (HMAC com chave derivada por HKDF do hash da senha, 90 dias, só em `/api/login`), que perde a validade quando a senha muda. Auditoria: `login_ok` e `login_locked` (uma vez por limite atingido), sem senha, hash ou cookie. Pendente (V5): cada senha errada ainda grava 2 linhas no banco.
- **Senhas novas:** 10 a 128 caracteres; recusa senhas comuns (lista embutida), igual ao e-mail ou ao nome e um único caractere repetido; sem exigência de maiúsculas/símbolos. Senhas antigas continuam valendo até o dono trocar.
- **Troca de senha:** a própria (`/api/me/password`) confere a senha atual no máximo 5 vezes por conta em 15 min, de qualquer IP (429 depois; a vaga é reservada antes do cálculo, então requisições simultâneas não passam do limite); a nova precisa ser diferente da atual. Toda troca (própria ou pelo administrador) encerra as sessões da pessoa e apaga códigos de recuperação pendentes no mesmo batch. Auditoria: `password_changed`, `staff_password_reset` e `password_change_failed` (uma vez por limite esgotado).
- **Recuperação de senha:** professor: o administrador troca em Equipe. Administrador: código de uso único (30 min, só o hash no banco) gerado pelo operador com `tools/reset-code.mjs --env <ambiente>` (pelo wrapper de banco; produção bloqueada até haver procedimento autorizado) e informado na tela de login ("Tenho um código de recuperação"). Procedimento em `docs/recuperacao-de-senha.md`.
- **Primeiro acesso:** só com código de ativação gerado pelo operador (`tools/setup-code.mjs --env <ambiente>`, pelo wrapper de banco; no banco fica só o hash, com validade). Sem código configurado o setup fica fechado; o primeiro administrador e o consumo do código são uma única transação. Procedimento em `docs/nova-instalacao.md`.
- **Entradas da API:** tipos, identificadores (UUID), datas do calendário e listas são conferidos antes do banco (400 em vez de 500); corpo até 256 KB (413); chamada até 300 alunos e 40 técnicas, até 100 avaliações por vez e 1 regra por faixa. Listas vão ao banco como um único parâmetro JSON (`json_each`), com número de comandos fixo.
- **Cabeçalhos:** CSP, X-Frame-Options e nosniff. Toda entrada é validada no servidor.

## Regras de negócio
- **Próxima graduação:**
  - Até 4 graus por faixa (6 na preta). Com 4 graus, o próximo passo é a faixa.
  - Abaixo de 16 anos segue o caminho infantil (cinza, amarela, laranja, verde) até a azul.
- **Critérios (editáveis):**
  - Meses e aulas desde o último grau.
  - Meses e aulas na faixa.
  - % do currículo com nível ≥ 3.
  - Idade mínima.
  - Os padrões de tempo mínimo de faixa e de idade seguem o Sistema Geral de Graduação da IBJJF: azul 2 anos, roxa 1,5 ano, marrom 1 ano; idades azul/roxa 16, marrom 18, preta 19.
- **Aulas antes do sistema:** contam para grau e faixa, zeram a cada graduação e são restauradas se a graduação for desfeita.
- **Nível de aprendizado:** média do nível (0–5) nas técnicas do currículo até a faixa do aluno:
  - 0 = não visto, 1 = visto em aula, 2 = executa com ajuda, 3 = executa sozinho, 4 = aplica no rola, 5 = domina.
  - Quem estava presente na aula recebe nível 1 nas técnicas passadas, sem rebaixar ninguém.
- **Nível de experiência:** aulas registradas + aulas anteriores + meses de experiência anterior × 8.
  - Faixas: Novato < 30, Iniciante < 100, Intermediário < 250, Avançado < 500, Experiente 500+.
- **Dificuldade:** técnica vista em 2+ aulas e ainda com nível ≤ 2.
- **Ausência:** aluno ativo sem presença há 14 dias ou mais.
- **Graduação fora dos critérios:** é permitida com confirmação e fica registrada (`criteria_met = 0`).

## Testes
- `tests/api_test.mjs`: 115 verificações da API (inclui recuperação de senha), rodando o Worker real sobre um emulador de D1 (`tests/d1shim.mjs`, node:sqlite).
- `tests/permissions.mjs`: matriz de acesso (toda rota x anônimo, professor, administrador). `tests/migration.mjs`: aplica e reverte as migrações 001 (recuperação de senha) e 002 (marcador de chamada) num banco no formato anterior.
- `tests/parity.mjs`: paridade dos cálculos. Compara o Worker, campo a campo, com uma implementação de referência independente (`tests/ref/`), com relógio fixo; divergências conhecidas em `tests/ref/divergencias.json`. Regras em `docs/regras-calculos.md`. `--detalhe` lista cada divergência.
- `tests/db_identity.mjs`: identidade do banco na Cloudflare (simulada), bloqueio da produção por UUID, `sql` e `timetravel-restore` protegidos, registro de evidências, nenhum caminho fora do wrapper e nenhum vazamento de credenciais. `tests/staging_check.mjs`: verificação do app de staging por HTTP (cenários de administradores, auditoria e exclusão de alunos) contra o Worker em processo. `tests/db_synthetic.mjs`: banco sintético `--base` e o caminho baseline → migrate.
- `tests/db_guard.mjs`, `tests/schema_check.mjs`, `tests/db_migrate.mjs`, `tests/backup.mjs`: operação do banco (travas contra produção, verificação de schema e linha de base, migrações, backup, anonimização e restauração validada com o Worker real). Procedimento em [docs/operacao-banco.md](docs/operacao-banco.md).
- `tests/e2e.mjs`: fluxo completo no navegador (Playwright), com 11 alunos e 12 semanas de aulas simuladas.
