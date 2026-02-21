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

// ─── Cliente ─────────────────────────────────────────────────────────────────

// Agente HTTPS configurable: ignora certificados auto-firmados si
// PRTG_REJECT_UNAUTHORIZED=false (default para PRTG on-premise).
const httpsAgent = new https.Agent({
  rejectUnauthorized: env.prtg.rejectUnauthorized,
});

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
 * Los subgrupos a consultar se configuran con PRTG_SUBGROUPS.
 */
export async function getSensorsByGroup(
  groupName: string,
): Promise<PrtgSensor[]> {
  const cacheKey = `prtg:group:${groupName}`;
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
        .then((r) => (r.sensors ?? []).filter((s) => s.probe === groupName))
        .catch(() => []),
    ),
  );

  const sensors = results.flat();

  logger.debug("PRTG sensors found", {
    group:  groupName,
    count:  sensors.length,
    sample: sensors.slice(0, 3).map((s) => ({ name: s.name, group: s.group })),
  });

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
  const result = await prtgGet<PrtgChannelResponse>("/api/table.json", {
    output:  "json",
    content: "channels",
    columns: "name,lastvalue,lastvalue_raw",
    id:      String(sensorId),
  });
  return result?.channels ?? [];
}
