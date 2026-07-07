import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateDevice, extractBearerToken, effectiveLockUntil, boxLocked, deviceLockView } from "@/lib/device-auth";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";
import { getTargetVersion, getFirmwareSig } from "@/lib/firmware";
import { syncTrackerIntent, pushBoxEvent, pushBoxStatus } from "@/lib/trackerClient";

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
    mac: z.string().max(32).optional(),
  }),
  knownSsids: z.array(z.string().max(64)).max(16).optional(), // WLANs, die die Box kennt
  logs: z.string().max(8000).optional(), // serielles Log (newline-getrennt), nur bei logToServer
});

const LOG_RETENTION = 2000; // je Gerät gespeicherte Log-Zeilen (ältere werden geprunt)

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
    // Vom Menschen ausgelöste Öffnung? pendingOpenReason koppelt die Server-Aktion an
    // genau dieses Box-Event: "early" → dokumentieren, "silent" → kein Eintrag.
    if (device.pendingOpenReason === "early") {
      eventType = "EARLY_OPEN";
    } else if (device.pendingOpenReason === "tracker") {
      eventType = "UNLOCKED"; // vom Sub im Tracker ausgelöstes Öffnen (eigene "ohne Zeit"-Sperre)
    } else if (device.pendingOpenReason === "cleaning") {
      eventType = "CLEAN_OPEN"; // Reinigungspause aus dem Tracker (Sperrzeit bleibt, Re-Lock-Frist läuft)
    } else if (device.pendingOpenReason === "silent") {
      eventType = null; // Passwort-Öffnung / Simple-Lock / abgelaufen → kein Eintrag
    } else {
      // Box hat selbst geöffnet (Button/Failsafe/Tamper). Exact-Match: Unbekanntes
      // wakeReason → UNAUTHORIZED_OPEN (Safety: im Zweifel Tamper).
      const reason = state.wakeReason ?? "";
      eventType = LEGITIMATE_OPEN_REASONS.includes(reason) ? "UNLOCKED" : "UNAUTHORIZED_OPEN";
    }
  }
  // Marker ist einmalig — bei jedem Lock-Wechsel verbrauchen/verwerfen.
  const clearMarker = prevLocked !== state.locked;

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
        mac:      state.mac       ?? device.mac,
        primarySsid: body.knownSsids?.[0] ?? device.primarySsid,
        pendingOpenReason: clearMarker ? null : device.pendingOpenReason,
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
  let policy = device.policy ?? await prisma.lockPolicy.findUnique({ where: { deviceId: device.id } });

  // Tracker-Anbindung (P1): die gemappte Instanz nur hier laden (nicht in authenticateDevice,
  // sonst läge das apiKey jeder Box bei jeder Auth im Speicher). Realen Übergang als Spur 2
  // pushen (fire-and-forget); trackerClient fängt alle Fehler/Timeouts — der Sync hängt nie daran.
  const trackerInstance =
    device.trackerSync && device.trackerInstanceId
      ? await prisma.trackerInstance.findUnique({ where: { id: device.trackerInstanceId } })
      : null;
  if (eventType && device.trackerUsername && trackerInstance) {
    void pushBoxEvent(trackerInstance, {
      username: device.trackerUsername,
      type: eventType,
      wakeReason: state.wakeReason,
      battery: state.battery,
      fwVersion: state.fwVersion,
      at: now,
    });
  }

  // Keyholder-Sperrzeit ziehen (Absicht → trackerLockUntil, greift via Hybrid-Regel in
  // effectiveLockUntil) parallel zu den OTA-Reads — kein serieller Remote-Call vor der Antwort.
  const [policyAfterTracker, targetVersion, otaSig] = await Promise.all([
    syncTrackerIntent(device, trackerInstance, policy),
    getTargetVersion(),
    getFirmwareSig(),
  ]);
  policy = policyAfterTracker;

  // Live-Box-Status an den Tracker pushen (für die Box-Anzeige dort) und ein vom Sub im
  // Tracker ausgelöstes Kommando ziehen (consume-on-read) + anwenden — VOR der lockUntil-
  // Berechnung, damit die Box das Kommando schon in DIESER Sync-Antwort vollzieht.
  if (trackerInstance && device.trackerUsername && policy) {
    const view = deviceLockView(policy, newLockedSince, now);
    const cmd = await pushBoxStatus(trackerInstance, {
      username: device.trackerUsername,
      boxId: device.id,
      name: device.name,
      locked: boxLocked(policy, newLockedSince, now),
      lockUntil: view.lockUntil,
      simpleLock: view.simpleLock,
      keyholderLocked: view.keyholderLocked,
      battery: state.battery ?? device.battery,
      charging: state.charging,
      boltPos: state.boltPos,
      fwVersion: state.fwVersion ?? device.fwVersion,
      lastSyncAt: now,
    });
    // "lock" → Simple-Lock (zu, ohne Zeit). "open" → eigene Sperre lösen (Simple-Lock + lockUntil);
    // eine Tracker-Sperrzeit (trackerLockUntil) bleibt unangetastet → bindet weiter (nicht Sub-Hoheit).
    // "clean_open" → Reinigungspause: temporär offen bis relockBy, Sperrzeit bleibt.
    if (cmd?.pendingCommand === "lock") {
      // Re-Lock während einer Reinigungspause → nur die Pause beenden (Sperrzeit lebt weiter),
      // KEIN simpleLock (sonst bliebe die Box nach Sperrzeit-Ablauf fälschlich „ohne Zeit" zu).
      policy = policy?.cleaningUntil
        ? await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { cleaningUntil: null } })
        : await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { simpleLock: true } });
    } else if (cmd?.pendingCommand === "open") {
      policy = await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { simpleLock: false, lockUntil: null } });
      await prisma.device.update({ where: { id: device.id }, data: { pendingOpenReason: "tracker" } });
    } else if (cmd?.pendingCommand === "clean_open") {
      const relockBy = cmd.relockBy ? new Date(cmd.relockBy) : null;
      policy = await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { cleaningUntil: relockBy } });
      await prisma.device.update({ where: { id: device.id }, data: { pendingOpenReason: "cleaning" } });
    }
  }

  const lockUntil = effectiveLockUntil(policy, newLockedSince, now);

  if (eventType) {
    console.log(`${ts()} [box/sync] Device "${device.name}" → ${eventType} (reason: ${state.wakeReason ?? "—"})`);
  }

  // Server-Pull-OTA: Zielversion ≠ gemeldeter FW → Box zieht die neue Bin.
  // Nur anbieten, wenn auch eine Signatur vorliegt — sonst lehnt die Box (0.1.44+)
  // sie ohnehin ab (fail-closed) und würde jeden Sync sinnlos die Bin laden.
  // otaDisabled = Server-seitiger Freeze: OTA-Felder weglassen → Box hat nichts zu flashen.
  // Wirkt sofort (auch auf bestehender Firmware); die Signaturprüfung bleibt die Schutzgrenze.
  const otaPending = !!targetVersion && targetVersion !== state.fwVersion && !!otaSig && !device.otaDisabled;

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

  // Serielles Log anhängen (nur bei aktivem logToServer): Zeilen splitten, speichern,
  // dann je Gerät auf die letzten LOG_RETENTION prunen (Verlauf bleibt beschränkt).
  if (device.logToServer && body.logs) {
    const lines = body.logs
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(-500); // Sicherheitskappe pro Sync
    if (lines.length) {
      await prisma.deviceLog.createMany({ data: lines.map((line) => ({ deviceId: device.id, line })) });
      // Retention ist weich (~2000). Nicht jeden Sync prunen — das spart auf dem Hot-Path
      // den skip:LOG_RETENTION-Indexscan; ~1-in-10 reicht, kurze Drift ist unkritisch.
      if (Math.random() < 0.1) {
        const cutoff = await prisma.deviceLog.findFirst({
          where: { deviceId: device.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
          skip: LOG_RETENTION,
        });
        if (cutoff) {
          await prisma.deviceLog.deleteMany({
            where: { deviceId: device.id, createdAt: { lt: cutoff.createdAt } },
          });
        }
      }
    }
  }

  return NextResponse.json({
    name: device.name,
    locked: boxLocked(policy, newLockedSince, now), // autoritativ: Simple-Lock ODER aktive Zeit
    lockUntil: lockUntil?.toISOString() ?? null,
    offlineOpenHours: policy?.offlineOpenHours ?? 24,
    hardCapHours: policy?.hardCapHours ?? 0, // lokal als absolute Obergrenze enforced

    timeUTC: now.toISOString(),
    otaVersion: otaPending ? targetVersion : null,
    otaUrl: otaPending ? `${process.env.NEXTAUTH_URL ?? ""}/api/box/firmware` : null,
    otaSig: otaPending ? otaSig : null,
    debugMode: device.debugMode, // Box bleibt wach + serviert lokale Debug-Seite
    logToServer: device.logToServer, // Box schickt ihr serielles Log bei jedem Sync mit
    wifiNetworks: pendingNets.map((n) => ({ ssid: n.ssid, pass: n.password })),
    preferredSsid: device.preferredSsid ?? null, // Server-Präferenz (Box gewinnt-lassen); null = Box behält lokale Wahl
    commands: [],
  });
}
