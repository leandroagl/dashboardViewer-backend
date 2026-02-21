// ─── Servicio de Dashboards ───────────────────────────────────────────────────
import {
  PrtgSensor,
  PrtgChannel,
  getSensorsByGroup,
  getSensorChannels,
} from "../prtg/prtg.client";
import { logger } from "../../utils/logger";
import { getCached, setCache } from "../../utils/cache";

export type DashboardType = "servers" | "backups" | "networking" | "windows";

const CACHE_TTL_MS = 55_000;

// ─── Mapeo grupo PRTG → dashboard ────────────────────────────────────────────
const GROUP_MAP: { pattern: RegExp; type: DashboardType }[] = [
  { pattern: /^servers?$/i,                          type: "servers"    },
  { pattern: /^(backups?|veeam)$/i,                  type: "backups"    },
  { pattern: /^(networking|network|mikrotik)$/i,     type: "networking" },
  { pattern: /^(windows?\s*server|windows|wmi)$/i,   type: "windows"    },
];

function groupNameToDashboard(groupName: string): DashboardType | null {
  const name = groupName.trim();
  for (const { pattern, type } of GROUP_MAP) {
    if (pattern.test(name)) return type;
  }
  return null;
}

// ─── Detección automática de dashboards disponibles ──────────────────────────
export async function getAvailableDashboards(prtgGroup: string): Promise<DashboardType[]> {
  const cacheKey = `available:${prtgGroup}`;
  const cached = getCached<DashboardType[]>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const sensors = await getSensorsByGroup(prtgGroup);
  const subgroups = [...new Set(sensors.map((s) => s.group).filter(Boolean))];
  logger.debug("PRTG subgroups found", { prtgGroup, subgroups });

  const available: DashboardType[] = [];
  for (const subgroup of subgroups) {
    const parts = subgroup.split(">").map((p) => p.trim());
    const leafGroup = parts[parts.length - 1];
    const type = groupNameToDashboard(leafGroup);
    if (type && !available.includes(type)) available.push(type);
  }

  const order: DashboardType[] = ["servers", "backups", "networking", "windows"];
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

// ─── Dashboard: Servidores VMware ─────────────────────────────────────────────
export interface VmwareHost {
  name:       string;
  status:     SensorStatus;
  uptime:     string;
  cpu:        { value: string; pct: number; status: SensorStatus };
  memory:     { value: string; pct: number; status: SensorStatus };
  vms:        { name: string; cpuPct: number; status: SensorStatus }[];
  datastores: { name: string; freePct: number; usedPct: number; status: SensorStatus }[];
  alerts:     { name: string; message: string; status: SensorStatus }[];
}

export interface VmwareDashboard {
  hosts:  VmwareHost[];
  alerts: { name: string; message: string; status: SensorStatus }[];
}

export async function getVmwareDashboard(prtgGroup: string): Promise<VmwareDashboard> {
  const cacheKey = `vmware:${prtgGroup}`;
  const cached = getCached<VmwareDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) { logger.debug('VMware dashboard (cache hit)', { prtgGroup }); return cached; }

  const all     = await getSensorsByGroup(prtgGroup);
  const sensors = filterBySubgroup(all, "servers");

  logger.debug("VMware sensors", {
    count:   sensors.length,
    devices: [...new Set(sensors.map((s) => s.device))],
  });

  const deviceMap = new Map<string, PrtgSensor[]>();
  for (const s of sensors) {
    const key = s.device || s.name;
    if (!deviceMap.has(key)) deviceMap.set(key, []);
    deviceMap.get(key)!.push(s);
  }

  const parseLastValue = (val: string): number =>
    parseFloat(val.replace(",", ".").replace(/[^0-9.]/g, "")) || 0;

  const deviceEntries = [...deviceMap.entries()];

  // Obtener canales de todos los hosts en paralelo (evita N+1 calls secuenciales)
  const channelResults = await Promise.all(
    deviceEntries.map(([, deviceSensors]) => {
      const hostPerfSensor = deviceSensors.find((s) => /^host\s*performance$/i.test(s.name.trim()));
      return hostPerfSensor
        ? getSensorChannels(hostPerfSensor.objid).catch(() => null)
        : Promise.resolve(null);
    })
  );

  const hosts: VmwareHost[] = deviceEntries.map(([device, deviceSensors], i) => {
    const uptimeSensor     = deviceSensors.find((s) => /^uptime$/i.test(s.name.trim()));
    const datastoreSensors = deviceSensors.filter((s) => /datastore\s*free/i.test(s.name));
    const hostPerfSensor   = deviceSensors.find((s) => /^host\s*performance$/i.test(s.name.trim()));
    const channels         = channelResults[i];

    let cpuPct = 0, cpuValue = 'N/A', cpuStatus: SensorStatus = 'unknown';
    let memPct = 0, memValue = 'N/A', memStatus: SensorStatus = 'unknown';

    if (hostPerfSensor) {
      if (channels) {
        const cpuCh = channels.find(c => /^cpu usage$/i.test(c.name));
        const memCh = channels.find(c => /^memory consumed/i.test(c.name));

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
        logger.debug('Host Performance channels', { device, cpuPct, memPct });
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

    const worstStatus = deviceSensors.length > 0
      ? Math.max(...deviceSensors.map((s) => s.status_raw))
      : 3;

    const vms = vmSensors.map((s) => ({
      name:   s.name,
      cpuPct: parseLastValue(s.lastvalue),
      status: normalizePrtgStatus(s.status_raw),
    }));

    const datastores = datastoreSensors.map((s) => {
      const freePct    = parseLastValue(s.lastvalue);
      const usedPct    = Math.max(0, 100 - freePct);
      const autoStatus: SensorStatus = usedPct > 95 ? "error" : usedPct > 85 ? "warning" : normalizePrtgStatus(s.status_raw);
      return {
        name:    s.name.replace(/datastore\s*free:\s*/i, "").trim(),
        freePct: Math.round(freePct * 10) / 10,
        usedPct: Math.round(usedPct * 10) / 10,
        status:  autoStatus,
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
      vms,
      datastores,
      alerts:     hostAlerts,
    };
  });

  const allAlerts = sensors
    .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
    .map((s) => ({ name: `${s.device} — ${s.name}`, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  const result: VmwareDashboard = { hosts, alerts: allAlerts };
  setCache(cacheKey, result);
  return result;
}

// ─── Dashboard: Backups ───────────────────────────────────────────────────────
export interface BackupJob {
  name:        string;
  lastStatus:  SensorStatus;
  lastMessage: string;
  lastValue:   string;
}

export interface BackupDevice {
  name:    string;
  type:    'veeam' | 'qnap' | 'other';
  status:  SensorStatus;
  jobs:    BackupJob[];
  alerts:  { name: string; message: string }[];
}

export interface BackupsDashboard {
  successRate7d: number;
  devices:       BackupDevice[];
  alerts:        { name: string; message: string }[];
}

export async function getBackupsDashboard(prtgGroup: string): Promise<BackupsDashboard> {
  const cacheKey = `backups:${prtgGroup}`;
  const cached = getCached<BackupsDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) { logger.debug('Backups dashboard (cache hit)', { prtgGroup }); return cached; }

  const all     = await getSensorsByGroup(prtgGroup);
  const sensors = filterBySubgroup(all, "backups");

  logger.debug("Backup sensors", {
    count:   sensors.length,
    devices: [...new Set(sensors.map(s => s.device))],
  });

  // Agrupar sensores por dispositivo
  const deviceMap = new Map<string, PrtgSensor[]>();
  for (const s of sensors) {
    const key = s.device || s.name;
    if (!deviceMap.has(key)) deviceMap.set(key, []);
    deviceMap.get(key)!.push(s);
  }

  const devices: BackupDevice[] = [];

  for (const [deviceName, deviceSensors] of deviceMap) {
    const type: BackupDevice['type'] = /qnap/i.test(deviceName) ? 'qnap'
      : /veeam/i.test(deviceName) ? 'veeam' : 'other';

    const jobs: BackupJob[] = deviceSensors.map(s => ({
      name:        s.name,
      lastStatus:  normalizePrtgStatus(s.status_raw),
      lastMessage: s.message,
      lastValue:   s.lastvalue,
    }));

    const worstRaw = Math.max(...deviceSensors.map(s => s.status_raw));
    const alerts   = jobs
      .filter(j => j.lastStatus === 'error' || j.lastStatus === 'warning')
      .map(j => ({ name: j.name, message: j.lastMessage }));

    devices.push({ name: deviceName, type, status: normalizePrtgStatus(worstRaw), jobs, alerts });
  }

  // Tasa de éxito global solo sobre jobs de Veeam
  const veeamJobs = devices.filter(d => d.type === 'veeam').flatMap(d => d.jobs);
  const okCount   = veeamJobs.filter(j => j.lastStatus === 'ok').length;
  const successRate7d = veeamJobs.length > 0 ? Math.round((okCount / veeamJobs.length) * 100) : 0;

  const allAlerts = devices.flatMap(d => d.alerts);

  const result: BackupsDashboard = { successRate7d, devices, alerts: allAlerts };
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
  devices: NetworkDevice[];
  alerts:  { name: string; message: string; status: SensorStatus }[];
}

export async function getNetworkingDashboard(prtgGroup: string): Promise<NetworkingDashboard> {
  const cacheKey = `networking:${prtgGroup}`;
  const cached = getCached<NetworkingDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) { logger.debug('Networking dashboard (cache hit)', { prtgGroup }); return cached; }

  const all     = await getSensorsByGroup(prtgGroup);
  const sensors = filterBySubgroup(all, "networking");

  logger.debug("Networking sensors", {
    count:   sensors.length,
    devices: [...new Set(sensors.map((s) => s.device))],
  });

  const deviceMap = new Map<string, NetworkDevice>();

  for (const sensor of sensors) {
    const deviceName = sensor.device || sensor.name;
    if (!deviceMap.has(deviceName)) {
      deviceMap.set(deviceName, { name: deviceName, status: "ok", sensors: [] });
    }
    const device = deviceMap.get(deviceName)!;
    device.sensors.push({
      name:   sensor.name,
      value:  sensor.lastvalue,
      status: normalizePrtgStatus(sensor.status_raw),
    });
    const sensorStatus = normalizePrtgStatus(sensor.status_raw);
    if (sensorStatus === "error") device.status = "error";
    else if (sensorStatus === "warning" && device.status !== "error") device.status = "warning";
  }

  const alerts = sensors
    .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
    .map((s) => ({ name: s.name, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  const result: NetworkingDashboard = { devices: [...deviceMap.values()], alerts };
  setCache(cacheKey, result);
  return result;
}

// ─── Dashboard: Windows Server ────────────────────────────────────────────────
export interface WindowsServer {
  name:   string;
  status: SensorStatus;
  cpu:    { value: string; status: SensorStatus };
  memory: { value: string; status: SensorStatus };
  disk:   { value: string; status: SensorStatus };
  uptime: { value: string; status: SensorStatus };
}

export interface WindowsDashboard {
  servers: WindowsServer[];
  alerts:  { name: string; message: string; status: SensorStatus }[];
}

export async function getWindowsDashboard(prtgGroup: string): Promise<WindowsDashboard> {
  const cacheKey = `windows:${prtgGroup}`;
  const cached = getCached<WindowsDashboard>(cacheKey, CACHE_TTL_MS);
  if (cached) { logger.debug('Windows dashboard (cache hit)', { prtgGroup }); return cached; }

  const all     = await getSensorsByGroup(prtgGroup);
  const sensors = filterBySubgroup(all, "windows");

  logger.debug("Windows sensors", {
    count:   sensors.length,
    devices: [...new Set(sensors.map((s) => s.device))],
  });

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

  const servers: WindowsServer[] = [...serverMap.entries()].map(([name, data]) => ({
    name,
    status: normalizePrtgStatus(data.worstStatus),
    cpu:    data.cpu    ? { value: data.cpu.lastvalue,    status: normalizePrtgStatus(data.cpu.status_raw)    } : placeholder(),
    memory: data.memory ? { value: data.memory.lastvalue, status: normalizePrtgStatus(data.memory.status_raw) } : placeholder(),
    disk:   data.disk   ? { value: data.disk.lastvalue,   status: normalizePrtgStatus(data.disk.status_raw)   } : placeholder(),
    uptime: data.uptime ? { value: data.uptime.lastvalue, status: normalizePrtgStatus(data.uptime.status_raw) } : placeholder(),
  }));

  const alerts = sensors
    .filter((s) => [4, 5, 13, 14].includes(s.status_raw))
    .map((s) => ({ name: s.name, message: s.message, status: normalizePrtgStatus(s.status_raw) }));

  const result: WindowsDashboard = { servers, alerts };
  setCache(cacheKey, result);
  return result;
}