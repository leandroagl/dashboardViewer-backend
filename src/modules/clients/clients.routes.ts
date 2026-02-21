// ─── Rutas de Clientes (solo admin_ondra) ─────────────────────────────────────

import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as ClientsController from './clients.controller';

const router = Router();

// Todas las rutas requieren autenticación y rol admin_ondra
router.use(authenticate, requireAdmin);

router.get('/',           ClientsController.getAll);
router.get('/:id',        ClientsController.getOne);
router.post('/',          ClientsController.createClientValidators, validate, ClientsController.create);
router.patch('/:id',      ClientsController.updateClientValidators, validate, ClientsController.update);
router.patch('/:id/status', ClientsController.setStatus);
router.delete('/:id', ClientsController.deleteClientHandler);


export default router;
