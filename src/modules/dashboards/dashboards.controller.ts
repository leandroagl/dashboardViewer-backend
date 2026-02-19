// ─── Controller de Dashboards ─────────────────────────────────────────────────
// Endpoints que consumen los datos de PRTG transformados para cada dashboard.
// El acceso está protegido: el usuario solo puede acceder al slug de su cliente.

import { Request, Response } from 'express';
import { sendOk, sendError, sendServerError } from '../../utils/response';
import { audit, getClientIp } from '../../middleware/auditLogger';
import { AuditAction, AuditResult, UserRole } from '../../types';
import { logger } from '../../utils/logger';
import { getClientBySlug } from '../clients/clients.service';
import * as DashboardsService from './dashboards.service';

/**
 * Verifica que el usuario tenga acceso al slug solicitado y devuelve el prtgGroup.
 * Los admin_ondra pueden acceder a cualquier slug.
 */
async function resolveClientAccess(req: Request, res: Response): Promise<{ prtgGroup: string; clienteId: string } | null> {
  const { clientSlug } = req.params;

  const client = await getClientBySlug(clientSlug);

  if (!client || !client.activo) {
    sendError(res, 404, 'Cliente no encontrado o inactivo.');
    return null;
  }

  // viewer solo puede acceder a su propio cliente
  if (req.user!.rol !== UserRole.ADMIN_ONDRA) {
    if (client.id !== req.user!.cliente_id) {
      sendError(res, 403, 'Acceso denegado.');
      return null;
    }
  }

  return { prtgGroup: client.prtg_group, clienteId: client.id };
}

/** GET /:clientSlug/dashboards — Lista los dashboards disponibles */
export async function getAvailable(req: Request, res: Response): Promise<void> {
  try {
    const access = await resolveClientAccess(req, res);
    if (!access) return;

    const available = await DashboardsService.getAvailableDashboards(access.prtgGroup);
    sendOk(res, { dashboards: available });
  } catch (err) {
    logger.error('Error al obtener dashboards disponibles', { error: err });
    sendServerError(res);
  }
}

/** GET /:clientSlug/dashboards/servers */
export async function getServers(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const access = await resolveClientAccess(req, res);
    if (!access) return;

    const data = await DashboardsService.getVmwareDashboard(access.prtgGroup);

    await audit({ usuario_id: req.user!.sub, email: req.user!.email, cliente_id: access.clienteId,
      accion: AuditAction.DASHBOARD_VIEW, dashboard: 'servers', ip_origen: ip, resultado: AuditResult.OK });

    sendOk(res, data);
  } catch (err) {
    logger.error('Error en dashboard servers', { error: err });
    sendServerError(res);
  }
}

/** GET /:clientSlug/dashboards/backups */
export async function getBackups(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const access = await resolveClientAccess(req, res);
    if (!access) return;

    const data = await DashboardsService.getBackupsDashboard(access.prtgGroup);

    await audit({ usuario_id: req.user!.sub, email: req.user!.email, cliente_id: access.clienteId,
      accion: AuditAction.DASHBOARD_VIEW, dashboard: 'backups', ip_origen: ip, resultado: AuditResult.OK });

    sendOk(res, data);
  } catch (err) {
    logger.error('Error en dashboard backups', { error: err });
    sendServerError(res);
  }
}

/** GET /:clientSlug/dashboards/networking */
export async function getNetworking(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const access = await resolveClientAccess(req, res);
    if (!access) return;

    const data = await DashboardsService.getNetworkingDashboard(access.prtgGroup);

    await audit({ usuario_id: req.user!.sub, email: req.user!.email, cliente_id: access.clienteId,
      accion: AuditAction.DASHBOARD_VIEW, dashboard: 'networking', ip_origen: ip, resultado: AuditResult.OK });

    sendOk(res, data);
  } catch (err) {
    logger.error('Error en dashboard networking', { error: err });
    sendServerError(res);
  }
}

/** GET /:clientSlug/dashboards/windows */
export async function getWindows(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req);
  try {
    const access = await resolveClientAccess(req, res);
    if (!access) return;

    const data = await DashboardsService.getWindowsDashboard(access.prtgGroup);

    await audit({ usuario_id: req.user!.sub, email: req.user!.email, cliente_id: access.clienteId,
      accion: AuditAction.DASHBOARD_VIEW, dashboard: 'windows', ip_origen: ip, resultado: AuditResult.OK });

    sendOk(res, data);
  } catch (err) {
    logger.error('Error en dashboard windows', { error: err });
    sendServerError(res);
  }
}
