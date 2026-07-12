#pragma once
#include <ArduinoJson.h>

// Persistentes Fehl-Sync-Log auf der LittleFS-("spiffs"-)Partition. Übersteht Reboot/Brownout
// (anders als der RAM-Ring gLog und das RTC-Wake-Journal). Wird NUR bei einem fehlgeschlagenen
// Sync beschrieben (verschleißarm) und beim nächsten ERFOLGREICHEN Sync hochgeladen, danach
// gelöscht. Best-effort & isoliert: schlägt der Mount fehl, sind alle Ops No-ops — der Flash-Log
// darf nie Boot, Safety oder die Lock-Funktion blockieren.
namespace FlashLog {
  void begin();                   // LittleFS mounten (einmal im setup(), nach NVS::begin())
  void persistPending();          // neue RAM-Log-Zeilen dieses Fehl-Wakes ans Backlog anhängen (+Rotation)
  void toJson(JsonDocument& req);  // Backlog als req["backlog"] anhängen (ungated) — im Sync-Body
  void clear();                   // Backlog löschen — NUR nach bestätigtem Upload (SyncResult::OK)
}
