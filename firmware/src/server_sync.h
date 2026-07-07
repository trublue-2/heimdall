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
  char sig[129]; // Ed25519-Signatur als 128 Hex-Zeichen (+ '\0')
};

namespace ServerSync {
  // Verbindet WiFi, synct Zustand mit Heimdall-Server,
  // schreibt aktualisierte Policy zurück in `policy` und NVS.
  // keepWifi=false: WiFi nach dem Call abschalten (Standard, akkuschonend).
  // keepWifi=true:  WiFi anlassen (z.B. wenn die Statusseite weiterläuft).
  // ota (optional): füllt version/url, wenn der Server eine neue FW anbietet.
  // debugMode (optional): true, wenn der Server den Debug-Mode für diese Box aktiviert.
  SyncResult run(const WifiCredentials& creds, BoxState& state, BoxPolicy& policy,
                 bool keepWifi = false, OtaInfo* ota = nullptr, bool* debugMode = nullptr);

  // Letzter WLAN-Connect-Fehler für die /wifi-Anzeige. true, wenn der letzte Versuch
  // scheiterte; füllt ssid (ggf. leer) + msg (z.B. "Passwort falsch?"). Erfolg löscht ihn.
  bool lastWifiError(String& ssid, String& msg);
}
