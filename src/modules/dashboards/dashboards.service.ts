// ─── Servicio de Dashboards ───────────────────────────────────────────────────
import {
  PrtgSensor,
  PrtgChannel,
  PrtgHistoricPoint,
  HistoryRange,
  RANGE_CONFIG,
  getSensorsByGroup,
  getSensorChannels,
  getHistoricData,
  getSensorDetail,
} from "../prtg/prtg.client";
import { logger } from "../../utils/logger";
import { getCached, setCache } from "../../utils/cache";

export type DashboardType = "servers" | "backups" | "networking" | "windows" | "sucursales";

const CACHE_TTL_MS = 55_000;

// Último "Last Job Run" conocido por sensor — persiste entre ciclos de cache
// para evitar mostrar "—" en los ciclos donde PRTG rechaza temporalmente el acceso a canales.
// Se almacena con timestamp para poder expirar entradas y evitar crecimiento indefinido.
const LAST_JOB_RUN_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const lastKnownJobRun = new Map<number, { value: string; updatedAt: number }>();

function setLastJobRun(sensorId: number, value: string): void {
  // Eliminar entradas expiradas antes de agregar la nueva
  const cutoff = Date.now() - LAST_JOB_RUN_TTL_MS;
  for (const [id, entry] of lastKnownJobRun) {
    if (entry.updatedAt < cutoff) lastKnownJobRun.delete(id);
  }
  lastKnownJobRun.set(sensorId, { value, updatedAt: Date.now() });
}

function getLastJobRun(sensorId: number): string | undefined {
  const entry = lastKnownJobRun.get(sensorId);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > LAST_JOB_RUN_TTL_MS) {
    lastKnownJobRun.delete(sensorId);
    return undefined;
  }
  return entry.value;
}

// ─── Mapeo grupo PRTG → dashboard ────────────────────────────────────────────
const GROUP_MAP: { pattern: RegExp; type: DashboardType }[] = [
  { pattern: /^servers?$/i,                          type: "servers"    },
  { pattern: /^(backups?|veeam)$/i,                  type: "backups"    },
  { pattern: /^(networking|network|mikrotik)$/i,     type: "networking" },
  { pattern: /^(windows?\s*server|windows|wmi)$/i,   type: "windows"    },
  { pattern: /^sucursales?$/i,                       type: "sucursales" },
];

function groupNameToDashboard(groupName: string): DashboardType | null {
  const name = groupName.trim();
  for (const { pattern, type } of GROUP_MAP) {
    if (pattern.test(name)) return type;
  }
  return null;
}

// ─── Detección automática de dashboards disponibles ──────────────────────────
export async function getAvailableDashboards(prtgGroup: string, extraProbes: string[] = []): Promise<DashboardType[]> {
  const cacheKey = `available:${[prtgGroup, ...extraProbes].sort().join(",")}`;
  const cached = getCached<DashboardType[]>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const sensors = await getSensorsByGroup(prtgGroup, extraProbes);
  const subgroups = [...new Set(sensors.map((s) => s.group).filter(Boolean))];

  const available: DashboardType[] = [];
  for (const subgroup of subgroups) {
    const parts = subgroup.split(">").map((p) => p.trim());
    const leafGroup = parts[parts.length - 1];
    const type = groupNameToDashboard(leafGroup);
    if (type && !available.includes(type)) available.push(type);
  }

  const order: DashboardType[] = ["servers", "backups", "networking", "windows", "sucursales"];
  const result = order.filter((t) => available.includes(t));
  setCache(cacheKey, result);
  return result;
}

// ─── Filtrado de sensores por subgrupo ───────────────────────────────────────
function filterBySubgroup(sensors: PrtgSensor[], dashboardType: DashboardType): PrtgSensor[] {
  const targetTypes = GROUP_MAP.filter((m) => m.type === dashboardType).map((m) => m.pattern);
  return sensors.filter((s) => {
    const parts = (s.group || "").split(">").map((p) => p.trim());
    const leafGroup = parts[parts.length - 1];
    return targetTypes.some((pattern) => pattern.test(leafGroup));
  });
}

// ─── Normalización de estado PRTG ────────────────────────────────────────────
type SensorStatus = "ok" | "warning" | "error" | "unusual" | "paused" | "unknown";

function normalizePrtgStatus(statusRaw: number): SensorStatus {
  switch (statusRaw) {
    case 3:  return "ok";
    case 4:  return "warning";
    case 5:
    case 13:
    case 14: return "error";
    case 11: return "unusual";
    case 7:
    case 8:
    case 9:
    case 10:
    case 12: return "paused";
    default: return "unknown";
  }
}

// ─── Conversión de bytes crudos PRTG a GB ────────────────────────────────────
// PRTG provee bytes como número en lastvalue_raw. El campo lastvalue formateado
// puede mostrar unidades incorrectas (ej. "1.860 GB" cuando son 1860 GB = 1.86 TB).
function rawBytesToGb(raw: number | undefined): number | null {
  if (!raw || raw <= 0) return null;
  return Math.round(raw / (1024 * 1024 * 1024) * 10) / 10;
}

// ─── Tipos y helpers para sparklines ─────────────────────────────────────────

export interface SparklineEntry {
  objid:  number;
  values: number[];
}

export type SparklineMap = Record<string, SparklineEntry>;

/**
 * Extrae valores numéricos de histdata PRTG para el canal que coincide
 * con channelPattern. Si no se especifica patrón, usa el primero disponible.
 * Retorna solo los valores numéricos, omitiendo puntos sin dato.
 */
// Con usecaption=1, PRTG devuelve las keys directamente como nombre de canal
// (ej. "CPU usage", "Disk read") sin prefijo "value_raw (...)".
// Excluimos "datetime" y "coverage" que son metadatos, no métricas.
const HISTDATA_SKIP_KEYS = new Set(['datetime', 'coverage']);

export function extractChannelValues(
  histdata:       PrtgHistoricPoint[],
  channelPattern: RegExp = /.*/,
): number[] {
  const values: number[] = [];
  for (const point of histdata) {
    for (const [key, val] of Object.entries(point)) {
      if (HISTDATA_SKIP_KEYS.has(key)) continue;
      if (channelPattern.test(key) && typeof val === 'number') {
        values.push(val);
        break;
      }
    }
  }
  return values;
}

// ─── Dashboard: Servidores VMware ─────────────────────────────────────────────
export interface VmwareHost {
  name:       string;
  status:     SensorStatus;
  uptime:     string;
  cpu:        { value: string; pct: number; status: SensorStatus };
  memory:     { value: string; pct: number; status: SensorStatus };
  disk:       { read: { value: string; status: SensorStatus }; write: { value: string; status: SensorStatus } };
  vms:        { name: string; status: SensorStatus }[];
  snapshots:  { name: string; value: string; status: SensorStatus }[];
  datastores: { name: string; freePct: number; usedPct: number; status: SensorStatus; freeGb: number | null; totalGb: number | null }[];
  alerts:     { name: string; message: string; status: SensorStatus }[];
}

export interface VmwareDashboard {
  hosts:      VmwareHost[];
  alerts:     { name: string; message: string; status: SensorStatus }[];
  sparklines: SparklineMap; // keys: "<hostname>/cpu", "/ram", "/diskR", "/diskW", "/datastore"
}

export async function getVmwareDashboard(prtgGroup: string, extraProbes: string[] = []): Promise<VmwareDashboard> {
  const cacheKey = `vmware:${[prtgGroup, ...extraProbes].sort().join(",")}`;
  const cached = getCached<VmwareDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const all     = await getSensorsByGroup(prtgGroup, extraProbes);
  const sensors = filterBySubgroup(all, "servers");

  const deviceMap = new Map<string, PrtgSensor[]>();
  for (const s of sensors) {
    const key = s.device || s.name;
    if (!deviceMap.has(key)) deviceMap.set(key, []);
    deviceMap.get(key)!.push(s);
  }

  const parseLastValue = (val: string): number =>
    parseFloat(val.replace(",", ".").replace(/[^0-9.]/g, "")) || 0;

  const deviceEntries = [...deviceMap.entries()];

  // Identificar sensores que necesitan canales: Host Performance + Datastores
  const hostPerfSensors    = deviceEntries.map(([, ds]) =>
    ds.find(s => /^host\s*performance$/i.test(s.name.trim())) ?? null
  );
  const allDatastoreSensors = deviceEntries.flatMap(([, ds]) =>
    ds.filter(s => /datastore\s*free/i.test(s.name))
  );

  // Fetch de todos los canales e históricos en paralelo (un solo batch)
  const [hostPerfChannelResults, dsChannelResults, hostPerfSparklineResults, dsSparklineResults] = await Promise.all([
    Promise.all(hostPerfSensors.map(s =>
      s ? getSensorChannels(s.objid).catch(() => null) : Promise.resolve(null)
    )),
    Promise.all(allDatastoreSensors.map(s =>
      getSensorChannels(s.objid).catch(() => null)
    )),
    Promise.all(hostPerfSensors.map(s =>
      s ? getHistoricData(s.objid, '24h').catch(() => [] as PrtgHistoricPoint[]) : Promise.resolve([] as PrtgHistoricPoint[])
    )),
    Promise.all(allDatastoreSensors.map(s =>
      getHistoricData(s.objid, '24h').catch(() => [] as PrtgHistoricPoint[])
    )),
  ]);

  const dsSparklineById = new Map<number, PrtgHistoricPoint[]>();
  allDatastoreSensors.forEach((s, i) => dsSparklineById.set(s.objid, dsSparklineResults[i]));

  // Mapa de canales de datastore por objid
  const dsChannelsById = new Map<number, PrtgChannel[] | null>();
  allDatastoreSensors.forEach((s, i) => dsChannelsById.set(s.objid, dsChannelResults[i]));

  const hosts: VmwareHost[] = deviceEntries.map(([device, deviceSensors], i) => {
    const uptimeSensor     = deviceSensors.find((s) => /^uptime$/i.test(s.name.trim()));
    const datastoreSensors = deviceSensors.filter((s) => /datastore\s*free/i.test(s.name));
    const hostPerfSensor   = deviceSensors.find((s) => /^host\s*performance$/i.test(s.name.trim()));
    const channels         = hostPerfChannelResults[i];

    let cpuPct = 0, cpuValue = 'N/A', cpuStatus: SensorStatus = 'unknown';
    let memPct = 0, memValue = 'N/A', memStatus: SensorStatus = 'unknown';
    let diskReadValue = 'N/A', diskReadStatus: SensorStatus = 'unknown';
    let diskWriteValue = 'N/A', diskWriteStatus: SensorStatus = 'unknown';

    if (hostPerfSensor) {
      if (channels) {
        const cpuCh       = channels.find(c => /^cpu usage$/i.test(c.name));
        const memCh       = channels.find(c => /^memory consumed/i.test(c.name));
        const diskReadCh  = channels.find(c => /disk.*read|read.*rate/i.test(c.name));
        const diskWriteCh = channels.find(c => /disk.*write|write.*rate/i.test(c.name));

        if (cpuCh) {
          cpuPct    = parseLastValue(cpuCh.lastvalue);
          cpuValue  = cpuCh.lastvalue;
          cpuStatus = cpuPct > 90 ? 'error' : cpuPct > 75 ? 'warning' : 'ok';
        }
        if (memCh) {
          memPct    = parseLastValue(memCh.lastvalue);
          memValue  = memCh.lastvalue;
          memStatus = memPct > 95 ? 'error' : memPct > 85 ? 'warning' : 'ok';
        }
        if (diskReadCh) {
          diskReadValue  = diskReadCh.lastvalue;
          diskReadStatus = normalizePrtgStatus(hostPerfSensor.status_raw);
        }
        if (diskWriteCh) {
          diskWriteValue  = diskWriteCh.lastvalue;
          diskWriteStatus = normalizePrtgStatus(hostPerfSensor.status_raw);
        }
      } else {
        // Fallback: extraer desde el mensaje del sensor si el canal falló
        const msg    = (hostPerfSensor.message ?? '').replace(/<[^>]+>/g, '').trim();
        const cpuVal = parseLastValue(hostPerfSensor.lastvalue);
        if (cpuVal > 0) { cpuPct = cpuVal; cpuValue = hostPerfSensor.lastvalue; cpuStatus = normalizePrtgStatus(hostPerfSensor.status_raw); }
        const memMatch = msg.match(/([\d,\.]+)\s*%.*[Mm]em/);
        if (memMatch) { memPct = parseLastValue(memMatch[1]); memValue = memMatch[1].replace(',', '.') + ' %'; memStatus = normalizePrtgStatus(hostPerfSensor.status_raw); }
        logger.warn('Fallback a message para Host Performance', { device });
      }
    }

    const vmSensors = deviceSensors.filter((s) =>
      !/datastore|uptime|snapshot|traffic|switch|vmk|host\s*performance/i.test(s.name)
    );

    const snapshots = deviceSensors
      .filter(s => /snapshot/i.test(s.name))
      .map(s => ({
        name:   s.name.replace(/^vmware\s*/i, '').trim(),
        value:  s.lastvalue,
        status: normalizePrtgStatus(s.status_raw),
      }));

    const worstStatus = deviceSensors.length > 0
      ? Math.max(...deviceSensors.map((s) => s.status_raw))
      : 3;

    const vms = vmSensors.map((s) => ({
      name:   s.name,
      status: normalizePrtgStatus(s.status_raw),
    }));

    const datastores = datastoreSensors.map((s) => {
      const freePct    = parseLastValue(s.lastvalue);
      const usedPct    = Math.max(0, 100 - freePct);
      const autoStatus: SensorStatus = usedPct > 95 ? "error" : usedPct > 85 ? "warning" : normalizePrtgStatus(s.status_raw);
      const dsChannels  = dsChannelsById.get(s.objid);
      const freeGb      = rawBytesToGb(dsChannels?.find(c => /^free.?bytes$/i.test(c.name))?.lastvalue_raw);
      const totalGb     = rawBytesToGb(dsChannels?.find(c => /^available.?capacity$/i.test(c.name))?.lastvalue_raw);
      return {
        name:    s.name.replace(/datastore\s*free:\s*/i, "").trim(),
        freePct: Math.round(freePct * 10) / 10,
        usedPct: Math.round(usedPct * 10) / 10,
        status:  autoStatus,
        freeGb,
        totalGb,
      };
    });

    const hostAlerts = deviceSensors
      .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
      .map((s) => ({ name: s.name, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

    return {
      name:       device,
      status:     normalizePrtgStatus(worstStatus),
      uptime:     uptimeSensor?.lastvalue ?? "N/A",
      cpu:        { value: cpuValue, pct: cpuPct, status: cpuStatus },
      memory:     { value: memValue, pct: memPct, status: memStatus },
      disk:       {
        read:  { value: diskReadValue,  status: diskReadStatus  },
        write: { value: diskWriteValue, status: diskWriteStatus },
      },
      vms,
      snapshots,
      datastores,
      alerts:     hostAlerts,
    };
  });

  const allAlerts = sensors
    .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
    .map((s) => ({ name: `${s.device} — ${s.name}`, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  const sparklines: SparklineMap = {};
  deviceEntries.forEach(([device], i) => {
    const perfSensor = hostPerfSensors[i];
    if (!perfSensor) return;
    const histdata = hostPerfSparklineResults[i];
    const objid    = perfSensor.objid;
    sparklines[`${device}/cpu`]   = { objid, values: extractChannelValues(histdata, /cpu\s*usage/i).slice(-12) };
    sparklines[`${device}/ram`]   = { objid, values: extractChannelValues(histdata, /memory\s*consum/i).slice(-12) };
    sparklines[`${device}/diskR`] = { objid, values: extractChannelValues(histdata, /disk.*read|read.*rate/i).slice(-12) };
    sparklines[`${device}/diskW`] = { objid, values: extractChannelValues(histdata, /disk.*write|write.*rate/i).slice(-12) };
  });
  allDatastoreSensors.forEach(s => {
    const histdata = dsSparklineById.get(s.objid) ?? [];
    const device   = s.device || s.name;
    sparklines[`${device}/datastore`] = { objid: s.objid, values: extractChannelValues(histdata).slice(-12) };
  });

  const result: VmwareDashboard = { hosts, alerts: allAlerts, sparklines };
  setCache(cacheKey, result);
  return result;
}

// ─── Dashboard: Backups ───────────────────────────────────────────────────────
export interface BackupJob {
  name:        string;
  lastStatus:  SensorStatus;
  lastMessage: string;
  lastValue:   string;
  freeGb:      number | null;
  totalGb:     number | null;
}

export interface BackupDevice {
  name:    string;
  type:    'veeam' | 'acronis' | 'qnap' | 'other';
  status:  SensorStatus;
  jobs:    BackupJob[];
  alerts:  { name: string; message: string; status: SensorStatus }[];
}

export interface BackupsDashboard {
  successRate7d: number;
  devices:       BackupDevice[];
  alerts:        { name: string; message: string; status: SensorStatus }[];
  sparklines:    SparklineMap; // keys: "<deviceName>/<jobName>" — últimos 7 resultados binarios
}

export async function getBackupsDashboard(prtgGroup: string, extraProbes: string[] = []): Promise<BackupsDashboard> {
  const cacheKey = `backups:${[prtgGroup, ...extraProbes].sort().join(",")}`;
  const cached = getCached<BackupsDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const all     = await getSensorsByGroup(prtgGroup, extraProbes);
  const sensors = filterBySubgroup(all, "backups");

  // Agrupar sensores por dispositivo
  const deviceMap = new Map<string, PrtgSensor[]>();
  for (const s of sensors) {
    const key = s.device || s.name;
    if (!deviceMap.has(key)) deviceMap.set(key, []);
    deviceMap.get(key)!.push(s);
  }

  // Fetch canales en un único batch paralelo:
  // - Sensores de disco lógico → espacio libre GB
  // - Sensores de jobs Veeam   → canal "Last Job Run" (horas desde el último backup)
  const allLogicalDiskSensors = sensors.filter(s => /logical.?disk|disk.?free/i.test(s.name));
  const veeamJobSensors       = sensors.filter(s =>
    /veeam/i.test(s.device || '') &&
    !/logical.?disk|disk.?free/i.test(s.name) &&
    !/^veeam backup job status$/i.test(s.name.trim())
  );

  const [diskChannelResults, veeamChannelResults, jobSparklineResults] = await Promise.all([
    Promise.all(allLogicalDiskSensors.map(s => getSensorChannels(s.objid).catch(() => null))),
    Promise.all(veeamJobSensors.map(s => getSensorChannels(s.objid).catch(() => null))),
    Promise.all(veeamJobSensors.map(s =>
      getHistoricData(s.objid, '7d').catch(() => [] as PrtgHistoricPoint[])
    )),
  ]);

  const jobSparklineById = new Map<number, PrtgHistoricPoint[]>();
  veeamJobSensors.forEach((s, i) => jobSparklineById.set(s.objid, jobSparklineResults[i]));

  const diskChannelsById = new Map<number, PrtgChannel[] | null>();
  allLogicalDiskSensors.forEach((s, i) => diskChannelsById.set(s.objid, diskChannelResults[i]));

  const veeamChannelsById = new Map<number, PrtgChannel[] | null>();
  veeamJobSensors.forEach((s, i) => veeamChannelsById.set(s.objid, veeamChannelResults[i]));

  const devices: BackupDevice[] = [];

  for (const [deviceName, deviceSensors] of deviceMap) {
    const type: BackupDevice['type'] = /qnap/i.test(deviceName)    ? 'qnap'
      : /veeam/i.test(deviceName)    ? 'veeam'
      : /acronis/i.test(deviceName)  ? 'acronis'
      : 'other';

    const jobs: BackupJob[] = deviceSensors
      .filter(s => !/^veeam backup job status$/i.test(s.name.trim()))
      .map(s => {
        let freeGb: number | null  = null;
        let totalGb: number | null = null;
        if (/logical.?disk|disk.?free/i.test(s.name)) {
          const chs = diskChannelsById.get(s.objid);
          freeGb    = rawBytesToGb(chs?.find(c => /^free.?bytes$/i.test(c.name))?.lastvalue_raw);
          if (freeGb != null) {
            const freePct = parseFloat(s.lastvalue) || 0;
            if (freePct > 0) totalGb = Math.round(freeGb / (freePct / 100) * 10) / 10;
          }
        }
        // Canal "Last Job Run" → horas desde el último backup (solo sensores Veeam)
        const isVeeamSensor = veeamChannelsById.has(s.objid);
        const jobChannels   = veeamChannelsById.get(s.objid);
        const lastRunValue  = jobChannels?.find(c => /last.?job.?run/i.test(c.name))?.lastvalue;
        if (lastRunValue) setLastJobRun(s.objid, lastRunValue);
        return {
          name:        s.name,
          lastStatus:  normalizePrtgStatus(s.status_raw),
          lastMessage: s.message,
          lastValue:   isVeeamSensor ? (getLastJobRun(s.objid) ?? '') : s.lastvalue,
          freeGb,
          totalGb,
        };
      });

    const worstRaw = Math.max(...deviceSensors.map(s => s.status_raw));
    const alerts   = jobs
      .filter(j => j.lastStatus === 'error' || j.lastStatus === 'warning')
      .map(j => ({ name: j.name, message: j.lastMessage, status: j.lastStatus }));

    devices.push({ name: deviceName, type, status: normalizePrtgStatus(worstRaw), jobs, alerts });
  }

  // Tasa de éxito global solo sobre jobs de Veeam
  const veeamJobs = devices.filter(d => d.type === 'veeam').flatMap(d => d.jobs);
  const okCount   = veeamJobs.filter(j => j.lastStatus === 'ok').length;
  const successRate7d = veeamJobs.length > 0 ? Math.round((okCount / veeamJobs.length) * 100) : 0;

  const allAlerts = devices.flatMap(d => d.alerts);

  const sparklines: SparklineMap = {};
  for (const device of devices) {
    for (const job of device.jobs) {
      const sensor = sensors.find(s => (s.device || s.name) === device.name && s.name === job.name);
      if (!sensor) continue;
      const histdata = jobSparklineById.get(sensor.objid) ?? [];
      sparklines[`${device.name}/${job.name}`] = {
        objid:  sensor.objid,
        values: extractChannelValues(histdata).slice(-7),
      };
    }
  }

  const result: BackupsDashboard = { successRate7d, devices, alerts: allAlerts, sparklines };
  setCache(cacheKey, result);
  return result;
}

// ─── Dashboard: Networking ────────────────────────────────────────────────────
export interface NetworkDevice {
  name:    string;
  status:  SensorStatus;
  sensors: { name: string; value: string; status: SensorStatus }[];
}

export interface NetworkingDashboard {
  devices:     NetworkDevice[];
  switches:    NetworkDevice[];
  ptpAntennas: NetworkDevice[];
  alerts:      { name: string; message: string; status: SensorStatus }[];
  sparklines:  SparklineMap; // keys: "<deviceName>/<sensorName>" — solo sensores del array devices
}

function filterByLeafGroup(sensors: PrtgSensor[], leafPattern: RegExp): PrtgSensor[] {
  return sensors.filter((s) => {
    const parts = (s.group || "").split(">").map((p) => p.trim());
    return leafPattern.test(parts[parts.length - 1]);
  });
}

function buildNetworkDevices(sensors: PrtgSensor[]): NetworkDevice[] {
  const map = new Map<string, NetworkDevice>();
  for (const s of sensors) {
    const key = s.device || s.name;
    if (!map.has(key)) map.set(key, { name: key, status: "ok", sensors: [] });
    const dev = map.get(key)!;
    dev.sensors.push({ name: s.name, value: s.lastvalue, status: normalizePrtgStatus(s.status_raw) });
    const st = normalizePrtgStatus(s.status_raw);
    if (st === "error") dev.status = "error";
    else if (st === "warning" && dev.status !== "error") dev.status = "warning";
  }
  return [...map.values()];
}

export async function getNetworkingDashboard(prtgGroup: string, extraProbes: string[] = []): Promise<NetworkingDashboard> {
  const cacheKey = `networking:${[prtgGroup, ...extraProbes].sort().join(",")}`;
  const cached = getCached<NetworkingDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const all            = await getSensorsByGroup(prtgGroup, extraProbes);
  const netSensors     = filterBySubgroup(all, "networking");
  const switchSensors  = filterByLeafGroup(all, /^switches?$/i);
  const ptpSensors     = filterByLeafGroup(all, /^antenas?\s*ptp$/i);

  const allNetSensors  = [...netSensors, ...switchSensors, ...ptpSensors];
  const alerts = allNetSensors
    .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
    .map((s) => ({ name: s.name, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  const netSparklineResults = await Promise.all(
    netSensors.map(s =>
      getHistoricData(s.objid, '24h').catch(() => [] as PrtgHistoricPoint[])
    )
  );

  const sparklines: SparklineMap = {};
  netSensors.forEach((s, i) => {
    const device = s.device || s.name;
    const key    = `${device}/${s.name}`;
    sparklines[key] = {
      objid:  s.objid,
      values: extractChannelValues(netSparklineResults[i]).slice(-12),
    };
  });

  const result: NetworkingDashboard = {
    devices:     buildNetworkDevices(netSensors),
    switches:    buildNetworkDevices(switchSensors),
    ptpAntennas: buildNetworkDevices(ptpSensors),
    alerts,
    sparklines,
  };
  setCache(cacheKey, result);
  return result;
}

/**
 * Parsea el string de uptime de PRTG a horas numéricas.
 * Formatos soportados: "5 d 3 h 15 min", "127 h", "3 d", "N/A".
 */
function parseUptimeHours(val: string): number {
  let hours = 0;
  const days = val.match(/(\d+(?:\.\d+)?)\s*d/i);
  const hrs  = val.match(/(\d+(?:\.\d+)?)\s*h/i);
  if (days) hours += parseFloat(days[1]) * 24;
  if (hrs)  hours += parseFloat(hrs[1]);
  return hours;
}

// ─── Dashboard: Windows Server ────────────────────────────────────────────────
export interface WindowsServer {
  name:   string;
  status: SensorStatus;
  cpu:    { value: string; status: SensorStatus };
  memory: { value: string; status: SensorStatus };
  disk:   { value: string; status: SensorStatus; freeGb: number | null };
  uptime: { value: string; status: SensorStatus };
}

export interface WindowsDashboard {
  servers:        WindowsServer[];
  alerts:         { name: string; message: string; status: SensorStatus }[];
  sparklines:     SparklineMap; // keys: "<serverName>/cpu", "/ram", "/diskFree"
  uptimeAvgHours: number;      // promedio de uptime en horas entre todos los servidores
}

export async function getWindowsDashboard(prtgGroup: string, extraProbes: string[] = []): Promise<WindowsDashboard> {
  const cacheKey = `windows:${[prtgGroup, ...extraProbes].sort().join(",")}`;
  const cached = getCached<WindowsDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const all     = await getSensorsByGroup(prtgGroup, extraProbes);
  const sensors = filterBySubgroup(all, "windows");

  const serverMap = new Map<string, {
    cpu?: PrtgSensor; memory?: PrtgSensor; disk?: PrtgSensor; uptime?: PrtgSensor; worstStatus: number;
  }>();

  for (const sensor of sensors) {
    const serverName = sensor.device || sensor.name;
    if (!serverMap.has(serverName)) serverMap.set(serverName, { worstStatus: 3 });
    const srv  = serverMap.get(serverName)!;
    const name = sensor.name.toLowerCase();
    if (/cpu|processor/i.test(name))          srv.cpu    = sensor;
    if (/mem|memory|ram/i.test(name))         srv.memory = sensor;
    if (/disk|storage|free\s*space/i.test(name)) srv.disk = sensor;
    if (/uptime|availability/i.test(name))    srv.uptime = sensor;
    if (sensor.status_raw > srv.worstStatus)  srv.worstStatus = sensor.status_raw;
  }

  const placeholder = (): { value: string; status: SensorStatus } => ({ value: "N/A", status: "unknown" });

  // Fetch canales de sensores de disco en paralelo
  const diskEntries = [...serverMap.entries()].filter(([, d]) => d.disk);
  const winDiskChannelResults = await Promise.all(
    diskEntries.map(([, d]) => getSensorChannels(d.disk!.objid).catch(() => null))
  );
  const winDiskChannelsByServer = new Map<string, PrtgChannel[] | null>();
  diskEntries.forEach(([name], i) => winDiskChannelsByServer.set(name, winDiskChannelResults[i]));

  // PRTG "Memory" sensor reporta % libre → convertir a % usado para el gauge
  const parseWinFloat = (val: string): number =>
    parseFloat(val.replace(",", ".").replace(/[^0-9.]/g, "")) || 0;
  const memFreeToUsed = (val: string): string => {
    if (!val.includes("%")) return val;
    const used = Math.round((100 - parseWinFloat(val)) * 10) / 10;
    return `${used} %`;
  };

  const servers: WindowsServer[] = [...serverMap.entries()].map(([name, data]) => {
    const diskChannels = winDiskChannelsByServer.get(name);
    // Canal "Total" = suma de todos los "Free Bytes X:" → espacio libre total
    const freeGb = rawBytesToGb(diskChannels?.find(c => /^total$/i.test(c.name))?.lastvalue_raw);
    return {
      name,
      status: normalizePrtgStatus(data.worstStatus),
      cpu:    data.cpu    ? { value: data.cpu.lastvalue,                 status: normalizePrtgStatus(data.cpu.status_raw)    } : placeholder(),
      memory: data.memory ? { value: memFreeToUsed(data.memory.lastvalue), status: normalizePrtgStatus(data.memory.status_raw) } : placeholder(),
      disk:   data.disk   ? { value: data.disk.lastvalue, status: normalizePrtgStatus(data.disk.status_raw), freeGb } : { value: 'N/A', status: 'unknown' as SensorStatus, freeGb: null },
      uptime: data.uptime ? { value: data.uptime.lastvalue, status: normalizePrtgStatus(data.uptime.status_raw) } : placeholder(),
    };
  });

  const alerts = sensors
    .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
    .map((s) => ({ name: `${s.device} — ${s.name}`, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  // Sparklines: un fetch por sensor (cpu/memory/disk son sensores independientes)
  const cpuEntries  = [...serverMap.entries()].filter(([, d]) => d.cpu);
  const memEntries  = [...serverMap.entries()].filter(([, d]) => d.memory);
  const diskSEntries = [...serverMap.entries()].filter(([, d]) => d.disk);

  const [cpuSparkResults, memSparkResults, diskSparkResults] = await Promise.all([
    Promise.all(cpuEntries.map(([, d])  => getHistoricData(d.cpu!.objid,    '24h').catch(() => [] as PrtgHistoricPoint[]))),
    Promise.all(memEntries.map(([, d])  => getHistoricData(d.memory!.objid, '24h').catch(() => [] as PrtgHistoricPoint[]))),
    Promise.all(diskSEntries.map(([, d]) => getHistoricData(d.disk!.objid,   '24h').catch(() => [] as PrtgHistoricPoint[]))),
  ]);

  const sparklines: SparklineMap = {};
  cpuEntries.forEach(([name, d], i) => {
    sparklines[`${name}/cpu`] = { objid: d.cpu!.objid, values: extractChannelValues(cpuSparkResults[i]).slice(-12) };
  });
  memEntries.forEach(([name, d], i) => {
    sparklines[`${name}/ram`] = { objid: d.memory!.objid, values: extractChannelValues(memSparkResults[i]).slice(-12) };
  });
  diskSEntries.forEach(([name, d], i) => {
    sparklines[`${name}/diskFree`] = { objid: d.disk!.objid, values: extractChannelValues(diskSparkResults[i]).slice(-12) };
  });

  // uptimeAvgHours: promedio de horas de uptime de todos los servidores
  const uptimeSensors = [...serverMap.values()].filter(d => d.uptime);
  const uptimeAvgHours = uptimeSensors.length === 0 ? 0 :
    Math.round(uptimeSensors.reduce((sum, d) => sum + parseUptimeHours(d.uptime!.lastvalue), 0) / uptimeSensors.length);

  const result: WindowsDashboard = { servers, alerts, sparklines, uptimeAvgHours };
  setCache(cacheKey, result);
  return result;
}
// ─── Dashboard: Sucursales ────────────────────────────────────────────────────
export interface SucursalDevice {
  name:    string;
  status:  SensorStatus;
  latency: string | null;
  message: string;
}

export interface SucursalesDashboard {
  sucursales:   SucursalDevice[];
  onlineCount:  number;
  offlineCount: number;
  alerts:       { name: string; message: string; status: SensorStatus }[];
  sparklines:   SparklineMap; // keys: "<sucursalName>/latency"
}

export async function getSucursalesDashboard(prtgGroup: string, extraProbes: string[] = []): Promise<SucursalesDashboard> {
  const cacheKey = `sucursales:${[prtgGroup, ...extraProbes].sort().join(",")}`;
  const cached = getCached<SucursalesDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const all     = await getSensorsByGroup(prtgGroup, extraProbes);
  const sensors = filterByLeafGroup(all, /^sucursales?$/i);

  const deviceMap = new Map<string, PrtgSensor[]>();
  for (const s of sensors) {
    const key = s.device || s.name;
    if (!deviceMap.has(key)) deviceMap.set(key, []);
    deviceMap.get(key)!.push(s);
  }

  const sucursales: SucursalDevice[] = [...deviceMap.entries()].map(([name, deviceSensors]) => {
    const worstRaw   = Math.max(...deviceSensors.map(s => s.status_raw));
    const status     = normalizePrtgStatus(worstRaw);
    const pingSensor = deviceSensors.find(s => /ping/i.test(s.name)) ?? deviceSensors[0];
    const latency    = (status === 'ok' || status === 'warning') && pingSensor?.lastvalue
      ? pingSensor.lastvalue
      : null;
    const rawMessage = pingSensor?.message ?? '';
    const message    = rawMessage.replace(/<[^>]+>/g, '').trim();
    return { name, status, latency, message };
  });

  // Ordenar: offline/error primero
  const statusOrder: Record<SensorStatus, number> = {
    error: 0, unknown: 1, warning: 2, unusual: 3, paused: 4, ok: 5,
  };
  sucursales.sort((a, b) => (statusOrder[a.status] ?? 6) - (statusOrder[b.status] ?? 6));

  const onlineCount  = sucursales.filter(s => s.status === 'ok').length;
  const offlineCount = sucursales.filter(s => s.status === 'error' || s.status === 'unknown').length;

  const alerts = sensors
    .filter(s => [4, 5, 13, 14].includes(s.status_raw))
    .map(s => ({ name: s.name, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  // Sparklines de latencia: un fetch por sucursal (sensor de ping)
  const sucursalEntries = [...deviceMap.entries()];
  const sparklineResults = await Promise.all(
    sucursalEntries.map(([, deviceSensors]) => {
      const ping = deviceSensors.find(s => /ping/i.test(s.name)) ?? deviceSensors[0];
      return ping
        ? getHistoricData(ping.objid, '24h').catch(() => [] as PrtgHistoricPoint[])
        : Promise.resolve([] as PrtgHistoricPoint[]);
    })
  );

  const sparklines: SparklineMap = {};
  sucursalEntries.forEach(([name, deviceSensors], i) => {
    const ping = deviceSensors.find(s => /ping/i.test(s.name)) ?? deviceSensors[0];
    if (!ping) return;
    sparklines[`${name}/latency`] = {
      objid:  ping.objid,
      values: extractChannelValues(sparklineResults[i]).slice(-12),
    };
  });

  const result: SucursalesDashboard = { sucursales, onlineCount, offlineCount, alerts, sparklines };
  setCache(cacheKey, result);
  return result;
}

// ─── Endpoint de historial: tipos y función de servicio ───────────────────────

export interface HistoryPoint {
  datetime: string; // ISO 8601
  value:    number;
}

export interface HistoryStats {
  max:     number; avg: number; min: number;
  prevMax: number; prevAvg: number; prevMin: number;
}

export interface HistoryData {
  objid:      number;
  sensorName: string;
  range:      HistoryRange;
  points:     HistoryPoint[];
  stats:      HistoryStats;
}

/**
 * Parsea el formato de fecha PRTG "DD.MM.YYYY HH:MM:SS" a ISO 8601.
 * new Date() no puede parsear el formato de PRTG directamente en Node.js.
 */
function parsePrtgDatetime(prtgDate: string): string {
  // Format: "22.03.2026 10:00:00"
  const clean = prtgDate.replace(/\s*(AM|PM)\s*[+-]\d{4}$/i, '').trim();
  const [datePart, timePart] = clean.split(' ');
  const [day, month, year]   = datePart.split('.');
  return new Date(`${year}-${month}-${day}T${timePart ?? '00:00:00'}Z`).toISOString();
}

function computeStats(values: number[]): { max: number; avg: number; min: number } {
  if (values.length === 0) return { max: 0, avg: 0, min: 0 };
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
  return { max, avg, min };
}

const CHANNEL_PATTERNS: Record<string, RegExp> = {
  cpu:   /cpu/i,
  ram:   /memory/i,
  diskR: /disk.*read|read/i,
  diskW: /disk.*write|write/i,
};

/**
 * Obtiene datos históricos de un sensor PRTG con estadísticas del período actual
 * y del período previo (para calcular deltas en KPI cards).
 */
export async function getHistoryData(objid: number, range: HistoryRange, channel = ''): Promise<HistoryData> {
  const now     = new Date();
  const cfg     = RANGE_CONFIG[range];
  const prevEnd = new Date(now.getTime() - cfg.hours * 3_600_000);

  const [currentHistdata, prevHistdata, sensorDetail] = await Promise.all([
    getHistoricData(objid, range, now),
    getHistoricData(objid, range, prevEnd),
    getSensorDetail(objid),
  ]);

  const channelPattern = (channel && CHANNEL_PATTERNS[channel]) ? CHANNEL_PATTERNS[channel] : /.*/;

  const currentValues = extractChannelValues(currentHistdata, channelPattern);
  const prevValues    = extractChannelValues(prevHistdata, channelPattern);

  const points: HistoryPoint[] = currentHistdata
    .map(p => {
      const value = extractChannelValues([p], channelPattern)[0];
      if (value === undefined) return null;
      // PRTG datetime format is "22.03.2026 10:00:00" (German locale) — NOT parseable by new Date().
      return { datetime: parsePrtgDatetime(p.datetime as string), value };
    })
    .filter((p): p is HistoryPoint => p !== null);

  const currentStats = computeStats(currentValues);
  const prevStats    = computeStats(prevValues);

  return {
    objid,
    sensorName: sensorDetail?.name ?? `Sensor ${objid}`,
    range,
    points,
    stats: {
      max:     currentStats.max,
      avg:     currentStats.avg,
      min:     currentStats.min,
      prevMax: prevStats.max,
      prevAvg: prevStats.avg,
      prevMin: prevStats.min,
    },
  };
}
