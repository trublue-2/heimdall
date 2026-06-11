import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Zusatz-WLANs eines Geräts auflisten (ohne Passwörter).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ deviceId: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { deviceId } = await params;
  const nets = await prisma.wifiNetwork.findMany({
    where: { deviceId },
    orderBy: { createdAt: "asc" },
    select: { id: true, ssid: true, password: true },
  });
  return NextResponse.json(nets.map((n) => ({ id: n.id, ssid: n.ssid, delivered: n.password === null })));
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
