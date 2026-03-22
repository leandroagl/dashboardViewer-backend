// ─── SQL de migraciones ───────────────────────────────────────────────────────
// Exportado como módulo para que migrate.ts y los tests de integración
// puedan importarlo directamente sin parsear el código fuente con regex.

export const migrations = `

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
ALTER TABLE clientes       ADD COLUMN IF NOT EXISTS prtg_extra_probes TEXT;           -- sondas adicionales, separadas por coma
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS es_superadmin BOOLEAN NOT NULL DEFAULT FALSE;  -- usuario inmutable del sistema
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revocado_en TIMESTAMPTZ;          -- momento de revocación explícita
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS intentos_fallidos  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS bloqueado_hasta     TIMESTAMPTZ NULL;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS cantidad_bloqueos   INTEGER     NOT NULL DEFAULT 0;

-- ─── Índices para consultas frecuentes ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp      ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_usuario_id     ON audit_logs(usuario_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_cliente_id     ON audit_logs(cliente_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_accion         ON audit_logs(accion);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ip_origen      ON audit_logs(ip_origen);
-- Índice compuesto para filtros combinados accion+resultado (frecuente en getLogs y resumen)
CREATE INDEX IF NOT EXISTS idx_audit_logs_accion_resultado ON audit_logs(accion, resultado);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario    ON refresh_tokens(usuario_id);
-- Índice parcial: consultas de tokens válidos solo leen los no revocados
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_activos    ON refresh_tokens(usuario_id) WHERE revocado = FALSE;
CREATE INDEX IF NOT EXISTS idx_usuarios_email            ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_cliente_id       ON usuarios(cliente_id);
-- FK sin índice explícito: creado_por referencia self-join en auditorías y ABM
CREATE INDEX IF NOT EXISTS idx_usuarios_creado_por       ON usuarios(creado_por);

`;
