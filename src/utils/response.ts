// ─── Helpers para respuestas HTTP consistentes ───────────────────────────────
// Todos los controllers usan estas funciones para mantener una estructura
// uniforme en las respuestas de la API.

import { Response } from 'express';

interface ApiResponse<T = unknown> {
  ok:      boolean;
  data?:   T;
  error?:  string;
  meta?:   Record<string, unknown>;
}

/** Respuesta exitosa */
export function sendOk<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): void {
  const body: ApiResponse<T> = { ok: true, data };
  if (meta) body.meta = meta;
  res.status(status).json(body);
}

/** Error del cliente (400, 401, 403, 404, etc.) */
export function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/** Error interno del servidor */
export function sendServerError(res: Response, message = 'Error interno del servidor'): void {
  res.status(500).json({ ok: false, error: message });
}
