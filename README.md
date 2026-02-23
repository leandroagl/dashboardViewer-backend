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
# Crear la base de datos en PostgreSQL
createdb ondra_monitor
```

> Si la DB corre en Docker:
> ```bash
> docker exec <contenedor-postgres> psql -U ondra -d ondra_monitor -c "SELECT 1"
> ```

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

## Build de producción

```bash
npm run build
```

Compila TypeScript a `dist/`. El artefacto resultante es JS puro ejecutable con Node.js, sin dependencias de TypeScript en runtime.

```bash
# Probar el build localmente antes de desplegar
node dist/index.js
```

> El build requiere que `.env` esté presente con todas las variables de producción configuradas.

---

## Despliegue en Windows Server

### Requisitos previos

| Componente | Versión mínima | Descarga |
|------------|----------------|----------|
| Node.js    | 18 LTS         | https://nodejs.org |
| PostgreSQL | 14+            | https://www.postgresql.org/download/windows |
| PM2        | última         | `npm install -g pm2` |

### 1. Instalar dependencias del sistema

```powershell
# Verificar instalaciones
node --version    # >= 18.x
npm --version

# Instalar PM2 y su integración con Windows Service
npm install -g pm2
npm install -g pm2-windows-service
```

### 2. Configurar PostgreSQL

```sql
-- En psql o pgAdmin, crear usuario y base de datos:
CREATE USER ondra WITH PASSWORD 'password_seguro';
CREATE DATABASE ondra_monitor OWNER ondra;
GRANT ALL PRIVILEGES ON DATABASE ondra_monitor TO ondra;
```

### 3. Desplegar la aplicación

```powershell
# Copiar el proyecto al servidor, por ejemplo: C:\apps\ondra-monitor-backend\

# Instalar solo dependencias de producción (sin devDependencies)
npm install --omit=dev

# Crear y configurar .env (ver sección Variables de entorno)
# Valores clave para producción:
#   NODE_ENV=production
#   COOKIE_SECURE=true
#   COOKIE_DOMAIN=monitor.ondra.com.ar
#   CORS_ORIGIN=https://monitor.ondra.com.ar

# Compilar TypeScript a JavaScript
npm run build

# Ejecutar migraciones (idempotente, seguro de re-ejecutar)
npm run db:migrate

# Crear usuario administrador inicial (solo la primera vez)
npm run db:seed
```

### 4. Iniciar con PM2 como servicio de Windows

```powershell
# Iniciar la aplicación
pm2 start dist/index.js --name ondra-monitor-backend

# Guardar la lista de procesos
pm2 save

# Registrar PM2 como servicio de Windows
# (se inicia automáticamente con el servidor, sin login de usuario)
pm2-service-install

# Verificar estado
pm2 status
pm2 logs ondra-monitor-backend
```

### 5. (Opcional) Proxy inverso con IIS

Para exponer el backend en HTTPS a través de IIS:

1. Instalar **URL Rewrite** y **Application Request Routing (ARR)** desde el Web Platform Installer de IIS
2. En IIS Manager → Server level → Application Request Routing → Enable Proxy
3. Crear un sitio web en IIS y agregar el siguiente `web.config`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="API Proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:3000/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

### Comandos de operación

```powershell
pm2 status                         # Estado de todos los procesos
pm2 logs ondra-monitor-backend     # Logs en tiempo real
pm2 restart ondra-monitor-backend  # Reiniciar (tras actualización)
pm2 stop ondra-monitor-backend     # Detener
pm2 delete ondra-monitor-backend   # Eliminar del registro de PM2
```

### Proceso de actualización

```powershell
# 1. Copiar los nuevos archivos al servidor
# 2. Instalar dependencias si cambiaron
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

Todas las respuestas siguen la misma estructura:

```json
// Éxito
{ "ok": true, "data": { ... }, "meta": { ... } }

// Error
{ "ok": false, "error": "Mensaje descriptivo" }
```

---

## Variables de entorno de referencia

| Variable                   | Descripción                                 | Prod recomendado        |
|----------------------------|---------------------------------------------|-------------------------|
| `PORT`                     | Puerto del servidor                         | `3000`                  |
| `NODE_ENV`                 | Entorno                                     | `production`            |
| `CORS_ORIGIN`              | Origen permitido para CORS                  | URL del frontend        |
| `DB_HOST`                  | Host de PostgreSQL                          | `localhost`             |
| `DB_PORT`                  | Puerto PostgreSQL                           | `5432`                  |
| `DB_NAME`                  | Nombre de la base de datos                  | `ondra_monitor`         |
| `DB_USER`                  | Usuario PostgreSQL                          | `ondra`                 |
| `DB_PASSWORD`              | Contraseña PostgreSQL                       | —                       |
| `JWT_ACCESS_SECRET`        | Secreto access tokens (mín. 32 chars)       | Cadena aleatoria fuerte |
| `JWT_REFRESH_SECRET`       | Secreto refresh tokens (mín. 32 chars)      | Cadena aleatoria fuerte |
| `JWT_ACCESS_EXPIRES_IN`    | Expiración access token                     | `5h`                    |
| `JWT_REFRESH_EXPIRES_IN`   | Expiración refresh token                    | `7d`                    |
| `PRTG_BASE_URL`            | URL base de la API PRTG                     | `https://prtg.host`     |
| `PRTG_API_TOKEN`           | Token de API de PRTG                        | —                       |
| `PRTG_REJECT_UNAUTHORIZED` | Validar TLS de PRTG                         | `false` (cert propio)   |
| `PRTG_SUBGROUPS`           | Subgrupos PRTG a consultar (coma-separados) | —                       |
| `COOKIE_DOMAIN`            | Dominio de la cookie de sesión              | `monitor.ondra.com.ar`  |
| `COOKIE_SECURE`            | Cookie solo sobre HTTPS                     | `true`                  |
