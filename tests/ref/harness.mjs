// Harness da paridade: relógio fixo + Worker real sobre D1 emulado + leitura das tabelas cruas.
import { fileURLToPath } from 'node:url';
import { makeD1 } from '../d1shim.mjs';
import { generateCode, buildSetupSql } from '../../tools/setup-token.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RealDate = Date;

// Congela `new Date()` e `Date.now()` em 12:00 (horário de Brasília) do dia informado. Só o teste faz isso; o Worker não é alterado.
export function freezeClock(day) {
  const fixed = RealDate.parse(day + 'T15:00:00Z');
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
export const unfreezeClock = () => { globalThis.Date = RealDate; };

const TABLES = ['students', 'classes', 'lessons', 'attendance', 'lesson_techniques', 'techniques', 'skills', 'rules', 'promotions'];

// Cria um banco novo e entra como administrador (sessão estendida para não expirar contra o relógio congelado).
export async function openWorld(today) {
  unfreezeClock(); // o cadastro inicial usa o relógio real: a limpeza de sessões do Worker compara com o `now` do SQLite
  const DB = makeD1();
  DB.load(ROOT + 'db/schema.sql'); DB.load(ROOT + 'db/seed_tecnicas.sql');
  const W = (await import('../../web/_worker.js')).default;
  const env = { DB, ASSETS: { fetch: () => new Response('static') } };
  let cookie = '';
  const api = async (method, path, body) => {
    const r = await W.fetch(new Request('https://parity.test' + path, { method, headers: { 'content-type': 'application/json', 'x-tatame': '1', cookie }, body: body ? JSON.stringify(body) : undefined }), env);
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const setupCode = generateCode(); DB.raw.exec(buildSetupSql(setupCode));
  const setup = await api('POST', '/api/setup', { academy_name: 'Academia Paridade', name: 'Admin', email: 'admin@paridade.test', password: 'cordafina-71', setup_code: setupCode });
  if (setup.status !== 201) throw new Error('setup falhou: ' + JSON.stringify(setup.body));
  DB.raw.prepare("UPDATE auth_sessions SET expires_at = '2999-01-01T00:00:00.000Z', created_at = ?").run(today + 'T00:00:00.000Z');
  freezeClock(today);
  const dump = () => Object.fromEntries(TABLES.map(t => [t, DB.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(r => ({ ...r }))]));
  return { DB, api, today, dump, state: async () => (await api('GET', '/api/state')).body };
}
