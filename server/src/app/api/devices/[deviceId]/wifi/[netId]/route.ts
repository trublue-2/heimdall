import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

// Zusatz-WLAN entfernen (stoppt die Auslieferung; die Box behält ein bereits
// gespeichertes Netz bis zur Neu-Provisionierung).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ deviceId: string; netId: string }> }
) {
  const { deviceId, netId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;
  // Gelöscht wird über BEIDE Ids. Die netId allein genügt nicht: der Guard prüft die deviceId
  // aus dem Pfad, die netId zeigt aber irgendwohin — wer Zugriff auf EINE Box hat, könnte sonst
  // über eine fremde netId das Netz einer anderen Box löschen. Unter dem früheren Admin-Guard
  // war das folgenlos, mit gerätegebundenem Zugriff ist es eine Lücke.
  const net = await prisma.wifiNetwork.findFirst({
    where: { id: netId, deviceId },
    select: { ssid: true },
  });
  if (!net) return NextResponse.json({ error: "Netz nicht gefunden" }, { status: 404 });

  await prisma.wifiNetwork.delete({ where: { id: netId } });
  // Eine Präferenz, die auf das gelöschte Netz zeigte, miträumen.
  await prisma.device.updateMany({
    where: { id: deviceId, preferredSsid: net.ssid },
    data: { preferredSsid: null },
  });
  return NextResponse.json({ ok: true });
}
