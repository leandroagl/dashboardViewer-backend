// ─── ONDRA Monitor — Punto de entrada del servidor ───────────────────────────

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import { testDatabaseConnection, pool } from './config/database/pool';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

// ─── Routers ──────────────────────────────────────────────────────────────────
import authRoutes       from './modules/auth/auth.routes';
import clientsRoutes    from './modules/clients/clients.routes';
import usersRoutes      from './modules/users/users.routes';
import logsRoutes       from './modules/logs/logs.routes';
import dashboardsRoutes from './modules/dashboards/dashboards.routes';

// ─── Inicialización de Express ────────────────────────────────────────────────

const app = express();

// En producción hay un reverse proxy (nginx/traefik) — Express debe
// usar X-Forwarded-For para obtener la IP real del cliente.
// En desarrollo no se activa para evitar spoofing de IP en tests locales.
if (env.nodeEnv === 'production') {
  app.set('trust proxy', 1);
}

// ─── Seguridad ────────────────────────────────────────────────────────────────

// Cabeceras de seguridad HTTP (XSS, MIME sniffing, etc.)
app.use(helmet());

// CORS: origen configurable por env var (CORS_ORIGIN)
app.use(cors({
  origin:      env.corsOrigin,
  credentials: true,            // ← imprescindible para cookies
}));

// Rate limiting global — protección básica contra fuerza bruta y scraping
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max:      200,              // Máximo 200 requests por IP en ese período
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Demasiadas solicitudes. Intentá de nuevo en unos minutos.' },
}));

// Rate limiting más estricto para el endpoint de login
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutos
  max:      10,               // Máximo 10 intentos de login por IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Demasiados intentos de login. Intentá de nuevo en 10 minutos.' },
});

// Rate limiting para refresh — los kiosks refresca tokens cada 5h, pero
// 60 req/15min por IP es más que suficiente para cualquier uso legítimo
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Demasiadas solicitudes de refresh. Intentá de nuevo en unos minutos.' },
});

// ─── Parsers ──────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Rutas ────────────────────────────────────────────────────────────────────

// Health check (público, sin autenticación)
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, version: '1.0.0', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, error: 'Database unavailable', timestamp: new Date().toISOString() });
  }
});

// Auth
app.use('/auth/login',   loginLimiter);
app.use('/auth/refresh', refreshLimiter);
app.use('/auth',         authRoutes);

// Panel de administración (solo admin_ondra — los guards están dentro de cada router)
app.use('/admin/clients', clientsRoutes);
app.use('/admin/users',   usersRoutes);
app.use('/admin/logs',    logsRoutes);

// Dashboards por cliente: /:clientSlug/dashboards/...
app.use('/:clientSlug/dashboards', dashboardsRoutes);

// ─── Manejo de errores ────────────────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    // Verificar conexión a la base de datos antes de aceptar tráfico
    await testDatabaseConnection();

    app.listen(env.port, () => {
      logger.info(`ONDRA Monitor API corriendo en puerto ${env.port} [${env.nodeEnv}]`);
    });
  } catch (err) {
    logger.error('Error al iniciar el servidor', { error: err });
    process.exit(1);
  }
}

// ─── Manejo de errores no capturados ──────────────────────────────────────────
// Sin estos handlers, una excepción o rejection no capturada termina el proceso
// silenciosamente sin log estructurado, dificultando el diagnóstico.

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — proceso termina', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection — proceso termina', { reason });
  process.exit(1);
});

start();
