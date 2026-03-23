// ─── Cliente HTTP para la API de PRTG ────────────────────────────────────────
// Abstrae todas las llamadas a la API REST de PRTG.
// PRTG expone su API en: /api/table.json y /api/getsensordetails.json
// La autenticación se hace mediante API Token (Setup → My Account → API Token).

import https from "https";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { getCached, setCache } from "../../utils/cache";
import fetch from "node-fetch";

const CACHE_TTL_MS = 55_000; // 55 segundos

// ─── Tipos de respuesta PRTG ─────────────────────────────────────────────────

export interface PrtgSensor {
  objid:      number;
  name:       string;
  device:     string;
  group:      string;
  probe:      string;
  status:     string; // "Up", "Down", "Warning", "Unknown", "Paused", "Unusual"
  status_raw: number;
  lastvalue:  string;
  message:    string;
  tags:       string;
}

export interface PrtgTableResponse {
  sensors:  PrtgSensor[];
  treesize: number;
}

export interface PrtgSensorDetail {
  sensordata: {
    name:       string;
    statustext: string;
    lastvalue:  string;
    message:    string;
  };
}

export interface PrtgChannel {
  name:          string;
  lastvalue:     string;
  lastvalue_raw: number;
}

interface PrtgChannelResponse {
  channels: PrtgChannel[];
}

export type HistoryRange = '1h' | '24h' | '7d' | '30d';

export interface PrtgHistoricPoint {
  datetime:    string | undefined;
  [key: string]: string | number | undefined;
}

interface PrtgHistoricResponse {
  histdata?: PrtgHistoricPoint[];
}

// Exported so dashboards.service.ts can reuse it for getHistoryData
export const RANGE_CONFIG: Record<HistoryRange, { avg: number; hours: number }> = {
  '1h':  { avg: 0,     hours: 1   },
  '24h': { avg: 3600,  hours: 24  },
  '7d':  { avg: 86400, hours: 168 },
  '30d': { avg: 86400, hours: 720 },
};

function prtgDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join('-');
}

// ─── Cliente ─────────────────────────────────────────────────────────────────

// Agente HTTPS configurable: ignora certificados auto-firmados si
// PRTG_REJECT_UNAUTHORIZED=false (default para PRTG on-premise).
const httpsAgent = new https.Agent({
  rejectUnauthorized: env.prtg.rejectUnauthorized,
});

/**
 * Construye los parámetros de autenticación para la API de PRTG.
 *
 * Prioridad:
 *   1. PRTG_USERNAME + PRTG_PASSHASH  → autenticación por usuario/passhash
 *   2. PRTG_API_TOKEN                 → autenticación por API Token
 *
 * El passhash se obtiene desde PRTG en:
 *   Setup → My Account → My Settings (campo "Passhash")
 * O via API: GET /api/getpasshash.htm?username=USER&password=PASS
 */
function buildAuthParams(): URLSearchParams {
  const params = new URLSearchParams();
  if (env.prtg.username && env.prtg.passhash) {
    params.set("username", env.prtg.username);
    params.set("passhash", env.prtg.passhash);
  } else {
    params.set("apitoken", env.prtg.apiToken);
  }
  return params;
}

/**
 * Realiza una llamada GET a la API de PRTG y devuelve el JSON parseado.
 */
async function prtgGet<T>(
  endpoint: string,
  extraParams: Record<string, string> = {},
  quiet = false,
): Promise<T> {
  const params = buildAuthParams();
  params.set("output", "json");

  for (const [key, value] of Object.entries(extraParams)) {
    params.set(key, value);
  }

  const url = `${env.prtg.baseUrl}${endpoint}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  let response: Response;

  try {
    response = (await fetch(url, {
      agent:   httpsAgent,
      headers: { Accept: "application/json" },
      // node-fetch v2 no declara 'signal' en sus tipos pero lo soporta desde v2.4
      signal:  controller.signal as unknown as AbortSignal,
    })) as unknown as Response;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const error = err as { name?: string; message?: string; code?: string; cause?: { message?: string } };
    if (error?.name === 'AbortError') {
      logger.error("PRTG request timeout (>15s)", { url: url.replace(/apitoken=[^&]+/, "apitoken=***") });
      throw new Error("PRTG timeout: la solicitud tardó más de 15 segundos");
    }
    logger.error("PRTG fetch error (network/TLS)", {
      message: error?.message,
      code:    error?.code,
      cause:   error?.cause?.message,
    });
    // Sanear el mensaje antes de re-lanzar para prevenir filtración del token
    const rawMessage = error?.message ?? 'PRTG connection error';
    throw new Error(rawMessage.replace(/apitoken=[^&\s]+/gi, 'apitoken=***'));
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body      = await response.text().catch(() => "");
    const maskedUrl = url.replace(/apitoken=[^&]+/, "apitoken=***");
    // 4xx: errores de cliente — recuperables, warn (o debug si quiet=true).
    // 5xx: errores de servidor — críticos, error siempre.
    const logFn = response.status >= 500 ? logger.error : quiet ? logger.debug : logger.warn;
    logFn("PRTG HTTP error", {
      status:   response.status,
      endpoint: maskedUrl,
      body:     body.slice(0, 300),
    });
    throw new Error(`PRTG HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const logFn = quiet ? logger.debug : logger.error;
    logFn("PRTG JSON parse error", { preview: text.slice(0, 300) });
    throw new Error("PRTG devolvió una respuesta no-JSON");
  }
}

// ─── Métodos públicos del cliente ─────────────────────────────────────────────

/**
 * Obtiene todos los sensores de un grupo raíz de PRTG.
 * Los subgrupos a consultar se configuran con PRTG_SUBGROUPS.
 */
export async function getSensorsByGroup(
  groupName:   string,
  extraProbes: string[] = [],
): Promise<PrtgSensor[]> {
  const allProbes = [groupName, ...extraProbes];
  const cacheKey  = `prtg:group:${allProbes.slice().sort().join(",")}`;
  const cached = getCached<PrtgSensor[]>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const results = await Promise.all(
    env.prtg.subgroups.map((sub) =>
      prtgGet<PrtgTableResponse>("/api/table.json", {
        content:      "sensors",
        columns:      "objid,name,device,group,probe,status,status_raw,lastvalue,message,tags",
        filter_group: sub,
        count:        "2500",
      })
        .then((r) => (r.sensors ?? []).filter((s) => allProbes.includes(s.probe)))
        .catch((err: unknown) => {
          logger.warn("PRTG subgroup fetch failed", {
            sub,
            error: (err as Error).message,
          });
          return [] as PrtgSensor[];
        }),
    ),
  );

  const sensors = results.flat();

  setCache(cacheKey, sensors);
  return sensors;
}

/**
 * Obtiene el detalle de un sensor específico por su ID.
 */
export async function getSensorDetail(
  sensorId: number,
): Promise<PrtgSensorDetail["sensordata"] | null> {
  try {
    const result = await prtgGet<PrtgSensorDetail>(
      "/api/getsensordetails.json",
      { id: sensorId.toString() },
    );
    return result.sensordata ?? null;
  } catch {
    return null;
  }
}

/**
 * Obtiene sensores filtrados por tipo de tag.
 */
export async function getSensorsByTag(
  groupName: string,
  tag: string,
): Promise<PrtgSensor[]> {
  const result = await prtgGet<PrtgTableResponse>("/api/table.json", {
    content:      "sensors",
    columns:      "objid,name,device,group,status,status_raw,lastvalue,message,tags",
    filter_group: groupName,
    filter_tags:  tag,
    count:        "2500",
  });

  return result.sensors ?? [];
}

/**
 * Obtiene los canales de un sensor (CPU, memoria, etc.) por su ID.
 */
export async function getSensorChannels(
  sensorId: number,
): Promise<PrtgChannel[]> {
  // quiet=true: los 400 de sensores que no soportan channels se loguean
  // en debug (no warn). Se propaga la excepción para que los callers
  // capturen con .catch(() => null) y usen su lógica de fallback.
  const result = await prtgGet<PrtgChannelResponse>("/api/table.json", {
    output:  "json",
    content: "channels",
    columns: "name,lastvalue,lastvalue_raw",
    id:      String(sensorId),
  }, true);
  return result?.channels ?? [];
}

/**
 * Obtiene datos históricos de un sensor PRTG.
 * @param objid      ID del sensor PRTG.
 * @param range      Rango de tiempo ('1h' | '24h' | '7d' | '30d').
 * @param periodEnd  Fin del período (default: ahora). Pasar un Date anterior
 *                   para obtener el período previo (usado en cálculo de prevStats).
 */
export async function getHistoricData(
  objid:      number,
  range:      HistoryRange,
  periodEnd?: Date,
): Promise<PrtgHistoricPoint[]> {
  const cfg   = RANGE_CONFIG[range];
  const edate = periodEnd ?? new Date();
  const sdate = new Date(edate.getTime() - cfg.hours * 3_600_000);

  try {
    const result = await prtgGet<PrtgHistoricResponse>('/api/historicdata.json', {
      id:         String(objid),
      avg:        String(cfg.avg),
      sdate:      prtgDateStr(sdate),
      edate:      prtgDateStr(edate),
      usecaption: '1',
    }, true);
    return result.histdata ?? [];
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    // "no-JSON" = PRTG devolvió "Not enough monitoring data" — estado esperado para sensores nuevos
    if (msg === 'PRTG devolvió una respuesta no-JSON') {
      logger.debug("PRTG historicdata: sensor sin datos suficientes", { objid, range });
    } else {
      logger.warn("PRTG historicdata fetch failed", { objid, range, error: msg });
    }
    return [];
  }
}
