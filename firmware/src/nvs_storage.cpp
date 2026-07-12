#include "nvs_storage.h"
#include "config.h"
#include <Preferences.h>

static Preferences prefs;

void NVS::begin() {
  // Preferences öffnet intern — nichts zu tun.
}

// Read-only-Zugriffe (loadState/Policy/Mqtt/ExtraNets/getPreferredSsid) öffnen ihren Namespace
// mit begin(ns, true). Fehlt er (fabrikfrische Box, oder "nets" ohne Extra-WLAN), loggt
// Preferences::begin ein hässliches — aber harmloses — "nvs_open failed: NOT_FOUND". "nets"
// wird bei JEDEM Sync gelesen (knownSsids) → Dauer-Spam. Hier je Namespace einmal read-write
// öffnen (legt ihn an) + neutralen Marker schreiben (persistiert den leeren Namespace). Die
// Loader prüfen ihre echten Keys ("locked"/"lockUntil"/"host"/"count"/…) — der Marker ändert nichts.
void NVS::ensureNamespaces() {
  static const char* NS[] = { "state", "policy", "mqtt", "nets", "wifi" };
  for (const char* ns : NS) {
    prefs.begin(ns, false); // READWRITE legt den Namespace an, falls er fehlt
    if (!prefs.isKey("_ns")) prefs.putUChar("_ns", 1);
    prefs.end();
  }
}

// ── Credentials ─────────────────────────────────────────────────────────────

bool NVS::loadCredentials(WifiCredentials& out) {
  prefs.begin("wifi", /*readOnly=*/true);
  bool ok = prefs.isKey("ssid");
  if (ok) {
    strlcpy(out.ssid,        prefs.getString("ssid",  "").c_str(), sizeof(out.ssid));
    strlcpy(out.password,    prefs.getString("pass",  "").c_str(), sizeof(out.password));
    strlcpy(out.serverUrl,   prefs.getString("url",   "").c_str(), sizeof(out.serverUrl));
    strlcpy(out.deviceToken, prefs.getString("token", "").c_str(), sizeof(out.deviceToken));
    ok = out.ssid[0] != '\0' && out.deviceToken[0] != '\0';
  }
  prefs.end();
  return ok;
}

void NVS::saveCredentials(const WifiCredentials& in) {
  prefs.begin("wifi", false);
  prefs.putString("ssid",  in.ssid);
  prefs.putString("pass",  in.password);
  prefs.putString("url",   in.serverUrl);
  prefs.putString("token", in.deviceToken);
  prefs.end();
}

void NVS::clearCredentials() {
  prefs.begin("wifi", false);
  prefs.clear();
  prefs.end();
}

// ── Box-Zustand ──────────────────────────────────────────────────────────────

bool NVS::loadState(BoxState& out) {
  prefs.begin("state", true);
  bool ok = prefs.isKey("locked");
  if (ok) {
    out.locked      = prefs.getBool("locked",   false);
    out.lockedSince = (time_t)prefs.getLong64("lsince", 0);
    out.lastSyncAt  = (time_t)prefs.getLong64("lsync",  0);
    out.batteryPct  = prefs.getInt("prevBatt", -1); // -1 = noch nie gemessen
    strlcpy(out.wakeReason, prefs.getString("reason", "unknown").c_str(), sizeof(out.wakeReason));
    out.offlineSeconds = prefs.getUInt("offsec",   0);
    out.lastTick       = (time_t)prefs.getLong64("ltick", 0);
    out.lowBattLatched = prefs.getBool("lowbatt", false);
  }
  prefs.end();
  return ok;
}

void NVS::saveState(const BoxState& in) {
  prefs.begin("state", false);
  prefs.putBool("locked",    in.locked);
  prefs.putLong64("lsince",  (int64_t)in.lockedSince);
  prefs.putLong64("lsync",   (int64_t)in.lastSyncAt);
  prefs.putString("reason",  in.wakeReason);
  prefs.putInt("prevBatt",   in.batteryPct);
  prefs.putUInt("offsec",    in.offlineSeconds);
  prefs.putLong64("ltick",   (int64_t)in.lastTick);
  prefs.putBool("lowbatt",   in.lowBattLatched);
  prefs.end();
}

// ── Policy ───────────────────────────────────────────────────────────────────

bool NVS::loadPolicy(BoxPolicy& out) {
  prefs.begin("policy", true);
  bool ok = prefs.isKey("lockUntil");
  out.lockUntil    = (time_t)prefs.getLong64("lockUntil", 0);
  out.offlineOpenH = prefs.getInt("offlineH", OFFLINE_OPEN_H);
  out.syncIntervalS = prefs.getInt("syncInt", HEARTBEAT_S); // Default = Standard-Heartbeat
  // Fallback für Altbestand ohne Key: "zu" aus lockUntil ableiten (kein Fehl-Öffnen).
  out.serverLocked = prefs.getBool("srvLocked", out.lockUntil > 0);
  prefs.end();
  return ok;
}

void NVS::savePolicy(const BoxPolicy& in) {
  prefs.begin("policy", false);
  prefs.putLong64("lockUntil", (int64_t)in.lockUntil);
  prefs.putInt("offlineH", in.offlineOpenH);
  prefs.putInt("syncInt", in.syncIntervalS);
  prefs.putBool("srvLocked", in.serverLocked);
  prefs.end();
}

// ── MQTT-Konfig ────────────────────────────────────────────────────────────
bool NVS::loadMqtt(MqttConfig& out) {
  prefs.begin("mqtt", true);
  bool ok = prefs.isKey("host");
  out.enabled = prefs.getBool("en", false);
  strlcpy(out.host,     prefs.getString("host", "").c_str(), sizeof(out.host));
  strlcpy(out.deviceId, prefs.getString("did",  "").c_str(), sizeof(out.deviceId));
  prefs.end();
  return ok;
}

void NVS::saveMqtt(const MqttConfig& in) {
  prefs.begin("mqtt", false);
  prefs.putBool("en", in.enabled);
  prefs.putString("host", in.host);
  prefs.putString("did",  in.deviceId);
  prefs.end();
}

// ── Zusatz-WLANs ─────────────────────────────────────────────────────────────
int NVS::loadExtraNets(WifiNet* out, int maxN) {
  prefs.begin("nets", true);
  int count = prefs.getInt("count", 0);
  if (count > maxN) count = maxN;
  if (count > MAX_EXTRA_NETS) count = MAX_EXTRA_NETS;
  char key[8];
  for (int i = 0; i < count; i++) {
    snprintf(key, sizeof(key), "s%d", i);
    strlcpy(out[i].ssid, prefs.getString(key, "").c_str(), sizeof(out[i].ssid));
    snprintf(key, sizeof(key), "p%d", i);
    strlcpy(out[i].pass, prefs.getString(key, "").c_str(), sizeof(out[i].pass));
  }
  prefs.end();
  return count;
}

// Schreibt die komplette Extra-Netz-Liste in den "nets"-Namespace (count + s%d/p%d).
static void writeNets(const WifiNet* nets, int count) {
  prefs.begin("nets", false);
  prefs.putInt("count", count);
  char key[8];
  for (int i = 0; i < count; i++) {
    snprintf(key, sizeof(key), "s%d", i); prefs.putString(key, nets[i].ssid);
    snprintf(key, sizeof(key), "p%d", i); prefs.putString(key, nets[i].pass);
  }
  prefs.end();
}

void NVS::saveExtraNet(const char* ssid, const char* pass) {
  if (!ssid || ssid[0] == '\0') return;
  WifiNet nets[MAX_EXTRA_NETS];
  int count = loadExtraNets(nets, MAX_EXTRA_NETS);

  int idx = -1;
  for (int i = 0; i < count; i++)
    if (strcmp(nets[i].ssid, ssid) == 0) { idx = i; break; }

  if (idx < 0) {                          // neues Netz
    if (count >= MAX_EXTRA_NETS) {         // voll → ältestes verdrängen
      for (int i = 1; i < count; i++) nets[i - 1] = nets[i];
      count = MAX_EXTRA_NETS - 1;
    }
    idx = count++;
    strlcpy(nets[idx].ssid, ssid, sizeof(nets[idx].ssid));
  }
  strlcpy(nets[idx].pass, pass ? pass : "", sizeof(nets[idx].pass));
  writeNets(nets, count);
}

void NVS::deleteExtraNet(const char* ssid) {
  if (!ssid || ssid[0] == '\0') return;
  WifiNet nets[MAX_EXTRA_NETS];
  int count = loadExtraNets(nets, MAX_EXTRA_NETS);
  int idx = -1;
  for (int i = 0; i < count; i++)
    if (strcmp(nets[i].ssid, ssid) == 0) { idx = i; break; }
  if (idx < 0) return;                       // nicht vorhanden
  for (int i = idx + 1; i < count; i++) nets[i - 1] = nets[i]; // Lücke schließen
  count--;
  writeNets(nets, count);

  // War dieses Netz das bevorzugte, die Präferenz mit entfernen — die Integrität der
  // "nets"-Daten (pref darf nur auf ein existierendes Netz zeigen) gehört in diese Schicht.
  char pref[64] = {0};
  if (getPreferredSsid(pref, sizeof(pref)) && strcmp(pref, ssid) == 0) setPreferredSsid("");
}

// Bevorzugtes Netz (im selben "nets"-Namespace, Schlüssel "pref"). Leer = keine Präferenz.
void NVS::setPreferredSsid(const char* ssid) {
  prefs.begin("nets", false);
  if (ssid && ssid[0]) prefs.putString("pref", ssid);
  else                 prefs.remove("pref");
  prefs.end();
}

bool NVS::getPreferredSsid(char* out, size_t cap) {
  prefs.begin("nets", true);
  String s = prefs.getString("pref", "");
  prefs.end();
  strlcpy(out, s.c_str(), cap);
  return out[0] != '\0';
}
