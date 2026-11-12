-- Reverte a migração 001. Apaga os códigos pendentes e o registro de eventos; contas e senhas não são tocadas.
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS audit_log;
