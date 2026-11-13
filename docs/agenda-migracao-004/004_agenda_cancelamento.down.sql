-- Reverte a proposta 004: remove as travas e a tabela de exceções (aulas e presenças não são tocadas; o histórico de cancelamentos some, o audit_log permanece).
DROP TRIGGER IF EXISTS agenda_exc_restore_no_overlap;
DROP TRIGGER IF EXISTS lessons_no_instructor_overlap_upd;
DROP TRIGGER IF EXISTS lessons_no_instructor_overlap_ins;
DROP TABLE IF EXISTS agenda_exceptions;
