import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Zusatz-WLAN entfernen (stoppt die Auslieferung; die Box behält ein bereits
// gespeichertes Netz bis zur Neu-Provisionierung).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ netId: string }> }) {
  const { response } = await requireAdminApi();
  if (response) return response;
  const { netId } = await params;
  // SSID vor dem Löschen merken, um eine ggf. darauf zeigende Präferenz mitzuräumen.
  const net = await prisma.wifiNetwork.findUnique({
    where: { id: netId },
    select: { deviceId: true, ssid: true },
  });
  await prisma.wifiNetwork.delete({ where: { id: netId } }).catch(() => {});
  if (net) {
    await prisma.device.updateMany({
      where: { id: net.deviceId, preferredSsid: net.ssid },
      data: { preferredSsid: null },
    });
  }
  return NextResponse.json({ ok: true });
}
