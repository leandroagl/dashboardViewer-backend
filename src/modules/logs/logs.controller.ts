// ─── Controller de Logs de Auditoría ─────────────────────────────────────────

import { Request, Response } from 'express';
import { sendError, sendOk, sendServerError } from '../../utils/response';
import { logger } from '../../utils/logger';
import * as LogsService from './logs.service';
import { pool } from '../../config/database/pool';
import { AuditAction, AuditResult } from '../../types';
import { audit, getClientIp } from '../../middleware/auditLogger';

const PAGE_SIZE = 50;

/** GET /admin/logs */
export async function getLogs(req: Request, res: Response): Promise<void> {
  try {
    const rawPage = parseInt(req.query.page as string ?? '1', 10);
    const page    = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);
    const limit = PAGE_SIZE;

    const result = await LogsService.getLogs({
      clienteId: req.query.cliente_id as string | undefined,
      usuarioId: req.query.usuario_id as string | undefined,
      accion:    req.query.accion     as string | undefined,
      resultado: req.query.resultado  as string | undefined,
      desde:     req.query.desde      as string | undefined,
      hasta:     req.query.hasta      as string | undefined,
      page,
      limit,
    });

    sendOk(res, result.logs, {
      total:       result.total,
      page,
      limit,
      totalPages:  Math.ceil(result.total / limit),
      resumen:     result.resumen,
    });
  } catch (err) {
    logger.error('Error al obtener logs', { error: err });
    sendServerError(res);
  }
}

/** GET /admin/logs/suspicious-ips */
export async function getSuspiciousIps(req: Request, res: Response): Promise<void> {
  try {
    const ips = await LogsService.getSuspiciousIps();
    sendOk(res, ips);
  } catch (err) {
    logger.error('Error al obtener IPs sospechosas', { error: err });
    sendServerError(res);
  }
}

/** GET /admin/logs/export */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  try {
    const csv = await LogsService.exportLogsCsv({
      clienteId: req.query.cliente_id as string | undefined,
      usuarioId: req.query.usuario_id as string | undefined,
      accion:    req.query.accion     as string | undefined,
      resultado: req.query.resultado  as string | undefined,
      desde:     req.query.desde      as string | undefined,
      hasta:     req.query.hasta      as string | undefined,
    });

    const filename = `ondra-logs-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error('Error al exportar logs', { error: err });
    sendServerError(res);
  }
}

export async function purgeLogsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { antes_de } = req.query;

    // Validar que antes_de sea una fecha ISO válida antes de pasarla a PostgreSQL
    if (antes_de !== undefined && Number.isNaN(Date.parse(antes_de as string))) {
      sendError(res, 400, 'El parámetro antes_de debe ser una fecha ISO válida (ej: 2024-01-01T00:00:00Z).');
      return;
    }

    const deleted = await LogsService.purgeLogs(antes_de as string | undefined);
    await audit({
      usuario_id: req.user!.sub, email: req.user!.email, cliente_id: undefined,
      accion: AuditAction.LOGS_PURGE, ip_origen: getClientIp(req), resultado: AuditResult.OK,
    });
    sendOk(res, { deleted });
  } catch (err) {
    logger.error('Error al purgar logs', { error: err });
    sendServerError(res);
  }
}



