// ─── Cliente HTTP para la API de PRTG ────────────────────────────────────────
// Abstrae todas las llamadas a la API REST de PRTG.
// PRTG expone su API en: /api/table.json y /api/getsensordetails.json
// La autenticación se hace mediante API Token (Setup → My Account → API Token).

import https from "https";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import fetch from "node-fetch";

// ─── Cache simple en memoria ──────────────────────────────────────────────────
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 55_000; // 55 segundos

export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache(key: string, data: any): void {
  cache.set(key, { data, timestamp: Date.now() });
}



// ─── Tipos de respuesta PRTG ─────────────────────────────────────────────────

export interface PrtgSensor {
  objid: number;
  name: string;
  device: string;
  group: string;
  status: string; // "Up", "Down", "Warning", "Unknown", "Paused", "Unusual"
  status_raw: number;
  lastvalue: string;
  message: string;
  tags: string;
  probe: string;
}

export interface PrtgTableResponse {
  sensors: PrtgSensor[];
  treesize: number;
}

export interface PrtgSensorDetail {
  sensordata: {
    name: string;
    statustext: string;
    lastvalue: string;
    message: string;
  };
}

// ─── Cliente ─────────────────────────────────────────────────────────────────

// Agente HTTPS que ignora certificados auto-firmados (común en PRTG on-premise)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Construye los parámetros de autenticación para la API de PRTG.
 *
 * PRTG autentica mediante API Token, obtenido en:
 *   Setup → My Account → API Token → Agregar nuevo token
 * Se recomienda crear un usuario de solo lectura dedicado al portal
 * y generar el token para ese usuario específico.
 */
function buildAuthParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("apitoken", env.prtg.apiToken);
  return params;
}

/**
 * Realiza una llamada GET a la API de PRTG y devuelve el JSON parseado.
 */
async function prtgGet<T>(
  endpoint: string,
  extraParams: Record<string, string> = {},
): Promise<T> {
  const params = buildAuthParams();
  params.set("output", "json");

  for (const [key, value] of Object.entries(extraParams)) {
    params.set(key, value);
  }

  const url = `${env.prtg.baseUrl}${endpoint}?${params.toString()}`;
  logger.debug("PRTG request", {
    url: url.replace(/apitoken=[^&]+/, "apitoken=***"),
  });

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15_000);

  let response: Response;

  try {
    response = (await fetch(url, {
      agent:   httpsAgent,
      headers: { Accept: "application/json" },
      signal:  controller.signal as any,
    })) as unknown as Response;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      logger.error("PRTG request timeout (>15s)", { url: url.replace(/apitoken=[^&]+/, "apitoken=***") });
      throw new Error("PRTG timeout: la solicitud tardó más de 15 segundos");
    }
    logger.error("PRTG fetch error (network/TLS)", {
      message: err?.message,
      code:    err?.code,
      cause:   err?.cause?.message,
    });
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("PRTG HTTP error", {
      status: response.status,
      body:   body.slice(0, 300),
    });
    throw new Error(`PRTG HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    logger.error("PRTG JSON parse error", { preview: text.slice(0, 300) });
    throw new Error("PRTG devolvió una respuesta no-JSON");
  }
}



// ─── Métodos públicos del cliente ─────────────────────────────────────────────

/**
 * Obtiene todos los sensores de un grupo raíz de PRTG.
 * El grupo se identifica por su nombre exacto (prtg_group del cliente).
 */
export async function getSensorsByGroup(
  groupName: string,
): Promise<PrtgSensor[]> {
  const subgroups = ["Windows Server", "Networking", "Servers", "Backups"];
  const results = await Promise.all(
    subgroups.map((sub) =>
      prtgGet<PrtgTableResponse>("/api/table.json", {
        content: "sensors",
        columns:
          "objid,name,device,group,probe,status,status_raw,lastvalue,message,tags",
        filter_group: sub,
        count: "2500",
      })
        .then((r) => {
          return (r.sensors ?? []).filter(
            (s) => (s as any).probe === groupName,
          );
        })
        .catch(() => []),
    ),
  );

  const sensors = results.flat();

  logger.debug("PRTG sensors found", {
    group: groupName,
    count: sensors.length,
    sample: sensors.slice(0, 3).map((s) => ({ name: s.name, group: s.group })),
  });

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
      {
        id: sensorId.toString(),
      },
    );
    return result.sensordata ?? null;
  } catch {
    return null;
  }
}

/**
 * Obtiene sensores filtrados por tipo de tag.
 * Permite detectar automáticamente qué dashboards están disponibles para un cliente.
 */
export async function getSensorsByTag(
  groupName: string,
  tag: string,
): Promise<PrtgSensor[]> {
  const result = await prtgGet<PrtgTableResponse>("/api/table.json", {
    content: "sensors",
    columns: "objid,name,device,group,status,status_raw,lastvalue,message,tags",
    filter_group: groupName,
    filter_tags: tag,
    count: "2500",
  });

  return result.sensors ?? [];
}

export async function getSensorChannels(
  sensorId: number,
): Promise<{ name: string; lastvalue: string; lastvalue_raw: number }[]> {
  const result = await prtgGet<any>("/api/table.json", {
    output: "json",
    content: "channels",
    columns: "name,lastvalue,lastvalue_raw",
    id: String(sensorId),
  });
  return result?.channels ?? [];
}
