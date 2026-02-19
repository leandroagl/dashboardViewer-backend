// ─── Middleware global de manejo de errores ──────────────────────────────────
// Captura cualquier error no manejado que llegue con next(err).

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('Error no manejado', {
    message: err.message,
    stack:   err.stack,
    method:  req.method,
    url:     req.originalUrl,
  });

  res.status(500).json({
    ok:    false,
    error: 'Error interno del servidor.',
  });
}

/** Maneja rutas no encontradas (404) */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok:    false,
    error: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
}
