// ─── Controller de Clientes ───────────────────────────────────────────────────

import { Request, Response } from 'express';
import { body, param } from 'express-validator';
import { audit, getClientIp } from '../../middleware/auditLogger';
import { AuditAction, AuditResult } from '../../types';
import { sendOk, sendError, sendServerError } from '../../utils/response';
import { logger } from '../../utils/logger';
import * as ClientsService from './clients.service';
import { pool } from '../../config/database/pool';

// ─── Validadores ──────────────────────────────────────────────────────────────

export const idParamValidator = [
  param('id').isUUID().withMessage('ID inválido.'),
];

export const createClientValidators = [
  body('nombre').notEmpty().trim().withMessage('Nombre requerido.'),
  body('slug')
    .notEmpty().trim()
    .matches(/^[a-z0-9-]+$/).withMessage('El slug solo puede contener letras minúsculas, números y guiones.'),
  body('prtg_group').notEmpty().trim().withMessage('Grupo PRTG requerido.'),
  body('color_marca').optional().matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Color debe ser HEX válido (ej: #4dd0e1).'),
];

export const updateClientValidators = [
  param('id').isUUID().withMessage('ID inválido.'),
  body('color_marca').optional().matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Color debe ser HEX válido.'),
];

// ─── Endpoints ────────────────────────────────────────────────────────────────

/** GET /admin/clients */
export async function getAll(req: Request, res: Response): Promise<void> {
  try {
    const clients = await ClientsService.getAllClients();
    sendOk(res, clients);
  } catch (err) {
    logger.error('Error al obtener clientes', { error: err });
    sendServerError(res);
  }
}

/** GET /admin/clients/:id */
export async function getOne(req: Request, res: Response): Promise<void> {
  try {
    const client = await ClientsService.getClientById(req.params.id);
    if (!client) { sendError(res, 404, 'Cliente no encontrado.'); return; }
    sendOk(res, client);
  } catch (err) {
    logger.error('Error al obtener cliente', { error: err });
    sendServerError(res);
  }
}

/** POST /admin/clients */
export async function create(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const client = await ClientsService.createClient(req.body);

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      cliente_id: client.id,
      accion:     AuditAction.CONFIG_MODIFIED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, client, undefined, 201);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      sendError(res, 409, 'Ya existe un cliente con ese slug.');
      return;
    }
    logger.error('Error al crear cliente', { error: err });
    sendServerError(res);
  }
}

/** PATCH /admin/clients/:id */
export async function update(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const client = await ClientsService.updateClient(req.params.id, req.body);
    if (!client) { sendError(res, 404, 'Cliente no encontrado.'); return; }

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      cliente_id: client.id,
      accion:     AuditAction.CONFIG_MODIFIED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, client);
  } catch (err) {
    logger.error('Error al actualizar cliente', { error: err });
    sendServerError(res);
  }
}

/** PATCH /admin/clients/:id/status */
export async function setStatus(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  const { activo } = req.body;

  if (typeof activo !== 'boolean') {
    sendError(res, 400, 'El campo "activo" debe ser booleano.');
    return;
  }

  try {
    const client = await ClientsService.setClientActive(req.params.id, activo);
    if (!client) { sendError(res, 404, 'Cliente no encontrado.'); return; }

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      cliente_id: client.id,
      accion:     AuditAction.CONFIG_MODIFIED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, client);
  } catch (err) {
    logger.error('Error al cambiar estado del cliente', { error: err });
    sendServerError(res);
  }
}

export async function deleteClientHandler(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const { id } = req.params;
    // Verificar que no tenga usuarios activos
    const check = await pool.query(
      `SELECT COUNT(*)::int as total FROM usuarios WHERE cliente_id = $1 AND activo = TRUE`,
      [id]
    );
    if (check.rows[0].total > 0) {
      sendError(res, 400, 'No se puede eliminar un cliente con usuarios activos.');
      return;
    }
    const result = await pool.query(`DELETE FROM clientes WHERE id = $1`, [id]);
    if ((result.rowCount ?? 0) === 0) {
      sendError(res, 404, 'Cliente no encontrado.');
      return;
    }

    await audit({
      usuario_id: req.user!.sub,
      email:      req.user!.email,
      cliente_id: id,
      accion:     AuditAction.CLIENT_DELETED,
      ip_origen:  ip,
      resultado:  AuditResult.OK,
    });

    sendOk(res, { deleted: true });
  } catch (err) {
    logger.error('Error al eliminar cliente', { error: err });
    sendServerError(res);
  }
}