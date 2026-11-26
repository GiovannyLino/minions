import m001 from './001_init';
import m002 from './002_answer_memory';
import m003 from './003_serverless';

/** Migrações em ordem. O nome é gravado em schema_migrations — nunca renomeie uma já aplicada. */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  { name: '001_init.sql', sql: m001 },
  { name: '002_answer_memory.sql', sql: m002 },
  { name: '003_serverless.sql', sql: m003 },
];
