// ─── Servicio de Logs de Auditoría ────────────────────────────────────────────

import { pool } from '../../config/database/pool';
import { AuditLog } from '../../types';

export interface LogFilters {
  clienteId?: string;
  usuarioId?: string;
  accion?:    string;
  resultado?: string;
  desde?:     string;
  hasta?:     string;
  page:       number;
  limit:      number;
}

export interface LogsResult {
  logs:  AuditLog[];
  total: number;
  resumen: {
    total_eventos:        number;
    logins_exitosos:      number;
    logins_fallidos:      number;
    usuarios_activos:     number;
  };
}

export async function getLogs(filters: LogFilters): Promise<LogsResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.clienteId) {
    params.push(filters.clienteId);
    conditions.push(`cliente_id = $${params.length}`);
  }
  if (filters.usuarioId) {
    params.push(filters.usuarioId);
    conditions.push(`usuario_id = $${params.length}`);
  }
  if (filters.accion) {
    params.push(filters.accion);
    conditions.push(`accion = $${params.length}`);
  }
  if (filters.resultado) {
    params.push(filters.resultado);
    conditions.push(`resultado = $${params.length}`);
  }
  if (filters.desde) {
    params.push(filters.desde);
    conditions.push(`timestamp >= $${params.length}`);
  }
  if (filters.hasta) {
    params.push(filters.hasta);
    conditions.push(`timestamp <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Total de registros para paginación
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM audit_logs ${where}`,
    params
  );
  const total = countResult.rows[0].total;

  // Paginación
  const offset = (filters.page - 1) * filters.limit;
  params.push(filters.limit, offset);

  const logsResult = await pool.query(
    `SELECT al.*, u.nombre AS usuario_nombre, c.nombre AS cliente_nombre
     FROM audit_logs al
     LEFT JOIN usuarios u ON al.usuario_id = u.id
     LEFT JOIN clientes c ON al.cliente_id = c.id
     ${where}
     ORDER BY al.timestamp DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Resumen del período filtrado
  const resumenResult = await pool.query(
    `SELECT
       COUNT(*)::int                                                  AS total_eventos,
       COUNT(*) FILTER (WHERE accion = 'login' AND resultado = 'ok')::int AS logins_exitosos,
       COUNT(*) FILTER (WHERE accion = 'login_fallido')::int          AS logins_fallidos,
       COUNT(DISTINCT usuario_id) FILTER (WHERE usuario_id IS NOT NULL)::int AS usuarios_activos
     FROM audit_logs ${where}`,
    params.slice(0, params.length - 2) // Sin LIMIT/OFFSET
  );

  return {
    logs:    logsResult.rows,
    total,
    resumen: resumenResult.rows[0],
  };
}

/**
 * Detecta IPs sospechosas: 3+ logins fallidos desde la misma IP en los últimos 10 minutos.
 * Se usa para destacar visualmente en el panel de administración.
 */
export async function getSuspiciousIps(): Promise<{ ip_origen: string; intentos: number; ultimo: Date }[]> {
  const result = await pool.query(
    `SELECT
       ip_origen,
       COUNT(*)::int  AS intentos,
       MAX(timestamp) AS ultimo
     FROM audit_logs
     WHERE accion     = 'login_fallido'
       AND timestamp  >= NOW() - INTERVAL '10 minutes'
     GROUP BY ip_origen
     HAVING COUNT(*) >= 3
     ORDER BY intentos DESC`
  );
  return result.rows;
}

/** Exporta logs a formato CSV (sin paginación, limitado a 10k registros) */
export async function exportLogsCsv(filters: Omit<LogFilters, 'page' | 'limit'>): Promise<string> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.clienteId) { params.push(filters.clienteId); conditions.push(`al.cliente_id = $${params.length}`); }
  if (filters.usuarioId) { params.push(filters.usuarioId); conditions.push(`al.usuario_id = $${params.length}`); }
  if (filters.accion)    { params.push(filters.accion);    conditions.push(`al.accion = $${params.length}`); }
  if (filters.resultado) { params.push(filters.resultado); conditions.push(`al.resultado = $${params.length}`); }
  if (filters.desde)     { params.push(filters.desde);     conditions.push(`al.timestamp >= $${params.length}`); }
  if (filters.hasta)     { params.push(filters.hasta);     conditions.push(`al.timestamp <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT
       al.timestamp, al.accion, al.resultado,
       al.email, u.nombre AS usuario_nombre,
       c.nombre AS cliente_nombre,
       al.dashboard, al.ip_origen
     FROM audit_logs al
     LEFT JOIN usuarios u ON al.usuario_id = u.id
     LEFT JOIN clientes c ON al.cliente_id = c.id
     ${where}
     ORDER BY al.timestamp DESC
     LIMIT 10000`,
    params
  );

  // Construir CSV manualmente
  const header = 'timestamp,accion,resultado,email,usuario,cliente,dashboard,ip_origen';
  const rows = result.rows.map(r =>
    [r.timestamp, r.accion, r.resultado, r.email ?? '', r.usuario_nombre ?? '',
     r.cliente_nombre ?? '', r.dashboard ?? '', r.ip_origen]
    .map(v => `"${String(v).replace(/"/g, '""')}"`)
    .join(',')
  );

  return [header, ...rows].join('\n');
}

/** Elimina todos los registros de audit_logs (o por filtro de fecha) */
export async function purgeLogs(antes_de?: string): Promise<number> {
  let result;
  if (antes_de) {
    result = await pool.query(
      `DELETE FROM audit_logs WHERE timestamp < $1`,
      [antes_de]
    );
  } else {
    result = await pool.query(`DELETE FROM audit_logs`);
  }
  return result.rowCount ?? 0;
}
