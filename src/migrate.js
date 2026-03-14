/**
 * Standalone migration runner.
 * Usage: node src/migrate.js
 */

import { runMigrations, closePool } from './database.js';

try {
  await runMigrations();
  console.log('Migrations complete.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await closePool();
}
