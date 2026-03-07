# Design: Account Lockout Progresivo

## Problema

El backend ya tiene IP rate limiting (10 intentos/10min), pero un atacante con múltiples IPs puede hacer credential stuffing sin ser bloqueado. Se necesita bloqueo a nivel de cuenta por email.

## Requisitos

- 10 intentos fallidos → bloqueo automático
- Duración progresiva: 1º bloqueo 5min, 2º 15min, 3º+ 1h
- Admin puede desbloquear manualmente desde el panel
- Frontend muestra intentos restantes (cuando ≤5) y tiempo de desbloqueo
- Tests de integración incluidos (Jest + PostgreSQL real, igual que auth.service.test.ts)

## Base de datos

Tres columnas nuevas en `usuarios` (idempotentes con `ADD COLUMN IF NOT EXISTS`):

```sql
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta     TIMESTAMPTZ NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cantidad_bloqueos   INTEGER     NOT NULL DEFAULT 0;
```

- `intentos_fallidos`: contador de intentos desde el último bloqueo (o desde siempre si nunca se bloqueó)
- `bloqueado_hasta`: NULL = desbloqueado, timestamp futuro = bloqueado hasta esa fecha
- `cantidad_bloqueos`: contador histórico de bloqueos, determina la duración progresiva. Se resetea a 0 en login exitoso.

## Backend

### `auth.service.ts` — `loginUser()` refactorizado

Nuevo tipo de retorno discriminado:

```typescript
type LoginResult =
  | { status: 'ok';     data: LoginSuccess }
  | { status: 'locked'; bloqueado_hasta: Date }
  | { status: 'wrong';  intentos_restantes: number | null }
  | null  // usuario inactivo o cliente inactivo
```

Flujo:
1. Buscar usuario por email incluyendo campos de lockout
2. Si `bloqueado_hasta > NOW()` → retornar `{ status: 'locked', bloqueado_hasta }`
3. Ejecutar bcrypt siempre (dummy hash si no existe, anti timing-attack)
4. Si credenciales inválidas y usuario existe:
   - `intentos_fallidos++`
   - Si `intentos_fallidos >= 10`:
     - Duración: `cantidad_bloqueos=0` → 5min | `=1` → 15min | `>=2` → 60min
     - `SET bloqueado_hasta = NOW() + duración, cantidad_bloqueos++, intentos_fallidos = 0`
     - Retornar `{ status: 'locked', bloqueado_hasta }`
   - Sino: retornar `{ status: 'wrong', intentos_restantes: 10 - intentos_fallidos }` (solo si ≤5 restantes, sino null)
5. Si credenciales válidas:
   - `SET intentos_fallidos = 0, bloqueado_hasta = NULL, cantidad_bloqueos = 0`
   - Continuar con flujo normal → retornar `{ status: 'ok', data: ... }`

### `auth.controller.ts` — `login()`

- `status: 'locked'` → HTTP 423 con `{ ok: false, error: "Cuenta bloqueada.", bloqueado_hasta: ISO }`
- `status: 'wrong'` → HTTP 401 con `{ ok: false, error: "Email o contraseña incorrectos.", intentos_restantes: N | null }`
- `null` → HTTP 401 sin info extra (usuario inactivo)

### `users.service.ts` — nueva función `unlockUser(id)`

```typescript
export async function unlockUser(id: string): Promise<boolean>
// SET intentos_fallidos=0, bloqueado_hasta=NULL, cantidad_bloqueos=0
// Retorna false si el usuario no existe
```

`getAllUsers()` y `getUserById()` incluyen `intentos_fallidos`, `bloqueado_hasta`, `cantidad_bloqueos` en el SELECT.

### `users.routes.ts` + `users.controller.ts`

Nuevo endpoint: `POST /admin/users/:id/unlock`
- Solo admin_ondra (ya cubierto por `router.use(authenticate, requireAdmin)`)
- Llama `UsersService.unlockUser(id)`
- Retorna el usuario actualizado

### `src/types/index.ts`

Agregar al tipo `User`:
```typescript
intentos_fallidos?: number;
bloqueado_hasta?:   string | null;
cantidad_bloqueos?: number;
```

## Tests de integración

Nuevo archivo `src/tests/lockout.service.test.ts` usando la misma infraestructura (`db.helper.ts`):

Casos a cubrir:
- 9 intentos fallidos no bloquean
- Intento 10 bloquea con duración 5min (primer bloqueo)
- Cuenta bloqueada retorna `status: 'locked'` sin importar la contraseña
- Login exitoso resetea todos los contadores
- Segundo bloqueo (tras reset) → 15min
- Tercer bloqueo → 60min
- Admin unlock resetea el estado → login vuelve a funcionar
- Intentos restantes: se informa cuando ≤5 quedan

## Frontend

### `src/app/core/models/index.ts`

Agregar a `User`:
```typescript
intentos_fallidos?: number;
bloqueado_hasta?:   string | null;
cantidad_bloqueos?: number;
```

### `AuthService` + `login.component`

El interceptor ya maneja 401. El 423 es nuevo: el frontend lo parsea y muestra el estado bloqueado.

`login.component.ts` — 2 signals nuevos:
- `lockoutUntil = signal<Date | null>(null)` — si != null, cuenta bloqueada
- `attemptsLeft = signal<number | null>(null)` — si != null y ≤5, mostrar advertencia

`login.component.html` — estados nuevos:
- `lockoutUntil()` → mostrar mensaje de bloqueo con hora de desbloqueo, deshabilitar formulario
- `attemptsLeft()` → mostrar warning "X intentos restantes antes del bloqueo temporal"

### Panel admin — usuarios

En la tabla de usuarios, el menú de acciones muestra "Desbloquear cuenta" cuando `bloqueado_hasta` es una fecha futura. `UsersService.unlock(id)` llama `POST /admin/users/:id/unlock`.

## Archivos afectados

### Backend (7)
- `src/config/database/migrate.ts` — 3 columnas nuevas
- `src/modules/auth/auth.service.ts` — lockout en loginUser()
- `src/modules/auth/auth.controller.ts` — handle 423/intentos_restantes
- `src/modules/users/users.service.ts` — unlockUser() + campos en queries
- `src/modules/users/users.controller.ts` — handler unlock
- `src/modules/users/users.routes.ts` — POST /:id/unlock
- `src/types/index.ts` — campos lockout en User

### Tests (1)
- `src/tests/lockout.service.test.ts` — 8 test cases

### Frontend (4)
- `src/app/core/models/index.ts` — campos lockout en User
- `src/app/modules/auth/login/login.component.ts` — signals lockout/attempts
- `src/app/modules/auth/login/login.component.html` — UI lockout/warning
- `src/app/modules/admin/pages/users/users-page.component.html` — botón unlock
- `src/app/core/services/users.service.ts` — método unlock()
