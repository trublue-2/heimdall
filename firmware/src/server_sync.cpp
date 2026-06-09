#include "server_sync.h"
#include "config.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>

// ISO-8601 "2026-06-08T12:00:00Z" → Unix-Epoch.
// Funktioniert nur nach configTime(0,0,...) — TZ muss UTC sein.
static time_t parseIso8601(const char* s) {
  if (!s || s[0] == '\0') return 0;
  struct tm t = {};
  if (sscanf(s, "%d-%d-%dT%d:%d:%dZ",
        &t.tm_year, &t.tm_mon, &t.tm_mday,
        &t.tm_hour, &t.tm_min, &t.tm_sec) != 6) return 0;
  t.tm_year -= 1900;
  t.tm_mon  -= 1;
  t.tm_isdst = 0;
  return mktime(&t); // mktime in UTC nach configTime(0,0,...)
}

static bool connectWifi(const char* ssid, const char* pass) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) return false;
    delay(200);
  }
  log_i("WiFi OK: %s", WiFi.localIP().toString().c_str());
  return true;
}

static void syncNtp() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  struct tm t;
  for (int i = 0; i < 20 && !getLocalTime(&t, 500); i++) delay(100);
}

SyncResult ServerSync::run(const WifiCredentials& creds,
                           BoxState& state, BoxPolicy& policy) {
  if (!connectWifi(creds.ssid, creds.password)) return SyncResult::NO_WIFI;
  syncNtp();

  WiFiClientSecure client;
  // TODO: Zertifikat-Pinning nach erster Validierung
  client.setInsecure();

  HTTPClient http;
  String url = String(creds.serverUrl) + SERVER_PATH_SYNC;
  auto cleanup = [&]() {
    http.end();
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
  };

  if (!http.begin(client, url)) { cleanup(); return SyncResult::SERVER_ERROR; }

  http.addHeader("Content-Type",  "application/json");
  http.addHeader("Authorization", String("Bearer ") + creds.deviceToken);

  // Request-Body aufbauen
  JsonDocument req;
  req["token"] = creds.deviceToken;
  JsonObject s = req["state"].to<JsonObject>();
  s["locked"]  = state.locked;
  // "since" nur senden wenn gesperrt und Timestamp bekannt (Server erwartet ISO-8601-String)
  if (state.locked && state.lockedSince > 0) {
    char sinceStr[32];
    struct tm tm_info;
    gmtime_r(&state.lockedSince, &tm_info);
    strftime(sinceStr, sizeof(sinceStr), "%Y-%m-%dT%H:%M:%SZ", &tm_info);
    s["since"] = sinceStr;
  }
  s["battery"]    = 0;         // TODO: Failsafe::batteryPercent()
  s["boltPos"]    = "UNKNOWN"; // TODO: Endlagensensor
  s["fwVersion"]  = FW_VERSION;
  s["wakeReason"] = state.wakeReason;

  String body;
  serializeJson(req, body);

  int code = http.POST(body);
  log_i("Sync POST %s → %d", url.c_str(), code);

  if (code == 401 || code == 403) { cleanup(); return SyncResult::AUTH_ERROR; }
  if (code != 200)                 { cleanup(); return SyncResult::SERVER_ERROR; }

  // Response verarbeiten
  JsonDocument resp;
  DeserializationError err = deserializeJson(resp, http.getString());
  cleanup();

  if (err) return SyncResult::SERVER_ERROR;

  const char* lockUntilStr = resp["lockUntil"] | "";
  policy.lockUntil    = parseIso8601(lockUntilStr);
  policy.offlineOpenH = resp["offlineOpenHours"] | OFFLINE_OPEN_H;
  policy.hardCapH     = resp["hardCapHours"] | 0;
  state.lastSyncAt    = time(nullptr);

  NVS::savePolicy(policy);
  NVS::saveState(state);

  log_i("Policy: lockUntil=%ld offlineH=%d hardCap=%d",
        (long)policy.lockUntil, policy.offlineOpenH, policy.hardCapH);
  return SyncResult::OK;
}
