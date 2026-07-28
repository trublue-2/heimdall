import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { publishCommand } from "@/lib/mqttBridge";

// Gemeldete Namensliste der Box (JSON-Array-String im Device) → String[].
function parseKnown(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// Zugriff auf alle WLAN-Routen: Admin ODER das Konto, dem die Box zugewiesen ist. Wer seine Box
// bedienen darf, darf sie auch ins eigene Netz bringen — sonst hängt jeder Netzwechsel am Admin.
// Passwörter verlässt die API nie (nur `delivered`), das gilt für beide Rollen gleichermassen.
//
// Die Routen liegen deshalb NICHT unter /api/admin: proxy.ts sperrt diesen Pfad-Präfix für
// Nicht-Admins schon vor dem Handler — ein Rollen-Check im Handler allein käme nie zum Zug.

// Zusatz-WLANs eines Geräts + bevorzugtes Netz auflisten (ohne Passwörter).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;
  const [device, nets] = await Promise.all([
    prisma.device.findUnique({ where: { id: deviceId }, select: { preferredSsid: true, primaryLastUsedAt: true, primarySsid: true, knownSsids: true } }),
    prisma.wifiNetwork.findMany({
      where: { deviceId },
      orderBy: { createdAt: "asc" },
      select: { id: true, ssid: true, password: true, lastUsedAt: true },
    }),
  ]);
  return NextResponse.json({
    preferredSsid: device?.preferredSsid ?? null,
    primaryLastUsedAt: device?.primaryLastUsedAt?.toISOString() ?? null,
    primarySsid: device?.primarySsid ?? null,
    knownSsids: parseKnown(device?.knownSsids), // von der Box gemeldet (NVS: Primär + Extras)
    nets: nets.map((n) => ({
      id: n.id,
      ssid: n.ssid,
      delivered: n.password === null,
      lastUsedAt: n.lastUsedAt?.toISOString() ?? null,
    })),
  });
}

// Zusatz-WLAN hinzufügen/aktualisieren. Passwort wird beim nächsten Box-Sync
// ausgeliefert und danach automatisch genullt.
export async function POST(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;
  const { ssid, password } = await req.json();
  if (!ssid || typeof ssid !== "string") {
    return NextResponse.json({ error: "SSID nötig" }, { status: 400 });
  }
  const net = await prisma.wifiNetwork.upsert({
    where: { deviceId_ssid: { deviceId, ssid } },
    update: { password: password ?? "" },
    create: { deviceId, ssid, password: password ?? "" },
  });
  return NextResponse.json({ id: net.id, ssid: net.ssid, delivered: false });
}

// Bevorzugtes Netz setzen/aufheben (Server gewinnt → wird beim Sync an die Box gepusht).
// Erlaubt nur ein der Box bekanntes Netz (Primär oder ein Extra) oder null.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;
  const body = await req.json();

  // „Vergessen": ein von der Box gemeldetes Extra-WLAN aus deren NVS entfernen. Primär ist
  // geschützt (das braucht die Box zum Verbinden). Das MQTT-Kommando ist der Trigger (wirkt im
  // Wachfenster; die Box bestätigt die reduzierte Liste per nächstem Sync). Serverseitig gleich
  // aus Anzeige- + Push-Liste nehmen, damit es nicht sofort wieder auftaucht/neu gepusht wird.
  if (typeof body.forgetSsid === "string" && body.forgetSsid) {
    const ssid = body.forgetSsid;
    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { primarySsid: true, knownSsids: true } });
    if (device?.primarySsid === ssid) {
      return NextResponse.json({ error: "Primär-WLAN kann nicht vergessen werden" }, { status: 400 });
    }
    publishCommand(deviceId, "forget_wifi", { ssid });
    const known = parseKnown(device?.knownSsids).filter((s) => s !== ssid);
    await prisma.device.update({ where: { id: deviceId }, data: { knownSsids: JSON.stringify(known) } });
    await prisma.wifiNetwork.deleteMany({ where: { deviceId, ssid } });
    notifyDeviceChange();
    return NextResponse.json({ forgotten: ssid });
  }

  const { preferredSsid } = body;
  if (preferredSsid !== null && typeof preferredSsid !== "string") {
    return NextResponse.json({ error: "preferredSsid muss String oder null sein" }, { status: 400 });
  }
  const pref = preferredSsid || null;
  if (pref) {
    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { primarySsid: true } });
    const known =
      device?.primarySsid === pref ||
      (await prisma.wifiNetwork.count({ where: { deviceId, ssid: pref } })) > 0;
    if (!known) return NextResponse.json({ error: "Netz ist der Box nicht bekannt" }, { status: 400 });
  }
  await prisma.device.update({ where: { id: deviceId }, data: { preferredSsid: pref } });
  notifyDeviceChange();
  return NextResponse.json({ preferredSsid: pref });
}
