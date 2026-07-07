#pragma once
#include <Arduino.h>
#include "nvs_storage.h"

// MQTT-Push für das Wachfenster. Nur bei Button/USB verbunden (Deep-Sleep = getrennt).
// Trägt die Sofort-Kommandos der Website; die autoritative Policy bleibt beim HTTPS-Sync.
// TLS mit demselben Cert-Pinning wie der Sync (ROOT_CA_BUNDLE).
namespace Mqtt {
  enum class Command { NONE, OPEN, CLOSE, LOCK, SYNC, REOPEN };

  // Verbindet zum Broker. token = MQTT-Passwort (username/clientId = cfg.deviceId).
  // false, wenn deaktiviert, unkonfiguriert oder Connect fehlschlägt.
  bool connect(const MqttConfig& cfg, const char* token);
  bool connected();
  void loop();       // im Wachfenster jede Iteration aufrufen (bedient Keepalive + Callbacks)
  void disconnect(); // publisht "offline" (retained) + trennt — vor Deep-Sleep

  // Zuletzt empfangenes Kommando (consume-on-read), Command::NONE wenn keins.
  Command takeCommand();
}
