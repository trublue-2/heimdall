import mqtt, { type MqttClient } from "mqtt";
import { notifyDeviceChange } from "@/lib/events";
import { MQTT_TOPIC_PREFIX } from "@/lib/mqttAuth";
import { prisma } from "@/lib/prisma";

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
    // Live-Log-Zeilen der Boxen (im Wachfenster) → in die DeviceLog-Tabelle spiegeln.
    client.subscribe(`${MQTT_TOPIC_PREFIX}+/log`, { qos: 0 });
  });
  client.on("message", (topic, payload) => {
    const m = topic.match(/^heimdall\/box\/([^/]+)\/(status|log)$/);
    if (!m) return;
    const [, deviceId, kind] = m;
    if (kind === "status") {
      const online = payload.toString() === "online";
      if (state.presence.get(deviceId) !== online) {
        state.presence.set(deviceId, online);
        notifyDeviceChange(); // Dashboards live aktualisieren (online/schläft)
      }
      return;
    }
    void ingestLog(deviceId, payload.toString()); // kind === "log"
  });
  client.on("error", (e) => console.warn(`[mqttBridge] ${e.message}`));

  state.client = client;
  return client;
}

// Live-Log-Zeilen (MQTT) in dieselbe DeviceLog-Tabelle wie der Sync-Upload spiegeln → der
// bestehende Log-Viewer zeigt sie ohne Sync-Verzögerung. Retention übernimmt der Sync-Handler.
let lastLogNotify = 0;
async function ingestLog(deviceId: string, chunk: string): Promise<void> {
  const lines = chunk
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-200);
  if (!lines.length) return;
  try {
    await prisma.deviceLog.createMany({ data: lines.map((line) => ({ deviceId, line })) });
    // Dashboard-Refresh drosseln (max. 1×/s), sonst flutet aktives Logging die SSE-Clients.
    const now = Date.now();
    if (now - lastLogNotify > 1000) {
      lastLogNotify = now;
      notifyDeviceChange();
    }
  } catch (e) {
    console.warn(`[mqttBridge] log ingest failed: ${(e as Error).message}`);
  }
}

/** Sofort-Kommando an die Box pushen (fire-and-forget). Wirkt nur, wenn die Box gerade
 *  im Wachfenster verbunden ist; sonst greift es beim nächsten Sync/Heartbeat. */
export function publishCommand(deviceId: string, cmd: string, extra?: Record<string, string>): void {
  try {
    const client = ensureClient();
    client?.publish(`${MQTT_TOPIC_PREFIX}${deviceId}/cmd`, JSON.stringify({ cmd, ...extra }), { qos: 1 });
  } catch (e) {
    console.warn(`[mqttBridge] publish failed: ${(e as Error).message}`);
  }
}

/** Ist die Box gerade MQTT-verbunden (Wachfenster)? Startet die Bridge notfalls lazy mit —
 *  der reguläre Start passiert aber EAGER beim Server-Boot (instrumentation.ts): lazy war die
 *  Präsenz-Liste beim allerersten Aufruf nach einem Neustart noch leer (connect + retained
 *  Messages sind asynchron), und der erste Instant-Push wurde fälschlich übersprungen. */
export function deviceOnline(deviceId: string): boolean {
  ensureClient();
  return state.presence.get(deviceId) ?? false;
}

/** Bridge beim Server-Start verbinden (instrumentation.ts). Die status-Topics sind retained —
 *  kurz nach dem Connect ist die Präsenz-Liste für alle bekannten Boxen warm. */
export function initBridge(): void {
  ensureClient();
}
