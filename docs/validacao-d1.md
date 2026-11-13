# Validação controlada no Cloudflare D1 (checklist para o ensaio real)

**Estado: NADA DESTE DOCUMENTO FOI EXECUTADO.** Ele prepara o primeiro ensaio contra o D1 real. Cada passo remoto
exige autorização explícita do responsável, no momento. Os passos usam **somente bancos descartáveis**
(`tatame-staging` e `tatame-restore-test`, criados para isso) e **dados sintéticos**. Produção não é lida nem escrita
neste ensaio.

Complementa `docs/operacao-banco.md` (runbook). Comandos no formato do Windows (`set`); no Linux/macOS use `export`.

## 0. O que foi conferido sem rede (Etapa 5.2) e o que continua PENDENTE

Fonte das conferências abaixo: código do wrangler **4.155.0** instalado (`node_modules/wrangler/wrangler-dist/cli.js`)
e a leitura da configuração pela API do próprio wrangler (`unstable_readConfig`, sem rede). Comportamento do serviço
D1 só se confirma no ensaio.

| Dúvida | O que se sabe | Situação |
|---|---|---|
| `wrangler d1 export --json` | **Não existe** `--json` no `d1 export` do 4.155.0 (opções: `--output` obrigatório, `--local/--remote`, `--table`, `--no-schema`, `--no-data`, `--skip-confirmation`). O wrapper não usa `--json` no export. `--json` é usado só em `d1 execute` e `d1 time-travel info`. | Conferido no código. Execução real PENDENTE |
| Como o export remoto funciona | Pede o dump à API (`/d1/database/<id>/export`, por polling), recebe uma **URL assinada válida por 1 hora**, **imprime essa URL** e baixa o arquivo. O banco fica indisponível durante o export. | Conferido no código. Duração e indisponibilidade reais PENDENTES |
| URL assinada em log | Por padrão o wrangler grava toda linha do logger em arquivo de depuração (pasta de configuração global, `logs/`), inclusive essa URL. **Correção na 5.2:** o wrapper roda o wrangler com `WRANGLER_WRITE_LOGS=false` (e `WRANGLER_SEND_METRICS=false`). Mensagens de erro do wrapper omitem URLs e literais. | Corrigido e testado localmente. Ausência de arquivo de log no ensaio: conferir no passo 3 |
| `wrangler d1 execute --file` (remoto) | Não executa comando a comando pelo terminal: calcula o MD5 do arquivo, pede `import init` à API, **envia o arquivo para um armazenamento da Cloudflare** (URL de upload), pede `ingest` e acompanha por `poll`. O próprio wrangler afirma: "if the execution fails to complete, your DB will return to its original state". | Fluxo conferido no código. Atomicidade real PENDENTE (passo 7) |
| `BEGIN TRANSACTION` no arquivo | O wrangler remove um `BEGIN TRANSACTION;`/`COMMIT;` e **recusa** arquivo com mais de uma transação ("D1 runs your SQL in a transaction for you"). Os dumps do wrapper não contêm `BEGIN`. | Conferido no código. Comportamento do serviço com dumps do wrapper PENDENTE |
| Ambiente `restore-test` com hífen | Não há regra de nome de ambiente no 4.155.0. `unstable_readConfig` lê `db/wrangler.migrations.jsonc` com `--env restore-test` e devolve `tatame-restore-test`, `migrations_table` `d1_migrations` e `migrations_dir` `migrations`. Ambiente inexistente dá erro. | Leitura da configuração confirmada. Comando remoto com `--env restore-test` PENDENTE (passo 2) |
| `d1_migrations` | Tabela padrão `d1_migrations`, criada com `CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`. Cada migração é enviada como **o conteúdo do arquivo seguido de** `INSERT INTO "d1_migrations" (name) values ('<arquivo>')`, num único comando. É o mesmo formato que o wrapper espera e testa. | Conferido no código. Atomicidade de "migração + registro" PENDENTE (passo 9) |
| SQLite local × D1 | Diferenças conhecidas e tratadas no código: no D1 não se desliga `foreign_keys` (o wrapper usa `PRAGMA defer_foreign_keys` e apaga tabelas filhas antes das pais); tabelas internas `_cf_*` e `sqlite_*` são ignoradas na comparação de schema; o wrapper usa `node:sqlite` nos testes porque o `--local` do wrangler (workerd) não roda nesta máquina. | Simulado localmente. Comportamento real PENDENTE |
| Transações e rollback | Localmente provado só no simulador (SQLite). No D1: ver as linhas acima; o rollback de verdade é o **Time Travel** (restaura o banco inteiro no lugar, 7 dias no plano gratuito). | PENDENTE (passos 7 e 9) |

## 1. Pré-condições (antes de autorizar o primeiro passo remoto)

- Branch do ensaio com `npm test` verde e árvore limpa (`git status` vazio).
- Chave de backup **de ensaio**, diferente da que será usada com produção: `node tools/db.mjs key-generate --out <caminho absoluto>`, `set TATAME_BACKUP_KEY_FILE=...`, cópia conferida com `key-verify-copy`.
- `TATAME_BACKUP_DIR` num diretório **de ensaio**, fora do repositório e do OneDrive.
- `node tools/db.mjs temp-clean` mostra "nenhum resíduo encontrado".
- Wrangler autenticado só pelo responsável (`wrangler login` ou token de escopo mínimo, **nunca** em arquivo do repositório). O token antigo da Cloudflare deve ter sido revogado antes.
- Um terminal só para o ensaio, com a saída gravada **fora do repositório** (ex.: `... 2>&1 | tee D:\ensaio\log.txt`), para o passo 11.

## 2. Passos

Convenções: **Comando** = o que rodar; **Esperado** = o que deve aparecer; **Aprova** = critério objetivo; **Interrompe** =
condição em que se para tudo (não tentar "consertar" no meio: anote, pare e reavalie).

### Passo 1: versão do wrangler
- **Comando:** `node node_modules/wrangler/bin/wrangler.js --version`
- **Esperado:** `4.155.0`.
- **Aprova:** versão idêntica à de `package.json` (o wrapper também confere a cada execução).
- **Interrompe:** qualquer outra versão. Rode `npm ci` e confira de novo. Não use `npx wrangler`.

### Passo 2: criar e identificar os bancos descartáveis
- **Comando (remoto, escrita na conta):** `node node_modules/wrangler/bin/wrangler.js d1 create tatame-staging` e `... d1 create tatame-restore-test`. Depois `... d1 info tatame-staging` e `... d1 info tatame-restore-test`.
- **Esperado:** dois bancos novos, vazios, com UUIDs diferentes entre si e diferentes do banco de produção.
- **Aprova:** preencher `db/environments.json` e `db/wrangler.migrations.jsonc` com os nomes e UUIDs **copiados da saída**, nunca digitados. `node tools/db.mjs check --env restore-test --dry-run` mostra o banner com `tatame-restore-test` e o início do UUID correto. Commit só dos IDs.
- **Interrompe:** UUID igual ao de produção; nome diferente do esperado; `--env restore-test` não reconhecido pelo wrangler; qualquer binding de produção alterado no painel do Pages.

### Passo 3: dados sintéticos no banco descartável e export
- **Comando:** `node tools/db-synthetic.mjs` (offline: grava no armazenamento um backup criptografado do cenário sintético da Etapa 4), depois `node tools/db.mjs import --env staging --backup sintetico-<data>-anon --confirm-destination=tatame-staging` e, por fim, `node tools/db.mjs export --env staging`.
- **Esperado:** `[export] backup staging-<data> gravado (criptografado, AES-256-GCM) e verificado`. Nenhum `[aviso]` de resíduo.
- **Aprova:** existe `TATAME_BACKUP_DIR/staging-<data>/backup.tbk` + `manifest.json`; `temp-clean` sem resíduos; **nenhum arquivo novo** em `logs/` da pasta de configuração do wrangler (conferir a data dos arquivos antes e depois). A saída do terminal não contém URL assinada.
- **Interrompe:** export que termina sem arquivo; arquivo de log do wrangler criado com a URL; texto puro fora da área temporária; erro "D1 reset before export completed".

### Passo 4: criptografia do backup
- **Comando:** `node tools/db.mjs key-check --backup <id>`
- **Esperado:** `esta chave abre <id>: autenticação completa ok`.
- **Aprova:** `backup.tbk` começa com `TATAMEBK` e não contém `CREATE TABLE`/`INSERT` legíveis (ex.: `findstr /m "INSERT INTO" backup.tbk` não encontra nada).
- **Interrompe:** qualquer SQL legível no `.tbk`; chave exibida em qualquer saída.

### Passo 5: integridade e autenticidade
- **Comando:** `node tools/db.mjs verify --backup <id>`. Depois, numa **cópia** do backup, alterar 1 byte e rodar `verify --file <cópia>`.
- **Esperado:** original: `backup autêntico, íntegro e importável`; cópia alterada: `RECUSADO: Autenticação falhou`.
- **Aprova:** os dois resultados acima, código de saída 0 e 3.
- **Interrompe:** cópia alterada aceita; original reprovado.

### Passo 6: descriptografia e validação do SQL
- **Comando:** `node tools/db.mjs anonymize --backup <id>` (se o backup não for anonimizado) ou `verify` já cobre a validação.
- **Esperado:** hash, import em SQLite temporário, `integrity_check`, `foreign_key_check`, contagens e schema `ok`.
- **Aprova:** todas as verificações `ok`; schema igual ao esperado para as migrações registradas.
- **Interrompe:** qualquer `FALHOU`. Isso indica diferença entre o que o D1 exporta e o que o wrapper espera (registrar exatamente qual).

### Passo 7: restauração em banco descartável
- **Comando:** `node tools/db.mjs restore-test --env restore-test --backup <id> --confirm-destination=tatame-restore-test` (com `--replace` se o banco não estiver vazio).
- **Esperado:** `[import] tatame-restore-test: contagens iguais às do manifesto` e `[restore-test] OK: ... 0 divergências`.
- **Aprova:** ida e volta idêntica (schema e contagens) e Worker real sem divergências; `status.json` com `ok: true`.
- **Teste de atomicidade (PENDENTE de confirmação):** importar no `restore-test` um arquivo sintético com um erro proposital no meio e conferir que o banco ficou **como antes** (zero tabelas novas). Se ficar parcialmente importado, registrar: o `--replace` + reimportação passa a ser o procedimento obrigatório após falha.
- **Interrompe:** contagem diferente; erro de chave estrangeira na importação; banco parcialmente importado sem aviso.

### Passo 8: tabelas, índices, chaves estrangeiras e dados
- **Comando:** `node tools/db.mjs check --env restore-test`
- **Esperado:** schema igual ao esperado (inclui índices e gatilhos na impressão digital), `integrity_check` ok, `foreign_key_check` vazio.
- **Aprova:** veredito ok; contagens iguais às do manifesto (já conferidas no passo 7).
- **Interrompe:** objeto faltando ou sobrando (exceto `_cf_*`/`sqlite_*`, ignorados).

### Passo 9: migrações em ambiente descartável
- **Comando:** `node tools/db-synthetic.mjs --sem-002`, restaurar esse backup no `restore-test` (`import --env restore-test ... --replace`), depois `node tools/db.mjs migrate --env restore-test --dry-run` e `node tools/db.mjs migrate --env restore-test`. Depois `check --env restore-test`.
- **Esperado:** `002_marcador_de_chamada.sql` e `003_auditoria_e_ultimo_admin.sql` pendentes; aplicadas; `d1_migrations` com 000 a 003; schema igual ao esperado (inclui os gatilhos `staff_keep_active_admin` e `staff_keep_active_admin_on_delete`).
- **003 no D1 (PENDENTE):** confirmar `ALTER TABLE ... ADD COLUMN` com `CHECK`; que `UPDATE staff SET active = 0` no único admin ativo, via `d1 execute --command`, falha com `ultimo_admin_ativo` e não muda nada; idem para `DELETE FROM staff WHERE id = ...` no único admin ativo (a linha continua); o formato do erro devolvido (D1_ERROR/SQLITE_CONSTRAINT); que o gatilho aborta o `batch` inteiro; e, no rollback (só no restore-test), `DROP TRIGGER` (os dois) + `ALTER TABLE ... DROP COLUMN` preservando os registros.
- **Aprova:** `check` ok e o bookmark do Time Travel anotado antes da migração.
- **Teste de rollback (PENDENTE):** usar o bookmark anotado com `wrangler d1 time-travel restore tatame-restore-test --bookmark=<...>` **somente no restore-test** e confirmar o schema anterior. Confirma na prática o procedimento de incidente 9.1.
- **Interrompe:** migração aplicada sem registro em `d1_migrations` (ou o contrário); qualquer comando com o nome de produção.

### Passo 10: aplicação contra o ambiente de teste
- **Comando:** prévia do Pages apontando para `tatame-staging` (binding configurado **na prévia**, pelo painel, nunca alterando produção), e `npm run test:e2e` contra a URL da prévia, se aplicável. Senão, roteiro manual: login com conta criada via `tools/reset-code.mjs`, alunos, chamada, graduação e painel.
- **Auditoria 6.4-C no D1 (PENDENTE):** depois do roteiro, `SELECT at, event, actor_id, target_type, target_id, outcome, detail FROM audit_log ORDER BY id DESC LIMIT 50` no staging. Confirmar: um evento por ação feita, com ator e alvo certos; `INSERT ... SELECT ... WHERE <condição>` dentro de `batch` grava só quando a escrita acontece; `technique_created` com o id real (subconsulta pelo nome no mesmo batch); `action_denied` limitado a um por ator/ação em 15 min (usa `json_extract` em `detail`); exportação sem evento = sem arquivo; nada de nome, e-mail, telefone ou segredo em `detail`.
- **Esperado:** aplicação funcional com os dados do staging.
- **Aprova:** roteiro completo sem erro; nenhum dado de produção visível.
- **Interrompe:** prévia lendo o banco de produção; erro 500 em qualquer rota.

### Passo 11: produção não foi alterada
- **Comando:** procurar no log do ensaio (`D:\ensaio\log.txt`) por linhas `[tatame-db] wrangler ` e conferir os nomes de banco; `node node_modules/wrangler/bin/wrangler.js d1 list` (somente leitura).
- **Esperado:** todos os comandos citam apenas `tatame-staging` ou `tatame-restore-test`; nenhum `--env production`; `d1 list` mostra produção com o mesmo UUID de antes; o binding `DB` do projeto Pages de produção no painel continua apontando para o banco de produção.
- **Aprova:** zero ocorrências do nome ou UUID de produção no log; painel inalterado.
- **Interrompe:** qualquer ocorrência. Nesse caso, avaliar imediatamente o Time Travel da produção (runbook, seção 8) com o responsável.

## 3. Encerramento do ensaio
- `node tools/db.mjs temp-clean` (sem resíduos).
- Apagar os backups de ensaio e, se não forem mais usados, a chave de ensaio. Manter o log do ensaio fora do repositório.
- Registrar no runbook (seção 12) o que foi confirmado e o que mudou em relação às linhas PENDENTE da tabela da seção 0.
- Só depois disso: linha de base da produção, primeiro backup real e migração (runbook, seções 5 e 10), cada um com autorização própria.
