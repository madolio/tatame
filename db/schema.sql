-- =====================================================================
-- TATAME — gestão de academia de jiu-jitsu (Cloudflare D1 / SQLite)
-- Pode rodar de novo sem apagar dados (CREATE ... IF NOT EXISTS / INSERT OR IGNORE).
-- =====================================================================
-- (D1 já aplica chaves estrangeiras; o teste local liga PRAGMA foreign_keys no emulador)

-- ---------- Equipe e autenticação ----------
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'professor' CHECK (role IN ('admin', 'professor')),
  belt TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS auth_sessions_staff ON auth_sessions (staff_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts (key, at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- Alunos ----------
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  nickname TEXT,
  birth_date TEXT,                                  -- AAAA-MM-DD
  sex TEXT CHECK (sex IN ('m', 'f', 'x')),
  phone TEXT,
  email TEXT,
  start_date TEXT NOT NULL,                         -- início na academia
  prior_months INTEGER NOT NULL DEFAULT 0 CHECK (prior_months BETWEEN 0 AND 600),  -- experiência antes da academia
  belt TEXT NOT NULL DEFAULT 'branca' CHECK (belt IN ('branca','cinza','amarela','laranja','verde','azul','roxa','marrom','preta')),
  degrees INTEGER NOT NULL DEFAULT 0 CHECK (degrees BETWEEN 0 AND 6),
  belt_since TEXT NOT NULL,                          -- data em que recebeu a faixa atual
  degree_since TEXT NOT NULL,                        -- data do último grau (ou da faixa)
  imported_classes_belt INTEGER NOT NULL DEFAULT 0 CHECK (imported_classes_belt BETWEEN 0 AND 5000),     -- aulas na faixa atual feitas antes do sistema
  imported_classes_degree INTEGER NOT NULL DEFAULT 0 CHECK (imported_classes_degree BETWEEN 0 AND 5000), -- aulas desde o último grau feitas antes do sistema
  weight_kg REAL CHECK (weight_kg IS NULL OR weight_kg BETWEEN 10 AND 250),
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'trancado', 'inativo')),
  goals TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS students_status ON students (status, name);

-- ---------- Horários (turmas fixas) ----------
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 60),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = domingo
  start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  level TEXT NOT NULL DEFAULT 'todos' CHECK (level IN ('todos', 'iniciante', 'intermediario', 'avancado', 'kids', 'competicao')),
  modality TEXT NOT NULL DEFAULT 'gi' CHECK (modality IN ('gi', 'nogi', 'livre')),
  instructor_id TEXT REFERENCES staff (id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_time > start_time)
);

-- ---------- Aulas dadas, presença e técnicas passadas ----------
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES classes (id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  modality TEXT NOT NULL DEFAULT 'gi' CHECK (modality IN ('gi', 'nogi', 'livre')),
  title TEXT,
  notes TEXT,
  instructor_id TEXT REFERENCES staff (id) ON DELETE SET NULL,
  created_by TEXT REFERENCES staff (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS lessons_date ON lessons (date DESC, start_time);
CREATE UNIQUE INDEX IF NOT EXISTS lessons_class_date ON lessons (class_id, date) WHERE class_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attendance (
  lesson_id TEXT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS attendance_student ON attendance (student_id);

CREATE TABLE IF NOT EXISTS techniques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  category TEXT NOT NULL CHECK (category IN ('Fundamentos','Quedas','Guarda','Raspagens','Passagens','Controle','Costas','Finalizações','Defesas e saídas')),
  min_belt TEXT NOT NULL DEFAULT 'branca' CHECK (min_belt IN ('branca','azul','roxa','marrom','preta')),
  difficulty INTEGER NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 5),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS lesson_techniques (
  lesson_id TEXT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  technique_id INTEGER NOT NULL REFERENCES techniques (id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, technique_id)
);

-- Nível de aprendizado do aluno em cada técnica (0 a 5) e o histórico das avaliações.
CREATE TABLE IF NOT EXISTS skills (
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  technique_id INTEGER NOT NULL REFERENCES techniques (id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 5),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT REFERENCES staff (id) ON DELETE SET NULL,
  PRIMARY KEY (student_id, technique_id)
);
CREATE TABLE IF NOT EXISTS skill_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  technique_id INTEGER NOT NULL REFERENCES techniques (id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  staff_id TEXT REFERENCES staff (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS skill_history_student ON skill_history (student_id, at);

-- ---------- Graduações ----------
CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('grau', 'faixa')),
  from_belt TEXT NOT NULL, from_degrees INTEGER NOT NULL,
  to_belt TEXT NOT NULL, to_degrees INTEGER NOT NULL,
  from_belt_since TEXT, from_degree_since TEXT,       -- para desfazer com segurança
  from_imported_belt INTEGER NOT NULL DEFAULT 0, from_imported_degree INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  criteria_met INTEGER NOT NULL DEFAULT 1,           -- 0 = graduado antes de cumprir os critérios
  notes TEXT,
  staff_id TEXT REFERENCES staff (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS promotions_student ON promotions (student_id, date DESC);

-- Critérios de graduação por faixa (editáveis pela academia).
CREATE TABLE IF NOT EXISTS rules (
  belt TEXT PRIMARY KEY,
  degree_months REAL NOT NULL,        -- tempo mínimo entre graus
  degree_classes INTEGER NOT NULL,    -- aulas mínimas desde o último grau
  belt_months REAL,                   -- tempo mínimo na faixa para a próxima (null = não se aplica)
  belt_classes INTEGER,               -- aulas mínimas na faixa
  curriculum_pct INTEGER,             -- % do currículo da faixa com nível >= 3
  next_min_age INTEGER                -- idade mínima para a próxima faixa
);

-- Padrões: tempos mínimos de faixa (azul 2 anos, roxa 1,5, marrom 1) e idades mínimas
-- (azul/roxa 16, marrom 18, preta 19; amarela 7, laranja 10, verde 13) seguem o Sistema Geral
-- de Graduação da IBJJF (2022). Tempos entre graus e número de aulas são sugestões da academia.
INSERT OR IGNORE INTO rules VALUES
  ('branca',  3,  24, 12,  120, 70, 16),
  ('cinza',   3,  24, 12,   96, 60, 7),
  ('amarela', 3,  24, 12,   96, 60, 10),
  ('laranja', 3,  24, 12,   96, 60, 13),
  ('verde',   3,  24, 12,   96, 70, 16),
  ('azul',    6,  48, 24,  200, 70, 16),
  ('roxa',    4.5,36, 18,  150, 75, 18),
  ('marrom',  3,  24, 12,  100, 80, 19),
  ('preta',  36,   0, NULL, NULL, NULL, NULL);

INSERT OR IGNORE INTO settings (key, value) VALUES ('academy_name', NULL), ('setup_done', '0');
