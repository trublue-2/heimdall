import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import type { Device, LockPolicy } from "@prisma/client";

export type DeviceWithPolicy = Device & { policy: LockPolicy | null };

export async function authenticateDevice(
  rawToken: string
): Promise<DeviceWithPolicy | null> {
  if (!rawToken || rawToken.length > 128) return null;

  // Strip dashes so XK7F-M2PQ-9TRW-4VNB and XK7FM2PQ9TRW4VNB both work
  const normalized = rawToken.replace(/-/g, "").toUpperCase();

  const devices = await prisma.device.findMany({
    include: { policy: true },
  });

  const now = new Date();
  for (const device of devices) {
    if (await bcrypt.compare(normalized, device.tokenHash)) {
      // Neuer Token bestätigt → Grace-Token sofort entwerten (nicht erst nach 1 h).
      if (device.prevTokenHash) {
        await prisma.device.update({
          where: { id: device.id },
          data: { prevTokenHash: null, prevTokenExpiry: null },
        });
      }
      return device as DeviceWithPolicy;
    }
    // Grace: vorheriger Token noch innerhalb des Gültigkeitsfensters akzeptieren.
    if (
      device.prevTokenHash &&
      device.prevTokenExpiry &&
      device.prevTokenExpiry > now &&
      (await bcrypt.compare(normalized, device.prevTokenHash))
    ) {
      return device as DeviceWithPolicy;
    }
  }

  return null;
}

/**
 * Auth für eine BEKANNTE deviceId (MQTT: username=deviceId, password=token). O(1) statt
 * des Token-Scans über alle Geräte — dieselbe Normalisierung + Grace-Token-Logik wie
 * authenticateDevice, nur gezielt per findUnique. Kein Grace-Invalidierungs-Write (nicht nötig).
 */
export async function authenticateDeviceById(
  deviceId: string,
  rawToken: string
): Promise<boolean> {
  if (!rawToken || rawToken.length > 128) return false;
  const normalized = rawToken.replace(/-/g, "").toUpperCase();

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return false;

  if (await bcrypt.compare(normalized, device.tokenHash)) return true;
  // Grace: vorheriger Token noch im Gültigkeitsfenster.
  return (
    !!device.prevTokenHash &&
    !!device.prevTokenExpiry &&
    device.prevTokenExpiry > new Date() &&
    (await bcrypt.compare(normalized, device.prevTokenHash))
  );
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

/**
 * Soll die Box (physisch) geschlossen sein? Autoritatives Signal für das Box-Protokoll:
 * Simple-Lock (ohne Zeit) ODER ein aktives, gekapptes lockUntil.
 */
export function boxLocked(
  policy: LockPolicy | null,
  lockedSince: Date | null,
  now: Date
): boolean {
  // Reinigungspause: bis cleaningUntil darf die Box trotz Sperrzeit offen sein. Öffnet nur
  // FRÜHER (sichere Richtung), danach greift die Sperre wieder. hardCap/Failsafes unberührt.
  if (policy?.cleaningUntil && policy.cleaningUntil > now) return false;
  return (
    !!policy?.simpleLock ||
    !!policy?.trackerSimpleLock ||
    effectiveLockUntil(policy, lockedSince, now) !== null
  );
}

/**
 * Ist das Gerät in einer aktiven Session? Während Verschluss dürfen Server/Token
 * und User-Zuweisung nicht geändert werden (kein Mid-Session-Takeover).
 * Session = ab Sperr-Zeitpunkt (Simple-Lock oder effektives lockUntil), nicht erst
 * ab physischem Schliessen — schliesst das Renn-Fenster "sperren → schnell tauschen".
 */
export async function isDeviceLocked(deviceId: string): Promise<boolean> {
  const d = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { locked: true, lockedSince: true, policy: true },
  });
  if (!d) return false;
  return d.locked || boxLocked(d.policy, d.lockedSince, new Date());
}

/**
 * Effektives lockUntil für die Box, gekappt durch hardCapHours.
 * HardCap ist eine absolute Obergrenze AB VERSCHLIESSEN (lockedSince) — nicht ab
 * "jetzt". Sonst würde der Cap bei jedem Sync mitgleiten und nie ablaufen.
 * 0/null = kein Cap. Ist die Box noch nicht zu (lockedSince null), wird ab jetzt
 * gerechnet (der Lock beginnt gleich; die Firmware enforced ohnehin lokal ab Lock).
 */
export function effectiveLockUntil(
  policy: LockPolicy | null,
  lockedSince: Date | null,
  now: Date
): Date | null {
  // Hybrid: Heimdall-eigene Zeit UND aus dem Tracker gezogene Sperrzeit — die
  // strengere (spätere) gewinnt. hardCap kappt das Ergebnis IMMER, der Tracker kann
  // also nie über die absolute Obergrenze hinaus verlängern (Safety-Invariante).
  let until = policy?.lockUntil ?? null;
  const tracker = policy?.trackerLockUntil ?? null;
  if (tracker && (!until || tracker > until)) until = tracker;
  if (!until) return null;

  const hardCapHours = policy?.hardCapHours ?? 0;
  if (hardCapHours > 0) {
    const anchor = lockedSince ?? now;
    const cap = new Date(anchor.getTime() + hardCapHours * 60 * 60 * 1000);
    if (until > cap) until = cap;
  }

  // Don't return a lockUntil that's already in the past
  if (until <= now) return null;

  return until;
}

/** Anzeige-Sicht für die Geräte-Karte: die EFFEKTIVE Sperre (eigene + aus dem Tracker gezogene
 *  Sperrzeit, gekappt durch hardCap) statt nur der eigenen lockUntil — damit „geschlossen bis"
 *  die real gültige Zeit zeigt, auch wenn der Tracker sie verändert hat. keyholderLocked = eine
 *  Tracker-Sperrzeit hält die Box, die der Sub lokal nicht öffnen kann (nur Keyholderin/Ablauf). */
export function deviceLockView(
  policy: LockPolicy | null,
  lockedSince: Date | null,
  now: Date
): { lockUntil: Date | null; simpleLock: boolean; keyholderLocked: boolean } {
  return {
    lockUntil: effectiveLockUntil(policy, lockedSince, now),
    simpleLock: !!policy?.simpleLock || !!policy?.trackerSimpleLock,
    keyholderLocked: !!policy?.trackerSimpleLock || !!(policy?.trackerLockUntil && policy.trackerLockUntil > now),
  };
}
