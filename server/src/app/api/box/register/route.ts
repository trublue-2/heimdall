import { NextRequest, NextResponse } from "next/server";
import { authenticateDevice, extractBearerToken, boxLocked, deviceLockView } from "@/lib/device-auth";
import { prisma } from "@/lib/prisma";
import { logTs as ts } from "@/lib/logTime";
import { DEFAULT_OFFLINE_OPEN_HOURS } from "@/lib/utils";

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

  // Dieselbe Soll-Sicht wie box/sync: eine Deadline nur, wenn die Box auch zu sein soll — sonst
  // widerspräche sie dem `locked: false` daneben (siehe deviceLockView).
  const { lockUntil } = deviceLockView(device.policy, now);
  console.log(`${ts()} [box/register] Device "${device.name}" registered`);

  return NextResponse.json({
    locked: boxLocked(device.policy, now),
    lockUntil: lockUntil?.toISOString() ?? null,
    offlineOpenHours: device.policy?.offlineOpenHours ?? DEFAULT_OFFLINE_OPEN_HOURS,
    timeUTC: now.toISOString(),
    fwTarget: null,
  });
}
