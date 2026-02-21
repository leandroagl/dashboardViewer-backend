// ─── Middleware de validación de requests ────────────────────────────────────
// Usa express-validator para validar el body de los requests.
// Si hay errores, responde 400 con los detalles.

import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';

export function validate(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    res.status(400).json({
      ok:     false,
      error:  'Datos inválidos.',
      fields: errors.array().map(e => ({ field: 'path' in e ? e.path : e.type, message: e.msg })),
    });
    return;
  }

  next();
}
