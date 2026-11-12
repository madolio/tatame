-- Reverte a migração 002: remove a coluna lessons.roll_called (aulas e presenças não são tocadas).
-- Exige SQLite 3.35+ (D1 e node:sqlite têm).
ALTER TABLE lessons DROP COLUMN roll_called;
