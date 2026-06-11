#pragma once
#include <Arduino.h>
#include <time.h>
#include "config.h"
#include "nvs_storage.h"

// Alle Failsafe-Checks.  Safety > Security > Function.
// Jeder dieser Checks kann die Box öffnen — unabhängig von Server/WLAN.
namespace Failsafe {

  // Akkustand in Prozent (LOLIN D32: GPIO35, 100k/100k Teiler, 4.2V=100%, 3.2V=0%).
  // Messung ist bei WIFI_OFF genauer (ESP32 ADC beeinflusst durch WiFi-Rauschen).
  inline int batteryPercent() {
    int raw = analogRead(PIN_BATT_ADC);
    float vBat = (raw / 4095.0f) * 3.3f * 2.0f; // Teiler 1:2
    int pct = (int)((vBat - 3.2f) / (4.2f - 3.2f) * 100.0f);
    return constrain(pct, 0, 100);
  }

  // Low-Battery: Öffnen solange noch genug Energie für den Stepper da ist.
  inline bool isLowBattery() {
    return batteryPercent() <= BATT_CRITICAL_PCT;
  }

  // Offline-Timeout: letzter erfolgreicher Sync liegt zu lang zurück.
  inline bool isOfflineTimeout(const BoxState& state, const BoxPolicy& policy) {
    if (state.lastSyncAt == 0) return false;
    long elapsedH = (long)(time(nullptr) - state.lastSyncAt) / 3600;
    return elapsedH >= policy.offlineOpenH;
  }

  // Policy-Deadline: Server-Vorgabe abgelaufen oder kein Lock gesetzt.
  inline bool isPolicyExpired(const BoxPolicy& policy) {
    if (policy.lockUntil == 0) return true; // kein Lock → offen
    return time(nullptr) >= policy.lockUntil;
  }

  // Fasst alle drei zusammen: true → Box muss jetzt öffnen.
  inline bool shouldOpen(const BoxState& state, const BoxPolicy& policy) {
    return isLowBattery()
        || isOfflineTimeout(state, policy)
        || isPolicyExpired(policy);
  }

} // namespace Failsafe
