# CLAUDE.md — Heimdall Server

Prozessregeln, Identität und Commit-Konventionen → `../CLAUDE.md` (Root)

---

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

---

## Stack

Next.js 16 (App Router) · React 19 · NextAuth v5 (JWT + Credentials) · Prisma 5 + SQLite · Tailwind v4 · TypeScript 5

---

## Auth-Ebenen (zwei getrennte!)

| Ebene | Wo | Mechanismus |
|---|---|---|
| **Session-Auth** | `/dashboard/*`, `/api/admin/*`, `/api/settings/*` | NextAuth JWT, Session-Cookie |
| **Token-Auth** | `/api/box/*` | `Authorization: Bearer <token>` → bcrypt gegen `Device.tokenHash` |

Middleware: `src/proxy.ts` — öffentliche Routen: `/login`, `/api/auth/*`, `/api/box/*`, `/api/version`

---

## DB-Modelle

| Modell | Zweck |
|---|---|
| `User` | Keyholder-Konten (`admin` / `viewer`) |
| `Device` | Die Lockbox — Token-Hash, letzter gemeldeter Zustand |
| `LockPolicy` | Soll-Policy pro Gerät (`lockUntil`, `offlineOpenHours`) |
| `DeviceEvent` | Zustandsübergänge: `LOCKED` / `UNLOCKED` / `FAILSAFE_OPEN` / `UNAUTHORIZED_OPEN` |
| `RateLimit` | Login-Rate-Limiting |
| `AppMeta` | KV-Store für Metadaten |
| `TrackerInstance` | chastitytracker.ch-Deployment (name/baseUrl/apiKey); N Boxen : 1 Instanz |

Alle Relations mit `onDelete: Cascade`.

---

## Box-API-Kontrakt

**Token-Format:** 16-Zeichen Base32 in 4er-Gruppen (`XK7F-M2PQ-9TRW-4VNB`, ~80 Bit).
Bindestriche werden vor dem Hashing entfernt. Nur einmalig angezeigt.

```
POST /api/box/register   → Erstanmeldung, liefert Config (lockUntil, offlineOpenHours, ...)
POST /api/box/sync       → Jedes Aufwachen: State rein, Soll-Zustand raus
```

**Sync-Logik:**
1. Token verifizieren → 401 wenn ungültig
2. Device-Zustand updaten (locked, battery, boltPos, fwVersion, lastSyncAt, wakeReason)
3. Zustandsübergang erkennen → `DeviceEvent` erstellen
4. `lockUntil = effectiveLockUntil(policy)` — eigene + aus dem Tracker gezogene Sperrzeit, die spätere gewinnt
5. Tracker-Sync-Stub (Feature-Flag `TRACKER_SYNC_ENABLED=false`)

---

## Key Files

```
src/lib/auth.ts                               ← NextAuth v5 Credentials
src/lib/device-auth.ts                        ← Token-Verifikation + effectiveLockUntil()
src/lib/authGuards.ts                         ← requireAdminApi() / requireSessionApi()
src/lib/actions.ts                            ← Server Actions (handleSignOut)
src/lib/utils.ts                              ← generateProvisioningToken(), formatDateTime()
src/lib/prisma.ts                             ← Prisma-Client Singleton
src/proxy.ts                                  ← Middleware: Route-Schutz + Rate-Limit

src/app/api/box/register/route.ts             ← Box-Erstanmeldung
src/app/api/box/sync/route.ts                 ← Box-Sync (Kernlogik)
src/app/api/admin/devices/route.ts            ← GET (Liste) / POST (Anlegen + Token)
src/app/api/admin/devices/[deviceId]/route.ts ← DELETE Gerät
src/app/api/admin/devices/[deviceId]/token/route.ts   ← POST Token neu generieren
src/app/api/admin/devices/[deviceId]/policy/route.ts  ← PATCH Lock-Policy
src/app/api/admin/users/route.ts              ← GET / POST Konten
src/app/api/admin/users/[userId]/route.ts     ← PATCH (PW reset) / DELETE
src/app/api/settings/password/route.ts        ← PATCH eigenes Passwort

src/app/dashboard/page.tsx                    ← Gerätestatus-Übersicht
src/app/dashboard/policy/page.tsx             ← Sperrzeit setzen
src/app/dashboard/events/page.tsx             ← Event-Log
src/app/dashboard/devices/page.tsx            ← Geräteliste + Aktionen
src/app/dashboard/devices/new/page.tsx        ← Gerät anlegen + Token einmalig anzeigen
src/app/dashboard/settings/page.tsx           ← Eigenes Passwort ändern
src/app/admin/users/page.tsx                  ← Keyholder-Konten (Admin)
src/app/admin/users/[userId]/page.tsx         ← PW zurücksetzen (Admin)
```

---

## Komponenten (`src/app/components/`)

`Card`, `Button`, `Badge`, `Input`, `FormError` — alle anderen Komponenten vor Neubau prüfen.

---

## ENV

```
NEXTAUTH_SECRET=
NEXTAUTH_URL=https://heimdall.trublue.ch
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
```

**Tracker-Anbindung:** kein globales Env mehr — multi-tenant über die DB. Jede
`TrackerInstance` {name, baseUrl, apiKey} wird unter „Tracker" angelegt; eine Box wird
ihr auf der Geräte-Detailseite zugeordnet (`trackerInstanceId` + `trackerUsername`, per
Name — kein cuid-Lookup). Die Box ist generisch (keine feste KG-Zuordnung). `apiKey` == das
`HEIMDALL_SYNC_SECRET` der jeweiligen Tracker-Instanz.

`DATABASE_URL` wird im Container via Entrypoint auf `file:/app/data/prod.db` gesetzt.
