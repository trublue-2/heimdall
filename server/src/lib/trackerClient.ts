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

/** Die Absicht des Trackers, mehr nicht. Kein Reinigungs-Begriff: ob eine Öffnung erlaubt ist,
 *  entscheidet der Tracker und schickt daraufhin ein `open`. Heimdall darf das nicht nachrechnen —
 *  zwei Regelwerke über dieselbe Frage laufen auseinander. */
export type TrackerConfig = {
  sperrzeit: { endetAt: string | null; indefinite: boolean } | null;
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
    if (!r.ok) {
      console.warn(`[trackerClient] fetchTrackerConfig → HTTP ${r.status} (${target.baseUrl})`);
      return null;
    }
    return (await r.json()) as TrackerConfig;
  } catch (e) {
    console.warn(`[trackerClient] fetchTrackerConfig fehlgeschlagen: ${(e as Error).message}`);
    return null;
  }
}

/** Fakten pushen: ein realer Box-Übergang als Spur 2 (Hardware-Wahrheit) an eine Instanz. */
export async function pushBoxEvent(
  target: Target,
  p: {
    username: string;
    type: string;
    wakeReason?: string | null;
    battery?: number | null;
    fwVersion?: string | null;
    at: Date;
  }
): Promise<void> {
  try {
    const r = await withTimeout(`${target.baseUrl}/api/integration/box/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        username: p.username,
        type: p.type,
        wakeReason: p.wakeReason ?? undefined,
        battery: p.battery ?? undefined,
        fwVersion: p.fwVersion ?? undefined,
        at: p.at.toISOString(),
      }),
    });
    // Fehler nie still verschlucken — sonst gehen Fakten unsichtbar verloren (z.B. falscher
    // deviceName → 404). Der Box-Sync bleibt davon unberührt (kein throw).
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[trackerClient] pushBoxEvent ${p.type} → HTTP ${r.status} ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[trackerClient] pushBoxEvent ${p.type} fehlgeschlagen: ${(e as Error).message}`);
  }
}

export type BoxCommand = { pendingCommand: string | null };

/** Live-Status pushen: der aktuelle Box-Zustand (Soll-Sperre + Telemetrie) an eine Instanz,
 *  damit der Tracker die Box anzeigen kann. Quittiert ein erledigtes Kommando (lastAppliedCommand)
 *  und liefert das aktuell anstehende zurück. Fehler werden geloggt, nie verschluckt. */
export async function pushBoxStatus(
  target: Target,
  p: {
    username: string;
    boxId: string;
    name: string;
    locked: boolean;
    /** Physisches IST: hat die Box sich in DIESEM Sync als zu gemeldet? `locked` ist das SOLL
     *  (boxLocked) — seit dem Präsenz-Guard kann die Box offen stehen, obwohl sie zu sein soll
     *  (wartet auf Knopf/USB). Der Tracker braucht das IST für ein ehrliches hardwareEnforced. */
    reportedLocked: boolean;
    lockUntil: Date | null;
    simpleLock: boolean;
    keyholderLocked: boolean;
    battery?: number | null;
    charging?: boolean | null;
    boltPos?: string | null;
    fwVersion?: string | null;
    lastSyncAt: Date | null;
    /** Offline-Failsafe-Schwelle (Stunden ohne Sync → Box öffnet selbst). Der Tracker braucht sie,
     *  um `staleLock`/`hardwareEnforced` ehrlich zu berechnen — sie ist KEIN Lock-View-Wert. */
    offlineOpenHours: number;
    lastAppliedCommand?: string;
  }
): Promise<BoxCommand | null> {
  try {
    const r = await withTimeout(`${target.baseUrl}/api/integration/box/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        username: p.username,
        boxId: p.boxId,
        name: p.name,
        locked: p.locked,
        reportedLocked: p.reportedLocked,
        lockUntil: p.lockUntil?.toISOString() ?? null,
        simpleLock: p.simpleLock,
        keyholderLocked: p.keyholderLocked,
        battery: p.battery ?? undefined,
        charging: p.charging ?? undefined,
        boltPos: p.boltPos ?? undefined,
        fwVersion: p.fwVersion ?? undefined,
        lastSyncAt: p.lastSyncAt?.toISOString() ?? null,
        offlineOpenHours: p.offlineOpenHours,
        lastAppliedCommand: p.lastAppliedCommand,
      }),
    });
    if (!r.ok) {
      console.warn(`[trackerClient] pushBoxStatus → HTTP ${r.status}`);
      return null;
    }
    return (await r.json()) as BoxCommand;
  } catch (e) {
    console.warn(`[trackerClient] pushBoxStatus fehlgeschlagen: ${(e as Error).message}`);
    return null;
  }
}
