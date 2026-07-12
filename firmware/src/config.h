#pragma once

#define FW_VERSION "0.2.30"

// ── Stepper (28BYJ-48 via ULN2003) ────────────────────────────────────────
// Ziel-Board: ULN2003 an GPIO 23/17/16/4 (per Debug-Sweep ermittelt, auf/zu ok).
// Alle boot-sicher (keine Strapping-/Flash-/Input-only-Pins).
// LOLIN-Dev-Board war 32/33/25/26 → bei Board-Wechsel hier in config.h anpassen (Board-Profil noch offen).
#define STEPPER_IN1 23
#define STEPPER_IN2 17
#define STEPPER_IN3 16
#define STEPPER_IN4 4

// Schritte pro Richtung — kalibriert am Bench.
// 28BYJ-48 Half-Step: 4096 Steps/Umdrehung (~11,4 Steps/°). 1024 Steps = 90° Riegelweg.
#define STEPPER_LOCK_STEPS  1024
#define STEPPER_STEP_DELAY_US 3000 // µs — langsamer = mehr Drehmoment; mit Last ≥3000
// Manuelles Jogging (Notfall/Entklemmen auf der Box-Seite): kleiner Schritt pro Klick.
// Bewusst klein (~5,6°) — ohne Endlagensensor gegen den Anschlag zu fahren soll wehtun-los bleiben.
#define STEPPER_JOG_STEPS   (STEPPER_LOCK_STEPS / 16)
// Drehrichtung: Vorzeichen, das auf ZU fährt. Ziel-Mechanik ggü. LOLIN gespiegelt.
#define STEPPER_DIR_LOCK (+1) // +1 = zu (Ziel-Board); LOLIN-Dev war -1

// ── Status-LED ──────────────────────────────────────────────────────────────
// Ziel-Board: weisse Status-LED auf GPIO5, ACTIVE-HIGH (leuchtet bei HIGH — am Gerät
// verifiziert; GPIO5 per Firmware-Analyse der Original-Platine bestätigt). Das LOLIN-Dev-Board
// hatte dieselbe GPIO5, aber die blaue Onboard-LED war active-LOW → bei Board-Wechsel flippen.
#define PIN_LED  5
#define LED_ON   HIGH
#define LED_OFF  LOW

// ── Button ─────────────────────────────────────────────────────────────────
// Externer Lockbox-Taster gegen GND. Der LOLIN D32 hat KEINEN BOOT/IO0-Knopf
// (nur RESET), darum eigener GPIO. GPIO14: RTC-fähig (→ EXT0-Wake aus Deep-Sleep),
// interner Pull-Up (HIGH idle, LOW bei Druck), KEIN Strapping-Pin. Taster: GPIO14 ↔ GND.
#define PIN_BUTTON 14
// Taster im Wach-Fenster: kurzer Tap = Sync; anhaltendes Halten ≥ BTN_SLEEP_HOLD_MS =
// „erst syncen, dann sofort schlafen" (statt aufs 2-min-Fenster-Timeout zu warten).
#define BTN_SLEEP_HOLD_MS 1500

// ── Batterie ADC + Lade-Erkennung ──────────────────────────────────────────
// Ziel-Board: Akkuspannung auf GPIO32, 1:2-Teiler (per ADC-Scan ermittelt: 2,06 V → 4,12 V).
// LOLIN-Dev war GPIO35 — Teiler bei beiden 1:2 (der ×2 in failsafe.h bleibt).
#define PIN_BATT_ADC      32
// Skalierung: V_batt = V_adc × BATT_DIVIDER. Am Multimeter kalibriert (2026-07-06):
// 4,10 V real ÷ 1,990 V (GPIO32-Node) = 2,06. (Original-FW nutzte ~2,2625 + ADC-Kurve.)
#define BATT_DIVIDER      2.06f
// Lade-Erkennung: GPIO26, active-HIGH (HIGH = Ladung LÄUFT). Fällt am Ladeschluss (STDBY)
// weg — „am USB" ist daher charging ODER chargeFull (siehe readChargeState). -1 = kein Pin.
#define PIN_CHARGE_DETECT 26
// Ladeschluss „voll/fertig" (TP4056 STDBY, grüne LED): GPIO13, open-drain → INPUT_PULLUP,
// LOW = fertig & am Kabel. UNABHÄNGIG von GPIO26 gelesen (bei voll ist charging bereits weg).
// Reine Anzeige + „am USB"-Signal, KEIN Safety-Pfad. -1 = kein Pin (z.B. LOLIN).
#define PIN_CHARGE_FULL   13
#define BATT_LOW_PERCENT  20  // % Warnung (Dashboard-Badge, Server-seitig ausgewertet)
#define BATT_CRITICAL_PCT  15 // % → Auto-Open Failsafe (Notöffnung mit Reserve fürs Drehmoment)
// Hysterese: einmal unter BATT_CRITICAL gilt "leer", bis der Akku wieder ≥ BATT_RECOVER
// steigt → kein Flattern durch ADC-Rauschen um die 15%-Schwelle (latch in BoxState).
#define BATT_RECOVER_PCT   25
// Plausibilität: ein laufendes 1S-LiPo-Board liegt bei ~3.0–4.2 V. Liest der ADC
// ausserhalb 2.5–4.5 V, ist kein echter Akku-Sensor am Pin (z.B. ein Board ohne
// Teiler auf GPIO35) → BATT_UNKNOWN statt fälschlich "0% = kritisch leer".
#define BATT_UNKNOWN        (-1)
#define BATT_PLAUSIBLE_MIN_V 2.5f
#define BATT_PLAUSIBLE_MAX_V 4.5f

// ── Timeouts ───────────────────────────────────────────────────────────────
// Session-Fenster-Modell: Button/USB öffnet ein kurzes Wachfenster mit Live-MQTT;
// dormant schläft die Box zwischen stündlichen Heartbeat-Syncs.
#define ACTIVE_WINDOW_MS         (2UL * 60 * 1000) // 2 min ohne Aktivität → Deep-Sleep (Wachfenster, MQTT live)
#define HEARTBEAT_S              (60UL * 60)        // dormant: Standard-Sync-Intervall (60 min); pro Box per Server überschreibbar
// Konfigurierbares Heartbeat-Sync-Intervall (Server liefert es pro Box): Grenzen 1 min … 180 min.
#define SYNC_INTERVAL_MIN_S      (1UL * 60)
#define SYNC_INTERVAL_MAX_S      (180UL * 60)
// Längstes reguläres Sleep-Intervall — Klemme für die monotonen Failsafe-Zähler in
// checkFailsafes(): ein Delta darüber gilt als Uhr-Sprung und wird konservativ gekappt.
// MUSS ≥ dem MAXIMAL konfigurierbaren Sync-Intervall sein, sonst unterzählt der Offline-Zähler
// (Failsafe feuert zu spät) — Safety-Invariante bei konfigurierbarem Intervall.
#define MAX_SLEEP_S              SYNC_INTERVAL_MAX_S
#define OFFLINE_OPEN_H           24                 // h ohne Sync → Auto-Open
// Hardware-Watchdog: rebootet die Box, wenn die Firmware WDT_TIMEOUT_S lang haengt (kein
// Feed) — Selbstheilung gegen Aufhaenger. Liegt bewusst ueber dem laengsten legitimen
// Einzelblocker: OTA-Download wird per Chunk gefuettert, TLS/Sync/Stepper laufen << 30 s.
#define WDT_TIMEOUT_S            30
#define WIFI_CONNECT_TIMEOUT_MS  (15 * 1000)        // 15 s WiFi-Connect-Limit
#define AUTH_FAIL_LIMIT          10                 // N×401 in Folge → Setup-Hotspot (Selbstheilung)
#define OTA_VALIDATE_SYNCS       1                  // erfolgreiche Syncs bis OTA bestätigt (sonst Rollback)

// Re-Sync-Takt im Wach-Zustand (am Netz) — hält Policy/OTA/IP frisch.
#define DEBUG_RESYNC_MS          (30UL * 1000)

// Persistentes Fehl-Sync-Log (LittleFS auf der "spiffs"-Partition): max. Dateigröße, darüber
// rotiert (älteste Zeilen fallen weg). 16 KB deckt einen langen Offline-Stretch ab.
#define FLASHLOG_CAP             16384

// WLAN-Sendeleistung: 8,5 dBm — wieder hoch für bessere Reichweite/Stabilität
// (Multi-WLAN, schwächere APs). Der Brownout-Fix war primär ein gutes Kabel, nicht
// diese Drosselung. Etwas unter Maximum (19,5) als LDO-Marge. MUSS nach jedem
// WiFi.mode(STA)/begin() gesetzt werden (mode-Wechsel setzt die Power zurück).
#define WIFI_TX_POWER            WIFI_POWER_8_5dBm

// ── Server API ─────────────────────────────────────────────────────────────
#define DEFAULT_SERVER_URL   "https://heimdall.trublue.ch" // Provisioning-Default
#define SERVER_PATH_REGISTER "/api/box/register"
#define SERVER_PATH_SYNC     "/api/box/sync"

// ── MQTT (Session-Fenster-Push) ────────────────────────────────────────────
// Broker-Host kommt pro Box aus der Sync-Response (mqtt.host → NVS). Nur im Wachfenster
// (Button/USB) verbunden; TLS mit demselben Cert-Pinning wie der Sync (ROOT_CA_BUNDLE).
#define MQTT_PORT            8883            // mqtts (TLS) über Traefik-TCP-Router
#define MQTT_KEEPALIVE_S     30              // PINGREQ-Intervall (kurz → zügige LWT-Offline-Erkennung)
#define MQTT_TOPIC_PREFIX    "heimdall/box/" // + <deviceId>/cmd (sub) bzw. /status (LWT)
