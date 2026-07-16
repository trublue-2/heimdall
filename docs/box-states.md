# Box-Zustände — Referenz

Warum die Box auf/zu ist, entscheidet **eine** Funktion: `boxLocked(policy, now)` in
`server/src/lib/device-auth.ts`. Alles andere ist Eingabe für sie, Ableitung aus ihr, oder ein
anderer Blickwinkel auf denselben Zustand. Die wiederkehrenden Missverständnisse kommen daher, dass
dieselbe Sache auf drei Schichten unterschiedlich heisst (Server-SOLL, physisches IST, Anzeige) und
dass es **mehrere „zu"-Quellen** gibt. Diese Datei benennt jede Variable, ihre Werte und Bedeutung.

> Faustregel: **`boxLocked()` ist das SOLL. `Device.locked` / `state.locked` ist das IST.**
> Alles, was der Firmware, dem Tracker oder dem MCP gemeldet wird, leitet sich aus einem der beiden ab.

---

## 1. Die Autorität: `LockPolicy` (Heimdall-DB, `server/prisma/schema.prisma`)

Der maßgebliche Server-Zustand pro Box. `boxLocked()` liest **nur** diese Felder.

| Variable | Werte | Bedeutung |
|---|---|---|
| `simpleLock` | `false` \| `true` | **Heimdall-eigene** Sperre OHNE Zeit. „Zu, bis jemand serverseitig öffnet." Kein Deadline. |
| `lockUntil` | `null` \| Zeitstempel | **Heimdall-eigene** Sperre MIT Zeit. Aktiv, solange `> now`. Vergangen = wirkungslos. |
| `trackerLockUntil` | `null` \| Zeitstempel | Aus dem Tracker gezogene **befristete** Sperrzeit (endetAt). Getrennt von `lockUntil`, damit die Heimdall-Zeit nicht überschrieben wird. |
| `trackerSimpleLock` | `false` \| `true` | Aus dem Tracker gezogene **unbefristete** Sperrzeit („bis die Keyholderin öffnet"). |
| `holdOpen` | `false` \| `true` | **Ausnahme-Flag.** Der Tracker hat geöffnet (z.B. erlaubte Reinigung) und den Tracker-Dauerauftrag AUSGESETZT. Box darf trotz laufender Tracker-Sperre offen sein — bis zum nächsten `lock`. Setzt NUR den Tracker-Halt aus, **nie** eine Heimdall-eigene Sperre. |
| `openPasswordHash` | `null` \| bcrypt | Gesetzt → vorzeitiges Öffnen nur mit Passwort. |
| `offlineOpenHours` | Int (Default 24) | Nach so vielen Stunden ohne Sync öffnet die Box per Failsafe (siehe §4). |

### Warum vier „zu"-Quellen?

Zwei Achsen: **Herkunft** (Heimdall-eigen vs. aus dem Tracker) × **Zeit** (befristet vs. unbefristet).

|  | unbefristet | befristet |
|---|---|---|
| **Heimdall-eigen** (`devices/[id]/lock`, oder aus Rückzug-Umwandlung) | `simpleLock` | `lockUntil` |
| **aus dem Tracker** (Sperrzeit) | `trackerSimpleLock` | `trackerLockUntil` |

Die Trennung ist load-bearing: Der Sub darf eine Heimdall-eigene Sperre selbst lösen, eine
Tracker-Sperrzeit aber nicht (nur die Keyholderin / Ablauf). Und `holdOpen` setzt gezielt nur die
Tracker-Achse aus.

---

## 2. Die Ableitungen (`server/src/lib/device-auth.ts`)

Reine Funktionen. Nichts hier ist ein gespeicherter Wert — alles wird aus §1 berechnet.

### `boxLocked(policy, now) → bool` — DAS SOLL

```
1. simpleLock ODER (lockUntil > now)   → true   (Heimdall-eigene Sperre gewinnt IMMER)
2. holdOpen                            → false  (Tracker-Halt ausgesetzt)
3. sonst: trackerIntentActive(policy)  → true/false
```

Reihenfolge ist entscheidend: Eine Heimdall-eigene Sperre (Zeile 1) schlägt `holdOpen` (Zeile 2).
Deshalb kann die Keyholderin die Box auch während einer Reinigungspause wieder schliessen.

### `trackerIntentActive(policy, now) → bool`

Hält gerade eine **Tracker**-Sperrzeit? `trackerSimpleLock || (trackerLockUntil > now)`.
Ignoriert die Heimdall-eigenen Felder und `holdOpen`. Antwortet nur: „läuft eine Sperrzeit?"

### `effectiveLockUntil(policy, now) → Zeit | null`

Die **spätere** von `lockUntil` und `trackerLockUntil` (die strengere gewinnt), oder `null` wenn
keine in der Zukunft liegt. Nur für Anzeige/Countdown — nicht für die Auf/Zu-Entscheidung.

### `deviceLockView(policy, now) → { lockUntil, simpleLock, keyholderLocked }`

Die **Anzeige-Sicht** (Heimdall-Karte + Push an den Tracker). Leitet sich aus `boxLocked()` ab, NICHT
aus den Rohfeldern — sonst driftet die Anzeige.

| Feld | Bedeutung |
|---|---|
| `lockUntil` | `effectiveLockUntil`, aber **nur wenn `boxLocked()` true**. Sonst `null`. |
| `simpleLock` | Box soll zu sein, aber ohne Deadline (`boxLocked && lockUntil===null`). |
| `keyholderLocked` | `trackerIntentActive` — eine Tracker-Sperrzeit läuft. Sagt „wer wieder schliesst", **nicht** „ist gerade zu". Bleibt auch während `holdOpen` (Reinigung) true. |

> **INVARIANTE:** `wantsClosed(lockUntil) || simpleLock` == `boxLocked()`. Wer das lockert (z.B.
> `lockUntil` auch bei offener Box mitgibt), bricht die Karte still. War ein realer Bug.

### `shouldHoldClosedOnTrackerEnd(before, after, deviceLocked, now) → bool`

Wurde eine Tracker-Sperre **vorzeitig zurückgezogen** (aktiv vorher, weg nachher), während die Box
physisch zu ist? Dann in einen Heimdall-eigenen `simpleLock` umwandeln → Box öffnet NICHT von selbst.
Ein **natürlich abgelaufener** Timer war schon vorher inaktiv → zählt NICHT (den öffnet die Firmware
am Deadline). `deviceLocked` MUSS die frische `state.locked`-Meldung sein, nicht der DB-Stand.

---

## 3. Das physische IST: `Device` (Heimdall-DB)

Zuletzt von der Box GEMELDETER Zustand. Nicht das SOLL — kann vom SOLL abweichen (Box schläft, hat
noch nicht vollzogen, Failsafe hat geöffnet).

| Variable | Werte | Bedeutung |
|---|---|---|
| `locked` | `false` \| `true` | Physischer Riegel-Zustand beim letzten Sync. **IST**, nicht SOLL. |
| `lockedSince` | `null` \| Zeit | Seit wann physisch zu (Server-autoritativ gesetzt). |
| `boltPos` | `OPEN` \| `CLOSED` \| `UNKNOWN` | Rohe Stepper-Position (Diagnose). |
| `pendingOpenReason` | `null` \| `early` \| `tracker` \| `silent` | Einmal-Marker: koppelt eine menschlich ausgelöste Öffnung an das NÄCHSTE Box-Event. `early`→EARLY_OPEN, `tracker`→UNLOCKED, `silent`→kein Eintrag. Kein Sperr-Zustand. |
| `emergencyOpensLeft` | Int (Default 3) | Kontingent für „Trotzdem öffnen" ohne Passwort. 0 = nur Keyholderin/Failsafe. |
| `lastSyncAt` | Zeit | Letzter Sync → Grundlage für „online" (< 10 min). |
| `battery` / `charging` / `chargeFull` | — | Telemetrie; speisen Low-Batt-Failsafe. |

---

## 4. Was die Firmware bekommt und daraus macht

Die box/sync-Response schickt der Box nur zwei Sperr-Felder: `locked` (= `boxLocked()`) und
`lockUntil` (= `deviceLockView().lockUntil`). Die Box cached sie als `BoxPolicy`.

| Firmware-Feld | Herkunft | Bedeutung |
|---|---|---|
| `serverLocked` | Response `locked` | „Soll zu sein." Autoritativ. |
| `lockUntil` | Response `lockUntil` | `0` = **keine Deadline** (= simpleLock, NICHT „offen"). Sonst Failsafe-Grenze. |
| `offlineOpenH` | Response `offlineOpenHours` | Offline-Failsafe-Schwelle. |

**Die Box öffnet (`shouldOpen`), wenn EINES gilt** (`firmware/src/failsafe.h`):

| Failsafe | Bedingung | Clock nötig? |
|---|---|---|
| `isPolicyExpired` | `!serverLocked` (Server sagt offen) ODER (`lockUntil != 0` UND `now >= lockUntil`) | ja (bei ungültiger Uhr: nein) |
| `isLowBattery` | Akku ≤ kritisch (Hysterese) | nein |
| `isOfflineTimeout` | `offlineSeconds >= offlineOpenH·3600` | nein (monotoner Zähler) |

> **`lockUntil == 0` heisst „zu ohne Deadline", nicht „offen".** `serverLocked` entscheidet, nicht
> `lockUntil`. Ein simpleLock ist `serverLocked=true, lockUntil=0` → `isPolicyExpired` false → zu.
>
> **Die Box öffnet am gecachten `lockUntil` von selbst, beim nächsten Wake, ohne zu syncen.**
> Das ist BEWUSST so (Entscheid 16.07): die Frist ist das Freiheits-Versprechen, sie gilt auch
> offline. „Zubleiben trotz Ablauf" heisst serverseitig `lockUntil=0` (simpleLock), nie eine Frist.

**Zufahren (seit FW 0.2.33): nur mit jemandem am Gerät.** Der Präsenz-Guard sitzt IM Mechanismus
(`lockBox()` prüft `presentAtDevice()` = Knopf-/Power-on-Wake ODER USB) — ein stiller Heartbeat
bewegt den Motor NIE Richtung zu (Open-Loop-Stepper ohne Positions-Sensor; sonst führe z.B. nach
einer Notöffnung der nächste Heartbeat blind gegen den Anschlag). Kein Aufrufer kann den Guard
vergessen; der MQTT-Befehlspfad lief ohnehin schon nur im Wachfenster.
**Öffnen bleibt ungeguarded — Öffnen ist immer die sichere Richtung.**
Merksatz: *Von selbst bewegt sich die Box nur, um zu retten (Akku, Funkstille, Frist). Zufahren
braucht Befehl UND Präsenz.*

---

## 5. Die Anzeige-Spiegel

### Tracker `BoxStatus` (vom Heimdall-Push, `chastitytracker` DB)

Reine Anzeige-Kopie für den Tracker. `locked`, `lockUntil`, `simpleLock`, `keyholderLocked` kommen
1:1 aus `deviceLockView()`. Zusätzlich:

| Variable | Werte | Bedeutung |
|---|---|---|
| `reportedLocked` | bool \| null | **Physisches IST** aus der frischen Sync-Meldung (`state.locked`) — `locked` ist das SOLL. Seit dem Präsenz-Guard kann die Box offen stehen, obwohl sie zu sein soll (wartet auf Knopf/USB). `null` bei Alt-Zeilen → Fallback aufs SOLL. |
| `offlineOpenHours` | Int \| null | Aus `policy` (NICHT aus `deviceLockView()`) mitgepusht. Der Tracker braucht die Offline-Failsafe-Schwelle, um `staleLock`/`hardwareEnforced` im MCP ehrlich zu berechnen. `null` bei Alt-Zeilen vor diesem Push. |
| `pendingCommand` | `null` \| `lock` \| `open` | Aus einem Eintrag abgeleitetes, noch nicht von der Box abgeholtes Kommando. Keine Frist, kein Reinigungs-Kommando. |

### MCP `get_box_state` (die Keyholder-Sicht)

| Variable | Werte | Bedeutung |
|---|---|---|
| `locked` | bool | SOLL (aus `boxLocked()`). Der zuletzt gemeldete Wert; kippt nicht durch Zeitablauf ohne Sync — dafür `staleLock`. |
| `reportedLocked` | bool \| null | **IST**: war die Box beim letzten Sync wirklich zu? Kann vom SOLL abweichen (Präsenz-Guard: „soll zu, steht offen, wartet auf Knopf/USB"). `null` = Alt-Zeile, dann gilt das SOLL als bester Stand. |
| `lockUntil` | Zeit \| null | Effektive Frist, oder null (unbefristet/kein Soll). |
| `hardwareEnforced` | bool | **Die EINE ehrliche Vollstreckungs-Antwort** — hält die Box den Schlüssel gerade fest, **online-unabhängig**. Basiert auf dem **IST**: true nur bei `reportedLocked` (Fallback `locked`) UND `keyInBox !== false` UND `!staleLock`. Ist sie false, nennt genau EIN Feld das Warum: `locked:false` (soll offen), `reportedLocked:false` (steht offen), `keyInBox:false` (Schlüssel beim Sub) oder `staleLock:true` (hat sich offline selbst geöffnet). |
| `staleLock` | bool | Der zuletzt gemeldete „zu"-Stand (IST) ist entwertet, weil die Box sich seit dem letzten Sync **deterministisch selbst geöffnet** hat: Frist (`lockUntil`) verstrichen ODER Offline-Failsafe (`offlineOpenHours` ohne Sync) erreicht. Beides auch offline — „online" spielt keine Rolle. |
| `keyInBox` | true \| false \| null | Sub-Deklaration: liegt der Schlüssel in der Box? `false` erklärt ein `hardwareEnforced:false`, das sonst wie eine Störung aussähe. |
| `battery` / `charging` / `lastSeen` | — | Telemetrie + Zeitpunkt des letzten Syncs. Kein `online`-Feld mehr (Aktualität liest man an `lastSeen`). |

---

## 6. Die typischen Verwechslungen (Kurz-Glossar)

| Klingt gleich, ist es nicht | Unterschied |
|---|---|
| `Device.locked` vs. `boxLocked()` | **IST** (physisch gemeldet) vs. **SOLL** (Server-Absicht). Weichen ab, solange die Box nicht vollzogen hat. |
| `lockUntil` vs. `trackerLockUntil` | Heimdall-**eigene** Zeit vs. aus dem **Tracker** gezogene Sperrzeit. `effectiveLockUntil` = die spätere. |
| `simpleLock` vs. `trackerSimpleLock` | Eigene unbefristete Sperre vs. unbefristete **Tracker**-Sperrzeit. |
| `holdOpen` | Setzt NUR den Tracker-Halt aus (erlaubte Öffnung trotz Sperrzeit). Eine eigene Sperre gewinnt trotzdem. |
| `keyholderLocked` (Anzeige) | „Eine Tracker-Sperrzeit läuft" (wer schliesst wieder), NICHT „ist gerade zu". Bleibt bei `holdOpen` true. |
| `pendingOpenReason` (Device) vs. `pendingCommand` (BoxStatus) | Marker für das NÄCHSTE Öffnungs-EVENT (Doku-Kopplung) vs. anstehendes lock/open-KOMMANDO an die Box. |
| `hardwareEnforced` vs. `staleLock` (MCP) | Ehrliche Vollstreckungs-Antwort vs. „gemeldeter Stand entwertet, weil die Box sich offline selbst geöffnet hat". `hardwareEnforced` ist online-unabhängig; ein früheres `hardwareEnforcedEffective`/`online` gibt es nicht mehr. |

---

## 7. Zustandsübergänge (die vier, die zählen)

| Auslöser | Was passiert | Ergebnis |
|---|---|---|
| VERSCHLUSS-Eintrag | Tracker → `open`? nein → `lock`. Box fährt zu, sobald jemand am Gerät ist (Knopf/USB — Präsenz-Guard). | Box zu (beim nächsten Präsenz-Fenster). |
| OEFFNEN-Eintrag (erlaubt) | Tracker → `open`. `applyTrackerCommand`: `simpleLock=false, lockUntil=null, holdOpen = trackerIntentActive`. | Box auf; Sperrzeit läuft weiter (holdOpen). |
| OEFFNEN-Eintrag (VERBOTEN) | Tracker sendet **kein** Kommando. | Box bleibt zu; Sperrzeit gebrochen; Strafbuch bucht. |
| Sperrzeit-Rückzug (vorzeitig) | `shouldHoldClosedOnTrackerEnd` → eigener `simpleLock`. | Box bleibt zu, bis der Sub OEFFNEN einträgt. |
| Sperrzeit läuft natürlich ab | Firmware öffnet am gecachten Deadline (bewusst, Entscheid 16.07 — Frist gilt auch offline). | Box auf. |
| Notöffnung (Akku/Offline-Failsafe) | Box öffnet selbst. KEIN blindes Re-Lock: zu fährt sie erst wieder im Präsenz-Fenster. Tracker sieht `reportedLocked:false`. | Box offen, wartet auf jemanden am Gerät. |
