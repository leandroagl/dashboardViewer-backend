// ─── Tests de integración: account lockout ────────────────────────────────────
// Corre contra la DB de test real — sin mocks del pool.

import bcrypt from 'bcrypt';
import {
  createTestDatabase,
  runMigrations,
  cleanDatabase,
  closeTestDatabase,
  testPool,
} from './db.helper';
import { loginUser } from '../modules/auth/auth.service';

// ─── Setup global ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  await createTestDatabase();
  await runMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function crearUsuario(email: string, password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 4); // cost 4 para tests rápidos
  const r = await testPool.query(
    `INSERT INTO usuarios (email, nombre, password_hash, rol, debe_cambiar_password)
     VALUES ($1, 'Test Lockout', $2, 'viewer', FALSE)
     RETURNING id`,
    [email, hash],
  );
  return r.rows[0].id;
}

async function getLockoutState(email: string) {
  const r = await testPool.query(
    `SELECT intentos_fallidos, bloqueado_hasta, cantidad_bloqueos
     FROM usuarios WHERE email = $1`,
    [email],
  );
  return r.rows[0];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Account Lockout', () => {

  test('usuario inexistente: retorna wrong sin rastrear intentos', async () => {
    const r = await loginUser('noexiste@test.com', 'wrong');
    expect(r).not.toBeNull();
    expect((r as any).status).toBe('wrong');
    expect((r as any).intentos_restantes).toBeNull();
  });

  test('password incorrecta: no informa restantes en los primeros 5 intentos', async () => {
    await crearUsuario('u1@test.com', 'correct');
    for (let i = 0; i < 5; i++) {
      const r = await loginUser('u1@test.com', 'wrong');
      expect((r as any).status).toBe('wrong');
      expect((r as any).intentos_restantes).toBeNull();
    }
  });

  test('password incorrecta: informa restantes cuando quedan ≤5', async () => {
    await crearUsuario('u2@test.com', 'correct');
    // 5 intentos que no se informan
    for (let i = 0; i < 5; i++) await loginUser('u2@test.com', 'wrong');
    // 6to intento: quedan 4
    const r6 = await loginUser('u2@test.com', 'wrong');
    expect((r6 as any).status).toBe('wrong');
    expect((r6 as any).intentos_restantes).toBe(4);
    // 7mo: quedan 3
    const r7 = await loginUser('u2@test.com', 'wrong');
    expect((r7 as any).intentos_restantes).toBe(3);
  });

  test('intento 10 bloquea la cuenta y retorna status locked', async () => {
    await crearUsuario('u3@test.com', 'correct');
    for (let i = 0; i < 9; i++) await loginUser('u3@test.com', 'wrong');
    const r = await loginUser('u3@test.com', 'wrong'); // décimo intento
    expect((r as any).status).toBe('locked');
    expect((r as any).bloqueado_hasta).toBeInstanceOf(Date);
  });

  test('primer bloqueo dura ~5 minutos', async () => {
    await crearUsuario('u4@test.com', 'correct');
    for (let i = 0; i < 9; i++) await loginUser('u4@test.com', 'wrong');
    const r = await loginUser('u4@test.com', 'wrong');
    const bloqueadoHasta = (r as any).bloqueado_hasta as Date;
    const diffMs = bloqueadoHasta.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(4 * 60 * 1000);   // más de 4 minutos
    expect(diffMs).toBeLessThan(6 * 60 * 1000);       // menos de 6 minutos
  });

  test('cuenta bloqueada: rechaza incluso con password correcta', async () => {
    await crearUsuario('u5@test.com', 'correct');
    await testPool.query(
      `UPDATE usuarios SET bloqueado_hasta = NOW() + INTERVAL '5 minutes' WHERE email = $1`,
      ['u5@test.com'],
    );
    const r = await loginUser('u5@test.com', 'correct');
    expect((r as any).status).toBe('locked');
  });

  test('login exitoso resetea intentos_fallidos y bloqueado_hasta', async () => {
    await crearUsuario('u6@test.com', 'correct');
    for (let i = 0; i < 5; i++) await loginUser('u6@test.com', 'wrong');
    await loginUser('u6@test.com', 'correct');
    const state = await getLockoutState('u6@test.com');
    expect(state.intentos_fallidos).toBe(0);
    expect(state.bloqueado_hasta).toBeNull();
    // cantidad_bloqueos NO se resetea en login exitoso
    expect(state.cantidad_bloqueos).toBe(0); // era 0 porque nunca se bloqueó
  });

  test('segundo bloqueo (cantidad_bloqueos=1) dura ~15 minutos', async () => {
    await crearUsuario('u7@test.com', 'correct');
    // Primer bloqueo
    for (let i = 0; i < 10; i++) await loginUser('u7@test.com', 'wrong');
    // Verificar que cantidad_bloqueos es 1
    const state1 = await getLockoutState('u7@test.com');
    expect(state1.cantidad_bloqueos).toBe(1);
    // Simular que el tiempo pasó (forzar expiración)
    await testPool.query(
      `UPDATE usuarios SET bloqueado_hasta = NOW() - INTERVAL '1 second' WHERE email = $1`,
      ['u7@test.com'],
    );
    // Segundo bloqueo (sin login exitoso intermedio — cantidad_bloqueos se mantiene en 1)
    for (let i = 0; i < 10; i++) await loginUser('u7@test.com', 'wrong');
    const r = await loginUser('u7@test.com', 'wrong');
    const bloqueadoHasta = (r as any).bloqueado_hasta as Date;
    const diffMs = bloqueadoHasta.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(14 * 60 * 1000);  // más de 14 minutos
    expect(diffMs).toBeLessThan(16 * 60 * 1000);      // menos de 16 minutos
  });

  test('tercer bloqueo (cantidad_bloqueos>=2) dura ~60 minutos', async () => {
    await crearUsuario('u8@test.com', 'correct');
    // Forzar cantidad_bloqueos = 2 directamente
    await testPool.query(
      `UPDATE usuarios SET cantidad_bloqueos = 2 WHERE email = $1`,
      ['u8@test.com'],
    );
    for (let i = 0; i < 10; i++) await loginUser('u8@test.com', 'wrong');
    const r = await loginUser('u8@test.com', 'wrong');
    const bloqueadoHasta = (r as any).bloqueado_hasta as Date;
    const diffMs = bloqueadoHasta.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(59 * 60 * 1000);   // más de 59 minutos
    expect(diffMs).toBeLessThan(61 * 60 * 1000);       // menos de 61 minutos
  });

});
