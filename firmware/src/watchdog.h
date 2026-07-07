#pragma once
#include <Arduino.h>
#include "config.h"

// Hardware-Watchdog auf einem dedizierten HW-Timer (bewusst UNABHAENGIG vom Core-Task-WDT,
// der ohnehin auf idle-CPU0 laeuft): feuert WDT_TIMEOUT_S nach dem letzten feed() einen
// Timer-ISR, der die Box hart neu startet — Selbstheilung gegen Firmware-Haenger (Deadlock,
// blockierender Call, Endlosschleife). Der Reboot laeuft durch setup() → alle lokalen
// Failsafes werden neu ausgewertet. Nur im Wach-Zustand aktiv (Deep-Sleep haelt den Timer
// an, der Wake bootet frisch). Safety-Netz, KEIN Ersatz fuer die lokalen Failsafes.
namespace Watchdog {
  // Einmal beim ersten loop()-Eintritt aufrufen: HW-Timer scharf schalten (idempotent).
  // Bewusst NICHT in setup(): so bleiben setup() und die Dev-Test-Modi (STEPPER_TEST/
  // GPIO_TEST, die vorher endlos laufen) unbewacht und loesen keinen Fehl-Reset aus.
  void begin();
  // In jeder langen Schleife/Iteration aufrufen — solange Fortschritt da ist, kein Reboot.
  void feed();
}
