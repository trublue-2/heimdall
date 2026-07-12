#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

// Deep-sleep-festes Aufwach-Journal (RTC-RAM). Jeder Wake wird festgehalten und beim NÄCHSTEN
// erfolgreichen Sync gebündelt hochgeladen — so hinterlässt auch ein Auto-Wake (rtc_timer),
// dessen Sync scheiterte, eine Spur auf dem Server. Die Einträge überleben den Deep-Sleep
// (RTC_DATA_ATTR im .cpp), werden aber bei echtem Power-on genullt; ein Magic-Marker trennt
// frischen Boot-Müll von gültigen Daten. Unabhängig vom flüchtigen Serien-Log (gLog) und von
// logToServer — das Journal ist der strukturierte Audit-Pfad.

// Einen Wake festhalten. reason wie wakeReasonStr() ("button"/"rtc_timer"/"power_on"),
// batteryPct = letzter bekannter Akku-% (<0 = unbekannt). Zeitstempel = time(nullptr)
// (RTC läuft im Sleep frei → auch offline korrekt; vor dem ersten NTP → 0).
void recordWake(const char* reason, int batteryPct);

// Journal an den Sync-Body hängen: req["wakes"] = [{"r","t","b"}, …] plus req["wakesDropped"]
// (Anzahl bei Overflow verworfener ältester Einträge). No-op, wenn nichts anliegt.
void wakeJournalToJson(JsonDocument& req);

// Journal leeren — NUR nach bestätigtem Upload (SyncResult::OK) aufrufen. Dadurch bleiben die
// Einträge eines fehlgeschlagenen Syncs liegen und gehen beim nächsten geglückten Sync mit hoch.
void wakeJournalClear();
