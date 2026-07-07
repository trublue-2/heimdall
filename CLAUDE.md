# CLAUDE.md — Heimdall

Dieses File steuert das Verhalten von Claude Code in diesem Repository.

---

## Projekt-Identität — kritisch

- **Maintainer:** `trublue-2 <info@trublue.ch>`
- **SSH-Alias:** `github-trublue` mit Key `~/.ssh/id_ed25519_trublue`
- **`jfahrni` darf nirgends erscheinen** — nicht im Code, nicht in Commits, nicht als Author, nicht in Kommentaren.
- **Git-Push immer via:** `GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_trublue" git push origin main`
- **Remote:** `git@github-trublue:trublue-2/heimdall.git`

---

## Repo-Struktur

```
heimdall/
├── server/      ← Next.js-Steuerserver (aktive Entwicklung)
├── firmware/    ← ESP32-Firmware (noch Platzhalter)
└── docs/        ← Konzeptdokumente
```

Technische Details zum Server: → `server/CLAUDE.md`

---

## Prozessregeln

### Nach jeder Code-Ausgabe: /simplify ausführen

Nach dem Schreiben von Code **immer** `/simplify` ausführen:
- Ist jede neue Funktion/Komponente wirklich nötig?
- Kann Logik inline bleiben statt ausgelagert zu werden?
- Gibt es bestehende Utilities/Komponenten, die das schon lösen?
- Enthält der Code Abstraktionen, die erst bei 3+ Verwendungen gerechtfertigt sind?

Ziel: kein Over-Engineering. Weniger Code ist besser als mehr Code.

### Klärende Fragen stellen, wenn:

- Die Absicht unklar oder mehrdeutig ist
- Mehrere technische Ansätze möglich sind und der Trade-off nicht offensichtlich ist
- Die Aufgabe Architekturentscheidungen beinhaltet (neue Tabelle, neue Route, neue Komponente)
- Feldnamen, Geschäftsregeln oder Details nicht explizit spezifiziert sind
- Eine Implementierung bestehende Funktionalität berührt

**Lieber einmal zu viel fragen als eine falsche Annahme bauen.**

### Plan vorlegen & auf Freigabe warten, wenn:

- Die Aufgabe mehr als ~3 Dateien betrifft
- Mehrere gültige Lösungsansätze existieren
- Bestehende Kernfunktionalität geändert wird (Auth, Box-API, Schema)
- Neue DB-Modelle oder Migrations nötig sind

### Vor der Ausführung bestätigen, wenn:

- Daten oder Dateien unwiderruflich gelöscht werden
- Prisma-Migrations ausgeführt werden (Prod-Daten!)
- Breaking Changes an der Box-API eingeführt werden
- Das erwartete Ergebnis nicht explizit benannt ist

---

## Sicherheits-Prinzipien (für Box-Logik)

**Safety > Security > Function** — in dieser Reihenfolge, ohne Ausnahmen.

- Lokale Failsafes (low-battery, offline-timeout, hard-deadline) können **nicht** durch den Server deaktiviert werden
- Jede Änderung an `effectiveLockUntil()` braucht explizite Überprüfung dieser Failsafe-Invariante

---

## Architektur-Konventionen

### Wiederverwendung vor Neubau

- **Vor jeder neuen Komponente/Funktion:** `grep` in `src/app/components/` und `src/lib/` — existiert das schon?
- Gleicher JSX in >1 Datei → sofort extrahieren. Auch 10-Zeilen-Blöcke.
- Gleiche Lookup-Konstanten → in `src/lib/utils.ts` oder eigenem Konstanten-File, nicht lokal in Seiten.

### Form-Konventionen

- **Loading-State** heisst immer `saving` (nicht `isLoading`, nicht `pending`)
- **Fehler-Anzeige** immer über `<FormError message={error} />` — kein inline-styled Error
- **Network-Errors** immer via `try/catch` mit User-Feedback — kein unhandled Promise
- **Nach Submit:** entweder `router.refresh()` (gleiche Seite) oder `router.push(ziel)` — nie beides

### API-Routen

- Session-geschützt: `requireSessionApi()` aus `src/lib/authGuards.ts`
- Admin-only: `requireAdminApi()` aus `src/lib/authGuards.ts`
- Box-Routen: `authenticateDevice()` aus `src/lib/device-auth.ts` — kein Session-Auth

### Design System

- **Keine Magic Numbers.** Alle Farben, Abstände, Radii aus CSS-Custom-Properties (`var(--...)`)
- **Keine externen UI-Libraries.** Nur die eigenen Komponenten in `src/app/components/`
- Token-Semantik: `--color-lock-*` (gesperrt/aktiv), `--color-unlock-*` (offen), `--color-warn-*` (gefährlich)

---

## Commit-Konventionen

Erlaubte `type`-Werte: `feat`, `fix`, `security`, `perf`, `chore`, `ui`

Format:
```
<type>: <beschreibung in imperativ, deutsch oder englisch>

Co-Authored-By: trublue-2 <info@trublue.ch>
```

**Kein `jfahrni` im Co-Author-Feld.**

---

## CI/CD

- **Trigger:** Push auf `main`, Pfad `server/**`
- **Jobs:** `typecheck` → `build-and-push` (GHCR) → `deploy` (SSH, environment `kink`)
- **Vor dem Push:** `npx tsc --noEmit` im `server/`-Verzeichnis — TypeScript-Fehler blockieren den Build
- **Image:** `ghcr.io/trublue-2/heimdall:latest`
- **Deploy-Pfad:** via Secret `DEPLOY_PATH` (kein trailing newline — wird im Script gestripped)
