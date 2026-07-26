#pragma once
#include <Arduino.h>
#include <math.h>
#include <time.h>
#include "config.h"
#include "log.h"
#include "nvs_storage.h"

// Alle Failsafe-Checks.  Safety > Security > Function.
// Die NOT-Failsafes (Low-Batt, Offline-Timeout) öffnen AUTONOM — unabhängig von Server/WLAN.
// Ein Policy-Offen (isPolicyExpired) BEWAFFNET das Öffnen dagegen nur: der Riegel fährt erst
// mit jemandem am Gerät auf (Präsenz-Gate policyOpenPermitted() in main.cpp, Entscheid 16.07).
namespace Failsafe {

  // ── Akku-Messpfad + Selbstkalibrierung ─────────────────────────────────────
  // Warum überhaupt kalibriert wird, steht in config.h beim Konstanten-Block.
  //
  // Persistiert wird NUR die Referenzspannung: die ROH-Spannung, die diese Box beim letzten
  // beobachteten Ladeschluss gemessen hat (0 = noch nie). Der Gain wird daraus abgeleitet,
  // nicht zweitgespeichert — ein Paar (Gain, Referenz) könnte auseinanderlaufen, ein
  // einzelner Wert nicht. Nebeneffekt: 0 ist ein eindeutiges „noch nie kalibriert", während
  // ein Gain von exakt 1,0 auch das legitime Ergebnis einer echten Kalibrierung sein kann.
  //
  // Function-local static → EINE Instanz über alle Übersetzungseinheiten hinweg, obwohl
  // failsafe.h header-only ist und mehrfach inkludiert wird. Vor dem ersten Laden aus NVS
  // gilt der Werkszustand — nie undefiniert.
  inline float& batteryRefV() { static float refV = 0.0f; return refV; }

  // Gültigkeitsband der Referenz. Wird beim Schreiben UND beim Lesen geprüft: die Invariante
  // gehört an den Wert, nicht an den einen Code-Pfad, der ihn zufällig schreibt. Sonst liefe
  // ein korrupter oder unter älteren Konstanten geschriebener NVS-Wert ungeprüft in den
  // Failsafe-Pfad. 0 (Werkszustand) fällt hier ebenfalls raus → unkalibriert.
  inline bool refPlausible(float refV) {
    return refV >= BATT_FULL_V / BATT_CAL_MAX && refV <= BATT_FULL_V / BATT_CAL_MIN;
  }

  inline bool  batteryCalibrated() { return refPlausible(batteryRefV()); }
  inline float batteryGain() { return batteryCalibrated() ? BATT_FULL_V / batteryRefV() : 1.0f; }

  // Akkuspannung OHNE Kalibrier-Gain. analogReadMilliVolts() statt analogRead(): nutzt die
  // eFuse-ADC-Kalibrierung des Chips und linearisiert die Attenuations-Kurve — beseitigt den
  // grössten Teil der Chip-zu-Chip-Streuung (Vref 1000–1200 mV) systematisch, ohne Zustand.
  // Messung ist bei WIFI_OFF genauer (ESP32 ADC beeinflusst durch WiFi-Rauschen).
  inline float batteryVoltsRaw() {
    uint32_t acc = 0;                                    // 16× mitteln gegen ADC-Rauschen
    for (int i = 0; i < 16; i++) acc += analogReadMilliVolts(PIN_BATT_ADC);
    return (acc / 16) / 1000.0f * BATT_DIVIDER;          // board-konfig (BATT_DIVIDER)
  }

  // Kalibrierte Akkuspannung. NAN, wenn unplausibel (kein Sensor am Pin) — sonst würde
  // "kein Sensor" als "0% = kritisch" fehlinterpretiert (Auto-Open).
  inline float batteryVolts() {
    float v = batteryVoltsRaw() * batteryGain();
    if (v < BATT_PLAUSIBLE_MIN_V || v > BATT_PLAUSIBLE_MAX_V) return NAN;
    return v;
  }

  // Spannung → Prozent. Getrennt, damit ein Aufrufer mit bereits gemessener Spannung nicht
  // ein zweites Mal messen muss (16 ADC-Samples je Messung).
  inline int percentFromVolts(float vBat) {
    if (!isfinite(vBat)) return BATT_UNKNOWN;
    int pct = (int)((vBat - BATT_EMPTY_V) / (BATT_FULL_V - BATT_EMPTY_V) * 100.0f);
    return constrain(pct, 0, 100);
  }

  // Akkustand in Prozent. BATT_UNKNOWN (-1) bei unplausibler Messung.
  inline int batteryPercent() { return percentFromVolts(batteryVolts()); }

  // Selbstkalibrierung: chargeFull (TP4056-STDBY) ist Hardware-Wahrheit für "diese Zelle steht
  // auf BATT_FULL_V" — die einzige Spannungsreferenz, die jede Box selbst mitbringt (kein
  // USB-/Serial-/Multimeter-Zugang im Feld). Bei JEDEM frischen Ladezustand aufrufen.
  //
  // SICHERHEITSRELEVANT: der Gain skaliert jede batteryPercent()-Antwort und damit auch
  // isLowBattery() und die 15-%-Notöffnung. Die gefährliche Richtung ist ein zu HOHER Gain —
  // die Box liest zu hoch, der Failsafe feuert zu spät, die Box kann verschlossen wegsterben.
  // Ein zu hoher Gain entsteht aus einer zu NIEDRIGEN Referenzmessung. Zwei Schutzschichten:
  //
  // 1. Nur die FLANKE laden→Ladeschluss zählt. chargeFull allein genügt NICHT: das Signal
  //    bleibt am Kabel stehen, während die Zelle Richtung TP4056-Recharge-Schwelle (~4,05 V)
  //    absackt. Eine Box, die erst Stunden nach Ladeende aufwacht, sähe chargeFull auf einer
  //    entspannten Zelle und nähme 4,05 V für 4,20 V — Gain 1,037, Notöffnung erst bei real
  //    ~3,2 V statt 3,35 V. Deshalb wird nur kalibriert, wenn dieselbe Box das Laden vorher
  //    SELBST gesehen hat. Am Kabel bleibt sie wach und resynct alle 30 s (DEBUG_RESYNC_MS),
  //    trifft die Flanke also im Normalfall live. Verschlafene Ladung → keine Kalibrierung.
  // 2. Die Klammer BATT_CAL_MIN/MAX prüft die REFERENZMESSUNG, nicht das Ergebnis: nur ein
  //    Rohwert, der schon von sich aus im Ladeschluss-Fenster liegt, wird angenommen.
  //
  // Verworfen heisst "bleibt unkalibriert" — der sichere Ausgang, nicht der Fehlerfall.
  //
  // Der Wert wird je Ladezyklus ÜBERSCHRIEBEN, nicht zum Maximum verrechnet. Ein Maximum
  // ratscht nur nach oben: bei ~2 Messungen/Minute am Kabel zieht der grösste Messausreisser
  // die Referenz dauerhaft hoch (Gain < 1 → Box liest zu niedrig → öffnet zu früh), ohne je
  // zurückzufinden. Überschreiben heilt sich mit der nächsten Volladung selbst.
  inline void observeCharge(bool charging, bool chargeFull) {
    static bool sawCharging = false;                 // nur RAM: ein verschlafener Ladevorgang
    if (charging)   { sawCharging = true; return; }  // lädt noch → Referenz erst am Ende
    if (!chargeFull) { sawCharging = false; return; }// kein Kabel mehr → Zyklus verfällt
    if (!sawCharging) return;                        // Ladeschluss ohne beobachtetes Laden
    sawCharging = false;                             // genau eine Referenz je Ladezyklus

    float raw = batteryVoltsRaw();                   // roh: die Referenz darf nicht durch den Gain laufen
    if (!refPlausible(raw)) {
      LOGW("Akku-Kalibrierung verworfen: %.3f V am Ladeschluss liegt ausserhalb %.2f–%.2f V "
           "— Box bleibt unkalibriert", raw, BATT_FULL_V / BATT_CAL_MAX, BATT_FULL_V / BATT_CAL_MIN);
      return;
    }
    if (fabsf(raw - batteryRefV()) < BATT_CAL_MIN_STEP_V) return; // unverändert → keine Flash-Zelle
    batteryRefV() = raw;
    NVS::saveBattRefV(raw);
    LOGI("Akku selbst kalibriert: Ladeschluss bei %.3f V gemessen → Faktor %.3f",
          raw, BATT_FULL_V / raw);
  }

  // Zurück auf Werkszustand (Debug-Seite). Die nächste Volladung kalibriert neu.
  inline void resetCalibration() {
    batteryRefV() = 0.0f;
    NVS::saveBattRefV(0.0f);
    LOGW("Akku-Kalibrierung zurückgesetzt — nächste Volladung kalibriert neu");
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

  // "Policy will offen": Server sagt offen ODER zeitliche Deadline abgelaufen.
  // serverLocked ist autoritativ — Simple-Lock (lockUntil==0, aber serverLocked) bleibt zu.
  // Zeit-Deadline zählt NUR bei gültiger Uhr — sonst übernimmt der Offline-Timeout
  // (sonst bliebe die Box bei 1970 ewig zu).
  // ACHTUNG Semantik seit 0.2.34: true heisst „darf/soll öffnen", NICHT „öffnet jetzt" —
  // vollzogen wird ein Policy-Offen nur mit Präsenz (policyOpenPermitted() in main.cpp).
  // Als Zufahr-Blocker wirkt es weiterhin sofort: solange die Policy offen will, wird nie zugefahren.
  inline bool isPolicyExpired(const BoxPolicy& policy) {
    if (!policy.serverLocked) return true;  // Server sagt offen
    if (policy.lockUntil == 0) return false; // Simple-Lock: zu, keine Deadline
    if (!clockValid()) return false;         // Uhr ungültig → nicht hierauf öffnen
    return time(nullptr) >= policy.lockUntil;
  }

} // namespace Failsafe
