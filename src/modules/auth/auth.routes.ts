// ─── Rutas de Autenticación ───────────────────────────────────────────────────

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as AuthController from './auth.controller';

const router = Router();

// Pública — no requiere token
router.post('/login',   AuthController.loginValidators, validate, AuthController.login);
router.post('/refresh', AuthController.refresh);

// Protegida — requiere token válido
router.post('/logout',          authenticate, AuthController.logout);
router.post('/change-password', authenticate, AuthController.changePasswordValidators, validate, AuthController.changePassword);

export default router;
