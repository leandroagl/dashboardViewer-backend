// ─── Script de migración de base de datos ───────────────────────────────────
// Ejecutar con: npm run db:migrate
// Crea todas las tablas necesarias si no existen.

import { pool } from './pool';
import { logger } from '../../utils/logger';
import { migrations } from './migrations';

async function migrate() {
  logger.info('Iniciando migraciones...');
  const client = await pool.connect();
  try {
    await client.query(migrations);
    logger.info('Migraciones ejecutadas correctamente.');
  } catch (err) {
    logger.error('Error al ejecutar migraciones', { error: err });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
