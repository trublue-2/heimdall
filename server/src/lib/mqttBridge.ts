import mqtt, { type MqttClient } from "mqtt";
import { notifyDeviceChange } from "@/lib/events";
import { MQTT_TOPIC_PREFIX } from "@/lib/mqttAuth";

// Server→Box-Push über MQTT. Der Server publisht Sofort-Kommandos auf das cmd-Topic der Box
// und liest die LWT-Präsenz (online/offline) vom status-Topic. Single-Container → In-Memory-
// Präsenz genügt (wie der SSE-Bus in events.ts). Ohne MQTT_BRIDGE_URL (z.B. Dev) ist die
// Bridge inaktiv: publishCommand() ist ein No-Op, die Box läuft dann rein pull-basiert weiter.

type BridgeState = { client: MqttClient | null; presence: Map<string, boolean> };

const g = globalThis as unknown as { __mqttBridge?: BridgeState };
const state: BridgeState =
  g.__mqttBridge ?? (g.__mqttBridge = { client: null, presence: new Map() });

function ensureClient(): MqttClient | null {
  if (state.client) return state.client;
  const url = process.env.MQTT_BRIDGE_URL;
  if (!url) return null; // kein Broker konfiguriert → Bridge inaktiv

  const client = mqtt.connect(url, {
    username: process.env.MQTT_BRIDGE_USER,
    password: process.env.MQTT_BRIDGE_PASS,
    reconnectPeriod: 5000,
    clientId: `heimdall-bridge-${process.pid}`,
  });

  client.on("connect", () => {
    // Retained status-Topics → Präsenz füllt sich beim Connect für alle bekannten Boxen.
    client.subscribe(`${MQTT_TOPIC_PREFIX}+/status`, { qos: 1 });
  });
  client.on("message", (topic, payload) => {
    const m = topic.match(/^heimdall\/box\/([^/]+)\/status$/);
    if (!m) return;
    const online = payload.toString() === "online";
    if (state.presence.get(m[1]) !== online) {
      state.presence.set(m[1], online);
      notifyDeviceChange(); // Dashboards live aktualisieren (online/schläft)
    }
  });
  client.on("error", (e) => console.warn(`[mqttBridge] ${e.message}`));

  state.client = client;
  return client;
}

/** Sofort-Kommando an die Box pushen (fire-and-forget). Wirkt nur, wenn die Box gerade
 *  im Wachfenster verbunden ist; sonst greift es beim nächsten Sync/Heartbeat. */
export function publishCommand(deviceId: string, cmd: string): void {
  try {
    const client = ensureClient();
    client?.publish(`${MQTT_TOPIC_PREFIX}${deviceId}/cmd`, JSON.stringify({ cmd }), { qos: 1 });
  } catch (e) {
    console.warn(`[mqttBridge] publish failed: ${(e as Error).message}`);
  }
}

/** Ist die Box gerade MQTT-verbunden (Wachfenster)? Startet die Bridge lazy mit. */
export function deviceOnline(deviceId: string): boolean {
  ensureClient();
  return state.presence.get(deviceId) ?? false;
}
