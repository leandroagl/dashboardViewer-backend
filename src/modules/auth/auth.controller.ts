// ─── Controller de Autenticación ─────────────────────────────────────────────
// Maneja los endpoints de login, logout, refresh y cambio de contraseña.

import { Request, Response } from "express";
import { body } from "express-validator";
import { env } from "../../config/env";
import { UserRole } from "../../types";
import { audit, getClientIp } from "../../middleware/auditLogger";
import { AuditAction, AuditResult } from "../../types";
import { sendOk, sendError, sendServerError } from "../../utils/response";
import { logger } from "../../utils/logger";
import * as AuthService from "./auth.service";

// ─── Validadores de input ─────────────────────────────────────────────────────

export const loginValidators = [
  body("email").isEmail().withMessage("Email inválido."),
  body("password").notEmpty().withMessage("Contraseña requerida."),
];

export const changePasswordValidators = [
  body("oldPassword").notEmpty().withMessage("Contraseña actual requerida."),
  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("La nueva contraseña debe tener al menos 8 caracteres."),
];

// ─── Helpers de cookie ────────────────────────────────────────────────────────

function setRefreshCookie(
  res: Response,
  token: string,
  expiry: Date | null,
): void {
  res.cookie("refresh_token", token, {
    httpOnly: true,
    secure: env.cookie.secure, // false en desarrollo
    sameSite: env.nodeEnv === "production" ? "strict" : "lax",
    domain: env.nodeEnv === "production" ? env.cookie.domain : undefined,
    expires: expiry ?? undefined,
    path: "/",
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie("refresh_token", {
    httpOnly: true,
    secure:   env.cookie.secure,
    sameSite: env.nodeEnv === "production" ? "strict" : "lax",
    domain:   env.nodeEnv === "production" ? env.cookie.domain : undefined,
    path:     "/",
  });
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/** POST /auth/login */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const ip = getClientIp(req);

  try {
    const result = await AuthService.loginUser(email, password);

    if (!result) {
      // Login fallido: registrar auditoría con información mínima
      await audit({
        email,
        accion: AuditAction.LOGIN_FAILED,
        ip_origen: ip,
        resultado: AuditResult.UNAUTHORIZED,
      });
      sendError(res, 401, "Email o contraseña incorrectos.");
      return;
    }

    // Almacenar refresh token en cookie HttpOnly
    setRefreshCookie(res, result.refreshToken, result.refreshExpiry);

    // Auditoría de login exitoso
    await audit({
      email,
      accion: AuditAction.LOGIN,
      ip_origen: ip,
      resultado: AuditResult.OK,
    });

    sendOk(res, {
      accessToken: result.accessToken,
      mustChangePassword: result.mustChangePassword,
      rol: result.rol,
      clienteSlug: result.clienteSlug,
      dashboardsDisponibles: result.dashboardsDisponibles,
    });
  } catch (err) {
    logger.error("Error en login", { error: err });
    sendServerError(res);
  }
}

/** POST /auth/refresh */
export async function refresh(req: Request, res: Response): Promise<void> {
  const refreshToken = req.cookies?.refresh_token;
  const ip = getClientIp(req);

  if (!refreshToken) {
    sendError(res, 401, "Refresh token no encontrado.");
    return;
  }

  try {
    const result = await AuthService.refreshAccessToken(refreshToken);

    if (!result) {
      clearRefreshCookie(res);
      sendError(res, 401, "Refresh token inválido o expirado.");
      return;
    }

    // Rotar el refresh token en la cookie
    setRefreshCookie(res, result.newRefreshToken, result.refreshExpiry);

    await audit({
      accion: AuditAction.TOKEN_REFRESH,
      ip_origen: ip,
      resultado: AuditResult.OK,
    });

    sendOk(res, { accessToken: result.accessToken });
  } catch (err) {
    logger.error("Error en refresh", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendServerError(res);
  }
}

/** POST /auth/logout */
export async function logout(req: Request, res: Response): Promise<void> {
  const refreshToken = req.cookies?.refresh_token;
  const ip = getClientIp(req);

  try {
    if (refreshToken) {
      await AuthService.logoutUser(refreshToken);
    }

    clearRefreshCookie(res);

    if (req.user) {
      await audit({
        usuario_id: req.user.sub,
        email: req.user.email,
        cliente_id: req.user.cliente_id ?? undefined,
        accion: AuditAction.LOGOUT,
        ip_origen: ip,
        resultado: AuditResult.OK,
      });
    }

    sendOk(res, { message: "Sesión cerrada correctamente." });
  } catch (err) {
    logger.error("Error en logout", { error: err });
    sendServerError(res);
  }
}

/** POST /auth/change-password */
export async function changePassword(
  req: Request,
  res: Response,
): Promise<void> {
  const { oldPassword, newPassword } = req.body;
  const userId = req.user!.sub;
  const ip = getClientIp(req);

  try {
    const result = await AuthService.changePassword(
      userId,
      oldPassword,
      newPassword,
    );

    if (!result.ok) {
      sendError(res, 400, result.error ?? "Error al cambiar contraseña.");
      return;
    }

    // Revocar la cookie actual (el usuario deberá hacer login de nuevo)
    clearRefreshCookie(res);

    await audit({
      usuario_id: userId,
      email: req.user!.email,
      cliente_id: req.user!.cliente_id ?? undefined,
      accion: AuditAction.PASSWORD_RESET,
      ip_origen: ip,
      resultado: AuditResult.OK,
    });

    sendOk(res, {
      message: "Contraseña actualizada. Por favor iniciá sesión nuevamente.",
    });
  } catch (err) {
    logger.error("Error al cambiar contraseña", { error: err });
    sendServerError(res);
  }
}
