#include "nvs_storage.h"
#include "config.h"
#include <Preferences.h>

static Preferences prefs;

void NVS::begin() {
  // Preferences öffnet intern — nichts zu tun.
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
  prefs.end();
}

// ── Policy ───────────────────────────────────────────────────────────────────

bool NVS::loadPolicy(BoxPolicy& out) {
  prefs.begin("policy", true);
  bool ok = prefs.isKey("lockUntil");
  out.lockUntil    = (time_t)prefs.getLong64("lockUntil", 0);
  out.offlineOpenH = prefs.getInt("offlineH", OFFLINE_OPEN_H);
  out.hardCapH     = prefs.getInt("hardCap",  0);
  prefs.end();
  return ok;
}

void NVS::savePolicy(const BoxPolicy& in) {
  prefs.begin("policy", false);
  prefs.putLong64("lockUntil", (int64_t)in.lockUntil);
  prefs.putInt("offlineH", in.offlineOpenH);
  prefs.putInt("hardCap",  in.hardCapH);
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

  prefs.begin("nets", false);
  prefs.putInt("count", count);
  char key[8];
  for (int i = 0; i < count; i++) {
    snprintf(key, sizeof(key), "s%d", i);
    prefs.putString(key, nets[i].ssid);
    snprintf(key, sizeof(key), "p%d", i);
    prefs.putString(key, nets[i].pass);
  }
  prefs.end();
}
