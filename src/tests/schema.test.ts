// ─── Test de schema de base de datos ─────────────────────────────────────────
// Verifica que las migraciones crean todas las columnas que el código referencia.
// Este test hubiera detectado el bug de la columna revocado_en faltante.

import {
  createTestDatabase,
  runMigrations,
  testPool,
  closeTestDatabase,
} from './db.helper';

beforeAll(async () => {
  await createTestDatabase();
  await runMigrations();
});

afterAll(async () => {
  await closeTestDatabase();
});

async function getColumns(table: string): Promise<string[]> {
  const result = await testPool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY column_name`,
    [table],
  );
  return result.rows.map((r) => r.column_name as string);
}

describe('schema: tabla refresh_tokens', () => {
  test('tiene todas las columnas requeridas por el código', async () => {
    const columns = await getColumns('refresh_tokens');
    expect(columns).toContain('id');
    expect(columns).toContain('usuario_id');
    expect(columns).toContain('token_hash');
    expect(columns).toContain('revocado');
    expect(columns).toContain('revocado_en');   // columna que faltaba en prod
    expect(columns).toContain('creado_en');
    expect(columns).toContain('expira_en');
  });
});

describe('schema: tabla usuarios', () => {
  test('tiene todas las columnas requeridas por el código', async () => {
    const columns = await getColumns('usuarios');
    expect(columns).toContain('id');
    expect(columns).toContain('email');
    expect(columns).toContain('password_hash');
    expect(columns).toContain('rol');
    expect(columns).toContain('activo');
    expect(columns).toContain('debe_cambiar_password');
    expect(columns).toContain('es_kiosk');
    expect(columns).toContain('es_superadmin');
    expect(columns).toContain('ultimo_acceso');
  });
});

describe('schema: tabla clientes', () => {
  test('tiene todas las columnas requeridas por el código', async () => {
    const columns = await getColumns('clientes');
    expect(columns).toContain('id');
    expect(columns).toContain('nombre');
    expect(columns).toContain('slug');
    expect(columns).toContain('prtg_group');
    expect(columns).toContain('prtg_extra_probes');
    expect(columns).toContain('activo');
  });
});
