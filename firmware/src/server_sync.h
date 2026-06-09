#pragma once
#include "nvs_storage.h"

enum class SyncResult {
  OK,
  NO_WIFI,       // WiFi-Connect fehlgeschlagen
  SERVER_ERROR,  // HTTP != 200 oder Parse-Fehler
  AUTH_ERROR,    // 401 / 403 → Token ungültig
};

namespace ServerSync {
  // Verbindet WiFi, synct Zustand mit Heimdall-Server,
  // schreibt aktualisierte Policy zurück in `policy` und NVS.
  // WiFi wird nach dem Call wieder abgeschaltet.
  SyncResult run(const WifiCredentials& creds, BoxState& state, BoxPolicy& policy);
}
