-- PROPOSTA (não faz parte da cadeia): migração 004, cancelamento, feriado e reposição na agenda, mais proteção de conflito de professor.
-- Para ativar: mover este arquivo para db/migrations/ e o .down.sql para db/rollbacks/ quando a Etapa 6.5 liberar a cadeia
-- (atualizar também db/schema.sql e as listas dos testes schema_check/migration/db_migrate/backup). Enquanto isso o Worker detecta
-- a ausência da tabela e responde 501 nas rotas de cancelamento; nada mais muda. tests/agenda_cancel.mjs aplica este arquivo num banco de teste.
--
-- Modelo: a aula nunca é apagada nem alterada ao cancelar. Cancelar é um REGISTRO À PARTE (exceção) que aponta para a ocorrência.
--   kind = 'cancel'   uma aula (gravada em lessons, ou prevista pela grade: class_id + date) não acontece
--   kind = 'holiday'  nenhuma aula acontece naquele dia (class_id e lesson_id NULL)
-- Restaurar = preencher restored_at/restored_by (a linha fica, é o histórico). Reposição = makeup_lesson_id aponta para a aula criada para repor.
-- Presença nunca é tocada: o Worker recusa cancelar aula que já tem chamada.
CREATE TABLE agenda_exceptions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('cancel', 'holiday')),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  class_id TEXT REFERENCES classes (id) ON DELETE CASCADE,
  lesson_id TEXT REFERENCES lessons (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  created_by TEXT REFERENCES staff (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  restored_by TEXT REFERENCES staff (id) ON DELETE SET NULL,
  restored_at TEXT,
  makeup_lesson_id TEXT REFERENCES lessons (id) ON DELETE SET NULL,
  CHECK (kind = 'cancel' OR (class_id IS NULL AND lesson_id IS NULL)),
  CHECK (kind = 'holiday' OR class_id IS NOT NULL OR lesson_id IS NOT NULL)
);
-- No máximo uma exceção ativa por alvo: a mesma aula (ou turma+dia, ou o dia inteiro) não é cancelada duas vezes, nem em requisições simultâneas.
CREATE UNIQUE INDEX agenda_exc_active_lesson ON agenda_exceptions (lesson_id) WHERE restored_at IS NULL AND lesson_id IS NOT NULL;
CREATE UNIQUE INDEX agenda_exc_active_class_day ON agenda_exceptions (class_id, date) WHERE restored_at IS NULL AND lesson_id IS NULL AND class_id IS NOT NULL;
CREATE UNIQUE INDEX agenda_exc_active_holiday ON agenda_exceptions (date) WHERE restored_at IS NULL AND kind = 'holiday';
CREATE INDEX agenda_exc_date ON agenda_exceptions (date);

-- Proteção atômica contra o mesmo professor em duas aulas sobrepostas (corrida entre duas requisições: a checagem do Worker
-- é só a mensagem amigável; esta trava é a garantia). Aula cancelada não ocupa o professor. Edição só é checada quando data, horário
-- ou professor mudam (conflito antigo não impede corrigir a chamada).
CREATE TRIGGER lessons_no_instructor_overlap_ins BEFORE INSERT ON lessons
WHEN NEW.instructor_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM lessons o WHERE o.instructor_id = NEW.instructor_id AND o.date = NEW.date AND o.id <> NEW.id
    AND o.start_time < NEW.end_time AND o.end_time > NEW.start_time
    AND NOT EXISTS (SELECT 1 FROM agenda_exceptions x WHERE x.lesson_id = o.id AND x.restored_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'conflito_professor'); END;

CREATE TRIGGER lessons_no_instructor_overlap_upd BEFORE UPDATE OF instructor_id, date, start_time, end_time ON lessons
WHEN NEW.instructor_id IS NOT NULL
  AND (OLD.instructor_id IS NOT NEW.instructor_id OR OLD.date <> NEW.date OR OLD.start_time <> NEW.start_time OR OLD.end_time <> NEW.end_time)
  AND EXISTS (
  SELECT 1 FROM lessons o WHERE o.instructor_id = NEW.instructor_id AND o.date = NEW.date AND o.id <> NEW.id
    AND o.start_time < NEW.end_time AND o.end_time > NEW.start_time
    AND NOT EXISTS (SELECT 1 FROM agenda_exceptions x WHERE x.lesson_id = o.id AND x.restored_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'conflito_professor'); END;

-- Restaurar uma aula cancelada a coloca de volta na escala do professor: também não pode sobrepor outra aula dele.
CREATE TRIGGER agenda_exc_restore_no_overlap BEFORE UPDATE OF restored_at ON agenda_exceptions
WHEN OLD.restored_at IS NULL AND NEW.restored_at IS NOT NULL AND NEW.lesson_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM lessons n JOIN lessons o ON o.instructor_id = n.instructor_id AND o.date = n.date AND o.id <> n.id
    AND o.start_time < n.end_time AND o.end_time > n.start_time
  WHERE n.id = NEW.lesson_id AND n.instructor_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM agenda_exceptions x WHERE x.lesson_id = o.id AND x.restored_at IS NULL AND x.id <> NEW.id))
BEGIN SELECT RAISE(ABORT, 'conflito_professor'); END;
