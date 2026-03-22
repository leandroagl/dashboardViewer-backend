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

const transports: winston.transport[] = [
  new winston.transports.Console(),
];

if (!env.isDev) {
  // En producción: persistir logs en archivos con rotación por tamaño (10 MB, 5 archivos)
  transports.push(
    new winston.transports.File({
      filename: 'logs/app.log',
      maxsize:  10_485_760, // 10 MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level:    'error',
      maxsize:  10_485_760,
      maxFiles: 5,
    }),
  );
}

export const logger = winston.createLogger({
  level:      env.isDev ? 'debug' : 'info',
  format:     env.isDev ? devFormat : prodFormat,
  transports,
});
