import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";

// Gerät umbenennen und/oder Tracker-Mapping setzen. Zugriff: zugewiesenes Konto oder Admin.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  const body = await req.json();

  // Partielles Update: nur übergebene Felder ändern (Name oder Tracker-Anbindung).
  const data: {
    name?: string;
    otaDisabled?: boolean;
    logToServer?: boolean;
    emergencyOpensLeft?: number;
    trackerSync?: boolean;
    trackerInstanceId?: string | null;
    trackerUsername?: string | null;
  } = {};

  if (body.name !== undefined) {
    const name = (body.name as string)?.trim();
    if (!name) return NextResponse.json({ error: "Name erforderlich" }, { status: 400 });
    data.name = name;
  }
  if (body.emergencyOpensLeft !== undefined) {
    const n = Number(body.emergencyOpensLeft);
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      return NextResponse.json({ error: "Notöffnungen: 0–99" }, { status: 400 });
    }
    data.emergencyOpensLeft = n;
  }
  if (body.otaDisabled !== undefined) data.otaDisabled = !!body.otaDisabled;
  if (body.logToServer !== undefined) data.logToServer = !!body.logToServer;
  if (body.trackerSync !== undefined) data.trackerSync = !!body.trackerSync;
  if (body.trackerInstanceId !== undefined) data.trackerInstanceId = (body.trackerInstanceId as string)?.trim() || null;
  if (body.trackerUsername !== undefined) data.trackerUsername = (body.trackerUsername as string)?.trim() || null;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nichts zu ändern" }, { status: 400 });
  }

  await prisma.device.update({ where: { id: deviceId }, data });
  notifyDeviceChange();

  return NextResponse.json({ deviceId, ...data });
}
