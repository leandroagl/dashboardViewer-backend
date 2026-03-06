// ─── Seed de datos iniciales ─────────────────────────────────────────────────
// Crea el primer usuario admin_ondra (superadmin) si no existe.
// Ejecutar con: npm run db:seed

import bcrypt from 'bcrypt';
import { pool } from './pool';
import { logger } from '../../utils/logger';
import { generateRandomPassword } from '../../utils/password';

const SEED_EMAIL  = 'st@ondra.com.ar';
const SEED_NOMBRE = 'Admin ONDRA';

async function seed() {
  const client = await pool.connect();

  try {
    // Verificar si el usuario superadmin ya existe (idempotente por email)
    const existing = await client.query(
      `SELECT id FROM usuarios WHERE email = $1 LIMIT 1`,
      [SEED_EMAIL]
    );

    if (existing.rowCount && existing.rowCount > 0) {
      logger.info('El usuario superadmin ya existe. Seed omitido.');
      return;
    }

    // 1. Crear (o recuperar) el cliente ONDRA
    const clienteResult = await client.query(`
      INSERT INTO clientes (nombre, slug, prtg_group)
      VALUES ('ONDRA', 'ondra', 'ONDRA')
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id
    `);
    const ondraClienteId: string = clienteResult.rows[0].id;

    // 2. Crear usuario superadmin con contraseña generada
    const plainPassword = generateRandomPassword();
    const passwordHash  = await bcrypt.hash(plainPassword, 12);

    await client.query(
      `INSERT INTO usuarios
         (email, nombre, password_hash, rol, cliente_id, debe_cambiar_password, es_superadmin)
       VALUES ($1, $2, $3, 'admin_ondra', $4, TRUE, TRUE)`,
      [SEED_EMAIL, SEED_NOMBRE, passwordHash, ondraClienteId]
    );

    // Mostrar contraseña UNA SOLA VEZ (nunca se vuelve a recuperar)
    logger.info('─────────────────────────────────────────────');
    logger.info('Usuario superadmin creado:');
    logger.info(`  Nombre:     ${SEED_NOMBRE}`);
    logger.info(`  Email:      ${SEED_EMAIL}`);
    logger.info(`  Contraseña: ${plainPassword}`);
    logger.info('  ⚠ Guardá esta contraseña — no se volverá a mostrar.');
    logger.info('─────────────────────────────────────────────');

  } finally {
    client.release();
    await pool.end();
  }
}

seed();
