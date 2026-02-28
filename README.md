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

## Setup local (desarrollo)

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

### 6. Iniciar en desarrollo

```bash
npm run dev   # ts-node-dev con hot reload en http://localhost:3000
```

---

## Despliegue en Windows Server

El backend corre como servicio de Windows gestionado por **PM2**. PostgreSQL se asume ya instalado en el servidor.

### Requisitos previos

| Componente | Versión mínima | Instalación |
|------------|----------------|-------------|
| Node.js    | 18 LTS         | https://nodejs.org |
| PM2        | última         | `npm install -g pm2` |
| NSSM       | última         | https://nssm.cc/download (para PM2 como servicio) |

```powershell
node --version    # verificar >= 18.x
npm install -g pm2
```

### 1. Preparar la base de datos

En psql o pgAdmin, crear usuario y base de datos:

```sql
CREATE USER ondra WITH PASSWORD 'password_seguro';
CREATE DATABASE ondra_monitor OWNER ondra;
GRANT ALL PRIVILEGES ON DATABASE ondra_monitor TO ondra;
```

### 2. Ubicar el código en el servidor

Copiar el repositorio completo al servidor. Ruta recomendada:

```
C:\apps\ondra-monitor\backend\
```

### 3. Crear el archivo `.env` de producción

Crear `C:\apps\ondra-monitor\backend\.env` con los valores reales:

```env
# ─── Servidor ────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://monitor.ondra.com.ar

# ─── Base de datos ───────────────────────────────────────────────────────────
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ondra_monitor
DB_USER=ondra
DB_PASSWORD=<contraseña_postgres>

# ─── JWT (mínimo 32 caracteres cada secreto, valores distintos entre sí) ─────
JWT_ACCESS_SECRET=<cadena_aleatoria_minimo_32_caracteres>
JWT_REFRESH_SECRET=<cadena_aleatoria_diferente_minimo_32_caracteres>
JWT_ACCESS_EXPIRES_IN=5h
JWT_REFRESH_EXPIRES_IN=7d

# ─── PRTG ────────────────────────────────────────────────────────────────────
PRTG_BASE_URL=https://prtg.ondra.local
# Opción A: API Token (Setup → My Account → API Token)
PRTG_API_TOKEN=<token>
# Opción B: usuario + passhash (tiene prioridad si ambos están definidos)
# PRTG_USERNAME=
# PRTG_PASSHASH=
PRTG_REJECT_UNAUTHORIZED=false
PRTG_SUBGROUPS=Windows Server,Networking,Servers,Backups,Switches,Antenas PTP

# ─── Cookies ─────────────────────────────────────────────────────────────────
COOKIE_DOMAIN=monitor.ondra.com.ar
COOKIE_SECURE=true
```

> **Seguridad:** `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` deben ser cadenas aleatorias únicas
> de al menos 32 caracteres. Generarlas con:
> ```powershell
> node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
> ```
> El archivo `.env` nunca debe commitearse ni compartirse. Tratarlo con el mismo cuidado que
> una contraseña de base de datos.

### 4. Instalar dependencias y compilar

```powershell
cd C:\apps\ondra-monitor\backend

# Solo dependencias de producción
npm install --omit=dev

# Compilar TypeScript → dist/
npm run build

# Verificar que el build levanta (Ctrl+C para detener)
node dist/index.js
```

### 5. Ejecutar migraciones e inicializar admin

```powershell
# Migraciones (idempotente — seguro de re-ejecutar en cada actualización)
npm run db:migrate

# Crear el usuario administrador inicial (solo la primera vez)
npm run db:seed
# IMPORTANTE: copiar la contraseña mostrada en consola — no se vuelve a mostrar
```

### 6. Iniciar con PM2 y configurar servicio de Windows

```powershell
# Iniciar la aplicación
pm2 start dist/index.js --name ondra-monitor-backend

# Verificar que está corriendo
pm2 status
pm2 logs ondra-monitor-backend --lines 20

# Guardar la lista de procesos activos
pm2 save
```

Para que PM2 arranque automáticamente con Windows (sin necesidad de login de usuario),
instalar PM2 como servicio de Windows usando NSSM:

```powershell
# Obtener la ruta del ejecutable pm2
where pm2
# Ejemplo: C:\Users\<usuario>\AppData\Roaming\npm\pm2.cmd

# Instalar el servicio (reemplazar la ruta por la real)
nssm install PM2 "C:\Users\<usuario>\AppData\Roaming\npm\pm2.cmd" "resurrect"

# Configurar el directorio de trabajo
nssm set PM2 AppDirectory "C:\apps\ondra-monitor\backend"

# Iniciar el servicio
nssm start PM2

# Verificar estado
nssm status PM2
```

> El servicio PM2 lee el estado guardado con `pm2 save` y levanta todos los procesos
> registrados al iniciar Windows.

### 7. Comandos de operación

```powershell
pm2 status                          # Estado de todos los procesos
pm2 logs ondra-monitor-backend      # Logs en tiempo real
pm2 restart ondra-monitor-backend   # Reiniciar (tras actualización)
pm2 stop ondra-monitor-backend      # Detener
```

### Proceso de actualización

```powershell
# 1. Copiar los nuevos archivos al servidor
# 2. Instalar dependencias si cambiaron
cd C:\apps\ondra-monitor\backend
npm install --omit=dev
# 3. Recompilar
npm run build
# 4. Migrar la base de datos (idempotente)
npm run db:migrate
# 5. Reiniciar
pm2 restart ondra-monitor-backend
```

---

## Endpoints principales

### Autenticación

| Método | Ruta                    | Descripción                          |
|--------|-------------------------|--------------------------------------|
| POST   | `/auth/login`           | Login con email/contraseña           |
| POST   | `/auth/refresh`         | Renovar access token                 |
| POST   | `/auth/logout`          | Cerrar sesión                        |
| POST   | `/auth/change-password` | Cambio de contraseña (requiere auth) |

### Dashboards (requiere auth + acceso al cliente)

| Método | Ruta                                 | Descripción              |
|--------|--------------------------------------|--------------------------|
| GET    | `/:clientSlug/dashboards`            | Dashboards disponibles   |
| GET    | `/:clientSlug/dashboards/servers`    | Dashboard VMware         |
| GET    | `/:clientSlug/dashboards/backups`    | Dashboard Backups        |
| GET    | `/:clientSlug/dashboards/networking` | Dashboard Networking     |
| GET    | `/:clientSlug/dashboards/windows`    | Dashboard Windows Server |

### Administración (solo admin_ondra)

| Método | Ruta                                 | Descripción                    |
|--------|--------------------------------------|--------------------------------|
| GET    | `/admin/clients`                     | Listar clientes                |
| POST   | `/admin/clients`                     | Crear cliente                  |
| PATCH  | `/admin/clients/:id`                 | Editar cliente                 |
| PATCH  | `/admin/clients/:id/status`          | Activar/desactivar cliente     |
| GET    | `/admin/users`                       | Listar usuarios                |
| POST   | `/admin/users`                       | Crear usuario (pwd auto)       |
| PATCH  | `/admin/users/:id/status`            | Activar/desactivar usuario     |
| POST   | `/admin/users/:id/reset-password`    | Resetear contraseña            |
| POST   | `/admin/users/:id/revoke-kiosk`      | Revocar sesión kiosk           |
| GET    | `/admin/logs`                        | Logs con filtros y paginación  |
| GET    | `/admin/logs/suspicious-ips`         | IPs con intentos fallidos      |
| GET    | `/admin/logs/export`                 | Exportar logs a CSV            |

---

## Formato de respuesta

```json
// Éxito
{ "ok": true, "data": { ... }, "meta": { ... } }

// Error
{ "ok": false, "error": "Mensaje descriptivo" }
```
