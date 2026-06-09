#pragma once
#include <Arduino.h>

// Gespeicherte WLAN- und Server-Credentials (Provisioning).
struct WifiCredentials {
  char ssid[64];
  char password[64];
  char serverUrl[128]; // "https://heimdall.trublue.ch"
  char deviceToken[64];
};

// Persistenter Box-Zustand (bleibt über Deep-Sleep erhalten).
struct BoxState {
  bool   locked;
  time_t lockedSince;  // Unix-Epoch; 0 wenn nie gesperrt
  time_t lastSyncAt;   // Unix-Epoch des letzten erfolgreichen Syncs
  char   wakeReason[32];
  int    batteryPct;   // Aktuell gemessen, vor WiFi-Init (ADC ungestört)
};

// Letzte vom Server empfangene Policy.
struct BoxPolicy {
  time_t lockUntil;    // Unix-Epoch; 0 = kein Lock gesetzt
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
}
