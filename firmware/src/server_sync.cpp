#include "server_sync.h"
#include "config.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>

// struct tm (UTC) → Unix-Epoch, TZ-unabhängig (Hinnant days-from-civil).
// ESP32-newlib hat kein timegm(); mktime würde die gesetzte TZ anwenden.
static time_t tmToUtc(const struct tm& t) {
  int  y = t.tm_year + 1900;
  int  m = t.tm_mon + 1;
  y -= (m <= 2);
  int era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + t.tm_mday - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = (long)(era * 146097 + (int)doe - 719468);
  return (time_t)days * 86400 + t.tm_hour * 3600 + t.tm_min * 60 + t.tm_sec;
}

// ISO-8601 "2026-06-08T12:00:00Z" → Unix-Epoch (UTC).
static time_t parseIso8601(const char* s) {
  if (!s || s[0] == '\0') return 0;
  struct tm t = {};
  if (sscanf(s, "%d-%d-%dT%d:%d:%dZ",
        &t.tm_year, &t.tm_mon, &t.tm_mday,
        &t.tm_hour, &t.tm_min, &t.tm_sec) != 6) return 0;
  t.tm_year -= 1900;
  t.tm_mon  -= 1;
  return tmToUtc(t);
}

// Letzte erfolgreiche WiFi-Parameter — überlebt Deep-Sleep (RTC-RAM).
// Gezielter Reconnect (Kanal+BSSID) spart den Scan und damit ~0.5–1.5 s pro Wake.
RTC_DATA_ATTR static uint8_t  rtcBssid[6] = {0};
RTC_DATA_ATTR static int32_t  rtcChannel  = 0;
RTC_DATA_ATTR static bool     rtcWifiHint = false;

static bool waitConnected(unsigned long timeoutMs) {
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > timeoutMs) return false;
    delay(50);
  }
  return true;
}

static bool connectWifi(const char* ssid, const char* pass) {
  WiFi.persistent(false); // keine Flash-Writes pro Connect
  WiFi.mode(WIFI_STA);

  // Schnellpfad: direkt auf bekannten Kanal/AP verbinden (kein Scan).
  if (rtcWifiHint) {
    WiFi.begin(ssid, pass, rtcChannel, rtcBssid);
    WiFi.setTxPower(WIFI_TX_POWER); // erst NACH begin() — STA muss gestartet sein
    if (waitConnected(WIFI_CONNECT_TIMEOUT_MS / 2)) {
      log_i("WiFi OK (fast): %s", WiFi.localIP().toString().c_str());
      return true;
    }
    // AP umgezogen/Kanal gewechselt → Hint verwerfen, normal scannen.
    rtcWifiHint = false;
    WiFi.disconnect();
  }

  WiFi.begin(ssid, pass);
  WiFi.setTxPower(WIFI_TX_POWER); // erst NACH begin() — STA muss gestartet sein
  if (!waitConnected(WIFI_CONNECT_TIMEOUT_MS)) return false;

  // Parameter für den nächsten Wake merken.
  memcpy(rtcBssid, WiFi.BSSID(), 6);
  rtcChannel  = WiFi.channel();
  rtcWifiHint = true;
  log_i("WiFi OK: %s", WiFi.localIP().toString().c_str());
  return true;
}

static void syncNtp() {
  // TZ immer setzen (für lokale Anzeige der Statusseite).
  setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1);
  tzset();
  // RTC läuft im Deep-Sleep weiter: ist die Uhr schon plausibel gesetzt,
  // sparen wir den NTP-Roundtrip komplett (mehrere Sekunden auf dem Wake-Pfad).
  if (time(nullptr) > 1700000000) return; // ~2023-11 → Uhr gültig
  configTime(0, 0, "pool.ntp.org", "time.nist.gov"); // Epoch bleibt UTC
  struct tm t;
  for (int i = 0; i < 20 && !getLocalTime(&t, 500); i++) delay(100);
}

SyncResult ServerSync::run(const WifiCredentials& creds,
                           BoxState& state, BoxPolicy& policy, bool keepWifi,
                           OtaInfo* ota) {
  if (WiFi.status() != WL_CONNECTED &&
      !connectWifi(creds.ssid, creds.password)) return SyncResult::NO_WIFI;
  syncNtp();

  WiFiClientSecure client;
  // TODO: Zertifikat-Pinning nach erster Validierung
  client.setInsecure();

  HTTPClient http;
  String url = String(creds.serverUrl) + SERVER_PATH_SYNC;
  auto cleanup = [&]() {
    http.end();
    if (!keepWifi) {
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
    }
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
  s["battery"]    = state.batteryPct;
  s["charging"]   = state.charging;
  s["boltPos"]    = "UNKNOWN"; // TODO: Endlagensensor
  s["fwVersion"]  = FW_VERSION;
  s["wakeReason"] = state.wakeReason;
  s["wifiSsid"]   = WiFi.SSID().c_str();
  s["wifiRssi"]   = WiFi.RSSI();
  s["ip"]         = WiFi.localIP().toString();

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

  // OTA-Hinweis (Server-Pull): leer = kein Update.
  if (ota) {
    strlcpy(ota->version, resp["otaVersion"] | "", sizeof(ota->version));
    strlcpy(ota->url,     resp["otaUrl"]     | "", sizeof(ota->url));
  }

  NVS::savePolicy(policy);
  NVS::saveState(state);

  log_i("Policy: lockUntil=%ld offlineH=%d hardCap=%d",
        (long)policy.lockUntil, policy.offlineOpenH, policy.hardCapH);
  return SyncResult::OK;
}
