import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";

// Steuerung + Policy-Edit (lockUntil = sperren/öffnen, offlineOpenHours, hardCap).
// Zugriff: zugewiesenes Konto oder Admin.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  const body = await req.json();

  // Partielles Update: nur übergebene Felder ändern. So setzt das Sperren/Öffnen
  // (nur lockUntil) nicht versehentlich Failsafe/Hard-Cap zurück.
  const data: {
    lockUntil?: Date | null;
    offlineOpenHours?: number;
    hardCapHours?: number | null;
  } = {};
  if ("lockUntil" in body) data.lockUntil = body.lockUntil ? new Date(body.lockUntil) : null;
  if ("offlineOpenHours" in body) data.offlineOpenHours = Number(body.offlineOpenHours) || 24;
  if ("hardCapHours" in body) data.hardCapHours = body.hardCapHours != null ? Number(body.hardCapHours) : null;

  const policy = await prisma.lockPolicy.upsert({
    where: { deviceId },
    create: { deviceId, ...data },
    update: data,
    include: { device: { select: { name: true } } },
  });

  notifyDeviceChange(); // offene Dashboards sofort aktualisieren

  return NextResponse.json({
    deviceId,
    deviceName: policy.device.name,
    lockUntil: policy.lockUntil?.toISOString() ?? null,
    offlineOpenHours: policy.offlineOpenHours,
    hardCapHours: policy.hardCapHours,
  });
}
