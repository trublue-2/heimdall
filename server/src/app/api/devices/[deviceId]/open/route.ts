import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireDeviceAccess } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { effectiveLockUntil } from "@/lib/device-auth";
import { notifyDeviceChange } from "@/lib/events";
import { publishCommand } from "@/lib/mqttBridge";

const openSchema = z.object({
  password: z.string().max(128).optional(),
  confirmEarly: z.boolean().optional(),
});

// Öffnen. Setzt pendingOpenReason als Marker für das nächste Box-Sync-Event:
//   "early"  → EARLY_OPEN (vorzeitig ohne Passwort, dokumentiert)
//   "silent" → kein Event (Passwort korrekt / Simple-Lock / bereits abgelaufen)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await params;
  const { response } = await requireDeviceAccess(deviceId);
  if (response) return response;

  const parsed = openSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  const { password, confirmEarly } = parsed.data;

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    include: { policy: true },
  });
  if (!device) return NextResponse.json({ error: "Gerät nicht gefunden" }, { status: 404 });

  const now = new Date();
  const policy = device.policy;
  const timedActive = effectiveLockUntil(policy, now) !== null;
  const hasPassword = !!policy?.openPasswordHash;

  let reason: "early" | "silent" = "silent";

  if (policy?.simpleLock) {
    // Einfach-Lock: jederzeit lautlos öffnen.
    reason = "silent";
  } else if (timedActive) {
    if (hasPassword) {
      if (!password || !(await bcrypt.compare(password, policy!.openPasswordHash!))) {
        return NextResponse.json(
          { error: "Passwort falsch", needsPassword: true },
          { status: 403 }
        );
      }
      reason = "silent"; // mit korrektem Passwort = autorisiert, kein Eintrag
    } else {
      // Kein Passwort → vorzeitiges Öffnen muss bestätigt werden, wird dokumentiert UND aus dem
      // Notöffnungs-Kontingent gedeckt sein. Kontingent leer → blockiert (nur Keyholderin/Failsafes).
      if (!confirmEarly) {
        return NextResponse.json({ needsConfirm: true }, { status: 409 });
      }
      if (device.emergencyOpensLeft <= 0) {
        return NextResponse.json(
          { error: "Keine Notöffnungen mehr übrig — nur die Keyholderin oder die Failsafes öffnen.", noEmergencyLeft: true },
          { status: 409 }
        );
      }
      reason = "early";
    }
  }
  // sonst (nicht gesperrt / bereits abgelaufen): einfach öffnen, kein Event.

  await prisma.$transaction([
    // Policy nur leeren, wenn vorhanden (nie-gesperrtes Gerät hat keine).
    ...(policy
      ? [prisma.lockPolicy.update({
          where: { deviceId },
          data: { lockUntil: null, simpleLock: false, openPasswordHash: null },
        })]
      : []),
    prisma.device.update({
      where: { id: deviceId },
      data: {
        pendingOpenReason: reason,
        ...(reason === "early" ? { emergencyOpensLeft: { decrement: 1 } } : {}),
      },
    }),
  ]);

  notifyDeviceChange();
  // Physisch öffnen NUR, wenn die Box aktuell zu ist. Ist sie schon offen (z.B. nach einem
  // Failsafe-Open — hier wird dann nur die Policy geleert), KEIN "open" senden: sonst fährt der
  // Stepper (open-loop, kein Endlagensensor) weiter gegen den mechanischen Anschlag → Motorschaden.
  if (device.locked) publishCommand(deviceId, "open"); // Sofort-Push, falls die Box im Wachfenster verbunden ist
  return NextResponse.json({ ok: true });
}
