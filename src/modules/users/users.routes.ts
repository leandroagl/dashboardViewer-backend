// ─── Rutas de Usuarios (solo admin_ondra) ─────────────────────────────────────

import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as UsersController from './users.controller';

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/',                         UsersController.getAll);
router.get('/:id',                      UsersController.getOne);
router.post('/',                        UsersController.createUserValidators, validate, UsersController.create);
router.patch('/:id',                    UsersController.update);
router.patch('/:id/status',             UsersController.setStatus);
router.post('/:id/reset-password',      UsersController.resetPassword);
router.post('/:id/revoke-kiosk',        UsersController.revokeKiosk);
router.delete('/:id', UsersController.deleteUserHandler);

export default router;
