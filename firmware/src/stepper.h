#pragma once
#include <Arduino.h>

namespace Stepper {
  void begin();
  void lock();     // Riegel zu (dreht in positive Richtung)
  void unlock();   // Riegel auf (dreht in negative Richtung)
  void powerOff(); // Alle Spulen aus — wichtig vor Deep-Sleep
}
