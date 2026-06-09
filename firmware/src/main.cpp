#include <Arduino.h>
#include "config.h"
#include "nvs_storage.h"
#include "stepper.h"
#include "server_sync.h"
#include "failsafe.h"

// ── State-Machine ───────────────────────────────────────────────────────────
enum class State {
  PROVISIONING, // Keine WLAN/Token-Credentials in NVS → wartet auf Setup
  SYNCING,      // Verbindet WiFi, synct Policy vom Server
  OPENING,      // Führt Öffnungssequenz aus
  LOCKED,       // Riegel zu, wartet auf Deadline oder Wake
  IDLE_OPEN,    // Riegel offen, wartet auf neue Policy oder User-Intent
};

static State           gState          = State::PROVISIONING;
static WifiCredentials gCreds          = {};
static BoxState        gBox            = {};
static BoxPolicy       gPolicy         = {};
static unsigned long   gLastActivityMs = 0;

// ── Wake-Reason ─────────────────────────────────────────────────────────────
static const char* wakeReasonStr() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_EXT0:  return "button";
    case ESP_SLEEP_WAKEUP_TIMER: return "rtc_timer";
    default:                      return "power_on";
  }
}

// ── Deep-Sleep ──────────────────────────────────────────────────────────────
static void goDeepSleep() {
  // Timer-Wake: kurz vor Policy-Deadline aufwachen (falls gesetzt).
  uint64_t timerUs = 0;
  if (gPolicy.lockUntil > 0) {
    time_t remaining = gPolicy.lockUntil - time(nullptr);
    if (remaining > 60 && remaining < (long)(gPolicy.offlineOpenH * 3600LL)) {
      timerUs = (uint64_t)remaining * 1000000ULL;
    }
  }

  log_i("Deep-Sleep — button=GPIO%d LOW, timer=%llus",
        PIN_BUTTON, timerUs / 1000000ULL);
  Stepper::powerOff();
  // GPIO0 = BOOT-Button, Pull-Up → normalerweise HIGH.
  // Wake auf LOW: aufwachen wenn Button gedrückt (zieht GPIO0 auf GND).
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_BUTTON, LOW);
  if (timerUs > 0) esp_sleep_enable_timer_wakeup(timerUs);
  esp_deep_sleep_start();
}

// ── setup: läuft einmal nach jedem Wake / Power-On ──────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200); // Sicherstellen dass UART-Buffer geleert wird vor erstem Log
  NVS::begin();
  Stepper::begin();
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  gLastActivityMs = millis();

  // Batterie vor WiFi messen — ADC ist ohne WiFi-Rauschen genauer
  int batt = Failsafe::batteryPercent();

  const char* reason = wakeReasonStr();
  log_i("=== Heimdall %s | Wake: %s | Batt: %d%% ===", FW_VERSION, reason, batt);

  // ── Bench-Test: Stepper/GPIO manuell testen ──────────────────────────────
#if defined(GPIO_TEST) || defined(STEPPER_TEST)
  const uint8_t testPins[4] = {STEPPER_IN1, STEPPER_IN2, STEPPER_IN3, STEPPER_IN4};
  log_i("[GPIO_TEST] IN1=GPIO%d IN2=GPIO%d IN3=GPIO%d IN4=GPIO%d",
        STEPPER_IN1, STEPPER_IN2, STEPPER_IN3, STEPPER_IN4);
  for (int i = 0; i < 4; i++) {
    log_i("[GPIO_TEST] IN%d (GPIO%d) HIGH …", i+1, testPins[i]);
    digitalWrite(testPins[i], HIGH);
    delay(1000);
    digitalWrite(testPins[i], LOW);
    delay(300);
  }
  log_i("[GPIO_TEST] Fertig.");
#endif
#ifdef STEPPER_TEST
  delay(1000);
  log_i("[STEPPER_TEST] Steps=%d Delay=%dus", STEPPER_LOCK_STEPS, STEPPER_STEP_DELAY_US);
  for (int round = 1; round <= 3; round++) {
    log_i("[STEPPER_TEST] Runde %d — lock", round);
    Stepper::lock();
    delay(2000);
    log_i("[STEPPER_TEST] Runde %d — unlock", round);
    Stepper::unlock();
    delay(2000);
  }
  log_i("[STEPPER_TEST] Fertig.");
#endif
#if defined(GPIO_TEST) || defined(STEPPER_TEST)
  return;
#endif

  // ── Zustand aus NVS laden ────────────────────────────────────────────────
  bool hasCreds = NVS::loadCredentials(gCreds);
  bool hasState = NVS::loadState(gBox);
  NVS::loadPolicy(gPolicy);
  strlcpy(gBox.wakeReason, reason, sizeof(gBox.wakeReason));
  gBox.batteryPct = batt;

  // ── Bench-Test: Credentials aus config.h flashen ─────────────────────────
#if defined(TEST_WIFI_SSID) && defined(TEST_DEVICE_TOKEN)
  if (!hasCreds) {
    log_w("Bench-Test: Schreibe Test-Credentials in NVS …");
    strlcpy(gCreds.ssid,        TEST_WIFI_SSID,    sizeof(gCreds.ssid));
    strlcpy(gCreds.password,    TEST_WIFI_PASS,    sizeof(gCreds.password));
    strlcpy(gCreds.serverUrl,   TEST_SERVER_URL,   sizeof(gCreds.serverUrl));
    strlcpy(gCreds.deviceToken, TEST_DEVICE_TOKEN, sizeof(gCreds.deviceToken));
    NVS::saveCredentials(gCreds);
    hasCreds = true;
  }
#endif

  if (!hasCreds) {
    gState = State::PROVISIONING;
    return;
  }

  gState = (hasState && gBox.locked) ? State::LOCKED : State::IDLE_OPEN;

  // ── P0: Failsafes — Safety vor Security vor Funktion ────────────────────
  if (Failsafe::isLowBattery()) {
    log_w("FAILSAFE: Low-Battery (%d%%) → OPENING", Failsafe::batteryPercent());
    strlcpy(gBox.wakeReason, "low_battery", sizeof(gBox.wakeReason));
    gState = State::OPENING;
    return;
  }

  if (gBox.locked && Failsafe::isOfflineTimeout(gBox, gPolicy)) {
    log_w("FAILSAFE: Offline-Timeout (%dh) → OPENING", gPolicy.offlineOpenH);
    strlcpy(gBox.wakeReason, "offline_timeout", sizeof(gBox.wakeReason));
    gState = State::OPENING;
    return;
  }

  gState = State::SYNCING;
}

// ── loop: State-Machine ──────────────────────────────────────────────────────
void loop() {
  switch (gState) {

    // ── PROVISIONING ──────────────────────────────────────────────────────
    case State::PROVISIONING:
      // TODO: Captive-Portal / AP-Modus implementieren
      log_w("PROVISIONING: Keine Credentials. Captive Portal nicht implementiert.");
      delay(5000);
      break;

    // ── SYNCING ───────────────────────────────────────────────────────────
    case State::SYNCING: {
      log_i("SYNCING …");
      SyncResult res = ServerSync::run(gCreds, gBox, gPolicy);

      if (res == SyncResult::OK) {
        bool shouldLock = (gPolicy.lockUntil > 0 && time(nullptr) < gPolicy.lockUntil);

        if (gBox.locked && Failsafe::isPolicyExpired(gPolicy)) {
          gState = State::OPENING;
        } else if (!gBox.locked && shouldLock) {
          log_i("Policy: Sperren bis %ld", (long)gPolicy.lockUntil);
          gBox.locked      = true;
          gBox.lockedSince = time(nullptr);
          NVS::saveState(gBox);
          Stepper::lock();
          gState = State::LOCKED;
        } else {
          gState = gBox.locked ? State::LOCKED : State::IDLE_OPEN;
        }
      } else {
        log_e("Sync fehlgeschlagen (code=%d) — arbeite mit Cache", (int)res);
        if (gBox.locked && Failsafe::isPolicyExpired(gPolicy)) {
          gState = State::OPENING;
        } else {
          gState = gBox.locked ? State::LOCKED : State::IDLE_OPEN;
        }
      }
      break;
    }

    // ── OPENING ───────────────────────────────────────────────────────────
    case State::OPENING:
      log_i("OPENING …");
      Stepper::unlock();
      gBox.locked = false;
      NVS::saveState(gBox);
      gState = State::IDLE_OPEN;
      gLastActivityMs = millis();
      // Best-effort Sync nach Öffnen (wakeReason landet im Event-Log)
      ServerSync::run(gCreds, gBox, gPolicy);
      break;

    // ── LOCKED / IDLE_OPEN ────────────────────────────────────────────────
    case State::LOCKED:
      digitalWrite(PIN_LED, HIGH);
      if (millis() - gLastActivityMs > IDLE_SLEEP_MS) goDeepSleep();
      delay(100);
      break;

    case State::IDLE_OPEN:
      digitalWrite(PIN_LED, LOW);
      if (millis() - gLastActivityMs > IDLE_SLEEP_MS) goDeepSleep();
      delay(100);
      break;
  }
}
