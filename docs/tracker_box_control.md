# Box-Steuerung im Tracker — Spec

Ziel: Der Sub steuert die Heimdall-Box **aus dem chastitytracker** (seine Haupt-App) —
keine zweite App, kein zweiter Login. Stand: 2026-06-13.

## Leitprinzipien
- **Heimdall bleibt der aktive Part.** Es *pusht* den Box-Status und *zieht* Kommandos —
  beides über den bestehenden Shared-Secret-Kanal. **Keine neue Auth-Richtung.**
- **Latenz wie heute:** die Box führt alles beim nächsten Wake / Tasterdruck aus.
- **Öffnen ist eine Anforderung, keine Garantie** — wer öffnen darf, entscheiden die Regeln
  (Sperrzeit / Reinigung), nicht der freie Wille des Subs.
- **Keine Kachel.** Ein einziger, zustands-bewusster Eintrag unter dem **(+)**.

## Der (+)-Eintrag „Box" — vier Zustände
| Box-Zustand | (+) zeigt | Aktion |
|---|---|---|
| **offen** | „Box verschliessen" | → zu **ohne Zeit** (Simple-Lock) |
| **zu, ohne Zeit** (Sub hat selbst zugemacht) | „Box öffnen" | → öffnet (Hoheit des Subs) |
| **zu, mit Zeit / Sperrzeit** | „Box zu · bis HH:MM" (ausgegraut) | nicht öffenbar — Notfall-Übersteuern bleibt in **Heimdall** |
| **zu, Sperrzeit + Reinigung erlaubt + im Fenster + Kontingent übrig** | „🧽 Reinigung: öffnen (Fenster 19–20, noch 1/2, max 15 Min)" | → öffnet zur Reinigung, Re-Lock-Frist läuft |

## Datenfluss (pro Box-Sync, wenn trackerSync an)
1. **Status push** Heimdall → Tracker: `POST /api/integration/box/status`
   - meldet: `boxId` (Heimdall-Geräte-id), `name`, `locked`, effektives `lockUntil`,
     `simpleLock`, `keyholderLocked`, `battery`, `charging`, `boltPos`, `fwVersion`, `lastSyncAt`
   - meldet `lastAppliedCommand` → Tracker löscht ein erledigtes `pendingCommand`
   - **Antwort:** das aktuelle `pendingCommand` (`lock` | `open` | `clean_open` + ggf. `relockBy`)
2. **Config pull** (bestehend, erweitert): `GET /api/integration/box/config` → `sperrzeit` (wie bisher).
3. Heimdall **wendet das Kommando an** (lock→Simple-Lock, open→öffnen, clean_open→öffnen + Re-Lock-Frist)
   und meldet's beim nächsten Status-Push als `lastAppliedCommand` zurück.

## Reinigung (Regel-Hoheit liegt beim Tracker)
Config lebt in **Tracker → Einstellungen → REINIGUNG** (existiert grösstenteils schon):
- `reinigungErlaubt` (Toggle „Reinigungspausen erlauben")
- `reinigungMaxMinuten` (Max. Dauer = Re-Lock-Fenster, z.B. 15)
- `reinigungMaxProTag` (Max. Öffnungen/Tag = Kontingent, z.B. 2; 0 = unbegrenzt)
- **NEU: `reinigungsFenster`** — Öffnungs-Fenster (z.B. `[{start:"19:00",end:"20:00"}]`). Fehlt noch.

Ablauf „Reinigung öffnen":
- Der **Tracker** prüft beim Klick: `erlaubt && im Fenster && Kontingent übrig` →
  setzt `pendingCommand="clean_open"` mit `relockBy = jetzt + maxMinuten`, zählt den Tageszähler hoch.
- **Heimdall** zieht's, öffnet, merkt sich die Re-Lock-Frist. Re-Lock fristgerecht → dieselbe Session.
  Überzug → Verstoss (Strafbuch-Fakt).
- Verpasstes Fenster / Kontingent aus → der (+)-Eintrag zeigt „zu bis HH:MM" (keine Reinigung).

## Datenmodell (Tracker, feat/heimdall-integration)
- **`BoxStatus`** pro `(userId, boxId)`: Status-Felder (s.o.) + `pendingCommand`, `pendingCommandRelockBy`, `pendingCommandAt`.
- **User**: `+ reinigungsFenster Json?`.

## Bau-Reihenfolge
1. **Backend** — `BoxStatus`-Modell + `POST /box/status` (Tracker); `pushBoxStatus` + Command-Pull/Anwenden (Heimdall).
2. **(+)-Eintrag simpel** — verschliessen / öffnen (eigene Zeit) / „zu bis HH:MM".
3. **Reinigung** — `reinigungsFenster`-Setting (UI) + Clean-Open-Pfad im (+)-Eintrag + Re-Lock-Frist.

## Offen / bewusst ausgeklammert
- **Notfall-Übersteuern** einer laufenden Zeit bleibt in Heimdall (Notfall-Satz).
- Mehrere Boxen pro User: `BoxStatus` ist pro `boxId` — der (+)-Eintrag listet alle gemappten Boxen.
- Box ↔ KG-Verknüpfung: bewusst **keine** (Box ist generisch); welches KG getragen wird, weiss der Tracker aus der Lock-Session.
