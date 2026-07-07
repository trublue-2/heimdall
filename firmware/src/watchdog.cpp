#include "watchdog.h"
#include <esp_system.h> // esp_restart()

namespace {
  hw_timer_t* g_wdtTimer = nullptr;

  // Timer-ISR: Firmware haengt seit WDT_TIMEOUT_S (kein feed) → harter Neustart.
  // Minimal + IRAM-sicher; esp_restart() ist aus ISR-Kontext aufrufbar (Standard-Muster).
  void IRAM_ATTR onWatchdogTimeout() {
    esp_restart();
  }
}

void Watchdog::begin() {
  if (g_wdtTimer) return; // idempotent — nur einmal scharf schalten
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  // Arduino-Core 3.x: Frequenz-basierte API. 1 MHz → 1 Tick = 1 µs; one-shot (autoreload=false).
  g_wdtTimer = timerBegin(1000000);
  timerAttachInterrupt(g_wdtTimer, &onWatchdogTimeout);
  timerAlarm(g_wdtTimer, (uint64_t)WDT_TIMEOUT_S * 1000000ULL, false, 0);
#else
  // Arduino-Core 2.x: Timer 0, Teiler 80 (80 MHz APB /80 → 1 MHz). Edge-ISR, one-shot.
  g_wdtTimer = timerBegin(0, 80, true);
  timerAttachInterrupt(g_wdtTimer, &onWatchdogTimeout, true);
  timerAlarmWrite(g_wdtTimer, (uint64_t)WDT_TIMEOUT_S * 1000000ULL, false);
  timerAlarmEnable(g_wdtTimer);
#endif
}

void Watchdog::feed() {
  if (g_wdtTimer) timerWrite(g_wdtTimer, 0); // Zaehler zurueck auf 0 → Alarm verschoben
}
