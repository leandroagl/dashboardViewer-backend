// ─── Script de migración de base de datos ───────────────────────────────────
// Ejecutar con: npm run db:migrate
// Crea todas las tablas necesarias si no existen.

import { pool } from './pool';
import { logger } from '../../utils/logger';

const migrations = `

-- ─── Clientes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE,     -- inmutable, usado para filtrar PRTG
  prtg_group  VARCHAR(255) NOT NULL,             -- nombre exacto del grupo raíz en PRTG
  activo      BOOLEAN NOT NULL DEFAULT TRUE,
  logo_url    VARCHAR(500),
  color_marca VARCHAR(7),                        -- HEX color, ej: #4dd0e1
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Usuarios ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 VARCHAR(255) NOT NULL UNIQUE,
  nombre                VARCHAR(255) NOT NULL,
  password_hash         VARCHAR(255) NOT NULL,
  rol                   VARCHAR(20) NOT NULL CHECK (rol IN ('admin_ondra', 'viewer', 'viewer_kiosk')),
  cliente_id            UUID REFERENCES clientes(id) ON DELETE SET NULL,
  activo                BOOLEAN NOT NULL DEFAULT TRUE,
  debe_cambiar_password BOOLEAN NOT NULL DEFAULT TRUE,
  es_kiosk              BOOLEAN NOT NULL DEFAULT FALSE,
  ultimo_acceso         TIMESTAMPTZ,
  creado_por            UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Refresh tokens (para revocación) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,    -- hash del token para no almacenar en claro
  revocado    BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_en   TIMESTAMPTZ                      -- NULL = sin vencimiento (kiosk)
);

-- ─── Logs de auditoría ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  usuario_id  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  email       VARCHAR(255),                    -- capturado incluso para logins fallidos
  cliente_id  UUID REFERENCES clientes(id) ON DELETE SET NULL,
  accion      VARCHAR(30) NOT NULL,
  dashboard   VARCHAR(100),                    -- sólo para acción dashboard_view
  ip_origen   VARCHAR(45) NOT NULL,            -- IPv4 o IPv6
  resultado   VARCHAR(15) NOT NULL CHECK (resultado IN ('ok', 'error', 'unauthorized'))
);

-- ─── Columnas agregadas post-creación ────────────────────────────────────────
ALTER TABLE clientes  ADD COLUMN IF NOT EXISTS prtg_extra_probes TEXT;           -- sondas adicionales, separadas por coma
ALTER TABLE usuarios  ADD COLUMN IF NOT EXISTS es_superadmin BOOLEAN NOT NULL DEFAULT FALSE;  -- usuario inmutable del sistema

-- ─── Índices para consultas frecuentes ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp    ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_usuario_id   ON audit_logs(usuario_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_cliente_id   ON audit_logs(cliente_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_accion       ON audit_logs(accion);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ip_origen    ON audit_logs(ip_origen);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario  ON refresh_tokens(usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_email          ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_cliente_id     ON usuarios(cliente_id);

`;

async function migrate() {
  logger.info('Iniciando migraciones...');
  const client = await pool.connect();
  try {
    await client.query(migrations);
    logger.info('Migraciones ejecutadas correctamente.');
  } catch (err) {
    logger.error('Error al ejecutar migraciones', { error: err });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
