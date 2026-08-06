#include "server_sync.h"
#include "config.h"
#include "certs.h"
#include "logbuf.h"
#include "wake_journal.h"
#include "flash_log.h"
#include "watchdog.h"
#include "log.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <sys/time.h> // settimeofday — Server-Zeit je Sync übernehmen (RTC-Drift korrigieren)

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

// Server-Log: vom Server je Sync gemeldet (resp["logToServer"]). Ist er an, hängt der
// NÄCHSTE Sync die neuen Log-Bytes an (ein Sync Verzögerung beim Umschalten — gewollt).
static bool             gLogToServer = false;

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

bool ServerSync::logToServerActive() { return gLogToServer; }

static bool waitConnected(unsigned long timeoutMs) {
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    Watchdog::feed(); // WiFi-Connect kann bis WIFI_CONNECT_TIMEOUT_MS dauern → WDT nicht ausloesen
    if (millis() - start > timeoutMs) return false;
    // "Verbinde"-Anzeige: LED schnell blinken während des WiFi-Connects (die dunkle Phase
    // zwischen Button-Ack und "verbunden = dauer an"). ~4 Hz.
    digitalWrite(PIN_LED, ((millis() / 120) % 2) ? LED_ON : LED_OFF);
    delay(50);
  }
  // WiFi verbunden → LED sofort dauerhaft AN. Sonst bliebe sie im letzten (zufälligen) Blink-
  // Pegel hängen, während Sync-POST + MQTT laufen (~2-5 s), bis der erste LOCKED/IDLE_OPEN-Loop
  // sie setzt → genau die beobachtete „blinken → schwarz → an"-Lücke.
  digitalWrite(PIN_LED, LED_ON);
  return true;
}

// Nach einem gescheiterten Connect läuft der Auto-Reconnect des WiFi-Stacks weiter, und
// solange der läuft, liefert WiFi.scanNetworks() nur noch WIFI_SCAN_FAILED (-2). Ohne
// diesen Reset macht ein einziger Fehlversuch die Box für die ganze Boot-Session blind:
// jeder Folge-Scan scheitert, sie meldet "kein bekanntes WLAN" und nur ein Reboot hilft.
static void radioReset() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  delay(100);
  WiFi.mode(WIFI_STA);
}

static bool tryConnect(const char* ssid, const char* pass, unsigned long timeout,
                       int32_t channel = 0, const uint8_t* bssid = nullptr) {
  if (channel && bssid) WiFi.begin(ssid, pass, channel, bssid);
  else                  WiFi.begin(ssid, pass);
  WiFi.setTxPower(WIFI_TX_POWER); // erst NACH begin() — STA muss gestartet sein
  return waitConnected(timeout);
}

// Verbindet mit einem *bekannten* Netz (Primär + Zusatz-WLANs aus NVS): aus dem Scan werden
// alle bekannten Netze zu Kandidaten, sortiert nach Präferenz und dann RSSI, und der Reihe
// nach probiert (max. WIFI_MAX_CONNECT_TRIES).
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
    LOGI("WiFi: connecting (fast path) to '%s' (ch %d)", rtcSsid, rtcChannel);
    if (tryConnect(rtcSsid, rtcPass, WIFI_CONNECT_TIMEOUT_MS / 2, rtcChannel, rtcBssid)) {
      gWifiErrMsg[0] = '\0'; // Erfolg → letzten Fehler löschen
      LOGI("WiFi: connected (fast path) to '%s' @ %s (%d dBm)", rtcSsid, WiFi.localIP().toString().c_str(), WiFi.RSSI());
      return true;
    }
    LOGW("WiFi: fast path to '%s' failed → full scan", rtcSsid);
    rtcWifiHint = false; // Kanal/BSSID-Hint verwerfen — ein Hotspot wandert
    radioReset();
  }

  int found = WiFi.scanNetworks();
  if (found < 0) { // WIFI_SCAN_FAILED/-RUNNING: Funkteil hängt → einmal zurücksetzen, neu scannen
    LOGW("WiFi: scan failed (%d) → radio reset, retry", found);
    radioReset();
    found = WiFi.scanNetworks();
  }
  // Je bekanntem Netz den stärksten Treffer merken — NICHT nur den einen besten. Ein
  // sichtbares Netz heisst nicht verbindbar (Handy-Hotspot schläft ohne Client): mit nur
  // einem Kandidaten war der Sync nach dem ersten Fehlschlag tot, obwohl das Heim-WLAN
  // im selben Scan-Ergebnis stand.
  struct Cand { int net; int32_t rssi; int32_t ch; uint8_t bssid[6]; bool pref; };
  Cand cands[1 + MAX_EXTRA_NETS];
  int nc = 0;
  for (int s = 0; s < found; s++) {
    for (int k = 0; k < n; k++) {
      if (WiFi.SSID(s) != known[k].ssid) continue;
      int c = 0;
      while (c < nc && cands[c].net != k) c++;
      if (c == nc) cands[nc++] = Cand{k, -999, 0, {0}, pref[0] && strcmp(known[k].ssid, pref) == 0};
      if (WiFi.RSSI(s) > cands[c].rssi) {
        cands[c].rssi = WiFi.RSSI(s);
        cands[c].ch   = WiFi.channel(s);
        memcpy(cands[c].bssid, WiFi.BSSID(s), 6);
      }
    }
  }
  WiFi.scanDelete();

  if (nc == 0) {
    // Scan-FEHLER ist nicht "nichts da": ehrlich benennen, sonst sucht man den Fehler beim WLAN.
    if (found < 0) {
      LOGW("WiFi: scan failed twice (%d) — kein Verbindungsversuch", found);
      setWifiErr("", "WLAN-Scan fehlgeschlagen");
    } else {
      LOGW("WiFi: no known network in range (%d APs scanned)", found);
      setWifiErr("", "kein bekanntes WLAN in Reichweite");
    }
    return false;
  }

  // Reihenfolge: Bevorzugtes zuerst, danach nach RSSI. Die Präferenz bestimmt damit nur noch,
  // wer zuerst drankommt — sie kann die anderen Netze nicht mehr aussperren.
  for (int i = 1; i < nc; i++)
    for (int j = i; j > 0 && (cands[j].pref > cands[j-1].pref ||
                              (cands[j].pref == cands[j-1].pref && cands[j].rssi > cands[j-1].rssi)); j--) {
      Cand t = cands[j]; cands[j] = cands[j-1]; cands[j-1] = t;
    }

  // Der Reihe nach durchprobieren. Gedeckelt, weil jeder Fehlversuch bis
  // WIFI_CONNECT_TIMEOUT_MS wach kostet — Akku vor Vollständigkeit.
  int tries = nc < WIFI_MAX_CONNECT_TRIES ? nc : WIFI_MAX_CONNECT_TRIES;
  for (int c = 0; c < tries; c++) {
    const WifiNet& net = known[cands[c].net];
    LOGI("WiFi: connecting to '%s'%s (%d dBm, Versuch %d/%d)",
         net.ssid, cands[c].pref ? " [preferred]" : "", cands[c].rssi, c + 1, tries);
    gDiscReason = 0; // frischen Grund fürs kommende Disconnect-Event
    if (tryConnect(net.ssid, net.pass, WIFI_CONNECT_TIMEOUT_MS, cands[c].ch, cands[c].bssid)) {
      memcpy(rtcBssid, WiFi.BSSID(), 6);
      rtcChannel = WiFi.channel();
      strlcpy(rtcSsid, net.ssid, sizeof(rtcSsid));
      strlcpy(rtcPass, net.pass, sizeof(rtcPass));
      rtcWifiHint = true;
      gWifiErrMsg[0] = '\0'; // Erfolg → letzten Fehler löschen
      LOGI("WiFi: connected to '%s' @ %s (%d dBm)", net.ssid, WiFi.localIP().toString().c_str(), cands[c].rssi);
      return true;
    }
    setWifiErr(net.ssid, wifiReasonMsg(gDiscReason));
    LOGW("WiFi: connect to '%s' failed: %s (reason %u)", net.ssid, gWifiErrMsg, gDiscReason);
    radioReset(); // Auto-Reconnect stoppen — sonst scheitert jeder weitere Scan dieser Session
  }
  return false; // Fehler steht schon vom letzten Versuch
}

static void syncNtp() {
  // TZ wird bereits in setup() gesetzt (TZ_EUROPE_ZURICH) → hier nicht mehr nötig.
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
  if (WiFi.status() != WL_CONNECTED) {
    if (!connectWifi(creds)) return SyncResult::NO_WIFI;
  } else {
    // Schon verbunden (Wachfenster-Re-Sync): connectWifi() wird übersprungen — trotzdem
    // das aktuell genutzte WLAN pro Sync ins Log, damit es dort immer sichtbar ist.
    LOGI("WiFi: still connected to '%s' @ %s (%d dBm)",
         WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
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
  s["full"]       = state.chargeFull; // Ladeschluss (TP4056 STDBY / grüne LED) — Dashboard-Anzeige
  // Akku-Kalibrierfaktor dieser Box; 0 = unkalibriert. Bewusst IMMER senden, auch die 0 —
  // liesse man das Feld weg, könnte der Server ein Zurücksetzen der Kalibrierung nie von
  // "Alt-Firmware meldet nichts" unterscheiden und zeigte für immer den alten Faktor an.
  s["battCalib"] = state.battCalib;
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

  // Serielles Log mitschicken, wenn der Server es für diese Box aktiviert hat (logToServer).
  if (gLogToServer) {
    String logs = collectSyncLogs(4096);
    if (logs.length()) req["logs"] = logs;
  }

  // Aufwach-Journal immer mitschicken (ungated) — der Server legt je Wake ein Event an; geleert
  // wird es erst nach bestätigtem Sync (main.cpp, SyncResult::OK).
  wakeJournalToJson(req);

  // Persistenten Fehl-Sync-Backlog (LittleFS) mitschicken — auch ungated. Wird erst nach
  // bestätigtem Sync gelöscht (main.cpp, SyncResult::OK).
  FlashLog::toJson(req);

  String body;
  serializeJson(req, body);

  int code = http.POST(body);
  LOGI("Sync: HTTP %d from %s", code, url.c_str());

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
  // Konfigurierbares Sync-Intervall (Server liefert Minuten). Hart auf [1 min, 180 min] geklemmt —
  // die Untergrenze schützt den Akku, die Obergrenze die Offline-Failsafe-Invariante (MAX_SLEEP_S).
  int siMin = resp["syncIntervalMin"] | (int)(HEARTBEAT_S / 60);
  policy.syncIntervalS = constrain(siMin * 60, (int)SYNC_INTERVAL_MIN_S, (int)SYNC_INTERVAL_MAX_S);
  strlcpy(state.deviceName, resp["name"] | "", sizeof(state.deviceName));

  // Server-Zeit übernehmen: die Deep-Sleep-RTC driftet (Minuten pro Tage), NTP läuft nur
  // bei ungültiger Uhr. timeUTC steht in JEDER Response → hier je Sync korrigiert, ohne
  // extra NTP-Roundtrip. lastTick MIT verschieben, sonst sähe der monotone Failsafe-
  // Zähler (offlineSeconds) durch die Korrektur einen Scheinsprung.
  time_t srvNow = parseIso8601(resp["timeUTC"] | "");
  if (srvNow > 1700000000) {
    struct timeval tv;
    tv.tv_sec  = srvNow;
    tv.tv_usec = 0;
    settimeofday(&tv, nullptr);
    state.lastTick = srvNow;
  }
  state.lastSyncAt    = time(nullptr);
  state.offlineSeconds = 0; // erfolgreicher Sync → Offline-Zähler zurücksetzen

  // OTA-Hinweis (Server-Pull): leer = kein Update.
  if (ota) {
    strlcpy(ota->version, resp["otaVersion"] | "", sizeof(ota->version));
    strlcpy(ota->url,     resp["otaUrl"]     | "", sizeof(ota->url));
    strlcpy(ota->sig,     resp["otaSig"]     | "", sizeof(ota->sig));
  }


  // Zusatz-WLANs vom Server übernehmen (Passwort wird serverseitig danach genullt).
  JsonArray nets = resp["wifiNetworks"].as<JsonArray>();
  for (JsonObject net : nets) {
    const char* nssid = net["ssid"] | "";
    const char* npass = net["pass"] | "";
    if (nssid[0]) { NVS::saveExtraNet(nssid, npass); LOGI("WiFi: stored extra network from server: '%s'", nssid); }
  }

  // Bevorzugtes Netz (Server gewinnt): nur setzen, wenn der Server eins liefert.
  // Leer/fehlt → die lokale /wifi-Wahl der Box bleibt unberührt.
  const char* prefSsid = resp["preferredSsid"] | "";
  if (prefSsid[0]) { NVS::setPreferredSsid(prefSsid); LOGI("WiFi: preferred network set by server: '%s'", prefSsid); }

  // Server-Log-Schalter für den nächsten Sync merken.
  gLogToServer = resp["logToServer"] | false;

  // MQTT-Konfig (Session-Fenster-Push): nur wenn der Server den Block liefert.
  // Fehlt er → enabled=false → Box bleibt heartbeat-only (abwärtskompatibel).
  MqttConfig mq = {};
  JsonObject mqtt = resp["mqtt"].as<JsonObject>();
  if (!mqtt.isNull()) {
    mq.enabled = mqtt["enabled"] | false;
    strlcpy(mq.host,     mqtt["host"]     | "", sizeof(mq.host));
    strlcpy(mq.deviceId, mqtt["deviceId"] | "", sizeof(mq.deviceId));
  }
  NVS::saveMqtt(mq);

  NVS::savePolicy(policy);
  NVS::saveState(state);

  char lu[20] = "—";
  if (policy.lockUntil > 0) { struct tm t; time_t v = policy.lockUntil; localtime_r(&v, &t);
    strftime(lu, sizeof(lu), "%d.%m.%Y %H:%M", &t); }
  LOGI("Policy from server: serverLocked=%d lockUntil=%s offlineOpenH=%d syncInterval=%dmin",
        policy.serverLocked, lu, policy.offlineOpenH, policy.syncIntervalS / 60);
  return SyncResult::OK;
}
