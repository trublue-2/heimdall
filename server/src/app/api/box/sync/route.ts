import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateDevice, extractBearerToken, effectiveLockUntil } from "@/lib/device-auth";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { getTargetVersion } from "@/lib/firmware";

function ts() { return new Date().toISOString(); }

const LEGITIMATE_OPEN_REASONS = [
  "button",         // keyholder pressed button on box
  "low_battery",    // failsafe: battery too low
  "offline_timeout", // failsafe: 24h without sync
  "hard_deadline",  // failsafe: RTC deadline reached
  "keyholder",      // explicit keyholder command
];

const syncBodySchema = z.object({
  state: z.object({
    locked: z.boolean(),
    since: z.string().datetime().optional(),
    battery: z.number().int().min(0).max(100).optional(),
    boltPos: z.enum(["OPEN", "CLOSED", "UNKNOWN"]).optional(),
    fwVersion: z.string().max(32).optional(),
    wakeReason: z.string().max(64).optional(),
    wifiSsid: z.string().max(64).optional(),
    wifiRssi: z.number().int().min(-120).max(0).optional(),
    charging: z.boolean().optional(),
    ip: z.string().max(45).optional(),
  }),
});

export async function POST(req: NextRequest) {
  const rawToken = extractBearerToken(req.headers.get("authorization"));
  if (!rawToken) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  const device = await authenticateDevice(rawToken);
  if (!device) {
    console.warn(`${ts()} [box/sync] Invalid token`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof syncBodySchema>;
  try {
    body = syncBodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { state } = body;
  const now = new Date();
  const prevLocked = device.locked;

  // Determine event type from state transition
  let eventType: string | null = null;
  if (!prevLocked && state.locked) {
    eventType = "LOCKED";
  } else if (prevLocked && !state.locked) {
    const reason = state.wakeReason ?? "";
    const isLegitimate = LEGITIMATE_OPEN_REASONS.some((r) => reason.includes(r));
    eventType = isLegitimate ? "UNLOCKED" : "UNAUTHORIZED_OPEN";
  }

  // Update device state + optionally create event in a transaction
  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: device.id },
      data: {
        locked: state.locked,
        lockedSince: state.locked
          ? (state.since ? new Date(state.since) : (prevLocked ? device.lockedSince : now))
          : null,
        battery: state.battery ?? device.battery,
        boltPos: state.boltPos ?? device.boltPos,
        fwVersion: state.fwVersion ?? device.fwVersion,
        lastSyncAt: now,
        wakeReason: state.wakeReason ?? null,
        wifiSsid: state.wifiSsid  ?? null,
        wifiRssi: state.wifiRssi  ?? null,
        charging: state.charging  ?? null,
        boxIp:    state.ip        ?? null,
      },
    });

    if (eventType) {
      await tx.deviceEvent.create({
        data: {
          deviceId: device.id,
          type: eventType,
          timestamp: now,
          reason: state.wakeReason ?? null,
          battery: state.battery ?? null,
          fwVersion: state.fwVersion ?? null,
        },
      });
    }

    // Ensure LockPolicy exists
    if (!device.policy) {
      await tx.lockPolicy.create({ data: { deviceId: device.id } });
    }
  });

  // Live-Update an offene Dashboards pushen (jeder Sync ändert mind. lastSyncAt)
  notifyDeviceChange();

  // Reload policy after potential creation
  const policy = device.policy ?? await prisma.lockPolicy.findUnique({ where: { deviceId: device.id } });
  const lockUntil = effectiveLockUntil(policy, now);

  if (eventType) {
    console.log(`${ts()} [box/sync] Device "${device.name}" → ${eventType} (reason: ${state.wakeReason ?? "—"})`);
  }

  // TRACKER_SYNC stub — wire up when ready
  if (process.env.TRACKER_SYNC_ENABLED === "true" && eventType) {
    // TODO: push event to chastitytracker.ch
  }

  // Server-Pull-OTA: Zielversion ≠ gemeldeter FW → Box zieht die neue Bin.
  const targetVersion = await getTargetVersion();
  const otaPending = !!targetVersion && targetVersion !== state.fwVersion;

  return NextResponse.json({
    name: device.name,
    lockUntil: lockUntil?.toISOString() ?? null,
    offlineOpenHours: policy?.offlineOpenHours ?? 24,
    timeUTC: now.toISOString(),
    otaVersion: otaPending ? targetVersion : null,
    otaUrl: otaPending ? `${process.env.NEXTAUTH_URL ?? ""}/api/box/firmware` : null,
    commands: [],
  });
}
