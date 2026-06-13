import { prisma } from "@/lib/prisma";
import type { LockPolicy } from "@prisma/client";

// Brücke Heimdall-Server → chastitytracker.ch (Maschinen-Auth via Shared-Secret).
// Multi-tenant: jede Box zeigt auf EINE TrackerInstance {baseUrl, apiKey} — es gibt kein
// globales Tracker-Env mehr. Die Box kennt den Tracker nicht; nur der Server spricht ihn an.
// Alle Aufrufe sind no-op/null bei fehlender Instanz und dürfen den Box-Sync NIE brechen
// (Safety > Function): Fehler werden gefangen, kurzer Timeout.

const TIMEOUT_MS = 3000;

// baseUrl wird beim Anlegen der Instanz ohne Trailing-Slash gespeichert.
type Target = { baseUrl: string; apiKey: string };

async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export type TrackerConfig = {
  sperrzeit: { endetAt: string | null; indefinite: boolean; reinigungErlaubt: boolean } | null;
};

/** Absicht ziehen + in die Policy falten: aktive Keyholder-Sperrzeit → trackerLockUntil /
 *  trackerSimpleLock. Schreibt NUR bei Änderung (Steady-State-Sync = kein DB-Write). Ohne
 *  Instanz/Mapping oder bei Fehler/Timeout bleibt die Policy unverändert. Gibt sie zurück. */
export async function syncTrackerIntent(
  device: { id: string; trackerUsername: string | null },
  instance: Target | null,
  policy: LockPolicy | null
): Promise<LockPolicy | null> {
  if (!policy || !device.trackerUsername || !instance) return policy;
  const cfg = await fetchTrackerConfig(instance, device.trackerUsername);
  if (!cfg) return policy;

  const sz = cfg.sperrzeit;
  const trackerLockUntil = sz?.endetAt && !sz.indefinite ? new Date(sz.endetAt) : null;
  const trackerSimpleLock = sz?.indefinite ?? false;

  const unchanged =
    (policy.trackerLockUntil?.getTime() ?? null) === (trackerLockUntil?.getTime() ?? null) &&
    policy.trackerSimpleLock === trackerSimpleLock;
  if (unchanged) return policy;

  return prisma.lockPolicy.update({
    where: { deviceId: device.id },
    data: { trackerLockUntil, trackerSimpleLock },
  });
}

/** Absicht ziehen: aktive Keyholder-Sperrzeit für den gemappten Tracker-User auf einer Instanz. */
async function fetchTrackerConfig(target: Target, username: string): Promise<TrackerConfig | null> {
  try {
    const r = await withTimeout(
      `${target.baseUrl}/api/integration/box/config?username=${encodeURIComponent(username)}`,
      { headers: { authorization: `Bearer ${target.apiKey}` } }
    );
    if (!r.ok) return null;
    return (await r.json()) as TrackerConfig;
  } catch {
    return null;
  }
}

/** Fakten pushen: ein realer Box-Übergang als Spur 2 (Hardware-Wahrheit) an eine Instanz. */
export async function pushBoxEvent(
  target: Target,
  p: {
    username: string;
    deviceName?: string | null;
    type: string;
    wakeReason?: string | null;
    battery?: number | null;
    fwVersion?: string | null;
    at: Date;
  }
): Promise<void> {
  try {
    await withTimeout(`${target.baseUrl}/api/integration/box/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        username: p.username,
        deviceName: p.deviceName ?? undefined,
        type: p.type,
        wakeReason: p.wakeReason ?? undefined,
        battery: p.battery ?? undefined,
        fwVersion: p.fwVersion ?? undefined,
        at: p.at.toISOString(),
      }),
    });
  } catch {
    // Tracker-Ausfall darf den Box-Sync nie beeinträchtigen — bewusst verschluckt.
  }
}
