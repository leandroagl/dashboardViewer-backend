// ─── Logger centralizado (Winston) ──────────────────────────────────────────
// Todos los módulos importan este logger en lugar de usar console.log.

import winston from 'winston';
import { env } from '../config/env';

const { combine, timestamp, colorize, printf, json } = winston.format;

// Formato legible para desarrollo
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

// Formato estructurado JSON para producción
const prodFormat = combine(
  timestamp(),
  json()
);

export const logger = winston.createLogger({
  level:     env.isDev ? 'debug' : 'info',
  format:    env.isDev ? devFormat : prodFormat,
  transports: [
    new winston.transports.Console(),
    // En producción se podría agregar un transporte a archivo o servicio externo
  ],
});
