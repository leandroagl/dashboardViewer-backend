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

## Despliegue en Linux (Ubuntu 22.04 / Debian 12)

En Linux el proceso Node.js se gestiona con **systemd**, que viene incluido en el sistema
operativo. No es necesario instalar PM2 ni NSSM — systemd se encarga de arrancar el servicio
automáticamente con el sistema y de reiniciarlo si cae.

### 1. Instalar Node.js 18

Ubuntu y Debian no incluyen Node.js 18 en sus repositorios base. Se instala desde el
repositorio oficial de NodeSource:

```bash
# Agregar el repositorio de Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -

# Instalar Node.js (incluye npm)
sudo apt install -y nodejs

# Verificar versiones
node --version   # debe mostrar v18.x.x
npm --version
```

### 2. Instalar PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib

# Verificar que el servicio está corriendo
sudo systemctl status postgresql
```

### 3. Crear el usuario y base de datos PostgreSQL

PostgreSQL en Linux usa autenticación por sistema operativo para el usuario `postgres`.
Hay que entrar con ese usuario para ejecutar comandos SQL:

```bash
# Entrar al cliente psql como superusuario de postgres
sudo -u postgres psql
```

Dentro de psql, ejecutar:

```sql
-- Crear el usuario de la aplicación
CREATE USER ondra WITH PASSWORD 'contraseña_segura';

-- Crear la base de datos
CREATE DATABASE ondra_monitor OWNER ondra;

-- Otorgar todos los permisos
GRANT ALL PRIVILEGES ON DATABASE ondra_monitor TO ondra;

-- Salir de psql
\q
```

Verificar que la conexión funciona:

```bash
# Intentar conectarse con el usuario recién creado
psql -U ondra -d ondra_monitor -h localhost -c "SELECT 1;"
# Debe mostrar: ?column? = 1
```

> Si da error de autenticación, editar `/etc/postgresql/<versión>/main/pg_hba.conf`
> y cambiar el método de autenticación para `localhost` de `peer` a `md5`, luego
> reiniciar PostgreSQL: `sudo systemctl restart postgresql`

### 4. Crear usuario del sistema para correr la aplicación

Por seguridad, el proceso Node.js no debe correr como `root`. Se crea un usuario del sistema
sin shell de login dedicado para la aplicación:

```bash
# Crear usuario del sistema (sin directorio home, sin shell de login)
sudo useradd --system --no-create-home --shell /bin/false monitor-app
```

### 5. Ubicar el código en el servidor

```bash
# Crear el directorio de la aplicación
sudo mkdir -p /opt/ondra/dashboardViewer-backend

# Copiar el código del repositorio al servidor
# (desde la máquina de desarrollo, o clonar directamente si hay acceso a git)
# Ejemplo con scp desde la máquina de desarrollo:
# scp -r /ruta/local/dashboardViewer-backend/* usuario@servidor:/opt/ondra-monitor/backend/

# Asignar el usuario ondra-app como dueño de los archivos
sudo chown -R monitor-app:monitor-app /opt/ondra/dashboardViewer-backend
```

### 6. Crear el archivo `.env` de producción

```bash
sudo nano /opt/ondra/dashboardViewer-backend/.env
```

Contenido del archivo:

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

Generar los JWT secrets con:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Ejecutar dos veces — usar valores distintos para ACCESS y REFRESH
```

Proteger el archivo para que solo `monitor-app` pueda leerlo:

```bash
sudo chown monitor-app:monitor-app /opt/ondra/dashboardViewer-backend/.env
sudo chmod 600 /opt/ondra/dashboardViewer-backend/.env
```

### 7. Instalar dependencias y compilar

```bash
cd /opt/ondra-monitor/backend

# Instalar dependencias (como el usuario ondra-app para mantener permisos)
sudo -u ondra-app npm install

# Compilar TypeScript → dist/
sudo -u ondra-app npm run build

# Verificar que el build levanta correctamente (Ctrl+C para detener)
sudo -u ondra-app node dist/index.js
```

> Si aparece "Permission denied" al correr npm, verificar que el directorio
> pertenece a `monitor-app`: `ls -la /opt/ondra/`

### 8. Ejecutar migraciones e inicializar admin

```bash
cd /opt/ondra-monitor/backend

# Crear las tablas en la base de datos (idempotente — seguro de re-ejecutar)
sudo -u ondra-app npm run db:migrate

# Crear el usuario administrador inicial (solo la primera vez)
sudo -u ondra-app npm run db:seed
# ¡IMPORTANTE! Copiar la contraseña mostrada en consola — no se vuelve a mostrar
```

### 9. Crear el servicio systemd

systemd es el gestor de servicios de Linux. Crear el archivo de servicio:

```bash
sudo nano /etc/systemd/system/ondra-monitor.service
```

Contenido exacto del archivo:

```ini
[Unit]
Description=ONDRA Monitor — Backend API
# El servicio arranca después de que la red y PostgreSQL estén listos
After=network.target postgresql.service

[Service]
Type=simple
# El proceso corre con el usuario sin privilegios que creamos
User=ondra
Group=ondra
WorkingDirectory=/opt/ondra/dashboardViewer-backend
# Comando para iniciar la aplicación
ExecStart=/usr/bin/node dist/index.js
# Si el proceso muere, systemd lo reinicia automáticamente
Restart=always
RestartSec=10
# Variables de entorno cargadas desde el archivo .env
EnvironmentFile=/opt/ondra/dashboardViewer-backend/.env
# Los logs van a journald (ver con: journalctl -u ondra-monitor)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ondra-monitor

[Install]
# El servicio se activa en el target normal del sistema (arranque estándar)
WantedBy=multi-user.target
```

### 10. Habilitar y arrancar el servicio

```bash
# Recargar la lista de servicios de systemd (necesario tras crear/editar un .service)
sudo systemctl daemon-reload

# Habilitar el servicio: se iniciará automáticamente al arrancar el servidor
sudo systemctl enable ondra-monitor

# Iniciar el servicio ahora
sudo systemctl start ondra-monitor

# Verificar que está corriendo correctamente
sudo systemctl status ondra-monitor
```

La salida de `status` debe mostrar `active (running)` en verde. Ejemplo:

```
● ondra-monitor.service - ONDRA Monitor — Backend API
     Loaded: loaded (/etc/systemd/system/ondra-monitor.service; enabled)
     Active: active (running) since ...
```

### 11. Comandos de operación diaria

```bash
# Ver estado del servicio
sudo systemctl status ondra-monitor

# Ver logs en tiempo real (Ctrl+C para salir)
sudo journalctl -u ondra-monitor -f

# Ver los últimos 50 líneas de log
sudo journalctl -u ondra-monitor -n 50

# Ver logs de hoy
sudo journalctl -u ondra-monitor --since today

# Reiniciar el servicio (necesario tras actualizar el código)
sudo systemctl restart ondra-monitor

# Detener el servicio
sudo systemctl stop ondra-monitor

# Deshabilitar el inicio automático (no lo elimina, solo evita que arranque solo)
sudo systemctl disable ondra-monitor
```

### Proceso de actualización en Linux

```bash
# 1. Ir al directorio del backend
cd /opt/ondra-monitor/backend

# 2. Copiar los nuevos archivos al servidor (o hacer git pull si hay acceso)
# scp -r /ruta/local/build/* usuario@servidor:/opt/ondra-monitor/backend/

# 3. Corregir permisos si es necesario
sudo chown -R ondra-app:ondra-app /opt/ondra-monitor/backend

# 4. Instalar dependencias nuevas o actualizadas
sudo -u ondra-app npm install

# 5. Recompilar TypeScript
sudo -u ondra-app npm run build

# 6. Ejecutar migraciones (idempotente — no borra datos existentes)
sudo -u ondra-app npm run db:migrate

# 7. Reiniciar el servicio para aplicar los cambios
sudo systemctl restart ondra-monitor

# 8. Verificar que quedó corriendo
sudo systemctl status ondra-monitor
sudo journalctl -u ondra-monitor -n 20
```

---

## Endpoints principales

### Autenticación

| Método | Ruta                    | Descripción                          |
| ------ | ----------------------- | ------------------------------------ |
| POST   | `/auth/login`           | Login con email/contraseña           |
| POST   | `/auth/refresh`         | Renovar access token                 |
| POST   | `/auth/logout`          | Cerrar sesión                        |
| POST   | `/auth/change-password` | Cambio de contraseña (requiere auth) |

### Dashboards (requiere auth + acceso al cliente)

| Método | Ruta                                 | Descripción              |
| ------ | ------------------------------------ | ------------------------ |
| GET    | `/:clientSlug/dashboards`            | Dashboards disponibles   |
| GET    | `/:clientSlug/dashboards/servers`    | Dashboard VMware         |
| GET    | `/:clientSlug/dashboards/backups`    | Dashboard Backups        |
| GET    | `/:clientSlug/dashboards/networking` | Dashboard Networking     |
| GET    | `/:clientSlug/dashboards/windows`    | Dashboard Windows Server |

### Administración (solo admin_ondra)

| Método | Ruta                              | Descripción                   |
| ------ | --------------------------------- | ----------------------------- |
| GET    | `/admin/clients`                  | Listar clientes               |
| POST   | `/admin/clients`                  | Crear cliente                 |
| PATCH  | `/admin/clients/:id`              | Editar cliente                |
| PATCH  | `/admin/clients/:id/status`       | Activar/desactivar cliente    |
| GET    | `/admin/users`                    | Listar usuarios               |
| POST   | `/admin/users`                    | Crear usuario (pwd auto)      |
| PATCH  | `/admin/users/:id/status`         | Activar/desactivar usuario    |
| POST   | `/admin/users/:id/reset-password` | Resetear contraseña           |
| POST   | `/admin/users/:id/revoke-kiosk`   | Revocar sesión kiosk          |
| GET    | `/admin/logs`                     | Logs con filtros y paginación |
| GET    | `/admin/logs/suspicious-ips`      | IPs con intentos fallidos     |
| GET    | `/admin/logs/export`              | Exportar logs a CSV           |

---

## Formato de respuesta

```json
// Éxito
{ "ok": true, "data": { ... }, "meta": { ... } }

// Error
{ "ok": false, "error": "Mensaje descriptivo" }
```
