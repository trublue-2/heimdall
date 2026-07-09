import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { extractBearerToken, boxLocked, effectiveLockUntil } from "@/lib/device-auth";
import { publishCommand, deviceOnline } from "@/lib/mqttBridge";
import { notifyDeviceChange } from "@/lib/events";
import { syncTrackerIntent } from "@/lib/trackerClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Instant-Push VOM Tracker: ein box-relevanter Zustand hat sich geändert (Verschluss-/Öffnen-Eintrag
// oder Sperrzeit gesetzt/geändert/zurückgezogen). Bisher erfuhr Heimdall das erst beim nächsten
// Box-Sync (Pull). Jetzt zieht der Tracker aktiv hier an, und wir (1) holen die Config frisch → die
// Policy (trackerLockUntil/trackerSimpleLock) stimmt sofort, (2) pushen ein evtl. Kommando direkt an
// eine LIVE Box per MQTT. Fallback bleibt der pendingCommand-/Config-Pull beim nächsten Box-Sync.
//
// Auth = TrackerInstance.apiKey als Bearer — derselbe Shared-Secret-Kanal wie outbound, nur rückwärts.
const schema = z.object({
  username: z.string().min(1),
  command: z.enum(["lock", "open"]).optional(),
});

export async function POST(req: NextRequest) {
  const token = extractBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const instance = await prisma.trackerInstance.findUnique({ where: { apiKey: token } });
  if (!instance) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Alle Boxen dieses Tracker-Users auf DIESER Instanz (ein User kann mehrere gemappte Boxen haben).
  const devices = await prisma.device.findMany({
    where: { trackerInstanceId: instance.id, trackerUsername: body.username, trackerSync: true },
    include: { policy: true },
  });

  const now = new Date();
  for (const device of devices) {
    // (1) Config frisch ziehen → aktualisierte Policy zurück (z.B. Rückzug: trackerLockUntil → null).
    //     Bei Fehler die alte Policy behalten (konservativ: lieber NICHT öffnen als fälschlich).
    const policy = await syncTrackerIntent(device, instance, device.policy).catch(() => device.policy);

    if (body.command && deviceOnline(device.id)) {
      // (2) Kommando sofort an die LIVE Box. "lock" ist immer sicher. "open" NUR, wenn die frisch
      //     gesyncte Policy KEINE Sperre mehr verlangt (weder Heimdall-eigen noch Tracker — boxLocked
      //     ist die autoritative Prüfung) UND die Box physisch zu ist (Stepper-Schutz: open-loop, kein
      //     Endlagensensor → nicht gegen den Anschlag fahren; siehe devices/[id]/open).
      if (body.command === "lock") {
        publishCommand(device.id, "lock");
      } else if (device.locked && !boxLocked(policy, now)) {
        publishCommand(device.id, "open");
      }
    } else if (
      !body.command && device.locked && policy &&
      // KEINE Sperr-Absicht mehr aktiv — bewusst NICHT boxLocked() (das gibt während einer
      // Reinigungspause false zurück, obwohl die Sperre lebt → würde die befristete Sperre fälschlich
      // in einen unbefristeten simpleLock verwandeln und im Open-Route ein passwortloses Öffnen erlauben;
      // vgl. den Guard in box/sync/route.ts). Präzise: kein own/tracker-simpleLock, keine effektive
      // Timed-Sperre, keine aktive Reinigungspause.
      !policy.simpleLock && !policy.trackerSimpleLock &&
      effectiveLockUntil(policy, now) === null &&
      !(policy.cleaningUntil && policy.cleaningUntil > now)
    ) {
      // (3) Reine Config-Änderung ohne Kommando (z.B. Sperrzeit-RÜCKZUG): keine Sperre mehr aktiv, die
      //     Box aber physisch noch zu → in einen eigenen Simple-Lock überführen. Dann zeigt die Anzeige
      //     "GESCHLOSSEN, ohne Zeitlimit (jederzeit öffenbar)" statt fälschlich "WIRD GEÖFFNET" (die Box
      //     federt nie autonom auf; der Sub öffnet auf Knopfdruck). Gilt für live UND schlafende Box.
      await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { simpleLock: true } });
    }
  }
  if (devices.length > 0) notifyDeviceChange();

  return NextResponse.json({ ok: true, devices: devices.length });
}
