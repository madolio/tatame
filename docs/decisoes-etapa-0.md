# Etapa 0 — Segurança e confiabilidade: registro das decisões técnicas

Registro para a documentação acadêmica (TCC). Cada item segue: problema, causa raiz, solução, arquivos, testes, resultado e justificativa. Base: `main` em `8bcea11`; trabalho na branch `etapa-0-seguranca`, 12 nov 2026.

## Classificação dos apontamentos da auditoria

| Apontamento | Situação em `8bcea11` | Tratado nesta etapa |
|---|---|---|
| Professor executa ações administrativas (excluir aula/horário, catálogo de técnicas, CSV, desfazer graduação, corrigir datas de faixa) | Confirmado e reproduzido (teste de matriz: 14 falhas) | Sim (0.1) |
| Sem recuperação de senha do administrador | Confirmado | Sim (0.2): código gerado por comando, entrega manual |
| Bloqueio de conta por e-mail a partir de qualquer IP | Confirmado | Sim (0.3) |
| Enumeração de e-mails pelo tempo de resposta | Confirmado (0,2 ms × 13 ms) | Sim (0.3) |
| Tentativas de login nunca apagadas | Confirmado (impacto baixo) | Sim (0.3) |
| Injeção de fórmula no CSV | Confirmado | Sim (0.4) |
| Técnica de aula sem presentes sem "última aula" | Confirmado e reproduzido | Sim (0.5) |
| Sessão fixa de 30 dias, sem renovação | Confirmado | Sim (0.6) |
| Sem trilha de auditoria | Confirmado | Não: exige tabela nova (depende do mecanismo de migração) |
| Sem documentação de deploy/backup/migração | Confirmado | Não: precisa do id do D1 e do nome do projeto Pages |
| Suíte de testes não roda no Windows | Confirmado e reproduzido (novo) | Sim (P.0) |
| Integridade de chamada, aulas e graduações | Revisado: escritas em `db.batch` (transação), duplicidade turma+dia por índice único, desfazer só a graduação mais recente, datas validadas | Sem alteração necessária |

Não reproduzidos ou parcialmente resolvidos: nenhum. Dependem de ambiente real: plano da conta Cloudflare (limite de CPU), latência do D1, limite de comandos por batch.

---

## P.0 — Suíte de testes portátil

- **Problema:** `npm test` não existia; os testes falhavam no Windows (`ENOENT C:\C:\...`) e o e2e apontava para `/opt/npm-tools` e `/tmp`.
- **Causa raiz:** `new URL(...).pathname` devolve `/C:/...` no Windows; caminhos absolutos do ambiente onde os testes nasceram.
- **Solução:** `fileURLToPath`, `os.tmpdir()`, navegador por variável `TATAME_CHROME` (ou pacote `playwright`), scripts `test`, `test:e2e`, `test:all`.
- **Arquivos:** `tests/api_test.mjs`, `tests/e2e.mjs`, `tests/fake_data.mjs`, `package.json`, `.gitignore`.
- **Testes:** as próprias suítes. **Resultado:** 41 verificações de API e 9 etapas de e2e passando no Windows a partir do repositório.
- **Justificativa:** nenhuma correção de segurança deveria ser feita sem rede de regressão reproduzível. Commit `d0ffbbd`.

## 0.4 — Injeção de fórmula no CSV

- **Problema:** campo que começa com `=`, `+`, `-`, `@` é executado como fórmula ao abrir o CSV no Excel/LibreOffice (CSV injection, OWASP).
- **Causa raiz:** a função de escape só duplicava aspas (`_worker.js`, exportação).
- **Solução:** apóstrofo na frente desses prefixos e de tabulação/CR; remoção de caracteres de controle. Aspas continuam duplicadas.
- **Arquivos:** `web/_worker.js`, `tests/api_test.mjs`.
- **Testes:** aluno `=1+1` / `@cmd` gera `"'=1+1";"'@cmd"`; cabeçalho e linha de aluno normal idênticos aos de antes. **Resultado:** 3 verificações novas, suíte passa.
- **Justificativa:** mitigação padrão recomendada pela OWASP, sem mudar o formato do arquivo para quem não tem valores especiais. Commit `741f61f`.

## 0.3 — Bloqueio indevido e enumeração de e-mails

- **Problema:** (a) 8 erros contra um e-mail, de qualquer IP, bloqueavam o dono por 15 min, repetidamente; (b) e-mail inexistente respondia em 0,2 ms contra 13 ms de conta existente, revelando quais e-mails existem; (c) tentativas por IP nunca eram apagadas.
- **Causa raiz:** (a) chave do limite era só `email:`; (b) `s && safeEqual(...)` pulava o PBKDF2 (100 mil iterações) quando a conta não existia; (c) limpeza só da chave de e-mail no sucesso.
- **Solução:** limite por par `(e-mail, IP)` = 8 e por IP = 30 em 15 min; PBKDF2 sempre executado (sal fixo "fantasma" quando não há conta); remoção de tentativas com mais de 1 hora no mesmo batch da falha.
- **Arquivos:** `web/_worker.js` (`rateLimited`, rota de login), `tests/api_test.mjs`.
- **Testes:** 8 erros do IP A bloqueiam A; login correto do IP B passa com o e-mail sob ataque; par limpo no sucesso; mediana de 12 logins com e-mail inexistente dentro de ±50% da mediana com e-mail existente (medido: 14,3 ms × 14,5 ms); nada com mais de 1 h na tabela. **Resultado:** 6 verificações novas, suíte passa.
- **Justificativa:** o limite por par protege contra força bruta sem permitir negação de serviço ao dono da conta; a resposta em tempo constante remove o oráculo de existência. Ataque distribuído por muitos IPs continua limitado a 8 tentativas por IP contra PBKDF2 e senha mínima de 8 caracteres. Commit `1e761e5`.

## 0.5 — Data da última aula das técnicas

- **Problema:** técnica passada numa aula sem presentes contava em "vezes ensinada" mas ficava sem "última aula" e fora dos 90 dias.
- **Causa raiz:** o mapa aula→data era montado a partir da tabela de presença, não da de aulas.
- **Solução:** `computeAll` carrega `SELECT id, date FROM lessons` e `techniqueStats` usa esse mapa. Só `last_taught` e `taught_90d` mudam; `times_taught` e todos os indicadores dos alunos ficam iguais.
- **Arquivos:** `web/_worker.js`, `tests/api_test.mjs`.
- **Testes:** aula sem presentes com técnica → `times_taught = 1`, `last_taught` = data da aula, `taught_90d = 1`; a verificação existente de "vezes ensinada = 13" continua passando. **Resultado:** 3 verificações novas.
- **Justificativa:** correção mínima na fonte do dado, sem tocar na regra de graduação. A implementação de referência ("golden") prevista no plano (P.1) ainda não foi criada; a paridade dos demais campos é garantida pela suíte existente. Commit `b9c76e8`.

## 0.6 — Renovação de sessão

- **Problema:** sessão de 30 dias fixos a partir do login; o professor era deslogado no meio do uso.
- **Causa raiz:** `currentStaff` só validava `expires_at`; nenhum ponto renovava.
- **Solução:** renovação deslizante: quando faltam menos de 15 dias, `expires_at` avança 30 dias e o cookie é reenviado (mesmos atributos `HttpOnly; Secure; SameSite=Strict`), até o teto de 90 dias desde `created_at`; passado o teto, a sessão é apagada e a resposta é 401. Troca de senha e desativação continuam derrubando sessões.
- **Arquivos:** `web/_worker.js` (`currentStaff`, `route`, `fetch`), `tests/api_test.mjs`.
- **Testes:** 20 dias restantes → sem `set-cookie`; 10 dias → cookie seguro reenviado e `expires_at` ≈ +30 dias; `created_at` há 91 dias → 401 e sessão removida. **Resultado:** 4 verificações novas.
- **Justificativa:** equilíbrio entre conveniência (uso contínuo não desloga) e limite de exposição de um aparelho perdido (teto absoluto). Os valores 30/15/90 são constantes no topo do Worker e podem ser ajustados. Commit `98854b0`.

## 0.2 — Recuperação de senha do administrador

- **Problema:** o administrador que esquecia a senha ficava sem acesso; só havia reset de professor, feito pelo próprio administrador.
- **Decisão (alternativa A, com preparação para B):** código gerado localmente, sem provedor de e-mail. Comparação feita antes: A não tem dependência externa nem custo e a raiz de confiança é a verificação humana; B dá autonomia e escala para várias academias, mas exige provedor, domínio verificado, chave secreta e depende da segurança da caixa de e-mail. Hoje há uma academia, então A; a validação ficou separada da entrega para que B troque só o emissor.
- **Solução:** `tools/reset-code.mjs` consulta a conta via Wrangler, pede que o operador digite o e-mail da conta, gera 130 bits aleatórios (Crockford base32) e grava só `SHA-256(conta + código)` com validade de 30 minutos em `password_resets`. `POST /api/reset` (e-mail, código, nova senha) valida em tempo constante, consome o código de forma atômica (`UPDATE ... WHERE used_at IS NULL`, confere `changes = 1`), troca a senha e apaga todas as sessões da conta. Cinco erros contra o código o invalidam; além disso valem os limites de login por par (e-mail, IP) e por IP. Código errado, e-mail inexistente e conta sem código recebem a mesma resposta; mensagens específicas (expirado, já usado) só aparecem para quem apresentou o código certo, então não permitem enumerar contas. Eventos `reset_issued`, `reset_failed` e `reset_used` vão para `audit_log`, sem código nem senha.
- **Migração:** `db/migrations/001_recuperacao_senha.sql` cria duas tabelas novas (sem ALTER em tabela existente, por isso é idempotente) e `.down.sql` as remove. Escolhi tabelas novas em vez de colunas em `staff` porque SQLite/D1 não tem `ADD COLUMN IF NOT EXISTS` e a reversão fica trivial. `db/schema.sql` também as inclui para bancos novos.
- **Interface:** link discreto "Tenho um código de recuperação" no login e tela com e-mail, código, nova senha e confirmação, no mesmo padrão visual. Sem alteração de CSS.
- **Arquivos:** `web/_worker.js`, `web/app.js`, `tools/reset-code.mjs`, `db/migrations/`, `db/schema.sql`, `tests/api_test.mjs`, `tests/permissions.mjs`, `tests/migration.mjs`, `tests/e2e.mjs`, `docs/recuperacao-de-senha.md`, `README.md`.
- **Testes:** 29 verificações novas de API (código válido, incorreto, expirado, reutilizado, tentativas excessivas, código de outra conta, sessões antigas encerradas, senha nova funciona e a anterior não, nenhum código nem senha em texto puro no banco ou no console, resposta igual para e-mail inexistente), 8 de migração (aplica, repete, reverte, preserva dados), linha nova na matriz de rotas e um passo de e2e no navegador. O script foi exercitado de ponta a ponta com um SQLite local no lugar do Wrangler (confirmação errada cancela; conta inexistente não gera nada).
- **Riscos residuais:** engenharia social contra o operador (mitigação: confirmação por segundo canal, documentada); o operador é ponto único de recuperação; um atacante que descubra o e-mail pode gastar as 5 tentativas de um código pendente e obrigar a pedir outro (negação limitada a janelas de 30 minutos); o código passa pelo canal humano em texto claro durante 30 minutos; o fluxo real com o Wrangler contra D1 remoto não foi executado nesta etapa (sem deploy).

## 0.1 — Matriz de acesso

- **Problema:** professor conseguia excluir chamadas e horários de qualquer pessoa, desfazer qualquer graduação, criar/editar/excluir técnicas do catálogo, corrigir datas de faixa/grau e aulas anteriores ao sistema (que alteram a contagem para graduação) e exportar o CSV com dados de todos os alunos.
- **Causa raiz:** autorização decidida rota a rota por omissão; só cinco rotas chamavam `admin()`.
- **Solução:** regra explícita no servidor (comentada no Worker e documentada no README): só administrador exclui horário, chamadas de outros ou com mais de 7 dias, desfaz graduação de outros ou com mais de 7 dias, corrige campos de graduação depois do cadastro, mantém o catálogo de técnicas, exporta CSV. Helper `ownRecent(staffId, createdAt)` usa `lessons.created_by` e `promotions.staff_id`, que já existiam. A interface espelha a regra (botões escondidos, técnica em modo consulta, campos de graduação travados com aviso), mas a verificação é sempre do servidor.
- **Arquivos:** `web/_worker.js`, `web/app.js`, `README.md`, `tests/permissions.mjs` (novo), `tests/e2e.mjs`, `package.json`.
- **Testes:** `tests/permissions.mjs` percorre 37 rotas × 3 perfis (anônimo, professor, administrador) com o status esperado de cada célula, e confere por leitura do fonte que toda rota do Worker tem linha na tabela (uma rota nova sem regra faz o teste falhar). Executado antes da correção: 14 falhas; depois: 0. E2e ganhou um passo: como professor, sem CSV, sem "Nova técnica", técnica só consulta, sem excluir horário, datas de graduação travadas, e o dia a dia (editar telefone, fazer chamada) continua. Capturas em 390 e 1280 px conferidas.
- **Resultado:** API 53 verificações, matriz OK, e2e 9 etapas sem erros de console.
- **Justificativa:** princípio do menor privilégio com verificação no servidor; a janela de 7 dias para o próprio registro evita que o professor precise do administrador para corrigir um erro recente, sem abrir a exclusão de histórico. Pontos abertos à decisão do dono do produto: professor exportar CSV e corrigir datas de faixa (proposta: não). Commit `b22bb49`.

---

## Pendências da Etapa 0

1. **Trilha de auditoria (0.7):** a tabela `audit_log` já existe (migração 001) e registra a recuperação de senha; falta registrar as demais ações sensíveis.
2. **Documentação de operação e migrações (0.8):** precisa do id do banco D1 e do nome do projeto Pages.
3. **Implementação de referência para paridade dos cálculos (P.1):** pré-requisito da Etapa 1.

## Como rodar

```
npm test            # API (82) + matriz + migração de acesso
npm run test:e2e    # navegador; defina TATAME_CHROME=<caminho do chrome.exe> e NODE_PATH com playwright-core, ou instale o pacote playwright
```
