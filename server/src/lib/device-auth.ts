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

  for (const device of devices) {
    const match = await bcrypt.compare(normalized, device.tokenHash);
    if (match) return device as DeviceWithPolicy;
  }

  return null;
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

/** Compute the effective lockUntil the box should receive, capped by hardCapHours. */
export function effectiveLockUntil(
  policy: LockPolicy | null,
  now: Date
): Date | null {
  if (!policy?.lockUntil) return null;

  let until = policy.lockUntil;

  if (policy.hardCapHours != null) {
    const cap = new Date(now.getTime() + policy.hardCapHours * 60 * 60 * 1000);
    if (until > cap) until = cap;
  }

  // Don't return a lockUntil that's already in the past
  if (until <= now) return null;

  return until;
}
