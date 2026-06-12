import { NextRequest, NextResponse } from "next/server";
import { authenticateDevice, extractBearerToken, effectiveLockUntil } from "@/lib/device-auth";
import { prisma } from "@/lib/prisma";

function ts() { return new Date().toISOString(); }

export async function POST(req: NextRequest) {
  const rawToken = extractBearerToken(req.headers.get("authorization"));
  if (!rawToken) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  const device = await authenticateDevice(rawToken);
  if (!device) {
    console.warn(`${ts()} [box/register] Invalid token`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Ensure a default LockPolicy exists — und das erzeugte Objekt auch nutzen
  // (vorher wurde der refetch verworfen → device.policy blieb null → lockUntil falsch).
  if (!device.policy) {
    device.policy = await prisma.lockPolicy.create({
      data: { deviceId: device.id },
    });
  }

  const lockUntil = effectiveLockUntil(device.policy, device.lockedSince, now);
  console.log(`${ts()} [box/register] Device "${device.name}" registered`);

  return NextResponse.json({
    lockUntil: lockUntil?.toISOString() ?? null,
    offlineOpenHours: device.policy?.offlineOpenHours ?? 24,
    hardCapHours: device.policy?.hardCapHours ?? 0, // 0 = kein Cap (wie sync, lokal enforced)
    timeUTC: now.toISOString(),
    fwTarget: null,
  });
}
