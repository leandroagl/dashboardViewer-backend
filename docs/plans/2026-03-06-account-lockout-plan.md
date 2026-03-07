# Account Lockout Progresivo — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bloquear cuentas de usuario tras 10 intentos fallidos de login, con duración progresiva (5min/15min/1h), desbloqueo manual por admin, y feedback al usuario en el frontend.

**Architecture:** Se agregan 3 columnas a la tabla `usuarios` (intentos_fallidos, bloqueado_hasta, cantidad_bloqueos). `loginUser()` en auth.service cambia su tipo de retorno a un discriminated union `LoginOutcome`. El admin puede desbloquear via `POST /admin/users/:id/unlock`. El frontend muestra intentos restantes y estado de bloqueo en la página de login, y botón de desbloqueo en el panel de usuarios.

**Tech Stack:** Node.js/Express/TypeScript/PostgreSQL (backend), Angular 19/Signals (frontend). Tests: Jest + ts-jest contra PostgreSQL real (misma infraestructura que `src/tests/auth.service.test.ts`).

**Repos:**
- Backend: `e:/develop/dashboardViewer-backend` — rama `develop`
- Frontend: `e:/develop/dashboardViewer-frontend` — rama `develop`

**IMPORTANTE:** `cantidad_bloqueos` NO se resetea en login exitoso — solo se resetea cuando el admin desbloquea. Esto garantiza la progresividad real. `intentos_fallidos` y `bloqueado_hasta` sí se resetean en login exitoso.

---

## Task 1: Migración de base de datos

**Files:**
- Modify: `src/config/database/migrate.ts`
- Modify: `src/tests/schema.test.ts`

### Step 1: Agregar columnas al bloque de migraciones

En `migrate.ts`, localizar el bloque `-- ─── Columnas agregadas post-creación ───` (alrededor de línea 61) y agregar al final de esa sección:

```sql
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta     TIMESTAMPTZ NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cantidad_bloqueos   INTEGER     NOT NULL DEFAULT 0;
```

El bloque debe quedar así:
```sql
-- ─── Columnas agregadas post-creación ────────────────────────────────────────
ALTER TABLE clientes       ADD COLUMN IF NOT EXISTS prtg_extra_probes TEXT;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS es_superadmin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revocado_en TIMESTAMPTZ;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS intentos_fallidos  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS bloqueado_hasta     TIMESTAMPTZ NULL;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS cantidad_bloqueos   INTEGER     NOT NULL DEFAULT 0;
```

### Step 2: Actualizar schema.test.ts

En `src/tests/schema.test.ts`, agregar las 3 columnas nuevas a los expected columns de `usuarios`. Buscar el test de la tabla `usuarios` y agregar al array:
- `'intentos_fallidos'`
- `'bloqueado_hasta'`
- `'cantidad_bloqueos'`

### Step 3: Aplicar migración a la DB principal

```bash
cd e:/develop/dashboardViewer-backend
npm run db:migrate
```

Expected output: `Migraciones ejecutadas correctamente.`

### Step 4: Ejecutar tests de schema

```bash
npm test -- --testPathPattern=schema
```

Expected: PASS (todos los tests de schema en verde).

### Step 5: Commit

```bash
cd e:/develop/dashboardViewer-backend
git add src/config/database/migrate.ts src/tests/schema.test.ts
git commit -m "feat(auth): agregar columnas de lockout a tabla usuarios"
```

---

## Task 2: Tipos backend

**Files:**
- Modify: `src/types/index.ts`

### Step 1: Agregar campos de lockout a la interfaz User

En `src/types/index.ts`, agregar al final de la interfaz `User` (antes del cierre `}`):

```typescript
  intentos_fallidos?: number;
  bloqueado_hasta?:   Date | null;
  cantidad_bloqueos?: number;
```

### Step 2: Commit

```bash
git add src/types/index.ts
git commit -m "feat(auth): agregar campos de lockout al tipo User"
```

---

## Task 3: Tests de integración — lockout (TDD: escribir primero)

**Files:**
- Create: `src/tests/lockout.service.test.ts`

### Step 1: Crear el archivo de tests

Crear `src/tests/lockout.service.test.ts` con el siguiente contenido completo:

```typescript
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
```

### Step 2: Ejecutar tests para verificar que FALLAN

```bash
cd e:/develop/dashboardViewer-backend
npm test -- --testPathPattern=lockout
```

Expected: FAIL — `loginUser` retorna el tipo viejo, los assertions de `.status` fallan.

### Step 3: Commit de los tests (aunque fallen — son la spec)

```bash
git add src/tests/lockout.service.test.ts
git commit -m "test(auth): agregar tests de integración para account lockout"
```

---

## Task 4: Refactorizar auth.service.ts + actualizar auth.service.test.ts

**Files:**
- Modify: `src/modules/auth/auth.service.ts`
- Modify: `src/tests/auth.service.test.ts`

### Contexto

El `loginUser` actual retorna `LoginResult | null`. Hay que cambiar al discriminated union `LoginOutcome`. Los tests en `auth.service.test.ts` que usan `loginUser` también deberán actualizarse.

### Step 1: Leer auth.service.ts completo antes de editar

Leer el archivo para entender la estructura actual antes de modificar.

### Step 2: Reemplazar tipos y función loginUser en auth.service.ts

**A) Cambiar la interfaz `LoginResult` por `LoginSuccess` y agregar `LoginOutcome`:**

Reemplazar:
```typescript
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiry: Date | null;
  mustChangePassword: boolean;
  nombre: string;
  rol: UserRole;
  clienteSlug: string | null;
  dashboardsDisponibles: string[];
}
```

Por:
```typescript
export interface LoginSuccess {
  accessToken:           string;
  refreshToken:          string;
  refreshExpiry:         Date | null;
  mustChangePassword:    boolean;
  nombre:                string;
  rol:                   UserRole;
  clienteSlug:           string | null;
  dashboardsDisponibles: string[];
}

export type LoginOutcome =
  | { status: 'ok';     data: LoginSuccess }
  | { status: 'locked'; bloqueado_hasta: Date }
  | { status: 'wrong';  intentos_restantes: number | null }
  | null;  // usuario inactivo o cliente inactivo
```

**B) Agregar helper de duración de bloqueo** (antes de `loginUser`):

```typescript
function lockoutDurationMs(cantidadBloqueos: number): number {
  if (cantidadBloqueos === 0) return  5 * 60 * 1000;  // 5 min
  if (cantidadBloqueos === 1) return 15 * 60 * 1000;  // 15 min
  return                             60 * 60 * 1000;   // 1 h
}
```

**C) Reemplazar la función `loginUser` completa:**

```typescript
export async function loginUser(
  email: string,
  password: string,
): Promise<LoginOutcome> {
  const result = await pool.query(
    `SELECT u.*, c.slug as cliente_slug
     FROM usuarios u
     LEFT JOIN clientes c ON u.cliente_id = c.id
     WHERE u.email = $1 AND u.activo = TRUE`,
    [email.toLowerCase().trim()],
  );

  const user = result.rows[0];

  // Chequear bloqueo ANTES de bcrypt (evitar costo innecesario)
  if (user && user.bloqueado_hasta && new Date(user.bloqueado_hasta) > new Date()) {
    return { status: 'locked', bloqueado_hasta: new Date(user.bloqueado_hasta) };
  }

  // Siempre ejecutar bcrypt aunque el usuario no exista (anti timing-attack)
  const isValid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !isValid) {
    // Rastrear intentos solo para usuarios existentes
    if (user) {
      const nuevoIntentos = (user.intentos_fallidos ?? 0) + 1;

      if (nuevoIntentos >= 10) {
        const durMs      = lockoutDurationMs(user.cantidad_bloqueos ?? 0);
        const bloqueadoHasta = new Date(Date.now() + durMs);
        await pool.query(
          `UPDATE usuarios
           SET intentos_fallidos = 0,
               bloqueado_hasta   = $1,
               cantidad_bloqueos = cantidad_bloqueos + 1
           WHERE id = $2`,
          [bloqueadoHasta, user.id],
        );
        return { status: 'locked', bloqueado_hasta: bloqueadoHasta };
      }

      await pool.query(
        `UPDATE usuarios SET intentos_fallidos = $1 WHERE id = $2`,
        [nuevoIntentos, user.id],
      );
      // Informar restantes solo cuando quedan ≤5
      const restantes = 10 - nuevoIntentos;
      return {
        status: 'wrong',
        intentos_restantes: restantes <= 5 ? restantes : null,
      };
    }

    return { status: 'wrong', intentos_restantes: null };
  }

  // Credenciales válidas — verificar cliente activo
  if (user.cliente_id) {
    const clientResult = await pool.query(
      `SELECT activo FROM clientes WHERE id = $1`,
      [user.cliente_id],
    );
    if (!clientResult.rows[0]?.activo) return null;
  }

  // Resetear intentos en login exitoso (cantidad_bloqueos NO se resetea)
  await pool.query(
    `UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`,
    [user.id],
  );

  const payload: JwtPayload = {
    sub:        user.id,
    email:      user.email,
    rol:        user.rol as UserRole,
    cliente_id: user.cliente_id ?? null,
    es_kiosk:   user.es_kiosk,
  };

  const { accessToken, refreshToken, refreshExpiry } = generateTokenPair(
    payload,
    user.es_kiosk,
  );

  await storeRefreshToken(user.id, refreshToken, refreshExpiry);
  await pool.query(`UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1`, [user.id]);

  return {
    status: 'ok',
    data: {
      accessToken,
      refreshToken,
      refreshExpiry,
      mustChangePassword:    user.debe_cambiar_password,
      nombre:                user.nombre as string,
      rol:                   user.rol as UserRole,
      clienteSlug:           user.cliente_slug ?? null,
      dashboardsDisponibles: [],
    },
  };
}
```

### Step 3: Actualizar auth.service.test.ts

En `src/tests/auth.service.test.ts`, todos los lugares donde se llama `loginUser` y se usa el resultado deben adaptarse al nuevo tipo. Buscar los assertions que asumen el tipo anterior (ej: `result?.accessToken`) y actualizarlos a `(result as any).data?.accessToken` o hacer un type narrowing por `result?.status`.

Los cambios típicos:
- `expect(result).not.toBeNull()` → mantener igual
- `expect(result?.accessToken).toBeDefined()` → `expect((result as any).status).toBe('ok'); expect((result as any).data?.accessToken).toBeDefined()`
- `expect(result).toBeNull()` donde se espera fallo de credenciales → cambiar a `expect((result as any)?.status).toBe('wrong')` o si el usuario no existe `expect((result as any)?.status).toBe('wrong')`

**Leer `auth.service.test.ts` completo** antes de modificar para entender todos los assertions.

### Step 4: Ejecutar todos los tests

```bash
cd e:/develop/dashboardViewer-backend
npm test
```

Expected: PASS — tanto `lockout.service.test.ts` como `auth.service.test.ts` en verde. Si alguno falla, corregir.

### Step 5: Commit

```bash
git add src/modules/auth/auth.service.ts src/tests/auth.service.test.ts
git commit -m "feat(auth): implementar account lockout progresivo en loginUser"
```

---

## Task 5: auth.controller.ts — manejar respuestas de lockout

**Files:**
- Modify: `src/modules/auth/auth.controller.ts`

### Step 1: Actualizar la función `login`

Leer el archivo completo primero. Luego reemplazar la función `login` completa:

```typescript
/** POST /auth/login */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const ip = getClientIp(req);

  try {
    const outcome = await AuthService.loginUser(email, password);

    // Usuario inactivo o cliente inactivo
    if (outcome === null) {
      sendError(res, 401, 'Email o contraseña incorrectos.');
      void audit({ email, accion: AuditAction.LOGIN_FAILED, ip_origen: ip, resultado: AuditResult.UNAUTHORIZED });
      return;
    }

    // Cuenta bloqueada
    if (outcome.status === 'locked') {
      res.status(423).json({
        ok: false,
        error: 'Cuenta bloqueada temporalmente.',
        bloqueado_hasta: outcome.bloqueado_hasta.toISOString(),
      });
      void audit({ email, accion: AuditAction.LOGIN_FAILED, ip_origen: ip, resultado: AuditResult.UNAUTHORIZED });
      return;
    }

    // Credenciales incorrectas
    if (outcome.status === 'wrong') {
      res.status(401).json({
        ok: false,
        error: 'Email o contraseña incorrectos.',
        ...(outcome.intentos_restantes !== null
          ? { intentos_restantes: outcome.intentos_restantes }
          : {}),
      });
      void audit({ email, accion: AuditAction.LOGIN_FAILED, ip_origen: ip, resultado: AuditResult.UNAUTHORIZED });
      return;
    }

    // Login exitoso
    const result = outcome.data;
    setRefreshCookie(res, result.refreshToken, result.refreshExpiry);
    sendOk(res, {
      accessToken:           result.accessToken,
      mustChangePassword:    result.mustChangePassword,
      nombre:                result.nombre,
      rol:                   result.rol,
      clienteSlug:           result.clienteSlug,
      dashboardsDisponibles: result.dashboardsDisponibles,
    });
    void audit({ email, accion: AuditAction.LOGIN, ip_origen: ip, resultado: AuditResult.OK });

  } catch (err) {
    logger.error('Error en login', { error: err });
    sendServerError(res);
  }
}
```

### Step 2: Verificar que los tests siguen pasando

```bash
npm test
```

Expected: PASS.

### Step 3: Commit

```bash
git add src/modules/auth/auth.controller.ts
git commit -m "feat(auth): controller maneja 423 Locked e intentos_restantes"
```

---

## Task 6: users.service.ts — unlockUser y exponer campos de lockout

**Files:**
- Modify: `src/modules/users/users.service.ts`

### Step 1: Leer el archivo completo antes de editar

### Step 2: Agregar función `unlockUser`

Al final del archivo (antes del último export o al final), agregar:

```typescript
/** Desbloquea manualmente una cuenta: resetea intentos, bloqueo y cantidad de bloqueos. */
export async function unlockUser(id: string): Promise<Omit<User, 'password_hash'> | null> {
  const result = await pool.query(
    `UPDATE usuarios
     SET intentos_fallidos = 0,
         bloqueado_hasta   = NULL,
         cantidad_bloqueos = 0
     WHERE id = $1
     RETURNING id, email, nombre, rol, cliente_id, activo,
               debe_cambiar_password, es_kiosk, es_superadmin,
               intentos_fallidos, bloqueado_hasta, cantidad_bloqueos,
               ultimo_acceso, creado_por, creado_en`,
    [id],
  );
  return result.rows[0] ?? null;
}
```

### Step 3: Actualizar SELECT en getAllUsers

En la función `getAllUsers`, agregar los campos de lockout al SELECT:

```sql
SELECT
  u.id, u.email, u.nombre, u.rol, u.cliente_id,
  u.activo, u.debe_cambiar_password, u.es_kiosk, u.es_superadmin,
  u.intentos_fallidos, u.bloqueado_hasta, u.cantidad_bloqueos,
  u.ultimo_acceso, u.creado_por, u.creado_en,
  c.nombre AS cliente_nombre
FROM usuarios u
LEFT JOIN clientes c ON u.cliente_id = c.id
${where}
ORDER BY u.es_superadmin DESC, u.creado_en DESC
```

### Step 4: Actualizar SELECT en getUserById

Agregar los mismos campos de lockout al SELECT de `getUserById`:

```sql
SELECT u.id, u.email, u.nombre, u.rol, u.cliente_id,
       u.activo, u.debe_cambiar_password, u.es_kiosk, u.es_superadmin,
       u.intentos_fallidos, u.bloqueado_hasta, u.cantidad_bloqueos,
       u.ultimo_acceso, u.creado_por, u.creado_en
FROM usuarios u WHERE u.id = $1
```

### Step 5: Commit

```bash
git add src/modules/users/users.service.ts
git commit -m "feat(users): agregar unlockUser y exponer campos de lockout en queries"
```

---

## Task 7: Endpoint admin unlock

**Files:**
- Modify: `src/modules/users/users.controller.ts`
- Modify: `src/modules/users/users.routes.ts`

### Step 1: Leer users.controller.ts completo

### Step 2: Agregar handler `unlock` en users.controller.ts

Al final del archivo agregar:

```typescript
/** POST /admin/users/:id/unlock */
export async function unlock(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  try {
    const user = await UsersService.unlockUser(id);
    if (!user) {
      sendError(res, 404, 'Usuario no encontrado.');
      return;
    }
    sendOk(res, user);
  } catch (err) {
    logger.error('Error al desbloquear usuario', { error: err });
    sendServerError(res);
  }
}
```

### Step 3: Agregar ruta en users.routes.ts

En `src/modules/users/users.routes.ts`, agregar antes del `export default router`:

```typescript
router.post('/:id/unlock', UsersController.idParamValidator, validate, UsersController.unlock);
```

### Step 4: Verificar que todos los tests siguen pasando

```bash
npm test
```

Expected: PASS.

### Step 5: Commit

```bash
git add src/modules/users/users.controller.ts src/modules/users/users.routes.ts
git commit -m "feat(users): agregar endpoint POST /admin/users/:id/unlock"
```

---

## Task 8: Frontend — modelos y UsersService

**Files:**
- Modify: `e:/develop/dashboardViewer-frontend/src/app/core/models/index.ts`
- Modify: `e:/develop/dashboardViewer-frontend/src/app/core/services/users.service.ts`

### Step 1: Agregar campos de lockout a la interfaz User en models/index.ts

Leer el archivo. Agregar al final de la interfaz `User` (en el frontend):

```typescript
  intentos_fallidos?: number;
  bloqueado_hasta?:   string | null;   // ISO string (JSON serializa Date como string)
  cantidad_bloqueos?: number;
```

### Step 2: Agregar método unlock en UsersService

Leer `users.service.ts` del frontend. Agregar método:

```typescript
unlock(id: string): Observable<User> {
  return this.http
    .post<ApiResponse<User>>(`${this.base}/${id}/unlock`, {})
    .pipe(map(requireData));
}
```

### Step 3: Commit en frontend

```bash
cd e:/develop/dashboardViewer-frontend
git add src/app/core/models/index.ts src/app/core/services/users.service.ts
git commit -m "feat(auth): agregar campos de lockout a User y método unlock en UsersService"
```

---

## Task 9: Frontend — Login con feedback de lockout

**Files:**
- Modify: `e:/develop/dashboardViewer-frontend/src/app/modules/auth/login/login.component.ts`
- Modify: `e:/develop/dashboardViewer-frontend/src/app/modules/auth/login/login.component.html`
- Modify: `e:/develop/dashboardViewer-frontend/src/app/modules/auth/login/login.component.scss`

### Step 1: Leer los tres archivos

### Step 2: Modificar login.component.ts

**A) Agregar dos signals nuevas** (junto a las existentes):

```typescript
protected readonly lockoutUntil  = signal<Date | null>(null);
protected readonly attemptsLeft  = signal<number | null>(null);
```

**B) Actualizar `submit()` para manejar el 423 y limpiar estado:**

```typescript
protected submit(): void {
  if (this.form.invalid || this.loading() || !!this.lockoutUntil()) return;
  this.error.set('');
  this.attemptsLeft.set(null);
  this.loading.set(true);

  const { email, password } = this.form.getRawValue();

  this.auth.login(email!, password!).subscribe({
    next: res => {
      this.loading.set(false);
      if (!res.ok) { this.error.set('Email o contraseña incorrectos.'); return; }
      if (res.data?.mustChangePassword) { this.router.navigate(['/change-password']); return; }
      if (res.data?.rol === 'admin_ondra') { this.router.navigate(['/admin/clients']); return; }
      const slug = res.data?.clienteSlug;
      if (slug) this.router.navigate([`/${slug}/dashboards`]);
    },
    error: (err) => {
      this.loading.set(false);
      if (err.status === 423) {
        this.lockoutUntil.set(new Date(err.error?.bloqueado_hasta));
        this.error.set('');
        this.attemptsLeft.set(null);
      } else {
        this.lockoutUntil.set(null);
        const restantes = err?.error?.intentos_restantes ?? null;
        this.attemptsLeft.set(typeof restantes === 'number' ? restantes : null);
        this.error.set('Email o contraseña incorrectos.');
      }
    },
  });
}
```

### Step 3: Actualizar login.component.html

**A) Agregar el bloque de lockout y warning** después del `<div class="login-card__error">` existente (línea 51-54):

```html
      <div class="login-card__lockout" *ngIf="lockoutUntil()">
        <mat-icon>lock</mat-icon>
        Cuenta bloqueada hasta las {{ lockoutUntil() | date:'HH:mm' }} del {{ lockoutUntil() | date:'dd/MM' }}.
        Contactá al administrador para desbloquear antes.
      </div>

      <div class="login-card__warning" *ngIf="attemptsLeft() !== null && !lockoutUntil()">
        <mat-icon>warning_amber</mat-icon>
        {{ attemptsLeft() }} intento{{ attemptsLeft() !== 1 ? 's' : '' }} restante{{ attemptsLeft() !== 1 ? 's' : '' }} antes del bloqueo temporal.
      </div>
```

**B) Deshabilitar el botón submit cuando la cuenta está bloqueada:**

En el botón submit, cambiar `[disabled]="form.invalid || loading()"` a:

```html
[disabled]="form.invalid || loading() || !!lockoutUntil()"
```

### Step 4: Actualizar login.component.scss

Agregar al final del archivo los estilos nuevos (mismo estilo que `.login-card__error` pero con colores distintos):

```scss
.login-card__lockout {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  background: rgba(244, 67, 54, 0.08);
  border: 1px solid rgba(244, 67, 54, 0.25);
  border-radius: 8px;
  color: #ef9a9a;
  font-size: 13px;
  line-height: 1.5;

  mat-icon {
    font-size: 18px;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }
}

.login-card__warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(255, 152, 0, 0.08);
  border: 1px solid rgba(255, 152, 0, 0.25);
  border-radius: 8px;
  color: #ffb74d;
  font-size: 13px;

  mat-icon {
    font-size: 18px;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }
}
```

### Step 5: Commit

```bash
cd e:/develop/dashboardViewer-frontend
git add src/app/modules/auth/login/login.component.ts
git add src/app/modules/auth/login/login.component.html
git add src/app/modules/auth/login/login.component.scss
git commit -m "feat(login): mostrar estado de bloqueo e intentos restantes"
```

---

## Task 10: Frontend — Panel admin/users con botón desbloquear

**Files:**
- Modify: `e:/develop/dashboardViewer-frontend/src/app/modules/admin/pages/users/users-page.component.ts`
- Modify: `e:/develop/dashboardViewer-frontend/src/app/modules/admin/pages/users/users-page.component.html`

### Step 1: Leer ambos archivos completos

### Step 2: Actualizar users-page.component.ts

**A) Agregar helper `isLocked`:**

```typescript
protected isLocked(user: User): boolean {
  return !!user.bloqueado_hasta && new Date(user.bloqueado_hasta) > new Date();
}
```

**B) Agregar método `unlockUser`:**

```typescript
protected unlockUser(user: User): void {
  this.service.unlock(user.id).subscribe({
    next: updated => {
      this.users.update(list => list.map(u => u.id === updated.id ? { ...u, ...updated } : u));
      this.snackbar.open(`Cuenta de ${user.nombre} desbloqueada.`, 'OK', { duration: SNACKBAR_SHORT });
    },
    error: () => {
      this.snackbar.open('Error al desbloquear la cuenta.', 'OK', { duration: SNACKBAR_LONG });
    },
  });
}
```

### Step 3: Actualizar users-page.component.html

**A) Agregar ícono de bloqueo junto al nombre del usuario** (en la celda `matColumnDef="nombre"`, después del ícono de superadmin existente en línea ~22):

```html
<mat-icon *ngIf="isLocked(u)"
  style="font-size: 14px; width: 14px; height: 14px; color: #ef9a9a;"
  matTooltip="Cuenta bloqueada temporalmente">lock</mat-icon>
```

**B) Agregar opción "Desbloquear cuenta" en el menú de acciones** (dentro de `<mat-menu #menu="matMenu">`, después del botón de revocar kiosk y antes del `<ng-container>` del divider/eliminar):

```html
<button mat-menu-item (click)="unlockUser(u)" *ngIf="isLocked(u)">
  <mat-icon>lock_open</mat-icon> Desbloquear cuenta
</button>
```

### Step 4: Commit

```bash
cd e:/develop/dashboardViewer-frontend
git add src/app/modules/admin/pages/users/users-page.component.ts
git add src/app/modules/admin/pages/users/users-page.component.html
git commit -m "feat(admin): botón desbloquear cuenta en panel de usuarios"
```

---

## Task 11: Push ambos repos a main

### Step 1: Backend — merge y push

```bash
cd e:/develop/dashboardViewer-backend
git checkout main
git merge --no-ff develop -m "Merge develop: account lockout progresivo"
git push origin main
git checkout develop
```

### Step 2: Frontend — merge y push

```bash
cd e:/develop/dashboardViewer-frontend
git checkout main
git merge --no-ff develop -m "Merge develop: account lockout progresivo — UI login y admin"
git push origin main
git checkout develop
```
