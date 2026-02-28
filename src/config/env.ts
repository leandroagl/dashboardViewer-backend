// ─── Configuración de variables de entorno ───────────────────────────────────
// Valida y exporta todas las variables requeridas al iniciar la aplicación.
// Si falta alguna variable crítica, la aplicación no arranca.

import dotenv from "dotenv";
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable de entorno requerida no encontrada: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  // Servidor
  port: parseInt(optionalEnv("PORT", "3000"), 10),
  nodeEnv: optionalEnv("NODE_ENV", "development"),
  isDev: optionalEnv("NODE_ENV", "development") === "development",
  corsOrigin: optionalEnv("CORS_ORIGIN", "http://192.168.22.51:4200"),

  // Base de datos
  db: {
    host: requireEnv("DB_HOST"),
    port: parseInt(optionalEnv("DB_PORT", "5432"), 10),
    name: requireEnv("DB_NAME"),
    user: requireEnv("DB_USER"),
    password: requireEnv("DB_PASSWORD"),
  },

  // JWT
  jwt: {
    accessSecret: requireEnv("JWT_ACCESS_SECRET"),
    refreshSecret: requireEnv("JWT_REFRESH_SECRET"),
    accessExpiresIn: optionalEnv("JWT_ACCESS_EXPIRES_IN", "5h"),
    refreshExpiresIn: optionalEnv("JWT_REFRESH_EXPIRES_IN", "7d"),
  },

  // PRTG
  prtg: {
    baseUrl:  requireEnv("PRTG_BASE_URL"),
    // Autenticación: si PRTG_USERNAME + PRTG_PASSHASH están definidos, tienen prioridad.
    // De lo contrario se usa PRTG_API_TOKEN.
    apiToken:  optionalEnv("PRTG_API_TOKEN",  ""),
    username:  optionalEnv("PRTG_USERNAME",   ""),
    passhash:  optionalEnv("PRTG_PASSHASH",   ""),
    // false por defecto: PRTG on-premise típicamente usa certificados auto-firmados.
    // Setear a true en producción si se instala un certificado válido.
    rejectUnauthorized:
      optionalEnv("PRTG_REJECT_UNAUTHORIZED", "false") === "true",
    // Subgrupos a consultar en PRTG. Separados por coma, sin espacios extra.
    subgroups: optionalEnv(
      "PRTG_SUBGROUPS",
      "Windows Server,Networking,Servers,Backups,Switches,Antenas PTP,Sucursales",
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Cookies
  cookie: {
    domain: optionalEnv("COOKIE_DOMAIN", "localhost"),
    secure: optionalEnv("COOKIE_SECURE", "false") === "true",
    sameSite: "lax",
  },
} as const;
