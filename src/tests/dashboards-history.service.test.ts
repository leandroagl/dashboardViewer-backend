// ─── Tests: history service ────────────────────────────────────────────────────
jest.mock('../modules/prtg/prtg.client', () => ({
  getSensorsByGroup:  jest.fn(),
  getSensorChannels:  jest.fn(),
  getHistoricData:    jest.fn(),
  getSensorDetail:    jest.fn(),
}));

jest.mock('../config/env', () => ({
  env: {
    prtg: {
      baseUrl: 'https://prtg.test', apiToken: 'test-token',
      username: '', passhash: '', rejectUnauthorized: false,
      subgroups: ['Servers'],
    },
    db: { host: 'localhost', port: 5432, name: 'test', user: 'test', password: 'test' },
    jwt: { accessSecret: 'x', refreshSecret: 'x', accessExpiresIn: '5h', refreshExpiresIn: '7d' },
    port: 3000, nodeEnv: 'test', isDev: false, corsOrigin: '',
    cookie: { domain: 'localhost', secure: false, sameSite: 'lax' },
  },
}));

import { extractChannelValues } from '../modules/dashboards/dashboards.service';
import { getSensorsByGroup, getSensorChannels, getHistoricData } from '../modules/prtg/prtg.client';
import { getVmwareDashboard, getBackupsDashboard, getWindowsDashboard, getSucursalesDashboard } from '../modules/dashboards/dashboards.service';
import { invalidateCache } from '../utils/cache';

const mockGetSensors  = getSensorsByGroup as jest.MockedFunction<typeof getSensorsByGroup>;
const mockGetChannels = getSensorChannels as jest.MockedFunction<typeof getSensorChannels>;
const mockGetHistoric = getHistoricData   as jest.MockedFunction<typeof getHistoricData>;

describe('extractChannelValues', () => {
  test('extracts value_raw from single-channel histdata', () => {
    const histdata = [
      { datetime: '2026-03-22 10:00:00', 'value_raw (Response Time)': 23.4 },
      { datetime: '2026-03-22 10:05:00', 'value_raw (Response Time)': 28.1 },
    ];
    expect(extractChannelValues(histdata)).toEqual([23.4, 28.1]);
  });

  test('filters by channel pattern', () => {
    const histdata = [
      {
        datetime: '2026-03-22 10:00:00',
        'value_raw (CPU Usage)': 23.4,
        'value_raw (Memory Consumed)': 65.0,
      },
    ];
    expect(extractChannelValues(histdata, /cpu\s*usage/i)).toEqual([23.4]);
    expect(extractChannelValues(histdata, /memory/i)).toEqual([65.0]);
  });

  test('returns empty array when histdata is empty', () => {
    expect(extractChannelValues([])).toEqual([]);
  });

  test('skips points with no matching value_raw key', () => {
    const histdata = [
      { datetime: '2026-03-22 10:00:00', 'value (No Raw)': '23' },
      { datetime: '2026-03-22 10:05:00', 'value_raw (CPU Usage)': 10.0 },
    ];
    expect(extractChannelValues(histdata)).toEqual([10.0]);
  });
});

describe('VmwareDashboard sparklines', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateCache('vmware:ONDRA');
  });

  test('incluye sparklines con objid y values para cada host/métrica', async () => {
    mockGetSensors.mockResolvedValue([{
      objid: 100, name: 'Host Performance', device: 'ESX01',
      group: 'Servers', probe: 'ONDRA', status: 'Up', status_raw: 3,
      lastvalue: '23 %', message: 'OK', tags: '',
    }]);
    mockGetChannels.mockResolvedValue([
      { name: 'CPU Usage',         lastvalue: '23 %',   lastvalue_raw: 23   },
      { name: 'Memory Consumed',   lastvalue: '65 %',   lastvalue_raw: 65   },
      { name: 'Disk Read Rate',    lastvalue: '2.1 MB', lastvalue_raw: 2.1  },
      { name: 'Disk Write Rate',   lastvalue: '0.8 MB', lastvalue_raw: 0.8  },
    ]);
    mockGetHistoric.mockResolvedValue([
      { datetime: '...', 'value_raw (CPU Usage)': 20, 'value_raw (Memory Consumed)': 60, 'value_raw (Disk Read Rate)': 1.5, 'value_raw (Disk Write Rate)': 0.5 },
      { datetime: '...', 'value_raw (CPU Usage)': 23, 'value_raw (Memory Consumed)': 65, 'value_raw (Disk Read Rate)': 2.1, 'value_raw (Disk Write Rate)': 0.8 },
    ]);

    const result = await getVmwareDashboard('ONDRA');

    expect(result.sparklines['ESX01/cpu']).toEqual({ objid: 100, values: [20, 23] });
    expect(result.sparklines['ESX01/ram']).toEqual({ objid: 100, values: [60, 65] });
    expect(result.sparklines['ESX01/diskR']).toEqual({ objid: 100, values: [1.5, 2.1] });
    expect(result.sparklines['ESX01/diskW']).toEqual({ objid: 100, values: [0.5, 0.8] });
  });

  test('sparklines es {} cuando no hay Host Performance sensor', async () => {
    mockGetSensors.mockResolvedValue([{
      objid: 1, name: 'Uptime', device: 'ESX01',
      group: 'Servers', probe: 'ONDRA', status: 'Up', status_raw: 3,
      lastvalue: '5 d', message: 'OK', tags: '',
    }]);
    mockGetChannels.mockResolvedValue([]);
    mockGetHistoric.mockResolvedValue([]);

    const result = await getVmwareDashboard('ONDRA');
    expect(result.sparklines).toEqual({});
  });
});

describe('BackupsDashboard sparklines', () => {
  beforeEach(() => { jest.clearAllMocks(); invalidateCache('backups:ONDRA'); });

  test('incluye sparklines con los últimos 7 resultados binarios del job', async () => {
    mockGetSensors.mockResolvedValue([{
      objid: 200, name: 'Job - Backup diario', device: 'Veeam',
      group: 'Backups', probe: 'ONDRA', status: 'Up', status_raw: 3,
      lastvalue: '0 h', message: 'OK', tags: '',
    }]);
    mockGetChannels.mockResolvedValue([
      { name: 'Last Job Run', lastvalue: '2 h', lastvalue_raw: 2 },
    ]);
    mockGetHistoric.mockResolvedValue([
      { datetime: '...', 'value_raw (Last Result)': 1 },
      { datetime: '...', 'value_raw (Last Result)': 1 },
      { datetime: '...', 'value_raw (Last Result)': 0 },
      { datetime: '...', 'value_raw (Last Result)': 1 },
      { datetime: '...', 'value_raw (Last Result)': 1 },
      { datetime: '...', 'value_raw (Last Result)': 1 },
      { datetime: '...', 'value_raw (Last Result)': 1 },
    ]);

    const result = await getBackupsDashboard('ONDRA');
    expect(result.sparklines['Veeam/Job - Backup diario']).toEqual({
      objid: 200,
      values: [1, 1, 0, 1, 1, 1, 1],
    });
  });
});

describe('WindowsDashboard uptimeAvgHours', () => {
  beforeEach(() => { jest.clearAllMocks(); invalidateCache('windows:ONDRA'); });

  test('calcula el promedio de uptime desde los valores de los sensores', async () => {
    mockGetSensors.mockResolvedValue([
      { objid: 301, name: 'CPU',    device: 'SRV01', group: 'Windows Server', probe: 'ONDRA', status: 'Up', status_raw: 3, lastvalue: '45 %',  message: 'OK', tags: '' },
      { objid: 302, name: 'Memory', device: 'SRV01', group: 'Windows Server', probe: 'ONDRA', status: 'Up', status_raw: 3, lastvalue: '60 %',  message: 'OK', tags: '' },
      { objid: 303, name: 'Disk',   device: 'SRV01', group: 'Windows Server', probe: 'ONDRA', status: 'Up', status_raw: 3, lastvalue: '70 %',  message: 'OK', tags: '' },
      { objid: 304, name: 'Uptime', device: 'SRV01', group: 'Windows Server', probe: 'ONDRA', status: 'Up', status_raw: 3, lastvalue: '120 h', message: 'OK', tags: '' },
      { objid: 311, name: 'CPU',    device: 'SRV02', group: 'Windows Server', probe: 'ONDRA', status: 'Up', status_raw: 3, lastvalue: '30 %',  message: 'OK', tags: '' },
      { objid: 314, name: 'Uptime', device: 'SRV02', group: 'Windows Server', probe: 'ONDRA', status: 'Up', status_raw: 3, lastvalue: '48 h',  message: 'OK', tags: '' },
    ]);
    mockGetChannels.mockResolvedValue([]);
    mockGetHistoric.mockResolvedValue([]);

    const result = await getWindowsDashboard('ONDRA');
    // (120 + 48) / 2 = 84
    expect(result.uptimeAvgHours).toBe(84);
  });

  test('uptimeAvgHours es 0 cuando no hay sensores de uptime', async () => {
    mockGetSensors.mockResolvedValue([{
      objid: 301, name: 'CPU', device: 'SRV01', group: 'Windows Server', probe: 'ONDRA',
      status: 'Up', status_raw: 3, lastvalue: '45 %', message: 'OK', tags: '',
    }]);
    mockGetChannels.mockResolvedValue([]);
    mockGetHistoric.mockResolvedValue([]);

    const result = await getWindowsDashboard('ONDRA');
    expect(result.uptimeAvgHours).toBe(0);
  });
});

describe('SucursalesDashboard sparklines', () => {
  beforeEach(() => { jest.clearAllMocks(); invalidateCache('sucursales:ONDRA'); });

  test('incluye sparklines con objid y values de latencia por sucursal', async () => {
    mockGetSensors.mockResolvedValue([
      { objid: 500, name: 'Ping', device: 'Sucursal Centro', group: 'Sucursales', probe: 'ONDRA',
        status: 'Up', status_raw: 3, lastvalue: '12 ms', message: 'OK', tags: '' },
    ]);
    mockGetHistoric.mockResolvedValue([
      { datetime: '...', 'value_raw (Ping Time)': 10 },
      { datetime: '...', 'value_raw (Ping Time)': 12 },
    ]);

    const result = await getSucursalesDashboard('ONDRA');
    expect(result.sparklines['Sucursal Centro/latency']).toEqual({
      objid: 500,
      values: [10, 12],
    });
  });

  test('sparklines es {} cuando no hay sensores', async () => {
    mockGetSensors.mockResolvedValue([]);
    const result = await getSucursalesDashboard('ONDRA');
    expect(result.sparklines).toEqual({});
  });
});
