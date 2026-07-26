# Box-Zustände — Referenz

Warum die Box auf/zu ist, entscheidet **eine** Funktion: `boxLocked(policy, now)` in
`server/src/lib/device-auth.ts`. Alles andere ist Eingabe für sie, Ableitung aus ihr, oder ein
anderer Blickwinkel auf denselben Zustand. Die wiederkehrenden Missverständnisse kommen daher, dass
dieselbe Sache auf drei Schichten unterschiedlich heisst (Server-SOLL, physisches IST, Anzeige) und
dass es **mehrere „zu"-Quellen** gibt. Diese Datei benennt jede Variable, ihre Werte und Bedeutung.

> Faustregel: **`boxLocked()` ist das SOLL. `Device.locked` / `state.locked` ist das IST.**
> Alles, was der Firmware, dem Tracker oder dem MCP gemeldet wird, leitet sich aus einem der beiden ab.

---

## 0. Die drei Sichtweisen (Box · Heimdall · Tracker)

Dieselbe Wirklichkeit, drei Blickwinkel. **Widersprüche zwischen den Spalten sind Information,
keine Fehler** — sie sagen „veraltet", „wartet auf Präsenz" oder „Ehrensache". Heimdall entscheidet,
die Box führt aus (und überlebt offline), der Tracker zeigt an.

| | **Box (Firmware)** | **Heimdall (Server)** | **Tracker / MCP (Anzeige)** |
|---|---|---|---|
| **Rolle** | führt aus; muss offline überleben | **entscheidet** — die Autorität | zeigt an — die Keyholder-Sicht |
| **Datenbestand** | gecachte `BoxPolicy` (NVS) + eigener Riegel | `LockPolicy` (SOLL-Quelle) + `Device` (zuletzt gemeldetes IST) | `BoxStatus`-Spiegel, gepusht bei jedem Sync |
| **„Soll zu sein?" (SOLL)** | `serverLocked` — Stand des letzten Syncs | `boxLocked(policy, now)` — live berechnet, DIE eine Quelle | `locked` — Stand des letzten Pushs |
| **„Ist wirklich zu?" (IST)** | weiss es selbst (Riegel, `gBox.locked`) | `Device.locked` — zuletzt gemeldet | `reportedLocked` (`null` = nie gemeldet → SOLL gilt) |
| **Frist** | gecachtes `lockUntil` (`0` = keine); öffnet daran **selbst**, auch offline | `lockUntil` + `trackerLockUntil` → `effectiveLockUntil()` | `lockUntil` — effektive Frist oder `null` |
| **Öffnen** | von selbst NUR zum Retten: Akku, Funkstille (`offlineOpenH`). Frist/Server-„offen" **bewaffnen** nur — Riegel fährt erst mit Präsenz auf (Knopf/USB) | setzt das SOLL auf offen (Eintrag, `withdraw`, `holdOpen`) | löst über Einträge aus; liest sonst nur |
| **Zufahren** | **NUR mit Präsenz** (Knopf/USB) — Guard in `lockBox()` | setzt das SOLL auf zu; erzwingt keine Bewegung | hinterlegt `pendingCommand` „lock" |
| **Schlüssel in der Box?** | weiss es nicht (kein Sensor) | weiss es nicht | `keyInBox` — Deklaration des Subs beim Verschluss |
| **Wann veraltet?** | Policy-Cache bis zum nächsten Sync | IST bis zur nächsten Meldung | alles bis zum nächsten Push; `staleLock` rechnet die Selbst-Öffner ein |
| **„Hält sie gerade fest?"** | — | — | `hardwareEnforced` = IST ∧ `keyInBox ≠ false` ∧ `¬staleLock` |
| **Zeitbasis** | RTC (kann ungültig sein → 1970) + monotoner Offline-Zähler | Serverzeit | Serverzeit; Aktualität an `lastSeen` |

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
| `lastSyncAt` | Zeit | Letzter Sync → als `lastSeen` im Spiegel; Basis des Offline-Failsafe-Terms in `staleLock`. (Ein „online < 10 min"-Feld gibt es seit 16.07 nicht mehr.) |
| `battery` / `charging` / `chargeFull` | — | Telemetrie; speisen Low-Batt-Failsafe. |
| `battCalib` | `null` \| Float | Akku-Kalibrierfaktor, den die Box sich am Ladeschluss selbst gegeben hat. `null` = noch nie voll geladen (oder FW < 0.2.35). Reine Anzeige — der Server rechnet nie damit. |

---

## 4. Was die Firmware bekommt und daraus macht

Die box/sync-Response schickt der Box nur zwei Sperr-Felder: `locked` (= `boxLocked()`) und
`lockUntil` (= `deviceLockView().lockUntil`). Die Box cached sie als `BoxPolicy`.

| Firmware-Feld | Herkunft | Bedeutung |
|---|---|---|
| `serverLocked` | Response `locked` | „Soll zu sein." Autoritativ. |
| `lockUntil` | Response `lockUntil` | `0` = **keine Deadline** (= simpleLock, NICHT „offen"). Sonst Failsafe-Grenze. |
| `offlineOpenH` | Response `offlineOpenHours` | Offline-Failsafe-Schwelle. |

**Öffnungs-Gründe und ihr Vollzug** (`firmware/src/failsafe.h` + Präsenz-Gate in `main.cpp`):

| Grund | Bedingung | Clock nötig? | Vollzug |
|---|---|---|---|
| `isPolicyExpired` | `!serverLocked` (Server sagt offen) ODER (`lockUntil != 0` UND `now >= lockUntil`) | ja (bei ungültiger Uhr: nein) | **nur mit Präsenz** (bewaffnet sonst) |
| `isLowBattery` | Akku ≤ kritisch (Hysterese) | nein | autonom (rettet) |
| `isOfflineTimeout` | `offlineSeconds >= offlineOpenH·3600` | nein (monotoner Zähler) | autonom (rettet) |

> **`lockUntil == 0` heisst „zu ohne Deadline", nicht „offen".** `serverLocked` entscheidet, nicht
> `lockUntil`. Ein simpleLock ist `serverLocked=true, lockUntil=0` → `isPolicyExpired` false → zu.
>
> **Frist/Policy-Offen bewaffnet nur (seit FW 0.2.34, Entscheid 16.07 abends).** Läuft die Frist
> ab (oder meldet der Sync SOLL-offen), bleibt der Riegel zu und die Box ist „scharfgestellt":
> sie öffnet beim nächsten Präsenz-Ereignis (Knopf/USB) — auch offline (gecachte Frist + Knopf
> genügen, kein Sync nötig). Die Frist ist das Versprechen „du DARFST jetzt öffnen", nicht „der
> Riegel springt auf, während niemand da ist und z.B. der Schlüssel einer laufenden Session
> drinliegt". Genau das war der Vorfall vom 16.07 nachmittags: Sperrzeit lief um 14:07 ab, die
> Box öffnete am Heartbeat ins Leere, der Session-Schlüssel lag frei.
> „Zubleiben auch gegen den Knopf" heisst serverseitig weiterhin `lockUntil=0` (simpleLock).
> Ein `isPolicyExpired` wirkt ausserdem sofort als **Zufahr-Blocker** (nie zufahren, solange die
> Policy offen will) — dieser Teil ist ungegated.

**Zufahren (seit FW 0.2.33): nur mit jemandem am Gerät.** Der Präsenz-Guard sitzt IM Mechanismus
(`lockBox()` prüft `presentAtDevice()` = Knopf-/Power-on-Wake ODER USB ODER — seit 0.2.34 — ein
konsumierter Tastendruck im laufenden Wachfenster) — ein stiller Heartbeat bewegt den Motor NIE
Richtung zu (Open-Loop-Stepper ohne Positions-Sensor; sonst führe z.B. nach einer Notöffnung der
nächste Heartbeat blind gegen den Anschlag). Kein Aufrufer kann den Guard vergessen; der
MQTT-Befehlspfad lief ohnehin schon nur im Wachfenster.
Merksatz: *Von selbst bewegt sich die Box nur, um zu retten (Akku, Funkstille). Alles andere —
Zufahren UND Policy-Öffnen — braucht jemanden am Gerät.*

---

## 5. Die Anzeige-Spiegel

### Tracker `BoxStatus` (vom Heimdall-Push, `chastitytracker` DB)

Reine Anzeige-Kopie für den Tracker. `locked` = `boxLocked()` (SOLL); `lockUntil`, `simpleLock`,
`keyholderLocked` kommen 1:1 aus `deviceLockView()`. Zusätzlich:

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
| `hardwareEnforced` | bool | **Die EINE ehrliche Vollstreckungs-Antwort** — hält die Box den Schlüssel gerade fest, **online-unabhängig**. Basiert auf dem **IST**: true nur bei `reportedLocked` (Fallback `locked`) UND `keyInBox !== false` UND `!staleLock` UND `!openArmed`. Ist sie false, nennt genau EIN Feld das Warum: `locked:false` (soll offen), `reportedLocked:false` (steht offen), `keyInBox:false` (Schlüssel beim Sub), `openArmed:true` (zu, aber ein Knopfdruck vom Offen entfernt) oder `staleLock:true` (hat sich offline selbst geöffnet). |
| `openArmed` | bool | Box ist (laut IST) zu, aber die Öffnung ist **scharfgestellt**: Frist verstrichen oder SOLL offen — der nächste Knopf/USB-Kontakt öffnet ohne weitere Prüfung (FW ≥ 0.2.34). „Hält" zählt das ehrlicherweise nicht mehr; `hardwareEnforced` ist dann false. |
| `staleLock` | bool | Der zuletzt gemeldete „zu"-Stand (IST) ist entwertet, weil die Box sich seit dem letzten Sync per **Offline-Failsafe** (`offlineOpenHours` ohne Sync) **selbst geöffnet** hat — der einzige verbliebene deterministische Selbst-Öffner neben Akku-Not (seit 0.2.34 öffnet eine abgelaufene Frist nicht mehr autonom → dafür `openArmed`). |
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
| Sperrzeit läuft natürlich ab | Firmware **bewaffnet** das Öffnen am gecachten Deadline (seit 0.2.34): Riegel bleibt zu, öffnet beim nächsten Knopf/USB — auch offline. Tracker sieht `openArmed`. | Box zu, „scharfgestellt" — ein Knopfdruck öffnet. |
| Notöffnung (Akku/Offline-Failsafe) | Box öffnet selbst (rettet). KEIN blindes Re-Lock: zu fährt sie erst wieder im Präsenz-Fenster. Tracker sieht `reportedLocked:false`. | Box offen, wartet auf jemanden am Gerät. |
