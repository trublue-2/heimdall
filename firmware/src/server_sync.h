#pragma once
#include "nvs_storage.h"

enum class SyncResult {
  OK,
  NO_WIFI,       // WiFi-Connect fehlgeschlagen
  SERVER_ERROR,  // HTTP != 200 oder Parse-Fehler
  AUTH_ERROR,    // 401 / 403 → Token ungültig
};

// OTA-Hinweis aus der Sync-Response (Server-Pull). version leer = kein Update.
struct OtaInfo {
  char version[16];
  char url[256];
};

namespace ServerSync {
  // Verbindet WiFi, synct Zustand mit Heimdall-Server,
  // schreibt aktualisierte Policy zurück in `policy` und NVS.
  // keepWifi=false: WiFi nach dem Call abschalten (Standard, akkuschonend).
  // keepWifi=true:  WiFi anlassen (z.B. wenn die Statusseite weiterläuft).
  // ota (optional): füllt version/url, wenn der Server eine neue FW anbietet.
  SyncResult run(const WifiCredentials& creds, BoxState& state, BoxPolicy& policy,
                 bool keepWifi = false, OtaInfo* ota = nullptr);
}
