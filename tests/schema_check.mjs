// Verificação de schema e linha de base, com bancos SQLite reais (fixtures em arquivo temporário).
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, diffSchemas, expectedAfter, schemaRows, migrationFiles, MIGRATIONS_DIR, MIGRATIONS_TABLE } from '../tools/db/schema.mjs';
import { main } from '../tools/db/ops.mjs';
import { reportFromFiles } from '../tools/db-baseline.mjs';

const ok = (c, m) => { assert.ok(c, m); console.log('ok ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'tatame-schema-'));
const sqlOf = n => readFileSync(MIGRATIONS_DIR + n, 'utf8');
const make = (name, ...sqls) => { const f = join(tmp, name + '.db'); const db = new DatabaseSync(f); for (const s of sqls) db.exec(s); db.close(); return f; };
const fpOf = f => { const db = new DatabaseSync(f); try { return fingerprint(schemaRows(db)); } finally { db.close(); } };
const kinds = (exp, f) => diffSchemas(exp, fpOf(f)).map(d => d.kind);
const BASE = expectedAfter(['000_base.sql']);
const FINAL = expectedAfter(migrationFiles());

try {
  ok(migrationFiles().join() === '000_base.sql,001_recuperacao_senha.sql,002_marcador_de_chamada.sql', 'migrações encontradas em ordem: 000, 001, 002');
  ok(diffSchemas(FINAL, fpOf(make('schemasql', readFileSync(MIGRATIONS_DIR + '../schema.sql', 'utf8')))).length === 0, 'schema.sql e cadeia 000+001+002 sem diferenças');
  const base = sqlOf('000_base.sql');
  ok(kinds(BASE, make('igual', base)).length === 0, 'banco igual a 17f1fbd: nenhuma diferença');

  // cada tipo de divergência
  const k1 = kinds(BASE, make('semcoluna', base.replace(/\n\s*nickname TEXT,/, '\n')));
  ok(k1.includes('coluna_ausente'), 'detecta coluna ausente (students.nickname)');
  ok(kinds(BASE, make('colextra', base, 'ALTER TABLE students ADD COLUMN apelido2 TEXT')).includes('coluna_adicional'), 'detecta coluna adicional');
  ok(kinds(BASE, make('semtabela', base, 'DROP TABLE skill_history')).includes('tabela_ausente'), 'detecta tabela ausente');
  ok(kinds(BASE, make('tabextra', base, 'CREATE TABLE intrusa (x)')).includes('tabela_inesperada'), 'detecta tabela inesperada');
  ok(kinds(BASE, make('semindice', base, 'DROP INDEX lessons_date')).includes('indice_ausente'), 'detecta índice ausente');
  ok(kinds(BASE, make('indicediv', base, 'DROP INDEX lessons_date', 'CREATE INDEX lessons_date ON lessons (date ASC)')).includes('indice_divergente'), 'detecta índice divergente (mesmo nome, outra definição)');
  ok(kinds(BASE, make('indiceextra', base, 'CREATE INDEX extra_i ON students (name)')).includes('indice_adicional'), 'detecta índice adicional');
  const chk = base.replace("CHECK (modality IN ('gi', 'nogi', 'livre'))", "CHECK (modality IN ('gi', 'nogi'))");
  assert.notStrictEqual(chk, base);
  ok(kinds(BASE, make('checkdiv', chk)).includes('check_diferente'), 'detecta CHECK divergente');
  const nn = base.replace('  date TEXT NOT NULL,\n  start_time TEXT NOT NULL,', '  date TEXT,\n  start_time TEXT NOT NULL,').replace('  date TEXT NOT NULL,\r\n  start_time TEXT NOT NULL,', '  date TEXT,\r\n  start_time TEXT NOT NULL,');
  assert.notStrictEqual(nn, base);
  ok(kinds(BASE, make('notnull', nn)).includes('coluna_notnull_diferente'), 'detecta NOT NULL diferente');
  const dflt = base.replace("modality TEXT NOT NULL DEFAULT 'gi'", "modality TEXT NOT NULL DEFAULT 'nogi'");
  ok(dflt !== base && kinds(BASE, make('default', dflt)).includes('coluna_default_diferente'), 'detecta default diferente');
  const fk = base.replace('lesson_id TEXT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE', 'lesson_id TEXT NOT NULL REFERENCES lessons (id)');
  ok(fk !== base && kinds(BASE, make('fk', fk)).includes('chave_estrangeira_diferente'), 'detecta chave estrangeira diferente (sem ON DELETE CASCADE)');
  ok(kinds(BASE, make('internos', base, `CREATE TABLE ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY, name TEXT)`, 'CREATE TABLE _cf_KV (k, v)')).length === 0, 'ignora só objetos internos (d1_migrations, _cf_*)');

  // linha de base via wrapper, com --env local
  const deps = () => { const out = [], err = []; return { out, err, d: { environments: () => ({ local: { kind: 'local' } }), wranglerVersion: () => 'x', exec: () => { throw new Error('não deveria chamar o wrangler'); }, isTTY: () => false, ask: async () => '', out: m => out.push(m), err: m => err.push(m) } }; };
  const run = async (...argv) => { const h = deps(); h.code = await main(argv, h.d); return h; };
  const prodLike = make('prod', base);
  const filled = new DatabaseSync(prodLike); filled.exec("INSERT INTO students (id, name, start_date, belt_since, degree_since) VALUES ('s1','Aluno','2026-01-01','2026-01-01','2026-01-01')"); filled.close();
  let h = await run('baseline', '--env', 'local', '--sqlite', prodLike);
  ok(h.code === 0 && /veredito: identica/.test(h.out.join('\n')), 'baseline: banco no formato de 17f1fbd é "identica" e não registra nada');
  ok(!fpOf(prodLike).tables[MIGRATIONS_TABLE] && new DatabaseSync(prodLike).prepare("SELECT count(*) n FROM sqlite_schema WHERE name = 'd1_migrations'").get().n === 0, 'baseline não cria a tabela de migrações');
  h = await run('baseline-register', '--env', 'local', '--sqlite', prodLike);
  ok(h.code === 3 && /confirm-baseline/.test(h.err.join('\n')), 'baseline-register sem --confirm-baseline é recusado');
  h = await run('baseline-register', '--env', 'local', '--sqlite', prodLike, '--confirm-baseline=001_recuperacao_senha.sql');
  ok(h.code === 3, 'baseline-register com confirmação de outro arquivo é recusado');
  const div = make('div', base, 'ALTER TABLE students ADD COLUMN apelido2 TEXT');
  h = await run('baseline-register', '--env', 'local', '--sqlite', div, '--confirm-baseline=000_base.sql');
  ok(h.code === 3 && /NÃO registrada/.test(h.err.join('\n')) && /coluna adicional: students.apelido2/.test(h.out.join('\n')), 'banco divergente: lista as diferenças e recusa o registro');
  const manual = make('manual', base, sqlOf('001_recuperacao_senha.sql'));
  h = await run('baseline', '--env', 'local', '--sqlite', manual);
  ok(h.code === 4 && /contem_alteracoes_posteriores/.test(h.out.join('\n')), 'banco com a 001 aplicada à mão sem registro: veredito específico, não registra');
  h = await run('baseline-register', '--env', 'local', '--sqlite', prodLike, '--confirm-baseline=000_base.sql');
  const reg = new DatabaseSync(prodLike); const names = reg.prepare('SELECT name FROM d1_migrations').all().map(r => r.name); const n = reg.prepare('SELECT count(*) n FROM students').get().n; reg.close();
  ok(h.code === 0 && names.join() === '000_base.sql' && n === 1, 'banco idêntico + confirmação: registra só 000_base.sql, sem executar nem tocar em dados');
  h = await run('baseline-register', '--env', 'local', '--sqlite', prodLike, '--confirm-baseline=000_base.sql');
  ok(h.code === 3 && /ja_registrada/.test(h.out.join('\n')), 'segunda tentativa de registrar a linha de base é recusada');

  // check
  h = await run('check', '--env', 'local', '--sqlite', prodLike);
  ok(h.code === 0 && /pendentes: 001_recuperacao_senha.sql, 002_marcador_de_chamada.sql/.test(h.out.join('\n')), 'check: base registrada confere e lista 001 e 002 como pendentes');
  const broken = make('broken', base, 'PRAGMA foreign_keys = OFF', "INSERT INTO attendance (lesson_id, student_id) VALUES ('nao-existe', 'nem-este')", sqlOf('../migrations/000_base.sql').slice(0, 0));
  { const db = new DatabaseSync(broken); db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name) VALUES ('000_base.sql')`); db.close(); }
  h = await run('check', '--env', 'local', '--sqlite', broken);
  ok(h.code === 4 && /violação\(ões\) de chave estrangeira em attendance/.test(h.out.join('\n')), 'check detecta violação de integridade referencial (sem mostrar dados)');
  ok(!h.out.join('\n').includes('nao-existe'), 'check não imprime valores das linhas');
  h = await run('check', '--env', 'local', '--sqlite', div);
  ok(h.code === 4 && /sem registro de migrações/.test(h.out.join('\n')), 'check acusa banco sem linha de base registrada');

  // relatório offline a partir do JSON que o operador salvar
  const rowsJson = JSON.stringify([{ results: (() => { const db = new DatabaseSync(make('json', base)); try { return schemaRows(db); } finally { db.close(); } })(), success: true, meta: {} }]);
  writeFileSync(join(tmp, 'schema.json'), rowsJson);
  ok(reportFromFiles(rowsJson, null).verdict === 'identica', 'db-baseline.mjs lê a saída JSON do wrangler e dá o mesmo veredito');
  const withMig = JSON.stringify([{ results: JSON.parse(rowsJson)[0].results.concat([{ type: 'table', name: 'd1_migrations', tbl_name: 'd1_migrations', sql: 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)' }]), success: true }]);
  assert.throws(() => reportFromFiles(withMig, null), /informe também --migrations/);
  ok(reportFromFiles(withMig, JSON.stringify([{ results: [{ name: '000_base.sql' }], success: true }])).verdict === 'ja_registrada', 'db-baseline.mjs exige e usa o conteúdo de d1_migrations quando a tabela existe');
  console.log('\nVERIFICAÇÃO DE SCHEMA OK');
} finally { rmSync(tmp, { recursive: true, force: true }); }
