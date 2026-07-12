#include "wake_journal.h"
#include "failsafe.h"  // clockValid() — RTC via NTP gültig gesetzt?
#include <time.h>
#include <string.h>

// RTC-Slow-RAM: überlebt Deep-Sleep (die RTC-Domain bleibt für den Weck-Timer ohnehin versorgt →
// kein zusätzlicher Sleep-Strom), wird nur bei echtem Power-on genullt. Der Magic-Marker erkennt
// genau diesen Fall (frischer Boot = Müll) — analog zu rtcWifiHint in server_sync.cpp.
namespace {
  constexpr uint8_t  JOURNAL_CAP   = 64;          // 24h offline ≈ 24 Heartbeats + Button-Wakes, mit Reserve
  constexpr uint32_t JOURNAL_MAGIC = 0x574B4A31;  // "WKJ1"

  struct WakeEntry {
    uint32_t t;      // unix-Zeit (RTC), 0 = vor erstem NTP (Server klemmt auf Empfangszeit)
    int16_t  b;      // Akku %, -1 = unbekannt
    char     r[16];  // Wake-Grund ("offline_timeout" = längster, 15+null)
  };

  struct Journal {
    uint32_t  magic;
    uint8_t   count;             // gültige Einträge in entry[0..count)
    uint16_t  dropped;           // wegen Overflow verworfene älteste Einträge
    WakeEntry entry[JOURNAL_CAP];
  };

  RTC_DATA_ATTR Journal gJournal;

  void ensureInit() {
    if (gJournal.magic != JOURNAL_MAGIC) { // frischer Power-on → Müll → sauber initialisieren
      gJournal.magic   = JOURNAL_MAGIC;
      gJournal.count   = 0;
      gJournal.dropped = 0;
    }
  }
}

void recordWake(const char* reason, int batteryPct) {
  ensureInit();
  if (gJournal.count >= JOURNAL_CAP) { // Ring voll: ältesten verwerfen, Overflow zählen
    memmove(&gJournal.entry[0], &gJournal.entry[1], sizeof(WakeEntry) * (JOURNAL_CAP - 1));
    gJournal.count = JOURNAL_CAP - 1;
    if (gJournal.dropped < 0xFFFF) gJournal.dropped++;
  }
  WakeEntry& e = gJournal.entry[gJournal.count++];
  // Zeitstempel nur, wenn die RTC via NTP gültig läuft (sonst 0 → Server klemmt auf Empfangszeit).
  e.t = Failsafe::clockValid() ? (uint32_t)time(nullptr) : 0;
  e.b = (batteryPct >= 0 && batteryPct <= 100) ? (int16_t)batteryPct : -1;
  strlcpy(e.r, reason ? reason : "", sizeof(e.r));
}

void wakeJournalToJson(JsonDocument& req) {
  ensureInit();
  if (gJournal.count == 0 && gJournal.dropped == 0) return;
  JsonArray a = req["wakes"].to<JsonArray>();
  for (uint8_t i = 0; i < gJournal.count; i++) {
    JsonObject o = a.add<JsonObject>();
    o["r"] = gJournal.entry[i].r;
    o["t"] = gJournal.entry[i].t;
    if (gJournal.entry[i].b >= 0) o["b"] = gJournal.entry[i].b;
  }
  if (gJournal.dropped) req["wakesDropped"] = gJournal.dropped;
}

void wakeJournalClear() {
  ensureInit();
  gJournal.count   = 0;
  gJournal.dropped = 0;
}
