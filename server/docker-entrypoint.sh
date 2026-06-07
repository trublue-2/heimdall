#!/bin/sh
set -e

chown -R www-data:www-data /app/data 2>/dev/null || chmod -R a+w /app/data 2>/dev/null || true

PRISMA_CLI="node ./node_modules/prisma/build/index.js"
export DATABASE_URL="file:/app/data/prod.db"

echo "┌─────────────────────────────────────────────────────┐"
echo "│  HEIMDALL SERVER STARTUP                            │"
printf "│  ADMIN_USERNAME : %-34s│\n" "${ADMIN_USERNAME:-'(nicht gesetzt → admin)'}"
if [ -n "$ADMIN_PASSWORD" ]; then
  printf "│  ADMIN_PASSWORD : %-34s│\n" "(gesetzt, ${#ADMIN_PASSWORD} Zeichen)"
else
  printf "│  ADMIN_PASSWORD : %-34s│\n" "(nicht gesetzt → admin123)"
fi
printf "│  NEXTAUTH_URL   : %-34s│\n" "${NEXTAUTH_URL:-'(nicht gesetzt)'}"
printf "│  DATABASE_URL   : %-34s│\n" "file:/app/data/prod.db"
echo "└─────────────────────────────────────────────────────┘"

echo "→ Datenbankmigrationen anwenden..."
su-exec www-data sh -c "$PRISMA_CLI migrate deploy --schema ./prisma/schema.prisma"

echo "→ Admin-User anlegen (falls nötig)..."
su-exec www-data sh -c "node scripts/seed.js"

echo "→ App starten..."
exec su-exec www-data node server.js
