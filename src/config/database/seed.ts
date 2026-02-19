// ─── Seed de datos iniciales ─────────────────────────────────────────────────
// Crea el primer usuario admin_ondra si no existe ninguno.
// Ejecutar con: npm run db:seed

import bcrypt from 'bcrypt';
import { pool } from './pool';
import { logger } from '../../utils/logger';
import { generateRandomPassword } from '../../utils/password';

async function seed() {
  const client = await pool.connect();

  try {
    // Verificar si ya existe algún admin_ondra
    const existing = await client.query(
      `SELECT id FROM usuarios WHERE rol = 'admin_ondra' LIMIT 1`
    );

    if (existing.rowCount && existing.rowCount > 0) {
      logger.info('Ya existe un admin_ondra. Seed omitido.');
      return;
    }

    // Generar contraseña inicial
    const plainPassword = generateRandomPassword();
    const passwordHash  = await bcrypt.hash(plainPassword, 12);

    await client.query(
      `INSERT INTO usuarios (email, nombre, password_hash, rol, debe_cambiar_password)
       VALUES ($1, $2, $3, 'admin_ondra', TRUE)`,
      ['admin@ondra.com.ar', 'Administrador ONDRA', passwordHash]
    );

    // Mostrar contraseña UNA SOLA VEZ (nunca se vuelve a recuperar)
    logger.info('─────────────────────────────────────────────');
    logger.info('Usuario admin creado:');
    logger.info(`  Email:      admin@ondra.com.ar`);
    logger.info(`  Contraseña: ${plainPassword}`);
    logger.info('  ⚠ Guardá esta contraseña — no se volverá a mostrar.');
    logger.info('─────────────────────────────────────────────');

  } finally {
    client.release();
    await pool.end();
  }
}

seed();
