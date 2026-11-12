# Tatame — gestão de academia de jiu-jitsu

Sistema web para o professor acompanhar os alunos: frequência, chamada, técnicas ensinadas, nível de aprendizado, nível de experiência, dificuldades e prontidão para grau e faixa.

**Produção:** https://tatame-2rx.pages.dev (Cloudflare Pages + D1)

## Arquitetura
| Camada | Tecnologia | Papel |
|---|---|---|
| Interface | HTML, CSS e JavaScript puro (`web/app.js`, `web/charts.js`) | Telas do professor, gráficos SVG próprios, responsivo |
| API | Cloudflare Pages Functions (`web/_worker.js`) | Autenticação, autorização, validação, regras de negócio e indicadores |
| Banco | Cloudflare D1 (SQLite) | `db/schema.sql` + `db/seed_tecnicas.sql` (70 técnicas) |

## Segurança
- **Senhas:** PBKDF2-SHA256 com 100 mil iterações e sal aleatório.
- **Sessão:** token aleatório de 256 bits, guardado no banco só como hash SHA-256. Fica em cookie `HttpOnly; Secure; SameSite=Strict`, com validade de 30 dias.
- **CSRF:** toda escrita exige o cabeçalho `x-tatame`. **Força bruta:** 8 tentativas em 15 minutos por e-mail ou por IP.
- **Perfis:** o *administrador* gerencia a equipe, os critérios e as exclusões; o *professor* faz o dia a dia. A regra vale no servidor (`tests/permissions.mjs` confere toda rota):
  - Professor: chamada (criar, editar), alunos (cadastrar, editar dados), avaliar técnicas, graduar, horários (criar, editar). Exclui chamada e desfaz graduação só do que ele mesmo registrou nos últimos 7 dias.
  - Só administrador: excluir aluno, horário e chamadas de outros; corrigir datas de faixa/grau e aulas anteriores ao sistema; catálogo de técnicas; exportar CSV; critérios; nome da academia; equipe.
- **Força bruta:** 8 tentativas em 15 minutos por par (e-mail, IP) e 30 por IP. O tempo de resposta é o mesmo para e-mail inexistente.
- **Sessão:** renova sozinha quando faltam menos de 15 dias, até o teto de 90 dias desde o login.
- **Recuperação de senha:** professor: o administrador troca em Equipe. Administrador: código de uso único (30 min, só o hash no banco) gerado pelo operador com `tools/reset-code.mjs` e informado na tela de login ("Tenho um código de recuperação"). Procedimento em `docs/recuperacao-de-senha.md`.
- **Primeiro acesso:** protegido por código de ativação, que é apagado depois do uso.
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
- `tests/api_test.mjs`: 82 verificações da API (inclui recuperação de senha), rodando o Worker real sobre um emulador de D1 (`tests/d1shim.mjs`, node:sqlite).
- `tests/permissions.mjs`: matriz de acesso (toda rota x anônimo, professor, administrador). `tests/migration.mjs`: aplica e reverte as migrações 001 (recuperação de senha) e 002 (marcador de chamada) num banco no formato anterior.
- `tests/parity.mjs`: paridade dos cálculos. Compara o Worker, campo a campo, com uma implementação de referência independente (`tests/ref/`), com relógio fixo; divergências conhecidas em `tests/ref/divergencias.json`. Regras em `docs/regras-calculos.md`. `--detalhe` lista cada divergência.
- `tests/e2e.mjs`: fluxo completo no navegador (Playwright), com 11 alunos e 12 semanas de aulas simuladas.
