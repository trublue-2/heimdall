#pragma once

// OTA-Update über HTTPS (Server-Pull). Lädt die .bin vom Server und schreibt sie
// in den inaktiven App-Slot. Bei Erfolg Reboot (kehrt dann nicht zurück).
// Sicherheits-Gating (Akku, nicht während Aktuierung) macht der Aufrufer.
namespace OTA {
  bool apply(const char* url, const char* token); // true→Reboot, false→Fehler
}
