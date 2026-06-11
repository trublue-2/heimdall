#include "ota.h"
#include "config.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>

bool OTA::apply(const char* url, const char* token) {
  WiFiClientSecure client;
  client.setInsecure(); // TODO: Zertifikat-Pinning (wie server_sync)

  HTTPClient http;
  if (!http.begin(client, url)) { log_e("OTA: begin fehlgeschlagen"); return false; }
  http.addHeader("Authorization", String("Bearer ") + token);

  int code = http.GET();
  if (code != 200) { log_e("OTA: HTTP %d", code); http.end(); return false; }

  int len = http.getSize();
  if (!Update.begin(len > 0 ? (size_t)len : UPDATE_SIZE_UNKNOWN)) {
    log_e("OTA: Update.begin fehlgeschlagen (Platz?)"); http.end(); return false;
  }
  Update.onProgress([](size_t done, size_t total) {
    if (total) log_i("OTA: %u%%", (unsigned)(done * 100 / total));
  });

  size_t written = Update.writeStream(http.getStream());
  http.end();

  if (!Update.end(true) || !Update.isFinished()) {
    log_e("OTA: Schreiben fehlgeschlagen (err=%d)", Update.getError());
    return false;
  }
  log_i("OTA: OK (%u Bytes) → Reboot in neue Firmware", (unsigned)written);
  // Validierung anstoßen (S14): neue FW muss sich durch erfolgreichen Sync bestätigen,
  // sonst Rollback. Flag überlebt den Reboot in NVS.
  { Preferences p; p.begin("ota", false); p.putBool("pending", true); p.putUInt("boots", 0); p.end(); }
  delay(500);
  ESP.restart();
  return true; // nie erreicht
}
