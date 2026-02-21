// ─── Configuración de variables de entorno ───────────────────────────────────
// Valida y exporta todas las variables requeridas al iniciar la aplicación.
// Si falta alguna variable crítica, la aplicación no arranca.

import dotenv from 'dotenv';
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
  port:        parseInt(optionalEnv('PORT', '3000'), 10),
  nodeEnv:     optionalEnv('NODE_ENV', 'development'),
  isDev:       optionalEnv('NODE_ENV', 'development') === 'development',
  corsOrigin:  optionalEnv('CORS_ORIGIN', 'http://localhost:4200'),

  // Base de datos
  db: {
    host:     requireEnv('DB_HOST'),
    port:     parseInt(optionalEnv('DB_PORT', '5432'), 10),
    name:     requireEnv('DB_NAME'),
    user:     requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
  },

  // JWT
  jwt: {
    accessSecret:    requireEnv('JWT_ACCESS_SECRET'),
    refreshSecret:   requireEnv('JWT_REFRESH_SECRET'),
    accessExpiresIn: optionalEnv('JWT_ACCESS_EXPIRES_IN', '5h'),
    refreshExpiresIn: optionalEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  // PRTG
  prtg: {
    baseUrl:   requireEnv('PRTG_BASE_URL'),
    apiToken:  requireEnv('PRTG_API_TOKEN'),
  },

  // Cookies
  cookie: {
    domain: optionalEnv('COOKIE_DOMAIN', 'localhost'),
    secure: optionalEnv('COOKIE_SECURE', 'false') === 'true',
    sameSite: 'lax'
  },
} as const;
