#pragma once
#include <Arduino.h>

// Gespeicherte WLAN- und Server-Credentials (Provisioning).
struct WifiCredentials {
  char ssid[64];
  char password[64];
  char serverUrl[128]; // "https://heimdall.trublue.ch"
  char deviceToken[64];
};

// Zusätzliche WLANs (vom Server per Sync geliefert). Primärnetz = WifiCredentials.
#define MAX_EXTRA_NETS 3
struct WifiNet {
  char ssid[64];
  char pass[64];
};

// Persistenter Box-Zustand (bleibt über Deep-Sleep erhalten).
struct BoxState {
  bool   locked;
  time_t lockedSince;  // Unix-Epoch; 0 wenn nie gesperrt
  time_t lastSyncAt;   // Unix-Epoch des letzten erfolgreichen Syncs
  char   wakeReason[32];
  int    batteryPct;   // Aktuell gemessen, vor WiFi-Init (ADC ungestört)
  bool   charging;     // true = USB/Netz dran (GPIO26, PIN_CHARGE_DETECT)
  char   deviceName[64]; // Anzeigename vom Server (nur RAM, je Sync gesetzt)

  // Monotone Failsafe-Zähler — clock-UNABHÄNGIG (überleben Brownout/1970-Uhr via NVS).
  // Garantieren, dass Offline-Timeout/HardCap auch ohne gültige Wall-Clock greifen.
  uint32_t lockedSeconds;  // akkumulierte Sperrdauer (0 wenn offen) → HardCap
  uint32_t offlineSeconds; // Zeit seit letztem erfolgreichen Sync (0 bei Sync) → Offline-Open
  time_t   lastTick;       // time() beim letzten Wake (für Delta-Berechnung)
};

// MQTT-Konfig für den Session-Fenster-Push. Kommt pro Box aus der Sync-Response
// (über den gehärteten HTTPS-Kanal provisioniert) und wird in NVS gecacht.
// enabled=false (oder fehlender Block) → Box bleibt heartbeat-only, kein MQTT.
struct MqttConfig {
  bool enabled;
  char host[128];    // Broker-Host (mqtts, Port aus config.h)
  char deviceId[40]; // cuid der Box — clientId/username + Topic-Segment
};

// Letzte vom Server empfangene Policy.
struct BoxPolicy {
  bool   serverLocked; // Server-Vorgabe "soll zu sein" (Simple-Lock ODER aktive Zeit).
                       // Autoritativ — entkoppelt "zu" von lockUntil (Simple-Lock: zu ohne Deadline).
  time_t lockUntil;    // Unix-Epoch; 0 = keine Deadline (Failsafe-Grenze, NICHT "offen")
  int    offlineOpenH; // h — Standard: OFFLINE_OPEN_H
  int    hardCapH;     // 0 = kein absoluter Cap
};

namespace NVS {
  void begin();

  bool loadCredentials(WifiCredentials& out);
  void saveCredentials(const WifiCredentials& in);
  void clearCredentials(); // Long-Press Reset

  bool loadState(BoxState& out);
  void saveState(const BoxState& in);

  bool loadPolicy(BoxPolicy& out);
  void savePolicy(const BoxPolicy& in);

  bool loadMqtt(MqttConfig& out);   // false, wenn nie ein Block gespeichert wurde
  void saveMqtt(const MqttConfig& in);

  int  loadExtraNets(WifiNet* out, int maxN);          // gibt Anzahl zurück
  void saveExtraNet(const char* ssid, const char* pass); // dedup nach SSID, max MAX_EXTRA_NETS
  void deleteExtraNet(const char* ssid);                 // Extra-Netz entfernen (nach SSID)
  void setPreferredSsid(const char* ssid);               // bevorzugtes Netz (leer = löscht Präferenz)
  bool getPreferredSsid(char* out, size_t cap);          // true, wenn eine Präferenz gesetzt ist
}
