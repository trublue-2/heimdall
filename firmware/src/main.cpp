#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include <time.h>
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

// Knopfdruck wird per Interrupt gelatcht — so geht keine Flanke verloren,
// auch nicht während SYNCING/Boot/Actuation, wo der Loop nicht pollt.
static volatile bool   gBtnLatched     = false;
static void IRAM_ATTR onButtonIsr() { gBtnLatched = true; }

// ── Diagnose (über WLAN sichtbar, kein Serial nötig) ────────────────────────
// Persistente Zähler in NVS: Brownouts zeigen sich als Resets, die KEIN
// Deep-Sleep-Wake sind (POWERON/BROWNOUT). gUnexpected klettert dann hoch.
static uint32_t    gBootCount  = 0;
static uint32_t    gUnexpected = 0;
static const char* gResetReason = "?";

static const char* resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_EXT:       return "EXT";
    default:                return "OTHER";
  }
}

static void recordBoot() {
  esp_reset_reason_t r = esp_reset_reason();
  gResetReason = resetReasonStr(r);
  Preferences p;
  p.begin("diag", false);
  gBootCount  = p.getUInt("boots", 0) + 1;
  gUnexpected = p.getUInt("unexp", 0);
  // Alles außer regulärem Deep-Sleep-Wake gilt als unerwartet (Brownout-Verdacht).
  if (r != ESP_RST_DEEPSLEEP) gUnexpected++;
  p.putUInt("boots", gBootCount);
  p.putUInt("unexp", gUnexpected);
  p.end();
}

// LED-Sofortquittung: 3× gegen den aktuellen Pegel blitzen (Knopfdruck angekommen).
// Gegenphasig, damit die Quittung auch bei dauerleuchtender LED (LOCKED) sichtbar ist.
static void ledAck() {
  int rest = digitalRead(PIN_LED); // Ruhepegel des aktuellen Zustands
  int flash = (rest == LED_ON) ? LED_OFF : LED_ON;
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED, flash); delay(90);
    digitalWrite(PIN_LED, rest);  delay(90);
  }
}

// ── Statusseite (nur aktiv solange am Strom, siehe loop) ────────────────────
static WebServer gWeb(80);
static bool      gWebOn = false;

// Epoch → "TT.MM.JJJJ HH:MM" in lokaler Zeit (TZ in syncNtp gesetzt).
static String fmtLocal(time_t t) {
  if (t <= 0) return "—";
  struct tm tm_l;
  localtime_r(&t, &tm_l);
  char buf[20];
  strftime(buf, sizeof(buf), "%d.%m.%Y %H:%M", &tm_l);
  return String(buf);
}

static void handleStatus() {
  bool   locked = gBox.locked;
  String html = "<!DOCTYPE html><html lang=de><head><meta charset=utf-8>"
                "<meta name=viewport content='width=device-width,initial-scale=1'>"
                "<meta http-equiv=refresh content=5>"
                "<title>Heimdall</title><style>"
                "body{font-family:system-ui,sans-serif;margin:0;padding:2rem;"
                "background:#0f1115;color:#e6e6e6;text-align:center}"
                ".s{font-size:2rem;font-weight:700;margin:1rem 0;padding:1rem;border-radius:1rem}"
                ".lock{background:#2a1416;color:#ff6b6b}.open{background:#13241a;color:#4ade80}"
                ".m{color:#8a8a8a;font-size:.9rem;margin:.3rem}</style></head><body>"
                "<h2>🔒 Heimdall</h2>";
  if (locked) {
    html += "<div class='s lock'>GESCHLOSSEN</div>";
    if (gPolicy.lockUntil > 0)
      html += "<p class=m>bis " + fmtLocal(gPolicy.lockUntil) + "</p>";
  } else {
    html += "<div class='s open'>OFFEN</div>";
  }
  html += "<p class=m>Zeit: " + fmtLocal(time(nullptr)) + "</p>";
  html += "<p class=m>Akku: " + String(gBox.batteryPct) + "% · "
          + String(WiFi.RSSI()) + " dBm · fw " + FW_VERSION + "</p>";
  // Diagnose: gUnexpected > Boot-Power-On = Brownout-Verdacht (über WLAN sichtbar).
  html += "<p class=m>Boots: " + String(gBootCount)
          + " · unerwartet: " + String(gUnexpected)
          + " · Reset: " + String(gResetReason) + "</p>";
  html += "<p class=m>Uptime: " + String(millis() / 1000) + " s · Heap: "
          + String(ESP.getFreeHeap() / 1024) + " kB</p>";
  html += "</body></html>";
  gWeb.send(200, "text/html", html);
}

// Stellt WiFi + Web-Server sicher (für die Statusseite am Strom).
static void ensureStatusServer() {
  if (WiFi.status() != WL_CONNECTED) {
    gWebOn = false;
    WiFi.mode(WIFI_STA);
    WiFi.begin(gCreds.ssid, gCreds.password);
    WiFi.setTxPower(WIFI_TX_POWER); // erst NACH begin() — STA muss gestartet sein
    unsigned long t = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t < WIFI_CONNECT_TIMEOUT_MS) delay(100);
    if (WiFi.status() != WL_CONNECTED) return;
  }
  if (!gWebOn) {
    gWeb.begin();
    gWebOn = true;
    log_i("Statusseite live: http://%s/", WiFi.localIP().toString().c_str());
  }
}

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
  // Periodischer Sync alle WAKE_INTERVAL_S — oder früher, wenn eine
  // Policy-Deadline näher liegt (dann genau zur Deadline aufwachen).
  uint64_t timerS = WAKE_INTERVAL_S;
  if (gPolicy.lockUntil > 0) {
    time_t remaining = gPolicy.lockUntil - time(nullptr);
    if (remaining > 60 && remaining < (long)timerS) timerS = (uint64_t)remaining;
  }

  log_i("Deep-Sleep — button=GPIO%d LOW, timer=%llus", PIN_BUTTON, timerS);
  detachInterrupt(digitalPinToInterrupt(PIN_BUTTON)); // GPIO-ISR freigeben, EXT0 übernimmt
  Stepper::powerOff();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  // GPIO0 = BOOT-Button, Pull-Up → normalerweise HIGH.
  // Wake auf LOW: aufwachen wenn Button gedrückt (zieht GPIO0 auf GND).
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_BUTTON, LOW);
  esp_sleep_enable_timer_wakeup(timerS * 1000000ULL);
  esp_deep_sleep_start();
}

// ── setup: läuft einmal nach jedem Wake / Power-On ──────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200); // Sicherstellen dass UART-Buffer geleert wird vor erstem Log
  // CPU auf 80 MHz (WiFi-Minimum) drosseln: spart ~20-25 mA und gibt damit
  // dem schwachen LOLIN-D32-LDO Reserve für die WLAN-Stromspitzen (Brownout).
  setCpuFrequencyMhz(80);
  recordBoot(); // Reset-Grund + Zähler (über WLAN/Statusseite sichtbar)
  NVS::begin();
  Stepper::begin();
  gWeb.on("/", handleStatus); // Statusseite-Route einmalig registrieren
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LED_OFF);
  pinMode(PIN_BUTTON, INPUT_PULLUP); // GPIO0: HIGH per Pull-up, LOW bei Druck
  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), onButtonIsr, FALLING);
  gLastActivityMs = millis();

  // Sofort-Quittung bei Knopfdruck aus dem Schlaf: 3× blinken, bevor WiFi/Sync.
  // Der User vor Ort sieht innerhalb ~0.3 s, dass der Druck angekommen ist.
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) ledAck();

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

  // Lade-Status: Vergleich aktueller Messwert vs. gespeicherter Vorwert (≥2% Schwelle)
  int prevBatt = gBox.batteryPct; // aus NVS (-1 = noch nie gespeichert)
  gBox.batteryPct = batt;
  gBox.charging = (prevBatt >= 0) && (batt >= prevBatt + 2);

  // LED zeigt Lock-Status NUR während die Box wach ist (Knopfdruck → Status auf Abruf).
  // Bewusst KEIN gpio_hold im Deep-Sleep: spart Akku, LED erlischt im Schlaf.
  // Sofort aus gecachtem NVS-Zustand setzen — vor dem Sync (der bis zu 15s dauert).
  digitalWrite(PIN_LED, (hasState && gBox.locked) ? LED_ON : LED_OFF);
  log_i("NVS: hasState=%d locked=%d lockedSince=%ld | LED=%d",
        hasState, gBox.locked, (long)gBox.lockedSince, (hasState && gBox.locked));

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
  gBtnLatched = false; // Boot-Bounce verwerfen — der Initial-Sync läuft ohnehin
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
        log_i("Entscheidung: locked=%d lockUntil=%ld shouldLock=%d expired=%d",
              gBox.locked, (long)gPolicy.lockUntil, shouldLock,
              Failsafe::isPolicyExpired(gPolicy));

        if (gBox.locked && Failsafe::isPolicyExpired(gPolicy)) {
          gState = State::OPENING;
        } else if (!gBox.locked && shouldLock) {
          log_i("Policy: Sperren bis %ld", (long)gPolicy.lockUntil);
          gBox.locked      = true;
          gBox.lockedSince = time(nullptr);
          NVS::saveState(gBox);
          Stepper::lock();
          gLastActivityMs = millis();
          // Neuen Zustand sofort an Server melden — sonst zeigt das Web "Offen"
          // bis zum nächsten Wake (Diskrepanz zur LED).
          ServerSync::run(gCreds, gBox, gPolicy);
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
    case State::IDLE_OPEN: {
      digitalWrite(PIN_LED, (gState == State::LOCKED) ? LED_ON : LED_OFF);

      // Per ISR gelatchter Druck — auch dann gesetzt, wenn er während eines
      // anderen Zustands (SYNCING/Boot) kam. Flag konsumieren und syncen.
      if (gBtnLatched) {
        gBtnLatched = false;
        log_i("Button (wach) → Sync");
        ledAck();
        gLastActivityMs = millis();
        gState = State::SYNCING;
        break;
      }

      // Status-Seite in jedem Wach-Fenster bedienen — entkoppelt von der
      // unzuverlässigen Power-Erkennung. Nach IDLE_SLEEP_MS ohne Aktivität
      // Deep-Sleep; der periodische Re-Sync läuft über den Timer-Wake.
      ensureStatusServer();
      gWeb.handleClient();

      if (millis() - gLastActivityMs > IDLE_SLEEP_MS) {
        goDeepSleep();
      } else {
        delay(10);
      }
      break;
    }
  }
}
