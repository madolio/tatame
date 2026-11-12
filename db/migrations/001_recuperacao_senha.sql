-- Migração 001 — recuperação de senha por código (entrega manual) e registro de eventos de segurança.
-- Só cria tabelas novas; não altera nem apaga nada que já existe. Pode rodar de novo (IF NOT EXISTS).
-- Reverter: db/migrations/001_recuperacao_senha.down.sql
-- Aplicar:  npx wrangler d1 execute <NOME_DO_BANCO> --remote --file db/migrations/001_recuperacao_senha.sql

-- Um código pendente por pessoa. Guarda apenas o hash (SHA-256) do código, nunca o código.
CREATE TABLE IF NOT EXISTS password_resets (
  staff_id TEXT PRIMARY KEY REFERENCES staff (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Eventos relevantes de segurança. Nunca recebe senha nem código.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event TEXT NOT NULL,
  staff_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
