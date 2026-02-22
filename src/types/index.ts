// ─── Tipos globales del sistema ───────────────────────────────────────────────
// Centraliza enums, interfaces y tipos compartidos entre módulos.

// ─── Roles ───────────────────────────────────────────────────────────────────

export enum UserRole {
  ADMIN_ONDRA   = 'admin_ondra',
  VIEWER        = 'viewer',
  VIEWER_KIOSK  = 'viewer_kiosk',
}

// ─── Acciones de auditoría ───────────────────────────────────────────────────

export enum AuditAction {
  LOGIN              = 'login',
  LOGOUT             = 'logout',
  LOGIN_FAILED       = 'login_fallido',
  TOKEN_REFRESH      = 'token_refresh',
  DASHBOARD_VIEW     = 'dashboard_view',
  USER_CREATED       = 'usuario_creado',
  USER_DEACTIVATED   = 'usuario_desactivado',
  USER_DELETED       = 'usuario_eliminado',
  CLIENT_DELETED     = 'cliente_eliminado',
  KIOSK_REVOKED      = 'kiosk_revocado',
  PASSWORD_RESET     = 'password_reset',
  ACCESS_DENIED      = 'acceso_denegado',
  CONFIG_MODIFIED    = 'config_modificada',
  LOGS_PURGE         = 'logs_purge',
}

export enum AuditResult {
  OK           = 'ok',
  ERROR        = 'error',
  UNAUTHORIZED = 'unauthorized',
}

// ─── Entidades de dominio ────────────────────────────────────────────────────

export interface Client {
  id:                 string;
  nombre:             string;
  slug:               string;           // Identificador inmutable usado para filtrar en PRTG
  prtg_group:         string;           // Nombre exacto del grupo raíz en PRTG (sonda principal)
  prtg_extra_probes?: string | null;    // Sondas adicionales separadas por coma, ej: "Velia,OtraSonda"
  activo:             boolean;
  logo_url?:          string;
  color_marca?:       string;
  creado_en:          Date;
}

export interface User {
  id:                    string;
  email:                 string;
  nombre:                string;
  password_hash:         string;
  rol:                   UserRole;
  cliente_id:            string | null;  // Null para admin_ondra
  activo:                boolean;
  debe_cambiar_password: boolean;
  es_kiosk:              boolean;
  ultimo_acceso?:        Date;
  creado_por?:           string;
  creado_en:             Date;
}

export interface AuditLog {
  id:          string;
  timestamp:   Date;
  usuario_id?: string;
  email?:      string;
  cliente_id?: string;
  accion:      AuditAction;
  dashboard?:  string;
  ip_origen:   string;
  resultado:   AuditResult;
}

// ─── Payload del JWT ─────────────────────────────────────────────────────────

export interface JwtPayload {
  sub:        string;       // user id
  email:      string;
  rol:        UserRole;
  cliente_id: string | null;
  es_kiosk:   boolean;
}

// ─── Express: request extendido con usuario autenticado ──────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
