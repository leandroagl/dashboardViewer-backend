// ─── Tests unitarios: dashboards.controller (resolveClientAccess) ─────────────
// Verifica la lógica de autorización multi-tenant:
// - 404 si el cliente no existe o está inactivo
// - 403 si un viewer intenta acceder al slug de otro cliente
// - 200 si el viewer accede a su propio cliente
// - admin_ondra puede acceder a cualquier slug
// No requiere DB real — mockea clients.service y dashboards.service.

import type { Request, Response } from 'express';
import { UserRole } from '../types';

jest.mock('../modules/clients/clients.service', () => ({
  getClientBySlug: jest.fn(),
}));

jest.mock('../modules/dashboards/dashboards.service', () => ({
  getAvailableDashboards: jest.fn().mockResolvedValue([]),
  getVmwareDashboard:     jest.fn().mockResolvedValue({ hosts: [], alerts: [], sparklines: {} }),
  getBackupsDashboard:    jest.fn().mockResolvedValue({ successRate7d: 0, devices: [], alerts: [] }),
  getNetworkingDashboard: jest.fn().mockResolvedValue({ devices: [], switches: [], ptpAntennas: [], alerts: [] }),
  getWindowsDashboard:    jest.fn().mockResolvedValue({ servers: [], alerts: [] }),
  getSucursalesDashboard: jest.fn().mockResolvedValue({ sucursales: [], onlineCount: 0, offlineCount: 0, alerts: [], sparklines: {} }),
}));

jest.mock('../middleware/auditLogger', () => ({
  audit:       jest.fn().mockResolvedValue(undefined),
  getClientIp: jest.fn().mockReturnValue('127.0.0.1'),
}));

jest.mock('../config/env', () => ({
  env: {
    prtg:    { baseUrl: 'https://prtg.test', apiToken: 'x', username: '', passhash: '', rejectUnauthorized: false, subgroups: [] },
    db:      { host: 'localhost', port: 5432, name: 'test', user: 'test', password: 'test' },
    jwt:     { accessSecret: 'x', refreshSecret: 'x', accessExpiresIn: '5h', refreshExpiresIn: '7d' },
    port:    3000,
    nodeEnv: 'test',
    isDev:   false,
    corsOrigin: '',
    cookie:  { domain: 'localhost', secure: false },
  },
}));

import { getClientBySlug } from '../modules/clients/clients.service';
import { audit } from '../middleware/auditLogger';
import { getAvailable, getServers } from '../modules/dashboards/dashboards.controller';
import * as DashboardsService from '../modules/dashboards/dashboards.service';

const mockGetClientBySlug = getClientBySlug as jest.MockedFunction<typeof getClientBySlug>;
const mockAudit           = audit as jest.MockedFunction<typeof audit>;
const mockGetAvailable    = DashboardsService.getAvailableDashboards as jest.MockedFunction<typeof DashboardsService.getAvailableDashboards>;
const mockGetVmware       = DashboardsService.getVmwareDashboard as jest.MockedFunction<typeof DashboardsService.getVmwareDashboard>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLIENT_ID    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_CLIENT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeClient(overrides: Partial<{
  id: string; activo: boolean; prtg_group: string; prtg_extra_probes: string | null;
}> = {}) {
  return {
    id:                overrides.id         ?? CLIENT_ID,
    nombre:            'Cliente Test',
    slug:              'cliente-test',
    prtg_group:        overrides.prtg_group ?? 'GrupoTest',
    prtg_extra_probes: overrides.prtg_extra_probes ?? null,
    activo:            overrides.activo     ?? true,
    creado_en:         new Date(),
  };
}

function makeReq(params: Record<string, string>, userId: string, rol: UserRole, clienteId: string | null = CLIENT_ID): Request {
  return {
    params,
    user:    { sub: userId, email: 'user@test.com', rol, cliente_id: clienteId, es_kiosk: false },
    headers: {},
    ip:      '127.0.0.1',
  } as unknown as Request;
}

function makeRes() {
  const json   = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json, statusCode: 200 } as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAvailable.mockResolvedValue([]);
  mockGetVmware.mockResolvedValue({ hosts: [], alerts: [], sparklines: {} });
});

describe('resolveClientAccess — cliente no encontrado / inactivo', () => {

  test('devuelve 404 si el slug no existe', async () => {
    mockGetClientBySlug.mockResolvedValue(null);
    const req = makeReq({ clientSlug: 'no-existe' }, 'user1', UserRole.VIEWER);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('devuelve 404 si el cliente existe pero está inactivo', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient({ activo: false }));
    const req = makeReq({ clientSlug: 'cliente-test' }, 'user1', UserRole.VIEWER);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
  });

});

describe('resolveClientAccess — autorización por rol', () => {

  test('viewer con cliente_id propio recibe 200', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient());
    const req = makeReq({ clientSlug: 'cliente-test' }, 'user1', UserRole.VIEWER, CLIENT_ID);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    // No debe llamar al status con 403 ni 404 — la respuesta exitosa usa res.json directamente
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  test('viewer con cliente_id diferente recibe 403', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient({ id: OTHER_CLIENT }));
    const req = makeReq({ clientSlug: 'otro-cliente' }, 'user1', UserRole.VIEWER, CLIENT_ID);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('viewer denegado dispara audit con AuditAction.ACCESS_DENIED', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient({ id: OTHER_CLIENT }));
    const req = makeReq({ clientSlug: 'otro-cliente' }, 'user1', UserRole.VIEWER, CLIENT_ID);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'acceso_denegado', resultado: 'unauthorized' })
    );
  });

  test('admin_ondra puede acceder a cualquier slug sin importar su cliente_id', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient({ id: OTHER_CLIENT }));
    const req = makeReq({ clientSlug: 'cualquier-cliente' }, 'admin1', UserRole.ADMIN_ONDRA, null);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  test('viewer_kiosk con cliente_id propio recibe 200', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient());
    const req = makeReq({ clientSlug: 'cliente-test' }, 'kiosk1', UserRole.VIEWER_KIOSK, CLIENT_ID);
    const res = makeRes();

    await getAvailable(req, res as unknown as Response);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

});

describe('resolveClientAccess — propagación de prtgGroup y extraProbes', () => {

  test('pasa prtgGroup y extraProbes vacíos cuando no hay prtg_extra_probes', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient({ prtg_group: 'GrupoA', prtg_extra_probes: null }));
    const req = makeReq({ clientSlug: 'cliente-test' }, 'admin1', UserRole.ADMIN_ONDRA, null);
    const res = makeRes();

    await getServers(req, res as unknown as Response);

    expect(mockGetVmware).toHaveBeenCalledWith('GrupoA', []);
  });

  test('parsea prtg_extra_probes como array separado por comas', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient({ prtg_group: 'GrupoA', prtg_extra_probes: 'Velia, OtraSonda' }));
    const req = makeReq({ clientSlug: 'cliente-test' }, 'admin1', UserRole.ADMIN_ONDRA, null);
    const res = makeRes();

    await getServers(req, res as unknown as Response);

    expect(mockGetVmware).toHaveBeenCalledWith('GrupoA', ['Velia', 'OtraSonda']);
  });

  test('acceso exitoso registra audit DASHBOARD_VIEW con dashboard="servers"', async () => {
    mockGetClientBySlug.mockResolvedValue(makeClient());
    const req = makeReq({ clientSlug: 'cliente-test' }, 'user1', UserRole.VIEWER, CLIENT_ID);
    const res = makeRes();

    await getServers(req, res as unknown as Response);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'dashboard_view', dashboard: 'servers', resultado: 'ok' })
    );
  });

});
