# Operação do banco de dados (D1): schema, migrações, backup e recuperação

Este é o procedimento para operar o banco do Tatame com segurança. Ele foi escrito para quem **não** acompanhou o
desenvolvimento: siga os passos na ordem e não pule as verificações.

> **Regra de ouro.** Nada aqui deve ser feito "no braço" contra produção. Todas as operações passam por
> `node tools/db.mjs`, que confere o ambiente, recusa o que for perigoso e verifica o resultado. Um comando que
> termina sem erro **não** prova que o banco ficou certo: o wrapper sempre confere depois.

## 1. Peças

| Arquivo | Papel |
|---|---|
| `db/schema.sql` | Schema completo e atual (referência; usado para criar bancos de teste). |
| `db/migrations/000_base.sql` | Schema histórico do commit `17f1fbd`, o formato em que a produção foi criada. |
| `db/migrations/001_recuperacao_senha.sql` | Tabelas `password_resets` e `audit_log`. |
| `db/migrations/002_marcador_de_chamada.sql` | Coluna `lessons.roll_called` + preenchimento só onde há presença. |
| `db/rollbacks/*.down.sql` | Reversões testadas de 001 e 002. **Não** ficam em `db/migrations/` (o wrangler aplicaria todo `.sql` da pasta). |
| `db/environments.json` | Ambientes: `local`, `staging`, `restore-test`, `production`. Nome e `database_id` de cada banco. Sem segredos. |
| `db/wrangler.migrations.jsonc` | Configuração do wrangler **só** para migrações/consultas, usada com `-c ... --env <ambiente>`. |
| `tools/db.mjs` | Wrapper de todas as operações (abaixo). |
| `tools/db-baseline.mjs` | Relatório offline da linha de base a partir de um arquivo JSON. |
| `tools/backup/storage.mjs` | Armazenamento dos backups (hoje: diretório local `TATAME_BACKUP_DIR`). |

A garantia de que `000 + 001 + 002 = db/schema.sql` é testada em `npm test` (`tests/migration.mjs`, `tests/schema_check.mjs`).

### Por que a configuração do wrangler fica em `db/` e não na raiz
O projeto Pages está configurado **pelo painel** da Cloudflare (o binding `DB` está lá). Se existir um `wrangler.toml`/
`wrangler.json` com `pages_build_output_dir`, ele passa a ser a fonte da verdade do projeto Pages e os bindings do
painel deixam de valer. Por isso:
- **nunca** crie `wrangler.toml`, `wrangler.json` ou `wrangler.jsonc` na raiz nem em `web/` (um teste falha se existir);
- `db/wrangler.migrations.jsonc` não tem `pages_build_output_dir` nem binding no nível de cima (um teste confere);
- o wrapper confere que nomes e IDs desse arquivo são iguais aos de `db/environments.json`.

## 2. Pré-requisitos (uma vez por máquina)

1. Node.js 22.5 ou mais novo (o projeto usa `node:sqlite`).
2. Na raiz do projeto: `npm install`. Isso instala o **wrangler fixado** (versão exata em `package.json`). O wrapper
   nunca usa `npx wrangler` (versão variável) e recusa rodar se a versão instalada for diferente da fixada.
3. Login na Cloudflare com o wrangler fixado: `node node_modules/wrangler/bin/wrangler.js login`. Use uma conta com o
   mínimo de permissões (D1 e Pages). **Nunca** cole tokens em arquivos do projeto, em chats ou em mensagens.
4. Para backups: um diretório **fora do repositório e fora do OneDrive**, de preferência num disco cifrado
   (BitLocker), e a variável `TATAME_BACKUP_DIR` apontando para ele (seção 7).

## 3. Ambientes e travas

Todo comando exige `--env`. **Não existe ambiente padrão.**

| Ambiente | Para que serve | O que aceita |
|---|---|---|
| `local` | Arquivo SQLite local (`--sqlite <arquivo>`), sem rede | check, baseline, baseline-register, migrate |
| `staging` | Ensaio de migrações com dados **anonimizados** | tudo, menos receber backup com dados pessoais |
| `restore-test` | Banco descartável para provar que um backup restaura | import, restore-test (dados pessoais só com autorização específica) |
| `production` | Produção | só leitura e migrate, com confirmação dupla; **nunca** destino de import/restore-test |

O wrapper **recusa sem executar nada** quando:
- falta `--env`, o ambiente é desconhecido ou está com nome/ID `PENDENTE`;
- uma operação remota é pedida com `--env local`;
- é produção e falta `--confirm-production=<nome exato do banco>`, o nome não confere, não há terminal interativo ou
  o nome redigitado na pergunta não confere;
- `import`/`restore-test` apontam para produção (mesmo com confirmação);
- variáveis de ambiente tentam escolher ou confirmar produção (o wrapper ignora variáveis para isso).

Antes de qualquer comando ele mostra: ambiente, nome do banco, ID abreviado, versão do wrangler e operação.
`--dry-run` mostra o que seria executado sem executar.

### Preencher os bancos (depois de criados)
Os IDs estão como `PENDENTE` e **não devem ser inventados**. Depois de criar um banco (seção 10), copie o nome e o
`database_id` exibidos por `wrangler d1 info <nome>` para **os dois** arquivos: `db/environments.json` e
`db/wrangler.migrations.jsonc`. Faça um commit só com isso. O nome do banco de produção é o que aparece no painel do
Pages, em *Settings → Bindings → DB*.

## 4. Operações

```
node tools/db.mjs <operação> --env <ambiente> [opções]
```

| Operação | Tipo | O que faz |
|---|---|---|
| `check` | leitura | Compara o schema real com o esperado para as migrações registradas; roda `integrity_check` e `foreign_key_check`. |
| `baseline` | leitura | Compara o schema real com o de `17f1fbd` e dá um veredito. Não grava nada. |
| `baseline-register` | escrita | Registra `000_base.sql` como aplicada **sem executá-la**, só se a comparação for idêntica. Exige `--confirm-baseline=000_base.sql`. |
| `migrate` | escrita | Verifica antes, anota o bookmark do Time Travel, aplica **só** as pendentes, verifica depois. |
| `timetravel-info` | leitura | Mostra o bookmark atual do Time Travel. |
| `export` | leitura | Exporta o banco para o armazenamento de backups, com manifesto, e verifica o arquivo. |
| `verify` | offline | Verifica um backup (seção 7.2). |
| `anonymize` | offline | Gera cópia anonimizada de um backup verificado. |
| `import` | escrita | Importa um backup verificado em `staging` ou `restore-test`. |
| `restore-test` | escrita | Importa no `restore-test`, reexporta, compara e valida com o Worker real. |

## 5. Linha de base da produção (uma vez, antes da primeira migração)

A produção foi criada antes do controle de migrações: ela não tem a tabela `d1_migrations`. Antes de migrar, é
preciso **provar** que o schema real é o de `17f1fbd` e só então registrar `000_base.sql`.

1. Backup verificado antes de tudo (seção 7.1): `node tools/db.mjs export --env production --confirm-production=<NOME>`.
2. Comparação (somente leitura): `node tools/db.mjs baseline --env production --confirm-production=<NOME>`.
3. Interprete o veredito:

| Veredito | Significado | O que fazer |
|---|---|---|
| `identica` | Schema igual ao de `17f1fbd`, sem registro de migrações | Pode registrar (passo 4). |
| `contem_alteracoes_posteriores` | Já existem `password_resets`, `audit_log` ou `roll_called`, sem registro | **Pare.** Alguém aplicou migração à mão. Decisão humana: descobrir o que foi aplicado e registrar manualmente só o que for comprovado. |
| `divergente` | Colunas, tabelas, índices ou CHECKs diferentes | **Pare.** As diferenças são listadas. Pode ser banco criado de outra versão. Vira uma migração corretiva, revisada. |
| `ja_registrada` | Já existe `d1_migrations` com registros | Não há linha de base a fazer; use `check`. |
| `banco_vazio` | Sem tabelas | Use `migrate`, que aplica 000, 001 e 002. |

Também é possível gerar o relatório offline: salve a saída de
`wrangler d1 execute <NOME> --remote --json --command "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name"`
num arquivo e rode `node tools/db-baseline.mjs <arquivo>.json`.

4. Só com `identica`: `node tools/db.mjs baseline-register --env production --confirm-production=<NOME> --confirm-baseline=000_base.sql`.
   O wrapper refaz a comparação na hora; se algo mudou, recusa. Ele grava exatamente o que o wrangler 4.155.0
   gravaria (tabela `d1_migrations` e a linha `000_base.sql`), sem executar o conteúdo de `000_base.sql`.

## 6. Migrações

**Ordem obrigatória:** (1) backup verificado; (2) `migrate` em `staging` (com dados anonimizados) e teste da aplicação
apontando para staging; (3) `migrate` em produção; (4) só então publicar o Worker que depende das migrações.
O Worker atual **precisa** de 001 e 002 (recuperação de senha e marcador de chamada). As migrações só acrescentam,
então o Worker antigo continua funcionando com o banco migrado.

```
node tools/db.mjs migrate --env staging
node tools/db.mjs migrate --env production --confirm-production=<NOME>
```

O `migrate`:
1. recusa se o banco tem tabelas e não tem linha de base registrada;
2. recusa se o schema real difere do esperado para as migrações registradas, ou se a integridade falha;
3. mostra o **bookmark do Time Travel** antes de aplicar — **anote-o**;
4. aplica as pendentes com `wrangler d1 migrations apply` (cada migração e seu registro são um único comando; se
   uma falha, ela é revertida e as anteriores ficam);
5. confere depois: registro completo, schema esperado, `integrity_check`, `foreign_key_check`.

**Nunca reverte sozinho.** Se a verificação posterior falhar, siga a seção 9.1.

**Migração 002 (ADD COLUMN).** Ela não é idempotente: executada duas vezes, o SQLite recusa ("duplicate column").
Isso é proposital e é uma segunda trava. A primeira é o registro em `d1_migrations`. Se a coluna existir sem
registro, o `migrate` para com "coluna adicional: lessons.roll_called" e **não** registra nada sozinho.

## 7. Backup

### 7.1 Exportar
```
set TATAME_BACKUP_DIR=D:\backups-tatame        (Windows; caminho de exemplo)
node tools/db.mjs export --env production --confirm-production=<NOME>
```
- Sem `TATAME_BACKUP_DIR`, ou com diretório dentro do repositório, no OneDrive, inexistente ou sem escrita, a operação
  é recusada **antes** de tocar no banco.
- O arquivo é baixado para uma pasta temporária, verificado (7.2) e só então gravado em
  `TATAME_BACKUP_DIR/<ambiente>-<data UTC>/backup.sql` com `manifest.json`. Um backup nunca sobrescreve outro.
- O manifesto tem: ambiente e banco de origem, data UTC, migrações registradas, impressão digital do schema,
  contagem por tabela, SHA-256 do arquivo, versão do wrangler, commit do repositório e se contém dados pessoais.
  Ele **não** contém valores das linhas.
- O export pode deixar o banco indisponível por alguns instantes: faça fora do horário de aula.

**Quando:** sempre antes de migrar e uma vez por semana. **Retenção de referência:** os 4 mais recentes por semana e
os 3 mais recentes por mês (`retentionPlan` em `tools/backup/storage.mjs` calcula quais manter). A remoção dos que
saem da retenção ainda é manual: confira a lista antes de apagar.

### 7.2 Verificar
```
node tools/db.mjs verify --backup <id>
```
Confere: SHA-256; importação num SQLite temporário; `integrity_check`; `foreign_key_check`; contagens iguais às do
manifesto; schema igual ao do manifesto **e** ao esperado para as migrações registradas. O hash sozinho só prova que
o arquivo não mudou; quem prova que ele serve é a importação + as conferências. Mesmo assim, `verify` **não é** um teste
de restauração: para isso existe o `restore-test`.

### 7.3 Anonimizar (para staging)
```
node tools/db.mjs anonymize --backup <id>
```
Gera um novo backup (`...-anon`) a partir de um backup verificado. Regras (detalhes em `tools/db/anonymize.mjs`):
- **saem:** nomes (viram "Aluno N"/"Equipe N" pela ordem do ID, sem relação com o nome real), e-mails, telefones,
  apelidos, peso, objetivos, observações (alunos, aulas, graduações, avaliações), títulos de aula, detalhes de
  eventos, hashes de senha, sessões, tentativas de login (IPs), códigos de recuperação, código de configuração
  inicial e nome da academia;
- **generalizada:** data de nascimento vira 1º de julho do mesmo ano (mantém a faixa etária com erro de até 1 ano);
  "sem data" continua sem data;
- **ficam:** IDs (aleatórios), relações, quantidades, faixas, graus, datas de início/aulas/graduações, presenças,
  avaliações, critérios e estados — o necessário para o comportamento ser o mesmo.
- **Regra fechada:** coluna ou tabela nova sem regra explícita faz a anonimização falhar. Ao criar uma coluna nova,
  acrescente a regra dela em `RULES`.
- Depois de anonimizar, o wrapper procura no resultado **todos** os valores pessoais originais (com 4+ caracteres) e
  recusa gravar se algum aparecer.
- Na cópia anonimizada ninguém consegue entrar (hashes de senha trocados). Para usar o staging, gere um código de
  recuperação para uma conta com `tools/reset-code.mjs` (ver `docs/recuperacao-de-senha.md`).

### 7.4 Importar
```
node tools/db.mjs import --env staging --backup <id-anon> --confirm-destination=tatame-staging [--replace]
```
- Destinos permitidos: `staging` e `restore-test`. **Produção nunca.**
- `--confirm-destination=<nome do banco>` é obrigatório.
- O backup é verificado antes. Destino com tabelas exige `--replace` (apaga tudo antes, filhas antes de pais).
- Backup com dados pessoais **não** entra em staging.
- Depois de importar, as contagens do destino são comparadas com o manifesto.

### 7.5 Restore-test (prova de restauração)
```
node tools/db.mjs restore-test --env restore-test --backup <id> --confirm-destination=tatame-restore-test [--replace]
```
Importa no banco descartável, reexporta, compara a "ida e volta" (schema e contagens), e roda o **Worker real** sobre
a cópia (aplicando migrações pendentes nela, se o backup for antigo), conferindo alunos, painel e indicadores contra
a referência independente da Etapa 4. O resultado fica no manifesto do backup (`restore_test`).

**Dados pessoais reais.** Um backup integral de produção só entra no `restore-test` com autorização específica:
`--confirm-personal-data=<id do backup>` e terminal interativo. Provar a restauração de uma cópia **anonimizada**
prova o mecanismo (formato, ordem, integridade, compatibilidade com o Worker); provar a restauração do backup
**integral** prova aquele arquivo específico. Só o segundo garante que um backup real de produção é recuperável — e
só deve ser feito com autorização explícita, apagando o `restore-test` em seguida.

## 8. Time Travel (recuperação nativa do D1)

- Sempre ligado, sem custo. No **plano gratuito a janela é de 7 dias** (30 no pago). Não substitui backup: passou
  de 7 dias, só o export salva.
- A restauração **sobrescreve o próprio banco** (não cria cópia) e cancela consultas em andamento. Pode ser desfeita
  restaurando o bookmark anterior, que o comando mostra.
- Limite: 10 restaurações a cada 10 minutos por banco.
- **Não é automatizado** pelo wrapper. Comandos (manuais, com o wrangler fixado):
  ```
  node node_modules/wrangler/bin/wrangler.js d1 time-travel info <NOME>
  node node_modules/wrangler/bin/wrangler.js d1 time-travel info <NOME> --timestamp=2026-11-12T10:00:00Z
  node node_modules/wrangler/bin/wrangler.js d1 time-travel restore <NOME> --bookmark=<BOOKMARK>
  ```

## 9. Incidentes

### 9.1 Migração falhou ou a verificação posterior acusou problema
1. **Não** rode o `migrate` de novo. Pare as alterações (avise a equipe).
2. Rode `check` e guarde a saída.
3. Se a migração com problema tem reversão testada (001 e 002 têm, em `db/rollbacks/`) e o problema é só ela:
   aplique a reversão com `wrangler d1 execute <NOME> --remote --file db/rollbacks/<arquivo>.down.sql` e remova a linha
   dela de `d1_migrations`; rode `check`.
4. Se não houver reversão segura, ou na dúvida: Time Travel até o **bookmark anotado** antes da migração (seção 8).
5. Rode `check` de novo e registre o ocorrido.

### 9.2 Corrupção (`integrity_check` diferente de ok)
Não grave nada. Time Travel até o último ponto bom (descubra com `time-travel info --timestamp`); se passou de 7 dias,
restaure o último backup verificado (`import` num banco novo, conferência, troca do binding no painel).

### 9.3 Exclusão acidental de dados (ex.: DELETE sem WHERE)
Dentro de 7 dias: Time Travel para antes do erro. Para recuperar só algumas linhas sem voltar o banco inteiro: exporte,
restaure o ponto anterior num `restore-test` a partir de um backup e copie as linhas manualmente, com revisão.

### 9.4 Banco D1 apagado
A Cloudflare só aceita pedido de recuperação (undelete) em até **7 dias**. Depois disso, só backups.

## 10. Ensaio real (pendente — exige autorização para cada passo remoto)

1. Criar os bancos: `wrangler d1 create tatame-staging` e `wrangler d1 create tatame-restore-test`; preencher os IDs
   (seção 3); commit.
2. `export` da produção → `verify` → `anonymize` → `import` em staging → `migrate --env staging` → `check`.
3. Publicar uma prévia do Pages apontando para staging (pelo painel) e testar a aplicação.
4. `restore-test` com o backup anonimizado. (Com o integral, só com autorização específica.)
5. Linha de base da produção (seção 5), `migrate` em produção, deploy.

## 11. Dados pessoais e segredos

- Backups integrais contêm dados de alunos e equipe e hashes de senha/sessão: trate como **sensíveis**. Guarde em disco
  cifrado, fora do OneDrive e do repositório, com acesso só de quem opera o banco.
- O wrapper não imprime valores das linhas; os relatórios mostram só contagens, nomes de tabelas e impressões digitais.
- O manifesto não contém valores das linhas, tokens ou credenciais.
- Eventos de infraestrutura (migração, backup, restauração) **não** vão para o `audit_log` (que é de negócio). A
  auditoria ampliada (migração 003) fica para depois da Etapa 6.

## 12. Limitações conhecidas

- O modo `--local` do próprio wrangler não funciona nesta máquina (o runtime `workerd` falha ao iniciar; o npm bloqueou
  o script de instalação dele). Não afeta os comandos `--remote`. Os testes usam `node:sqlite` diretamente.
- Os testes do wrapper simulam o wrangler sobre SQLite real; o fluxo real contra o D1 só será provado no ensaio da
  seção 10.
- A retenção é calculada, mas a remoção dos backups antigos é manual.
