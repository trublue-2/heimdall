#include "flash_log.h"
#include "logbuf.h"  // collectSyncLogs
#include "config.h"  // FLASHLOG_CAP
#include "log.h"
#include <LittleFS.h>
#include <sys/stat.h>

namespace {
  const char* PATH      = "/backlog.log";           // LittleFS-relativ (open/remove)
  const char* STAT_PATH = "/littlefs/backlog.log";  // globaler VFS-Pfad für stat()
  bool gReady = false;

  // Existenz OHNE VFS-open-Logging: LittleFS.exists()/open() im Arduino-Core öffnen die Datei
  // intern read-only → loggen bei fehlender Datei ein hässliches (harmloses) [E][vfs_api]. POSIX
  // stat() meldet ENOENT still zurück. So bleibt das Log sauber, wenn kein Backlog vorliegt.
  bool backlogExists() { struct stat st; return stat(STAT_PATH, &st) == 0; }

  // Rotation: Datei auf die letzten ~3/4 FLASHLOG_CAP kürzen (an der nächsten Zeilengrenze),
  // damit die älteste Diagnose wegfällt und die Datei beschränkt bleibt ("aufräumen").
  void rotate() {
    File f = LittleFS.open(PATH, FILE_READ);
    if (!f) return;
    size_t sz = f.size();
    const size_t keep = FLASHLOG_CAP * 3 / 4;
    if (sz <= keep) { f.close(); return; }
    f.seek(sz - keep);
    String tail = f.readString(); // die letzten ~keep Bytes
    f.close();
    int nl = tail.indexOf('\n'); // halbe erste Zeile abschneiden
    if (nl >= 0 && nl + 1 < (int)tail.length()) tail = tail.substring(nl + 1);
    File w = LittleFS.open(PATH, FILE_WRITE); // truncate
    if (!w) return;
    w.print(tail);
    w.close();
  }
}

void FlashLog::begin() {
  // LittleFS auf der vorhandenen, bislang ungenutzten "spiffs"-Partition. formatOnFail=true
  // formatiert sie beim ERSTEN Mount nach dem Rollout einmalig (< WDT-Budget).
  gReady = LittleFS.begin(/*formatOnFail=*/true, "/littlefs", 5, "spiffs");
  if (!gReady) { LOGW("FlashLog: LittleFS mount failed → persistent log disabled"); return; }
  LOGI("FlashLog: ready (%u/%u bytes)", (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());
}

void FlashLog::persistPending() {
  if (!gReady) return;
  // Genau die neuen RAM-Log-Zeilen dieses (fehlgeschlagenen) Wakes greifen — Boot-Banner +
  // "WiFi: connect to 'X' failed …". Der Sync-Cursor rückt weiter → gelten damit als behandelt.
  String chunk = collectSyncLogs(FLASHLOG_CAP);
  if (chunk.isEmpty()) return;

  File f = LittleFS.open(PATH, FILE_APPEND);
  if (!f) { LOGW("FlashLog: append open failed"); return; }
  f.print(chunk);
  size_t sz = f.size();
  f.close();
  LOGI("FlashLog: persisted %u bytes (backlog now %u)", (unsigned)chunk.length(), (unsigned)sz);

  if (sz > FLASHLOG_CAP) rotate();
}

void FlashLog::toJson(JsonDocument& req) {
  if (!gReady || !backlogExists()) return; // stat() zuerst → kein [E] vfs-Spam bei fehlender Datei
  File f = LittleFS.open(PATH, FILE_READ);
  if (!f) return;
  String content = f.readString();
  f.close();
  if (content.length()) req["backlog"] = content;
}

void FlashLog::clear() {
  if (!gReady || !backlogExists()) return; // stat() statt exists() → kein [E] remove/open-Spam
  LittleFS.remove(PATH);
}
