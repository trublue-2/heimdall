import { authenticateDeviceById } from "@/lib/device-auth";

// HTTP-Auth-Backend für mosquitto-go-auth. Reuse der bestehenden Token-Prüfung:
// eine Box authentifiziert sich am Broker mit username=deviceId, password=deviceToken.
// Der Server (mqttBridge) nutzt ein privilegiertes Bridge-Konto (Superuser).
//
// Erwartete mosquitto.conf: http_response_mode = json (Antwort {"Ok": bool}).

// Einzige Quelle des Broker-Topic-Namespaces (mqttBridge importiert sie hierher).
export const MQTT_TOPIC_PREFIX = "heimdall/box/";

/** Body von go-auth lesen — je nach http_params_mode JSON oder form-urlencoded. */
export async function readParams(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      return (await req.json()) as Record<string, string>;
    }
    const form = await req.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

function isBridge(username?: string, password?: string): boolean {
  const u = process.env.MQTT_BRIDGE_USER;
  const p = process.env.MQTT_BRIDGE_PASS;
  return !!u && !!p && username === u && password === p;
}

/** getuser: Bridge-Konto ODER eine Box (deviceId + gültiger Token). */
export async function checkUser(username?: string, password?: string): Promise<boolean> {
  if (isBridge(username, password)) return true;
  if (!username || !password) return false;
  return authenticateDeviceById(username, password); // username = deviceId
}

/** superuser: nur das Bridge-Konto darf alle Topics (Passwort wird von go-auth mitgesendet). */
export function checkSuperuser(username?: string, password?: string): boolean {
  return isBridge(username, password);
}

/** aclcheck: Bridge darf alles; eine Box nur ihr eigenes Topic-Subtree. */
export function checkAcl(username?: string, topic?: string): boolean {
  if (!username || !topic) return false;
  if (username === process.env.MQTT_BRIDGE_USER) return true;
  return topic.startsWith(`${MQTT_TOPIC_PREFIX}${username}/`);
}
