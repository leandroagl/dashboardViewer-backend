// ─── Tests de integración: auth.service ──────────────────────────────────────
// Corre contra la DB de test real — sin mocks del pool.
// Esto garantiza que el código SQL es válido contra el schema actual.

import bcrypt from 'bcrypt';
import {
  createTestDatabase,
  runMigrations,
  cleanDatabase,
  closeTestDatabase,
  testPool,
} from './db.helper';
import {
  loginUser,
  logoutUser,
  refreshAccessToken,
  changePassword,
} from '../modules/auth/auth.service';

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

async function crearUsuario(overrides: {
  email?: string;
  password?: string;
  rol?: string;
  activo?: boolean;
  debe_cambiar_password?: boolean;
} = {}): Promise<{ id: string; email: string; password: string }> {
  const email    = overrides.email    ?? 'test@ondra.com.ar';
  const password = overrides.password ?? 'Test1234!';
  const hash     = await bcrypt.hash(password, 4); // cost 4 para tests rápidos

  const result = await testPool.query(
    `INSERT INTO usuarios (email, nombre, password_hash, rol, activo, debe_cambiar_password)
     VALUES ($1, 'Test User', $2, $3, $4, $5)
     RETURNING id`,
    [
      email,
      hash,
      overrides.rol                  ?? 'admin_ondra',
      overrides.activo               ?? true,
      overrides.debe_cambiar_password ?? false,
    ],
  );

  return { id: result.rows[0].id, email, password };
}

// ─── loginUser ────────────────────────────────────────────────────────────────

describe('loginUser', () => {
  test('retorna tokens y datos del usuario con credenciales correctas', async () => {
    const { email, password } = await crearUsuario();

    const result = await loginUser(email, password);

    expect(result).not.toBeNull();
    expect((result as any).status).toBe('ok');
    expect((result as any).data.accessToken).toBeTruthy();
    expect((result as any).data.refreshToken).toBeTruthy();
    expect((result as any).data.rol).toBe('admin_ondra');
    expect((result as any).data.clienteSlug).toBeNull();
    expect((result as any).data.mustChangePassword).toBe(false);
  });

  test('retorna wrong con contraseña incorrecta', async () => {
    const { email } = await crearUsuario();

    const result = await loginUser(email, 'contraseña_incorrecta');

    expect((result as any)?.status).toBe('wrong');
  });

  test('retorna wrong si el usuario no existe', async () => {
    const result = await loginUser('noexiste@ondra.com.ar', 'cualquier');

    expect((result as any)?.status).toBe('wrong');
    expect((result as any)?.intentos_restantes).toBeNull();
  });

  test('retorna null si el usuario está inactivo', async () => {
    const { email, password } = await crearUsuario({ activo: false });

    const result = await loginUser(email, password);

    expect(result).toBeNull();
  });

  test('acepta el email en mayúsculas (normalización)', async () => {
    const { password } = await crearUsuario({ email: 'test@ondra.com.ar' });

    const result = await loginUser('TEST@ONDRA.COM.AR', password);

    expect((result as any)?.status).toBe('ok');
  });

  test('guarda el refresh token en la DB', async () => {
    const { email, password } = await crearUsuario();

    await loginUser(email, password);

    const tokens = await testPool.query(`SELECT * FROM refresh_tokens`);
    expect(tokens.rowCount).toBe(1);
  });
});

// ─── logoutUser ───────────────────────────────────────────────────────────────

describe('logoutUser', () => {
  test('marca el refresh token como revocado', async () => {
    const { email, password } = await crearUsuario();
    const login = await loginUser(email, password);

    await logoutUser((login as any).data.refreshToken);

    const token = await testPool.query(
      `SELECT revocado, revocado_en FROM refresh_tokens WHERE revocado = TRUE`,
    );
    expect(token.rowCount).toBe(1);
    expect(token.rows[0].revocado_en).not.toBeNull();
  });

  test('no lanza error si el token no existe en la DB', async () => {
    await expect(logoutUser('token_inexistente')).resolves.not.toThrow();
  });
});

// ─── refreshAccessToken ───────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  test('retorna nuevo access token con refresh token válido', async () => {
    const { email, password } = await crearUsuario();
    const login = await loginUser(email, password);

    const result = await refreshAccessToken((login as any).data.refreshToken);

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBeTruthy();
  });

  test('retorna null con token revocado', async () => {
    const { email, password } = await crearUsuario();
    const login = await loginUser(email, password);
    await logoutUser((login as any).data.refreshToken);

    const result = await refreshAccessToken((login as any).data.refreshToken);

    expect(result).toBeNull();
  });

  test('retorna null con token inválido', async () => {
    const result = await refreshAccessToken('token.invalido.jwt');

    expect(result).toBeNull();
  });
});

// ─── changePassword ───────────────────────────────────────────────────────────

describe('changePassword', () => {
  test('cambia la contraseña y revoca todos los refresh tokens del usuario', async () => {
    const { id, email, password } = await crearUsuario();
    await loginUser(email, password); // genera un refresh token

    const result = await changePassword(id, password, 'NuevaPass123!');

    expect(result.ok).toBe(true);

    // Todos los tokens del usuario deben quedar revocados
    const tokens = await testPool.query(
      `SELECT revocado FROM refresh_tokens WHERE usuario_id = $1`,
      [id],
    );
    expect(tokens.rows.every((r) => r.revocado === true)).toBe(true);
  });

  test('retorna error si la contraseña actual es incorrecta', async () => {
    const { id } = await crearUsuario();

    const result = await changePassword(id, 'incorrecta', 'NuevaPass123!');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('retorna error si la nueva contraseña es débil', async () => {
    const { id, password } = await crearUsuario();

    const result = await changePassword(id, password, '1234');

    expect(result.ok).toBe(false);
  });

  test('la nueva contraseña funciona para login después del cambio', async () => {
    const { id, email, password } = await crearUsuario();

    await changePassword(id, password, 'NuevaPass123!');
    const loginResult = await loginUser(email, 'NuevaPass123!');

    expect((loginResult as any)?.status).toBe('ok');
  });
});
