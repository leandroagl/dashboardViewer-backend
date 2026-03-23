// Tests del endpoint GET /history
jest.mock('../modules/dashboards/dashboards.service', () => ({
  getHistoryData: jest.fn(),
}));
jest.mock('../modules/clients/clients.service', () => ({
  getClientBySlug: jest.fn(),
}));
jest.mock('../middleware/auditLogger', () => ({
  audit: jest.fn().mockResolvedValue(undefined),
  getClientIp: () => '127.0.0.1',
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import { Router } from 'express';
import { getClientBySlug } from '../modules/clients/clients.service';
import { getHistoryData } from '../modules/dashboards/dashboards.service';
import * as controller from '../modules/dashboards/dashboards.controller';

const mockGetClient  = getClientBySlug as jest.MockedFunction<typeof getClientBySlug>;
const mockGetHistory = getHistoryData  as jest.MockedFunction<typeof getHistoryData>;

function makeApp(user: object = { sub: 'u1', email: 'a@b.com', rol: 'admin_ondra', cliente_id: null }) {
  const app = express();
  app.use((req, _res, next) => { (req as any).user = user; next(); });
  const r = Router({ mergeParams: true });
  r.get('/history', controller.getHistory);
  app.use('/:clientSlug/dashboards', r);
  return app;
}

describe('GET /:clientSlug/dashboards/history', () => {
  beforeEach(() => jest.clearAllMocks());

  const fakeClient = {
    id: 'c1', nombre: 'ONDRA', slug: 'ondra', prtg_group: 'ONDRA',
    prtg_extra_probes: null, activo: true,
  };

  const fakeHistory = {
    objid: 1234, sensorName: 'CPU ESX01', range: '24h' as const,
    points: [{ datetime: '2026-03-22T10:00:00.000Z', value: 23 }],
    stats: { max: 40, avg: 28, min: 18, prevMax: 35, prevAvg: 24, prevMin: 15 },
  };

  test('devuelve 200 con datos históricos cuando objid y range son válidos', async () => {
    mockGetClient.mockResolvedValue(fakeClient as any);
    mockGetHistory.mockResolvedValue(fakeHistory);

    const res = await request(makeApp())
      .get('/ondra/dashboards/history')
      .query({ objid: '1234', range: '24h' });

    expect(res.status).toBe(200);
    expect(res.body.data.objid).toBe(1234);
  });

  test('devuelve 400 cuando objid no es numérico', async () => {
    mockGetClient.mockResolvedValue(fakeClient as any);
    const res = await request(makeApp()).get('/ondra/dashboards/history').query({ objid: 'abc', range: '24h' });
    expect(res.status).toBe(400);
  });

  test('devuelve 400 cuando range no es válido', async () => {
    mockGetClient.mockResolvedValue(fakeClient as any);
    const res = await request(makeApp()).get('/ondra/dashboards/history').query({ objid: '1234', range: '2h' });
    expect(res.status).toBe(400);
  });
});
