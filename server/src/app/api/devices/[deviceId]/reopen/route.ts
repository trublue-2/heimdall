import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { publishCommand } from "@/lib/mqttBridge";

// Riegel-Retry (Fallback ohne Endlagensensor): Box soll laut Zustand offen sein, der Riegel
// klemmt aber physisch → der User meldet das, die Box fährt erneut Richtung "offen".
// Sichere Richtung (öffnen ist immer safe); greift instant im Wachfenster, sonst beim nächsten Sync.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  await prisma.deviceEvent.create({
    data: { deviceId, type: "REOPEN", timestamp: new Date(), reason: "manual_retry" },
  });

  notifyDeviceChange();
  publishCommand(deviceId, "reopen");
  return NextResponse.json({ ok: true });
}
