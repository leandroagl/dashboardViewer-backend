// ─── Servicio de auditoría ───────────────────────────────────────────────────
// Registra eventos de seguridad y acceso en la tabla audit_logs.
// Se usa como función, no como middleware de Express, para poder llamarlo
// con contexto específico desde cualquier módulo.

import { pool } from '../config/database/pool';
import { AuditAction, AuditResult } from '../types';
import { logger } from '../utils/logger';

interface AuditEntry {
  usuario_id?: string;
  email?:      string;
  cliente_id?: string;
  accion:      AuditAction;
  dashboard?:  string;
  ip_origen:   string;
  resultado:   AuditResult;
}

/**
 * Registra un evento de auditoría de forma asíncrona (no bloquea la respuesta).
 * Los errores de logging no deben interrumpir el flujo principal.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs
        (usuario_id, email, cliente_id, accion, dashboard, ip_origen, resultado)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.usuario_id ?? null,
        entry.email      ?? null,
        entry.cliente_id ?? null,
        entry.accion,
        entry.dashboard  ?? null,
        entry.ip_origen,
        entry.resultado,
      ]
    );
  } catch (err) {
    // Loguear el error pero no propagarlo — el logging no debe romper la operación principal
    logger.error('Error al registrar auditoría', { error: err, entry });
  }
}

/**
 * Extrae la IP real del request, considerando proxies reversos.
 */
export function getClientIp(req: import('express').Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}
