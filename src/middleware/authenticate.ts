// ─── Middleware de autenticación ─────────────────────────────────────────────
// Verifica el access token JWT del header Authorization.
// Si es válido, adjunta el payload decodificado a req.user.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload } from '../types';
import { sendError } from '../utils/response';
import { UserRole } from '../types';

/**
 * Protege rutas que requieren sesión activa.
 * El token debe enviarse en el header: Authorization: Bearer <token>
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 401, 'Token de acceso requerido.');
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] }) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    sendError(res, 401, 'Token inválido o expirado.');
  }
}

/**
 * Middleware que restringe el acceso a admin_ondra únicamente.
 * Debe usarse DESPUÉS de authenticate.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.rol !== UserRole.ADMIN_ONDRA) {
    sendError(res, 403, 'Acceso restringido a administradores.');
    return;
  }
  next();
}

/**
 * Middleware de pre-filtrado para rutas de dashboard.
 *
 * ⚠️  ALCANCE LIMITADO: Este middleware NO verifica que el :clientSlug de la URL
 * corresponda al cliente del usuario. Solo garantiza que:
 *   1. El usuario está autenticado (hecho antes por `authenticate`).
 *   2. Los viewers tienen un cliente_id asignado en su JWT.
 *
 * La validación completa slug → cliente → acceso del usuario se realiza en
 * resolveClientAccess() dentro de cada controller de dashboards.
 * Toda nueva ruta bajo /:clientSlug/dashboards DEBE llamar resolveClientAccess().
 */
export function requireClientAccess(req: Request, res: Response, next: NextFunction): void {
  // Admin puede acceder a cualquier cliente — la validación de slug no aplica.
  if (req.user?.rol === UserRole.ADMIN_ONDRA) {
    next();
    return;
  }

  // Viewers sin cliente asignado no pueden acceder a ningún dashboard.
  if (!req.user?.cliente_id) {
    sendError(res, 403, 'No tenés un cliente asignado.');
    return;
  }

  // La verificación de que este cliente_id corresponde al :clientSlug de la URL
  // se delega a resolveClientAccess() en el controller correspondiente.
  next();
}
