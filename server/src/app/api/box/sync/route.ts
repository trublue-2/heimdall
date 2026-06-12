import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateDevice, extractBearerToken, effectiveLockUntil } from "@/lib/device-auth";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { getTargetVersion, getFirmwareSig } from "@/lib/firmware";

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
  knownSsids: z.array(z.string().max(64)).max(16).optional(), // WLANs, die die Box kennt
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

  // lockedSince server-autoritativ: beim Übergang offen→zu auf Server-"jetzt" setzen,
  // danach stabil halten. Der Box-gemeldete `since` wird NICHT vertraut (sonst könnte
  // die Box ihren HardCap-Anker manipulieren — der Cap rechnet ab lockedSince).
  const newLockedSince = state.locked ? (prevLocked ? device.lockedSince : now) : null;

  // Determine event type from state transition
  let eventType: string | null = null;
  if (!prevLocked && state.locked) {
    eventType = "LOCKED";
  } else if (prevLocked && !state.locked) {
    // Exact-Match: Unbekanntes/abweichendes wakeReason → UNAUTHORIZED_OPEN (Safety:
    // im Zweifel Tamper). Substring war spoofbar ("button_x" → fälschlich legitim).
    const reason = state.wakeReason ?? "";
    const isLegitimate = LEGITIMATE_OPEN_REASONS.includes(reason);
    eventType = isLegitimate ? "UNLOCKED" : "UNAUTHORIZED_OPEN";
  }

  // Update device state + optionally create event in a transaction
  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: device.id },
      data: {
        locked: state.locked,
        lockedSince: newLockedSince,
        battery: state.battery ?? device.battery,
        boltPos: state.boltPos ?? device.boltPos,
        fwVersion: state.fwVersion ?? device.fwVersion,
        lastSyncAt: now,
        wakeReason: state.wakeReason ?? null,
        wifiSsid: state.wifiSsid  ?? null,
        wifiRssi: state.wifiRssi  ?? null,
        charging: state.charging  ?? null,
        boxIp:    state.ip        ?? null,
        primarySsid: body.knownSsids?.[0] ?? device.primarySsid,
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
  const lockUntil = effectiveLockUntil(policy, newLockedSince, now);

  if (eventType) {
    console.log(`${ts()} [box/sync] Device "${device.name}" → ${eventType} (reason: ${state.wakeReason ?? "—"})`);
  }

  // TRACKER_SYNC stub — wire up when ready
  if (process.env.TRACKER_SYNC_ENABLED === "true" && eventType) {
    // TODO: push event to chastitytracker.ch
  }

  // Server-Pull-OTA: Zielversion ≠ gemeldeter FW → Box zieht die neue Bin.
  // Nur anbieten, wenn auch eine Signatur vorliegt — sonst lehnt die Box (0.1.44+)
  // sie ohnehin ab (fail-closed) und würde jeden Sync sinnlos die Bin laden.
  const [targetVersion, otaSig] = await Promise.all([getTargetVersion(), getFirmwareSig()]);
  const otaPending = !!targetVersion && targetVersion !== state.fwVersion && !!otaSig;

  // Multi-WLAN: Passwort nullen, sobald die Box die SSID als bekannt meldet
  // (= ausgeliefert). Danach nur noch nicht-ausgelieferte Netze schicken.
  const knownSsids = body.knownSsids ?? [];
  if (knownSsids.length) {
    await prisma.wifiNetwork.updateMany({
      where: { deviceId: device.id, ssid: { in: knownSsids }, password: { not: null } },
      data: { password: null },
    });
  }
  const pendingNets = await prisma.wifiNetwork.findMany({
    where: { deviceId: device.id, password: { not: null } },
    select: { ssid: true, password: true },
  });

  return NextResponse.json({
    name: device.name,
    lockUntil: lockUntil?.toISOString() ?? null,
    offlineOpenHours: policy?.offlineOpenHours ?? 24,
    hardCapHours: policy?.hardCapHours ?? 0, // lokal als absolute Obergrenze enforced

    timeUTC: now.toISOString(),
    otaVersion: otaPending ? targetVersion : null,
    otaUrl: otaPending ? `${process.env.NEXTAUTH_URL ?? ""}/api/box/firmware` : null,
    otaSig: otaPending ? otaSig : null,
    wifiNetworks: pendingNets.map((n) => ({ ssid: n.ssid, pass: n.password })),
    commands: [],
  });
}
