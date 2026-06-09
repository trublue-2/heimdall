#pragma once

#define FW_VERSION "0.1.0"

// ── Stepper (28BYJ-48 via ULN2003) ────────────────────────────────────────
// Boot-sichere GPIOs ohne Strapping-Konflikt.
#define STEPPER_IN1 32
#define STEPPER_IN2 33
#define STEPPER_IN3 25
#define STEPPER_IN4 26

// Schritte pro Richtung — muss nach Bench-Test kalibriert werden.
// 28BYJ-48 Half-Step: 4096 Steps/Umdrehung; echter Riegelweg < 1 Umdrehung.
#define STEPPER_LOCK_STEPS  512   // TODO: Kalibrieren
#define STEPPER_STEP_DELAY_US 1200 // µs — langsamer = mehr Drehmoment

// ── Button ─────────────────────────────────────────────────────────────────
// GPIO36 (VP): RTC-GPIO, input-only, kein Strapping-Konflikt.
// Externes Pull-Down (10k) nötig — kein interner PD auf GPIO36.
// Button: GPIO36 → 3.3V bei Tastendruck → EXT0-Wake auf HIGH.
#define PIN_BUTTON 36

// ── Batterie ADC ───────────────────────────────────────────────────────────
// LOLIN D32: GPIO35 mit 100k/100k Teiler → misst Vbat/2.
#define PIN_BATT_ADC      35
#define BATT_LOW_PERCENT  15  // % Warnung / LED
#define BATT_CRITICAL_PCT  8  // % → Auto-Open Failsafe

// ── Timeouts ───────────────────────────────────────────────────────────────
#define IDLE_SLEEP_MS            (3UL * 60 * 1000) // 3 min → Deep-Sleep
#define OFFLINE_OPEN_H           24                 // h ohne Sync → Auto-Open
#define WIFI_CONNECT_TIMEOUT_MS  (15 * 1000)        // 15 s WiFi-Connect-Limit

// ── Server API ─────────────────────────────────────────────────────────────
#define SERVER_PATH_REGISTER "/api/box/register"
#define SERVER_PATH_SYNC     "/api/box/sync"

// ── Bench-Test: Credentials (auskommentiert lassen, nur lokal setzen) ──────
// #define TEST_WIFI_SSID    "MeinWLAN"
// #define TEST_WIFI_PASS    "Passwort"
// #define TEST_SERVER_URL   "https://heimdall.trublue.ch"
// #define TEST_DEVICE_TOKEN "XXXX-XXXX-XXXX-XXXX"
