# Nova instalação: primeiro acesso com código de ativação

Este procedimento é **só para uma academia nova**, com banco vazio. Uma academia já configurada (com equipe
cadastrada) **não faz nada disso**: o setup dela está fechado para sempre, e nenhuma ferramenta o reabre. Na operação
normal, a equipe é cadastrada pelo administrador em "Equipe" e a recuperação de senha segue `docs/recuperacao-de-senha.md`.

## Por que existe

Sem o código, quem abrisse o site novo antes do dono podia se cadastrar como administrador (falha V1 da auditoria da
Etapa 6). Agora:
- o primeiro acesso **sempre** exige o código de ativação;
- sem código configurado no banco, o setup fica **fechado**;
- código errado, vencido ou já usado é recusado com a mesma mensagem genérica;
- no banco fica só o **hash** do código e a validade, nunca o código;
- o administrador, o nome da academia e o consumo do código são gravados numa única transação, condicionada a "não
  há equipe e o código ainda vale". Só uma requisição consegue concluir o setup.

## Passos

Cada passo remoto exige autorização de quem responde pela conta Cloudflare.

1. **Criar a instalação.** Projeto Pages novo com o conteúdo de `web/` e um banco D1 novo, ligado ao projeto pelo binding
   `DB` (no painel). O banco de uma academia nunca é compartilhado com outra.
2. **Preparar o schema** no banco novo, com o wrangler fixado:
   `node node_modules/wrangler/bin/wrangler.js d1 execute <banco novo> --remote --file db/schema.sql`
   e `... --file db/seed_tecnicas.sql`. Depois, cadastrar o banco em `db/environments.json` e registrar a linha de base (`docs/operacao-banco.md`, seções 3 e 5).
3. **Gerar o código** (o operador, no próprio terminal, interativo):
   ```
   node tools/setup-code.mjs --db <banco novo> --remote
   ```
   A ferramenta confere que o banco não tem equipe, pede para digitar o nome do banco de novo, grava o hash e a
   validade (padrão 72 h; `--hours 1..168`) e mostra o código **uma única vez**. Ela recusa o banco de produção listado em
   `db/environments.json` e qualquer banco que já tenha equipe.
4. **O código fica no banco só como hash.** Nada a configurar no painel, nada em variável de ambiente, nada no Git.
5. **Entregar o código** ao responsável pela academia por um canal humano (pessoalmente ou por telefone, em canal
   diferente do que pediu a instalação). Não envie por e-mail junto com o endereço do site e não guarde o código.
6. **Primeiro acesso.** O responsável abre o site, vê "Primeiro acesso", informa o código, o nome da academia e os
   próprios dados. Ele vira o administrador e entra direto.
7. **O código é consumido** na mesma transação: hash e validade são apagados.
8. **Confirmar que o setup fechou:**
   ```
   node node_modules/wrangler/bin/wrangler.js d1 execute <banco> --remote --json --command "SELECT (SELECT count(*) FROM staff) equipe, (SELECT count(*) FROM settings WHERE key LIKE 'setup_token%') codigos"
   ```
   Esperado: `equipe` = 1 e `codigos` = 0. Também: a tela inicial mostra o login (não mais "Primeiro acesso").

## Situações

- **Código venceu ou se perdeu antes do uso:** gere outro com `--replace` (exige nova confirmação). O anterior deixa
  de valer na hora.
- **Alguém tentou o código errado:** nada acontece; o código certo continua valendo até vencer.
- **A ferramenta disse que o código não ficou gravado como esperado:** ela não mostrou código nenhum. Confira o banco
  (passo 8) e rode de novo.
- **Instalação preparada antes desta correção** (código antigo em texto puro, `setup_token`): não é mais aceito. Gere um
  código novo com `tools/setup-code.mjs` (ele apaga o antigo).

## O que foi provado e o que está PENDENTE

- Provado localmente (`tests/setup.mjs`, Worker real sobre o shim do D1 em `node:sqlite`): todas as recusas, o caminho
  feliz, 10 setups simultâneos com o mesmo código (exatamente 1 sucesso, 1 administrador, código consumido uma vez),
  falha no meio do batch sem nada gravado, e a ferramenta do operador com o wrangler simulado.
- Provado em SQLite real com duas conexões: a segunda escrita espera a primeira, e a inserção condicionada não insere
  nada depois que a primeira concluiu.
- **PENDENTE no D1 real:** o shim executa o batch numa transação local e serializa as requisições do mesmo processo. No
  D1, a atomicidade do `batch` (tudo ou nada, comandos em sequência) e a execução serializada por banco vêm da
  documentação da Cloudflare, não de teste nosso. A proteção não depende de a verificação em JavaScript ser exata: a
  condição está dentro do próprio `INSERT`. Confirmar no ensaio (`docs/validacao-d1.md`) com dois setups simultâneos
  num banco descartável.
- **PENDENTE:** a ferramenta contra um D1 remoto real (leitura por `--command`, gravação por `--file`).
