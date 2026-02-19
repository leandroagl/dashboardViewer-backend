// ─── Servicio de Autenticación ────────────────────────────────────────────────
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../../config/database/pool";
import { env } from "../../config/env";
import { JwtPayload, UserRole } from "../../types";
import { validatePasswordStrength } from "../../utils/password";
import { logger } from "../../utils/logger";

// ─── Tokens ───────────────────────────────────────────────────────────────────

function generateTokenPair(
  payload: JwtPayload,
  esKiosk: boolean,
): {
  accessToken: string;
  refreshToken: string;
  refreshExpiry: Date | null;
} {
  const accessToken = jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn as jwt.SignOptions["expiresIn"],
  });

  const refreshExpiresIn = esKiosk
    ? undefined
    : (env.jwt.refreshExpiresIn as jwt.SignOptions["expiresIn"]);
  const refreshToken = jwt.sign(payload, env.jwt.refreshSecret, {
    ...(refreshExpiresIn ? { expiresIn: refreshExpiresIn } : {}),
  });

  const refreshExpiry = esKiosk
    ? null
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return { accessToken, refreshToken, refreshExpiry };
}

async function storeRefreshToken(
  userId: string,
  refreshToken: string,
  expiry: Date | null,
): Promise<void> {
  const tokenHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  await pool.query(
    `INSERT INTO refresh_tokens (usuario_id, token_hash, expira_en)
     VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING`,
    [userId, tokenHash, expiry],
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiry: Date | null;
  mustChangePassword: boolean;
  rol: UserRole;
  clienteSlug: string | null;
  dashboardsDisponibles: string[];
}

export async function loginUser(
  email: string,
  password: string,
): Promise<LoginResult | null> {
  const result = await pool.query(
    `SELECT u.*, c.slug as cliente_slug
     FROM usuarios u
     LEFT JOIN clientes c ON u.cliente_id = c.id
     WHERE u.email = $1 AND u.activo = TRUE`,
    [email.toLowerCase().trim()],
  );

  const user = result.rows[0];
  if (!user) return null;

  if (user.cliente_id) {
    const clientResult = await pool.query(
      `SELECT activo FROM clientes WHERE id = $1`,
      [user.cliente_id],
    );
    if (!clientResult.rows[0]?.activo) return null;
  }

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) return null;

  const payload: JwtPayload = {
    sub:        user.id,
    email:      user.email,
    rol:        user.rol as UserRole,
    cliente_id: user.cliente_id ?? null,
    es_kiosk:   user.es_kiosk,
  };

  const { accessToken, refreshToken, refreshExpiry } = generateTokenPair(
    payload,
    user.es_kiosk,
  );

  await storeRefreshToken(user.id, refreshToken, refreshExpiry);

  await pool.query(`UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1`, [
    user.id,
  ]);

  return {
    accessToken,
    refreshToken,
    refreshExpiry,
    mustChangePassword:    user.debe_cambiar_password,
    rol:                   user.rol as UserRole,
    clienteSlug:           user.cliente_slug ?? null,
    dashboardsDisponibles: [],
  };
}

// ─── Refresh token ────────────────────────────────────────────────────────────
// Ventana de gracia: si el token fue rotado hace menos de 10 segundos,
// devolvemos el nuevo token en lugar de rechazar. Esto resuelve el race
// condition cuando el frontend hace múltiples requests concurrentes.

const GRACE_PERIOD_MS = 10_000;

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  newRefreshToken: string;
  refreshExpiry: Date | null;
} | null> {
  let payload: JwtPayload;
  try {
    payload = jwt.verify(refreshToken, env.jwt.refreshSecret) as JwtPayload;
  } catch {
    return null;
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  const stored = await pool.query(
    `SELECT id, revocado, expira_en FROM refresh_tokens
     WHERE token_hash = $1 AND usuario_id = $2`,
    [tokenHash, payload.sub],
  );

  const record = stored.rows[0];
  if (!record || record.revocado) return null;

  if (record.expira_en && new Date(record.expira_en) < new Date()) return null;

  const userResult = await pool.query(
    `SELECT activo FROM usuarios WHERE id = $1`,
    [payload.sub],
  );
  if (!userResult.rows[0]?.activo) return null;

  // Solo rotar si vence en menos de 24 horas
  const rawPayload = payload as JwtPayload & { exp?: number; iat?: number };
  const { exp, iat, ...cleanPayload } = rawPayload;

  const hoursLeft = record.expira_en
    ? (new Date(record.expira_en).getTime() - Date.now()) / (1000 * 60 * 60)
    : Infinity;

  const shouldRotate = hoursLeft < 24;

  let newRefreshToken = refreshToken;
  let refreshExpiry: Date | null = record.expira_en ?? null;

  if (shouldRotate) {
    logger.debug('Rotando refresh token (vence en menos de 24hs)', { sub: payload.sub, hoursLeft });
    const pair = generateTokenPair(cleanPayload as JwtPayload, payload.es_kiosk ?? false);
    newRefreshToken = pair.refreshToken;
    refreshExpiry   = pair.refreshExpiry;

    await pool.query(
      `UPDATE refresh_tokens SET revocado = TRUE, revocado_en = NOW() WHERE id = $1`,
      [record.id],
    );
    await storeRefreshToken(payload.sub, newRefreshToken, refreshExpiry);
  }

  const { accessToken } = generateTokenPair(cleanPayload as JwtPayload, payload.es_kiosk ?? false);

  return { accessToken, newRefreshToken, refreshExpiry };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logoutUser(refreshToken: string): Promise<void> {
  const tokenHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");
  await pool.query(
    `UPDATE refresh_tokens SET revocado = TRUE, revocado_en = NOW() WHERE token_hash = $1`,
    [tokenHash],
  );
}

// ─── Revocar sesión kiosk ─────────────────────────────────────────────────────

export async function revokeKioskSession(userId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revocado = TRUE, revocado_en = NOW()
     WHERE usuario_id = $1 AND revocado = FALSE`,
    [userId],
  );
  logger.info("Sesión kiosk revocada", { userId });
}

// ─── Cambio de contraseña ─────────────────────────────────────────────────────

export interface ChangePasswordResult {
  ok: boolean;
  error?: string;
}

export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return { ok: false, error: strengthError };

  const result = await pool.query(
    `SELECT password_hash FROM usuarios WHERE id = $1`,
    [userId],
  );
  const user = result.rows[0];
  if (!user) return { ok: false, error: "Usuario no encontrado." };

  const isValid = await bcrypt.compare(oldPassword, user.password_hash);
  if (!isValid) return { ok: false, error: "La contraseña actual es incorrecta." };

  const newHash = await bcrypt.hash(newPassword, 12);
  await pool.query(
    `UPDATE usuarios SET password_hash = $1, debe_cambiar_password = FALSE WHERE id = $2`,
    [newHash, userId],
  );

  await pool.query(
    `UPDATE refresh_tokens SET revocado = TRUE, revocado_en = NOW() WHERE usuario_id = $1`,
    [userId],
  );

  return { ok: true };
}