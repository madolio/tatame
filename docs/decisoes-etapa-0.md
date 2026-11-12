# Etapa 0 — Segurança e confiabilidade: registro das decisões técnicas

Registro para a documentação acadêmica (TCC). Cada item segue: problema, causa raiz, solução, arquivos, testes, resultado e justificativa. Base: `main` em `8bcea11`; trabalho na branch `etapa-0-seguranca`, 12 nov 2026.

## Classificação dos apontamentos da auditoria

| Apontamento | Situação em `8bcea11` | Tratado nesta etapa |
|---|---|---|
| Professor executa ações administrativas (excluir aula/horário, catálogo de técnicas, CSV, desfazer graduação, corrigir datas de faixa) | Confirmado e reproduzido (teste de matriz: 14 falhas) | Sim (0.1) |
| Sem recuperação de senha do administrador | Confirmado | Não: exige decisão (código por comando × e-mail com provedor) e migração |
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

1. **Recuperação de senha do administrador (0.2):** decisão entre código gerado por comando (sem e-mail) e fluxo por e-mail com provedor externo. Exige migração (colunas `reset_hash`, `reset_expires`).
2. **Trilha de auditoria (0.7):** tabela `audit_log`; depende do mecanismo de migração.
3. **Documentação de operação e migrações (0.8):** precisa do id do banco D1 e do nome do projeto Pages.
4. **Implementação de referência para paridade dos cálculos (P.1):** pré-requisito da Etapa 1.

## Como rodar

```
npm test            # API (53) + matriz de acesso
npm run test:e2e    # navegador; defina TATAME_CHROME=<caminho do chrome.exe> e NODE_PATH com playwright-core, ou instale o pacote playwright
```
