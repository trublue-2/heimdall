#include "mqtt_client.h"
#include "config.h"
#include "certs.h"
#include "logbuf.h"
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// Eigener TLS-Socket (getrennt vom Sync — der macht seinen eigenen pro Call auf).
static WiFiClientSecure   gTls;
static PubSubClient       gClient(gTls);
static volatile Mqtt::Command gPending = Mqtt::Command::NONE;
static char gCmdTopic[160];
static char gStatusTopic[160];
static char gLogTopic[160];
static char gClientId[40];

static Mqtt::Command parseCmd(const char* c) {
  if (!strcmp(c, "open"))   return Mqtt::Command::OPEN;
  if (!strcmp(c, "close"))  return Mqtt::Command::CLOSE;
  if (!strcmp(c, "lock"))   return Mqtt::Command::LOCK;
  if (!strcmp(c, "sync"))   return Mqtt::Command::SYNC;
  if (!strcmp(c, "reopen")) return Mqtt::Command::REOPEN;
  return Mqtt::Command::NONE;
}

// Payload z.B. {"cmd":"open"} — klein, per ArduinoJson geparst.
static void onMsg(char* /*topic*/, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  const char* c = doc["cmd"] | "";
  Mqtt::Command cmd = parseCmd(c);
  if (cmd != Mqtt::Command::NONE) { gPending = cmd; log_i("MQTT cmd: %s", c); }
}

bool Mqtt::connect(const MqttConfig& cfg, const char* token) {
  if (!cfg.enabled || !cfg.host[0] || !cfg.deviceId[0]) return false;

  gTls.setCACert(MQTT_ROOT_CA); // nur ISRG X1 statt Bundle → weniger Heap im Handshake (Heap = TLS-Engpass)
  strlcpy(gClientId, cfg.deviceId, sizeof(gClientId));
  snprintf(gCmdTopic,    sizeof(gCmdTopic),    "%s%s/cmd",    MQTT_TOPIC_PREFIX, cfg.deviceId);
  snprintf(gStatusTopic, sizeof(gStatusTopic), "%s%s/status", MQTT_TOPIC_PREFIX, cfg.deviceId);
  snprintf(gLogTopic,    sizeof(gLogTopic),    "%s%s/log",    MQTT_TOPIC_PREFIX, cfg.deviceId);

  gClient.setServer(cfg.host, MQTT_PORT);
  gClient.setKeepAlive(MQTT_KEEPALIVE_S);
  gClient.setBufferSize(512);
  gClient.setCallback(onMsg);

  // LWT: Broker publisht "offline" (retained), wenn die Box wegbricht → Präsenz im Dashboard.
  bool ok = gClient.connect(gClientId, cfg.deviceId, token,
                            gStatusTopic, /*willQos=*/1, /*willRetain=*/true, "offline");
  if (ok) {
    gClient.publish(gStatusTopic, "online", true); // retained
    gClient.subscribe(gCmdTopic, 1);
    // Heap-Watermark direkt nach dem 2. TLS-Handshake (Sync + MQTT) — die eigentliche
    // ESP32-TLS-Engstelle. min = tiefster je erreichter Stand (deckt den Handshake-Peak ab).
    log_i("MQTT verbunden: %s:%d (%s) | Heap frei=%u min=%u",
          cfg.host, MQTT_PORT, gCmdTopic, ESP.getFreeHeap(), ESP.getMinFreeHeap());
  } else {
    log_w("MQTT-Connect fehlgeschlagen (state=%d) | Heap frei=%u min=%u",
          gClient.state(), ESP.getFreeHeap(), ESP.getMinFreeHeap());
  }
  return ok;
}

void Mqtt::publishLog(const char* payload) {
  // Live-Log ins .../log-Topic (QoS 0, best-effort) — nur solange verbunden.
  if (gClient.connected()) gClient.publish(gLogTopic, payload);
}

bool Mqtt::connected() { return gClient.connected(); }

void Mqtt::loop() { if (gClient.connected()) gClient.loop(); }

void Mqtt::disconnect() {
  if (gClient.connected()) {
    gClient.publish(gStatusTopic, "offline", true); // saubere Abmeldung (LWT als Backup)
    gClient.disconnect();
  }
}

Mqtt::Command Mqtt::takeCommand() {
  Command c = gPending;
  gPending = Command::NONE;
  return c;
}
