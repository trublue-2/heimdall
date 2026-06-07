# CLAUDE.md — Heimdall Server

## Projektübersicht

Next.js-Steuerserver für die Heimdall-Lockbox (ESP32). Verwaltet Sperrzeit-Policy, authentifiziert die Box per Token und loggt reale Hardware-Events.

## Commands

```bash
npm run dev      # Dev-Server (http://localhost:3000)
npm run build    # Produktions-Build
npm run start    # Produktions-Server

# Prisma
DATABASE_URL="file:./dev.db" npx prisma migrate dev --name <name>
DATABASE_URL="file:./dev.db" npx prisma studio
npx prisma generate
```

## Architektur

**Stack:** Next.js 16 (App Router) · React 19 · NextAuth v5 (JWT + Credentials) · Prisma 5 + SQLite · Tailwind v4 · TypeScript 5

**Auth-Ebenen (zwei getrennte!):**
- **Session-Auth** (NextAuth JWT): Browser-Keyholder-UI → alle `/dashboard/*` und `/api/admin/*` Routen
- **Token-Auth** (Device-Token): ESP32-Box → `/api/box/*` Routen — kein Session-Cookie, stattdessen `Authorization: Bearer <token>`

**Box-API-Kontrakt:**
- `POST /api/box/register` → Erstanmeldung, liefert Config zurück
- `POST /api/box/sync` → Jedes Aufwachen, State-Übergabe, Rückmeldung mit aktuellem Soll-Zustand

**Token-Format:** 16-Zeichen Base32 in 4er-Gruppen (`XK7F-M2PQ-9TRW-4VNB`). Bindestriche werden vor dem Hashing entfernt. Nur einmalig angezeigt — danach nur bcrypt-Hash in DB.

**DB-Modelle:**
- `User` — Keyholder-Konten (admin/viewer)
- `Device` — Die Lockbox (Token-Hash, letzter Zustand)
- `LockPolicy` — Soll-Policy pro Gerät (lockUntil, offlineOpenHours, hardCapHours)
- `DeviceEvent` — Alle Zustandsübergänge der Box (LOCKED/UNLOCKED/FAILSAFE_OPEN/UNAUTHORIZED_OPEN)
- `RateLimit` — Rate-Limiting für Login
- `AppMeta` — KV-Store für Metadaten

**Key files:**
- `src/lib/auth.ts` — NextAuth v5 Credentials
- `src/lib/device-auth.ts` — Token-Verifikation + effectiveLockUntil()
- `src/proxy.ts` — Middleware: Session-Schutz + Rate-Limit
- `src/app/api/box/register/route.ts` — Box-Erstanmeldung
- `src/app/api/box/sync/route.ts` — Box-Sync (Kern der Anwendung)
- `src/app/dashboard/page.tsx` — Gerätestatus-Übersicht
- `src/app/dashboard/policy/page.tsx` — Sperrzeit setzen
- `src/app/dashboard/events/page.tsx` — Event-Log
- `src/app/dashboard/devices/new/page.tsx` — Gerät anlegen + Token anzeigen

**Tracker-Sync:** Feature-Flag `TRACKER_SYNC_ENABLED=false`. Stub in `src/app/api/box/sync/route.ts` vorbereitet.

## Design System

Exakt wie chastitytracker — gleiche CSS-Custom-Properties in `globals.css`:
- `--color-lock-*` (emerald, gesperrt)
- `--color-unlock-*` (sky-blue, offen)
- `--color-warn-*` (rot, gefährlich)

Komponenten in `src/app/components/` — Card, Button, Badge, Input, FormError.

## Konventionen

- Loading-State heisst `saving`
- API-Routen prüfen Session mit `requireAdminApi()` oder `requireSessionApi()` aus `authGuards.ts`
- Box-Routen prüfen Token mit `authenticateDevice()` aus `device-auth.ts`
- Kein `jfahrni` im Code, keine persönlichen Referenzen
- Copyright: trublue-2
