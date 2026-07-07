#pragma once
#include <Arduino.h>

// Neue serielle Log-Bytes seit dem letzten Sync-Upload (newline-getrennt, auf maxBytes
// gekappt) — für den Server-Log (logToServer). In main.cpp definiert (dort liegt der
// Ring-Puffer), von server_sync.cpp genutzt. Schiebt den Cursor weiter; best-effort
// (bei fehlgeschlagenem Sync gehen die paar Zeilen verloren — fürs Debug-Log ok).
String collectSyncLogs(size_t maxBytes);
