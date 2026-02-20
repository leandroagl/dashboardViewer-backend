import { NextFunction, Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import * as LogsController from './logs.controller';
import * as UsersController from '../users/users.controller'

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/',                LogsController.getLogs);
router.get('/suspicious-ips',  LogsController.getSuspiciousIps);
router.get('/export',          LogsController.exportCsv);
router.delete('/logs/purge', authenticate, requireAdmin, LogsController.purgeLogsHandler);

export default router;
