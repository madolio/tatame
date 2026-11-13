# Auditoria (`audit_log`)

Etapa 6.4-C (V6). Este documento descreve o que fica registrado, o que **não** fica, as garantias de cada registro e o que
ainda falta decidir (retenção). Estrutura da tabela: migrações 001 e 003; código: `web/_worker.js`, seção "auditoria (V6)".

## Colunas

| Coluna | Conteúdo |
|---|---|
| `at` | Quando (UTC, ISO 8601, gerado pelo banco). |
| `event` | O que aconteceu (catálogo abaixo). |
| `actor_id` | Quem fez (id da conta da equipe). Nulo só nos limites atingidos por tentativas anônimas (`login_locked`, `reset_failed`). |
| `target_type`, `target_id` | Entidade afetada: `staff`, `student`, `lesson`, `promotion`, `class`, `technique`, `rules`, `settings`, `export`. |
| `outcome` | `ok` (feito), `denied` (negado com identidade conhecida), `limit` (limite de tentativas atingido). |
| `detail` | JSON pequeno, só com as chaves permitidas para o evento (allowlist), cada valor conferido. |
| `staff_id` | **Legado.** Só os eventos anteriores à 6.4-C o preenchem, com o significado que já tinham (tabela abaixo). Nos eventos novos fica `NULL`: use `actor_id` e `target_*`. |

Registros gravados antes da migração 003 têm as quatro colunas novas nulas; nada foi preenchido retroativamente.

## Catálogo de eventos

Eventos anteriores à 6.4-C (mesmo `event`, mesmo `staff_id`, mesmo `detail`; agora também com as colunas estruturadas):

| Evento | `staff_id` (legado) | Alvo | Resultado | `detail` |
|---|---|---|---|---|
| `login_ok` | a conta | staff | ok | `rede`, `aparelho_conhecido` |
| `login_locked` | a conta visada (se existe) | staff ou nenhum | limit | `limites`, `rede`, `conta_existe` |
| `reset_failed` | a conta (se tinha código) | staff ou nenhum | limit | `limites`, `rede` |
| `reset_used` | a conta | staff | ok | texto fixo "senha redefinida; sessões encerradas" |
| `reset_issued` | a conta | — | — | texto fixo; gravado pela ferramenta do operador (`tools/reset-code.mjs`), **sem** colunas estruturadas (o operador não é conta da equipe; a recuperação de senha não mudou nesta etapa) |
| `password_changed` | quem trocou | staff (a própria) | ok | `por`, `sessoes_encerradas`, `codigos_de_recuperacao_invalidados` |
| `password_change_failed` | quem tentou | staff (a própria) | limit | `tentativas`, `janela_min` |
| `staff_password_reset` | **quem fez** (o admin) | staff (a conta) | ok | `conta`, `sessoes_encerradas`, `codigos_de_recuperacao_invalidados` |
| `lesson_updated` | quem editou | lesson | ok | `lesson_id`, `before`, `after` (retrato da chamada, **sem** tema e observações) |
| `lesson_deleted` | quem excluiu | lesson | ok | `lesson_id`, `before` (idem) |

Retrato da chamada: `before` = `id`, `class_id`, `date`, `start_time`, `end_time`, `modality`, `instructor_id`,
`created_by`, `created_at`, `roll_called`, `student_ids`, `technique_ids`; `after` = os mesmos, menos `id`, `created_by` e
`created_at`. Registros gravados antes do ajuste da 6.4-C podem conter `title` e `notes` no retrato: continuam como estão
(nenhum evento antigo é reescrito; sem migração). Quem lê a tabela deve tratar essas chaves como opcionais.

Eventos novos (6.4-C, `staff_id` nulo):

| Evento | Alvo | `detail` |
|---|---|---|
| `setup_completed` | staff (o primeiro administrador, que é também o ator) | `papel` |
| `logout` | staff (a conta da sessão) | — |
| `staff_created` | staff | `papel` (`admin` = criação de administrador) |
| `staff_role_changed` | staff | `de`, `para` |
| `staff_deactivated` / `staff_reactivated` | staff | `sessoes_encerradas`, `codigos_de_recuperacao_invalidados` / — |
| `staff_updated` | staff | `campos` (só nomes: `name`, `belt`) |
| `student_created` | student | `situacao`, `faixa`, `graus` |
| `student_updated` | student | `campos` (só os nomes dos campos alterados, nunca os valores) |
| `student_status_changed` | student | `de`, `para` (desativação, trancamento, reativação) |
| `student_graduation_corrected` | student | `antes`, `depois` (datas de faixa/grau e aulas anteriores ao sistema) |
| `student_deleted` | student | `presencas`, `graduacoes`, `avaliacoes` (tamanho do histórico apagado em cascata) |
| `promotion_created` | promotion | `aluno`, `tipo`, `de_faixa`, `de_graus`, `para_faixa`, `para_graus`, `data`, `criterios_cumpridos` |
| `promotion_undone` | promotion | `aluno`, `tipo`, de/para da graduação desfeita |
| `lesson_created` | lesson | `turma`, `data`, `alunos`, `tecnicas`, `chamada` |
| `class_created` / `class_updated` / `class_deleted` | class | dia, horários, nível, modalidade, ativa, instrutor / `campos` / — |
| `technique_created` / `technique_updated` / `technique_deleted` | technique | categoria, faixa mínima, ativa / `campos` / — |
| `rules_updated` | rules | `faixas` (as que mudaram de fato) |
| `settings_updated` | settings (`academy_name`) | — (o valor não é registrado) |
| `students_exported` | export (`alunos.csv`) | `linhas` (exportação processada e arquivo preparado para a resposta; não confirma download) |
| `action_denied` | o alvo tentado, se conhecido | `acao`, `motivo` (`requer_admin`, `autoria_ou_prazo`, `ultimo_admin`) |

Eventos sem mudança real não são gravados (salvar uma turma, técnica, critério ou ajuste sem alterar nada; PUT de equipe
igual ao estado atual).

## O que nunca é registrado

Senha, hash, sal, token ou cookie de sessão, cookie de aparelho, código de recuperação ou de ativação; nome, apelido, e-mail,
telefone, data de nascimento, objetivos e observações de alunos; nome e e-mail da equipe; nome da academia, de turmas e de
técnicas; textos livres (tema e observações de aula, descrições, observações de graduação, avaliações); corpos de requisição.

Para reconstruir o texto de uma aula alterada ou excluída, use os backups (o retrato na auditoria tem ids, datas, horários e
as listas de presença e técnicas, sem texto livre).

## Como o helper impede conteúdo arbitrário

`audit(db, evento, { actor, target, outcome, detail }, condição)` monta o comando a partir do catálogo `AUDIT_EVENTS`:
evento fora do catálogo, tipo de alvo ou resultado não previstos, ator que não é um id, chave de `detail` fora da lista,
valor fora do domínio (lista fechada, inteiro com limites, data, id) ou JSON acima do limite **lançam exceção antes do
batch**: a operação não acontece e os testes acusam. Não existe chave que aceite texto livre (no retrato de aula, `title` e
`notes` são recusados mesmo vazios).
Nenhum `INSERT INTO audit_log` existe fora do helper (conferido em `tests/audit.mjs`).

## Garantias

- **Escritas:** o evento vai no **mesmo batch** (uma transação no D1) da escrita principal. Falhou a escrita, não há evento;
  falhou o evento, a escrita é desfeita. Testado com falhas forçadas nos dois sentidos.
- **Escritas condicionais:** o evento leva a mesma condição da escrita. Equipe (V8): a guarda de admin ativo e último
  administrador; papel e ativo só registram se o valor muda no banco naquele instante. Alunos, aulas, turmas, técnicas e
  graduações: o evento só é gravado se a entidade ainda existe no batch (excluída por outra requisição no meio do caminho =
  nenhum evento). Setup: só se este batch criou o administrador.
- **Exportação (sem escrita):** o CSV é montado, o evento é gravado e só então a resposta com o arquivo é devolvida; se a
  gravação falhar, a resposta é 500 e nenhum dado é entregue. O evento representa uma **exportação processada e um arquivo
  preparado para a resposta**. Ele **não confirma** que o download terminou nem que o navegador recebeu o arquivo: o
  servidor não tem como saber disso (a conexão pode cair ou o cliente desistir depois). Testado: o evento já existe antes de
  o corpo da resposta ser lido e continua igual se o download é abandonado.
- **Logout:** evento e fim da sessão no mesmo batch, e o evento só se a sessão ainda existe (dois logouts simultâneos = um
  evento). **Exceção deliberada:** se a gravação do evento falhar, a sessão é encerrada mesmo assim, sem evento. Sair é a
  operação que aumenta a segurança; a auditoria não pode impedi-la.
- **Negações (`action_denied`):** só com identidade autenticada. Melhor esforço: se a gravação falhar, a resposta 403/409 é
  a mesma (a auditoria não altera a segurança da operação). No máximo **um por (ator, ação) a cada 15 minutos**, para que
  uma conta logada não encha a tabela repetindo a tentativa. Senhas erradas anônimas continuam sem evento por tentativa
  (só `login_locked`/`reset_failed` quando um limite é atingido).

## Limites conhecidos

- Os `campos` de `student_updated`/`class_updated`/`technique_updated`/`staff_updated`, o `de` de `student_status_changed`,
  o `antes` de `student_graduation_corrected`, as `faixas` de `rules_updated` e as contagens de `student_deleted` são
  calculados contra o estado lido no início da requisição. Com duas edições simultâneas do mesmo registro, podem refletir a
  leitura e não o instante exato da gravação (ator, alvo e o fato de ter havido a gravação continuam exatos).
- Avaliações de técnica (`/skills`) não geram evento: já ficam em `skill_history` com quem avaliou.
- `reset_issued` (ferramenta do operador) segue no formato anterior.
- Tudo validado com o simulador local (node:sqlite). Comportamento no D1 real: ver `docs/validacao-d1.md`.

## Consultas úteis

```sql
-- últimas ações de uma pessoa da equipe
SELECT at, event, target_type, target_id, outcome, detail FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT 50;
-- histórico de um aluno (pelo id)
SELECT at, event, actor_id, detail FROM audit_log WHERE target_type = 'student' AND target_id = ? ORDER BY id;
-- negações recentes
SELECT at, actor_id, json_extract(detail, '$.acao') acao, json_extract(detail, '$.motivo') motivo FROM audit_log WHERE outcome = 'denied' ORDER BY id DESC LIMIT 50;
```

Não há índice em `actor_id`/`target_id` (a 003 não criou; a leitura atual é por data, `audit_log_at`). Se essas consultas
virarem rotina e a tabela crescer, um índice exige uma migração nova.

## Retenção (PENDENTE de decisão)

Nada é apagado automaticamente: a tabela cresce sem limite até haver uma política aprovada. A política precisa equilibrar:

- **Rastreabilidade administrativa:** quem mudou papel, desativou, corrigiu graduação ou exportou dados precisa ser
  verificável por tempo suficiente para apurar incidentes e contestações.
- **Minimização (LGPD, art. 6º, III):** os eventos não guardam dados pessoais diretos, mas guardam **ids** de alunos e da
  equipe, que continuam vinculáveis enquanto a pessoa existe no banco ou em backups.
- **Ids históricos:** após a exclusão de um aluno (hoje permitida; política na 6.4-D), o id no evento deixa de apontar para
  um cadastro, mas pode ser casado com backups antigos durante a retenção deles.
- **Pedidos de titulares e obrigações legais:** um pedido de eliminação pode conflitar com a guarda de registros de
  segurança; a política deve dizer o que prevalece e por quanto tempo.

A sugestão de **24 meses** (auditoria da Etapa 6.4) é uma hipótese, **não** uma decisão aprovada. Quando aprovada, a
remoção deve ser uma operação explícita e registrada (e alinhada à retenção dos backups), não um efeito colateral.
