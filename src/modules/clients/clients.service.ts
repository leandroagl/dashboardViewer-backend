// ─── Servicio de Clientes ─────────────────────────────────────────────────────
// CRUD de clientes (solo accesible para admin_ondra).

import { pool } from '../../config/database/pool';
import { Client } from '../../types';

// ─── Consultas ────────────────────────────────────────────────────────────────

/** Obtiene todos los clientes con estadísticas básicas */
export async function getAllClients(): Promise<(Client & { total_usuarios: number; ultimo_acceso_usuario: Date | null })[]> {
  const result = await pool.query(
    `SELECT
       c.*,
       COUNT(u.id)::int          AS total_usuarios,
       MAX(u.ultimo_acceso)      AS ultimo_acceso_usuario
     FROM clientes c
     LEFT JOIN usuarios u ON u.cliente_id = c.id AND u.activo = TRUE
     GROUP BY c.id
     ORDER BY c.nombre`
  );
  return result.rows;
}

/** Obtiene un cliente por su ID */
export async function getClientById(id: string): Promise<Client | null> {
  const result = await pool.query(
    `SELECT * FROM clientes WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** Obtiene un cliente por su slug (para operaciones de dashboard) */
export async function getClientBySlug(slug: string): Promise<Client | null> {
  const result = await pool.query(
    `SELECT * FROM clientes WHERE slug = $1`,
    [slug]
  );
  return result.rows[0] ?? null;
}

// ─── Mutaciones ───────────────────────────────────────────────────────────────

export interface CreateClientInput {
  nombre:      string;
  slug:        string;
  prtg_group:  string;
  logo_url?:   string;
  color_marca?: string;
}

/** Crea un nuevo cliente */
export async function createClient(input: CreateClientInput): Promise<Client> {
  const result = await pool.query(
    `INSERT INTO clientes (nombre, slug, prtg_group, logo_url, color_marca)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.nombre, input.slug.toLowerCase(), input.prtg_group, input.logo_url ?? null, input.color_marca ?? null]
  );
  return result.rows[0];
}

export interface UpdateClientInput {
  nombre?:      string;
  prtg_group?:  string;
  logo_url?:    string;
  color_marca?: string;
}

/** Actualiza los campos editables de un cliente. El slug es inmutable. */
export async function updateClient(id: string, input: UpdateClientInput): Promise<Client | null> {
  const result = await pool.query(
    `UPDATE clientes
     SET
       nombre      = COALESCE($1, nombre),
       prtg_group  = COALESCE($2, prtg_group),
       logo_url    = COALESCE($3, logo_url),
       color_marca = COALESCE($4, color_marca)
     WHERE id = $5
     RETURNING *`,
    [input.nombre, input.prtg_group, input.logo_url, input.color_marca, id]
  );
  return result.rows[0] ?? null;
}

/** Activa o desactiva un cliente (bloquea/desbloquea todos sus usuarios) */
export async function setClientActive(id: string, activo: boolean): Promise<Client | null> {
  const result = await pool.query(
    `UPDATE clientes SET activo = $1 WHERE id = $2 RETURNING *`,
    [activo, id]
  );
  return result.rows[0] ?? null;
}
