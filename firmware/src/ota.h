#pragma once

// OTA-Update über HTTPS (Server-Pull). Lädt die .bin vom Server und schreibt sie
// in den inaktiven App-Slot. Bei Erfolg Reboot (kehrt dann nicht zurück).
// Sicherheits-Gating (Akku, nicht während Aktuierung) macht der Aufrufer.
namespace OTA {
  // sigHex: Ed25519-Signatur (128 Hex-Zeichen) über sha256(.bin). Leer/ungültig →
  // kein Flash (fail-closed). true→Reboot, false→Fehler/abgelehnt.
  bool apply(const char* url, const char* token, const char* sigHex);
}
