#pragma once

// Setup-Hotspot (AP + Captive-Portal). Blockiert, bis der Nutzer fertig ist oder die Frist
// abläuft, und endet immer mit einem Neustart. Wer ihn betritt und wie er endet, zeigt
// `run()`; hier stehen nur die Zusagen, auf die sich der Rest verlässt:
//
//  • Credentials werden NUR hier gelöscht, auf ausdrücklichen Befehl — und nie bei
//    geschlossenem Riegel. Eine Box, die jemanden einschliesst, muss den Weg zurück zu ihrem
//    Server behalten.
//  • Die Not-Öffnungen (Akku, Funkstille) laufen auch hier weiter — der Hotspot hat dafür
//    eine eigene Wache, weil die State-Machine solange nicht tickt.
namespace Provisioning {
  // `idleTimeout`: darf der Hotspot nach SETUP_IDLE_TIMEOUT_MS von selbst aufgeben? Nur für
  // den Taster-Eintritt sinnvoll — wer wegen eines abgelehnten Tokens hier landet, braucht
  // Zeit, um sich anderswo einen frischen Setup-Link zu holen.
  void run(bool idleTimeout); // kehrt nie zurück (endet mit ESP.restart())
}
