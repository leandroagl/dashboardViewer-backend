// ─── Utilidades de contraseñas ───────────────────────────────────────────────

import crypto from 'crypto';

/**
 * Genera una contraseña aleatoria que cumple con los requisitos del sistema:
 * - Mínimo 12 caracteres
 * - Al menos una mayúscula, un número y un carácter especial
 */
export function generateRandomPassword(): string {
  const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower   = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const special = '!@#$%^&*()-_=+';
  const all     = upper + lower + numbers + special;

  // Garantizar presencia de cada tipo de carácter requerido
  const mandatory = [
    upper[crypto.randomInt(upper.length)],
    numbers[crypto.randomInt(numbers.length)],
    special[crypto.randomInt(special.length)],
  ];

  // Completar hasta 12 caracteres
  const rest = Array.from({ length: 9 }, () => all[crypto.randomInt(all.length)]);

  // Fisher-Yates shuffle — produce permutaciones uniformes, a diferencia de
  // Array.sort() con comparador aleatorio que genera distribuciones sesgadas.
  const combined = [...mandatory, ...rest];
  for (let i = combined.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }
  return combined.join('');
}

/**
 * Valida que una contraseña cumpla con los requisitos mínimos del sistema.
 * Devuelve null si es válida, o un mensaje de error si no cumple.
 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8)      return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Z]/.test(password))  return 'La contraseña debe contener al menos una mayúscula.';
  if (!/[0-9]/.test(password))  return 'La contraseña debe contener al menos un número.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'La contraseña debe contener al menos un carácter especial.';
  return null;
}
