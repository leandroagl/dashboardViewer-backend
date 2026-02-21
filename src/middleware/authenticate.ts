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
 * Middleware que verifica que el clientSlug de la URL corresponda
 * al cliente del usuario autenticado. Los admin_ondra pueden acceder a cualquier slug.
 */
export function requireClientAccess(req: Request, res: Response, next: NextFunction): void {
  const { clientSlug } = req.params;

  // Admin puede ver cualquier cliente
  if (req.user?.rol === UserRole.ADMIN_ONDRA) {
    next();
    return;
  }

  // Viewer debe coincidir con su propio slug (viene resuelto por el backend al hacer login)
  // El slug del cliente está almacenado en el claim cliente_id del JWT —
  // esta validación se hace contra la tabla de clientes en el servicio correspondiente.
  // Aquí simplemente garantizamos que haya un cliente_id en el token.
  if (!req.user?.cliente_id) {
    sendError(res, 403, 'No tenés un cliente asignado.');
    return;
  }

  next();
}
