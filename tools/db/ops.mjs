// Junta o núcleo do wrapper e todas as operações registradas. É o que a linha de comando e os testes importam.
export * from './cli.mjs';
import './ops-schema.mjs';
import './ops-migrate.mjs';
import './backup.mjs';
