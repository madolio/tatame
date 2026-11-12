# Regras de cálculo dos indicadores

Documento de referência para a paridade (`tests/parity.mjs`) e para o TCC. Cada indicador tem a **regra de referência** (a que a implementação independente em `tests/ref/reference.mjs` segue) e, quando difere, o **comportamento atual** do Worker (`web/_worker.js`). Regras marcadas **[provisória]** foram aprovadas só para construir a referência; nada foi alterado no Worker.

## 0. Convenções

- **Hoje** é a data no fuso `America/Sao_Paulo`. Todas as datas são `AAAA-MM-DD`; comparações são feitas por número de dias, nunca por hora.
- **Janela de N dias**: dias `d` com `hoje − N < d ≤ hoje` (N dias contando hoje). Vale para 30, 84 e 90 dias.
- **Semana** começa na segunda-feira.
- **Aula** = registro em `lessons`. **Presença** = linha em `attendance`. **Aula sem chamada** = aula sem nenhuma presença (ver D6).
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

### Média semanal (`weekly_avg`) — D7 [provisória]
`presenças na janela de 84 dias ÷ semanas`, onde `semanas = min(12, máx(1, ⌈(dias desde o início + 1) / 7⌉))`. O denominador cresce com o tempo de casa até 12 e nunca é menor que 1 (sem divisão por zero e sem inflar a média de quem entrou ontem).
**Atual:** divide sempre por 12. Quem entrou há 2 semanas com 6 aulas aparece com 0,5 por semana (a média real é 3).

### Ausência e risco de evasão (`days_absent`, `at_risk`) — D4 [provisória]
- Com presença: `days_absent = hoje − última presença`.
- Sem presença: `days_absent = hoje − início` (dias desde o cadastro). **Carência:** só é "em risco" a partir de 14 dias; aluno recém-cadastrado não é classificado como em risco.
- `at_risk` = aluno **ativo** e `days_absent ≥ 14`.
- **Início no futuro é dado inválido:** sem presença, `days_absent = null` e `at_risk = false`; nunca se calcula valor negativo. O aluno é sinalizado em `data_issues` (`inicio_futuro`).
**Atual:** início no futuro produz `days_absent` negativo (ex.: −10). O restante coincide.
**Pendente de confirmação (D4b):** a regra "14 dias de carência desde o cadastro" é a leitura que fiz de "não classificar automaticamente recém-cadastrados como em risco". Ela coincide com o comportamento atual.

## 2. Experiência — D3 [provisória]

Dois indicadores diferentes:

| Indicador | Definição |
|---|---|
| **Experiência total** (`experience.score`, nível e rótulo) | `presenças no sistema + aulas importadas acumuladas + meses de experiência anterior × 8` |
| **Experiência na faixa atual** (`classes_since_belt`) | `presenças desde a data da faixa + aulas importadas da faixa atual` |

**Aulas importadas acumuladas** = `imported_classes_belt` atual + soma de `from_imported_belt` das graduações de **faixa** registradas do aluno. Ao promover de faixa o Worker zera `imported_classes_belt` e guarda o valor anterior em `promotions.from_imported_belt`; somar esse histórico preserva a trajetória sem contar duas vezes (graduações de grau não zeram `imported_classes_belt`, então não entram na soma; desfazer uma graduação apaga o registro e restaura o campo, então não há duplicidade).
**Atual:** usa só `imported_classes_belt` atual. Depois da graduação de faixa a experiência cai (ex.: 300 pontos, "Avançado", viram 0, "Novato"). Níveis: 0 Novato, 30 Iniciante, 100 Intermediário, 250 Avançado, 500 Experiente.

Limitação conhecida: se o administrador editar `imported_classes_belt` depois de uma graduação de faixa, o total acumulado muda com a edição.

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
| `new_this_month` — D5 [provisória] | alunos **ativos** com `início` dentro do mês de hoje (do dia 1 até hoje; início futuro é inválido e não conta) | conta qualquer situação e início futuro |
| `at_risk`, `ready` | alunos **ativos** com a respectiva marca | igual |
| `lessons_30d` | aulas na janela de 30 dias | igual |
| `avg_per_lesson_30d` — D6 [provisória] | presenças ÷ aulas **com chamada** (≥ 1 presença) na janela, 1 casa | divide por todas as aulas, inclusive vazias |
| `attendance_this_week` / `_last_week` | presenças com data na semana atual / anterior | igual |
| `attendance_last_week_same_period` | presenças de `segunda anterior` até `hoje − 7` | igual |
| `weekly` (12 semanas) | por semana: aulas, presenças e alunos distintos | igual |
| `belts` | alunos ativos por faixa (só faixas com alunos) | igual |
| `occupancy` | por turma ativa, aulas das últimas 8 semanas e presença média (D6) | média inclui vazias |
| `heat` | por dia da semana e hora, aulas das últimas 8 semanas, presenças e média (D6) | média inclui vazias |
| listas `ready_list`, `risk_list`, `near_list` | ativos prontos; ativos em risco; ativos não prontos com `progress ≥ 75` (máx. 8) | igual |

### Aula sem chamada × aula com zero presentes — D6 [provisória]
O modelo de dados atual **não distingue** os dois casos: ambos são uma aula sem linhas em `attendance`. Para a referência, "sem chamada" é aproximado por "nenhuma presença registrada". Isso significa que uma aula realizada e que ficou de fato sem alunos é tratada como sem chamada. Para separar de verdade é preciso um marcador (por exemplo, `lessons.roll_called`, 0/1, com valor 1 quando a chamada é salva). Isso exige migração e mudança no Worker e fica **para decisão** (item 6 abaixo).

## 6. Decisões que ainda dependem de aprovação
1. Adotar meses-calendário no lugar da aproximação por 30,44 dias (item 8).
2. Criar o marcador de chamada para separar "sem chamada" de "chamada com zero presentes" (D6), com migração.
3. D4b: confirmar a carência de 14 dias para alunos sem presença.
4. D3: confirmar que a experiência total deve somar `from_imported_belt` das graduações de faixa (e tratar a edição administrativa de `imported_classes_belt`).
5. Aplicar cada regra provisória ao Worker, uma por vez, com o teste de paridade como prova.

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
| D3 | Promover de faixa zera `imported_classes_belt` e a experiência cai: 300 pontos ("Avançado") viram 2 ("Novato") | regra aprovada |
| D4 | Início no futuro: `days_absent = −10` | regra aprovada |
| D5 | `new_this_month` conta inativos e início futuro (7 contra 4) | regra aprovada |
| D6 | Média por aula inclui aulas sem presença (1,7 contra 1,9); o modelo não separa "sem chamada" de "chamada com zero" | depende de modelo |
| D7 | Média semanal dividida sempre por 12 (0,5 contra 2,0 para quem entrou há 2 semanas) | regra aprovada |
| item 8 | 31/01 → 30/04, alvo de 3 meses: calendário cumpre, aproximação dá 2,97 | tolerância |
| D4 | Sinalização `data_issues.inicio_futuro` ainda não existe no Worker (`needs_profile` e `sem_nascimento` já existem desde a D1) | campo novo |

Sem divergência: janelas de 30, 84 e 90 dias, última aula, contagens por faixa e por semana, ocupação por turma, mapa de calor (contagens), técnicas, currículo e aprendizado, critérios de graduação, desfazer graduação.

Limitações da verificação: a referência não prova que a regra de negócio é pedagogicamente correta, só que o código a executa como escrita; os dados gerados não incluem graduações (cobertas no cenário manual); o `near_list` com mais de 8 alunos empatados não tem ordem definida e é comparado como conjunto.
