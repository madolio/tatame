# Regras de cálculo dos indicadores

Documento de referência para a paridade (`tests/parity.mjs`) e para o TCC. Cada indicador tem a **regra de referência** (a que a implementação independente em `tests/ref/reference.mjs` segue) e, quando difere, o **comportamento atual** do Worker (`web/_worker.js`). Regras marcadas **[provisória]** foram aprovadas só para construir a referência; nada foi alterado no Worker.

## 0. Convenções

- **Hoje** é a data no fuso `America/Sao_Paulo`. Todas as datas são `AAAA-MM-DD`; comparações são feitas por número de dias, nunca por hora.
- **Janela de N dias**: dias `d` com `hoje − N < d ≤ hoje` (N dias contando hoje). Vale para 30, 84 e 90 dias.
- **Semana** começa na segunda-feira.
- **Aula** = registro em `lessons`. **Presença** = linha em `attendance`. **Aula sem chamada** = `roll_called = 0` (ver D6); `roll_called = 1` com zero presentes é chamada feita.
- **Arredondamento** para uma casa decimal: meio para cima.
- **Aluno ativo** = `status = 'ativo'`. Trancado e inativo não entram em contagens do painel nem em risco de evasão.
- **Dado inválido**: data de início no futuro; presença em aula anterior ao início do aluno é aceita e contada (a chamada é a evidência), mas não é erro.

## 1. Frequência

| Indicador | Regra de referência | Atual |
|---|---|---|
| `classes_total` | número de presenças do aluno | igual |
| `last_attendance` | data da presença mais recente; `null` sem presença | igual |
| `classes_last_30d` | presenças na janela de 30 dias | igual |
| `mat_hours` | soma de `fim − início` das aulas presentes, em horas, 1 casa | igual |
| `techniques_seen` | técnicas distintas passadas em aulas em que o aluno esteve | igual |

### Média semanal (`weekly_avg`) — D7 [aprovada e aplicada]
`presenças na janela de 84 dias ÷ semanas`, onde `semanas = min(12, máx(1, ⌈(dias desde o início + 1) / 7⌉))`. O denominador cresce com o tempo de casa até 12 e nunca é menor que 1 (sem divisão por zero e sem inflar a média de quem entrou ontem).
**Aplicação:** o Worker usa essa fórmula. Antes da D7 dividia sempre por 12: quem entrou há 2 semanas com 6 aulas aparecia com 0,5 por semana (agora 2,0, três semanas de cadastro contando o dia de hoje). Início futuro conta 1 semana.

### Ausência e risco de evasão (`days_absent`, `at_risk`) — D4 e D4b [aprovadas e aplicadas]
- Com presença: `days_absent = hoje − última presença`.
- Sem presença: `days_absent = hoje − início` (dias desde o cadastro). **Carência:** só é "em risco" a partir de 14 dias; aluno recém-cadastrado não é classificado como em risco.
- `at_risk` = aluno **ativo** e `days_absent ≥ 14`.
- **Início no futuro é dado inválido:** sem presença, `days_absent = null` e `at_risk = false`; nunca se calcula valor negativo. O aluno é sinalizado em `data_issues` (`inicio_futuro`).
**Aplicação:** a API já recusa data de início futura ao cadastrar; o tratamento no cálculo protege contra dados que cheguem por outro caminho (importação, banco). Também não se calcula ausência negativa se uma presença estiver datada no futuro (`days_absent` mínimo 0). Antes da D4 o Worker mostrava `days_absent = −10`.
**D4b (confirmada):** carência de 14 dias após o início do cadastro para quem não tem nenhuma presença.

## 2. Experiência — D3 [aprovada e aplicada]

Dois indicadores diferentes:

| Indicador | Definição |
|---|---|
| **Experiência total** (`experience.score`, nível e rótulo) | `presenças no sistema + aulas importadas acumuladas + meses de experiência anterior × 8` |
| **Experiência na faixa atual** (`experience.in_belt`, igual a `classes_since_belt`) | `presenças desde a data da faixa + aulas importadas da faixa atual` |

**Aulas importadas acumuladas** = `imported_classes_belt` atual + soma de `from_imported_belt` das graduações de **faixa** registradas do aluno. Ao promover de faixa o Worker zera `imported_classes_belt` e guarda o valor anterior em `promotions.from_imported_belt`; somar esse histórico preserva a trajetória sem contar duas vezes (graduações de grau não zeram `imported_classes_belt`, então não entram na soma; desfazer uma graduação apaga o registro e restaura o campo, então não há duplicidade).
**Aplicação:** o Worker soma `from_imported_belt` das graduações de faixa (consulta agregada em `computeAll`). Antes da D3 a experiência caía ao promover (ex.: 300 pontos, "Avançado", viravam 2, "Novato"). Níveis: 0 Novato, 30 Iniciante, 100 Intermediário, 250 Avançado, 500 Experiente.

**Edição administrativa:** alterar `imported_classes_belt` muda a referência da faixa atual (e, por consequência, o total), mas nunca reescreve `promotions.from_imported_belt`: o histórico de faixas anteriores fica como foi registrado. Desfazer uma graduação de faixa apaga a linha de `promotions` e devolve o valor ao aluno, então nada é contado duas vezes. Aulas importadas são aulas anteriores ao cadastro no sistema; o Worker não consegue detectar se alguém informou aulas que também estão registradas em presenças, então a orientação ao administrador é informar apenas o que veio de antes.

## 3. Graduação

### Tempo — item 8
`months_in_belt`, `training_months` e o critério de tempo usam **meses**. Duas definições:

| Definição | Fórmula | Exemplo 31/01 → 01/03 |
|---|---|---|
| **Meses-calendário** (referência) | meses completos (aniversário, com ajuste para fim de mês) + dias do mês parcial ÷ dias desse mês | 1,03 |
| **Meses aproximados por dias** (atual) | `(Δ anos × 12 + Δ meses) + (Δ dia do mês) ÷ 30,44` | 1,01 |

As duas diferem em até ~0,1 mês. O critério (`met`) só muda quando a data cai exatamente na fronteira (ex.: 31/01 → 30/04, alvo 3 meses: calendário completa 3 meses, aproximação dá 2,97). **Tolerância adotada na comparação:** 0,15 mês nos valores de meses, 5 pontos em `progress`; `met`/`ready` são comparados sem tolerância e as diferenças de fronteira ficam catalogadas.
**Recomendação (a decidir):** adotar meses-calendário. É a leitura natural de "faz 3 meses que recebeu o grau", é explicável ao aluno e não depende de uma constante (30,44). Custo: trocar `monthsBetween` por uma função de calendário, com teste de paridade.

### Próxima graduação
- Faixa com `degrees < máx` (4; preta 6): **grau**; critérios: tempo desde o último grau ≥ `degree_months`; aulas desde o último grau ≥ `degree_classes` (quando > 0). Aulas desde o último grau = presenças com data ≥ `degree_since` + `imported_classes_degree`.
- Grau máximo: **faixa**; critérios: tempo na faixa ≥ `belt_months`, aulas na faixa ≥ `belt_classes`, currículo dominado (% de técnicas com nível ≥ 3) ≥ `curriculum_pct`, idade ≥ mínima. Critério com valor `null` na regra não existe.
- Faixa preta sem faixa seguinte: sem próxima graduação.
- `progress` = média de `min(1, atual ÷ alvo)` dos critérios, em %. `ready` = há próxima graduação, há critérios e todos foram cumpridos.
- Idade mínima: `next_min_age` da regra da faixa atual, exceto branca → cinza (4 anos) e faixa infantil → azul (16).

### Próxima faixa e idade — D1 [aprovada e aplicada]
Faixas infantis (cinza, amarela, laranja, verde) são para quem tem até 15 anos.
- **Idade conhecida:** branca: menor de 16 → cinza, senão azul; faixa infantil: menor de 16 e não verde → próxima infantil, senão azul; adulta: próxima da sequência.
- **Idade desconhecida (sem data de nascimento):** não se presume adulto. Faixa infantil (cinza, amarela, laranja) segue para a próxima infantil; verde → azul; **branca fica ambígua** (`to_belt = null`: o instrutor escolhe ao graduar). O critério de **idade é ignorado** (não bloqueia a graduação), o aluno recebe `needs_profile = true` e `data_issues` contém `sem_nascimento`.
**Aplicação:** o Worker segue a regra acima. Na tela de graduação, quando a próxima faixa é "a definir", o instrutor escolhe a faixa explicitamente (cinza ou azul); a escolha conta como critérios cumpridos se o aluno está pronto. O aviso "Cadastro incompleto" aparece na aba Graduação. Antes da D1 o Worker usava idade 0: o aluno nunca ficava pronto e a faixa infantil sem nascimento apontava azul.

### Evolução de faixas e graus (integridade)
Invariantes verificadas a partir da tabela de graduações, em ordem de registro:
1. `de` de cada graduação = `para` da anterior;
2. faixa e grau atuais do aluno = `para` da última graduação (se houver);
3. `degree_since` = data da última graduação; `belt_since` = data da última graduação de **faixa** (ou o valor original, se não houve);
4. graduação de faixa zera grau, `imported_classes_belt` e `imported_classes_degree`; de grau zera só `imported_classes_degree`;
5. desfazer restaura exatamente o estado anterior (só a graduação mais recente).

## 4. Aprendizado e técnicas

- **Currículo da faixa** = técnicas ativas cuja `min_belt` é igual ou inferior à faixa do aluno (faixas infantis usam o currículo da branca).
- `learning.pct` = média dos níveis (0–5) no currículo ÷ 5, em % (técnica sem avaliação vale 0). Níveis: 0 Inicial, 20 Básico, 40 Intermediário, 60 Avançado, 80 Domínio.
- `curriculum_pct` = % do currículo com nível ≥ 3.
- `difficulties`: técnicas vistas em 2 ou mais aulas em que o aluno esteve e ainda com nível ≤ 2, ordenadas pelas mais vistas (máx. 10).
- **Técnica** (`techniqueStats`): `times_taught` = aulas em que foi passada (inclusive sem presentes); `last_taught` = data da aula mais recente; `taught_90d` = aulas na janela de 90 dias; `assessed` = alunos com avaliação; `avg_level` (1 casa); `proficient` = alunos com nível ≥ 3.

## 5. Painel

| Indicador | Regra de referência | Atual |
|---|---|---|
| `active_students` | alunos ativos | igual |
| `new_this_month` — D5 [aprovada e aplicada] | alunos **ativos** com `início` dentro do mês de hoje (do dia 1 até hoje; início futuro é inválido e não conta) | (antes da D5: contava qualquer situação e início futuro; 7 contra 4 no cenário manual) |
| `at_risk`, `ready` | alunos **ativos** com a respectiva marca | igual |
| `lessons_30d` | aulas na janela de 30 dias | igual |
| `avg_per_lesson_30d` — D6 [aprovada e aplicada] | presenças ÷ aulas **com chamada realizada** (`roll_called = 1` ou com presentes) na janela, 1 casa | (antes da D6: dividia por todas as aulas, inclusive vazias) |
| `attendance_this_week` / `_last_week` | presenças com data na semana atual / anterior | igual |
| `attendance_last_week_same_period` | presenças de `segunda anterior` até `hoje − 7` | igual |
| `weekly` (12 semanas) | por semana: aulas, presenças e alunos distintos | igual |
| `belts` | alunos ativos por faixa (só faixas com alunos) | igual |
| `occupancy` | por turma ativa, aulas das últimas 8 semanas e presença média (D6) | igual, com o denominador da D6 |
| `heat` | por dia da semana e hora, aulas das últimas 8 semanas, presenças e média (D6) | igual, com o denominador da D6 |
| listas `ready_list`, `risk_list`, `near_list` | ativos prontos; ativos em risco; ativos não prontos com `progress ≥ 75` (máx. 8) | igual |

### Aula sem chamada × aula com zero presentes — D6 [aprovada e aplicada]
O marcador `lessons.roll_called` (migração `db/migrations/002_marcador_de_chamada.sql`) separa os três estados:

| `roll_called` | Significado | Na média de presença |
|---|---|---|
| `1` | chamada feita (pode ter zero presentes) | entra; com zero presentes conta como aula de presença zero |
| `0` | aula dada sem chamada | **não** entra no denominador |
| `NULL` | desconhecido (histórico anterior à migração, sem evidência) | entra só se tiver presentes; sem presentes fica fora |

- **Chamada realizada** (denominador das médias `avg_per_lesson_30d`, `occupancy.avg`, `heat.avg`) = `roll_called = 1` ou aula com ao menos uma presença. A contagem de aulas dadas (`lessons_30d`, `weekly.lessons`, `occupancy.lessons`, `heat.lessons`) continua incluindo todas as aulas.
- **Novas aulas:** com presentes, `roll_called = 1` sempre. Sem presentes, o padrão é `0` (sem chamada); a chamada "feita, ninguém compareceu" é registrada enviando `roll_called: true` (na tela: caixa "Chamada feita: ninguém compareceu", que aparece quando ninguém está marcado). `roll_called: false` com alunos presentes é recusado. Ao editar uma aula sem informar o marcador, o estado existente é preservado (inclusive `NULL`).
- **Backfill (apenas com evidência confiável):** a migração marca `1` nas aulas que já têm presença registrada. Aulas sem presença **não são classificadas**: podem ser "sem chamada" ou "chamada com zero presentes" e nada no banco permite saber. Elas ficam `NULL`; o instrutor pode registrar a chamada depois, editando a aula.
- **Efeito do histórico desconhecido:** aulas `NULL` sem presentes ficam fora das médias (nem contam como zero, nem como "sem chamada" declarada). Médias de períodos antigos portanto não mudam por causa dessas aulas; só a evidência futura (marcador `0`/`1`) altera o denominador.
- **Ordem de implantação:** aplicar a migração 002 **uma vez** (o SQLite não torna `ADD COLUMN` idempotente) antes de publicar o Worker que lê/grava a coluna. Reversão: `002_marcador_de_chamada.down.sql` (remove a coluna; aulas e presenças ficam). Fazer `wrangler d1 export` antes.

## 6. Decisões que ainda dependem de aprovação
1. Adotar meses-calendário no lugar da aproximação por 30,44 dias (item 8).
2. Aplicar cada regra provisória ao Worker, uma por vez, com o teste de paridade como prova.

## 7. Paridade: como é verificada

`node tests/parity.mjs` (também em `npm test`) compara, campo a campo, o Worker real com `tests/ref/reference.mjs`, uma implementação independente (aritmética de datas própria, sem importar nada de `web/`).

- **Relógio fixo:** o teste congela `Date` (12:00 de Brasília) para o resultado não depender do dia da execução. O Worker não foi alterado.
- **Dados:** (1) cenário manual com 35 alunos, cada um ilustrando um caso (sem presença, aula antes do início ou da faixa, janelas de 29/30/83/84/89/90 dias, trancado e inativo, início no futuro, sem nascimento, faixas infantis, graduações feitas pela API real, inclusive desfazer), executado em duas datas (17/06/2026 e 30/04/2026, esta para a fronteira de fim de mês); (2) conjunto gerado com semente fixa (45 alunos, 181 aulas, 1.793 presenças); (3) banco vazio.
- **Passe A (fidelidade):** referência com o comportamento atual. Deve coincidir com o Worker em tudo, exceto na fronteira de fim de mês do item 8. Resultado: 0 divergências em ~6.200 campos fora essa fronteira. É a prova de que a referência entendeu o Worker.
- **Passe B (regras provisórias):** divergências esperadas, catalogadas em `tests/ref/divergencias.json` com classe, evidência e **contagem exata**. O teste falha se surgir divergência fora do catálogo, se uma contagem mudar ou se uma entrada deixar de ocorrer; ninguém "faz passar" mudando um número sem rever a evidência.
- **Tolerâncias:** 0,15 mês nos valores de meses (0,1 de diferença de definição + 0,05 de arredondamento) e 5 pontos em `progress`. `met`, `ready` e todas as contagens são exatas.
- **Evolução de faixa e grau:** as invariantes da seção 3 são conferidas contra a tabela de graduações dos alunos promovidos e desfeitos pela API. Nenhuma inconsistência encontrada.
- **Sensibilidade:** com um erro de uma linha no Worker (janela de 30 dias virando 29), a suíte falhou apontando aluno, campo e valores; o arquivo foi restaurado em seguida.

### Divergências do passe B (cada uma com evidência reproduzível em `node tests/parity.mjs --detalhe`)

| Regra | Efeito observado | Classe |
|---|---|---|
| item 8 | 31/01 → 30/04, alvo de 3 meses: calendário cumpre, aproximação dá 2,97 | tolerância |

Sem divergência: janelas de 30, 84 e 90 dias, última aula, contagens por faixa e por semana, ocupação por turma, mapa de calor (contagens), técnicas, currículo e aprendizado, critérios de graduação, desfazer graduação.

Limitações da verificação: a referência não prova que a regra de negócio é pedagogicamente correta, só que o código a executa como escrita; os dados gerados não incluem graduações (cobertas no cenário manual); o `near_list` com mais de 8 alunos empatados não tem ordem definida e é comparado como conjunto.
