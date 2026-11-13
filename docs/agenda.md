# Agenda V1

Branch `agenda-v1`, base `5508ac3`. Só leitura e escrita pelas rotas de aulas que já existiam, mais uma rota de leitura nova.

## Como funciona
- **Grade semanal = recorrência.** Cada turma (`classes`) já se repete toda semana. A agenda calcula as ocorrências do período e mostra as que ainda não têm aula gravada como "previstas". Nada é gerado nem gravado em massa. Uma ocorrência prevista só vira linha em `lessons` quando alguém faz a chamada ou programa a aula.
- **`GET /api/agenda?from&to`** (qualquer pessoa da equipe logada, no máximo 42 dias): aulas gravadas + ocorrências previstas + "costumam vir" por turma + marca de conflito de professor. Não devolve observações nem listas de alunos.
- **Aula programada:** `POST /api/lessons` aceita data futura (até 366 dias), sem chamada. Aula futura com alunos ou `roll_called: true` é recusada. Não entra nos indicadores do painel.
- **Conflito de professor:** o mesmo professor não pode ter duas aulas sobrepostas no mesmo dia (409 com o horário em conflito). Vale para aula nova quando o professor foi escolhido (ou veio da turma) e, na edição, quando data, horário ou professor mudam. Conflito antigo não bloqueia corrigir presença.
- **Presença:** continua sendo `attendance (lesson_id, student_id)`, chave primária, sem duplicidade (lista repetida vira uma presença). A correção usa o `PUT /api/lessons/:id` de sempre: professor só na própria chamada com menos de 7 dias, administrador em qualquer uma; antes e depois vão para a auditoria (`lesson_updated`).
- **Estados:** programada, em andamento, chamada pendente, sem chamada (passado) e realizada. Calculados pela data, hora da academia e `roll_called`/presentes.
- **Remover aula programada:** `DELETE /api/lessons/:id` (regra e auditoria existentes). Só é oferecido para aula sem chamada.

## Arquivos
Novos: `web/agenda.js`, `web/agenda.css`, `tests/agenda.mjs`, este documento.
Alterados: `web/_worker.js` (função `agenda`, rota, `saveLesson`, filtro do painel), `web/app.js` (aba Agenda como inicial e rótulo "Agenda"), `web/index.html` (fonte e arquivos novos), `tests/permissions.mjs` (linhas da nova rota), `tests/api_test.mjs` (chama `tests/agenda.mjs`), `tests/e2e.mjs` (passo da agenda; a aba "Chamadas" agora é clicada explicitamente).
`package.json` **não** foi alterado (o Chat 1 o modifica): `tests/agenda.mjs` roda dentro de `api_test.mjs`.

## Bloqueado: cancelar aula (e feriado, reposição)
Cancelar sem apagar histórico exige guardar o estado da aula, ou seja, uma migração (004). Ela conflita com o trabalho da Etapa 6.5 porque:
1. a cadeia de migrações é verificada por testes que a enumeram (`tests/schema_check.mjs`, `tests/migration.mjs`, `tests/db_migrate.mjs`, `tests/backup.mjs`), e os dois últimos estão sendo modificados pelo Chat 1;
2. `tests/db_migrate.mjs` aplica todas as migrações e depois só os rollbacks 003, 002, 001: com uma 004 o resultado deixa de ser idêntico ao `000_base`.

Nada disso foi alterado. Proposta para quando a 6.5 permitir (migração 004 e o rollback):
```sql
ALTER TABLE lessons ADD COLUMN status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'cancelada'));
ALTER TABLE lessons ADD COLUMN cancel_reason TEXT;
ALTER TABLE lessons ADD COLUMN cancelled_at TEXT;
ALTER TABLE lessons ADD COLUMN cancelled_by TEXT REFERENCES staff (id) ON DELETE SET NULL;
-- rollback: ALTER TABLE lessons DROP COLUMN cancelled_by / cancelled_at / cancel_reason / status;
```
Mudanças no código: rotas `POST /api/lessons/:id/cancel` e `/restore` (com `ownRecent`), cancelar ocorrência prevista criando a linha já cancelada, exclusão das canceladas das métricas, dois eventos novos no catálogo de auditoria (`lesson_cancelled`, `lesson_restored`, que mexe no catálogo fechado do Chat 1), e atualizar os testes que enumeram as migrações. Também permitiria uma trava no banco para o conflito de professor (hoje a conferência é na aplicação, sem trava atômica).

## Limitações
- Conflito de professor não é atômico: dois salvamentos exatamente simultâneos podem passar. A trava no banco depende da migração acima.
- Horários fixos (turmas) não são conferidos entre si; o conflito aparece marcado na agenda.
- A grade é a de hoje: ocorrências previstas de dias sem aula gravada refletem o horário atual da turma (só a partir do dia em que a turma foi cadastrada).
- Alunos "da aula": não há matrícula de aluno em turma. A agenda mostra quem costuma vir (2 ou mais presenças nas últimas 8 semanas) e a chamada continua escolhendo alunos ativos.
- Editar uma aula com chamada pelo formulário reenvia a lista de presentes atual (sem perder ninguém), mas duas pessoas editando a mesma aula ao mesmo tempo: vale a última gravação.
- `tests/backup.mjs` falha no commit-base `5508ac3` e continua falhando aqui (verificado em extração limpa); não tem relação com a agenda.

## Melhorias de interface (sem migração)
- Filtros por professor e modalidade, aviso "Próxima/Agora" no dia de hoje, atalhos ← → e T.
- "Duplicar para outra data": cria uma nova aula (POST existente) sem copiar presença.
- Aviso antecipado de conflito no formulário (consulta `GET /api/agenda`; o servidor continua sendo quem recusa).
- Interface de cancelamento/feriado/reposição pronta e desligada (`AG_CAPS.cancel = false` em `web/agenda.js`). Os cartões já mostram
  `status: 'cancelled'` com `cancel_kind` e `cancel_reason`. Falta: migração 004, rota de servidor com auditoria, e trocar a flag para `true`
  (o botão "Cancelar" chama a rota que for definida em `ag-cancel`, ainda não escrita).
