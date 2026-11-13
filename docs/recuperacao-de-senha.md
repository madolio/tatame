# Recuperação de senha por código (entrega manual)

Para quem opera o Tatame e para o administrador da academia. Decisão e justificativa: `docs/decisoes-etapa-0.md`, item 0.2.

## Quando usar

- **Professor esqueceu a senha:** o administrador troca em *Ajustes > Equipe*. Não precisa de código.
- **Administrador esqueceu a senha:** use o procedimento abaixo. Se a academia tiver dois administradores, um redefine a senha do outro em *Equipe* e o procedimento abaixo vira último recurso.

## Procedimento do operador

1. **Confirme a identidade de quem pede.** Ligue para um número que você já conhecia (não o que veio na mensagem do pedido) ou confirme dados que só o administrador saberia (nome da academia, data de cadastro de um aluno). Sem confirmação, não gere código.
2. Rode, na pasta do projeto, com o Wrangler já autenticado:
   ```
   node tools/reset-code.mjs --email admin@academia.com --db NOME_DO_BANCO_D1 --remote
   ```
   `--local` usa o banco de desenvolvimento. É obrigatório informar um dos dois, para não agir em produção por engano.
3. O script mostra o banco, o nome e a função da conta e pede para você **digitar o e-mail da conta**. Só então gera o código.
4. O código aparece uma única vez, no formato `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X`. Só o hash dele vai para o banco; ninguém consegue consultá-lo depois.
5. Entregue o código ao administrador **por um canal diferente do que pediu a ajuda** (por exemplo, pediu por e-mail, entregue por telefone ou WhatsApp conhecido). Não o escreva em chamados, planilhas ou conversas de grupo.

O código vale **30 minutos**, serve **uma vez** e é invalidado se um novo for gerado para a mesma conta.

## Passo a passo do administrador

1. Na tela de login, toque em **Tenho um código de recuperação**.
2. Informe o e-mail da conta, o código recebido, a nova senha (mínimo 10 caracteres; senhas muito comuns, iguais ao e-mail ou de um caractere repetido são recusadas) e repita a senha.
3. Ao ver "Senha redefinida", entre com a nova senha. Todos os aparelhos que estavam conectados nessa conta são desconectados.

Mensagens possíveis: *código inválido* (também aparece para e-mail errado, de propósito), *código expirado*, *código já utilizado*, *muitas tentativas*. Em qualquer uma, peça um código novo.

## O que o sistema garante

- Código de 130 bits gerado com `crypto.randomBytes`; banco guarda só `SHA-256(conta + código)`.
- Comparação em tempo constante; 30 minutos de validade; consumo atômico (duas requisições simultâneas não usam o mesmo código).
- 5 erros contra um código o invalidam; além disso valem os limites de 8 tentativas por par (e-mail, IP) e 30 por IP em 15 minutos.
- A resposta não revela se o e-mail existe nem se há código pendente.
- Eventos `reset_issued`, `reset_failed` e `reset_used` ficam em `audit_log`, sem código nem senha. Consulta:
  ```
  node node_modules/wrangler/bin/wrangler.js d1 execute NOME_DO_BANCO_D1 --remote --command "SELECT at, event, staff_id, detail FROM audit_log ORDER BY id DESC LIMIT 20"
  ```

## Migração (antes do primeiro deploy desta versão)

A versão nova do Worker precisa das tabelas `password_resets` e `audit_log` (migração `001`) e da coluna `lessons.roll_called` (migração `002`). As migrações são aplicadas **somente** pelo procedimento de [docs/operacao-banco.md](operacao-banco.md): backup verificado, linha de base, `node tools/db.mjs migrate`, verificação. Não aplique arquivos de migração à mão com `wrangler d1 execute`. Reversão testada: `db/rollbacks/001_recuperacao_senha.down.sql` (apaga só essas duas tabelas), conforme a seção de incidentes do runbook.

## Preparado para e-mail no futuro

A rota `POST /api/reset` só valida (e-mail, código, nova senha). Quem entrega o código é o script. Um fluxo por e-mail reaproveitaria a mesma tabela e a mesma validação; mudaria apenas o emissor, que passaria a ser uma rota pública `POST /api/reset/request` (resposta sempre igual, limite de tentativas) enviando o código por um provedor.
