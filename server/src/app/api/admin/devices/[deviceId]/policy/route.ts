import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { response } = await requireAdminApi();
  if (response) return response;

  const { deviceId } = await params;
  const body = await req.json();

  const lockUntil = body.lockUntil ? new Date(body.lockUntil) : null;
  const offlineOpenHours = Number(body.offlineOpenHours) || 24;
  const hardCapHours = body.hardCapHours != null ? Number(body.hardCapHours) : null;

  const policy = await prisma.lockPolicy.upsert({
    where: { deviceId },
    create: { deviceId, lockUntil, offlineOpenHours, hardCapHours },
    update: { lockUntil, offlineOpenHours, hardCapHours },
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
