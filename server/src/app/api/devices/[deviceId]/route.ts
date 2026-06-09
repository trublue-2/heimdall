import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";

// Gerät umbenennen. Zugriff: zugewiesenes Konto oder Admin.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  const body = await req.json();
  const name = (body.name as string)?.trim();
  if (!name) return NextResponse.json({ error: "Name erforderlich" }, { status: 400 });

  await prisma.device.update({ where: { id: deviceId }, data: { name } });
  notifyDeviceChange();

  return NextResponse.json({ deviceId, name });
}
