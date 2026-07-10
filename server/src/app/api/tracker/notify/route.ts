import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { extractBearerToken, boxLocked, shouldHoldClosedOnTrackerEnd } from "@/lib/device-auth";
import { applyTrackerCommand } from "@/lib/boxCommand";
import { publishCommand, deviceOnline } from "@/lib/mqttBridge";
import { notifyDeviceChange } from "@/lib/events";
import { syncTrackerIntent } from "@/lib/trackerClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Instant-Push VOM Tracker: ein box-relevanter Zustand hat sich geändert (Verschluss-/Öffnen-Eintrag
// oder Sperrzeit gesetzt/geändert/zurückgezogen). Bisher erfuhr Heimdall das erst beim nächsten
// Box-Sync (Pull). Jetzt zieht der Tracker aktiv hier an, und wir (1) holen die Config frisch → die
// Policy (trackerLockUntil/trackerSimpleLock) stimmt sofort, (2) wenden ein evtl. Kommando an und
// pushen es einer LIVE Box per MQTT. Fallback bleibt der pendingCommand-/Config-Pull beim nächsten
// Box-Sync — der dasselbe applyTrackerCommand fährt, also nie abweicht.
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

  if (devices.length === 0) {
    // Der Aufruf war erfolgreich und hat trotzdem nichts getan: kein Gerät ist auf diesen
    // Tracker-User gemappt (oder trackerSync ist aus). Sonst bliebe das folgenlos still.
    console.warn(`[tracker/notify] keine gemappte Box für den angefragten Tracker-User (${instance.baseUrl})`);
  }

  const now = new Date();
  for (const device of devices) {
    // (1) Config frisch ziehen → aktualisierte Policy zurück (z.B. Rückzug: trackerLockUntil → null).
    //     Bei Fehler die alte Policy behalten (konservativ: lieber NICHT öffnen als fälschlich).
    let policy = await syncTrackerIntent(device, instance, device.policy).catch(() => device.policy);

    if (body.command && policy && deviceOnline(device.id)) {
      // (2) Kommando auf die Policy anwenden und SOFORT an die LIVE Box pushen. Das Anwenden muss
      //     VOR der Prüfung unten stehen: `open` setzt einen laufenden Dauerauftrag aus (holdOpen),
      //     sonst meldete boxLocked() weiter „zu" und der Guard unterdrückte den Push.
      //
      //     NUR für die live Box. Eine schlafende bekommt dasselbe Kommando beim nächsten Box-Sync
      //     über `pendingCommand` — durch dieselbe Funktion, also nie abweichend. Hier vorab zu
      //     schreiben brächte nichts und bewaffnete `pendingOpenReason` für eine Öffnung, die gar
      //     nicht stattfindet: ein späterer Aufbruch würde als reguläres Öffnen protokolliert.
      policy = await applyTrackerCommand(device.id, body.command, policy, now);

      // "lock" ist immer sicher. "open" NUR, wenn die Policy jetzt keine Sperre mehr verlangt
      // (boxLocked ist die autoritative Prüfung) UND die Box physisch zu ist (Stepper-Schutz:
      // open-loop, kein Endlagensensor → nicht gegen den Anschlag fahren).
      if (body.command === "lock") {
        publishCommand(device.id, "lock");
        console.log(`[tracker/notify] "${device.name}" → lock (MQTT)`);
      } else if (device.locked && !boxLocked(policy, now)) {
        publishCommand(device.id, "open");
        console.log(`[tracker/notify] "${device.name}" → open (MQTT)`);
      }
    } else if (body.command) {
      // Kommando da, Box aber nicht im Wachfenster (Deep-Sleep, kein MQTT). Sie zieht es beim
      // nächsten Sync — für den Sub sieht das aus wie „passiert erst auf Knopfdruck". Sichtbar machen.
      console.log(`[tracker/notify] "${device.name}" schläft → ${body.command} wartet auf den Box-Sync`);
    } else if (shouldHoldClosedOnTrackerEnd(device.policy, policy, device.locked, now)) {
      // (3) Sperrzeit-RÜCKZUG ohne Kommando: die Tracker-Sperre ist weg, die Box aber physisch noch
      //     zu → in einen eigenen Simple-Lock überführen. Dann zeigt die Anzeige "GESCHLOSSEN, ohne
      //     Zeitlimit" statt fälschlich "WIRD GEÖFFNET", und die Box öffnet nicht von selbst (der Sub
      //     öffnet über einen Eintrag). Dieselbe Regel wie im autoritativen box/sync-Pfad; hier nur
      //     der Instant-Weg für die live Box. Gilt für live UND schlafende Box.
      await prisma.lockPolicy.update({ where: { deviceId: device.id }, data: { simpleLock: true } });
    }
  }
  if (devices.length > 0) notifyDeviceChange();

  return NextResponse.json({ ok: true, devices: devices.length });
}
