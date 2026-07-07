import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";

// Zusatz-WLANs eines Geräts + bevorzugtes Netz auflisten (ohne Passwörter).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { deviceId } = await params;
  const [device, nets] = await Promise.all([
    prisma.device.findUnique({ where: { id: deviceId }, select: { preferredSsid: true, primaryLastUsedAt: true } }),
    prisma.wifiNetwork.findMany({
      where: { deviceId },
      orderBy: { createdAt: "asc" },
      select: { id: true, ssid: true, password: true, lastUsedAt: true },
    }),
  ]);
  return NextResponse.json({
    preferredSsid: device?.preferredSsid ?? null,
    primaryLastUsedAt: device?.primaryLastUsedAt?.toISOString() ?? null,
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
  const { response } = await requireAdminApi();
  if (response) return response;
  const { deviceId } = await params;
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
  const { response } = await requireAdminApi();
  if (response) return response;
  const { deviceId } = await params;
  const { preferredSsid } = await req.json();
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
