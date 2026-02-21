// ─── Rutas de Usuarios (solo admin_ondra) ─────────────────────────────────────

import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as UsersController from './users.controller';

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/',                         UsersController.getAll);
router.get('/:id',                      UsersController.idParamValidator, validate, UsersController.getOne);
router.post('/',                        UsersController.createUserValidators, validate, UsersController.create);
router.patch('/:id',                    UsersController.updateUserValidators, validate, UsersController.update);
router.patch('/:id/status',             UsersController.idParamValidator, validate, UsersController.setStatus);
router.post('/:id/reset-password',      UsersController.idParamValidator, validate, UsersController.resetPassword);
router.post('/:id/revoke-kiosk',        UsersController.idParamValidator, validate, UsersController.revokeKiosk);
router.delete('/:id',                   UsersController.idParamValidator, validate, UsersController.deleteUserHandler);

export default router;
