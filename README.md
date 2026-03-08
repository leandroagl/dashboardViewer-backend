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

## Despliegue en Ubuntu Server con Docker

El sistema completo (backend + frontend + PostgreSQL) corre como contenedores Docker
orquestados con Docker Compose. El archivo `docker-compose.yml` se encuentra en este
repositorio (`dashboardViewer-backend/`).

### 1. Preparar el servidor Ubuntu

```bash
# Actualizar el sistema
sudo apt update && sudo apt upgrade -y

# Instalar dependencias necesarias para agregar repositorios externos
sudo apt install -y ca-certificates curl gnupg
```

### 2. Instalar Docker Engine

Ubuntu no incluye Docker en sus repositorios base. Se instala desde el repositorio oficial:

```bash
# Agregar la clave GPG oficial de Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Agregar el repositorio de Docker
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Instalar Docker Engine y Docker Compose
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Verificar instalación
docker --version
docker compose version
```

Agregar el usuario actual al grupo `docker` para no necesitar `sudo` en cada comando:

```bash
sudo usermod -aG docker $USER
# Cerrar sesión y volver a entrar para que el cambio de grupo tome efecto
```

### 3. Obtener el certificado SSL (Let's Encrypt)

El contenedor nginx monta `/etc/letsencrypt` del host para servir HTTPS en el puerto 7695.
Certbot debe correr **antes** del primer `docker compose up` porque el puerto 80 tiene que
estar libre para el challenge HTTP:

```bash
sudo apt install -y certbot

# Obtener el certificado (reemplazar con el dominio real)
sudo certbot certonly --standalone -d monitor.ondra.com.ar

# Verificar que los archivos existen
sudo ls /etc/letsencrypt/live/monitor.ondra.com.ar/
# Debe listar: cert.pem  chain.pem  fullchain.pem  privkey.pem
```

> **Renovación automática:** certbot instala un timer de systemd que renueva el
> certificado automáticamente antes de que expire. Verificar con:
> `sudo systemctl status certbot.timer`
>
> Tras la renovación es necesario recargar nginx: agregar un deploy hook en
> `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`:
> ```bash
> #!/bin/sh
> docker compose -f /opt/ondra/dashboardViewer-backend/docker-compose.yml \
>   exec frontend nginx -s reload
> ```
> ```bash
> sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
> ```

### 4. Clonar los repositorios

```bash
sudo mkdir -p /opt/ondra
cd /opt/ondra

# Clonar ambos repositorios (el docker-compose del backend referencia al frontend por ruta relativa)
sudo git clone <url-repo-backend> dashboardViewer-backend
sudo git clone <url-repo-frontend> dashboardViewer-frontend

# Asignar permisos al usuario actual
sudo chown -R $USER:$USER /opt/ondra
```

### 5. Crear el archivo `.env`

```bash
cp /opt/ondra/dashboardViewer-backend/.env.example /opt/ondra/dashboardViewer-backend/.env
nano /opt/ondra/dashboardViewer-backend/.env
```

Contenido del archivo:

```env
# ─── Servidor ────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://monitor.ondra.com.ar:7695

# ─── Base de datos (nombre del servicio en docker-compose) ───────────────────
DB_HOST=postgres
DB_PORT=5432
DB_NAME=ondra_monitor
DB_USER=ondra
DB_PASSWORD=<contraseña_segura_para_postgres>

# ─── JWT (mínimo 32 caracteres cada secreto, valores distintos entre sí) ─────
JWT_ACCESS_SECRET=<cadena_aleatoria_minimo_32_caracteres>
JWT_REFRESH_SECRET=<cadena_aleatoria_diferente_minimo_32_caracteres>
JWT_ACCESS_EXPIRES_IN=5h
JWT_REFRESH_EXPIRES_IN=7d

# ─── PRTG ────────────────────────────────────────────────────────────────────
PRTG_BASE_URL=https://<ip-o-hostname-prtg>
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

Proteger el archivo `.env`:

```bash
chmod 600 /opt/ondra/dashboardViewer-backend/.env
```

### 6. Levantar los contenedores

```bash
cd /opt/ondra/dashboardViewer-backend

# Construir las imágenes y levantar en segundo plano
docker compose up -d --build
```

Docker Compose:
1. Levanta PostgreSQL y espera a que esté saludable (`healthcheck`)
2. Levanta el backend — el `entrypoint.sh` ejecuta las migraciones automáticamente
3. Levanta el frontend (nginx con el build de Angular)

Verificar que todos los contenedores están corriendo:

```bash
docker compose ps
# Los tres servicios deben mostrar estado "running" (o "healthy")
```

### 7. Inicializar el administrador (solo la primera vez)

```bash
docker compose exec backend node dist/config/database/seed.js
# ¡IMPORTANTE! Copiar la contraseña mostrada en consola — no se vuelve a mostrar
```

### 8. Verificar el deploy

```bash
# Comprobar que el backend responde
curl http://localhost:3000/health

# Ver los logs de todos los servicios
docker compose logs -f

# Ver logs de un servicio específico
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

El portal debe ser accesible en `https://monitor.ondra.com.ar:7695`.

---

### Comandos de operación diaria

```bash
cd /opt/ondra/dashboardViewer-backend

# Estado de todos los contenedores
docker compose ps

# Logs en tiempo real
docker compose logs -f

# Reiniciar un servicio
docker compose restart backend

# Detener todo
docker compose down

# Detener y eliminar volúmenes (¡BORRA la base de datos!)
docker compose down -v
```

Acceder a PostgreSQL directamente:

```bash
docker compose exec postgres psql -U ondra -d ondra_monitor
```

---

### Proceso de actualización

```bash
cd /opt/ondra/dashboardViewer-backend

# 1. Traer los cambios del repositorio
git pull origin main
cd ../dashboardViewer-frontend && git pull origin main
cd ../dashboardViewer-backend

# 2. Reconstruir y reiniciar (las migraciones corren solas en el entrypoint)
docker compose up -d --build

# 3. Verificar que todo levantó correctamente
docker compose ps
docker compose logs -f backend
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
