-- Academia fictícia para testes. Tudo marcado com '[teste]'. Remover com db/limpar_teste.sql.
INSERT INTO students (id, name, nickname, birth_date, phone, start_date, prior_months, belt, degrees, belt_since, degree_since, imported_classes_belt, imported_classes_degree, weight_kg, status, goals, notes)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  n, nk, bd, '11 9' || (10000000 + abs(random()) % 89999999), date('now', '-' || (bdays + st) || ' days'), pm, b, dg, date('now', '-' || bdays || ' days'), date('now', '-' || min(dd, bdays) || ' days'), ib, idg, w, s, g, '[teste]'
FROM (SELECT column1 n, column2 nk, column3 bd, column4 b, column5 dg, column6 bdays, column7 dd, column8 ib, column9 idg, column10 pm, column11 w, column12 s, column13 g, column14 st FROM (VALUES
 ('Ana Clara Lima','Aninha','1997-04-10','branca',4,420,110,110,35,0,61,'ativo','Competir',90),
 ('Bruno Costa',NULL,'2001-08-21','branca',2,160,70,20,10,0,78,'ativo','Condicionamento',30),
 ('Caio Mendes',NULL,'2003-01-02','branca',0,35,35,0,0,0,70,'ativo','Defesa pessoal',0),
 ('Daniela Rocha','Dani','1995-11-30','azul',3,780,190,140,30,0,58,'ativo','Competir',300),
 ('Eduardo Pires','Dudu','1992-06-15','azul',1,320,200,40,25,0,92,'ativo','Hobby e saúde',400),
 ('Fernanda Alves','Fê','1990-02-03','roxa',2,520,150,60,20,0,63,'ativo','Competir',900),
 ('Gabriel Nunes',NULL,'1988-09-09','marrom',1,260,250,20,20,0,85,'ativo','Hobby e saúde',1500),
 ('Helena Dias',NULL,'2000-12-12','branca',1,95,95,0,0,0,57,'ativo','Defesa pessoal',10),
 ('Igor Teixeira',NULL,'1999-03-03','azul',1,70,10,0,0,0,80,'ativo','Competir',500),
 ('João Pedro Souza','JP',date('now','-3700 days'),'cinza',2,210,120,30,10,0,34,'ativo','Hobby e saúde',100),
 ('Lucas Martins',NULL,'1998-07-07','branca',3,230,115,40,15,0,74,'ativo','Condicionamento',60),
 ('Marina Couto','Mari','2002-05-19','branca',1,60,60,0,0,0,55,'ativo','Defesa pessoal',0),
 ('Nicolas Ferreira',NULL,date('now','-3020 days'),'amarela',1,150,70,10,5,0,29,'ativo','Hobby e saúde',150),
 ('Otávio Ramos','Tavinho','1985-01-20','preta',2,1500,600,0,0,120,88,'ativo','Competir',2000),
 ('Paula Santos',NULL,'1996-10-08','azul',2,400,160,30,10,0,60,'ativo','Condicionamento',300),
 ('Rafael Gomes','Rafa','1993-08-28','roxa',1,90,12,0,0,0,82,'ativo','Competir',1100),
 ('Sofia Barros',NULL,date('now','-2200 days'),'cinza',0,40,40,0,0,0,22,'ativo','Hobby e saúde',0),
 ('Thiago Moreira',NULL,'1994-03-15','branca',4,380,140,80,30,0,77,'ativo','Hobby e saúde',20),
 ('Vinícius Lopes','Vini','1991-12-01','azul',4,760,130,200,45,0,79,'ativo','Competir',200),
 ('William Duarte',NULL,'2004-06-06','branca',1,20,3,0,0,0,68,'ativo','Condicionamento',0),
 ('Yasmin Freitas',NULL,'1999-09-17','branca',2,200,100,10,5,0,59,'trancado','Hobby e saúde',100),
 ('Zeca Almeida',NULL,'1987-02-27','azul',1,300,180,20,10,0,95,'inativo','Hobby e saúde',300)));

INSERT INTO classes (id, name, weekday, start_time, end_time, level, modality, created_at)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  column1, column2, column3, column4, column5, column6, '2000-01-01T00:00:00.000Z' FROM (VALUES
 ('Fundamentos',1,'07:00','08:00','iniciante','gi'),('Fundamentos',1,'19:00','20:00','iniciante','gi'),('Avançada',1,'20:00','21:30','avancado','gi'),
 ('No-gi',2,'19:30','21:00','todos','nogi'),('Kids',2,'18:00','18:50','kids','gi'),('Fundamentos',3,'07:00','08:00','iniciante','gi'),
 ('Fundamentos',3,'19:00','20:00','iniciante','gi'),('Avançada',3,'20:00','21:30','avancado','gi'),('Kids',4,'18:00','18:50','kids','gi'),
 ('No-gi',4,'19:30','21:00','todos','nogi'),('Todos os níveis',5,'19:00','20:30','todos','gi'),('Competição',5,'20:30','22:00','competicao','gi'),
 ('Open mat',6,'10:00','12:00','todos','livre'));

-- 12 semanas de aulas (até ontem; hoje fica livre para testar a chamada)
WITH RECURSIVE d(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM d WHERE n < 84)
INSERT INTO lessons (id, class_id, date, start_time, end_time, modality, title, notes)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  c.id, date('now', '-' || d.n || ' days'), c.start_time, c.end_time, c.modality, NULL, '[teste]'
FROM d JOIN classes c ON c.weekday = CAST(strftime('%w', date('now', '-' || d.n || ' days')) AS INTEGER) AND c.created_at = '2000-01-01T00:00:00.000Z';

-- Técnicas passadas (1 ou 2 por aula, do currículo adequado ao nível da turma)
INSERT OR IGNORE INTO lesson_techniques (lesson_id, technique_id)
SELECT l.id, (SELECT t.id FROM techniques t WHERE t.min_belt IN (CASE WHEN c.level IN ('avancado','competicao') THEN 'azul' ELSE 'branca' END, CASE WHEN c.level IN ('avancado','competicao') THEN 'roxa' ELSE 'branca' END) AND length(l.id) > 0 ORDER BY random() LIMIT 1)
FROM lessons l JOIN classes c ON c.id = l.class_id WHERE l.notes = '[teste]';
INSERT OR IGNORE INTO lesson_techniques (lesson_id, technique_id)
SELECT l.id, (SELECT t.id FROM techniques t WHERE t.min_belt IN (CASE WHEN c.level IN ('avancado','competicao') THEN 'azul' ELSE 'branca' END, 'branca') AND length(l.id) > 0 ORDER BY random() LIMIT 1)
FROM lessons l JOIN classes c ON c.id = l.class_id WHERE l.notes = '[teste]' AND abs(random()) % 2 = 0;
UPDATE lessons SET title = (SELECT CASE t.category WHEN 'Fundamentos' THEN 'Fundamentos e movimentação' WHEN 'Quedas' THEN 'Quedas e projeções' WHEN 'Guarda' THEN 'Trabalho de guarda'
  WHEN 'Passagens' THEN 'Passagem de guarda' WHEN 'Controle' THEN 'Controle e transições' WHEN 'Costas' THEN 'Pegada das costas' ELSE t.category END
  FROM lesson_techniques lt JOIN techniques t ON t.id = lt.technique_id WHERE lt.lesson_id = lessons.id LIMIT 1) WHERE notes = '[teste]';

-- Presença: probabilidade por aluno, ajustada pelo tipo de turma
INSERT OR IGNORE INTO attendance (lesson_id, student_id)
SELECT l.id, s.id FROM lessons l JOIN classes c ON c.id = l.class_id JOIN students s ON s.notes = '[teste]'
JOIN (SELECT column1 nm, column2 f FROM (VALUES ('Ana Clara Lima',85),('Bruno Costa',70),('Caio Mendes',60),('Daniela Rocha',75),('Eduardo Pires',50),('Fernanda Alves',85),
  ('Gabriel Nunes',45),('Helena Dias',12),('Igor Teixeira',75),('João Pedro Souza',75),('Lucas Martins',40),('Marina Couto',80),('Nicolas Ferreira',70),('Otávio Ramos',60),
  ('Paula Santos',30),('Rafael Gomes',80),('Sofia Barros',60),('Thiago Moreira',65),('Vinícius Lopes',55),('William Duarte',90),('Yasmin Freitas',35),('Zeca Almeida',35))) fq ON fq.nm = s.name
WHERE l.notes = '[teste]' AND l.date >= s.start_date
  AND ((c.level = 'kids') = (s.belt IN ('cinza','amarela','laranja','verde')))
  AND NOT (s.name = 'Lucas Martins' AND l.date > date('now','-25 days'))
  AND NOT (s.status <> 'ativo' AND l.date > date('now','-45 days'))
  AND abs(random()) % 1000 < fq.f * 5.5
    * (CASE WHEN c.level = 'avancado' AND s.belt = 'branca' THEN 0.15 WHEN c.level = 'competicao' AND s.belt IN ('branca','cinza','amarela') THEN 0.1 ELSE 1 END)
    * (CASE WHEN c.start_time = '07:00' THEN 0.5 ELSE 1 END)
    * (CASE WHEN s.belt IN ('cinza','amarela','laranja','verde') THEN 1.6 ELSE 1 END);

-- Avaliação das técnicas (0–5) coerente com a faixa e o tempo de treino
INSERT OR REPLACE INTO skills (student_id, technique_id, level, updated_at)
SELECT s.id, t.id,
  max(0, min(5, CAST(round(
    (br.r - tr.r) * 1.2 + 1 + s.degrees * 0.35
    + (CASE s.name WHEN 'Ana Clara Lima' THEN 1.6 WHEN 'Vinícius Lopes' THEN 1.3 WHEN 'Thiago Moreira' THEN 0.5 ELSE 0 END)
    + (abs(random()) % 160) / 100.0 - 0.8 - t.difficulty * 0.25) AS INTEGER))),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (abs(random()) % 60) || ' days')
FROM students s
JOIN (SELECT column1 b, column2 r FROM (VALUES ('branca',0),('cinza',0),('amarela',0),('laranja',0),('verde',0),('azul',1),('roxa',2),('marrom',3),('preta',4))) br ON br.b = s.belt
JOIN techniques t JOIN (SELECT column1 b, column2 r FROM (VALUES ('branca',0),('azul',1),('roxa',2),('marrom',3),('preta',4))) tr ON tr.b = t.min_belt
WHERE s.notes = '[teste]' AND tr.r <= br.r AND NOT (s.degrees = 0 AND br.r = 0 AND abs(random()) % 2 = 0);
-- quem viu a técnica em aula tem pelo menos nível 1
INSERT INTO skills (student_id, technique_id, level)
SELECT DISTINCT a.student_id, lt.technique_id, 1 FROM attendance a JOIN lesson_techniques lt ON lt.lesson_id = a.lesson_id JOIN students s ON s.id = a.student_id AND s.notes = '[teste]'
WHERE true ON CONFLICT (student_id, technique_id) DO UPDATE SET level = 1 WHERE skills.level < 1;

-- Graduações recentes registradas no sistema
INSERT INTO promotions (id, student_id, kind, from_belt, from_degrees, to_belt, to_degrees, from_belt_since, from_degree_since, date, criteria_met, notes)
SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
  s.id, 'grau', s.belt, s.degrees - 1, s.belt, s.degrees, s.belt_since, date(s.degree_since, '-120 days'), s.degree_since, x.ok, x.nt
FROM students s JOIN (SELECT column1 nm, column2 ok, column3 nt FROM (VALUES ('William Duarte',0,'Grau de incentivo [teste]'),('Igor Teixeira',1,'Graduação de fim de mês [teste]'),('Rafael Gomes',1,'Graduação de fim de mês [teste]'))) x ON x.nm = s.name
WHERE s.notes = '[teste]';
UPDATE settings SET value = COALESCE(value, 'Academia (dados de teste)') WHERE key = 'academy_name';
