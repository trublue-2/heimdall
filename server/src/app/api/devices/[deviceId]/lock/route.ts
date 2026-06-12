import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { notifyDeviceChange } from "@/lib/events";

// Verschliessen in drei Varianten. Reduziert sich serverseitig auf (lockUntil, simpleLock,
// openPasswordHash) — die Box braucht nur das daraus berechnete `locked` + lockUntil.
const lockSchema = z.discriminatedUnion("mode", [
  // Feste Zeit: bis Zeitpunkt X.
  z.object({
    mode: z.literal("fixed"),
    until: z.string().datetime(),
    password: z.string().min(1).max(128).optional(),
  }),
  // Zufallszeit: Server würfelt die Dauer zwischen min/max (Minuten).
  z.object({
    mode: z.literal("random"),
    minMinutes: z.number().int().min(1).max(525600),
    maxMinutes: z.number().int().min(1).max(525600),
    password: z.string().min(1).max(128).optional(),
  }),
  // Einfach (ohne Zeit): zu, jederzeit wieder öffenbar, kein Event. Kein Passwort.
  z.object({ mode: z.literal("simple") }),
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  const parsed = lockSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Ungültige Verschluss-Angaben" }, { status: 400 });
  }
  const body = parsed.data;
  const now = new Date();

  let lockUntil: Date | null = null;
  let simpleLock = false;
  let password: string | undefined;

  if (body.mode === "fixed") {
    lockUntil = new Date(body.until);
    if (lockUntil <= now) {
      return NextResponse.json({ error: "Zeitpunkt liegt in der Vergangenheit" }, { status: 400 });
    }
    password = body.password;
  } else if (body.mode === "random") {
    if (body.minMinutes > body.maxMinutes) {
      return NextResponse.json({ error: "Min darf nicht grösser als Max sein" }, { status: 400 });
    }
    // Server entscheidet die Dauer selbst (inkl. beider Grenzen).
    const span = body.maxMinutes - body.minMinutes + 1;
    const dur = body.minMinutes + Math.floor(Math.random() * span);
    lockUntil = new Date(now.getTime() + dur * 60_000);
    password = body.password;
  } else {
    simpleLock = true; // ohne Zeit
  }

  const openPasswordHash = password ? await bcrypt.hash(password, 10) : null;

  const data = { lockUntil, simpleLock, openPasswordHash };
  await prisma.$transaction([
    prisma.lockPolicy.upsert({
      where: { deviceId },
      create: { deviceId, ...data },
      update: data,
    }),
    // Frischer Lock → alten Öffnungs-Marker verwerfen.
    prisma.device.update({ where: { id: deviceId }, data: { pendingOpenReason: null } }),
  ]);

  notifyDeviceChange();
  return NextResponse.json({ ok: true });
}
