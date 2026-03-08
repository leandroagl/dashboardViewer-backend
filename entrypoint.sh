#!/bin/sh
set -e

echo "Ejecutando migraciones..."
node dist/config/database/migrate.js

echo "Iniciando servidor..."
exec node dist/index.js
