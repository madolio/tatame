# Agenda V1: checkpoint de continuidade

Branch `agenda-v1`, base `5508ac3` (Etapa 6.4-D, estável do Chat 1). Este arquivo é só da frente de produto; não altera arquivos do Chat 1.
Detalhes de funcionamento: `docs/agenda.md`. Proposta de migração: `docs/agenda-migracao-004/`.

## 1. Estado da branch
| Commit | Conteúdo |
|---|---|
| `762f98a` | API `GET /api/agenda`, aula programada, conflito de professor (app) |
| `e2557e6` | Interface: semana/dia, programar/editar, chamada pela agenda, e2e |
| `08a66cc` | Filtros, duplicar aula, aviso de conflito, atalhos, base visual de cancelamento |
| `ceaf71e` | Polimento mobile e capturas no e2e |
| `83eb6bb` | Servidor: cancelar, feriado, restaurar, reposição, eventos de auditoria, trava de conflito; SQL da migração 004 (proposta); `tests/agenda_cancel.mjs` |
| `02cbf4c` | **WIP**: interface de cancelar/feriado/restaurar/reposição + passo e2e (ainda falha, ver seção 5) |

Nada foi mesclado com `etapa-0-seguranca`. Sem deploy, sem acesso a banco remoto.

## 2. Implementado e testado
- Agenda por dia e semana (grade semanal + aulas gravadas, nada gravado em massa), estados, filtros por professor/modalidade, "Agora/Próxima", atalhos ← → T.
- Programar, editar, duplicar e remover aula programada; conflito de professor (aviso no formulário e 409 no servidor).
- Chamada pela agenda (editor existente), sem duplicidade, correção com antes/depois na auditoria.
- Servidor de cancelamento (testado com a SQL aplicada num banco de teste): cancelar ocorrência da grade (admin) ou aula gravada (autor ≤ 7 dias ou admin), feriado (admin), restaurar, reposição (uma por cancelamento), eventos `lesson_cancelled` e `lesson_restored` (sem o texto do motivo), presença nunca tocada, trava atômica de conflito por trigger.

## 3. Decisões de arquitetura e design
- Recorrência = grade semanal existente (ocorrências calculadas por consulta). Aula gravada substitui a ocorrência prevista.
- Cancelar = registro à parte em `agenda_exceptions` (não altera `lessons`): preserva histórico; restaurar preenche `restored_at`.
- Autorização reaproveitada, nada novo: aula gravada = `ownRecent`; grade e feriado = `admin()`. Negações usam `auditDenied` (ações novas `lesson_cancel`, `agenda_holiday` no catálogo).
- Recurso detecta a tabela (`hasAgendaExt`): sem ela, rotas respondem 501 e a interface não mostra os botões (`capabilities.cancel`).
- Visual: preto + vermelho `#D91F27`, Schibsted Grotesk (SIL OFL), escopo `.ag`, sem redesenho global.

## 4. Dependência da migração 004 (bloqueado até a Etapa 6.5 liberar a cadeia)
Mover `docs/agenda-migracao-004/004_agenda_cancelamento.sql` para `db/migrations/` e o `.down.sql` para `db/rollbacks/`; atualizar `db/schema.sql` e as listas de `schema_check`, `migration`, `db_migrate`, `backup`; incluir `agenda.mjs`/`agenda_cancel.mjs` no `npm test` (hoje rodam dentro de `tests/api_test.mjs`, porque `package.json` é do Chat 1). Depois disso o e2e de cancelamento pode usar o banco já migrado (hoje o passo aplica o SQL no banco de teste).

## 5. Testes e resultados (no último estado verificado)
- Passam: `api_test` (inclui `agenda.mjs` e `agenda_cancel.mjs`), `setup`, `bruteforce`, `password_change`, `reset`, `admin_integrity`, `audit`, `student_delete`, `permissions`, `lessons_auth`, `limits`, `validation`, `migration`, `parity`, `db_guard`, `schema_check`, `db_migrate`, `backup_crypto`, `backup_temp`, `backup_key`, `anonymize` (rodadas no commit `83eb6bb`).
- `tests/backup.mjs` falha, **já falhava na base `5508ac3`**; não é da agenda.
- E2E (`tests/e2e.mjs`): todos os passos anteriores passam. O passo novo "agenda: cancelar, reposição e restaurar" (WIP) chega ao cancelamento e à reposição e falha ao procurar o item cancelado depois da reposição. Causa provável: após marcar a reposição a agenda passa para a semana da reposição, então o item cancelado não está na tela. Correção provável no teste: voltar à semana da aula cancelada (`[data-act=ag-nav]`) antes de `.ag-item[data-k=cancelled]`. Não confirmado.
- A interface de cancelar/restaurar/reposição ainda não foi revisada visualmente (capturas `22` e `23` do e2e).

## 6. Limitações conhecidas
- Cancelada aparece também na aba "Chamadas" (lista de aulas) como aula comum sem presença.
- Reposição não gera evento de auditoria próprio (é uma `lesson_created` e a ligação fica em `makeup_lesson_id`).
- Cache de "tabela existe" por instância do Worker: após rollback da migração é preciso reiniciar/reimplantar.
- Edição simultânea da mesma aula: vale a última gravação.
- Feriado vale para todas as turmas; sem feriado por turma ou recorrente (anual).
- Acessibilidade só com contraste medido, sem teste de leitor de tela.

## 7. Próximos passos concretos
1. Corrigir o passo e2e (navegar de volta à semana da aula cancelada) e rodar o e2e completo.
2. Revisar capturas `22` e `23`; ajustar o formulário de cancelamento se preciso.
3. Quando a 6.5 liberar a cadeia: aplicar a seção 4 e rodar `npm test`.
4. Integração controlada com o Chat 1 (revisão conjunta de conflitos antes de qualquer merge).
5. Depois da Agenda: Portal do Aluno (não iniciado).

## 8. Recuperar em outro computador
```
git clone https://github.com/madolio/tatame.git tatame
cd tatame
git fetch origin agenda-v1
git worktree add ../tatame-agenda agenda-v1      # ou: git checkout -b agenda-v1 origin/agenda-v1
cd ../tatame-agenda
npm install
node tests/api_test.mjs && node tests/permissions.mjs
# e2e (precisa de playwright-core e do Chrome):
#   TATAME_CHROME="<caminho do chrome.exe>" node tests/e2e.mjs
git log --oneline 5508ac3..HEAD       # deve listar os 6 commits da seção 1
```
Não faça merge com `etapa-0-seguranca` sem a revisão conjunta. O trabalho do Chat 1 fica na pasta/branch dele; esta branch não depende dele.
