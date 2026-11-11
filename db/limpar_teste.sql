-- Remove a academia fictícia de teste (alunos, aulas, horários e avaliações marcados como teste).
DELETE FROM lessons WHERE notes = '[teste]';
DELETE FROM students WHERE notes = '[teste]';
DELETE FROM classes WHERE created_at = '2000-01-01T00:00:00.000Z' AND id NOT IN (SELECT class_id FROM lessons WHERE class_id IS NOT NULL);
