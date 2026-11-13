-- Migração 003: auditoria estruturada (ator, alvo, resultado) e trava do último administrador ativo.
-- Aplicar somente via `node tools/db.mjs migrate` (docs/operacao-banco.md). UMA vez: ALTER TABLE ADD COLUMN não é
-- idempotente no SQLite (a segunda execução falha em "duplicate column" antes de mudar qualquer coisa).
-- Reversão: db/rollbacks/003_auditoria_e_ultimo_admin.down.sql.

-- Colunas novas, todas anuláveis. Registros antigos ficam com NULL: não há preenchimento retroativo (staff_id às vezes
-- é o ator e às vezes o alvo, e nada no banco permite distinguir com segurança). staff_id continua existindo.
-- Sem chave estrangeira em actor_id: o registro de auditoria precisa sobreviver à pessoa ou ao alvo.
-- Sem índice novo: nenhuma consulta do sistema filtra por essas colunas ainda (a leitura é por data, audit_log_at).
ALTER TABLE audit_log ADD COLUMN actor_id TEXT;
ALTER TABLE audit_log ADD COLUMN target_type TEXT CHECK (target_type IS NULL OR target_type IN ('staff', 'student', 'lesson', 'promotion', 'class', 'technique', 'rules', 'settings', 'export'));
ALTER TABLE audit_log ADD COLUMN target_id TEXT;
ALTER TABLE audit_log ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ok', 'denied', 'limit'));

-- Segunda camada do V8 (a primeira é a condição atômica do PUT /api/staff/:id): nenhuma atualização, nem SQL direto,
-- pode deixar o banco sem administrador ativo. Só dispara quando a linha ERA admin ativo e deixa de ser; renomear,
-- trocar faixa ou senha do último admin não é afetado. INSERT não precisa de trava: inserir nunca reduz os admins ativos.
-- A mensagem não contém dados (nem id, nem e-mail).
CREATE TRIGGER staff_keep_active_admin BEFORE UPDATE OF role, active ON staff
FOR EACH ROW
WHEN OLD.role = 'admin' AND OLD.active = 1 AND NOT (NEW.role = 'admin' AND NEW.active = 1)
  AND NOT EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1 AND id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'ultimo_admin_ativo');
END;

-- Mesma regra para exclusão: apagar quem não é admin ativo (professor ou admin inativo) segue permitido; apagar um admin
-- ativo só quando existe outro. Hoje não há endpoint de exclusão de equipe: isto protege o SQL direto. FOR EACH ROW vale
-- para DELETE de várias linhas: a última linha admin ativa aborta o comando inteiro (nenhuma linha é apagada).
CREATE TRIGGER staff_keep_active_admin_on_delete BEFORE DELETE ON staff
FOR EACH ROW
WHEN OLD.role = 'admin' AND OLD.active = 1
  AND NOT EXISTS (SELECT 1 FROM staff WHERE role = 'admin' AND active = 1 AND id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'ultimo_admin_ativo');
END;
