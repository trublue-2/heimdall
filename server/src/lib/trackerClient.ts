import { prisma } from "@/lib/prisma";
import type { LockPolicy } from "@prisma/client";

// Brücke Heimdall-Server → chastitytracker.ch (Maschinen-Auth via Shared-Secret).
// Die Box kennt den Tracker nicht; nur der Server spricht ihn an. Alle Aufrufe sind
// no-op/null, wenn TRACKER_URL/TRACKER_API_KEY fehlen — und dürfen den Box-Sync NIE
// brechen (Safety > Function): Fehler werden gefangen, kurzer Timeout.

const BASE = () => process.env.TRACKER_URL?.replace(/\/$/, "") ?? "";
const KEY = () => process.env.TRACKER_API_KEY ?? "";
const TIMEOUT_MS = 3000;

function configured(): boolean {
  return !!BASE() && !!KEY();
}

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
 *  trackerSimpleLock. Schreibt NUR bei Änderung (Steady-State-Sync = kein DB-Write). Bei
 *  Fehler/Timeout/keinem Mapping bleibt die Policy unverändert. Gibt die (ggf. neue) Policy zurück. */
export async function syncTrackerIntent(
  device: { id: string; trackerUserId: string | null },
  policy: LockPolicy | null
): Promise<LockPolicy | null> {
  if (!policy || !device.trackerUserId) return policy;
  const cfg = await fetchTrackerConfig(device.trackerUserId);
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

/** Absicht ziehen: aktive Keyholder-Sperrzeit für den gemappten Tracker-User. */
async function fetchTrackerConfig(trackerUserId: string): Promise<TrackerConfig | null> {
  if (!configured()) return null;
  try {
    const r = await withTimeout(
      `${BASE()}/api/integration/box/config?userId=${encodeURIComponent(trackerUserId)}`,
      { headers: { authorization: `Bearer ${KEY()}` } }
    );
    if (!r.ok) return null;
    return (await r.json()) as TrackerConfig;
  } catch {
    return null;
  }
}

/** Fakten pushen: ein realer Box-Übergang als Spur 2 (Hardware-Wahrheit). */
export async function pushBoxEvent(p: {
  trackerUserId: string;
  trackerDeviceId?: string | null;
  type: string;
  wakeReason?: string | null;
  battery?: number | null;
  fwVersion?: string | null;
  at: Date;
}): Promise<void> {
  if (!configured()) return;
  try {
    await withTimeout(`${BASE()}/api/integration/box/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY()}`, "content-type": "application/json" },
      body: JSON.stringify({
        userId: p.trackerUserId,
        deviceId: p.trackerDeviceId ?? undefined,
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
