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
