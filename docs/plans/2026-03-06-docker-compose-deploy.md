# Design: Dockerización del stack ONDRA Monitor

## Objetivo

Reemplazar el deploy manual (systemd + nginx nativo + Node.js instalado en el host) por
un stack Docker Compose autocontenido. PostgreSQL permanece externo en esta etapa.

## Arquitectura target

```
Host (Ubuntu)
├── nginx nativo → ELIMINADO
├── systemd ondra-monitor → ELIMINADO
├── Node.js instalado → no requerido en runtime
├── PostgreSQL (nativo) → sin cambios
│
└── Docker Compose
    ├── backend   (Node.js 18 Alpine, puerto 3000 interno)
    └── frontend  (nginx Alpine, puerto 7695 publicado → SSL + SPA + proxy /api/)
```

## Archivos nuevos

| Archivo | Repo | Descripción |
|---------|------|-------------|
| `Dockerfile` | backend | Multi-stage: builder (tsc) + runtime (node slim) |
| `docker-compose.yml` | backend | Orquesta ambos servicios |
| `Dockerfile` | frontend | Multi-stage: builder (ng build) + runtime (nginx) |
| `nginx.conf` | frontend | Config nginx del contenedor (SSL + SPA + proxy) |

## Decisiones clave

- **DB externa**: `DB_HOST` apunta a la IP LAN del servidor (ej. `192.168.11.192`),
  no a `localhost` (que dentro del contenedor resuelve al propio contenedor)
- **SSL dentro del contenedor**: el contenedor frontend monta `/etc/letsencrypt`
  del host como volumen read-only para acceder al cert de Let's Encrypt
- **`.env` nunca en imagen**: se pasa como `env_file` en docker-compose, vive solo en el host
- **Migraciones automáticas**: el entrypoint del backend corre `npm run db:migrate`
  antes de iniciar el servidor, igual que antes pero dentro del contenedor

## Proceso de migración en el servidor

1. Detener servicios actuales (systemd + nginx nativo)
2. Instalar Docker + Docker Compose en el servidor
3. Clonar ambos repos (si no están) o hacer `git pull`
4. Ajustar `.env`: cambiar `DB_HOST` de `localhost` a la IP LAN
5. `docker compose up --build -d`
6. Verificar logs y health del backend
7. Eliminar o deshabilitar nginx nativo y el servicio systemd

## Flujo de actualización post-deploy

```bash
cd /opt/ondra/dashboardViewer-backend && git pull
cd /opt/ondra/dashboardViewer-frontend && git pull
cd /opt/ondra/dashboardViewer-backend
docker compose up --build -d
```
