#include "ota.h"
#include "config.h"
#include "certs.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <SHA256.h>
#include <Ed25519.h>

// 128 Hex-Zeichen → 64 Byte Signatur. false bei falscher Länge / Nicht-Hex.
static bool hexToBytes(const char* hex, uint8_t* out, size_t outLen) {
  if (strlen(hex) != outLen * 2) return false;
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < outLen; i++) {
    int hi = nib(hex[2 * i]), lo = nib(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}

bool OTA::apply(const char* url, const char* token, const char* sigHex) {
  // Signatur ZUERST prüfen — kein Download/Flash, wenn sie formal schon kaputt ist.
  uint8_t sig[64];
  if (!sigHex || !hexToBytes(sigHex, sig, sizeof(sig))) {
    log_e("OTA: keine/ungültige Signatur — abgelehnt (fail-closed)");
    return false;
  }

  WiFiClientSecure client;
  client.setCACert(ROOT_CA_BUNDLE); // Cert-Pinning (siehe certs.h) — nur echter Server

  HTTPClient http;
  if (!http.begin(client, url)) { log_e("OTA: begin fehlgeschlagen"); return false; }
  http.addHeader("Authorization", String("Bearer ") + token);

  int code = http.GET();
  if (code != 200) { log_e("OTA: HTTP %d", code); http.end(); return false; }

  int len = http.getSize();
  if (!Update.begin(len > 0 ? (size_t)len : UPDATE_SIZE_UNKNOWN)) {
    log_e("OTA: Update.begin fehlgeschlagen (Platz?)"); http.end(); return false;
  }

  // .bin streamen: jeden Chunk in den inaktiven Slot schreiben UND mithashen.
  // Nie ganz im RAM (~1 MB) — wir verifizieren am Ende über den 32-Byte-Digest.
  // Update.write() macht den Slot noch NICHT bootfähig; das tut erst Update.end(true).
  SHA256 sha;
  Stream& stream = http.getStream();
  uint8_t buf[1024];
  size_t written = 0;
  int lastPct = -10;
  while (http.connected() && (len < 0 || written < (size_t)len)) {
    int n = stream.readBytes(buf, sizeof(buf));
    if (n <= 0) break; // Stream zu Ende / Timeout
    if (Update.write(buf, n) != (size_t)n) {
      log_e("OTA: Flash-Write-Fehler (err=%d)", Update.getError());
      Update.abort(); http.end(); return false;
    }
    sha.update(buf, n);
    written += n;
    int pct = len > 0 ? (int)(written * 100 / len) : -1;
    if (pct >= lastPct + 10) { log_i("OTA: %d%%", pct); lastPct = pct; }
  }
  http.end();

  if (len > 0 && written != (size_t)len) {
    log_e("OTA: unvollständig (%u/%d) — abgelehnt", (unsigned)written, len);
    Update.abort(); return false;
  }

  // Signatur über sha256(.bin) verifizieren — fremde/korrupte Bin fällt hier durch.
  uint8_t digest[32];
  sha.finalize(digest, sizeof(digest));
  if (!Ed25519::verify(sig, OTA_PUBKEY, digest, sizeof(digest))) {
    log_e("OTA: SIGNATUR UNGÜLTIG — Flash verworfen (fail-closed)");
    Update.abort();
    return false;
  }

  if (!Update.end(true) || !Update.isFinished()) {
    log_e("OTA: Abschluss fehlgeschlagen (err=%d)", Update.getError());
    return false;
  }
  log_i("OTA: signiert & OK (%u Bytes) → Reboot in neue Firmware", (unsigned)written);
  // Validierung anstoßen (S14): neue FW muss sich durch erfolgreichen Sync bestätigen,
  // sonst Rollback. Flag überlebt den Reboot in NVS.
  { Preferences p; p.begin("ota", false); p.putBool("pending", true); p.putUInt("boots", 0); p.end(); }
  delay(500);
  ESP.restart();
  return true; // nie erreicht
}
