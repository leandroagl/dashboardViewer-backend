# Docker Compose Deploy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dockerizar el stack completo (backend Node.js + frontend Angular/nginx) para deployar con un solo `docker compose up --build -d`, dejando PostgreSQL externo.

**Architecture:** Dos Dockerfiles multi-stage (uno por repo). El `docker-compose.yml` vive en el backend y referencia el frontend via path relativo. El contenedor frontend maneja SSL montando `/etc/letsencrypt` del host, sirve Angular SPA y proxea `/api/` al backend en la red interna Docker.

**Tech Stack:** Docker 24+, Docker Compose v2, Node.js 18 Alpine, nginx Alpine, TypeScript.

---

## Task 1: Dockerfile del backend

**Files:**
- Create: `Dockerfile` (en raíz del repo backend)
- Create: `.dockerignore` (en raíz del repo backend)

**Step 1: Crear `.dockerignore`**

```
node_modules
dist
.env
.env.test
*.7z
.git
docs
```

**Step 2: Crear `Dockerfile` multi-stage**

```dockerfile
# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:18-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

EXPOSE 3000

# Ejecuta migraciones y arranca el servidor
CMD ["sh", "-c", "node -e \"require('./dist/config/database/migrate.js').default?.().catch(console.error)\" 2>/dev/null; node dist/index.js"]
```

> **Nota:** El migrate.ts exporta la función como default (verificar antes de implementar).
> Si no la exporta, el CMD se simplifica a solo `node dist/index.js` y las migraciones
> se corren manualmente la primera vez.

**Step 3: Verificar que el migrate.ts tiene el export correcto**

Abrir `src/config/database/migrate.ts` y confirmar si la función `migrate()` está exportada.
Si no está exportada como default, el CMD del Dockerfile debe ser simplemente:
```
CMD ["node", "dist/index.js"]
```
Y las migraciones se corren por separado una sola vez:
```bash
docker compose run --rm backend node dist/config/database/migrate.js
```

**Step 4: Build de prueba local (opcional, requiere Docker)**

```bash
cd e:/develop/dashboardViewer-backend
docker build -t ondra-backend-test .
```
Expected: imagen construida sin errores.

**Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(docker): agregar Dockerfile multi-stage del backend"
```

---

## Task 2: nginx.conf del contenedor frontend

**Files:**
- Create: `nginx.conf` (en raíz del repo frontend)

**Step 1: Crear `nginx.conf`**

```nginx
server {
    listen 7695 ssl;
    server_name monitor.ondra.com.ar;

    ssl_certificate     /etc/letsencrypt/live/monitor.ondra.com.ar/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/monitor.ondra.com.ar/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    root  /usr/share/nginx/html;
    index index.html;

    # Proxy al backend en la red interna Docker
    location /api/ {
        proxy_pass         http://backend:3000/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # Assets con caché largo
    location ~* \.(js|css|woff2|woff|ttf|ico|png|svg|webp)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Angular SPA
    location / {
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name monitor.ondra.com.ar;
    return 301 https://$host:7695$request_uri;
}
```

**Step 2: Commit**

```bash
git add nginx.conf
git commit -m "feat(docker): agregar nginx.conf para contenedor frontend"
```

---

## Task 3: Dockerfile del frontend

**Files:**
- Create: `Dockerfile` (en raíz del repo frontend)
- Create: `.dockerignore` (en raíz del repo frontend)

**Step 1: Crear `.dockerignore`**

```
node_modules
dist
.git
docs
*.md
```

**Step 2: Crear `Dockerfile` multi-stage**

```dockerfile
# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:prod

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

# Copiar el build de Angular
COPY --from=builder /app/dist/ondra-monitor/browser /usr/share/nginx/html

# Copiar configuración nginx personalizada
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Eliminar la config default de nginx
RUN rm -f /etc/nginx/conf.d/default.conf.bak 2>/dev/null || true

EXPOSE 7695

CMD ["nginx", "-g", "daemon off;"]
```

**Step 3: Build de prueba local (opcional)**

```bash
cd e:/develop/dashboardViewer-frontend
docker build -t ondra-frontend-test .
```
Expected: imagen construida sin errores (~3-5 min por el build Angular).

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(docker): agregar Dockerfile multi-stage del frontend"
```

---

## Task 4: docker-compose.yml

**Files:**
- Create: `docker-compose.yml` (en raíz del repo backend)

**Step 1: Crear `docker-compose.yml`**

```yaml
services:

  backend:
    build: .
    restart: unless-stopped
    env_file: .env
    networks:
      - ondra
    extra_hosts:
      - "host.docker.internal:host-gateway"   # acceso a PostgreSQL en el host

  frontend:
    build: ../dashboardViewer-frontend
    restart: unless-stopped
    ports:
      - "7695:7695"
      - "80:80"
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro   # certificado SSL del host
    networks:
      - ondra
    depends_on:
      - backend

networks:
  ondra:
    driver: bridge
```

> **Importante:** el path `../dashboardViewer-frontend` asume que ambos repos están
> en el mismo directorio padre en el servidor. Ajustar si la estructura es diferente.

**Step 2: Verificar que `.env` tiene `DB_HOST` correcto**

En el servidor, `DB_HOST` debe ser la **IP LAN del servidor** (ej. `192.168.11.192`),
no `localhost` (que dentro del contenedor apuntaría al propio contenedor).

```bash
# En el servidor, verificar la IP LAN
ip a | grep "inet " | grep -v 127
```

Actualizar `.env`:
```env
DB_HOST=192.168.11.192   # IP LAN del servidor, no localhost
```

**Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(docker): agregar docker-compose.yml"
```

---

## Task 5: Push y guía de migración en el servidor

**Step 1: Push de ambos repos**

```bash
# Backend (develop → main)
cd e:/develop/dashboardViewer-backend
git checkout main && git merge --no-ff develop -m "Merge develop: dockerización"
git push origin main && git checkout develop

# Frontend (develop → main)
cd e:/develop/dashboardViewer-frontend
git checkout main && git merge --no-ff develop -m "Merge develop: dockerización"
git push origin main && git checkout develop
```

**Step 2: En el servidor — instalar Docker**

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker --version        # verificar
docker compose version  # verificar (debe ser v2+)
```

**Step 3: En el servidor — hacer git pull en ambos repos**

```bash
cd /opt/ondra/dashboardViewer-backend && git pull origin main
cd /opt/ondra/dashboardViewer-frontend && git pull origin main
```

**Step 4: En el servidor — actualizar `.env`**

```bash
cd /opt/ondra/dashboardViewer-backend
nano .env
# Cambiar DB_HOST=localhost → DB_HOST=<IP LAN del servidor>
# Verificar que CORS_ORIGIN y COOKIE_DOMAIN estén correctos para producción
```

**Step 5: En el servidor — correr migraciones (primera vez)**

Si el CMD del backend no corre migraciones automáticamente:
```bash
cd /opt/ondra/dashboardViewer-backend
docker compose run --rm backend node dist/config/database/migrate.js
```

**Step 6: En el servidor — levantar el stack**

```bash
cd /opt/ondra/dashboardViewer-backend
docker compose up --build -d
```

Expected: ambos contenedores en estado `Up`. Build tarda ~5 min la primera vez.

**Step 7: Verificar**

```bash
docker compose ps               # ambos servicios "Up"
docker compose logs backend     # sin errores, "corriendo en puerto 3000"
docker compose logs frontend    # nginx iniciado correctamente
curl -sk https://localhost:7695/api/health  # {"ok":true,...}
```

**Step 8: Detener servicios anteriores**

```bash
sudo systemctl stop ondra-monitor
sudo systemctl disable ondra-monitor
sudo systemctl stop nginx
sudo systemctl disable nginx
```

> ⚠️ Solo deshabilitar nginx nativo si el contenedor frontend ya está sirviendo
> correctamente en el puerto 7695.

---

## Flujo de actualización post-deploy

```bash
cd /opt/ondra/dashboardViewer-backend && git pull origin main
cd /opt/ondra/dashboardViewer-frontend && git pull origin main
cd /opt/ondra/dashboardViewer-backend
docker compose up --build -d
```

Docker Compose reemplaza solo los contenedores cuya imagen cambió.
Los contenedores sin cambios siguen corriendo sin downtime.
