# Heimdall

Eine ESP32-basierte Schlüssel-Lockbox mit selbst-gehostetem Steuerserver.

Heimdall sperrt einen Schlüssel (oder ein anderes kleines Objekt) physisch weg und gibt ihn
erst zu einem festgelegten Zeitpunkt wieder frei. Die Box arbeitet eigenständig auf einem
ESP32, holt ihre Vorgaben über WLAN von einem kleinen Steuerserver und öffnet im Zweifel
selbst — Safety geht vor Funktion.

---

## Funktionen

- **Sperren bis Datum/Zeit** — über ein Web-Dashboard, mit Schnellwahl (+1 h / +1 Tag / +1 Woche) oder freiem Termin.
- **Zufallszeit** — statt einer festen Deadline eine zufällige Dauer aus einem gewählten Fenster (kürzeste/längste Dauer). Die genaue Öffnungszeit wird nicht angezeigt, das Dashboard zeigt nur die Spanne.
- **Live-Steuerung (< 2 s)** — solange die Box wach ist (Tastendruck oder am USB), erreichen Öffnen/Verschliessen sie sofort per MQTT-Push statt beim nächsten Sync.
- **Notöffnungs-Kontingent** — vorzeitiges digitales Öffnen ist nur begrenzt oft möglich. Die Kachel zeigt die verbleibenden Notöffnungen, die Keyholderin füllt sie wieder auf. Failsafes und physischer Notausgang bleiben davon unberührt.
- **Drahtlos & mobil** — die Box kennt mehrere WLANs (Zuhause, Handy-Hotspot, …) und wählt automatisch das stärkste verfügbare. Von der Box gefundene Netze erscheinen im Dashboard und lassen sich aus der Ferne wieder entfernen.
- **Signiertes Selbst-Update (OTA)** — neue Firmware kommt über WLAN auf die Box, ohne Kabel (Ed25519-signiert, mit automatischem Rollback bei Fehlstart).
- **Einrichtung per QR/Link** — neue Box in unter einer Minute provisioniert, ohne Code.
- **Lokale Failsafes** — die Box öffnet bei leerem Akku, langer Offline-Zeit oder Erreichen einer absoluten Obergrenze autonom, auch ohne Server.
- **Akkubetrieb mit Ladeschluss-Erkennung** — Deep-Sleep zwischen kurzen Wach-Fenstern, stündlicher Heartbeat-Sync. Die Box erkennt „Akku voll" (TP4056-STDBY / grüne Lade-LED) und meldet es an das Dashboard.
- **Status-LED & Status-Seite** — die LED zeigt „mit dem Server verbunden"; die Box-Webseite zeigt Zustand, Akku, Signal und Firmware sowie einen manuellen Notfall-Riegel für den Klemmfall.

---

## Wie es funktioniert

Drei Ebenen, klar getrennt:

| Ebene | Rolle | Verfügbarkeit |
|---|---|---|
| Box (ESP32) | Hält den echten Riegelzustand, setzt Deadlines und Failsafes lokal durch. | Immer — auch offline |
| Steuerserver | Soll-Zustand (Sperrzeit), Authentifizierung, Firmware-Verteilung. | Hoch (klein, gehärtet) |
| Tracker (optional) | Verlauf, Regeln, Keyholder-Logik. | Darf ausfallen |

Die Box fragt beim Aufwachen den Server: bis wann soll ich zu sein? — und entscheidet dann
selbst. Fällt der Server aus, arbeitet sie mit dem zuletzt bekannten Stand weiter und greift
auf ihre Failsafes zurück.

### Reaktionsschnell trotz Akku

Die Box schläft, um Strom zu sparen, und wacht bei Tastendruck (oder stündlich für einen
Heartbeat) auf. Im Wach-Fenster hält sie eine MQTT-Verbindung zum Server — Keyholder-Kommandos
wirken dann in unter einer Sekunde. Schläft sie, greifen die Vorgaben beim nächsten Aufwachen.
Die autoritative Zustandsübertragung läuft immer über den gehärteten HTTPS-Sync; MQTT ist nur
der schnelle Anstoss.

### Safety-Prinzip: Safety > Security > Function

Kein digitales Mittel darf die physische Befreiung verhindern. Die lokalen Failsafes der Box
können vom Server nicht abgeschaltet werden.

---

## Hardware

- ESP32 — die Firmware läuft auf einem LOLIN-D32-Devboard und transplantiert auf der
  Original-Platine einer handelsüblichen Schlüssel-Lockbox (gleicher ESP32-Chip; Pin-Belegung
  per Firmware-Analyse der Ziel-Box übernommen).
- 28BYJ-48 Schrittmotor mit ULN2003-Treiber (bewegt den Riegel)
- LiPo-Akku mit Onboard-Lader
- Status-LED (verbunden = leuchtet, Verbindungsaufbau = blinkt, Schlaf = aus)
- Taster (GPIO14): weckt die Box und öffnet ein Live-Fenster
- PLA-Gehäuse mit Sollbruch-Front (mechanische Notfall-Befreiung durch Zerstören)

---

## Einrichtung & Bedienung

### 1. Steuerserver

Der Server (Next.js) läuft selbst-gehostet (z. B. unter `heimdall.example.ch`). Nach dem Login
erscheint das Dashboard mit allen zugewiesenen Boxen.

> Server-Installation und Konfiguration: siehe [`server/CLAUDE.md`](server/CLAUDE.md).

### 2. Box einrichten (Provisioning)

Eine neue (oder zurückgesetzte) Box spannt ein offenes WLAN `Heimdall-Setup-XXXX` auf.

1. Im Dashboard: Gerät → Verwaltung → „Setup-QR" → Heim-WLAN (Name und Passwort) eintragen.
2. „Setup-Link kopieren" antippen.
3. Mit dem Handy ins WLAN `Heimdall-Setup-XXXX` wechseln, das Captive-Fenster schließen
   („Trotzdem verwenden"), im Browser den Link einfügen und öffnen.
4. Die Box speichert die Daten, startet neu und verbindet sich mit dem WLAN.

Alternativ den QR scannen — am besten vor dem Verbinden mit dem Box-WLAN.

### 3. Sperren & Öffnen

Auf der Geräte-Kachel:

- Verschliessen → Modal: Sperrzeit wählen — feste Zeit, ohne Zeit (offen bis manuell geöffnet)
  oder Zufallszeit (die Box bleibt zwischen einer kürzesten und einer längsten Dauer zu; die
  genaue Deadline wird nicht angezeigt).
- Öffnen → hebt die Sperre auf. Ist das Notöffnungs-Kontingent aufgebraucht, bleibt nur der Weg
  über die Keyholderin oder die Failsafes; die Kachel zeigt die verbleibenden Notöffnungen an.

Ist die Box gerade wach (Tastendruck / am USB — die Kachel zeigt dann „live"), greift der
Befehl sofort (< 2 s). Schläft sie, zeigt die Kachel „ausstehend" und der Befehl wird beim
nächsten Aufwachen übernommen — jederzeit per Taster an der Box auslösbar.

### 4. Mehrere WLANs

Gerät → Weitere WLAN-Zugänge (Admin): zusätzliche Netze (z. B. Handy-Hotspot) eintragen.
Die Box übernimmt sie beim nächsten Sync (das Passwort wird danach serverseitig gelöscht) und
verbindet sich künftig automatisch mit dem stärksten bekannten Netz.

### 5. Status-LED & Status-Seite

Die Status-LED leuchtet, solange die Box wach und mit dem Server verbunden ist (sie blinkt
während des Verbindungsaufbaus, ist dunkel im Schlaf). Solange die Box wach ist, zeigt sie
zusätzlich unter ihrer IP (im Geräte-Detail verlinkt) eine konsolidierte Status-Seite: OFFEN /
GESCHLOSSEN bis …, Akku (inkl. Ladeschluss), WLAN-Signal, Firmware-Version — mit aufklappbaren
Info-/Debug-/WLAN-Bereichen und einem optionalen Live-Log für die Diagnose. Für einen klemmenden
Riegel bietet die Seite einen manuellen Notfall-Riegel direkt an der Box, unabhängig vom Server.

### 6. Firmware-Updates

Kein manueller Schritt nötig. Neue Firmware wird zentral bereitgestellt; jede Box prüft beim
Sync, ob eine neuere Version vorliegt, lädt sie über WLAN und installiert sie selbst. Bootet
eine neue Version nicht sauber, fällt die Box automatisch auf die vorherige zurück.

---

## Bedienung an der Box (Taster, LED, Sleep)

Die Box hat **einen Taster** und **eine Status-LED**. Alles andere läuft über das Dashboard.

### Reset — Taster beim Einschalten halten

Taster schon **beim Booten** (Strom an / Reset) gedrückt halten:

| Haltedauer | LED-Quittung | Wirkung |
|---|---|---|
| **≥ 3 s**, dann loslassen | 2× kurzes Blinken | **WLAN-Wechsel** → Setup-Hotspot, Zugangsdaten bleiben (Portal vorausgefüllt) |
| **≥ 10 s** | 6× schnelles Blinken | **Werksreset** → WLAN-Zugangsdaten gelöscht, Setup-Hotspot startet leer |
| nicht gehalten | — | normaler Start |

Der Werksreset löscht **nur** die Zugangsdaten (WLAN-Name/-Passwort, Server-URL, Geräte-Token).
Sperrzustand, Policy und zusätzliche WLANs bleiben erhalten.

### WLAN neu setzen

Taster **≥ 3 s beim Boot** halten → Setup-Hotspot mit erhaltenen Daten, nur das WLAN muss neu
eingetippt werden. Ist die Box gerade **verschlossen**, sind Server-URL und Token gesperrt — dann
lässt sich *nur* das WLAN ändern („🔒 Verschluss aktiv — nur WLAN änderbar"). Im Hotspot gibt es
**„Setup verlassen (Normalbetrieb)"**, das ohne Änderung in den Betrieb zurückkehrt (nur sichtbar,
wenn gültige Zugangsdaten vorliegen). Weitere Netze (z. B. Hotspot) lassen sich auch übers Dashboard
hinzufügen → siehe „Mehrere WLANs".

### Provisionierung (Setup-Hotspot)

Eine neue oder zurückgesetzte Box spannt ein **offenes** WLAN **`Heimdall-Setup-XXXX`** auf
(`XXXX` = letzte MAC-Bytes). Handy ins Netz, Browser auf **`http://192.168.4.1/`** (das Captive-Portal
fängt jede URL). Einzugeben: WLAN-Name, WLAN-Passwort, Server-URL (Default `https://heimdall.trublue.ch`)
und Geräte-Token — oder den im Dashboard kopierten `/provision?…`-Link einfügen. Nach dem Speichern
(„✅ Gespeichert") startet die Box neu in den Normalbetrieb. Der bequeme Weg übers Dashboard steht
oben unter „2. Box einrichten".

### LED-Blink-Muster

| LED | Bedeutung |
|---|---|
| geht bei Tastendruck **sofort an** | Tastendruck quittiert |
| **3× Blinken** (schnell) | Wake-/Tasten-Bestätigung |
| **schnelles Blinken (~4 Hz)** | verbindet sich mit dem WLAN |
| **dauerhaft an** | wach & mit dem Server verbunden |
| **langsames Blinken (~2,5 Hz)** | Setup-Hotspot aktiv — wartet auf Einrichtung |
| **2× / 6× Blinken beim Boot** | Reset-Quittung: 3 s = WLAN-Wechsel · 10 s = Werksreset |
| **aus** | schläft |

Die LED zeigt **wach/verbunden**, *nicht* den Schloss-Zustand — der steht im Dashboard und auf der
Status-Seite der Box.

### Sleep & Aufwachen

Die Box ist die meiste Zeit im **Deep-Sleep** (~10 µA) und wacht durch **Taster** oder **Timer** auf.

- **Dormant:** Timer-Wake im konfigurierten **Sync-Intervall** (Standard 60 min, pro Box 1–180 min im
  Dashboard einstellbar) → einmal syncen → sofort weiterschlafen.
- **Wachfenster:** Ein Tastendruck (oder USB) öffnet ein **~2-min-Fenster** mit Live-Steuerung; nach
  2 min ohne Aktivität schläft sie wieder. **Am USB bleibt sie wach.**
- **Sofort schlafen:** Taster **≥ 1,5 s** halten → sie synct noch und geht dann direkt in den Schlaf
  (statt auf das 2-min-Timeout zu warten). Ein kurzer Tap löst nur einen Sync aus.
- Liegt eine Sperr-Deadline früher als das Intervall, wacht die Box genau zur Deadline auf.

---

## Failsafes — die Box öffnet sich selbst

Damit niemand durch einen technischen Defekt eingesperrt bleibt, öffnet die Box autonom, sobald:

- der Akku kritisch leer ist (≤ 15 %, solange noch Energie für die Öffnung da ist) — mit
  Vorwarnung ab 20 % und Hysterese gegen Flattern,
- zu lange kein Server-Kontakt bestand (Standard: 24 h),
- die eingestellte Sperrzeit abgelaufen ist (`lockUntil`, uhrzeit-basiert).

Diese Prüfungen laufen lokal und uhrzeit-unabhängig auf der Box — auch ohne WLAN, ohne Server
und nach einem Stromausfall.

---

## Status & Einschränkungen

Heimdall ist ein funktionierender Prototyp, kein fertiges Produkt.

- Funktioniert und läuft auf echter Hardware: Provisioning, Sperren/Öffnen (feste Zeit, ohne
  Zeit, Zufallszeit), Live-Steuerung (MQTT), Notöffnungs-Kontingent, Multi-WLAN, signierte OTA
  mit Zertifikat-Pinning, Failsafes, Hardware-Watchdog (Selbst-Reboot bei Firmware-Hänger),
  Ladeschluss-Erkennung, Dashboard.
- Offen: Die Mechanik (Schrittmotor/Riegel) ist noch nicht unter Last validiert. Ein
  Endlagensensor ist bewusst nicht vorgesehen (keine Hardware dafür) — der gemeldete
  Riegelzustand ist gerechnet, nicht gemessen; bei klemmendem Riegel öffnet der user-gemeldete
  „Riegel klemmt → erneut öffnen"-Befehl erneut.
- Einsatzkontext: Gedacht für den privaten, selbst-gehosteten Betrieb. Die Sicherheit liegt
  bewusst in Sichtbarkeit und Keyholder-Beziehung, nicht in Unentrinnbarkeit — die Frontscheibe
  bleibt der physische Notausgang.

---

## Firmware im Detail

Die ESP32-Firmware (`firmware/`, PlatformIO/Arduino, Board `lolin_d32`) steuert Riegel, Sensorik und die Server-Anbindung. Sie ist auf **minimalen Akkuverbrauch** und **lokale Sicherheit** ausgelegt: die Box entscheidet autonom, der Server gibt nur das Soll vor.

### Betriebsmodell — Session-Fenster

Die Box ist die meiste Zeit im **Deep-Sleep** (~10 µA). Sie erwacht auf zwei Wegen:

- **Heartbeat-Wake** (RTC-Timer, im konfigurierten Intervall — Standard 60 min, pro Box **1–180 min** über den Server einstellbar): kurz aufwachen, **einmal synchronisieren**, sofort weiterschlafen. Kein Live-Fenster. Kleiner = reaktiver, aber mehr Akkuverbrauch.
- **Aktiv-Wake** (Taster oder USB): öffnet ein ~2-min-**Wachfenster** mit **Live-MQTT** (Kommandos < 2 s), re-synct alle 30 s, schläft nach 2 min Inaktivität wieder ein.

### State-Machine

`PROVISIONING` (keine Credentials → Setup-Hotspot) → `SYNCING` (WLAN + HTTPS-Sync) → `LOCKED` / `IDLE_OPEN` (warten auf Deadline/Wake/Kommando) → `OPENING` (Riegel fahren). Der Riegel ist **open-loop** (28BYJ-48-Stepper, kein Endlagensensor) → Position wird geschätzt, ein „Riegel klemmt"-Retry (`reopen`) fährt kontrolliert nach.

### Boot-/Wake-Ablauf

1. Reset-Grund + Boot-Zähler erfassen (`diag`-NVS), OTA-Validierung prüfen (`ota`-NVS)
2. NVS laden (Credentials, State, Policy, MQTT)
3. Wake-Grund bestimmen → **Wake-Journal-Eintrag** (RTC-RAM), Ein-Zeilen-Banner ins Log
4. Failsafes prüfen (Low-Batt / Offline / Deadline) → ggf. sofort öffnen
5. `SYNCING`: WLAN, NTP (wenn nötig), HTTPS-Sync (State rauf, Soll runter), OTA-Check
6. Riegel nach Soll fahren, dann Wachfenster **oder** Deep-Sleep

### Persistenz

Zwei getrennte Ebenen — **NVS** (Flash, überlebt Stromausfall) und **RTC-RAM** (überlebt nur Deep-Sleep, bei echtem Power-on genullt).

#### NVS (Flash) — 7 Namespaces

**`wifi`** — Provisioning-Credentials (bei Full-Reset gelöscht):

| Key | Typ | Inhalt |
|---|---|---|
| `ssid` | String | Primär-WLAN-SSID |
| `pass` | String | Primär-WLAN-Passwort |
| `url` | String | Server-Basis-URL (`https://heimdall.trublue.ch`) |
| `token` | String | Device-Token (Bearer-Auth für `/api/box/*`) |

**`state`** — Box-Zustand (jeder Sync/Sleep aktualisiert ihn):

| Key | Typ | Inhalt |
|---|---|---|
| `locked` | bool | Riegel zu? |
| `lsince` | int64 | „gesperrt seit" (Unix-Epoch, 0 = nie) |
| `lsync` | int64 | letzter **erfolgreicher** Sync (Unix-Epoch) |
| `reason` | String | letzter Wake-Grund |
| `prevBatt` | int | zuletzt gemessener Akku-% (−1 = nie) |
| `offsec` | uint32 | **monotoner Offline-Zähler** (Sek. seit letztem Sync) — clock-**un**abhängiger Offline-Failsafe |
| `ltick` | int64 | `time()` beim letzten Wake (Delta-Basis für `offsec`) |
| `lowbatt` | bool | Low-Batt-Hysterese-Latch (ab ≤15 %, gelöscht erst ≥25 %) |

**`policy`** — letzte Server-Vorgabe:

| Key | Typ | Inhalt |
|---|---|---|
| `lockUntil` | int64 | Sperr-Deadline (Unix-Epoch, 0 = keine) |
| `offlineH` | int | Offline-Open-Stunden (Standard 24) |
| `syncInt` | int | Heartbeat-Sync-Intervall in Sekunden (Server, 60–10800) → Deep-Sleep-Timer |
| `srvLocked` | bool | Server-Soll „zu" (Simple-Lock **oder** aktive Zeit) — entkoppelt „zu" von einer Deadline |

**`mqtt`** — Broker-Konfig (pro Box über den gehärteten HTTPS-Sync provisioniert):

| Key | Typ | Inhalt |
|---|---|---|
| `en` | bool | MQTT aktiv? |
| `host` | String | Broker-Host (mqtts) |
| `did` | String | `deviceId` (cuid) = MQTT-clientId/username + Topic-Segment |

**`nets`** — Zusatz-WLANs + Präferenz (max. 3 Extra-Netze):

| Key | Typ | Inhalt |
|---|---|---|
| `count` | int | Anzahl Extra-Netze |
| `s0`–`s2` | String | Extra-SSID |
| `p0`–`p2` | String | Extra-Passwort |
| `pref` | String | bevorzugte SSID (leer/fehlt = keine Präferenz) |

**`diag`** — Boot-Diagnose (nie gelöscht):

| Key | Typ | Inhalt |
|---|---|---|
| `boots` | uint32 | monotoner Boot-Zähler |
| `unexp` | uint32 | unerwartete Power-ons/Brownouts (Feld-Diagnose) |
| `statbase` | uint32 | Baseline-Marker — nullt `unexp` einmalig bei Firmware-Marker-Bump |

**`ota`** — OTA-Validierung / Auto-Rollback:

| Key | Typ | Inhalt |
|---|---|---|
| `pending` | bool | frisch geflashte FW wartet auf Bestätigung |
| `boots` | uint32 | Boot-Versuche seit Flash — **> 3 ohne erfolgreichen Sync → Rollback** auf die alte Partition |

> Jeder read-only gelesene Namespace trägt zusätzlich einen neutralen `_ns`-Marker (`uint8`), der ihn vorab anlegt und so harmlosen `nvs_open: NOT_FOUND`-Log-Spam vermeidet.
>
> **Hinweis:** NVS ist **unverschlüsselt** — WLAN-Passwörter und Device-Token liegen im Klartext im Flash. Physischer Zugriff auf den Chip = lesbare Credentials (bewusster Trade-off; der Token ist pro Box und serverseitig widerrufbar).

#### RTC-RAM (überlebt Deep-Sleep, kein Flash, kein Zusatzstrom)

| Struktur | Inhalt |
|---|---|
| **Wake-Journal** (`wake_journal.cpp`) | Ring aus 64 Wake-Einträgen (Grund/Zeit/Akku%) — beim nächsten erfolgreichen Sync hochgeladen, dann geleert. Erfasst auch Wakes, deren Sync scheiterte |
| **WiFi-Fast-Reconnect-Hint** | letztes SSID/Passwort/BSSID/Kanal → Scan überspringen (~0.5–1.5 s/Wake gespart) |
| **`gAuthFails`** | 401-Zähler in Folge → Selbstheilung in den Setup-Hotspot |

#### Flash-Log (LittleFS, überlebt auch Stromverlust/Reboot)

Auf der vorhandenen **128-KB-`spiffs`-Partition** (Flash) liegt ein persistenter Fehl-Sync-Log
(`/backlog.log`, `flash_log.cpp`). **Nur bei einem fehlgeschlagenen Sync** wird der RAM-Log-Ausschnitt
dieses Wakes (inkl. der `WiFi: connect to '<ssid>' failed …`-Zeilen) dorthin angehängt — so überlebt
die Diagnose auch Deep-Sleep **und** Stromverlust. Beim nächsten **erfolgreichen** Sync geht der
Backlog mit hoch und wird danach gelöscht; Rotation bei 16 KB. Best-effort: schlägt der Mount fehl,
läuft die Box normal weiter (der Flash-Log ist rein diagnostisch, nie im Safety-/Lock-Pfad).

### Failsafes (lokal, autoritativ, nicht vom Server abschaltbar)

- **Low-Battery-Auto-Open** bei ≤ 15 % (Hysterese bis ≥ 25 %) — Öffnen mit Drehmoment-Reserve
- **Offline-Auto-Open** nach 24 h ohne Sync — über den **monotonen `offsec`-Zähler**, funktioniert auch bei ungültiger Uhr
- **Hard-Deadline** — RTC-Deadline erreicht → öffnen

Reihenfolge: **Safety > Security > Function**. Ein Failsafe-Öffnen gewinnt und wird als `FAILSAFE_OPEN` an den Server gemeldet.

### OTA-Updates

Signierte OTA (Ed25519 über sha256 der `.bin`), Public Key eingebrannt. Auto-OTA nur bei **offener** Box + **Akku ≥ 40 %**. Nach dem Flash: `pending`-Validierung — bestätigt erst ein erfolgreicher Sync die neue FW, sonst **automatischer Rollback**.

### Logging

Ein RAM-Ring-Puffer (6 KB, flüchtig) speist einheitlich: UART · `/dbg/log`-Webseite · UDP-Broadcast (LAN) · Server-Log (`logToServer`) · MQTT-Live-Log. Zwei persistente Audit-Pfade daneben: das **Wake-Journal** (RTC-RAM, jeder Wake) und der **Flash-Log** (LittleFS, Roh-Diagnose fehlgeschlagener Syncs — siehe Persistenz).

---

## Für Entwickler

```
heimdall/
├── server/     ← Next.js-Steuerserver (Prisma + SQLite, NextAuth) + MQTT-Broker (Mosquitto)
├── firmware/   ← ESP32-Firmware (PlatformIO, Arduino)
└── docs/       ← Konzeptdokumente
```

Firmware wird per CI gebaut und automatisch als OTA veröffentlicht; der Server deployt per CI
auf den Host. Details: [`CLAUDE.md`](CLAUDE.md) und [`server/CLAUDE.md`](server/CLAUDE.md).

---

## Lizenz

PolyForm Noncommercial License 1.0.0 — siehe [LICENSE.md](LICENSE.md).

Copyright © 2026–heute trublue-2
