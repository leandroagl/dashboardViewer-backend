import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import * as LogsController from './logs.controller';

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/',                LogsController.getLogs);
router.get('/suspicious-ips',  LogsController.getSuspiciousIps);
router.get('/export',          LogsController.exportCsv);

export default router;
