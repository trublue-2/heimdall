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

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

/**
 * Ist das Gerät in einer aktiven Session? Während Verschluss dürfen Server/Token
 * und User-Zuweisung nicht geändert werden (kein Mid-Session-Takeover).
 * Session = ab Sperr-Zeitpunkt (effektives lockUntil gesetzt), nicht erst ab
 * physischem Schliessen — schliesst das Renn-Fenster "sperren → schnell tauschen".
 */
export async function isDeviceLocked(deviceId: string): Promise<boolean> {
  const d = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { locked: true, lockedSince: true, policy: true },
  });
  if (!d) return false;
  return d.locked || effectiveLockUntil(d.policy, d.lockedSince, new Date()) !== null;
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
  if (!policy?.lockUntil) return null;

  let until = policy.lockUntil;

  if ((policy.hardCapHours ?? 0) > 0) {
    const anchor = lockedSince ?? now;
    const cap = new Date(anchor.getTime() + policy.hardCapHours! * 60 * 60 * 1000);
    if (until > cap) until = cap;
  }

  // Don't return a lockUntil that's already in the past
  if (until <= now) return null;

  return until;
}
