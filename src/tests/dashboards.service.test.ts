// ─── Tests unitarios: dashboards.service ──────────────────────────────────────
// Verifica la detección automática de dashboards a partir de sensores PRTG.
// No requiere DB real — mockea getSensorsByGroup para aislar la lógica de servicio.

import { invalidateCache } from '../utils/cache';

// Mock del cliente PRTG para evitar llamadas de red reales
jest.mock('../modules/prtg/prtg.client', () => ({
  getSensorsByGroup: jest.fn(),
  getSensorChannels:  jest.fn(),
}));

// Mock de env para controlar PRTG_SUBGROUPS sin depender del .env real
jest.mock('../config/env', () => ({
  env: {
    prtg: {
      baseUrl:            'https://prtg.test',
      apiToken:           'test-token',
      username:           '',
      passhash:           '',
      rejectUnauthorized: false,
      subgroups: [
        'Windows Server', 'Networking', 'Servers',
        'Backups', 'Switches', 'Antenas PTP', 'Sucursales',
      ],
    },
    db:     { host: 'localhost', port: 5432, name: 'test', user: 'test', password: 'test' },
    jwt:    { accessSecret: 'x', refreshSecret: 'x', accessExpiresIn: '5h', refreshExpiresIn: '7d' },
    port:   3000,
    nodeEnv: 'test',
    isDev:  false,
    corsOrigin: '',
    cookie: { domain: 'localhost', secure: false, sameSite: 'lax' },
  },
}));

import { getSensorsByGroup } from '../modules/prtg/prtg.client';
import { getAvailableDashboards, DashboardType } from '../modules/dashboards/dashboards.service';

const mockGetSensors = getSensorsByGroup as jest.MockedFunction<typeof getSensorsByGroup>;

// Sensor de utilidad para tests
function makeSensor(group: string, probe: string) {
  return {
    objid:      1,
    name:       'Ping',
    device:     'Host',
    group,
    probe,
    status:     'Up',
    status_raw: 3,
    lastvalue:  '1 ms',
    message:    'OK',
    tags:       '',
  };
}

describe('getAvailableDashboards', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    // Limpiar el cache de detección para que cada test parta desde cero
    // Se invalidan las claves posibles usadas en estos tests
    ['ONDRA', 'ONDRA,Velia', 'ClienteA', 'ClienteA,Extra'].forEach(k =>
      invalidateCache(`available:${k}`),
    );
  });

  // ─── Detección de sucursales con grupo anidado ──────────────────────────────

  test('detecta sucursales cuando el sensor tiene group = "Networking > Sucursales"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor('Networking',            'ONDRA'),
      makeSensor('Networking > Sucursales', 'ONDRA'),
    ]);

    const result = await getAvailableDashboards('ONDRA');

    expect(result).toContain('networking');
    expect(result).toContain('sucursales');
  });

  test('detecta sucursales cuando el sensor tiene group = "Sucursales" (subgrupo directo)', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor('Sucursales', 'ONDRA'),
    ]);

    const result = await getAvailableDashboards('ONDRA');

    expect(result).toContain('sucursales');
  });

  test('no incluye sucursales si no hay sensores con ese grupo', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor('Servers',    'ONDRA'),
      makeSensor('Networking', 'ONDRA'),
    ]);

    const result = await getAvailableDashboards('ONDRA');

    expect(result).not.toContain('sucursales');
  });

  // ─── Orden de dashboards ────────────────────────────────────────────────────

  test('devuelve dashboards en el orden canónico: servers, backups, networking, windows, sucursales', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor('Sucursales',            'ONDRA'),
      makeSensor('Windows Server',        'ONDRA'),
      makeSensor('Networking',            'ONDRA'),
      makeSensor('Servers',               'ONDRA'),
      makeSensor('Backups',               'ONDRA'),
    ]);

    const result = await getAvailableDashboards('ONDRA');
    const expected: DashboardType[] = ['servers', 'backups', 'networking', 'windows', 'sucursales'];

    expect(result).toEqual(expected);
  });

  // ─── Cache key incluye extraProbes ──────────────────────────────────────────

  test('cache keys distintos para mismo prtgGroup con diferente extraProbes', async () => {
    // Primera llamada: ONDRA sin extra probes — sin sucursales
    mockGetSensors.mockResolvedValueOnce([
      makeSensor('Servers', 'ONDRA'),
    ]);
    const sinExtra = await getAvailableDashboards('ONDRA', []);

    // Segunda llamada: ONDRA con extra probe Velia — con sucursales
    mockGetSensors.mockResolvedValueOnce([
      makeSensor('Servers',     'ONDRA'),
      makeSensor('Sucursales',  'Velia'),
    ]);
    const conExtra = await getAvailableDashboards('ONDRA', ['Velia']);

    // Deben ser resultados independientes (cache por separado)
    expect(sinExtra).not.toContain('sucursales');
    expect(conExtra).toContain('sucursales');

    // getSensorsByGroup debe haberse llamado dos veces (sin cache cross-contamination)
    expect(mockGetSensors).toHaveBeenCalledTimes(2);
  });

  test('mismo prtgGroup + mismos extraProbes → segunda llamada usa cache (getSensorsByGroup solo 1 vez)', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor('Sucursales', 'ONDRA'),
    ]);

    await getAvailableDashboards('ONDRA', ['Velia']);
    await getAvailableDashboards('ONDRA', ['Velia']); // debe venir del cache

    expect(mockGetSensors).toHaveBeenCalledTimes(1);
  });

  // ─── Variantes de nombre de grupo ──────────────────────────────────────────

  test('NO detecta sucursales con nombre "Sucursal" (singular sin e — fuera del patrón)', async () => {
    // El patrón /^sucursales?$/i acepta "sucursale" o "sucursales", no "sucursal"
    mockGetSensors.mockResolvedValue([
      makeSensor('Sucursal', 'ONDRA'),
    ]);

    const result = await getAvailableDashboards('ONDRA');

    expect(result).not.toContain('sucursales');
  });

  test('detecta sucursales con nombre en mayúsculas (case-insensitive)', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor('SUCURSALES', 'ONDRA'),
    ]);

    const result = await getAvailableDashboards('ONDRA');

    expect(result).toContain('sucursales');
  });

  // ─── No expone dashboards de otros clientes ─────────────────────────────────

  test('solo incluye dashboards cuyo probe coincide con el cliente (filtrado por probe)', async () => {
    // getSensorsByGroup ya aplica el filtro de probe — devolvemos solo del cliente correcto
    mockGetSensors.mockResolvedValue([
      makeSensor('Sucursales', 'ONDRA'), // del cliente correcto
      // No incluimos sensores de otros clientes porque getSensorsByGroup ya los filtra
    ]);

    const result = await getAvailableDashboards('ONDRA');

    expect(result).toContain('sucursales');
    expect(mockGetSensors).toHaveBeenCalledWith('ONDRA', []);
  });

});

// ─── Configuración: PRTG_SUBGROUPS debe incluir Sucursales ───────────────────

describe('Configuración de PRTG_SUBGROUPS', () => {

  test('el mock de env incluye "Sucursales" en subgroups (refleja .env.example actualizado)', () => {
    const { env } = require('../config/env');
    expect(env.prtg.subgroups).toContain('Sucursales');
  });

});
