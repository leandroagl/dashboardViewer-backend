// ─── Controller de Usuarios ───────────────────────────────────────────────────

import { Request, Response } from 'express';
import { body, query } from 'express-validator';
import { audit, getClientIp } from '../../middleware/auditLogger';
import { AuditAction, AuditResult, UserRole } from '../../types';
import { sendOk, sendError, sendServerError } from '../../utils/response';
import { logger } from '../../utils/logger';
import * as UsersService from './users.service';
import { revokeKioskSession } from '../auth/auth.service';
import { pool } from '../../config/database/pool';

export const createUserValidators = [
  body('email').isEmail().withMessage('Email inválido.'),
  body('nombre').notEmpty().trim().withMessage('Nombre requerido.'),
  body('rol').isIn(Object.values(UserRole)).withMessage('Rol inválido.'),
  body('cliente_id').optional().isUUID().withMessage('ID de cliente inválido.'),
];

/** GET /admin/users */
export async function getAll(req: Request, res: Response): Promise<void> {
  try {
    const users = await UsersService.getAllUsers({
      clienteId: req.query.cliente_id as string | undefined,
      rol:       req.query.rol as string | undefined,
      activo:    req.query.activo !== undefined ? req.query.activo === 'true' : undefined,
    });
    sendOk(res, users);
  } catch (err) {
    logger.error('Error al obtener usuarios', { error: err });
    sendServerError(res);
  }
}

/** GET /admin/users/:id */
export async function getOne(req: Request, res: Response): Promise<void> {
  try {
    const user = await UsersService.getUserById(req.params.id);
    if (!user) { sendError(res, 404, 'Usuario no encontrado.'); return; }
    sendOk(res, user);
  } catch (err) {
    logger.error('Error al obtener usuario', { error: err });
    sendServerError(res);
  }
}

/** POST /admin/users */
export async function create(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const { user, plainPassword } = await UsersService.createUser(req.body, req.user!.sub);

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      cliente_id: user.cliente_id ?? undefined,
      accion:     AuditAction.USER_CREATED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    // Devolver la contraseña en texto plano UNA SOLA VEZ
    sendOk(res, { ...user, plainPassword }, undefined, 201);
  } catch (err: any) {
    if (err.code === '23505') {
      sendError(res, 409, 'Ya existe un usuario con ese email.');
      return;
    }
    logger.error('Error al crear usuario', { error: err });
    sendServerError(res);
  }
}

/** PATCH /admin/users/:id */
export async function update(req: Request, res: Response): Promise<void> {
  try {
    const user = await UsersService.updateUser(req.params.id, req.body);
    if (!user) { sendError(res, 404, 'Usuario no encontrado.'); return; }
    sendOk(res, user);
  } catch (err) {
    logger.error('Error al actualizar usuario', { error: err });
    sendServerError(res);
  }
}

/** PATCH /admin/users/:id/status */
export async function setStatus(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  const { activo } = req.body;

  if (typeof activo !== 'boolean') {
    sendError(res, 400, 'El campo "activo" debe ser booleano.');
    return;
  }

  try {
    const ok = await UsersService.setUserActive(req.params.id, activo);
    if (!ok) { sendError(res, 404, 'Usuario no encontrado.'); return; }

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      accion:     AuditAction.USER_DEACTIVATED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, { message: `Usuario ${activo ? 'activado' : 'desactivado'}.` });
  } catch (err) {
    logger.error('Error al cambiar estado del usuario', { error: err });
    sendServerError(res);
  }
}

/** POST /admin/users/:id/reset-password */
export async function resetPassword(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const plainPassword = await UsersService.resetPassword(req.params.id);
    if (!plainPassword) { sendError(res, 404, 'Usuario no encontrado.'); return; }

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      accion:     AuditAction.PASSWORD_RESET,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    // Devolver contraseña UNA SOLA VEZ
    sendOk(res, { plainPassword, message: 'Contraseña reseteada. Guardala — no se volverá a mostrar.' });
  } catch (err) {
    logger.error('Error al resetear contraseña', { error: err });
    sendServerError(res);
  }
}

/** POST /admin/users/:id/revoke-kiosk */
export async function revokeKiosk(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    await revokeKioskSession(req.params.id);

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      accion:     AuditAction.KIOSK_REVOKED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, { message: 'Sesión kiosk revocada.' });
  } catch (err) {
    logger.error('Error al revocar sesión kiosk', { error: err });
    sendServerError(res);
  }
}

export async function deleteUserHandler(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const { id } = req.params;
    // No permitir auto-eliminación
    if (id === req.user!.sub) {
      sendError(res, 400, 'No podés eliminar tu propio usuario.');
      return;
    }
    const result = await pool.query(`DELETE FROM usuarios WHERE id = $1`, [id]);
    if ((result.rowCount ?? 0) === 0) {
      sendError(res, 404, 'Usuario no encontrado.');
      return;
    }

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      accion:     AuditAction.USER_DELETED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, { deleted: true });
  } catch (err) {
    logger.error('Error al eliminar usuario', { error: err });
    sendServerError(res);
  }
}
