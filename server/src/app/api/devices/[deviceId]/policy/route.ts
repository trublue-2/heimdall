import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { publishCommand } from "@/lib/mqttBridge";

// Safety-relevante Felder — strikt validieren, kein NaN/Invalid-Date in die DB.
const policySchema = z.object({
  lockUntil: z.string().datetime().nullable().optional(),
  offlineOpenHours: z.number().int().min(1).max(168).optional(),
  syncIntervalMin: z.number().int().min(1).max(180).optional(),
});

// Steuerung + Policy-Edit (lockUntil = sperren/öffnen, offlineOpenHours).
// Zugriff: zugewiesenes Konto oder Admin.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  const parsed = policySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Ungültige Policy-Werte" }, { status: 400 });
  }
  const body = parsed.data;

  // Partielles Update: nur übergebene Felder ändern. So setzt das Sperren/Öffnen
  // (nur lockUntil) nicht versehentlich den Offline-Failsafe zurück.
  const data: {
    lockUntil?: Date | null;
    offlineOpenHours?: number;
    syncIntervalMin?: number;
  } = {};
  if (body.lockUntil !== undefined) data.lockUntil = body.lockUntil ? new Date(body.lockUntil) : null;
  if (body.offlineOpenHours !== undefined) data.offlineOpenHours = body.offlineOpenHours;
  if (body.syncIntervalMin !== undefined) data.syncIntervalMin = body.syncIntervalMin;

  const policy = await prisma.lockPolicy.upsert({
    where: { deviceId },
    create: { deviceId, ...data },
    update: data,
    include: { device: { select: { name: true } } },
  });

  notifyDeviceChange(); // offene Dashboards sofort aktualisieren
  publishCommand(deviceId, "sync"); // Box im Wachfenster zum sofortigen Re-Sync anstupsen

  return NextResponse.json({
    deviceId,
    deviceName: policy.device.name,
    lockUntil: policy.lockUntil?.toISOString() ?? null,
    offlineOpenHours: policy.offlineOpenHours,
    syncIntervalMin: policy.syncIntervalMin,
  });
}
