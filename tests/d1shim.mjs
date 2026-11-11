// Emula a API do Cloudflare D1 (prepare/bind/all/first/run/batch) sobre node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
export function makeD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  const norm = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...p) { return new Stmt(this.sql, p.map(norm)); }
    _exec() { const s = db.prepare(this.sql); return s; }
    async all() { const rows = this._exec().all(...this.params).map(r => ({ ...r })); return { results: rows, success: true, meta: {} }; }
    async first(col) { const r = this._exec().get(...this.params); if (!r) return null; return col ? r[col] : { ...r }; }
    async run() { const r = this._exec().run(...this.params); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; }
    _runSync() { const s = this._exec(); return /^\s*(select|with)/i.test(this.sql) ? { results: s.all(...this.params) } : s.run(...this.params); }
  }
  return {
    raw: db,
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._runSync()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    load(path) { db.exec(fs.readFileSync(path, 'utf8')); }
  };
}
