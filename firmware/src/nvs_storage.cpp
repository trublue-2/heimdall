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
