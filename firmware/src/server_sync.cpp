#include "server_sync.h"
#include "config.h"
#include "certs.h"
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
  // Plausibilität: Müll-Response (z.B. "2026-99-99T..") darf keine valide-
  // aussehende Epoch ergeben, die in lockUntil landet. 0 = "kein/ungültiges Datum".
  if (t.tm_year < 2020 || t.tm_year > 2099 ||
      t.tm_mon  < 1 || t.tm_mon  > 12 ||
      t.tm_mday < 1 || t.tm_mday > 31 ||
      t.tm_hour < 0 || t.tm_hour > 23 ||
      t.tm_min  < 0 || t.tm_min  > 59 ||
      t.tm_sec  < 0 || t.tm_sec  > 60) return 0;
  t.tm_year -= 1900;
  t.tm_mon  -= 1;
  return tmToUtc(t);
}

// Letzte erfolgreiche WiFi-Parameter — überlebt Deep-Sleep (RTC-RAM).
// Gezielter Reconnect (Kanal+BSSID) spart den Scan und damit ~0.5–1.5 s pro Wake.
RTC_DATA_ATTR static uint8_t  rtcBssid[6] = {0};
RTC_DATA_ATTR static int32_t  rtcChannel  = 0;
RTC_DATA_ATTR static bool     rtcWifiHint = false;
RTC_DATA_ATTR static char     rtcSsid[64] = {0};
RTC_DATA_ATTR static char     rtcPass[64] = {0};

// Letzter WLAN-Connect-Fehler (für /wifi). Der Disconnect-Grund kommt per WiFi-Event —
// nur so lässt sich „Passwort falsch" von „ausser Reichweite" unterscheiden.
static volatile uint8_t gDiscReason  = 0;
static char             gWifiErrSsid[64] = {0};
static char             gWifiErrMsg[48]  = {0};

static void onWifiEvent(WiFiEvent_t ev, WiFiEventInfo_t info) {
  if (ev == ARDUINO_EVENT_WIFI_STA_DISCONNECTED)
    gDiscReason = info.wifi_sta_disconnected.reason;
}
static const char* wifiReasonMsg(uint8_t r) {
  switch (r) {
    case WIFI_REASON_NO_AP_FOUND:           return "nicht gefunden / ausser Reichweite";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "Passwort falsch?";
    default:                                return "Verbindung fehlgeschlagen";
  }
}
static void setWifiErr(const char* ssid, const char* msg) {
  strlcpy(gWifiErrSsid, ssid ? ssid : "", sizeof(gWifiErrSsid));
  strlcpy(gWifiErrMsg,  msg,               sizeof(gWifiErrMsg));
}
bool ServerSync::lastWifiError(String& ssid, String& msg) {
  if (!gWifiErrMsg[0]) return false;         // kein Fehler offen
  ssid = gWifiErrSsid; msg = gWifiErrMsg;
  return true;
}

static bool waitConnected(unsigned long timeoutMs) {
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > timeoutMs) return false;
    delay(50);
  }
  return true;
}

static bool tryConnect(const char* ssid, const char* pass, unsigned long timeout,
                       int32_t channel = 0, const uint8_t* bssid = nullptr) {
  if (channel && bssid) WiFi.begin(ssid, pass, channel, bssid);
  else                  WiFi.begin(ssid, pass);
  WiFi.setTxPower(WIFI_TX_POWER); // erst NACH begin() — STA muss gestartet sein
  return waitConnected(timeout);
}

// Verbindet mit dem stärksten *bekannten* Netz (Primär + Zusatz-WLANs aus NVS).
// Schnellpfad: zuletzt erfolgreiches Netz direkt (kein Scan).
static bool connectWifi(const WifiCredentials& creds) {
  WiFi.persistent(false); // keine Flash-Writes pro Connect
  WiFi.mode(WIFI_STA);
  static bool evtReg = false; // Disconnect-Grund einmalig abgreifen (für /wifi-Fehleranzeige)
  if (!evtReg) { WiFi.onEvent(onWifiEvent, ARDUINO_EVENT_WIFI_STA_DISCONNECTED); evtReg = true; }

  WifiNet known[1 + MAX_EXTRA_NETS];
  strlcpy(known[0].ssid, creds.ssid,     sizeof(known[0].ssid));
  strlcpy(known[0].pass, creds.password, sizeof(known[0].pass));
  int n = 1 + NVS::loadExtraNets(&known[1], MAX_EXTRA_NETS);

  // Bevorzugtes Netz (vom Nutzer auf /wifi gesetzt): gewinnt, wenn sichtbar — sonst
  // Fallback aufs stärkste bekannte. Leer = keine Präferenz.
  char pref[64] = {0};
  NVS::getPreferredSsid(pref, sizeof(pref));

  // Schnellpfad: letztes erfolgreiches Netz direkt (kein Scan). Übersprungen, wenn ein
  // ANDERES Netz bevorzugt ist — sonst würde die Präferenz nie greifen (der Hint zeigt aufs
  // zuletzt Verbundene). Ist das Bevorzugte == Hint, gilt der Schnellpfad normal.
  if (rtcWifiHint && rtcSsid[0] && (!pref[0] || strcmp(pref, rtcSsid) == 0)) {
    if (tryConnect(rtcSsid, rtcPass, WIFI_CONNECT_TIMEOUT_MS / 2, rtcChannel, rtcBssid)) {
      gWifiErrMsg[0] = '\0'; // Erfolg → letzten Fehler löschen
      log_i("WiFi OK (fast): %s @ %s", rtcSsid, WiFi.localIP().toString().c_str());
      return true;
    }
    rtcWifiHint = false;
    WiFi.disconnect();
  }

  // Scan → bevorzugtes Netz zuerst, sonst stärkstes bekanntes.
  int found = WiFi.scanNetworks();
  int bestNet = -1, bestRssi = -999, bestChannel = 0;
  uint8_t bestBssid[6] = {0};
  bool bestPref = false;
  for (int s = 0; s < found; s++) {
    for (int k = 0; k < n; k++) {
      if (WiFi.SSID(s) != known[k].ssid) continue;
      bool isPref = pref[0] && strcmp(known[k].ssid, pref) == 0;
      // Bevorzugtes gewinnt immer; sonst das mit stärkstem RSSI.
      if ((isPref && !bestPref) || (isPref == bestPref && WiFi.RSSI(s) > bestRssi)) {
        bestRssi = WiFi.RSSI(s); bestNet = k; bestChannel = WiFi.channel(s);
        memcpy(bestBssid, WiFi.BSSID(s), 6); bestPref = isPref;
      }
    }
  }
  WiFi.scanDelete();

  if (bestNet < 0) {
    log_w("Kein bekanntes WLAN sichtbar (%d APs)", found);
    setWifiErr("", "kein bekanntes WLAN in Reichweite");
    return false;
  }

  log_i("Verbinde '%s'%s (%d dBm)", known[bestNet].ssid, bestPref ? " [bevorzugt]" : "", bestRssi);
  gDiscReason = 0; // frischen Grund fürs kommende Disconnect-Event
  if (!tryConnect(known[bestNet].ssid, known[bestNet].pass, WIFI_CONNECT_TIMEOUT_MS,
                  bestChannel, bestBssid)) {
    setWifiErr(known[bestNet].ssid, wifiReasonMsg(gDiscReason));
    log_w("WiFi-Fehler '%s': %s (reason %u)", known[bestNet].ssid, gWifiErrMsg, gDiscReason);
    return false;
  }

  memcpy(rtcBssid, WiFi.BSSID(), 6);
  rtcChannel = WiFi.channel();
  strlcpy(rtcSsid, known[bestNet].ssid, sizeof(rtcSsid));
  strlcpy(rtcPass, known[bestNet].pass, sizeof(rtcPass));
  rtcWifiHint = true;
  gWifiErrMsg[0] = '\0'; // Erfolg → letzten Fehler löschen
  log_i("WiFi OK: %s @ %s", known[bestNet].ssid, WiFi.localIP().toString().c_str());
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
                           OtaInfo* ota, bool* debugMode) {
  if (WiFi.status() != WL_CONNECTED &&
      !connectWifi(creds)) return SyncResult::NO_WIFI;
  syncNtp();

  WiFiClientSecure client;
  // Cert-Pinning: nur Let's-Encrypt-Roots vertrauen (siehe certs.h). Verhindert,
  // dass ein Rogue-AP eine gefälschte Policy (Schloss auf) unterschiebt.
  client.setCACert(ROOT_CA_BUNDLE);

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
  if (state.batteryPct >= 0) s["battery"] = state.batteryPct; // <0 = unbekannt → weglassen (Server zeigt „—")
  s["charging"]   = state.charging;
  s["boltPos"]    = "UNKNOWN"; // TODO: Endlagensensor
  s["fwVersion"]  = FW_VERSION;
  s["wakeReason"] = state.wakeReason;
  s["wifiSsid"]   = WiFi.SSID().c_str();
  s["wifiRssi"]   = WiFi.RSSI();
  s["ip"]         = WiFi.localIP().toString();
  s["mac"]        = WiFi.macAddress(); // Hardware-ID → Server-Anzeige (Board-Zuordnung)

  // Bekannte WLANs melden → Server nullt gelieferte Passwörter.
  JsonArray ks = req["knownSsids"].to<JsonArray>();
  ks.add(creds.ssid);
  WifiNet extras[MAX_EXTRA_NETS];
  int ne = NVS::loadExtraNets(extras, MAX_EXTRA_NETS);
  for (int i = 0; i < ne; i++) ks.add(extras[i].ssid);

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
  // Autoritatives "soll zu". Fallback (Altserver ohne Feld): aus lockUntil ableiten.
  policy.serverLocked = resp["locked"] | (policy.lockUntil > 0);
  policy.offlineOpenH = resp["offlineOpenHours"] | OFFLINE_OPEN_H;
  policy.hardCapH     = resp["hardCapHours"] | 0;
  strlcpy(state.deviceName, resp["name"] | "", sizeof(state.deviceName));
  state.lastSyncAt    = time(nullptr);
  state.offlineSeconds = 0; // erfolgreicher Sync → Offline-Zähler zurücksetzen

  // OTA-Hinweis (Server-Pull): leer = kein Update.
  if (ota) {
    strlcpy(ota->version, resp["otaVersion"] | "", sizeof(ota->version));
    strlcpy(ota->url,     resp["otaUrl"]     | "", sizeof(ota->url));
    strlcpy(ota->sig,     resp["otaSig"]     | "", sizeof(ota->sig));
  }

  // Debug-Mode-Direktive vom Server (für lokales Pin-Testen ohne Reflash).
  if (debugMode) *debugMode = resp["debugMode"] | false;

  // Zusatz-WLANs vom Server übernehmen (Passwort wird serverseitig danach genullt).
  JsonArray nets = resp["wifiNetworks"].as<JsonArray>();
  for (JsonObject net : nets) {
    const char* nssid = net["ssid"] | "";
    const char* npass = net["pass"] | "";
    if (nssid[0]) { NVS::saveExtraNet(nssid, npass); log_i("Neues WLAN: %s", nssid); }
  }

  // Bevorzugtes Netz (Server gewinnt): nur setzen, wenn der Server eins liefert.
  // Leer/fehlt → die lokale /wifi-Wahl der Box bleibt unberührt.
  const char* prefSsid = resp["preferredSsid"] | "";
  if (prefSsid[0]) { NVS::setPreferredSsid(prefSsid); log_i("Bevorzugtes WLAN (Server): %s", prefSsid); }

  NVS::savePolicy(policy);
  NVS::saveState(state);

  char lu[20] = "—";
  if (policy.lockUntil > 0) { struct tm t; time_t v = policy.lockUntil; localtime_r(&v, &t);
    strftime(lu, sizeof(lu), "%d.%m.%Y %H:%M", &t); }
  log_i("Policy: locked=%d lockUntil=%ld (%s) offlineH=%d hardCap=%d",
        policy.serverLocked, (long)policy.lockUntil, lu, policy.offlineOpenH, policy.hardCapH);
  return SyncResult::OK;
}
