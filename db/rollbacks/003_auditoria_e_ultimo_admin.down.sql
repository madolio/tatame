-- Reverte a migração 003: remove as duas travas do último admin (UPDATE e DELETE) e as 4 colunas novas de audit_log.
-- Os registros de auditoria NÃO são apagados: id, at, event, staff_id e detail ficam intactos (perdem-se só os valores
-- das colunas novas). DROP COLUMN não recria a tabela; exige SQLite 3.35+ (D1 e node:sqlite têm), como a 002.
DROP TRIGGER IF EXISTS staff_keep_active_admin_on_delete;
DROP TRIGGER IF EXISTS staff_keep_active_admin;
ALTER TABLE audit_log DROP COLUMN outcome;
ALTER TABLE audit_log DROP COLUMN target_id;
ALTER TABLE audit_log DROP COLUMN target_type;
ALTER TABLE audit_log DROP COLUMN actor_id;
