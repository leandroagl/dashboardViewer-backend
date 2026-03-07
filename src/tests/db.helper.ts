// ─── Helper de base de datos para tests de integración ───────────────────────
// Crea la DB de test, ejecuta migraciones y expone funciones de limpieza.

import { Pool } from 'pg';
import { env } from '../config/env';

// Pool exclusivo para tests — conecta a ondra_monitor_test
export const testPool = new Pool({
  host:     env.db.host,
  port:     env.db.port,
  database: env.db.name,   // ondra_monitor_test (via .env.test)
  user:     env.db.user,
  password: env.db.password,
});

/** Crea la DB de test si no existe (requiere permisos de superusuario o CREATEDB). */
export async function createTestDatabase(): Promise<void> {
  // Conectar al DB por defecto para poder crear la de test
  const adminPool = new Pool({
    host:     env.db.host,
    port:     env.db.port,
    database: 'postgres',
    user:     env.db.user,
    password: env.db.password,
  });
  try {
    const exists = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [env.db.name],
    );
    if (!exists.rowCount) {
      await adminPool.query(`CREATE DATABASE "${env.db.name}"`);
    }
  } finally {
    await adminPool.end();
  }
}

/** Ejecuta las migraciones en la DB de test. */
export async function runMigrations(): Promise<void> {
  const fs   = await import('fs');
  const path = await import('path');
  const sql  = fs.readFileSync(
    path.resolve(__dirname, '../config/database/migrate.ts'),
    'utf8',
  );

  // Extraer solo el bloque SQL de la variable `migrations`
  const match = sql.match(/const migrations = `([\s\S]*?)`;/);
  if (!match) throw new Error('No se encontró el bloque SQL en migrate.ts');

  await testPool.query(match[1]);
}

/** Trunca todas las tablas de datos entre tests (preserva el schema). */
export async function cleanDatabase(): Promise<void> {
  await testPool.query(`
    TRUNCATE TABLE refresh_tokens, audit_logs, usuarios, clientes
    RESTART IDENTITY CASCADE
  `);
}

/** Cierra el pool al terminar todos los tests. */
export async function closeTestDatabase(): Promise<void> {
  await testPool.end();
}
