// ─── ONDRA Monitor — Punto de entrada del servidor ───────────────────────────

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { env } from './config/env';
import { testDatabaseConnection } from './config/database/pool';
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

// ─── Seguridad ────────────────────────────────────────────────────────────────

// Cabeceras de seguridad HTTP (XSS, MIME sniffing, etc.)
app.use(helmet());

// CORS: solo orígenes confiables en producción
app.use(cors({
  origin:      'http://localhost:4200',  // URL exacta del frontend
  credentials: true,                     // ← imprescindible para cookies
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

// ─── Parsers ──────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Rutas ────────────────────────────────────────────────────────────────────

// Health check (público, sin autenticación)
app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0', timestamp: new Date().toISOString() });
});

// Auth
app.use('/auth/login', loginLimiter);       // Limitar intentos de login
app.use('/auth',       authRoutes);

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

start();
