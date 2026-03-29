// ─── Tests unitarios: transformaciones de dashboards ──────────────────────────
// Verifica las 5 funciones de transformación de sensores PRTG:
// getVmwareDashboard, getBackupsDashboard, getNetworkingDashboard,
// getWindowsDashboard, getSucursalesDashboard.
// No requiere DB real — mockea getSensorsByGroup y getSensorChannels.

import { invalidateCache } from '../utils/cache';

jest.mock('../modules/prtg/prtg.client', () => ({
  getSensorsByGroup: jest.fn(),
  getSensorChannels: jest.fn(),
  getHistoricData: jest.fn().mockResolvedValue([]),
}));

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
    db:      { host: 'localhost', port: 5432, name: 'test', user: 'test', password: 'test' },
    jwt:     { accessSecret: 'x', refreshSecret: 'x', accessExpiresIn: '5h', refreshExpiresIn: '7d' },
    port:    3000,
    nodeEnv: 'test',
    isDev:   false,
    corsOrigin: '',
    cookie:  { domain: 'localhost', secure: false },
  },
}));

import { getSensorsByGroup, getSensorChannels } from '../modules/prtg/prtg.client';
import {
  getVmwareDashboard,
  getBackupsDashboard,
  getNetworkingDashboard,
  getWindowsDashboard,
  getSucursalesDashboard,
} from '../modules/dashboards/dashboards.service';

const mockGetSensors  = getSensorsByGroup as jest.MockedFunction<typeof getSensorsByGroup>;
const mockGetChannels = getSensorChannels as jest.MockedFunction<typeof getSensorChannels>;

const GROUP = 'TESTGROUP';

function makeSensor(fields: {
  name?:       string;
  device?:     string;
  group?:      string;
  probe?:      string;
  status_raw?: number;
  lastvalue?:  string;
  message?:    string;
  objid?:      number;
}) {
  return {
    objid:      fields.objid      ?? 1,
    name:       fields.name       ?? 'Sensor',
    device:     fields.device     ?? 'Device',
    group:      fields.group      ?? 'Servers',
    probe:      fields.probe      ?? GROUP,
    status:     'Up',
    status_raw: fields.status_raw ?? 3,
    lastvalue:  fields.lastvalue  ?? '',
    message:    fields.message    ?? 'OK',
    tags:       '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChannels.mockResolvedValue([]);
  // Limpiar el cache de cada tipo de dashboard para aislar los tests
  ['vmware', 'backups', 'networking', 'windows', 'sucursales'].forEach(k =>
    invalidateCache(`${k}:${GROUP}`)
  );
});

// ─── getVmwareDashboard ───────────────────────────────────────────────────────

describe('getVmwareDashboard', () => {

  test('filtra sensores del subgrupo "Servers" y excluye otros subgrupos', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers',    device: 'ESX01', name: 'Uptime' }),
      makeSensor({ group: 'Networking', device: 'SW01',  name: 'Ping'  }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].name).toBe('ESX01');
  });

  test('host.uptime toma el lastvalue del sensor nombrado "Uptime"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Uptime', lastvalue: '15 days 3 hours' }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    expect(result.hosts[0].uptime).toBe('15 days 3 hours');
  });

  test('host.status refleja el peor status_raw del dispositivo', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Uptime',    status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Host Perf', status_raw: 5, objid: 2 }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    expect(result.hosts[0].status).toBe('error');
  });

  test('datastore con 4% libre (96% usado) tiene status "error"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Datastore Free: DS1', lastvalue: '4 %', status_raw: 3, objid: 10 }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    const ds = result.hosts[0].datastores[0];
    expect(ds.usedPct).toBe(96);
    expect(ds.status).toBe('error');
  });

  test('datastore con 12% libre (88% usado) tiene status "warning"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Datastore Free: DS1', lastvalue: '12 %', status_raw: 3, objid: 10 }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    const ds = result.hosts[0].datastores[0];
    expect(ds.usedPct).toBe(88);
    expect(ds.status).toBe('warning');
  });

  test('datastore name strip: elimina el prefijo "Datastore Free: "', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Datastore Free: Produccion', lastvalue: '50 %', status_raw: 3, objid: 10 }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    expect(result.hosts[0].datastores[0].name).toBe('Produccion');
  });

  test('sensores con status_raw warning/error aparecen en alerts globales', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'VM-Prod', status_raw: 5, message: 'CPU Overload', objid: 1 }),
    ]);

    const result = await getVmwareDashboard(GROUP);

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].status).toBe('error');
    expect(result.alerts[0].message).toBe('CPU Overload');
  });

  test('segunda llamada usa cache (getSensorsByGroup llamado una sola vez)', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Servers', device: 'ESX01', name: 'Uptime' }),
    ]);

    await getVmwareDashboard(GROUP);
    await getVmwareDashboard(GROUP);

    expect(mockGetSensors).toHaveBeenCalledTimes(1);
  });

});

// ─── getBackupsDashboard ──────────────────────────────────────────────────────

describe('getBackupsDashboard', () => {

  test('dispositivo "VEEAM-SERVER" tiene type "veeam"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups', device: 'VEEAM-SERVER', name: 'Job-Prod', status_raw: 3 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.devices[0].type).toBe('veeam');
  });

  test('dispositivo "QNAP-NAS01" tiene type "qnap"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups', device: 'QNAP-NAS01', name: 'Job1', status_raw: 3 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.devices[0].type).toBe('qnap');
  });

  test('successRate7d = 100 cuando todos los jobs Veeam están ok', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups', device: 'VEEAM-SRV', name: 'Job-A', status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Backups', device: 'VEEAM-SRV', name: 'Job-B', status_raw: 3, objid: 2 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.successRate7d).toBe(100);
  });

  test('successRate7d = 50 con un job ok y uno error en Veeam', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups', device: 'VEEAM-SRV', name: 'Job-OK',    status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Backups', device: 'VEEAM-SRV', name: 'Job-ERROR', status_raw: 5, objid: 2 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.successRate7d).toBe(50);
  });

  test('filtra sensores fuera del subgrupo Backups', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups',    device: 'VEEAM-SRV', name: 'Job1', status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Networking', device: 'SW01',       name: 'Ping', status_raw: 3, objid: 2 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].name).toBe('VEEAM-SRV');
  });

  test('job con status warning aparece en alerts del device', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups', device: 'VEEAM-SRV', name: 'Job-WARN', status_raw: 4, message: 'Slow backup', objid: 1 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.devices[0].alerts).toHaveLength(1);
    expect(result.devices[0].alerts[0].status).toBe('warning');
    expect(result.devices[0].alerts[0].message).toBe('Slow backup');
  });

  test('successRate7d = 0 cuando no hay devices Veeam', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Backups', device: 'QNAP-NAS01', name: 'Job1', status_raw: 3 }),
    ]);

    const result = await getBackupsDashboard(GROUP);

    expect(result.successRate7d).toBe(0);
  });

});

// ─── getNetworkingDashboard ───────────────────────────────────────────────────

describe('getNetworkingDashboard', () => {

  test('sensores del subgrupo "Networking" van a devices', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Networking', device: 'Router01', name: 'Traffic In', status_raw: 3 }),
    ]);

    const result = await getNetworkingDashboard(GROUP);

    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].name).toBe('Router01');
    expect(result.switches).toHaveLength(0);
    expect(result.ptpAntennas).toHaveLength(0);
  });

  test('sensores del subgrupo "Switches" (hoja) van a switches', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Networking > Switches', device: 'SW-CORE', name: 'Port 1', status_raw: 3 }),
    ]);

    const result = await getNetworkingDashboard(GROUP);

    expect(result.switches).toHaveLength(1);
    expect(result.switches[0].name).toBe('SW-CORE');
    expect(result.devices).toHaveLength(0);
  });

  test('sensores del subgrupo "Antenas PTP" (hoja) van a ptpAntennas', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Networking > Antenas PTP', device: 'Antena-01', name: 'Throughput', status_raw: 3 }),
    ]);

    const result = await getNetworkingDashboard(GROUP);

    expect(result.ptpAntennas).toHaveLength(1);
    expect(result.ptpAntennas[0].name).toBe('Antena-01');
  });

  test('un sensor error eleva device.status a "error" aunque otros estén ok', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Networking', device: 'Router01', name: 'Ping',       status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Networking', device: 'Router01', name: 'Traffic In', status_raw: 5, objid: 2 }),
    ]);

    const result = await getNetworkingDashboard(GROUP);

    expect(result.devices[0].status).toBe('error');
  });

  test('sensores en error generan alertas globales con status correcto', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Networking', device: 'Router01', name: 'Ping', status_raw: 5, message: 'Timeout', objid: 1 }),
    ]);

    const result = await getNetworkingDashboard(GROUP);

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].status).toBe('error');
    expect(result.alerts[0].message).toBe('Timeout');
  });

});

// ─── getWindowsDashboard ──────────────────────────────────────────────────────

describe('getWindowsDashboard', () => {

  test('sensor "CPU Load" asignado a server.cpu con su lastvalue', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'CPU Load', lastvalue: '45 %', status_raw: 3 }),
    ]);

    const result = await getWindowsDashboard(GROUP);

    expect(result.servers[0].cpu.value).toBe('45 %');
    expect(result.servers[0].cpu.status).toBe('ok');
  });

  test('sensor "Memory" convierte "% libre" a "% usado" (memFreeToUsed)', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'Memory', lastvalue: '20 %', status_raw: 3 }),
    ]);

    const result = await getWindowsDashboard(GROUP);

    expect(result.servers[0].memory.value).toBe('80 %');
  });

  test('servidor sin sensor CPU tiene cpu placeholder {value: "N/A", status: "unknown"}', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'System Uptime', lastvalue: '30 days', status_raw: 3 }),
    ]);

    const result = await getWindowsDashboard(GROUP);

    expect(result.servers[0].cpu.value).toBe('N/A');
    expect(result.servers[0].cpu.status).toBe('unknown');
  });

  test('sensor "Disk Free Space" asignado a server.disk', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'Disk Free Space C:', lastvalue: '60 %', status_raw: 3, objid: 10 }),
    ]);

    const result = await getWindowsDashboard(GROUP);

    expect(result.servers[0].disk.value).toBe('40 %');  // 60 % libre → 40 % usado
    expect(result.servers[0].disk.status).toBe('ok');
  });

  test('server.status refleja el peor status_raw de sus sensores', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'CPU Load', status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'Memory',   status_raw: 4, objid: 2 }),
    ]);

    const result = await getWindowsDashboard(GROUP);

    expect(result.servers[0].status).toBe('warning');
  });

  test('sensores error/warning generan alerts con formato "device — name"', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Windows Server', device: 'SRV01', name: 'CPU Load', status_raw: 5, message: 'CPU critical', objid: 1 }),
    ]);

    const result = await getWindowsDashboard(GROUP);

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].name).toBe('SRV01 — CPU Load');
    expect(result.alerts[0].status).toBe('error');
  });

});

// ─── getSucursalesDashboard ───────────────────────────────────────────────────

describe('getSucursalesDashboard', () => {

  test('sucursal ok expone latencia del sensor Ping', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Sucursales', device: 'Sucursal-A', name: 'Ping', lastvalue: '5 ms', status_raw: 3 }),
    ]);

    const result = await getSucursalesDashboard(GROUP);

    expect(result.sucursales[0].status).toBe('ok');
    expect(result.sucursales[0].latency).toBe('5 ms');
  });

  test('sucursal error tiene latencia null', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Sucursales', device: 'Sucursal-B', name: 'Ping', lastvalue: '0 ms', status_raw: 5 }),
    ]);

    const result = await getSucursalesDashboard(GROUP);

    expect(result.sucursales[0].status).toBe('error');
    expect(result.sucursales[0].latency).toBeNull();
  });

  test('calcula onlineCount y offlineCount correctamente', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Sucursales', device: 'S-OK',      name: 'Ping', status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Sucursales', device: 'S-ERR',     name: 'Ping', status_raw: 5, objid: 2 }),
      makeSensor({ group: 'Sucursales', device: 'S-UNKNOWN', name: 'Ping', status_raw: 0, objid: 3 }),
    ]);

    const result = await getSucursalesDashboard(GROUP);

    expect(result.onlineCount).toBe(1);
    expect(result.offlineCount).toBe(2); // error + unknown
  });

  test('ordena sucursales: error antes que ok', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Sucursales', device: 'S-OK',  name: 'Ping', status_raw: 3, objid: 1 }),
      makeSensor({ group: 'Sucursales', device: 'S-ERR', name: 'Ping', status_raw: 5, objid: 2 }),
    ]);

    const result = await getSucursalesDashboard(GROUP);

    expect(result.sucursales[0].name).toBe('S-ERR');
    expect(result.sucursales[1].name).toBe('S-OK');
  });

  test('elimina etiquetas HTML del campo message', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Sucursales', device: 'S-A', name: 'Ping', status_raw: 5, message: '<b>No route</b> to host', objid: 1 }),
    ]);

    const result = await getSucursalesDashboard(GROUP);

    expect(result.sucursales[0].message).toBe('No route to host');
  });

  test('sensor fuera del subgrupo "Sucursales" es excluido', async () => {
    mockGetSensors.mockResolvedValue([
      makeSensor({ group: 'Networking', device: 'SW-01', name: 'Ping', status_raw: 3, objid: 1 }),
    ]);

    const result = await getSucursalesDashboard(GROUP);

    expect(result.sucursales).toHaveLength(0);
    expect(result.onlineCount).toBe(0);
    expect(result.offlineCount).toBe(0);
  });

});
