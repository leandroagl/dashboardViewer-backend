// ─── Pool de conexiones PostgreSQL ───────────────────────────────────────────
// Instancia única compartida por todos los módulos (singleton).

import { Pool } from 'pg';
import { env } from '../env';
import { logger } from '../../utils/logger';

export const pool = new Pool({
  host:     env.db.host,
  port:     env.db.port,
  database: env.db.name,
  user:     env.db.user,
  password: env.db.password,
  max:      10,              // Máximo de conexiones concurrentes
  idleTimeoutMillis:  30000,
  connectionTimeoutMillis: 5000,
});

// Log de errores inesperados en el pool (ej: caída de BD)
pool.on('error', (err) => {
  logger.error('Error inesperado en el pool de PostgreSQL', { error: err.message });
});

// Función de prueba de conexión al iniciar
export async function testDatabaseConnection(): Promise<void> {
  const client = await pool.connect();
  client.release();
  logger.info('Conexión a PostgreSQL establecida correctamente');
}
