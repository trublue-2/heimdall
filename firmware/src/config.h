#pragma once

#define FW_VERSION "0.1.49"

// ── Stepper (28BYJ-48 via ULN2003) ────────────────────────────────────────
// Boot-sichere GPIOs ohne Strapping-Konflikt.
#define STEPPER_IN1 32
#define STEPPER_IN2 33
#define STEPPER_IN3 25
#define STEPPER_IN4 26

// Schritte pro Richtung — kalibriert am Bench.
// 28BYJ-48 Half-Step: 4096 Steps/Umdrehung (~11,4 Steps/°). 1024 Steps = 90° Riegelweg.
#define STEPPER_LOCK_STEPS  1024
#define STEPPER_STEP_DELAY_US 3000 // µs — langsamer = mehr Drehmoment; mit Last ≥3000

// ── Onboard LED ────────────────────────────────────────────────────────────
// LOLIN D32: Blaue LED auf GPIO5, ACTIVE-LOW (leuchtet bei LOW-Pegel!).
#define PIN_LED  5
#define LED_ON   LOW
#define LED_OFF  HIGH

// ── Button ─────────────────────────────────────────────────────────────────
// Externer Lockbox-Taster gegen GND. Der LOLIN D32 hat KEINEN BOOT/IO0-Knopf
// (nur RESET), darum eigener GPIO. GPIO14: RTC-fähig (→ EXT0-Wake aus Deep-Sleep),
// interner Pull-Up (HIGH idle, LOW bei Druck), KEIN Strapping-Pin. Auf dem Board
// der zweitunterste Pin der linken Reihe. Taster: GPIO14 ↔ GND.
#define PIN_BUTTON 14

// ── Batterie ADC ───────────────────────────────────────────────────────────
// LOLIN D32: GPIO35 mit 100k/100k Teiler → misst Vbat/2.
#define PIN_BATT_ADC      35
#define BATT_LOW_PERCENT  15  // % Warnung / LED
#define BATT_CRITICAL_PCT  8  // % → Auto-Open Failsafe
// Plausibilität: ein laufendes 1S-LiPo-Board liegt bei ~3.0–4.2 V. Liest der ADC
// ausserhalb 2.5–4.5 V, ist kein echter Akku-Sensor am Pin (z.B. LMB-Board ohne
// Teiler auf GPIO35) → BATT_UNKNOWN statt fälschlich "0% = kritisch leer".
#define BATT_UNKNOWN        (-1)
#define BATT_PLAUSIBLE_MIN_V 2.5f
#define BATT_PLAUSIBLE_MAX_V 4.5f

// ── Timeouts ───────────────────────────────────────────────────────────────
#define IDLE_SLEEP_MS            (1UL * 60 * 1000) // 1 min → Deep-Sleep
#define WAKE_INTERVAL_S          (5UL * 60)         // 5 min → periodischer Sync-Wake
#define OFFLINE_OPEN_H           24                 // h ohne Sync → Auto-Open
#define WIFI_CONNECT_TIMEOUT_MS  (15 * 1000)        // 15 s WiFi-Connect-Limit
#define AUTH_FAIL_LIMIT          10                 // N×401 in Folge → Setup-Hotspot (Selbstheilung)
#define OTA_VALIDATE_SYNCS       1                  // erfolgreiche Syncs bis OTA bestätigt (sonst Rollback)

// Debug-Mode (server-aktiviert): Box bleibt wach + serviert lokale Debug-Seite.
#define DEBUG_RESYNC_MS          (30UL * 1000)      // alle 30 s re-syncen (Flag/IP frisch, Fernabschaltung)
#define DEBUG_MAX_MS             (20UL * 60 * 1000) // harte Obergrenze: nach 20 min Debug → Sleep (Drain-Schutz)

// WLAN-Sendeleistung: 8,5 dBm — wieder hoch für bessere Reichweite/Stabilität
// (Multi-WLAN, schwächere APs). Der Brownout-Fix war primär ein gutes Kabel, nicht
// diese Drosselung. Etwas unter Maximum (19,5) als LDO-Marge. MUSS nach jedem
// WiFi.mode(STA)/begin() gesetzt werden (mode-Wechsel setzt die Power zurück).
#define WIFI_TX_POWER            WIFI_POWER_8_5dBm

// ── Server API ─────────────────────────────────────────────────────────────
#define SERVER_PATH_REGISTER "/api/box/register"
#define SERVER_PATH_SYNC     "/api/box/sync"

// ── Bench-Test: Credentials (auskommentiert lassen, nur lokal setzen) ──────
// #define TEST_WIFI_SSID    "MeinWLAN"
// #define TEST_WIFI_PASS    "Passwort"
// #define TEST_SERVER_URL   "https://heimdall.trublue.ch"
// #define TEST_DEVICE_TOKEN "XXXX-XXXX-XXXX-XXXX"

// ── Stepper-Kalibrierung: State-Machine überspringen, nur Stepper fahren ───
// Einkommentieren, flashen, Riegel beobachten, STEPPER_LOCK_STEPS anpassen.
// #define STEPPER_TEST
// #define GPIO_TEST
