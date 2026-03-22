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
