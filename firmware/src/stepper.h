#pragma once
#include <Arduino.h>

namespace Stepper {
  void begin();
  void lock();     // Riegel zu (dreht in positive Richtung)
  void unlock();   // Riegel auf (dreht in negative Richtung)
  void reopen();   // Riegel-Retry: kurz zurück, dann voller Öffnungshub (löst Verkanten, gedeckelt)
  void powerOff(); // Alle Spulen aus — wichtig vor Deep-Sleep
}
