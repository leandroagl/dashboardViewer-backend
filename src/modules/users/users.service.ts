// ─── Servicio de Usuarios ─────────────────────────────────────────────────────

import bcrypt from 'bcrypt';
import { pool } from '../../config/database/pool';
import { User, UserRole } from '../../types';
import { generateRandomPassword } from '../../utils/password';

// ─── Consultas ────────────────────────────────────────────────────────────────

/** Lista todos los usuarios con nombre del cliente */
export async function getAllUsers(filters: {
  clienteId?: string;
  rol?:       string;
  activo?:    boolean;
}): Promise<Omit<User, 'password_hash'>[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.clienteId) {
    params.push(filters.clienteId);
    conditions.push(`u.cliente_id = $${params.length}`);
  }
  if (filters.rol) {
    params.push(filters.rol);
    conditions.push(`u.rol = $${params.length}`);
  }
  if (filters.activo !== undefined) {
    params.push(filters.activo);
    conditions.push(`u.activo = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT
       u.id, u.email, u.nombre, u.rol, u.cliente_id,
       u.activo, u.debe_cambiar_password, u.es_kiosk,
       u.ultimo_acceso, u.creado_por, u.creado_en,
       c.nombre AS cliente_nombre
     FROM usuarios u
     LEFT JOIN clientes c ON u.cliente_id = c.id
     ${where}
     ORDER BY u.creado_en DESC`,
    params
  );
  return result.rows;
}

export async function getUserById(id: string): Promise<Omit<User, 'password_hash'> | null> {
  const result = await pool.query(
    `SELECT u.id, u.email, u.nombre, u.rol, u.cliente_id,
            u.activo, u.debe_cambiar_password, u.es_kiosk,
            u.ultimo_acceso, u.creado_por, u.creado_en
     FROM usuarios u WHERE u.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

// ─── Mutaciones ───────────────────────────────────────────────────────────────

export interface CreateUserInput {
  email:      string;
  nombre:     string;
  rol:        UserRole;
  cliente_id?: string;
  es_kiosk?:  boolean;
}

export interface CreateUserResult {
  user:             Omit<User, 'password_hash'>;
  plainPassword:    string; // Mostrar UNA SOLA VEZ al admin
}

/** Crea un usuario con contraseña generada automáticamente */
export async function createUser(input: CreateUserInput, creadoPor: string): Promise<CreateUserResult> {
  const plainPassword = generateRandomPassword();
  const passwordHash  = await bcrypt.hash(plainPassword, 12);
  const esKiosk       = input.es_kiosk ?? false;

  // viewer_kiosk siempre tiene es_kiosk = true
  const rolFinal = esKiosk ? UserRole.VIEWER_KIOSK : input.rol;

  const result = await pool.query(
    `INSERT INTO usuarios
       (email, nombre, password_hash, rol, cliente_id, es_kiosk, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, email, nombre, rol, cliente_id, activo,
               debe_cambiar_password, es_kiosk, creado_en`,
    [
      input.email.toLowerCase().trim(),
      input.nombre,
      passwordHash,
      rolFinal,
      input.cliente_id ?? null,
      esKiosk,
      creadoPor,
    ]
  );

  return { user: result.rows[0], plainPassword };
}

export interface UpdateUserInput {
  nombre?:     string;
  cliente_id?: string | null; // null = desasignar cliente explícitamente
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<Omit<User, 'password_hash'> | null> {
  const sets: string[]   = [];
  const params: unknown[] = [];

  if (input.nombre !== undefined) {
    params.push(input.nombre);
    sets.push(`nombre = $${params.length}`);
  }
  // Usar 'in' para distinguir "campo omitido" de "campo seteado a null"
  if ('cliente_id' in input) {
    params.push(input.cliente_id ?? null);
    sets.push(`cliente_id = $${params.length}`);
  }

  if (sets.length === 0) return getUserById(id);

  params.push(id);
  const result = await pool.query(
    `UPDATE usuarios
     SET ${sets.join(', ')}
     WHERE id = $${params.length}
     RETURNING id, email, nombre, rol, cliente_id, activo,
               debe_cambiar_password, es_kiosk, creado_en`,
    params
  );
  return result.rows[0] ?? null;
}

export async function setUserActive(id: string, activo: boolean): Promise<boolean> {
  const result = await pool.query(
    `UPDATE usuarios SET activo = $1 WHERE id = $2`,
    [activo, id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Resetea la contraseña del usuario y activa el flag de cambio obligatorio.
 *  Usa una transacción para garantizar que la actualización de contraseña
 *  y la revocación de tokens sean atómicas. */
export async function resetPassword(id: string): Promise<string | null> {
  const user = await getUserById(id);
  if (!user) return null;

  const plainPassword = generateRandomPassword();
  const passwordHash  = await bcrypt.hash(plainPassword, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE usuarios
       SET password_hash = $1, debe_cambiar_password = TRUE
       WHERE id = $2`,
      [passwordHash, id]
    );

    await client.query(
      `UPDATE refresh_tokens SET revocado = TRUE WHERE usuario_id = $1`,
      [id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return plainPassword;
}
