// ─── Rutas de Dashboards ──────────────────────────────────────────────────────

import { Router } from 'express';
import { authenticate, requireClientAccess } from '../../middleware/authenticate';
import * as DashboardsController from './dashboards.controller';

const router = Router({ mergeParams: true }); // Para acceder a :clientSlug del router padre

// Todas las rutas requieren autenticación + verificación de acceso al cliente
router.use(authenticate, requireClientAccess);

router.get('/',           DashboardsController.getAvailable);
router.get('/servers',    DashboardsController.getServers);
router.get('/backups',    DashboardsController.getBackups);
router.get('/networking', DashboardsController.getNetworking);
router.get('/windows',    DashboardsController.getWindows);
router.get('/sucursales', DashboardsController.getSucursales);

export default router;
