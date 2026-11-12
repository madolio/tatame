-- Migração 002: marcador de chamada em lessons.
--   roll_called = 1    a chamada foi feita (pode ter zero presentes)
--   roll_called = 0    aula dada sem chamada
--   roll_called IS NULL  desconhecido (histórico anterior à migração, sem evidência)
-- Aplicar somente via `node tools/db.mjs migrate` (docs/operacao-banco.md). UMA vez, antes de publicar o Worker que lê a coluna (ALTER TABLE ADD COLUMN não é idempotente no SQLite).
-- Reversão: db/rollbacks/002_marcador_de_chamada.down.sql.
ALTER TABLE lessons ADD COLUMN roll_called INTEGER CHECK (roll_called IN (0, 1));

-- Backfill só com evidência confiável: aula com ao menos uma presença registrada teve chamada.
-- Aulas sem presença NÃO são classificadas: podem ser "sem chamada" ou "chamada com zero presentes" e nada no banco permite saber.
UPDATE lessons SET roll_called = 1 WHERE EXISTS (SELECT 1 FROM attendance a WHERE a.lesson_id = lessons.id);
