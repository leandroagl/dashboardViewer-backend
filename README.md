# ONDRA Monitor — Backend API

API REST para el Portal de Monitoreo de Infraestructura de ONDRA Sistemas.

## Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Lenguaje:** TypeScript
- **Base de datos:** PostgreSQL 14+
- **Autenticación:** JWT (access token en memoria + refresh token en cookie HttpOnly)
- **Integración:** PRTG Network Monitor API REST

---

## Estructura del proyecto

```
src/
├── config/
│   ├── env.ts                  # Variables de entorno validadas
│   └── database/
│       ├── pool.ts             # Pool de conexiones PostgreSQL
│       ├── migrate.ts          # Script de migraciones
│       └── seed.ts             # Seed del primer admin
├── middleware/
│   ├── authenticate.ts         # Guards JWT (authenticate, requireAdmin, requireClientAccess)
│   ├── auditLogger.ts          # Registro de auditoría
│   ├── errorHandler.ts         # Manejo global de errores
│   └── validate.ts             # Validación de requests (express-validator)
├── modules/
│   ├── auth/                   # Login, logout, refresh, cambio de contraseña
│   ├── clients/                # ABM de clientes (admin_ondra only)
│   ├── users/                  # ABM de usuarios (admin_ondra only)
│   ├── logs/                   # Logs de auditoría con filtros y exportación CSV
│   ├── prtg/                   # Cliente HTTP para la API de PRTG
│   └── dashboards/             # Detección automática y transformación de datos
├── types/
│   └── index.ts                # Tipos, enums e interfaces globales
└── utils/
    ├── logger.ts               # Logger Winston
    ├── password.ts             # Generación y validación de contraseñas
    └── response.ts             # Helpers de respuesta HTTP consistentes
```

---

## Setup

### 1. Variables de entorno

```bash
cp .env.example .env
# Editar .env con los valores correspondientes
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Crear base de datos

```bash
# Crear la base de datos en PostgreSQL
createdb ondra_monitor
```

### 4. Ejecutar migraciones

```bash
npm run db:migrate
```

### 5. Crear usuario administrador inicial

```bash
npm run db:seed
# La contraseña generada se muestra UNA SOLA VEZ en consola
```

### 6. Iniciar el servidor

```bash
# Desarrollo (con hot reload)
npm run dev

# Producción
npm run build && npm start
```

---

## Endpoints principales

### Autenticación

| Método | Ruta                   | Descripción                          |
|--------|------------------------|--------------------------------------|
| POST   | `/auth/login`          | Login con email/contraseña           |
| POST   | `/auth/refresh`        | Renovar access token                 |
| POST   | `/auth/logout`         | Cerrar sesión                        |
| POST   | `/auth/change-password`| Cambio de contraseña (requiere auth) |

### Dashboards (requiere auth + acceso al cliente)

| Método | Ruta                              | Descripción                     |
|--------|-----------------------------------|---------------------------------|
| GET    | `/:clientSlug/dashboards`         | Dashboards disponibles          |
| GET    | `/:clientSlug/dashboards/servers` | Dashboard VMware                |
| GET    | `/:clientSlug/dashboards/backups` | Dashboard Backups Veeam         |
| GET    | `/:clientSlug/dashboards/networking` | Dashboard Networking         |
| GET    | `/:clientSlug/dashboards/windows` | Dashboard Windows Server        |

### Administración (solo admin_ondra)

| Método | Ruta                           | Descripción                    |
|--------|--------------------------------|--------------------------------|
| GET    | `/admin/clients`               | Listar clientes                |
| POST   | `/admin/clients`               | Crear cliente                  |
| PATCH  | `/admin/clients/:id`           | Editar cliente                 |
| PATCH  | `/admin/clients/:id/status`    | Activar/desactivar cliente     |
| GET    | `/admin/users`                 | Listar usuarios                |
| POST   | `/admin/users`                 | Crear usuario (pwd auto)       |
| PATCH  | `/admin/users/:id/status`      | Activar/desactivar usuario     |
| POST   | `/admin/users/:id/reset-password` | Resetear contraseña         |
| POST   | `/admin/users/:id/revoke-kiosk`| Revocar sesión kiosk           |
| GET    | `/admin/logs`                  | Logs con filtros y paginación  |
| GET    | `/admin/logs/suspicious-ips`   | IPs con intentos fallidos      |
| GET    | `/admin/logs/export`           | Exportar logs a CSV            |

---

## Formato de respuesta

Todas las respuestas siguen la misma estructura:

```json
// Éxito
{ "ok": true, "data": { ... }, "meta": { ... } }

// Error
{ "ok": false, "error": "Mensaje descriptivo" }
```
