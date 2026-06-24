#pragma once
#include <Arduino.h>

namespace Stepper {
  void begin();
  void lock();     // Riegel zu (dreht in positive Richtung)
  void unlock();   // Riegel auf (dreht in negative Richtung)
  void powerOff(); // Alle Spulen aus — wichtig vor Deep-Sleep

  // Debug-Mode (zugleich Vorarbeit fürs spätere Board-Profil):
  void setPins(uint8_t a, uint8_t b, uint8_t c, uint8_t d); // Stepper-Pins zur Laufzeit umsetzen
  void pulse(uint8_t pin, uint16_t ms);                     // einzelnen GPIO HIGH für ms (Pin-Sweep)
  String pinsCsv();                                         // aktuelle Pins als "a,b,c,d" (Status)
}
