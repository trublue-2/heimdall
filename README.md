# 🔒 Heimdall

**Eine ESP32-basierte Schlüssel-Lockbox mit selbst-gehostetem Steuerserver.**

Heimdall sperrt einen Schlüssel (oder ein anderes kleines Objekt) physisch weg und gibt ihn
erst zu einem festgelegten Zeitpunkt wieder frei. Die Box arbeitet eigenständig auf einem
ESP32, holt sich ihre Vorgaben über WLAN von einem kleinen Steuerserver und öffnet sich im
Zweifel **immer von selbst** — Sicherheit geht vor Funktion.

---

## Funktionen

- ⏱️ **Sperren bis Datum/Zeit** — über ein schlankes Web-Dashboard, mit Schnellwahl (+1 h / +1 Tag / +1 Woche) oder freiem Termin.
- 📶 **Drahtlos & mobil** — die Box kennt **mehrere WLANs** (Zuhause, Handy-Hotspot, …) und wählt automatisch das stärkste verfügbare.
- 🔄 **Selbst-Update (OTA)** — neue Firmware kommt über WLAN auf die Box, **ohne Kabel**.
- 📲 **Einrichtung per QR/Link** — neue Box in unter einer Minute provisioniert, ohne Code.
- 🛟 **Lokale Failsafes** — die Box öffnet bei leerem Akku, langer Offline-Zeit oder Erreichen einer absoluten Obergrenze **autonom**, auch ohne Server.
- 🔋 **Akkubetrieb** — Deep-Sleep zwischen den Syncs, hält tagelang.
- 📟 **Status-Seite** — jede Box zeigt ihren Zustand (offen / geschlossen bis …) im Browser an.

---

## Wie es funktioniert

Drei Ebenen, klar getrennt:

| Ebene | Rolle | Verfügbarkeit |
|---|---|---|
| **Box** (ESP32) | Hält den echten Riegelzustand, setzt Deadlines & Failsafes **lokal** durch. | Immer — auch offline |
| **Steuerserver** | Soll-Zustand (Sperrzeit), Authentifizierung, Firmware-Verteilung. | Hoch (klein, gehärtet) |
| **Tracker** *(optional)* | Verlauf, Regeln, Keyholder-Logik. | Darf ausfallen |

Die Box fragt beim Aufwachen den Server: *„Bis wann soll ich zu sein?"* — und entscheidet
dann **selbst**. Fällt der Server aus, arbeitet sie mit dem zuletzt bekannten Stand weiter
und greift auf ihre Failsafes zurück.

### Safety-Prinzip: **Safety > Security > Function**

Kein digitales Mittel darf die physische Befreiung verhindern. Die lokalen Failsafes der Box
können vom Server **nicht** abgeschaltet werden.

---

## Hardware

- **ESP32** (LOLIN D32, mit Onboard-LiPo-Lader)
- **28BYJ-48 Schrittmotor** + ULN2003-Treiber (bewegt den Riegel)
- **LiPo-Akku**
- Blaue Status-LED (onboard), optionaler externer Taster (GPIO14)
- PLA-Gehäuse mit Sollbruch-Front (mechanische Notfall-Befreiung durch Zerstören)

---

## Einrichtung & Bedienung

### 1. Steuerserver

Der Server (Next.js) läuft selbst-gehostet (z. B. unter `heimdall.example.ch`). Nach dem Login
landest du auf dem **Dashboard** mit allen dir zugewiesenen Boxen.

> Server-Installation & Konfiguration → siehe [`server/CLAUDE.md`](server/CLAUDE.md).

### 2. Box einrichten (Provisioning)

Eine neue (oder zurückgesetzte) Box spannt ein offenes WLAN **`Heimdall-Setup-XXXX`** auf.

1. Im Dashboard: **Gerät → Verwaltung → „Setup-QR"** → dein Heim-WLAN (Name + Passwort) eintragen.
2. **„Setup-Link kopieren"** antippen.
3. Mit dem Handy ins WLAN **`Heimdall-Setup-XXXX`** wechseln, das Captive-Fenster schließen
   („Trotzdem verwenden"), in **Safari/Browser** den Link einfügen → öffnen.
4. Die Box speichert die Daten, startet neu und verbindet sich mit deinem WLAN.

*(Alternativ den QR scannen — am besten **vor** dem Verbinden mit dem Box-WLAN.)*

### 3. Sperren & Öffnen

Auf der Geräte-Kachel:

- **Verschliessen** → Modal: Sperrzeit wählen → die Box zieht den Befehl beim nächsten Sync.
- **Öffnen** → hebt die Sperre auf.

Bis die Box den Befehl übernommen hat, zeigt die Kachel **„ausstehend"**. Sie synct alle paar
Minuten von selbst — soll es sofort sein, weckst du sie (Taster/Reset an der Box).

### 4. Mehrere WLANs

**Gerät → Weitere WLAN-Zugänge** (Admin): zusätzliche Netze (z. B. Handy-Hotspot) eintragen.
Die Box übernimmt sie beim nächsten Sync (das Passwort wird danach serverseitig gelöscht) und
verbindet sich künftig automatisch mit dem stärksten bekannten Netz.

### 5. Status-Seite der Box

Solange die Box wach ist, zeigt sie unter ihrer IP (im Geräte-Detail verlinkt) eine Status-Seite:
**OFFEN** / **GESCHLOSSEN bis …**, Akku, WLAN-Signal, Firmware-Version.

### 6. Firmware-Updates

**Nichts zu tun.** Neue Firmware wird zentral bereitgestellt; jede Box prüft beim Sync, ob eine
neuere Version vorliegt, lädt sie über WLAN und installiert sie selbst. Bootet eine neue Version
nicht sauber, fällt die Box automatisch auf die vorherige zurück.

---

## 🛟 Failsafes — die Box öffnet sich selbst

Damit niemand durch einen technischen Defekt eingesperrt bleibt, öffnet die Box **autonom**, sobald:

- **der Akku kritisch leer** ist (solange noch Energie für die Öffnung da ist),
- **zu lange kein Server-Kontakt** bestand (Standard: 24 h),
- eine **absolute Obergrenze** (`hardCap`) erreicht ist — diese kann der Server **nie** überschreiten.

Diese Prüfungen laufen **lokal und uhrzeit-unabhängig** auf der Box — auch ohne WLAN, ohne
Server und nach einem Stromausfall.

---

## Status & Einschränkungen

Heimdall ist ein **funktionierender Prototyp**, kein fertiges Produkt. Ehrlich zum Stand:

- ✅ Provisioning, Sperren/Öffnen-Logik, Multi-WLAN, OTA-Updates, Failsafes, Dashboard — **funktionieren**.
- ⚠️ Die **Mechanik (Schrittmotor/Riegel)** ist noch nicht unter Last validiert (kein Endlagensensor) — der gemeldete Zustand kann von der Realität abweichen, bis ein Positionssensor ergänzt ist.
- ⚠️ Härtung in Arbeit: **signierte OTA + Zertifikat-Pinning** sind auf der Roadmap. Bis dahin ist Heimdall für den **privaten, selbst-gehosteten Betrieb in einem vertrauenswürdigen Netz** gedacht — nicht für feindliche Umgebungen.

---

## Für Entwickler

```
heimdall/
├── server/     ← Next.js-Steuerserver (Prisma + SQLite, NextAuth)
├── firmware/   ← ESP32-Firmware (PlatformIO, Arduino)
└── docs/       ← Konzeptdokumente
```

Firmware wird per CI gebaut und automatisch als OTA veröffentlicht; der Server deployt per CI
auf den Host. Details → [`CLAUDE.md`](CLAUDE.md) und [`server/CLAUDE.md`](server/CLAUDE.md).

---

## Lizenz

PolyForm Noncommercial License 1.0.0 — siehe [LICENSE.md](LICENSE.md).

Copyright © 2026–heute trublue-2
