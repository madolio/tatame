// Revisão da pseudonimização (tools/db/anonymize.mjs): regra fechada, campos curtos, campos livres, quase-identificadores.
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { anonymize, leakReport, RULES, AnonymizationError } from '../tools/db/anonymize.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const fresh = () => { const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }); db.exec(SCHEMA); return db; };
const seed = db => {
  db.exec(`INSERT INTO staff (id, name, email, pass_hash, pass_salt, role, created_at) VALUES ('st1', 'Léo Prado', 'leo@academia.test', 'hashreal', 'salreal', 'admin', '2025-03-04T15:22:31.123Z');
    INSERT INTO students (id, name, nickname, birth_date, sex, phone, email, start_date, belt_since, degree_since, weight_kg, goals, notes, created_at, updated_at) VALUES
      ('a1', 'Ana Lu', 'Zé', '2012-11-23', 'f', '(11) 91234-5678', 'ana@familia.test', '2025-01-10', '2025-01-10', '2025-01-10', 41.5, 'competir', 'mãe liga às 18h', '2025-01-10T19:01:02.000Z', '2025-02-01T08:00:00.000Z'),
      ('a2', 'Bruno Kimura Souza', NULL, NULL, 'm', NULL, NULL, '2024-05-02', '2024-05-02', '2024-05-02', NULL, NULL, NULL, '2024-05-02T10:00:00.000Z', '2024-05-02T10:00:00.000Z');
    INSERT INTO classes (id, name, weekday, start_time, end_time, level) VALUES ('c1', 'Fundamentos 19h', 1, '19:00', '20:00', 'todos');
    INSERT INTO techniques (id, name, category, min_belt, difficulty, description) VALUES (1, 'Armlock da guarda', 'Finalizações', 'branca', 2, 'Clássica'), (2, 'Triângulo', 'Finalizações', 'branca', 2, NULL), (3, 'Raspagem de gancho', 'Raspagens', 'branca', 1, NULL);
    INSERT INTO lessons (id, class_id, date, start_time, end_time, title, notes, created_by, created_at) VALUES ('l1', 'c1', '2025-06-02', '19:00', '20:00', 'Guarda da Ana', 'Ana machucou o joelho', 'st1', '2025-06-02T20:10:00.000Z');
    INSERT INTO attendance VALUES ('l1', 'a1');
    INSERT INTO promotions (id, student_id, kind, from_belt, from_degrees, to_belt, to_degrees, from_belt_since, from_degree_since, date, notes, staff_id, created_at) VALUES ('p1', 'a1', 'grau', 'branca', 0, 'branca', 1, '2025-01-10', '2025-01-10', '2025-06-01', 'cerimônia com o Léo', 'st1', '2025-06-01T12:00:00.000Z');
    INSERT INTO auth_sessions (token_hash, staff_id, expires_at) VALUES ('tokenhash', 'st1', '2999-01-01');
    INSERT INTO login_attempts (key) VALUES ('ip:203.0.113.9');
    UPDATE settings SET value = 'Academia Prado' WHERE key = 'academy_name';`);
  return db;
};

// regra fechada
ok(Object.keys(RULES).length >= 17, 'há regra para todas as tabelas do schema atual');
{ const db = fresh(); const cols = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
    .flatMap(t => db.prepare(`PRAGMA table_info("${t}")`).all().map(c => `${t}.${c.name}`));
  ok(cols.every(tc => { const [t, c] = tc.split('.'); return RULES[t] && (RULES[t].drop || c in RULES[t].columns); }), `toda coluna do schema atual (${cols.length}) tem regra explícita`); db.close(); }
{ const db = seed(fresh()); db.exec('ALTER TABLE students ADD COLUMN cpf TEXT'); assert.throws(() => anonymize(db), e => e instanceof AnonymizationError && /students\.cpf/.test(e.message)); ok(true, 'coluna nova sem regra (students.cpf): recusada'); }
{ const db = seed(fresh()); db.exec('CREATE TABLE responsaveis (id TEXT, nome TEXT)'); assert.throws(() => anonymize(db), /tabela sem regra de anonimização: responsaveis/); ok(true, 'tabela nova sem regra: recusada'); }
{ const db = seed(fresh()); db.exec("INSERT INTO settings (key, value) VALUES ('whatsapp_dono', '11999990000')"); assert.throws(() => anonymize(db), /chave\(s\) de settings sem regra/); ok(true, 'chave nova em settings sem regra: recusada'); }
{ const db = seed(fresh()); db.exec('BEGIN'); let threw = false; try { db.exec('ALTER TABLE staff ADD COLUMN cpf TEXT'); anonymize(db); } catch { threw = true; } db.exec('ROLLBACK'); ok(threw && db.prepare("SELECT name FROM students WHERE id = 'a1'").get().name === 'Ana Lu', 'quando recusa, não altera nada'); }

// caso feliz: tudo tratado e varredura limpa
{ const db = seed(fresh()); const { sensitive } = anonymize(db); const rep = leakReport(db, sensitive);
  ok(rep.count === 0, 'dados semeados com nomes curtos, apelido de 2 letras, telefone, e-mail e observações: varredura limpa após anonimizar');
  const a1 = db.prepare("SELECT * FROM students WHERE id = 'a1'").get();
  ok(/^Aluno \d+$/.test(a1.name) && a1.nickname === null && a1.phone === null && a1.email === null && a1.sex === null && a1.weight_kg === null && a1.goals === null && a1.notes === '[anonimizado]', 'aluno: nome substituído; apelido, telefone, e-mail, sexo, peso e objetivos removidos; observação redigida');
  ok(a1.birth_date === '2012-07-01' && db.prepare("SELECT birth_date FROM students WHERE id = 'a2'").get().birth_date === null, 'nascimento generalizado para 1º de julho; sem data continua sem data');
  ok(a1.created_at === '2025-01-10T00:00:00.000Z' && a1.updated_at === '2025-02-01T00:00:00.000Z' && db.prepare('SELECT created_at FROM staff').get().created_at === '2025-03-04T00:00:00.000Z', 'created_at/updated_at de alunos e equipe só com a data');
  ok(db.prepare('SELECT created_at FROM lessons').get().created_at === '2025-06-02T20:10:00.000Z' && db.prepare('SELECT created_at FROM promotions').get().created_at === '2025-06-01T12:00:00.000Z', 'created_at de aulas e graduações mantido (janela de edição do professor)');
  ok(db.prepare('SELECT title, notes FROM lessons').get().title === 'Aula' && db.prepare('SELECT notes FROM promotions').get().notes === '[anonimizado]', 'título e observação de aula e observação de graduação redigidos');
  ok(db.prepare('SELECT count(*) n FROM auth_sessions').get().n === 0 && db.prepare('SELECT count(*) n FROM login_attempts').get().n === 0 && db.prepare("SELECT pass_hash FROM staff").get().pass_hash === 'anonimizado', 'sessões e IPs removidos; hash de senha substituído');
  ok(db.prepare("SELECT value FROM settings WHERE key = 'academy_name'").get().value === 'Academia de Teste (anonimizada)', 'nome da academia substituído');
  ok(db.prepare('SELECT count(*) n FROM attendance').get().n === 1 && db.prepare("SELECT student_id FROM promotions").get().student_id === 'a1', 'IDs, relações e quantidades preservados'); }

// varredura de resíduos em campos livres mantidos (classes.name, classes.level, techniques.name/description)
const leakIn = sql => { const db = seed(fresh()); db.exec(sql); const { sensitive } = anonymize(db); return leakReport(db, sensitive); };
let r = leakIn("UPDATE classes SET name = 'Turma da Ana'");
ok(r.count === 1 && r.where[0].startsWith('classes.name (nome/apelido curto original)'), 'nome curto (3 letras) em campo livre mantido: detectado e localizado, sem expor o valor');
r = leakIn("UPDATE techniques SET description = 'como o Zé ensinou' WHERE id = 1");
ok(r.count === 1 && /techniques\.description/.test(r.where[0]), 'apelido de 2 letras em descrição de técnica: detectado');
r = leakIn("UPDATE classes SET name = 'Americana e banana'");
ok(r.count === 0, 'nome curto não casa dentro de outra palavra ("Ana" em "Americana"/"banana")');
r = leakIn("UPDATE classes SET name = 'avisos: ana@familia.test'");
ok(r.count >= 1 && r.where.some(w => /classes\.name/.test(w)), 'e-mail original em campo livre: detectado');
r = leakIn("UPDATE techniques SET description = 'contato prof@outro.test' WHERE id = 1");
ok(r.where.some(w => /e-mail em campo livre/.test(w)), 'qualquer e-mail em campo livre (mesmo não cadastrado): detectado');
r = leakIn("UPDATE techniques SET description = 'ligar 11 98888-7777' WHERE id = 2");
ok(r.where.some(w => /telefone em campo livre/.test(w)), 'telefone em campo livre: detectado');
r = leakIn("UPDATE techniques SET name = 'Kimura do Bruno' WHERE id = 3");
ok(r.count === 1 && /techniques\.name \(valor pessoal original\)/.test(r.where[0]), 'parte longa de nome (sobrenome/nome) em campo livre: detectado');
r = leakIn("UPDATE classes SET name = 'Turma do Léo'");
ok(r.count === 1, 'acentuação não esconde o nome ("Léo" × "leo")');
r = leakIn("UPDATE staff SET name = 'Admin'; UPDATE students SET name = 'Inativo' WHERE id = 'a2'");
ok(r.count === 0, 'nomes iguais a valores de domínio fechado ("Admin" × papel admin, "Inativo" × status) não geram falso positivo');
ok(!JSON.stringify(leakIn("UPDATE classes SET name = 'Turma da Ana'")).includes('Ana'), 'o relatório nunca contém o valor encontrado');
console.log('\nANONIMIZAÇÃO OK');
