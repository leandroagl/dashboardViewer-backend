# ONDRA Monitor Backend — Lineamientos para Claude

Este archivo complementa el CLAUDE.md raíz (`e:\develop\CLAUDE.md`), que documenta el stack,
la estructura de carpetas, el setup local y los endpoints. Acá se registran los patrones de
implementación establecidos durante el desarrollo y code review del proyecto.

---

## Base de datos

### Transacciones para operaciones multi-step

Cuando una operación requiere más de una escritura relacionada (UPDATE + UPDATE, o SELECT +
DELETE), usar una transacción explícita con `pool.connect()`. Nunca usar `pool.query()` para
ambas llamadas por separado.

```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(/* primera escritura */);
  await client.query(/* segunda escritura */);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release(); // siempre liberar, incluso si hubo error
}
```

**Casos donde aplica obligatoriamente:**
- Cambio de contraseña + revocación de refresh tokens
- Desactivación de usuario + revocación de refresh tokens
- Reset de contraseña + revocación de refresh tokens
- DELETE con pre-check (verificar condición y eliminar como unidad atómica)

### Incrementos de contadores: atómico en SQL, no en JS

No leer un valor numérico en JS, incrementarlo, y escribirlo de vuelta. Dos requests
concurrentes con credenciales incorrectas leerían el mismo valor y escribirían el mismo
número, perdiendo un intento.

```typescript
// MAL — race condition
const nuevoIntentos = (user.intentos_fallidos ?? 0) + 1;
await pool.query(`UPDATE usuarios SET intentos_fallidos = $1 WHERE id = $2`, [nuevoIntentos, id]);

// BIEN — atómico
const result = await pool.query(
  `UPDATE usuarios SET intentos_fallidos = intentos_fallidos + 1
   WHERE id = $1 RETURNING intentos_fallidos`,
  [id]
);
const nuevoIntentos = result.rows[0].intentos_fallidos;
```

### Queries de DB solo en el service layer

Los controllers no importan `pool` ni ejecutan queries directamente. Toda lógica de base de
datos va en el servicio correspondiente (`*.service.ts`).

La única excepción aceptada es el health check en `index.ts`.

### Discriminated unions para resultados de operaciones de delete

En lugar de lanzar excepciones para casos de negocio esperados, el servicio retorna un tipo
discriminado que el controller mapea al HTTP status correspondiente:

```typescript
export type DeleteClientResult = 'deleted' | 'not_found' | 'has_active_users';
```

Esto distingue errores de negocio (manejables) de errores reales (que sí deben propagarse
como excepciones y resultar en 500).

---

## Cache

### Las cache keys deben incluir todos los parámetros que afectan el resultado

Las funciones de dashboard reciben `prtgGroup` y `extraProbes`. Ambos determinan el conjunto
de sensores que devuelve PRTG. Si la cache key solo incluye `prtgGroup`, dos clientes con el
mismo grupo pero distintas `extraProbes` comparten cache y uno ve los datos del otro.

```typescript
// MAL — tenant data leak si dos clientes tienen el mismo prtgGroup
const cacheKey = `vmware:${prtgGroup}`;

// BIEN — incluir todas las variables que determinan el resultado
const cacheKey = `vmware:${[prtgGroup, ...extraProbes].sort().join(",")}`;
```

---

## Auditoría

Las siguientes operaciones registran un evento en `audit_logs`. Al agregar nuevas operaciones,
verificar si corresponde agregar una acción al enum `AuditAction` en `src/types/index.ts`.

| Operación                        | AuditAction          | Resultado             |
|----------------------------------|----------------------|-----------------------|
| Login exitoso                    | `LOGIN`              | `OK`                  |
| Login fallido                    | `LOGIN_FAILED`       | `ERROR`               |
| Logout                           | `LOGOUT`             | `OK`                  |
| Refresh de token                 | `TOKEN_REFRESH`      | `OK`                  |
| Ver dashboard (cada endpoint)    | `DASHBOARD_VIEW`     | `OK`                  |
| Acceso a cliente ajeno (403)     | `ACCESS_DENIED`      | `UNAUTHORIZED`        |
| Crear usuario                    | `USER_CREATED`       | `OK`                  |
| Activar usuario                  | `USER_ACTIVATED`     | `OK`                  |
| Desactivar usuario               | `USER_DEACTIVATED`   | `OK`                  |
| Desbloquear usuario              | `USER_UNLOCKED`      | `OK`                  |
| Eliminar usuario                 | `USER_DELETED`       | `OK`                  |
| Reset de contraseña              | `PASSWORD_RESET`     | `OK`                  |
| Revocar sesión kiosk             | `KIOSK_REVOKED`      | `OK`                  |
| Modificar configuración cliente  | `CONFIG_MODIFIED`    | `OK`                  |
| Eliminar cliente                 | `CLIENT_DELETED`     | `OK`                  |
| Purga de logs                    | `LOGS_PURGE`         | `OK`                  |

---

## Seguridad

### Validar UUIDs en query params antes de pasarlos a PostgreSQL

Los parámetros `cliente_id` y `usuario_id` recibidos como query strings deben validarse como
UUID. Sin validación, un valor como `"abc"` hace que PostgreSQL lance un error de tipo que
resulta en un 500 en lugar de un 400 descriptivo.

```typescript
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

### Sanitizar mensajes de error antes de propagarlos hacia afuera

Los errores de red de node-fetch pueden incluir la URL completa en el mensaje, que contiene el
API token de PRTG. Al re-lanzar errores que provienen de llamadas a PRTG, sanear el mensaje:

```typescript
const rawMessage = (err as Error).message ?? 'PRTG connection error';
throw new Error(rawMessage.replace(/apitoken=[^&\s]+/gi, 'apitoken=***'));
```

### `purgeLogs` requiere fecha explícita

El endpoint `DELETE /admin/logs/purge` exige el parámetro `antes_de` (fecha ISO). No está
permitido hacer una purga sin filtro de fecha. La función `purgeLogs(antes_de: string)` en el
servicio tiene el parámetro como obligatorio por diseño.

---

## PRTG

### Errores de subgrupo no se silencian

El fetch por subgrupo usa `.catch()` para degradar graciosamente si un subgrupo falla, pero
el error debe loguearse como `warn` para que sea detectable:

```typescript
.catch((err: unknown) => {
  logger.warn("PRTG subgroup fetch failed", { sub, error: (err as Error).message });
  return [] as PrtgSensor[];
})
```

Un `.catch(() => [])` sin log impide diagnosticar fallas parciales de PRTG en producción.
