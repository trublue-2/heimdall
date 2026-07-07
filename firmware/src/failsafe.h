#pragma once
#include <Arduino.h>
#include <time.h>
#include "config.h"
#include "nvs_storage.h"

// Alle Failsafe-Checks.  Safety > Security > Function.
// Jeder dieser Checks kann die Box öffnen — unabhängig von Server/WLAN.
namespace Failsafe {

  // Akkustand in Prozent (PIN_BATT_ADC, 1:2-Teiler, 4.2V=100%, 3.2V=0%; LMB=GPIO32).
  // Messung ist bei WIFI_OFF genauer (ESP32 ADC beeinflusst durch WiFi-Rauschen).
  // Gibt BATT_UNKNOWN (-1) zurück, wenn die Spannung unplausibel ist (kein Sensor am
  // Pin) — sonst würde "kein Sensor" als "0% = kritisch" fehlinterpretiert (Auto-Open).
  inline int batteryPercent() {
    uint32_t acc = 0;                                    // 16× mitteln gegen ADC-Rauschen (wie der Debug-Scan)
    for (int i = 0; i < 16; i++) acc += analogRead(PIN_BATT_ADC);
    int raw = (int)(acc / 16);
    float vBat = (raw / 4095.0f) * 3.3f * BATT_DIVIDER; // board-konfig (BATT_DIVIDER)
    if (vBat < BATT_PLAUSIBLE_MIN_V || vBat > BATT_PLAUSIBLE_MAX_V) return BATT_UNKNOWN;
    int pct = (int)((vBat - 3.2f) / (4.2f - 3.2f) * 100.0f);
    return constrain(pct, 0, 100);
  }

  // Wall-Clock plausibel? Nach Power-on/Brownout ist time()≈0 (1970), bis NTP läuft.
  // Zeit-basierte Server-Deadlines dürfen einer ungültigen Uhr NICHT vertrauen.
  inline bool clockValid() { return time(nullptr) > 1700000000; } // ~2023-11

  // Low-Battery mit HYSTERESE: latcht ab ≤ BATT_CRITICAL_PCT, löst erst wieder ≥ BATT_RECOVER_PCT
  // → kein Flattern durch ADC-Rauschen um die 15%-Schwelle. Unbekannter Akku (kein Sensor)
  // feuert NICHT — sonst öffnete ein Board ohne Akku-Messung bei jedem Wake.
  inline bool isLowBattery(BoxState& state) {
    int p = batteryPercent();
    if (p == BATT_UNKNOWN) return false;              // kein Sensor → nicht feuern
    if (p <= BATT_CRITICAL_PCT)     state.lowBattLatched = true;
    else if (p >= BATT_RECOVER_PCT) state.lowBattLatched = false;
    return state.lowBattLatched;
  }

  // Offline-Timeout: zu lange kein erfolgreicher Sync. CLOCK-UNABHÄNGIG über den
  // monotonen offlineSeconds-Zähler — greift auch bei 1970-Uhr (genau dann nötig).
  inline bool isOfflineTimeout(const BoxState& state, const BoxPolicy& policy) {
    return state.offlineSeconds >= (uint32_t)policy.offlineOpenH * 3600u;
  }

  // HardCap: absolute, NIE überschreitbare Sperr-Obergrenze (CLAUDE.md). Lokal
  // enforced über die monotone Sperrdauer — unabhängig von Server UND Wall-Clock.
  inline bool isHardCapExceeded(const BoxState& state, const BoxPolicy& policy) {
    if (policy.hardCapH <= 0) return false; // 0 = kein Cap
    return state.lockedSeconds >= (uint32_t)policy.hardCapH * 3600u;
  }

  // "Soll offen": Server sagt offen ODER zeitliche Deadline abgelaufen.
  // serverLocked ist autoritativ — Simple-Lock (lockUntil==0, aber serverLocked) bleibt zu.
  // Zeit-Deadline öffnet NUR bei gültiger Uhr — sonst übernehmen Offline-Timeout/HardCap
  // (sonst bliebe die Box bei 1970 ewig zu).
  inline bool isPolicyExpired(const BoxPolicy& policy) {
    if (!policy.serverLocked) return true;  // Server sagt offen
    if (policy.lockUntil == 0) return false; // Simple-Lock: zu, keine Deadline
    if (!clockValid()) return false;         // Uhr ungültig → nicht hierauf öffnen
    return time(nullptr) >= policy.lockUntil;
  }

  // Fasst alle Öffnungsgründe zusammen: true → Box muss jetzt öffnen.
  inline bool shouldOpen(BoxState& state, const BoxPolicy& policy) {
    return isLowBattery(state)
        || isOfflineTimeout(state, policy)
        || isHardCapExceeded(state, policy)
        || isPolicyExpired(policy);
  }

} // namespace Failsafe
